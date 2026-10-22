import type { Point, Rect } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import { medianBySelectionOf, STANDARD_DEVIATION_SCALE } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import type { Image } from '../model/types'
import { clone } from '../processing/arithmetic'
import { debayer } from '../processing/debayer'
import { grayscale } from '../processing/geometry'
import { psf } from '../processing/psf'
import { starMomentShape } from './shape'

// Star detection and photometry for an image. Median-filters out hot pixels, runs a PSF-matched
// response to find candidate peaks, then measures each star's flux, SNR, half-flux diameter (HFD),
// and FWHM via aperture/annulus photometry. The HFD comes from a curve of growth on which every
// sample spreads its flux over the radii within half a pixel of its center, so it is stable against
// sub-pixel motion. The aperture is fixed at STAR_SIGNAL_RADIUS unless a larger maximum radius is
// requested, in which case it grows until it holds the whole star (defocused stars for focusing).
// The published (x, y) is the flux-weighted centroid around that peak, not the integer local-max
// pixel, so sub-pixel motion is visible to guiders. Centroids are zero-based image coordinates:
// origin at the upper-left sample, +X right, +Y down. Intensities use the normalized processing
// scale, which is not a permanent [0, 1] clamp. Measurement buffers are reused within one call.
// Also provides utilities to merge close detections and to drop pairs that would share a guiding search box.

// A detected star: flux-weighted centroid plus measured photometry.
// x and y are zero-based, +X right, +Y down.
export interface DetectedStar extends Readonly<Point> {
	// Curve-of-growth half-flux diameter, pixels.
	readonly hfd: number
	// Full width at half maximum, pixels (when estimable).
	readonly fwhm?: number
	// Shape eccentricity from 0 (round) toward 1 (elongated), when estimable.
	readonly eccentricity?: number
	// Major/minor axis ratio, at least 1, when estimable.
	readonly elongation?: number
	// Major and minor central second moments, in squared image pixels, when estimable.
	readonly majorVariance?: number
	readonly minorVariance?: number
	// Major-axis orientation in [0, PI), clockwise from +X because image Y grows downward.
	readonly theta?: Angle
	// Signal-to-noise ratio.
	readonly snr: number
	// Integrated flux above background.
	readonly flux: number
}

// Options controlling star detection.
export interface DetectStarOptions {
	// Maximum number of stars to return (brightest kept).
	readonly maxStars: number
	// Tracking-box size, in pixels. When positive, pairs of comparable-brightness stars that would
	// both fit inside one search box (plus a 5-pixel margin) are removed, matching the PHD2
	// uniqueness filter. This is not a central crop of the frame.
	readonly searchRegion?: number
	// Minimum SNR a star must reach to be kept.
	readonly minSNR?: number
	// Largest signal-aperture radius, in pixels. The default, STAR_SIGNAL_RADIUS, keeps the fixed
	// aperture. A larger value grows the aperture of each star whose light reaches its edge or covers
	// its sky annulus, until the star fits; a star that does not fit at this radius, or whose grown
	// aperture leaves the image, is dropped, and candidates inside a grown aperture are not measured again.
	readonly maximumRadius?: number
}

// Integral images for fast box statistics: [running sum, running sum of squares, padded width].
type IntegralImages = readonly [Float64Array, Float64Array, number] // sum, sumSq, width
// Measured photometry of one star as [flux, snr, hfd, fwhm].
export type StarPhotometry = readonly [number, number, number, number] // flux, snr, hfd, fwhm
// Robust sky of an annulus as [median, scaled-MAD deviation, sample count], in sample units.
type AnnulusStatistics = readonly [number, number, number] // median, deviation, count

// Photometry, shape and flux-weighted centroid of one circular aperture.
interface ApertureMeasurement {
	// Signal-aperture radius, in pixels.
	readonly radius: number
	// Integrated positive signal above the sky, in sample units.
	readonly flux: number
	// flux / sqrt(flux + pixels * noise^2), in the normalized sample scale.
	readonly snr: number
	// Curve-of-growth half-flux diameter, in pixels; 0 when it cannot be found.
	readonly hfd: number
	// Gaussian-equivalent FWHM from the second radial moment, in pixels.
	readonly fwhm: number
	// Moment shape of the positive signal, when estimable.
	readonly eccentricity?: number
	readonly elongation?: number
	readonly majorVariance?: number
	readonly minorVariance?: number
	readonly theta?: Angle
	// Flux-weighted centroid, zero-based pixels.
	readonly centroidX: number
	readonly centroidY: number
	// Median of the sky annulus, in sample units.
	readonly sky: number
	// Scaled MAD of the sky annulus, in sample units.
	readonly noise: number
	// Number of samples in the sky annulus.
	readonly skyCount: number
	// Sum of the signed signal of the whole aperture, in sample units.
	readonly netFlux: number
	// Number of samples in the aperture.
	readonly aperturePixels: number
	// Sum of the signed signal of the outermost one-pixel band of the aperture, in sample units.
	readonly edgeSignal: number
	// Number of samples in that band.
	readonly edgeCount: number
}

// Scratch buffers shared by every aperture measurement of one call and grown on demand.
interface PhotometryWorkspace {
	// Sky-annulus samples, reordered in place by the median selection.
	samples: Float64Array
	// Second differences of the curve of growth on the radial bin grid; their running sum is the flux per bin.
	bins: Float64Array
}

// Aperture radius (pixels) over which a detected star's signal flux and shape moments are measured.
export const STAR_SIGNAL_RADIUS = 4
// Gap, in pixels, between the signal aperture and the inner edge of its sky annulus.
const STAR_BACKGROUND_GAP = 1
// Width, in pixels, of the sky annulus beyond its inner edge.
const STAR_BACKGROUND_WIDTH = 2
// Width of the radial bins of the curve of growth, in pixels.
const STAR_HFD_BIN_WIDTH = 0.25
// Half of the radial extent, in pixels, over which one sample's flux is spread on the curve of
// growth. A sample covers the radii within about half a pixel of its center; spreading its flux over
// them instead of placing it at the center radius removes a sub-pixel jitter of up to ±0.9 pixel in
// the HFD of compact stars.
const STAR_HFD_SAMPLE_HALF_WIDTH = 0.5
// Significance, in standard errors, that makes an adaptive aperture grow: of the mean signal of its
// edge band above the sky, or of its sky annulus above the distant sky.
const STAR_GROWTH_SIGNIFICANCE = 4
// Standard error of the median of normal samples relative to that of their mean, sqrt(PI / 2).
const MEDIAN_STANDARD_ERROR_SCALE = Math.sqrt(Math.PI / 2)
// Number of samples of the distant sky circle of an adaptive aperture. 32 gives a median standard error
// of about 0.22 sky deviations, enough to see the face of a defocused star about 1 deviation above the
// sky, while keeping the scattered reads cheap for the tens of thousands of candidates of a frame.
const STAR_DISTANT_SKY_SAMPLES = 32
// Minimum number of samples for the distant sky to be a usable reference of an adaptive aperture.
const STAR_MIN_DISTANT_SKY_SAMPLES = 8
// Unit-circle cosines and sines of the evenly spaced distant sky samples.
const DISTANT_SKY_COS = Float64Array.from({ length: STAR_DISTANT_SKY_SAMPLES }, (_, i) => Math.cos((2 * Math.PI * i) / STAR_DISTANT_SKY_SAMPLES))
const DISTANT_SKY_SIN = Float64Array.from({ length: STAR_DISTANT_SKY_SAMPLES }, (_, i) => Math.sin((2 * Math.PI * i) / STAR_DISTANT_SKY_SAMPLES))
// Border margin (pixels) excluded after PSF convolution to avoid edge artifacts.
const STAR_CONVOLVED_MARGIN = 4
// Minimum acceptable HFD (pixels); smaller measurements are treated as noise/hot pixels.
const STAR_MIN_HFD = 1
// Extra photometry passes after the integer peak, recentering on the flux-weighted centroid.
const STAR_CENTROID_REFINEMENTS = 2
// Stop recentering when the centroid moves by this many pixels or less.
const STAR_CENTROID_TOLERANCE = 0.05
// Adjacent-rank ratio that marks a candidate star-to-noise break.
const STAR_SCORE_GAP_RATIO = 4
// How many candidates immediately below a gap are inspected for a tight field-star clump.
const STAR_SCORE_GAP_CLUMP_WINDOW = 8
// Rank ratio that still splits a tight clump. 4³ ≈ 3 mag of flux when SNR scales as √flux, which
// is larger than a handful of bright-star outliers and smaller than the noise floor on a star field.
const STAR_SCORE_GAP_OUTLIER_RATIO = STAR_SCORE_GAP_RATIO * STAR_SCORE_GAP_RATIO * STAR_SCORE_GAP_RATIO

// Default star-detection options.
const DEFAULT_DETECT_STARS_OPTIONS: Readonly<DetectStarOptions> = {
	maxStars: 500,
	searchRegion: 0,
	minSNR: 0,
	maximumRadius: STAR_SIGNAL_RADIUS,
}

// Converts RGB or raw CFA input into a coherent mono intensity image for filtering and photometry.
function starAnalysisImage(image: Image): Image | undefined {
	image = grayscale(image)
	if (!image.metadata.bayer) return image
	const color = debayer(image)
	return color && grayscale(color)
}

// Replaces each interior pixel with the median of its 3x3 neighborhood in place. Isolated hot
// pixels and 2x2 defect clumps disappear; the 1-pixel border is left unchanged because later
// detection already excludes a wider PSF margin. Returns the same image object.
function median3x3(image: Image) {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	if (width < 3 || height < 3) return image

	const RowArray = raw instanceof Float64Array ? Float64Array : Float32Array
	const previous = new RowArray(stride)
	const current = new RowArray(stride)
	previous.set(raw.subarray(0, stride))
	current.set(raw.subarray(stride, stride * 2))
	const window = new Float64Array(9)

	for (let y = 1; y < height - 1; y++) {
		const next = raw.subarray((y + 1) * stride, (y + 2) * stride)
		const row = y * stride

		for (let x = 1; x < width - 1; x++) {
			window[0] = previous[x - 1]
			window[1] = previous[x]
			window[2] = previous[x + 1]
			window[3] = current[x - 1]
			window[4] = current[x]
			window[5] = current[x + 1]
			window[6] = next[x - 1]
			window[7] = next[x]
			window[8] = next[x + 1]
			raw[row + x] = medianBySelectionOf(window, 9)
		}

		previous.set(current)
		current.set(next)
	}

	return image
}

// Detects stars in an image and returns them sorted by descending flux (up to maxStars), filtered by
// minSNR and optionally pruned with the PHD2 search-box uniqueness filter.
export function detectStars(image: Image, { maxStars = 500, searchRegion = 0, minSNR = 0, maximumRadius = STAR_SIGNAL_RADIUS }: Partial<DetectStarOptions> = DEFAULT_DETECT_STARS_OPTIONS): DetectedStar[] {
	const intensity = starAnalysisImage(image)
	if (intensity === undefined) return []
	image = intensity

	const original = image.raw

	// Run a 3x3 median first to eliminate hot pixels
	image = median3x3(clone(image))

	// Run the PSF convolution
	image = psf(image)

	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const convRect: Rect = { left: STAR_CONVOLVED_MARGIN, top: STAR_CONVOLVED_MARGIN, right: width - STAR_CONVOLVED_MARGIN - 1, bottom: height - STAR_CONVOLVED_MARGIN - 1 }
	const maxX = convRect.right - STAR_CONVOLVED_MARGIN
	const maxY = convRect.bottom - STAR_CONVOLVED_MARGIN
	const stars = new StarList(Math.min(maxStars, 2000))
	const integrals = buildIntegralImages(raw, width, height, stride)
	const leftBounds = new Uint16Array(width)
	const rightBounds = new Uint16Array(width)
	const topBounds = new Uint16Array(height)
	const bottomBounds = new Uint16Array(height)
	const stride2 = stride * 2
	const stride3 = stride * 3
	const stride4 = stride * 4
	const workspace: PhotometryWorkspace = { samples: new Float64Array(0), bins: new Float64Array(0) }
	// Center x, center y and radius, in pixels, of the grown apertures that may still hold candidates, flattened.
	const grown: number[] = []

	for (let x = convRect.left + 4; x <= maxX; x++) {
		leftBounds[x] = Math.max(convRect.left, x - 7)
		rightBounds[x] = Math.min(convRect.right, x + 7)
	}

	for (let y = convRect.top + 4; y <= maxY; y++) {
		topBounds[y] = Math.max(convRect.top, y - 7)
		bottomBounds[y] = Math.min(convRect.bottom, y + 7)
	}

	// Find each local maximum
	for (let y = convRect.top + 4; y <= maxY; y++) {
		const sy = stride * y
		const rowM1 = sy - stride
		const rowP1 = sy + stride
		const rowM2 = sy - stride2
		const rowP2 = sy + stride2
		const rowM3 = sy - stride3
		const rowP3 = sy + stride3
		const rowM4 = sy - stride4
		const rowP4 = sy + stride4

		for (let x = convRect.left + 4; x <= maxX; x++) {
			const center = sy + x
			const value = raw[center]

			// PSF of a flattened background is ~1e-17, not 0; those plateaus are local maxima
			// under a strict-`>` test and would photometer residual hot pixels on the original.
			if (value <= Number.EPSILON) continue
			if (raw[center - 1] > value || raw[center + 1] > value || raw[rowM1 + x] > value || raw[rowP1 + x] > value || raw[rowM1 + x - 1] > value || raw[rowM1 + x + 1] > value || raw[rowP1 + x - 1] > value || raw[rowP1 + x + 1] > value) continue

			const baseM4 = rowM4 + x
			const baseM3 = rowM3 + x
			const baseM2 = rowM2 + x
			const baseM1 = rowM1 + x
			const base0 = center
			const baseP1 = rowP1 + x
			const baseP2 = rowP2 + x
			const baseP3 = rowP3 + x
			const baseP4 = rowP4 + x
			let isMax = true

			for (let i = -4; i <= 4; i++) {
				if (raw[baseM4 + i] > value || raw[baseM3 + i] > value || raw[baseM2 + i] > value || raw[baseP2 + i] > value || raw[baseP3 + i] > value || raw[baseP4 + i] > value) {
					isMax = false
					break
				}
			}

			if (!isMax) continue

			for (let i = -4; i <= -2; i++) {
				if (raw[baseM1 + i] > value || raw[base0 + i] > value || raw[baseP1 + i] > value) {
					isMax = false
					break
				}
			}

			if (!isMax) continue

			for (let i = 2; i <= 4; i++) {
				if (raw[baseM1 + i] > value || raw[base0 + i] > value || raw[baseP1 + i] > value) {
					isMax = false
					break
				}
			}

			if (!isMax) continue

			// Compare local maximum to mean value of surrounding pixels
			const left = leftBounds[x]
			const top = topBounds[y]
			const right = rightBounds[x]
			const bottom = bottomBounds[y]
			const [mean, standardDeviation] = localStatistics(integrals, left, top, right, bottom)

			// This is our measure of star intensity
			const h = (value - mean) / standardDeviation

			if (h < 0.1) continue

			// A defocused star has many peaks; once one of them has grown an aperture over it, the rest are the same star.
			if (insideGrownAperture(grown, x, y)) continue

			// Validate each candidate against the original image so ranking uses measured photometry instead of only convolution response.
			const photometry = measureStarAroundPeak(original, width, height, stride, x, y, minSNR, maximumRadius, workspace, grown)
			if (photometry === undefined) continue
			const { flux, snr, hfd, fwhm, eccentricity, elongation, centroidX, centroidY, majorVariance, minorVariance, theta } = photometry

			// Ranks detections by measured signal so real stars survive capacity limits better than noise artifacts.
			const rank = flux * snr

			stars.add(centroidX, centroidY, rank, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta)
		}
	}

	// Merge stars that are very close into a single star
	mergeVeryCloseStars(stars)

	if (searchRegion > 0) {
		// Exclude stars that would fit within a single search region box
		excludeStarsFitWithinRegion(stars, searchRegion)
	}

	// Keep only the strongest coherent score cluster when the frame has a clear star-to-noise break.
	trimStarsByScoreGap(stars)

	let i = 0
	const res = new Array<DetectedStar>(stars.size)

	for (const { x, y, flux = 0, snr = 0, hfd = 0, fwhm = 0, eccentricity, elongation, majorVariance, minorVariance, theta } of stars) {
		res[i++] = { x, y, flux, hfd, fwhm, snr, eccentricity, elongation, majorVariance, minorVariance, theta }
	}

	res.sort((left, right) => right.flux - left.flux)
	return res
}

// Drops a dim noise tail after a large score gap, walking from the bright end. A modest jump
// above a tight clump is a magnitude gap among real stars and is left intact; a jump above a
// spread-out tail, or an enormous jump even above a clump, is treated as the noise floor.
function trimStarsByScoreGap(stars: StarList) {
	if (stars.size <= 3) return

	const ranked = stars.array()
	const n = ranked.length
	let keepFrom = 0

	for (let i = n - 2; i >= 0; i--) {
		const weaker = ranked[i].h
		const stronger = ranked[i + 1].h
		if (weaker <= 0 || stronger <= 0) continue
		const ratio = stronger / weaker
		if (ratio <= STAR_SCORE_GAP_RATIO) continue
		if (n - i - 1 < 3) continue

		const clumpStart = Math.max(0, i - STAR_SCORE_GAP_CLUMP_WINDOW + 1)
		const clumpMin = ranked[clumpStart].h
		if (clumpMin > 0 && weaker / clumpMin < STAR_SCORE_GAP_RATIO && ratio < STAR_SCORE_GAP_OUTLIER_RATIO) continue

		keepFrom = i + 1
		break
	}

	for (let removeCount = keepFrom; removeCount > 0; removeCount--) {
		stars.deleteFirst()
	}
}

// Whether the candidate pixel lies inside an aperture already grown over a star, given the flattened
// [x, y, radius] triples of `grown` in pixels. Candidates arrive in increasing `y`, so apertures that end
// above it are removed from `grown` in place, which keeps it to the few apertures around the current rows.
function insideGrownAperture(grown: number[], x: number, y: number) {
	let kept = 0
	let inside = false

	for (let i = 0; i < grown.length; i += 3) {
		const gx = grown[i]
		const gy = grown[i + 1]
		const radius = grown[i + 2]
		if (gy + radius < y) continue
		grown[kept++] = gx
		grown[kept++] = gy
		grown[kept++] = radius
		const dx = x - gx
		const dy = y - gy
		if (dx * dx + dy * dy <= radius * radius) inside = true
	}

	grown.length = kept
	return inside
}

// Measures a candidate at its integer PSF peak and recenters it on the flux-weighted centroid, so the
// published (x, y) is the center of the aperture that produced flux, HFD, and FWHM. When
// `maximumRadius` exceeds STAR_SIGNAL_RADIUS the aperture then grows while the star extends beyond it;
// every grown aperture, accepted or not, is appended to `grown` as [x, y, radius]. Undefined when the
// candidate has no flux, is below `minSNR` or STAR_MIN_HFD, still extends beyond `maximumRadius`, or
// its grown aperture leaves the image less the PSF margin.
function measureStarAroundPeak(raw: Image['raw'], width: number, height: number, stride: number, peakX: number, peakY: number, minSNR: number, maximumRadius: number, workspace: PhotometryWorkspace, grown: number[]): ApertureMeasurement | undefined {
	if (!(maximumRadius > STAR_SIGNAL_RADIUS)) return measureCenteredAperture(raw, width, height, stride, peakX, peakY, STAR_SIGNAL_RADIUS, minSNR, workspace)

	// The sky annulus of a star larger than the aperture lies on its own light, so the SNR is only meaningful once it fits.
	const first = measureCenteredAperture(raw, width, height, stride, peakX, peakY, STAR_SIGNAL_RADIUS, 0, workspace)
	if (first === undefined) return undefined
	let photometry: ApertureMeasurement = first
	let distantSky: AnnulusStatistics | undefined
	let distantSkyMeasured = false

	while (true) {
		if (!edgeHasLight(photometry, photometry.noise)) {
			if (!distantSkyMeasured) {
				// Beyond the largest accepted star, so it is the local sky of every star that fits.
				distantSky = distantSkyStatistics(raw, stride, photometry.centroidX, photometry.centroidY, maximumRadius + STAR_BACKGROUND_GAP + 0.5 * STAR_BACKGROUND_WIDTH, width, height, workspace)
				distantSkyMeasured = true
			}

			if (!extendsBeyondAperture(photometry, distantSky)) break
		}

		const { radius } = photometry
		const next = radius < maximumRadius ? measureCenteredAperture(raw, width, height, stride, photometry.centroidX, photometry.centroidY, Math.min(maximumRadius, radius + Math.max(2, Math.ceil(radius / 4))), 0, workspace) : undefined

		if (next === undefined || !apertureInsideImage(next, width, height)) {
			addGrownAperture(grown, next ?? photometry)
			return undefined
		}

		photometry = next
	}

	if (photometry.radius > STAR_SIGNAL_RADIUS) addGrownAperture(grown, photometry)
	return photometry.snr >= minSNR ? photometry : undefined
}

// Appends the centroid and radius, in pixels, of a grown aperture to `grown`.
function addGrownAperture(grown: number[], { centroidX, centroidY, radius }: ApertureMeasurement) {
	grown.push(centroidX, centroidY, radius)
}

// Measures an aperture of `radius` pixels at (x, y) and recenters it at most STAR_CENTROID_REFINEMENTS
// times on the flux-weighted centroid, keeping the last measurement with positive flux, `minSNR` and
// STAR_MIN_HFD. Undefined when the first measurement already fails them.
function measureCenteredAperture(raw: Image['raw'], width: number, height: number, stride: number, x: number, y: number, radius: number, minSNR: number, workspace: PhotometryWorkspace): ApertureMeasurement | undefined {
	const backgroundInnerRadius = radius + STAR_BACKGROUND_GAP
	const backgroundOuterRadius = backgroundInnerRadius + STAR_BACKGROUND_WIDTH
	let photometry = measureAperture(raw, width, height, stride, x, y, radius, backgroundInnerRadius, backgroundOuterRadius, STAR_CONVOLVED_MARGIN, workspace)
	if (photometry === undefined || photometry.snr < minSNR || photometry.hfd < STAR_MIN_HFD) return undefined

	for (let iteration = 0; iteration < STAR_CENTROID_REFINEMENTS; iteration++) {
		const { centroidX, centroidY } = photometry
		if (Math.hypot(centroidX - x, centroidY - y) <= STAR_CENTROID_TOLERANCE) break
		const refined = measureAperture(raw, width, height, stride, centroidX, centroidY, radius, backgroundInnerRadius, backgroundOuterRadius, STAR_CONVOLVED_MARGIN, workspace)
		if (refined === undefined || refined.snr < minSNR || refined.hfd < STAR_MIN_HFD) break
		x = centroidX
		y = centroidY
		photometry = refined
	}

	return photometry
}

// Whether a star measured without light at its aperture edge, given the local sky noise, still extends
// beyond the aperture once the distant sky is known. A sky annulus that mixes the star with the sky has
// an inflated deviation, so the edge is tested again with the distant sky noise when that is smaller.
// Otherwise the star extends beyond when its sky annulus lies on the flat face of a larger star: the
// annulus is significantly brighter than the distant sky, by at least the mean signal of the aperture
// itself. A star on nebulosity fainter per pixel than the nebula's excess also passes this test, grows
// to the maximum radius and is dropped.
function extendsBeyondAperture(photometry: ApertureMeasurement, distantSky: AnnulusStatistics | undefined) {
	if (distantSky === undefined || distantSky[2] < STAR_MIN_DISTANT_SKY_SAMPLES) return false
	const [distantMedian, distantNoise, distantCount] = distantSky
	const noise = Math.min(photometry.noise, distantNoise)
	if (noise < photometry.noise && edgeHasLight(photometry, noise)) return true
	const excess = photometry.sky - distantMedian
	return excess > STAR_GROWTH_SIGNIFICANCE * MEDIAN_STANDARD_ERROR_SCALE * distantNoise * Math.sqrt(1 / photometry.skyCount + 1 / distantCount) && excess >= photometry.netFlux / photometry.aperturePixels
}

// Whether the mean signed signal of the aperture edge band exceeds `noise` (sky deviation, in sample
// units) significantly, meaning the star continues outside the aperture.
function edgeHasLight({ edgeSignal, edgeCount }: ApertureMeasurement, noise: number) {
	return edgeCount > 0 && edgeSignal > STAR_GROWTH_SIGNIFICANCE * noise * Math.sqrt(edgeCount)
}

// Whether the signal aperture around the centroid lies inside the image less the PSF margin, so no
// part of the star is cut.
function apertureInsideImage({ centroidX, centroidY, radius }: ApertureMeasurement, width: number, height: number) {
	return centroidX - radius >= STAR_CONVOLVED_MARGIN && centroidY - radius >= STAR_CONVOLVED_MARGIN && centroidX + radius <= width - STAR_CONVOLVED_MARGIN - 1 && centroidY + radius <= height - STAR_CONVOLVED_MARGIN - 1
}

// Computes aperture flux, SNR, HFD and FWHM for a star centered on an image coordinate.
export function measureStarPhotometry(image: Image, x: number, y: number, radius: number): StarPhotometry {
	const intensity = starAnalysisImage(image)
	if (intensity === undefined) return [0, 0, 0, 0]
	image = intensity

	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const workspace: PhotometryWorkspace = { samples: new Float64Array(0), bins: new Float64Array(0) }
	const photometry = measureAperture(raw, width, height, stride, x, y, radius, radius + 1, radius + 3, 0, workspace)
	return photometry === undefined ? [0, 0, 0, 0] : [photometry.flux, photometry.snr, photometry.hfd, photometry.fwhm]
}

// Returns `buffer` when it holds at least `capacity` values, otherwise a new zeroed buffer of that size.
function ensureCapacity(buffer: Float64Array, capacity: number) {
	return buffer.length >= capacity ? buffer : new Float64Array(capacity)
}

// Computes the median and scaled-MAD deviation of the samples whose centers lie between `inner` and
// `outer` pixels from (x, y), inside the [xMin, xMax] x [yMin, yMax] window. Only the row spans of the
// annulus are visited, so a wide ring costs its area rather than its bounding box. Reorders the
// workspace samples; undefined when the annulus has no sample.
function annulusStatistics(raw: Image['raw'], stride: number, x: number, y: number, inner: number, outer: number, xMin: number, yMin: number, xMax: number, yMax: number, workspace: PhotometryWorkspace): AnnulusStatistics | undefined {
	const x0 = Math.max(xMin, Math.ceil(x - outer))
	const y0 = Math.max(yMin, Math.ceil(y - outer))
	const x1 = Math.min(xMax, Math.floor(x + outer))
	const y1 = Math.min(yMax, Math.floor(y + outer))
	if (x1 < x0 || y1 < y0) return undefined

	const innerSq = inner * inner
	const outerSq = outer * outer
	const samples = (workspace.samples = ensureCapacity(workspace.samples, (x1 - x0 + 1) * (y1 - y0 + 1)))
	let count = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		const dy = py - y
		const dy2 = dy * dy
		const outerHalf = Math.sqrt(Math.max(0, outerSq - dy2))
		const end = Math.min(x1, Math.floor(x + outerHalf) + 1)
		// Columns more than one pixel inside the inner circle are skipped without a distance test.
		const innerHalf = dy2 < innerSq ? Math.sqrt(innerSq - dy2) : 0
		const holeStart = Math.floor(x - innerHalf) + 2
		const holeEnd = Math.ceil(x + innerHalf) - 2

		for (let px = Math.max(x0, Math.ceil(x - outerHalf) - 1); px <= end; px++) {
			if (px >= holeStart && px < holeEnd) {
				px = holeEnd
				if (px > end) break
			}

			const dx = px - x
			const d2 = dx * dx + dy2
			if (d2 < innerSq || d2 > outerSq) continue
			samples[count++] = raw[row + px]
		}
	}

	if (count <= 0) return undefined

	const median = medianBySelectionOf(samples, count)
	for (let i = 0; i < count; i++) samples[i] = Math.abs(samples[i] - median)
	return [median, STANDARD_DEVIATION_SCALE * medianBySelectionOf(samples, count), count]
}

// Computes the median and scaled-MAD deviation of STAR_DISTANT_SKY_SAMPLES samples evenly spaced on a
// circle of `radius` pixels around (x, y), skipping those outside the image less the PSF margin. A sparse
// ring keeps this reference cheap for the thousands of candidates of a frame. Reorders the workspace
// samples; undefined when no sample falls inside.
function distantSkyStatistics(raw: Image['raw'], stride: number, x: number, y: number, radius: number, width: number, height: number, workspace: PhotometryWorkspace): AnnulusStatistics | undefined {
	const samples = (workspace.samples = ensureCapacity(workspace.samples, STAR_DISTANT_SKY_SAMPLES))
	const xMax = width - STAR_CONVOLVED_MARGIN - 1
	const yMax = height - STAR_CONVOLVED_MARGIN - 1
	let count = 0

	for (let i = 0; i < STAR_DISTANT_SKY_SAMPLES; i++) {
		const px = Math.round(x + radius * DISTANT_SKY_COS[i])
		const py = Math.round(y + radius * DISTANT_SKY_SIN[i])
		if (px < STAR_CONVOLVED_MARGIN || py < STAR_CONVOLVED_MARGIN || px > xMax || py > yMax) continue
		samples[count++] = raw[py * stride + px]
	}

	if (count <= 0) return undefined

	const median = medianBySelectionOf(samples, count)
	for (let i = 0; i < count; i++) samples[i] = Math.abs(samples[i] - median)
	return [median, STANDARD_DEVIATION_SCALE * medianBySelectionOf(samples, count), count]
}

// Returns the number of curve-of-growth bins that holds every sample of an aperture of `radius` pixels: its
// spread reaches `radius` + STAR_HFD_SAMPLE_HALF_WIDTH, and each ramp touches the bin after its start.
export function curveOfGrowthBinCount(radius: number) {
	return Math.ceil((radius + STAR_HFD_SAMPLE_HALF_WIDTH) / STAR_HFD_BIN_WIDTH) + 2
}

// Adds a sample's positive signal to the curve of growth, spread uniformly over the radii from
// `distance` - STAR_HFD_SAMPLE_HALF_WIDTH to `distance` + STAR_HFD_SAMPLE_HALF_WIDTH pixels, clamped at
// the center. The spread is a rising ramp minus a later one, and each ramp touches only the two second
// differences around its start, so a sample costs O(1). The bins must extend one bin past the radius
// `distance` + STAR_HFD_SAMPLE_HALF_WIDTH.
export function addToCurveOfGrowth(secondDifferences: Float64Array, distance: number, signal: number) {
	const start = Math.max(0, distance - STAR_HFD_SAMPLE_HALF_WIDTH)
	const end = distance + STAR_HFD_SAMPLE_HALF_WIDTH
	const density = signal / (end - start)
	addRampToCurveOfGrowth(secondDifferences, start, density)
	addRampToCurveOfGrowth(secondDifferences, end, -density)
}

// Adds to the second differences, on the STAR_HFD_BIN_WIDTH grid, of a curve of growth a ramp of `slope`
// flux per pixel that starts at `radius` pixels.
function addRampToCurveOfGrowth(secondDifferences: Float64Array, radius: number, slope: number) {
	const position = radius / STAR_HFD_BIN_WIDTH
	const index = Math.floor(position)
	const fraction = position - index
	const weight = slope * STAR_HFD_BIN_WIDTH
	secondDifferences[index] += weight * (1 - fraction)
	secondDifferences[index + 1] += weight * fraction
}

// Returns the diameter, in pixels, at which the curve of growth given by its first `count` second
// differences reaches half of `flux`, interpolated linearly inside the crossing bin; 0 when it never does.
export function halfFluxDiameter(secondDifferences: Readonly<Float64Array>, count: number, flux: number) {
	const halfFlux = 0.5 * flux
	let binFlux = 0
	let cumulative = 0

	for (let i = 0; i < count; i++) {
		binFlux += secondDifferences[i]
		if (binFlux > 0 && cumulative + binFlux >= halfFlux) return 2 * (i + Math.min(1, (halfFlux - cumulative) / binFlux)) * STAR_HFD_BIN_WIDTH
		cumulative += binFlux
	}

	return 0
}

// Measures a circular aperture of `signalRadius` pixels centered on (x, y): the sky is the median of the
// annulus between `backgroundInnerRadius` and `backgroundOuterRadius` and the noise its MAD scaled to a
// standard deviation, both inside the image less `margin` pixels per side. Flux, centroid, moments and
// the curve of growth use only the positive signal above the sky; the edge band keeps its sign so noise
// averages out there. Undefined when the center or the radii are invalid or there is no positive flux.
function measureAperture(raw: Image['raw'], width: number, height: number, stride: number, x: number, y: number, signalRadius: number, backgroundInnerRadius: number, backgroundOuterRadius: number, margin: number, workspace: PhotometryWorkspace): ApertureMeasurement | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(signalRadius) || signalRadius <= 0) return undefined
	if (!Number.isFinite(backgroundInnerRadius) || !Number.isFinite(backgroundOuterRadius) || backgroundInnerRadius <= signalRadius || backgroundOuterRadius < backgroundInnerRadius) return undefined

	const xMin = margin
	const yMin = margin
	const xMax = width - margin - 1
	const yMax = height - margin - 1
	if (x < xMin || x > xMax || y < yMin || y > yMax) return undefined

	const sky = annulusStatistics(raw, stride, x, y, backgroundInnerRadius, backgroundOuterRadius, xMin, yMin, xMax, yMax, workspace)
	if (sky === undefined) return undefined

	const [background, noise, skyCount] = sky
	const x0 = Math.max(xMin, Math.ceil(x - signalRadius))
	const y0 = Math.max(yMin, Math.ceil(y - signalRadius))
	const x1 = Math.min(xMax, Math.floor(x + signalRadius))
	const y1 = Math.min(yMax, Math.floor(y + signalRadius))
	const signalRadiusSq = signalRadius * signalRadius
	const edgeRadius = Math.max(0, signalRadius - 1)
	const edgeRadiusSq = edgeRadius * edgeRadius
	const binCount = curveOfGrowthBinCount(signalRadius)
	const bins = (workspace.bins = ensureCapacity(workspace.bins, binCount))
	bins.fill(0, 0, binCount)
	let flux = 0
	let netFlux = 0
	let radialMomentSq = 0
	let aperturePixels = 0
	let weightedX = 0
	let weightedY = 0
	let edgeSignal = 0
	let edgeCount = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		const dy = py - y
		const dy2 = dy * dy

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const d2 = dx * dx + dy2
			if (d2 > signalRadiusSq) continue
			aperturePixels++
			const signal = raw[row + px] - background
			netFlux += signal

			if (d2 > edgeRadiusSq) {
				edgeSignal += signal
				edgeCount++
			}

			if (signal <= 0) continue
			flux += signal
			radialMomentSq += signal * d2
			weightedX += signal * px
			weightedY += signal * py
			addToCurveOfGrowth(bins, Math.sqrt(d2), signal)
		}
	}

	if (flux <= 0 || aperturePixels <= 0) return undefined

	const snr = flux / Math.sqrt(Math.max(flux + aperturePixels * noise * noise, Number.EPSILON))
	const hfd = halfFluxDiameter(bins, binCount, flux)
	// Gaussian-equivalent FWHM from the second radial moment; this avoids fitting a noisy radial profile.
	const fwhm = radialMomentSq > 0 ? 2 * Math.sqrt((Math.LN2 * radialMomentSq) / flux) : 0
	const centroidX = weightedX / flux
	const centroidY = weightedY / flux
	let momentXX = 0
	let momentXY = 0
	let momentYY = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		const dy = py - y
		const dy2 = dy * dy

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			if (dx * dx + dy2 > signalRadiusSq) continue
			const signal = raw[row + px] - background
			if (signal <= 0) continue
			const centerX = px - centroidX
			const centerY = py - centroidY
			momentXX += signal * centerX * centerX
			momentXY += signal * centerX * centerY
			momentYY += signal * centerY * centerY
		}
	}

	const { eccentricity, elongation, majorVariance, minorVariance, theta } = starMomentShape(momentXX / flux, momentXY / flux, momentYY / flux)
	return { radius: signalRadius, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta, centroidX, centroidY, sky: background, noise, skyCount, netFlux, aperturePixels, edgeSignal, edgeCount }
}

// Builds summed-area tables for fast local mean and variance queries.
function buildIntegralImages(raw: Image['raw'], width: number, height: number, stride: number) {
	const integralWidth = width + 1
	const size = integralWidth * (height + 1)
	const sum = new Float64Array(size)
	const sumSq = new Float64Array(size)

	for (let y = 0; y < height; y++) {
		const rowOffset = y * stride
		const integralRow = (y + 1) * integralWidth
		const prevIntegralRow = y * integralWidth
		let rowSum = 0
		let rowSumSq = 0

		for (let x = 0; x < width; x++) {
			const value = clamp(raw[rowOffset + x], 0, 1)
			rowSum += value
			rowSumSq += value * value
			const index = integralRow + x + 1
			const prevIndex = prevIntegralRow + x + 1
			sum[index] = sum[prevIndex] + rowSum
			sumSq[index] = sumSq[prevIndex] + rowSumSq
		}
	}

	return [sum, sumSq, integralWidth] as const
}

// Computes local mean and standard deviation from the summed-area tables.
function localStatistics(image: IntegralImages, left: number, top: number, right: number, bottom: number) {
	const x0 = left
	const y0 = top
	const x1 = right + 1
	const y1 = bottom + 1
	const s = image[0]
	const sq = image[1]
	const width = image[2]
	const a = y0 * width + x0
	const b = y0 * width + x1
	const c = y1 * width + x0
	const d = y1 * width + x1
	const count = (right - left + 1) * (bottom - top + 1)
	const sum = s[d] - s[b] - s[c] + s[a]
	const sumSq = sq[d] - sq[b] - sq[c] + sq[a]
	const mean = sum / count
	const variance = Math.max(0, sumSq / count - mean * mean)
	return [mean, Math.sqrt(variance)] as const
}

// Removes duplicate detections that lie within sqrt(minLimitSq) pixels of an earlier star (in place).
export function mergeVeryCloseStars(stars: StarList, minLimitSq: number = 25) {
	if (stars.size <= 0) return

	let previous: Star | undefined
	let current = stars.first()

	while (current !== undefined) {
		const a = current
		let b = a.next
		let deleted = false

		while (b !== undefined) {
			const dx = a.x - b.x
			const dy = a.y - b.y
			const d2 = dx * dx + dy * dy

			if (d2 < minLimitSq) {
				const next = a.next
				stars.deleteAfter(previous)
				deleted = true
				current = previous ? previous.next : next
				break
			}

			b = b.next
		}

		if (!deleted) {
			previous = a
			current = a.next
		}
	}
}

// Removes pairs of stars that fall within `searchRegion` (plus a safety margin) of each other in both
// axes, unless one is much brighter than the other (so a dim star cannot eliminate a bright one).
export function excludeStarsFitWithinRegion(stars: StarList, searchRegion: number) {
	if (stars.size <= 0) return

	let current = stars.first()
	const deleted = new Set<Star>()

	searchRegion += 5 // extra safety margin

	while (current !== undefined) {
		const a = current
		let b = a.next
		current = b

		while (b !== undefined) {
			const dx = Math.abs(a.x - b.x)
			const dy = Math.abs(a.y - b.y)

			if (dx <= searchRegion && dy <= searchRegion) {
				// stars closer than search region, exclude them both
				// but do not let a very dim star eliminate a very bright star
				if (b.h / a.h < 5) {
					deleted.add(a)
					deleted.add(b)
				}
			}

			b = b.next
		}
	}

	let previous: Star | undefined
	current = stars.first()

	while (current !== undefined) {
		if (deleted.has(current)) {
			stars.deleteAfter(previous)
			current = previous?.next ?? stars.first()
		} else {
			previous = current
			current = current.next
		}
	}
}

// Internal doubly linked-list node for a candidate star during detection.
interface Star {
	// Pixel x coordinate.
	readonly x: number
	// Pixel y coordinate.
	readonly y: number
	// Peak height (brightness) of the candidate.
	readonly h: number
	// Measured flux, when computed.
	readonly flux?: number
	// Signal-to-noise ratio, when computed.
	readonly snr?: number
	// Half-flux diameter, when computed.
	readonly hfd?: number
	// FWHM, when computed.
	readonly fwhm?: number
	// Eccentricity, when computed.
	readonly eccentricity?: number
	// Major/minor axis ratio, when computed.
	readonly elongation?: number
	// Major and minor central second moments, in squared image pixels.
	readonly majorVariance?: number
	readonly minorVariance?: number
	// Major-axis orientation in [0, PI), clockwise in image coordinates.
	readonly theta?: Angle
	// Next node in the list.
	next?: this
	// Previous node in the list.
	prev?: this
}

// Intrusive doubly linked list of candidate stars, supporting in-place pruning during detection.
export class StarList implements Iterable<Star, Star | undefined, Star> {
	#head?: Star
	#tail?: Star
	size = 0

	constructor(readonly capacity: number = 100) {}

	// Returns the first star without allocating an iterator.
	first() {
		return this.#head
	}

	// Appends a star at the tail (brightest end).
	addLast(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number, majorVariance?: number, minorVariance?: number, theta?: Angle) {
		const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta }

		if (!this.#head) {
			this.#head = star
			this.#tail = star
		} else if (this.#tail) {
			star.prev = this.#tail
			this.#tail.next = star
			this.#tail = star
		}

		this.size++
	}

	// Prepends a star at the head (dimmest end).
	addFirst(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number, majorVariance?: number, minorVariance?: number, theta?: Angle) {
		const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta }

		if (!this.#head) {
			this.#head = star
			this.#tail = star
		} else {
			star.next = this.#head
			this.#head.prev = star
			this.#head = star
		}

		this.size++
	}

	// Inserts a star keeping the list sorted by ascending height, searching from the nearer end, and
	// evicts the dimmest star (head) when the capacity is exceeded.
	add(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number, majorVariance?: number, minorVariance?: number, theta?: Angle) {
		if (!this.#head || h <= this.#head.h) {
			if (this.size < this.capacity) this.addFirst(x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta)
		} else if (!this.#tail || h >= this.#tail.h) {
			this.addLast(x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta)
		} else {
			const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta }
			const headDistance = h - this.#head.h
			const tailDistance = this.#tail.h - h

			if (tailDistance < headDistance) {
				for (let a: Star | undefined = this.#tail; a; a = a.prev) {
					if (h < a.h) continue

					const next = a.next
					star.prev = a
					star.next = next
					a.next = star
					if (next) next.prev = star
					this.size++

					break
				}
			} else {
				for (let a: Star | undefined = this.#head; a; a = a.next) {
					if (a.next && h >= a.next.h) continue

					const next = a.next
					star.prev = a
					star.next = next
					a.next = star
					if (next) next.prev = star
					this.size++

					break
				}
			}
		}

		if (this.size > this.capacity) {
			this.deleteFirst()
		}
	}

	// Removes the head (dimmest) star; returns false when the list is empty.
	deleteFirst() {
		if (!this.#head) return false

		this.#head = this.#head.next
		if (this.#head) this.#head.prev = undefined
		else this.#tail = undefined

		this.size--

		return true
	}

	// Deletes the first node or the node after `previous` in O(1).
	deleteAfter(previous?: Star) {
		if (!previous) return this.deleteFirst()

		const current = previous.next
		if (!current) return false

		const next = current.next
		previous.next = next
		if (next) next.prev = previous
		if (current === this.#tail) this.#tail = previous
		current.prev = undefined
		current.next = undefined
		this.size--

		return true
	}

	// Removes a specific star node from the list.
	delete(s: Star) {
		if (this.#head && s === this.#head) return this.deleteFirst()
		return s.prev ? this.deleteAfter(s.prev) : false
	}

	// Empties the list.
	clear() {
		this.#head = undefined
		this.#tail = undefined
		this.size = 0
	}

	// Materializes the list into an array (head-to-tail, dim-to-bright order).
	array() {
		const n = this.size
		const data = new Array<Star>(n)
		for (let i = 0, s = this.#head; i < n; i++, s = s!.next) data[i] = s!
		return data
	}

	// Returns a forward iterator over the stars.
	iterator(): Iterator<Star, Star | undefined> {
		let current = this.#head

		return {
			next: () => {
				if (current) {
					const value = current
					current = current.next
					return { value, done: false }
				} else {
					return { value: undefined, done: true }
				}
			},
		} as const
	}

	[Symbol.iterator]() {
		return this.iterator()
	}
}
