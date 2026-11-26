import { Gnomonic } from '../../../astronomy/projections/projection'
import { DEG2RAD } from '../../../core/constants'
import type { ImageRawType } from '../../../imaging/model/types'
import { plotBahtinovSpikes } from '../../../imaging/stars/bahtinov'
import { colorIndexToRgbWeights, gaussianSigmaFromHfd, plotStar, type PlotStarOptions } from '../../../imaging/stars/generator'
import { evaluateSyntheticAberration, resolveSyntheticAberration, type SyntheticStarAberration } from '../../../imaging/synthetic/aberration'
import { applySyntheticCollimationBlur, applySyntheticCollimationSaturation, renderSyntheticCollimationPattern, renderValidatedSyntheticCollimationPattern, type SyntheticCollimationPattern } from '../../../imaging/synthetic/collimation'
import { type AstronomicalImageNoiseConfig, type AstronomicalImageStar, generateNoiseImage, generateStarImage } from '../../../imaging/synthetic/generator'
import type { Point } from '../../../math/numerical/geometry'
import { clamp } from '../../../math/numerical/math'
import type { Angle } from '../../../math/units/angle'
import type { CameraFlatConfig } from './camera.config'
import { renderCameraFlat } from './camera.flat'
import type { CameraOpticsState } from './camera.optics'
import type { CameraPsfState } from './camera.psf'
import type { CameraReadoutState } from './camera.readout'
import type { ExposureTrail } from './camera.trail'
import type { CatalogSourceStar } from './types'

// Image formation of the simulated camera: projects the sky onto the sensor along the exposure's trail,
// shapes each star with the optics, and draws the frame with its noise. Pure and deterministic: the
// same inputs give the same samples. Sensor coordinates are unbinned pixels with the origin at the
// first pixel and the boresight at the sensor centre; frame coordinates are binned pixels of the
// subframe. At a position angle of zero north is towards -y and east towards -x.

// Smallest defocus, as a fraction of the focus range, drawn as an annulus rather than a focused star.
const ANNULAR_MIN_DEFOCUS = 1e-6

// Indices of the three Bahtinov spikes, each transformed on its own.
const SPIKES = [0, 1, 2] as const

// Rotation below which the sensor counts as unrotated, radians.
const ROTATION_EPSILON = 1e-12

// A star projected into the frame, with its local best-focus displacement.
export interface CameraFrameStar extends AstronomicalImageStar {
	// Local best-focus displacement, focuser steps, from sensor tilt or field curvature.
	readonly focusOffset?: number
}

// Everything a frame is drawn from, taken when the shutter closed.
export interface CameraFrameInput {
	// Sensor size, unbinned pixels.
	readonly sensorWidth: number
	readonly sensorHeight: number
	readonly readout: CameraReadoutState
	readonly optics: CameraOpticsState
	readonly psf: CameraPsfState
	// Seeing, unbinned pixels of half-flux diameter.
	readonly seeing: number
	// Radians per unbinned pixel.
	readonly pixelScale: Angle
	// Rotation of the sensor on top of the tube's orientation, radians: camera angle plus rotator.
	readonly rotation: Angle
	// Optical focus position, focuser steps, and the focuser's range when one is attached.
	readonly focusPosition: number
	readonly maxFocusPosition?: number
	// Multiplier of every star flux: gain and exposure relative to the reference exposure.
	readonly fluxScale: number
	// Multiplier of every star signal-to-noise ratio.
	readonly snrScale: number
	// Noise of the frame.
	readonly noise: AstronomicalImageNoiseConfig
	// Illumination of a flat frame: settings, seed and signal multiplier.
	readonly flat?: { readonly config: CameraFlatConfig; readonly seed: number; readonly signalScale: number }
}

// Plotting options of a focused star in `input`.
function plotOptions(input: CameraFrameInput): PlotStarOptions {
	return { ...input.psf.plot, focusStep: input.focusPosition, bestFocus: input.optics.bestFocus, maxFocusStep: input.maxFocusPosition }
}

// Projects `stars` into the frame along `trail`.
//
// Each star is projected around every vertex of the trail, rotated by that vertex's position angle
// plus the sensor rotation about the sensor centre, and drawn as points `spacing` unbinned pixels
// apart along each stretch. A point carries the star's flux times the share of the exposure its
// stretch lasted, divided among the stretch's points, so the light of a trail is the light of the star
// and its brightness per pixel falls as the field moves faster, whatever the speed. Only the part of a
// stretch inside the subframe, padded by the radius an annulus can reach, is drawn, so a trail far
// longer than the frame costs no more than one crossing it; `maxPoints` bounds the points of one star.
// The aberrations of the field are evaluated where each point falls.
export function projectFrameStars(input: CameraFrameInput, stars: readonly CatalogSourceStar[], trail: ExposureTrail, spacing: number, maxPoints: number): CameraFrameStar[] {
	const { readout, optics, psf, pixelScale, sensorWidth, sensorHeight } = input
	const { x: frameX, y: frameY, width: frameWidth, height: frameHeight, binX, binY } = readout
	const { vertices } = trail
	const vertexCount = vertices.length
	const stretches = vertexCount - 1
	const centerX = (sensorWidth - 1) * 0.5
	const centerY = (sensorHeight - 1) * 0.5
	const projections = vertices.map((vertex) => new Gnomonic(vertex.rightAscension, vertex.declination))
	const cosines = vertices.map((vertex) => Math.cos(vertex.positionAngle + input.rotation))
	const sines = vertices.map((vertex) => Math.sin(vertex.positionAngle + input.rotation))
	const rotated = vertices.map((vertex) => Math.abs(vertex.positionAngle + input.rotation) >= ROTATION_EPSILON)
	const aberration = resolveSyntheticAberration(optics.aberration)
	const aberrationResult: SyntheticStarAberration = { defocus: 0, focusOffset: 0, covarianceXX: 0, covarianceXY: 0, covarianceYY: 0, coma: 0, comaTheta: 0 }
	const annular = psf.model === 'annular'
	const annularRadius = annular ? psf.collimation.maxRadius : 0
	const annularSoftness = annular ? psf.collimation.edgeSoftness * 8 : 0
	const paddingX = annularRadius + annularSoftness * Math.sqrt(binX / binY)
	const paddingY = annularRadius + annularSoftness * Math.sqrt(binY / binX)
	const weight = 1 / Math.max(1, stretches)
	const left = frameX - paddingX
	const right = frameX + frameWidth + paddingX
	const top = frameY - paddingY
	const bottom = frameY + frameHeight + paddingY
	const point: Point = { x: 0, y: 0 }
	const sensorX = new Float64Array(vertexCount)
	const sensorY = new Float64Array(vertexCount)
	const visible = new Uint8Array(vertexCount)
	const interval: [number, number] = [0, 1]
	const projected: CameraFrameStar[] = []

	// Adds one point of `star` at sensor position (`x`, `y`) carrying `share` of its flux.
	function addPoint(star: CatalogSourceStar, x: number, y: number, share: number) {
		if (x < frameX - paddingX || x >= frameX + frameWidth + paddingX || y < frameY - paddingY || y >= frameY + frameHeight + paddingY) return
		if (aberration.enabled) evaluateSyntheticAberration(x, y, sensorWidth, sensorHeight, input.focusPosition, optics.bestFocus, aberration, aberrationResult)
		const comaX = aberration.enabled ? Math.cos(aberrationResult.comaTheta) / binX : 0
		const comaY = aberration.enabled ? Math.sin(aberrationResult.comaTheta) / binY : 0

		projected.push({
			x: (x - frameX) / binX,
			y: (y - frameY) / binY,
			flux: star.flux * input.fluxScale * share,
			hfd: star.hfd,
			// The signal-to-noise ratio sets the width of the profile, not how much light it carries, so
			// it is not divided among the points of a trail.
			snr: star.snr * input.snrScale,
			colorIndex: star.colorIndex,
			scaleX: 1 / binX,
			scaleY: 1 / binY,
			defocus: aberration.focusEnabled ? aberrationResult.defocus : undefined,
			focusOffset: aberration.focusEnabled ? aberrationResult.focusOffset : undefined,
			covarianceXX: aberration.enabled ? aberrationResult.covarianceXX / (binX * binX) : undefined,
			covarianceXY: aberration.enabled ? aberrationResult.covarianceXY / (binX * binY) : undefined,
			covarianceYY: aberration.enabled ? aberrationResult.covarianceYY / (binY * binY) : undefined,
			coma: aberration.enabled ? aberrationResult.coma : undefined,
			comaTheta: aberration.enabled && aberrationResult.coma > 0 ? Math.atan2(comaY, comaX) : undefined,
		})
	}

	for (const star of stars) {
		let anyVisible = false

		for (let v = 0; v < vertexCount; v++) {
			visible[v] = 0
			if (projections[v].project(star.rightAscension, star.declination, point) === undefined) continue
			// East is -x and north -y at a position angle of zero.
			const dx = -point.x / pixelScale
			const dy = -point.y / pixelScale
			sensorX[v] = rotated[v] ? centerX + dx * cosines[v] - dy * sines[v] : centerX + dx
			sensorY[v] = rotated[v] ? centerY + dx * sines[v] + dy * cosines[v] : centerY + dy
			visible[v] = 1
			anyVisible = true
		}

		if (!anyVisible) continue

		if (vertexCount === 1) {
			addPoint(star, sensorX[0], sensorY[0], 1)
			continue
		}

		let budget = maxPoints

		for (let s = 0; s < stretches && budget > 0; s++) {
			if (!visible[s] || !visible[s + 1]) continue
			const x0 = sensorX[s]
			const y0 = sensorY[s]
			const dx = sensorX[s + 1] - x0
			const dy = sensorY[s + 1] - y0
			const clipped = clipSegment(x0, y0, dx, dy, left, top, right, bottom, interval)
			if (clipped === undefined) continue
			const points = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing))
			const share = weight / points
			const first = Math.max(0, Math.floor(clipped[0] * points - 0.5))
			const last = Math.min(points - 1, Math.ceil(clipped[1] * points - 0.5), first + budget - 1)
			budget -= last - first + 1

			for (let p = first; p <= last; p++) {
				const t = (p + 0.5) / points
				addPoint(star, x0 + dx * t, y0 + dy * t, share)
			}
		}
	}

	return projected
}

// Part of the segment from (`x`, `y`) along (`dx`, `dy`), t in [0, 1], that lies inside the rectangle
// [`left`, `right`] × [`top`, `bottom`], by Liang–Barsky clipping; writes the t range into `out` and
// returns it, or undefined when the segment misses the rectangle.
export function clipSegment(x: number, y: number, dx: number, dy: number, left: number, top: number, right: number, bottom: number, out: [number, number] = [0, 1]): [number, number] | undefined {
	out[0] = 0
	out[1] = 1
	return clipEdge(-dx, x - left, out) && clipEdge(dx, right - x, out) && clipEdge(-dy, y - top, out) && clipEdge(dy, bottom - y, out) ? out : undefined
}

// Narrows the t range in `out` to the side of one rectangle edge where p·t <= q, returning whether any
// of it is left. A segment parallel to the edge (p = 0) is kept whole or dropped by the sign of q.
function clipEdge(p: number, q: number, out: [number, number]) {
	if (p === 0) return q >= 0
	const r = q / p
	if (p < 0) out[0] = Math.max(out[0], r)
	else out[1] = Math.min(out[1], r)
	return out[0] <= out[1]
}

// Draws a frame into a fresh buffer of `imageWidth` × `imageHeight` × `channels` samples.
//
// A light frame draws `stars` along `trail` with the selected model and then the noise over them; a
// flat draws its illumination and then the noise; a dark or a bias draws only the noise.
export function renderCameraFrame(input: CameraFrameInput, stars: readonly CatalogSourceStar[], trail: ExposureTrail, spacing: number, maxPoints: number): Float32Array {
	const { readout, psf } = input
	const { imageWidth: width, imageHeight: height, channels } = readout
	const raw = new Float32Array(width * height * channels)

	if (readout.frameType === 'LIGHT') {
		const frameStars = projectFrameStars(input, stars, trail, spacing, maxPoints)

		if (psf.model === 'bahtinov') {
			renderBahtinovStars(raw, input, frameStars)
			generateNoiseImage(raw, width, height, channels, input.noise)
		} else if (psf.model === 'annular') {
			const saturationLevel = renderAnnularStars(raw, input, frameStars)
			const seeingSigma = gaussianSigmaFromHfd(input.seeing)
			applySyntheticCollimationBlur(raw, width, height, channels, { sigmaX: seeingSigma / readout.binX, sigmaY: seeingSigma / readout.binY })
			applySyntheticCollimationSaturation(raw, saturationLevel)
			generateNoiseImage(raw, width, height, channels, input.noise)
		} else {
			generateStarImage(raw, width, height, channels, frameStars, input.seeing, input.noise, plotOptions(input))
		}
	} else {
		if (readout.frameType === 'FLAT' && input.flat !== undefined) renderCameraFlat(raw, input.flat.config, readout, input.sensorWidth, input.sensorHeight, input.flat.seed, input.flat.signalScale)
		generateNoiseImage(raw, width, height, channels, input.noise)
	}

	return raw
}

// Draws focused star cores and a Bahtinov pattern on the brightest star inside the frame.
export function renderBahtinovStars(raw: ImageRawType, input: CameraFrameInput, stars: readonly CameraFrameStar[]) {
	const { imageWidth: width, imageHeight: height, channels } = input.readout
	const options = plotOptions(input)
	const saturationLevel = options.saturationLevel
	const coreOptions: PlotStarOptions = saturationLevel === undefined ? options : { ...options, saturationLevel: undefined }
	let brightest: CameraFrameStar | undefined

	for (const star of stars) {
		plotStar(raw, width, height, channels, star.x, star.y, star.flux, star.hfd, star.snr, input.seeing, star.colorIndex, coreOptions, star)
		if (star.x >= 0 && star.x < width && star.y >= 0 && star.y < height && (brightest === undefined || star.flux > brightest.flux)) brightest = star
	}

	if (brightest !== undefined) renderBahtinovSpikes(raw, input, brightest, options)
	applySyntheticCollimationSaturation(raw, saturationLevel)
}

// Adds the three spikes of a Bahtinov mask around `star`. Each spike is transformed on its own, so
// its sensor-space geometry survives anisotropic binning. The central spike is displaced by the focus
// error, in sensor pixels per FOCUS_STEPS_PER_PIXEL steps.
export function renderBahtinovSpikes(raw: ImageRawType, input: CameraFrameInput, star: CameraFrameStar, options: PlotStarOptions) {
	const { imageWidth: width, imageHeight: height, channels, binX, binY } = input.readout
	const pattern = input.psf.bahtinov
	const normalAngles = [pattern.normalAngle1 * DEG2RAD, pattern.normalAngle2 * DEG2RAD, pattern.normalAngle3 * DEG2RAD] as const
	const strengths = [pattern.strength1, pattern.strength2, pattern.strength3] as const
	const spikeFlux = star.flux * pattern.spikeFluxRatio
	if (!(strengths[0] + strengths[1] + strengths[2] > 0) || !(spikeFlux > 0)) return

	const bestFocus = input.optics.bestFocus
	const errorSensor = bestFocus === 0 ? 0 : (input.focusPosition - (bestFocus + (star.focusOffset ?? 0))) / pattern.focusStepsPerPixel
	const centerX = star.x + (options.jitterX ?? 0)
	const centerY = star.y + (options.jitterY ?? 0)
	const taperLength = Math.min(pattern.taperLength, pattern.halfLength)

	for (const index of SPIKES) {
		if (!(strengths[index] > 0)) continue
		const angle = normalAngles[index]
		const cosAngle = Math.cos(angle)
		const sinAngle = Math.sin(angle)
		const normalScale = Math.hypot(binX * cosAngle, binY * sinAngle)
		const tangentScale = Math.hypot(sinAngle / binX, cosAngle / binY)
		const imageAngle = Math.atan2(binY * sinAngle, binX * cosAngle)

		plotBahtinovSpikes(raw, width, height, channels, centerX, centerY, spikeFlux, index === 1 ? errorSensor / normalScale : 0, star.colorIndex, {
			normalAngles: [imageAngle, imageAngle, imageAngle],
			central: 1,
			spike: index,
			fwhm: pattern.fwhm / normalScale,
			halfLength: pattern.halfLength * tangentScale,
			taperLength: taperLength * tangentScale,
			strengths,
			gain: options.gain,
			cutoffSigma: pattern.cutoffSigma,
			gammaCompensation: options.gammaCompensation,
		})
	}
}

// Draws defocused stars as centrally obstructed annuli and focused ones with the Gaussian profile.
// Returns the saturation level, applied by the caller after the seeing blur.
export function renderAnnularStars(raw: ImageRawType, input: CameraFrameInput, stars: readonly CameraFrameStar[]): number | undefined {
	const { imageWidth: width, imageHeight: height, channels } = input.readout
	const pattern = input.psf.collimation
	const { aberration, bestFocus } = input.optics
	const globalDefocus = bestFocus === 0 ? 0 : clamp(Math.abs(input.focusPosition - bestFocus) / aberration.focusRange, 0, 1)
	const collimation = aberration.collimationEnabled ? aberration.collimation : 0
	const spiderVanes = Math.round(pattern.spiderVanes)
	const options = plotOptions(input)
	const plotGain = options.gain ?? 1
	const focusedOptions: PlotStarOptions = { ...options, saturationLevel: undefined, psfModel: 'gaussian', focusStep: bestFocus, bestFocus }
	const channelWeights: [number, number, number] | undefined = channels === 3 ? [1 / 3, 1 / 3, 1 / 3] : undefined
	let validated = false

	const fixture = {
		width,
		height,
		channels,
		channelWeights,
		outer: { center: { x: 0, y: 0 }, semiMajor: 0, semiMinor: 0, theta: 0, softness: 0 },
		obstruction: { center: { x: 0, y: 0 }, semiMajor: 0, semiMinor: 0, theta: 0, softness: 0 },
		signal: 0,
		background: 0,
		noise: 0,
		spider: spiderVanes > 0 ? { vanes: spiderVanes, angle: pattern.spiderAngle, width: 0, attenuation: pattern.spiderAttenuation } : undefined,
	} satisfies SyntheticCollimationPattern

	for (const star of stars) {
		const defocus = star.defocus ?? globalDefocus

		if (defocus <= ANNULAR_MIN_DEFOCUS) {
			plotStar(raw, width, height, channels, star.x, star.y, star.flux, star.hfd, star.snr, 0, star.colorIndex, focusedOptions, star)
			continue
		}

		const scaleX = star.scaleX ?? 1
		const scaleY = star.scaleY ?? 1
		const radius = Math.max(pattern.edgeSoftness * 3, pattern.maxRadius * defocus)
		const obstructionRadius = radius * pattern.obstructionRatio
		const clearance = Math.max(0, radius - obstructionRadius - pattern.edgeSoftness * 2)
		const offset = clearance * collimation
		const softness = pattern.edgeSoftness * Math.sqrt(scaleX * scaleY)

		fixture.outer.center.x = star.x
		fixture.outer.center.y = star.y
		fixture.outer.semiMajor = radius * scaleX
		fixture.outer.semiMinor = radius * scaleY
		fixture.outer.softness = softness
		fixture.obstruction.center.x = star.x + Math.cos(aberration.collimationAngle) * offset * scaleX
		fixture.obstruction.center.y = star.y + Math.sin(aberration.collimationAngle) * offset * scaleY
		fixture.obstruction.semiMajor = obstructionRadius * scaleX
		fixture.obstruction.semiMinor = obstructionRadius * scaleY
		fixture.obstruction.softness = softness
		if (fixture.spider !== undefined) fixture.spider.width = pattern.spiderWidth * Math.sqrt(scaleX * scaleY)
		fixture.signal = star.flux * plotGain

		if (channelWeights !== undefined) {
			const weights = colorIndexToRgbWeights(star.colorIndex, options.gammaCompensation)
			channelWeights[0] = weights[0]
			channelWeights[1] = weights[1]
			channelWeights[2] = weights[2]
		}

		// The fixture keeps its shape between stars, so only the first one needs the full validation.
		if (validated) renderValidatedSyntheticCollimationPattern(raw, fixture)
		else {
			renderSyntheticCollimationPattern(raw, fixture)
			validated = true
		}
	}

	return options.saturationLevel
}
