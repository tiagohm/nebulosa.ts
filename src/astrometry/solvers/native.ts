import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import type { StarCatalog } from '../../catalogs/stars/catalog'
import { RAD2DEG } from '../../core/constants'
import type { DetectedStar } from '../../imaging/stars/detector'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { type MutVec3, vecAngleUnit } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { DEC_TAN, RA_TAN } from '../wcs/fits.wcs'
import { inverseSipIntoFitsHeader, sipModelIntoFitsHeader } from '../wcs/sip.fit'
import { FieldQuadEnumerator, prepareSolverField, type SolverField } from './native.field'
import { fitSimilarityTanWcs, type TanWcs, tanWcsScale } from './native.fit'
import { type NativeSolution, nativeSolutionCone, projectNativeSolution, tweakSolution, verificationSigma2 } from './native.tweak'
import { DEFAULT_DISTRACTOR_FRACTION, LOG_ODDS_ACCEPT, LOG_ODDS_TUNE, verifyHypothesis } from './native.verify'
import { type Parity, type PlateSolution, PlateSolveError, type PlateSolveOptions, plateSolutionFrom } from './platesolver'
import { DEFAULT_QUAD_CODE_TOLERANCE, forEachQuadCodeVariant, type MutQuadCode } from './quad.code'
import type { QuadIndex, SkyCone } from './quad.index'
import { catalogStarVectors, EphemeralQuadIndex } from './quad.index.ephemeral'

// Native plate solver: blind or hinted astrometric calibration of detected stars against QuadIndex sources,
// after Astrometry.net (Lang et al. 2010). The field quads are enumerated brightest first; each canonical labeling
// of a quad looks up matching index quads by code; every hit passes cheap scale, region and parity filters,
// becomes a similarity TAN hypothesis and is verified by the Bayesian log-odds against the index stars. The first
// hypothesis whose odds reach 1e9 is refined over individual stars, with an optional SIP distortion, and returned
// as a FITS TAN or TAN-SIP header referenced at the image center, with its PlateSolution. nativeNearbyPlateSolve
// builds the indexes in memory from a star catalog around a position hint, with star densities matched to the
// image after ASTAP and Watney. The search is synchronous between blocks of stars and yields to the event loop
// between them, so the caller's signal and timeout can stop it. Pixels are FITS 1-based internally; angles are
// radians.

// Default stars entered per enumeration block, between yields and limit checks.
export const DEFAULT_NATIVE_DEPTH_BLOCK = 10

// Default centroid error of the field stars, pixels (Astrometry.net's verify_pix).
export const DEFAULT_NATIVE_PIXEL_ERROR = 1

// Default final SIP order.
export const DEFAULT_NATIVE_SIP_ORDER = 2

// Default maximum solve time, milliseconds.
export const DEFAULT_NATIVE_TIMEOUT = 300000

// Options of a native solve. rightAscension, declination and radius restrict the index quads to a cone; all of
// them must be given for the restriction to apply.
export interface NativePlateSolveOptions extends PlateSolveOptions {
	// Image width, pixels.
	readonly width: number
	// Image height, pixels.
	readonly height: number
	// Plate-scale range, radians per pixel; undefined searches every scale the indexes hold.
	readonly scale?: { readonly lower: Angle; readonly upper: Angle }
	// Expected parity; undefined tries both.
	readonly parity?: Parity
	// Final SIP order, 0 or 1 for a linear TAN solution.
	readonly sipOrder?: number
	// Maximum field stars used.
	readonly maxStars?: number
	// Code tolerance, code units.
	readonly codeTolerance?: number
	// Centroid error of the field stars, pixels.
	readonly pixelError?: number
	// Prior fraction of field stars missing from the indexes.
	readonly distractorFraction?: number
	// Stars entered per enumeration block.
	readonly depthBlock?: number
}

// A native solution with its diagnostics.
export interface NativePlateSolveResult {
	// FITS WCS header: TAN or TAN-SIP, ICRS, referenced at the image center, with IMAGEW and IMAGEH.
	readonly header: FitsHeader
	// Summary of the header.
	readonly solution: PlateSolution
	// Final log-odds of the solution.
	readonly logOdds: number
	// Matched field stars and field stars explained as distractors.
	readonly matchCount: number
	readonly distractorCount: number
	// Root mean square distance of the matches, pixels.
	readonly rms: number
	// Index that solved.
	readonly indexId: string
	// Hypotheses verified.
	readonly verifications: number
	// Field stars entered when solved.
	readonly depth: number
}

// Cone of the position hint, when complete.
function hintCone(options: PlateSolveOptions): SkyCone | undefined {
	const { rightAscension, declination, radius } = options
	if (rightAscension === undefined || declination === undefined || radius === undefined || !(radius > 0)) return undefined
	return { center: eraS2c(rightAscension, declination), radius: Math.min(Math.PI, radius) }
}

// Throws a PlateSolveError when the signal aborted or the deadline passed.
function checkLimits(signal: AbortSignal | undefined, deadline: number) {
	if (signal?.aborted) throw new PlateSolveError('aborted', 'the plate solve was aborted')
	if (performance.now() > deadline) throw new PlateSolveError('timeout', 'the plate solve timed out')
}

// Yields to the event loop so that aborts and timers run.
function yieldToEventLoop() {
	return new Promise<void>((resolve) => {
		setImmediate(resolve)
	})
}

// Solves detected stars (zero-based centroids) against the given indexes. Resolves undefined when the search
// ends without a solution; rejects with PlateSolveError on abort or timeout.
export async function nativePlateSolve(stars: readonly DetectedStar[], indexes: readonly QuadIndex[], options: NativePlateSolveOptions, signal?: AbortSignal): Promise<NativePlateSolveResult | undefined> {
	const deadline = performance.now() + (options.timeout ?? DEFAULT_NATIVE_TIMEOUT)
	checkLimits(signal, deadline)

	const field = prepareSolverField(stars, options.width, options.height, options.maxStars)
	const search = new NativeSearch(field, indexes, options)
	if (field.count < 4 || search.indexes.length === 0) return undefined

	const block = Math.max(1, options.depthBlock ?? DEFAULT_NATIVE_DEPTH_BLOCK)

	while (!search.enumerator.done) {
		if (search.enumerator.advance(block, search.visit)) break
		checkLimits(signal, deadline)
		await yieldToEventLoop()
		checkLimits(signal, deadline)
	}

	return search.result()
}

// Options of a nearby solve over a star catalog: a complete position hint and a scale are required.
export interface NativeNearbyPlateSolveOptions extends NativePlateSolveOptions {
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly radius: Angle
	readonly scale: { readonly lower: Angle; readonly upper: Angle }
	// Quad bands as fractions of the shorter image side: the first band starts at the first value and each band is
	// sqrt(2) wide. Default [0.2, 0.28, 0.4].
	readonly bandFractions?: readonly number[]
	// Epoch of the image, Julian year, for the proper motion of the catalog entries.
	readonly epoch?: number
}

// Default quad bands of the nearby search, as fractions of the shorter image side.
const DEFAULT_NEARBY_BAND_FRACTIONS = [0.2, 0.2 * Math.SQRT2, 0.4]

// Density factors tried in turn: the image density, then one sqrt(2) step denser and sparser (Watney's density offsets).
const NEARBY_DENSITY_FACTORS = [1, Math.SQRT2, Math.SQRT1_2]

// Number of search positions above which the hint cone is tiled instead of searched at once.
const NEARBY_SINGLE_CONE_FIELDS = 3

// Solves detected stars around a position hint with quads built in memory from a star catalog. The hint cone is
// searched at once when it spans at most three field radii, else it is tiled with field-sized positions ordered
// by distance from the hint. Resolves undefined when no position solves.
export async function nativeNearbyPlateSolve(stars: readonly DetectedStar[], catalog: StarCatalog, options: NativeNearbyPlateSolveOptions, signal?: AbortSignal): Promise<NativePlateSolveResult | undefined> {
	const started = performance.now()
	const timeout = options.timeout ?? DEFAULT_NATIVE_TIMEOUT
	const scale = Math.sqrt(options.scale.lower * options.scale.upper)
	const shortSide = Math.min(options.width, options.height) * scale
	const fieldRadius = (Math.hypot(options.width, options.height) / 2) * options.scale.upper
	const fractions = options.bandFractions ?? DEFAULT_NEARBY_BAND_FRACTIONS
	const bands = fractions.map((fraction) => [fraction * shortSide, fraction * shortSide * Math.SQRT2] as const)
	const field = prepareSolverField(stars, options.width, options.height, options.maxStars)
	const longestQuad = Math.max(...bands.map((band) => band[1]))
	const fieldArea = options.width * options.height * scale * scale
	const positions = nearbyPositions(eraS2c(options.rightAscension, options.declination), options.radius, fieldRadius)

	for (const factor of NEARBY_DENSITY_FACTORS) {
		for (const position of positions) {
			checkLimits(signal, started + timeout)
			// The catalog cone covers the position, one field radius around it for the quads near its edge, and the longest quad.
			const cone = { center: position.center, radius: position.radius + fieldRadius + longestQuad }
			const vectors = await catalogStarVectors(catalog, cone, options.epoch)
			const indexes = bands.map(([scaleLower, scaleUpper]) => {
				const starsPerCell = Math.max(4, Math.min(16, (factor * field.count * scaleLower * scaleLower) / fieldArea))
				return EphemeralQuadIndex.fromVectors(vectors, { scaleLower, scaleUpper, starsPerCell, region: { center: position.center, radius: position.radius + fieldRadius }, id: `nearby:${scaleLower}` })
			})
			const [ra, dec] = eraC2s(position.center[0], position.center[1], position.center[2])
			const remaining = timeout - (performance.now() - started)
			const result = await nativePlateSolve(stars, indexes, { ...options, rightAscension: ra, declination: dec, radius: position.radius + fieldRadius, timeout: remaining }, signal)
			if (result !== undefined) return result
		}
	}

	return undefined
}

// A search position of the nearby solve.
interface NearbyPosition {
	readonly center: MutVec3
	readonly radius: Angle
}

// Covers the hint cone with positions of one field radius, in declination rows one field radius apart with every
// other row shifted half a step (Watney), ordered by distance from the hint (ASTAP's spiral). A small cone is one position.
function nearbyPositions(center: MutVec3, radius: Angle, fieldRadius: Angle): NearbyPosition[] {
	if (radius <= NEARBY_SINGLE_CONE_FIELDS * fieldRadius) return [{ center, radius }]

	const [ra0, dec0] = eraC2s(center[0], center[1], center[2])
	const step = fieldRadius * Math.SQRT2
	const positions: { center: MutVec3; distance: number }[] = []
	const rows = Math.ceil(radius / step)

	for (let row = -rows; row <= rows; row++) {
		const dec = dec0 + row * step
		if (dec > Math.PI / 2 || dec < -Math.PI / 2) continue
		const cos = Math.max(1e-6, Math.cos(dec))
		const columns = Math.min(Math.ceil(radius / (step * cos)), Math.ceil(Math.PI / (step * cos)))
		const shift = (row & 1) === 0 ? 0 : 0.5

		for (let column = -columns; column <= columns; column++) {
			const ra = ra0 + ((column + shift) * step) / cos
			const point = eraS2c(ra, dec)
			const distance = vecAngleUnit(point, center)
			if (distance <= radius + fieldRadius) positions.push({ center: point, distance })
		}
	}

	positions.sort((a, b) => a.distance - b.distance)
	return positions.map((position) => ({ center: position.center, radius: fieldRadius }))
}

// State of one search: the field, the usable indexes, the hint and the best accepted hypothesis.
class NativeSearch {
	readonly indexes: readonly QuadIndex[]
	readonly enumerator: FieldQuadEnumerator
	readonly #field: SolverField
	readonly #options: NativePlateSolveOptions
	readonly #tolerance: number
	readonly #codeParity: boolean | undefined
	readonly #scaleLower: number
	readonly #scaleUpper: number
	readonly #hint?: SkyCone
	readonly #fieldRadiusPixels: number
	readonly #pixelError: number
	readonly #distractor: number
	readonly #tried = new Set<string>()
	readonly #quadStars = new Uint32Array(4)
	readonly #vectors = new Float64Array(12)
	readonly #vector: MutVec3 = [0, 0, 0]
	#solved?: { readonly solution: NativeSolution; readonly index: QuadIndex; readonly logOdds: number; readonly matchCount: number; readonly distractorCount: number; readonly rms: number }
	#verifications = 0

	constructor(field: SolverField, indexes: readonly QuadIndex[], options: NativePlateSolveOptions) {
		this.#field = field
		this.#options = options
		this.#tolerance = options.codeTolerance ?? DEFAULT_QUAD_CODE_TOLERANCE
		// An unflipped code (north + i·east against x + i·y) maps to a negative CD determinant, the FITS FLIPPED parity.
		this.#codeParity = options.parity === undefined ? undefined : options.parity === 'NORMAL'
		this.#hint = hintCone(options)
		this.#fieldRadiusPixels = Math.hypot(options.width, options.height) / 2
		this.#pixelError = options.pixelError ?? 1
		this.#distractor = options.distractorFraction ?? DEFAULT_DISTRACTOR_FRACTION

		const hint = this.#hint
		const usable = indexes.filter((index) => hint === undefined || index.coverage === undefined || vecAngleUnit(index.coverage.center, hint.center) <= index.coverage.radius + hint.radius)
		this.#scaleLower = options.scale?.lower ?? 0
		this.#scaleUpper = options.scale?.upper ?? Infinity

		// Backbone range in pixels: the index bands seen at the scale range, within 10% of the shorter side and the diagonal.
		let minBackbone = Infinity
		let maxBackbone = 0
		const selected: QuadIndex[] = []

		for (const index of usable) {
			const lower = index.scaleLower / this.#scaleUpper
			const upper = this.#scaleLower > 0 ? index.scaleUpper / this.#scaleLower : Infinity
			if (upper < 0.1 * Math.min(options.width, options.height) || lower > 2 * this.#fieldRadiusPixels) continue
			selected.push(index)
			minBackbone = Math.min(minBackbone, lower)
			maxBackbone = Math.max(maxBackbone, upper)
		}

		this.indexes = selected
		minBackbone = Math.max(minBackbone * (1 - this.#tolerance), 0.1 * Math.min(options.width, options.height))
		maxBackbone = Math.min(maxBackbone * (1 + this.#tolerance), 2 * this.#fieldRadiusPixels)
		this.enumerator = new FieldQuadEnumerator(field, minBackbone, maxBackbone, this.#tolerance)
	}

	// Field quad visitor: looks up every labeling in every index whose band admits the backbone. Returns true once solved.
	readonly visit = (a: number, b: number, c: number, d: number, backbone: number, code: MutQuadCode) => {
		forEachQuadCodeVariant(code, [a, b, c, d], this.#tolerance, this.#codeParity, (variant) => {
			if (this.#solved !== undefined) return
			const stars = [variant.stars[0], variant.stars[1], variant.stars[2], variant.stars[3]] as const

			for (const index of this.indexes) {
				if (this.#solved !== undefined) return
				if (backbone * this.#scaleUpper < index.scaleLower * (1 - this.#tolerance) || backbone * this.#scaleLower > index.scaleUpper * (1 + this.#tolerance)) continue
				index.searchCodes(variant.code, this.#tolerance, (quad) => this.#hit(index, quad, stars, backbone), this.#hint)
			}
		})

		return this.#solved !== undefined
	}

	// Filters, fits and verifies one code hit.
	#hit(index: QuadIndex, quad: number, fieldStars: readonly [number, number, number, number], backbone: number) {
		if (this.#solved !== undefined) return

		const key = `${index.id}:${quad}:${[...fieldStars].sort((p, q) => p - q).join(',')}`
		if (this.#tried.has(key)) return
		this.#tried.add(key)

		const field = this.#field
		const stars = index.quadStars(quad, this.#quadStars)
		const vectors = this.#vectors

		for (let i = 0; i < 4; i++) {
			index.starVector(stars[i], this.#vector)
			vectors[i * 3] = this.#vector[0]
			vectors[i * 3 + 1] = this.#vector[1]
			vectors[i * 3 + 2] = this.#vector[2]
		}

		// Scale of the backbone.
		const ab = vecAngleUnit([vectors[0], vectors[1], vectors[2]], [vectors[3], vectors[4], vectors[5]])
		const backboneScale = ab / backbone
		if (backboneScale < this.#scaleLower * (1 - this.#tolerance) || backboneScale > this.#scaleUpper * (1 + this.#tolerance)) return

		const crpix = [(field.width + 1) / 2, (field.height + 1) / 2] as const
		const x = fieldStars.map((s) => field.x[s])
		const y = fieldStars.map((s) => field.y[s])
		const parity = this.#options.parity === undefined ? undefined : this.#options.parity === 'FLIPPED'
		const fit = fitSimilarityTanWcs({ count: 4, x, y, vectors }, parity, crpix)
		if (fit === undefined) return

		const scale = tanWcsScale(fit.wcs)
		if (scale < this.#scaleLower * (1 - this.#tolerance) || scale > this.#scaleUpper * (1 + this.#tolerance)) return

		// Region: the image center must lie in the hint cone widened by the field radius.
		const hint = this.#hint
		if (hint !== undefined && vecAngleUnit(fit.wcs.crval, hint.center) > hint.radius + this.#fieldRadiusPixels * scale) return

		const quadX = (x[0] + x[1]) / 2
		const quadY = (y[0] + y[1]) / 2
		const quadRadiusSq = (backbone * backbone) / 4
		let solution: NativeSolution = { wcs: fit.wcs }
		this.#verifications++

		const verification = verifyHypothesis({
			field,
			index,
			project: (v, out) => projectNativeSolution(solution, v, out),
			cone: nativeSolutionCone(solution, field.width, field.height),
			quadX,
			quadY,
			quadRadiusSq,
			gamma: 1,
			sigma2: verificationSigma2(this.#pixelError, index, fit.wcs),
			quadFieldStars: fieldStars,
			quadIndexStars: stars,
			binSize: index.cellSize / scale,
			distractorFraction: this.#distractor,
		})

		if (verification.logOdds < LOG_ODDS_TUNE) return

		const tweak = tweakSolution({ field, index, wcs: fit.wcs, quadX, quadY, quadRadiusSq, pixelError: this.#pixelError, sipOrder: this.#options.sipOrder ?? DEFAULT_NATIVE_SIP_ORDER, distractorFraction: this.#distractor })
		solution = tweak.solution
		const final = tweak.verification
		if (Math.max(final.logOdds, verification.logOdds) < LOG_ODDS_ACCEPT || final.matchCount < 4) return

		let sumSq = 0
		for (let i = 0; i <= final.bestIndex; i++) {
			const ref = final.theta[i]
			if (ref < 0) continue
			const star = final.testStars[i]
			sumSq += (field.x[star] - final.refX[ref]) ** 2 + (field.y[star] - final.refY[ref]) ** 2
		}

		this.#solved = { solution, index, logOdds: final.logOdds, matchCount: final.matchCount, distractorCount: final.distractorCount, rms: Math.sqrt(sumSq / final.matchCount) }
	}

	// The accepted solution as a FITS header and summary, or undefined.
	result(): NativePlateSolveResult | undefined {
		const solved = this.#solved
		if (solved === undefined) return undefined

		const header = nativeSolutionHeader(solved.solution, this.#options.width, this.#options.height)
		const solution = plateSolutionFrom(header)
		if (solution === undefined) throw new PlateSolveError('failed', 'the native solver produced an invalid WCS')

		return { header, solution, logOdds: solved.logOdds, matchCount: solved.matchCount, distractorCount: solved.distractorCount, rms: solved.rms, indexId: solved.index.id, verifications: this.#verifications, depth: this.enumerator.entered }
	}
}

// Writes a native solution as a FITS TAN or TAN-SIP header in ICRS, degrees, with the image size.
export function nativeSolutionHeader(solution: NativeSolution, width: number, height: number): FitsHeader {
	const wcs: TanWcs = solution.wcs
	const [ra, dec] = eraC2s(wcs.crval[0], wcs.crval[1], wcs.crval[2])
	const header: FitsHeader = {
		CTYPE1: RA_TAN,
		CTYPE2: DEC_TAN,
		CUNIT1: 'deg',
		CUNIT2: 'deg',
		CRVAL1: (((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * RAD2DEG,
		CRVAL2: dec * RAD2DEG,
		CRPIX1: wcs.crpix1,
		CRPIX2: wcs.crpix2,
		CD1_1: wcs.cd11 * RAD2DEG,
		CD1_2: wcs.cd12 * RAD2DEG,
		CD2_1: wcs.cd21 * RAD2DEG,
		CD2_2: wcs.cd22 * RAD2DEG,
		RADESYS: 'ICRS',
		EQUINOX: 2000,
		IMAGEW: width,
		IMAGEH: height,
	}

	if (solution.sip !== undefined) {
		sipModelIntoFitsHeader(solution.sip, header)
		if (solution.inverseSip !== undefined) inverseSipIntoFitsHeader(solution.inverseSip, header)
	}

	return header
}
