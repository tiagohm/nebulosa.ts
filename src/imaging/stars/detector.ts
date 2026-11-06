import { quickSelect } from '../../math/numerical/array'
import type { Point } from '../../math/numerical/geometry'
import { medianBySelectionOf, STANDARD_DEVIATION_SCALE } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import type { Image } from '../model/types'
import { debayer } from '../processing/debayer'
import { grayscale } from '../processing/geometry'
import { starMomentShape } from './shape'

// Star detection and photometry for an image. Which stars exist is decided by a port of the star
// extraction of ASTAP (`analyse_image`, `HFD` and `get_background` of its command-line version, the
// `-extract` option): the sky and its noise come from the histogram of the whole frame, every pixel
// above a detection level with two bright neighbors is measured with ASTAP's HFD routine, a star is
// kept when its HFD and SNR pass ASTAP's limits, and its area is masked so it is not found twice; the
// detection level steps down from the star-dominated levels to 7 sky deviations until enough stars
// are found. ASTAP works in ADU, so the normalized samples are multiplied by 255 for 8-bit FITS images and
// by 65535 otherwise, as ASTAP loads them. Each accepted star is then measured again by aperture/annulus
// photometry around ASTAP's center of gravity, for its flux, half-flux diameter (HFD), FWHM and shape.
// That HFD comes from a curve of growth on which every sample spreads its flux over the radii within
// half a pixel of its center, so it is stable against sub-pixel motion. The aperture is fixed at
// STAR_SIGNAL_RADIUS unless a larger maximum radius is requested, in which case it grows until it
// holds the whole star (defocused stars for focusing). The published (x, y) is the flux-weighted
// centroid of that aperture, so sub-pixel motion is visible to guiders. Centroids are zero-based image
// coordinates: origin at the upper-left sample, +X right, +Y down. Intensities use the normalized
// processing scale, which is not a permanent [0, 1] clamp. One call allocates an ADU copy and a mask
// of the frame; the measurement buffers are reused within the call. Also provides utilities to merge
// close detections and to drop pairs that would share a guiding search box.

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
	// ASTAP's signal-to-noise ratio, flux / sqrt(flux + PI r² σ²) in ADU with a gain of 1 e-/ADU, where the flux
	// is the sum above the local sky inside ASTAP's star radius r and σ the sky deviation of its annulus.
	readonly snr: number
	// ASTAP's flux: the sum of the samples above the local sky over the square of half side r around the center of
	// gravity, in the normalized sample scale. It holds the whole star, so it ranks large and bright stars correctly.
	readonly flux: number
}

// Options controlling star detection.
export interface DetectStarOptions {
	// Number of stars that ends ASTAP's descent of the detection level, and the most stars returned (the
	// brightest by flux are kept). It also sets ASTAP's star levels: the sample levels exceeded by 6 and
	// 24 pixels per wanted star.
	readonly maxStars: number
	// Tracking-box size, in pixels. When positive, pairs of comparable-brightness stars that would
	// both fit inside one search box (plus a 5-pixel margin) are removed, matching the PHD2
	// uniqueness filter. This is not a central crop of the frame.
	readonly searchRegion?: number
	// SNR a star must exceed to be kept, as ASTAP's `-extract` minimum. A value of 30 or more also skips
	// ASTAP's 30-sigma detection level, and above 7 it raises the last level to that many sky deviations.
	readonly minSNR?: number
	// Largest signal-aperture radius, in pixels. The default, STAR_SIGNAL_RADIUS, keeps the fixed
	// aperture. A larger value widens ASTAP's search box to this radius when above its 14 pixels and
	// grows the aperture of each star whose light reaches its edge or covers its sky annulus, until the
	// star fits; a star that does not fit at this radius, or whose grown aperture leaves the image, is dropped.
	readonly maximumRadius?: number
}

// Sky of a frame as ASTAP's get_background finds it, all in ADU.
interface AstapBackground {
	// Most common sample value, or the mean when that is more than 1.5 times larger.
	readonly background: number
	// Standard deviation of the sky samples, 3-sigma clipped.
	readonly noise: number
	// Levels above the background exceeded by 6 and 24 pixels per wanted star, at least 3.5 noise and 1 ADU.
	readonly starLevel: number
	readonly starLevel2: number
}

// One star as ASTAP's HFD routine measures it, in ADU and zero-based pixels.
interface AstapStar {
	// Approximate half-flux diameter, 2 Σ(signal r) / Σ signal over the square of the star radius, in pixels.
	readonly hfd: number
	// Diameter of the area at or above half of the peak, in pixels.
	readonly fwhm: number
	// Signal-to-noise ratio with a gain of 1 e-/ADU.
	readonly snr: number
	// Sum of the signal above the local sky, in ADU.
	readonly flux: number
	// Center of gravity of the samples 3 deviations above the local sky, zero-based pixels.
	readonly x: number
	readonly y: number
	// Distance from the center of gravity, in whole pixels, at which the signal of the star drops off.
	readonly radius: number
}

// One detection pass of ASTAP's analyse_image.
interface AstapPass {
	// ASTAP's retry counter of the pass, from 4 down to 1, also its mark on the mask of found stars.
	readonly marker: number
	// Detection level above the background, in ADU.
	readonly level: number
}

// Geometry and scratch buffers of ASTAP's HFD routine for one frame width and one search box, built once per
// detection so each measurement only reads tables. Offsets are linear sample offsets in the packed frame; the
// distance tables cover the square of half side `tableRadius` pixels, indexed by (i + tableRadius) * tableSide
// + (j + tableRadius) for the column offset i and the row offset j.
interface AstapWorkspace {
	// Half side, in pixels, of the search box.
	readonly box: number
	// Offsets of the samples of the one-pixel sky annulus beyond the box.
	readonly annulusOffsets: Int32Array
	// Values of the annulus samples, then their absolute deviations, reordered in place by the median.
	readonly annulus: Float64Array
	// Offsets of the samples of the box, with their column and row offsets, in pixels, and their square ring
	// max(|i|, |j|), so the sums of every smaller box are prefix sums over the rings.
	readonly cellOffsets: Int32Array
	readonly cellX: Int32Array
	readonly cellY: Int32Array
	readonly cellRings: Int32Array
	// Signal sum, its x and y moments, in ADU pixels, and signal sample count per square ring.
	readonly ringSum: Float64Array
	readonly ringSumX: Float64Array
	readonly ringSumY: Float64Array
	readonly ringCount: Int32Array
	// Half side, in pixels, of the distance tables: the box plus the 2 pixels ASTAP adds around a star.
	readonly tableRadius: number
	readonly tableSide: number
	// Distance from the center, in pixels, rounded and exact.
	readonly roundedDistances: Int32Array
	readonly distances: Float64Array
	// Number of signal samples per rounded distance from the center of gravity.
	readonly histogram: Int32Array
	// Interpolated samples less the local sky, in ADU, on the square around the center of gravity.
	readonly samples: Float64Array
	// Integer part, fraction and validity of the interpolated columns and rows around the center of gravity.
	readonly columnStart: Int32Array
	readonly columnFraction: Float64Array
	readonly columnValid: Uint8Array
	readonly rowStart: Int32Array
	readonly rowFraction: Float64Array
	readonly rowValid: Uint8Array
}

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
	// Background-limited signal-to-noise ratio, netFlux / (noise * sqrt(pixels)): dimensionless, so the same in any
	// sample scale, and centred on 0 for a sky aperture.
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
export const STAR_GROWTH_SIGNIFICANCE = 4
// Standard error of the median of normal samples relative to that of their mean, sqrt(PI / 2).
const MEDIAN_STANDARD_ERROR_SCALE = Math.sqrt(Math.PI / 2)
// Number of samples of the distant sky circle of an adaptive aperture. 32 gives a median standard error
// of about 0.22 sky deviations, enough to see the face of a defocused star about 1 deviation above the
// sky, while keeping the scattered reads cheap for the thousands of stars of a frame.
const STAR_DISTANT_SKY_SAMPLES = 32
// Minimum number of samples for the distant sky to be a usable reference of an adaptive aperture.
const STAR_MIN_DISTANT_SKY_SAMPLES = 8
// Unit-circle cosines and sines of the evenly spaced distant sky samples.
const DISTANT_SKY_COS = Float64Array.from({ length: STAR_DISTANT_SKY_SAMPLES }, (_, i) => Math.cos((2 * Math.PI * i) / STAR_DISTANT_SKY_SAMPLES))
const DISTANT_SKY_SIN = Float64Array.from({ length: STAR_DISTANT_SKY_SAMPLES }, (_, i) => Math.sin((2 * Math.PI * i) / STAR_DISTANT_SKY_SAMPLES))
// Border margin, in pixels, that the photometry apertures and their sky annuli stay inside.
const STAR_BORDER_MARGIN = 4
// Extra photometry passes after the first one, recentering on the flux-weighted centroid.
const STAR_CENTROID_REFINEMENTS = 2
// Stop recentering when the centroid moves by this many pixels or less.
const STAR_CENTROID_TOLERANCE = 0.05

// ADU per normalized unit of an 8-bit FITS image, which ASTAP keeps in 0 to 255.
const ASTAP_8BIT_SCALE = 255
// ADU per normalized unit of every other image: ASTAP keeps 16-bit samples, scales floats up to 1.5 by 65535, and
// reads 8-bit PNG, JPEG, TIFF and BMP images at 16 bits, each 8-bit value times 257.
const ASTAP_16BIT_SCALE = 65535
// Size of ASTAP's sample histogram, one bin per ADU.
const ASTAP_HISTOGRAM_SIZE = 65536
// Samples at or above this level, in ADU, are left out of the histogram as saturated stars.
const ASTAP_HISTOGRAM_LIMIT = 65000
// Fractions of the width and the height left out of the histogram on each side (unused areas of raw sensors).
const ASTAP_HISTOGRAM_BORDER_X = 0.042
const ASTAP_HISTOGRAM_BORDER_Y = 0.015
// Highest histogram level, in ADU, from which the star levels are searched downwards, for 8-bit FITS and other images.
const ASTAP_8BIT_STAR_LEVEL_TOP = 255
const ASTAP_16BIT_STAR_LEVEL_TOP = 65001
// The noise is sampled on a grid of about this many steps along the height.
const ASTAP_NOISE_GRID_STEPS = 71
// Border, in pixels, left out of the noise grid.
const ASTAP_NOISE_BORDER = 15
// Most sigma-clipping passes of the noise; it also stops once a pass lowers it by less than 5%.
const ASTAP_NOISE_ITERATIONS = 7
// Clipping of the noise passes after the first, in standard deviations.
const ASTAP_NOISE_CLIP = 3
// Pixels above the star levels per wanted star, empirical values of ASTAP for stars of 2.25 and 4.5 pixels of HFD.
const ASTAP_STAR_LEVEL_PIXELS = 6
const ASTAP_STAR_LEVEL2_PIXELS = 24
// Lowest star level, in sky deviations.
const ASTAP_STAR_LEVEL_SIGMA = 3.5
// A star level is used for detection only above this many sky deviations (stars dominate the frame); it is
// also the level of the third pass.
const ASTAP_DOMINANT_SIGMA = 30
// Level of the last pass, in sky deviations, unless the minimum SNR is higher.
const ASTAP_FAINT_SIGMA = 7
// Number of detection passes, each at a lower level.
const ASTAP_PASSES = 4
// A pixel above the detection level starts a star only when at least 2 of its 4 direct neighbors are this
// many sky deviations above the background, so a hot pixel does not.
const ASTAP_NEIGHBOR_SIGMA = 4
const ASTAP_MIN_BRIGHT_NEIGHBORS = 2
// Half side, in pixels, of ASTAP's search box around a pixel that starts a star.
const ASTAP_BOX_RADIUS = 14
// A sample is signal when it is this many deviations of the local sky above it.
const ASTAP_SIGNAL_SIGMA = 3
// A box whose signal sums to this many local sky deviations or less holds no star.
const ASTAP_MIN_SIGNAL_SIGMA = 12
// Fraction of the box that the signal samples must cover, or the box shrinks to leave out its neighbors.
const ASTAP_BOXED_FRACTION = 2 / 9
// The star ends at the first distance whose signal samples drop to this fraction of the most at one distance.
const ASTAP_DROP_OFF = 0.1
// Fraction of the square of the star diameter less 2 pixels that its signal must cover, or it is a group of stars.
const ASTAP_DISK_FILL = 0.35
// Floor, in ADU, of the local sky deviation and of the star levels, so a noise-free sky is not read as a star.
const ASTAP_MIN_NOISE = 1
// MAD to standard deviation of a normal distribution, as ASTAP rounds it.
const ASTAP_MAD_SCALE = 1.4826
// Floor of the flux, in ADU, against a division by zero.
const ASTAP_MIN_FLUX = 0.00001
// Floor of the HFD, in pixels.
const ASTAP_HFD_FLOOR = 0.7
// HFD range, in pixels, of an accepted star: above 0.8 (two pixels) and at most 30, the upper limit growing in
// proportion when the search box is wider than ASTAP_BOX_RADIUS.
const ASTAP_MIN_HFD = 0.8
const ASTAP_MAX_HFD = 30
// Radius, in HFDs, of the area of an accepted star masked against a second detection.
const ASTAP_MASK_HFD_SCALE = 3

// Default star-detection options.
const DEFAULT_DETECT_STARS_OPTIONS: Readonly<DetectStarOptions> = {
	maxStars: 500,
	searchRegion: 0,
	minSNR: 0,
	maximumRadius: STAR_SIGNAL_RADIUS,
}

// Converts RGB or raw CFA input into a coherent mono intensity image for detection and photometry.
function starAnalysisImage(image: Image): Image | undefined {
	image = grayscale(image)
	if (!image.metadata.bayer) return image
	const color = debayer(image)
	return color && grayscale(color)
}

// Detects stars in an image with ASTAP's star extraction and returns them sorted by descending flux (up to
// maxStars), optionally pruned with the PHD2 search-box uniqueness filter. ASTAP decides which stars exist and
// gives their flux, which ranks them, and SNR; each one is then measured on the normalized samples around
// ASTAP's center of gravity for its centroid, HFD, FWHM and shape. When that aperture has no positive flux,
// ASTAP's own center, HFD and FWHM are published instead; with a growing aperture such a star, or one that does
// not fit, is dropped.
export function detectStars(image: Image, { maxStars = 500, searchRegion = 0, minSNR = 0, maximumRadius = STAR_SIGNAL_RADIUS }: Partial<DetectStarOptions> = DEFAULT_DETECT_STARS_OPTIONS): DetectedStar[] {
	const intensity = starAnalysisImage(image)
	if (intensity === undefined) return []

	const { raw, metadata } = intensity
	const { width, height, stride, bitpix } = metadata
	// Only a FITS header has SIMPLE: an 8-bit image from another format is 16-bit to ASTAP.
	const eightBit = bitpix === 8 && image.header.SIMPLE !== undefined
	const scale = eightBit ? ASTAP_8BIT_SCALE : ASTAP_16BIT_SCALE
	const adu = aduImage(raw, width, height, stride, scale)
	const sky = astapBackground(adu, width, height, eightBit, maxStars)
	const found = astapFindStars(adu, width, height, sky, Math.max(ASTAP_BOX_RADIUS, Math.ceil(maximumRadius)), minSNR, maxStars)
	const adaptive = maximumRadius > STAR_SIGNAL_RADIUS
	const stars = new StarList(maxStars)
	const workspace: PhotometryWorkspace = { samples: new Float64Array(0), bins: new Float64Array(0) }

	for (const star of found) {
		const photometry = measureStarAt(raw, width, height, stride, star.x, star.y, star.radius, maximumRadius, workspace)
		const flux = star.flux / scale

		if (photometry !== undefined) {
			const { hfd, fwhm, eccentricity, elongation, centroidX, centroidY, majorVariance, minorVariance, theta } = photometry
			stars.add(centroidX, centroidY, flux, flux, star.snr, hfd, fwhm, eccentricity, elongation, majorVariance, minorVariance, theta)
		} else if (!adaptive) {
			stars.add(star.x, star.y, flux, flux, star.snr, star.hfd, star.fwhm)
		}
	}

	if (searchRegion > 0) {
		// Exclude stars that would fit within a single search region box
		excludeStarsFitWithinRegion(stars, searchRegion)
	}

	let i = 0
	const res = new Array<DetectedStar>(stars.size)

	for (const { x, y, flux = 0, snr = 0, hfd = 0, fwhm = 0, eccentricity, elongation, majorVariance, minorVariance, theta } of stars) {
		res[i++] = { x, y, flux, hfd, fwhm, snr, eccentricity, elongation, majorVariance, minorVariance, theta }
	}

	res.sort((left, right) => right.flux - left.flux)
	return res
}

// Copies the samples of a mono image, `stride` samples per row, into a packed single-precision buffer in ADU,
// `scale` ADU per normalized unit, as ASTAP holds an image.
function aduImage(raw: Image['raw'], width: number, height: number, stride: number, scale: number) {
	const adu = new Float32Array(width * height)

	for (let y = 0; y < height; y++) {
		const row = y * stride
		const packed = y * width
		for (let x = 0; x < width; x++) adu[packed + x] = raw[row + x] * scale
	}

	return adu
}

// Median as ASTAP's SMedian computes it: of the sorted values, the middle one for up to 3 values, the mean of the
// middle three for more odd ones and of the middle two for even ones; NaN when empty. The order statistics are
// selected instead of sorting, which adds them in the same order, so the result is the same; the prefix of
// `count` values is reordered in place.
function astapMedian(values: Float64Array, count: number) {
	if (count === 0) return Number.NaN
	if (count === 1) return values[0]

	const middle = (count - 1) >> 1
	const center = quickSelect(values, count, middle)
	if ((count & 1) === 1 && count <= 3) return center

	// After the selection, the values before the middle are not greater and the ones after it not smaller.
	let next = values[middle + 1]
	for (let i = middle + 2; i < count; i++) if (values[i] < next) next = values[i]
	if ((count & 1) === 0) return (center + next) / 2

	let previous = values[0]
	for (let i = 1; i < middle; i++) if (values[i] > previous) previous = values[i]
	return (previous + center + next) / 3
}

// Finds the sky of a frame of `width` x `height` packed ADU samples as ASTAP's get_background does. The background
// is the peak of the histogram of the samples from 1 to 64999 ADU, without a border of 4.2% of the width and 1.5%
// of the height, searched up to their mean, or that mean when it is more than 1.5 times the peak. The noise is the
// standard deviation about the background of about 71 x 71 grid samples 15 pixels away from the border, nonzero
// and below twice the background, clipped at 3 deviations until it settles. The star levels are where the
// histogram, summed down from its top (255 ADU for 8-bit FITS images), first holds 6 and 24 pixels per wanted star.
function astapBackground(adu: Float32Array, width: number, height: number, eightBit: boolean, maxStars: number): AstapBackground {
	const histogram = new Uint32Array(ASTAP_HISTOGRAM_SIZE)
	const offsetX = Math.trunc(width * ASTAP_HISTOGRAM_BORDER_X)
	const offsetY = Math.trunc(height * ASTAP_HISTOGRAM_BORDER_Y)
	let total = 0
	// Starts at 1 as in ASTAP, against a division by zero.
	let count = 1

	for (let y = offsetY; y < height - offsetY; y++) {
		const row = y * width

		for (let x = offsetX; x < width - offsetX; x++) {
			const value = Math.round(adu[row + x])

			if (value >= 1 && value < ASTAP_HISTOGRAM_LIMIT) {
				histogram[value]++
				total += value
				count++
			}
		}
	}

	const mean = Math.round(total / count)
	let background = mean === 0 ? 0 : adu[0]

	for (let i = 1, pixels = 0; i <= mean; i++) {
		if (histogram[i] > pixels) {
			pixels = histogram[i]
			background = i
		}
	}

	if (mean > 1.5 * background) background = mean

	let step = Math.round(height / ASTAP_NOISE_GRID_STEPS)
	// An odd step does not land on one color of a raw CFA mosaic only.
	if (step % 2 === 0) step++

	let noise = Number.POSITIVE_INFINITY
	let previous: number
	let iterations = 0

	do {
		previous = noise
		let sum = 0
		let counter = 0

		for (let x = ASTAP_NOISE_BORDER; x <= width - 1 - ASTAP_NOISE_BORDER; x += step) {
			for (let y = ASTAP_NOISE_BORDER; y <= height - 1 - ASTAP_NOISE_BORDER; y += step) {
				const value = adu[y * width + x]
				if (!(value < 2 * background) || value === 0) continue
				if (iterations > 0 && !(Math.abs(value - background) <= ASTAP_NOISE_CLIP * previous)) continue
				sum += (value - background) * (value - background)
				counter++
			}
		}

		noise = counter > 0 ? Math.sqrt(sum / counter) : 0
		iterations++
	} while (!(previous - noise < 0.05 * noise || iterations >= ASTAP_NOISE_ITERATIONS))

	let starLevel = 0
	let starLevel2 = 0
	let above = 0
	let i = eightBit ? ASTAP_8BIT_STAR_LEVEL_TOP : ASTAP_16BIT_STAR_LEVEL_TOP

	while (starLevel === 0 && i > background + 1 && i > 0) {
		above += histogram[--i]
		if (above >= ASTAP_STAR_LEVEL_PIXELS * maxStars) starLevel = i
	}

	while (starLevel2 === 0 && i > background + 1 && i > 0) {
		above += histogram[--i]
		if (above >= ASTAP_STAR_LEVEL2_PIXELS * maxStars) starLevel2 = i
	}

	// Relative to the background, below a saturated level, and at least 3.5 deviations and 1 ADU.
	const floor = Math.max(ASTAP_STAR_LEVEL_SIGMA * noise, ASTAP_MIN_NOISE)
	return { background, noise, starLevel: Math.max(floor, starLevel - background - 1), starLevel2: Math.max(floor, starLevel2 - background - 1) }
}

// Returns the detection passes of ASTAP's analyse_image in order: the first star level and the second, each only
// when it is above 30 deviations (stars dominate the frame), 30 deviations unless `minSNR` is 30 or more, and
// finally `minSNR` but at least 7 deviations. Levels are in ADU above the background.
function astapPasses({ noise, starLevel, starLevel2 }: AstapBackground, minSNR: number): AstapPass[] {
	const dominant = ASTAP_DOMINANT_SIGMA * noise
	const passes: AstapPass[] = []
	if (starLevel > dominant) passes.push({ marker: 4, level: starLevel })
	if (starLevel2 > dominant) passes.push({ marker: 3, level: starLevel2 })
	if (minSNR < ASTAP_DOMINANT_SIGMA) passes.push({ marker: 2, level: dominant })
	passes.push({ marker: 1, level: Math.max(minSNR, ASTAP_FAINT_SIGMA) * noise })
	return passes
}

// Finds the stars of a frame of packed ADU samples as ASTAP's analyse_image does, with `box` pixels as the half
// side of its search box. Each pass scans the frame for a pixel above its detection level, not masked by a star
// of this pass, with at least 2 of its 4 direct neighbors 4 deviations above the background; ASTAP's HFD routine
// measures it, and the star is kept when its HFD is above 0.8 pixels and at most 30 (scaled with the box), its SNR
// exceeds `minSNR`, and its rounded center is not masked yet; a disk of 3 HFDs around that center is then masked.
// The passes (see astapPasses) stop once one finds `maxStars`. Returns the stars of the last pass, in scan order.
// The pixels that pass the neighbor test above the lowest level are collected once, in scan order, and each one is
// measured at most once, since the HFD routine and the acceptance do not depend on the pass; the passes then only
// walk that list, so they find what ASTAP's full scans find.
function astapFindStars(adu: Float32Array, width: number, height: number, sky: AstapBackground, box: number, minSNR: number, maxStars: number): AstapStar[] {
	const { background, noise } = sky
	const passes = astapPasses(sky, minSNR)
	const neighborLevel = ASTAP_NEIGHBOR_SIGMA * noise
	let lowest = passes[0].level
	for (let i = 1; i < passes.length; i++) lowest = Math.min(lowest, passes[i].level)

	let candidates = new Int32Array(4096)
	let count = 0

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const index = y * width + x
			if (!(adu[index] - background > lowest)) continue

			let bright = 0
			if (adu[index - 1] - background > neighborLevel) bright++
			if (adu[index + 1] - background > neighborLevel) bright++
			if (adu[index - width] - background > neighborLevel) bright++
			if (adu[index + width] - background > neighborLevel) bright++
			if (bright < ASTAP_MIN_BRIGHT_NEIGHBORS) continue

			if (count === candidates.length) {
				const grown = new Int32Array(2 * count)
				grown.set(candidates)
				candidates = grown
			}

			candidates[count++] = index
		}
	}

	const mask = new Uint8Array(width * height)
	const workspace = astapWorkspace(width, box)
	const maxHfd = (ASTAP_MAX_HFD * box) / ASTAP_BOX_RADIUS
	// Measurement state of each candidate: 0 not measured, 1 rejected, 2 accepted, with the accepted stars by candidate.
	const measured = new Uint8Array(count)
	const accepted = new Map<number, AstapStar>()
	let stars: AstapStar[] = []

	for (const { marker, level } of passes) {
		stars = []

		for (let k = 0; k < count; k++) {
			const index = candidates[k]
			if (mask[index] === marker || !(adu[index] - background > level)) continue

			if (measured[k] === 0) {
				const star = astapHfd(adu, width, height, index % width, Math.trunc(index / width), workspace)

				if (star !== undefined && star.hfd <= maxHfd && star.snr > minSNR && star.hfd > ASTAP_MIN_HFD) {
					measured[k] = 2
					accepted.set(k, star)
				} else {
					measured[k] = 1
				}
			}

			if (measured[k] === 1) continue

			const star = accepted.get(k)!
			const cx = Math.round(star.x)
			const cy = Math.round(star.y)
			if (mask[cy * width + cx] === marker) continue

			stars.push(star)
			maskStar(mask, width, height, cx, cy, Math.round(ASTAP_MASK_HFD_SCALE * star.hfd), marker)
		}

		if (stars.length >= maxStars) break
	}

	return stars
}

// Builds the geometry and scratch buffers of ASTAP's HFD routine for a packed frame `width` pixels wide and a
// search box of half side `box` pixels. The annulus holds the samples farther than `box` and at most `box` + 1
// pixels from the center, in ASTAP's order; the distance tables reach `box` + 2 pixels, the most ASTAP measures.
function astapWorkspace(width: number, box: number): AstapWorkspace {
	const outer = box + 1
	const innerSq = box * box
	const outerSq = outer * outer
	const annulus: number[] = []

	for (let i = -outer; i <= outer; i++) {
		for (let j = -outer; j <= outer; j++) {
			const distanceSq = i * i + j * j
			if (distanceSq > innerSq && distanceSq <= outerSq) annulus.push(j * width + i)
		}
	}

	const boxSide = 2 * box + 1
	const cellOffsets = new Int32Array(boxSide * boxSide)
	const cellX = new Int32Array(cellOffsets.length)
	const cellY = new Int32Array(cellOffsets.length)
	const cellRings = new Int32Array(cellOffsets.length)

	for (let i = -box, c = 0; i <= box; i++) {
		for (let j = -box; j <= box; j++, c++) {
			cellOffsets[c] = j * width + i
			cellX[c] = i
			cellY[c] = j
			cellRings[c] = Math.max(Math.abs(i), Math.abs(j))
		}
	}

	const tableRadius = box + 2
	const tableSide = 2 * tableRadius + 1
	const roundedDistances = new Int32Array(tableSide * tableSide)
	const distances = new Float64Array(tableSide * tableSide)

	for (let i = -tableRadius; i <= tableRadius; i++) {
		for (let j = -tableRadius; j <= tableRadius; j++) {
			const distance = Math.sqrt(i * i + j * j)
			const index = (i + tableRadius) * tableSide + j + tableRadius
			distances[index] = distance
			roundedDistances[index] = Math.round(distance)
		}
	}

	return {
		box,
		annulusOffsets: Int32Array.from(annulus),
		annulus: new Float64Array(annulus.length),
		cellOffsets,
		cellX,
		cellY,
		cellRings,
		ringSum: new Float64Array(box + 1),
		ringSumX: new Float64Array(box + 1),
		ringSumY: new Float64Array(box + 1),
		ringCount: new Int32Array(box + 1),
		tableRadius,
		tableSide,
		roundedDistances,
		distances,
		histogram: new Int32Array(tableRadius + 1),
		samples: new Float64Array(tableSide * tableSide),
		columnStart: new Int32Array(tableSide),
		columnFraction: new Float64Array(tableSide),
		columnValid: new Uint8Array(tableSide),
		rowStart: new Int32Array(tableSide),
		rowFraction: new Float64Array(tableSide),
		rowValid: new Uint8Array(tableSide),
	}
}

// Sets to `marker` the mask samples, of a `width` x `height` frame, within `radius` pixels of (x, y).
function maskStar(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number, marker: number) {
	const radiusSq = radius * radius
	const y0 = Math.max(0, y - radius)
	const y1 = Math.min(height - 1, y + radius)
	const x0 = Math.max(0, x - radius)
	const x1 = Math.min(width - 1, x + radius)

	for (let py = y0; py <= y1; py++) {
		const dy = py - y
		const row = py * width

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			if (dx * dx + dy * dy <= radiusSq) mask[row + px] = marker
		}
	}
}

// Measures the star around the pixel (x1, y1) of the packed ADU samples as ASTAP's HFD routine does, in the
// search box of the workspace. The local sky is the median of the one-pixel annulus beyond the box and its
// deviation the scaled MAD, at least 1 ADU. The center of gravity of the samples 3 deviations above the sky in the
// box is found, shrinking the box while those cover less than 2/9 of it, so a neighbor is left out; the star then
// ends where its signal samples per integer distance drop to a tenth of their most. Undefined, as ASTAP's HFD of
// 999, near the border, without enough signal, for a hot pixel, a star as large as the box, or a group of stars.
// The box is summed once, per square ring, so a smaller box is a prefix of the rings; that adds the samples in
// another order than ASTAP, which changes the center of gravity only by rounding. The samples around the center
// of gravity are interpolated as value_subpixel does (0 near the border), with the column and row weights of the
// offsets computed once, and kept for the HFD sum.
function astapHfd(adu: Float32Array, width: number, height: number, x1: number, y1: number, workspace: AstapWorkspace): AstapStar | undefined {
	let radius = workspace.box
	const outer = radius + 1
	if (x1 - outer <= 0 || x1 + outer >= width - 1 || y1 - outer <= 0 || y1 + outer >= height - 1) return undefined

	const center = y1 * width + x1
	const { annulusOffsets, annulus } = workspace
	const count = annulusOffsets.length
	for (let k = 0; k < count; k++) annulus[k] = adu[center + annulusOffsets[k]]

	const sky = astapMedian(annulus, count)
	for (let k = 0; k < count; k++) annulus[k] = Math.abs(annulus[k] - sky)
	const noise = Math.max(astapMedian(annulus, count) * ASTAP_MAD_SCALE, ASTAP_MIN_NOISE)
	const signalLevel = ASTAP_SIGNAL_SIGMA * noise

	const { cellOffsets, cellX, cellY, cellRings, ringSum, ringSumX, ringSumY, ringCount } = workspace
	ringSum.fill(0)
	ringSumX.fill(0)
	ringSumY.fill(0)
	ringCount.fill(0)

	for (let c = 0; c < cellOffsets.length; c++) {
		const value = adu[center + cellOffsets[c]] - sky

		if (value > signalLevel) {
			const ring = cellRings[c]
			ringSum[ring] += value
			ringSumX[ring] += value * cellX[c]
			ringSumY[ring] += value * cellY[c]
			ringCount[ring]++
		}
	}

	let xc = 0
	let yc = 0

	// Shrinks the box until the star fills it, to leave out nearby stars.
	while (true) {
		let sum = 0
		let sumX = 0
		let sumY = 0
		let signalCount = 0

		for (let ring = 0; ring <= radius; ring++) {
			sum += ringSum[ring]
			sumX += ringSumX[ring]
			sumY += ringSumY[ring]
			signalCount += ringCount[ring]
		}

		if (sum <= ASTAP_MIN_SIGNAL_SIGMA * noise) return undefined

		xc = x1 + sumX / sum
		yc = y1 + sumY / sum
		if (xc - radius < 0 || xc + radius > width - 1 || yc - radius < 0 || yc + radius > height - 1) return undefined

		const side = 2 * radius + 1
		const boxed = signalCount >= ASTAP_BOXED_FRACTION * side * side
		if (!boxed) radius -= radius > 4 ? 2 : 1
		if (signalCount <= 1) return undefined
		if (boxed || radius <= 1) break
	}

	radius += 2

	const { tableRadius, tableSide, roundedDistances, distances, histogram, samples, columnStart, columnFraction, columnValid, rowStart, rowFraction, rowValid } = workspace

	// The column of xc + i and the row of yc + j, with the same rounding as computing them for every sample.
	for (let i = -radius; i <= radius; i++) {
		const t = i + tableRadius
		const x = xc + i
		const xt = Math.trunc(x)
		columnStart[t] = xt
		columnFraction[t] = x - xt
		columnValid[t] = xt <= 0 || xt >= width - 2 ? 0 : 1
		const y = yc + i
		const yt = Math.trunc(y)
		rowStart[t] = yt
		rowFraction[t] = y - yt
		rowValid[t] = yt <= 0 || yt >= height - 2 ? 0 : 1
	}

	histogram.fill(0, 0, radius + 1)
	let peak = 0

	for (let i = -radius; i <= radius; i++) {
		const column = i + tableRadius
		const xt = columnStart[column]
		const fx = columnFraction[column]
		const columnInside = columnValid[column] === 1
		const tableRow = column * tableSide + tableRadius

		for (let j = -radius; j <= radius; j++) {
			const row = j + tableRadius
			let interpolated = 0

			if (columnInside && rowValid[row] === 1) {
				const fy = rowFraction[row]
				const s = rowStart[row] * width + xt
				interpolated = adu[s] * (1 - fx) * (1 - fy) + adu[s + 1] * fx * (1 - fy) + adu[s + width] * (1 - fx) * fy + adu[s + width + 1] * fx * fy
			}

			const value = interpolated - sky
			samples[tableRow + j] = value
			const distance = roundedDistances[tableRow + j]

			if (distance <= radius && value > signalLevel) {
				histogram[distance]++
				if (value > peak) peak = value
			}
		}
	}

	// The center of a defocused star can be dark, so the edge is searched only after the first signal.
	let starRadius = -1
	let top = 0
	let started = false
	let illuminated = 0

	do {
		starRadius++
		const signalSamples = histogram[starRadius]
		illuminated += signalSamples
		if (signalSamples > 0) started = true
		if (top < signalSamples) top = signalSamples
	} while (!(starRadius >= radius || (started && histogram[starRadius] <= ASTAP_DROP_OFF * top)))

	if (starRadius >= radius) return undefined
	if (starRadius > 2 && illuminated < ASTAP_DISK_FILL * (2 * starRadius - 2) * (2 * starRadius - 2)) return undefined

	// HFD of Kazuhisa Miyashita, Σ(signal r) / Σ signal = HFR, over the square of the star radius.
	let sum = 0
	let sumR = 0
	let halfCount = 0
	const halfPeak = 0.5 * peak

	for (let i = -starRadius; i <= starRadius; i++) {
		const tableRow = (i + tableRadius) * tableSide + tableRadius

		for (let j = -starRadius; j <= starRadius; j++) {
			const value = samples[tableRow + j]
			sum += value
			sumR += value * distances[tableRow + j]
			if (value >= halfPeak) halfCount++
		}
	}

	const flux = Math.max(sum, ASTAP_MIN_FLUX)
	const hfd = Math.max(ASTAP_HFD_FLOOR, (2 * sumR) / flux)
	const fwhm = 2 * Math.sqrt(halfCount / Math.PI)
	const snr = flux / Math.sqrt(flux + starRadius * starRadius * Math.PI * noise * noise)
	return { hfd, fwhm, snr, flux, x: xc, y: yc, radius: starRadius }
}

// Measures the star centered near (x, y), in pixels, and recenters the aperture on the flux-weighted centroid,
// so the published (x, y) is the center of the aperture that produced flux, HFD, and FWHM. The aperture is
// STAR_SIGNAL_RADIUS unless `maximumRadius` exceeds it: it then starts at `starRadius` pixels, clamped between
// them, so it holds the dark center of a defocused star instead of sliding onto one side of its ring, and grows
// while the star extends beyond it. Undefined when the aperture has no positive flux, or when the star still
// extends beyond `maximumRadius` or its grown aperture leaves the image less the border margin.
function measureStarAt(raw: Image['raw'], width: number, height: number, stride: number, x: number, y: number, starRadius: number, maximumRadius: number, workspace: PhotometryWorkspace): ApertureMeasurement | undefined {
	if (!(maximumRadius > STAR_SIGNAL_RADIUS)) return measureCenteredAperture(raw, width, height, stride, x, y, STAR_SIGNAL_RADIUS, workspace)

	const first = measureCenteredAperture(raw, width, height, stride, x, y, Math.min(maximumRadius, Math.max(STAR_SIGNAL_RADIUS, starRadius)), workspace)
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

			if (!extendsBeyondAperture(photometry, distantSky)) return photometry
		}

		const { radius } = photometry
		const next = radius < maximumRadius ? measureCenteredAperture(raw, width, height, stride, photometry.centroidX, photometry.centroidY, Math.min(maximumRadius, radius + Math.max(2, Math.ceil(radius / 4))), workspace) : undefined
		if (next === undefined || !apertureInsideImage(next, width, height)) return undefined
		photometry = next
	}
}

// Measures an aperture of `radius` pixels at (x, y) and recenters it at most STAR_CENTROID_REFINEMENTS
// times on the flux-weighted centroid, keeping the last measurement with positive flux. Undefined when
// the first measurement already has none.
function measureCenteredAperture(raw: Image['raw'], width: number, height: number, stride: number, x: number, y: number, radius: number, workspace: PhotometryWorkspace): ApertureMeasurement | undefined {
	const backgroundInnerRadius = radius + STAR_BACKGROUND_GAP
	const backgroundOuterRadius = backgroundInnerRadius + STAR_BACKGROUND_WIDTH
	let photometry = measureAperture(raw, width, height, stride, x, y, radius, backgroundInnerRadius, backgroundOuterRadius, STAR_BORDER_MARGIN, workspace)
	if (photometry === undefined) return undefined

	for (let iteration = 0; iteration < STAR_CENTROID_REFINEMENTS; iteration++) {
		const { centroidX, centroidY } = photometry
		if (Math.hypot(centroidX - x, centroidY - y) <= STAR_CENTROID_TOLERANCE) break
		const refined = measureAperture(raw, width, height, stride, centroidX, centroidY, radius, backgroundInnerRadius, backgroundOuterRadius, STAR_BORDER_MARGIN, workspace)
		if (refined === undefined) break
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

// Whether the signal aperture around the centroid lies inside the image less the border margin, so no
// part of the star is cut.
function apertureInsideImage({ centroidX, centroidY, radius }: ApertureMeasurement, width: number, height: number) {
	return centroidX - radius >= STAR_BORDER_MARGIN && centroidY - radius >= STAR_BORDER_MARGIN && centroidX + radius <= width - STAR_BORDER_MARGIN - 1 && centroidY + radius <= height - STAR_BORDER_MARGIN - 1
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
// circle of `radius` pixels around (x, y), skipping those outside the image less the border margin. A sparse
// ring keeps this reference cheap for the thousands of candidates of a frame. Reorders the workspace
// samples; undefined when no sample falls inside.
function distantSkyStatistics(raw: Image['raw'], stride: number, x: number, y: number, radius: number, width: number, height: number, workspace: PhotometryWorkspace): AnnulusStatistics | undefined {
	const samples = (workspace.samples = ensureCapacity(workspace.samples, STAR_DISTANT_SKY_SAMPLES))
	const xMax = width - STAR_BORDER_MARGIN - 1
	const yMax = height - STAR_BORDER_MARGIN - 1
	let count = 0

	for (let i = 0; i < STAR_DISTANT_SKY_SAMPLES; i++) {
		const px = Math.round(x + radius * DISTANT_SKY_COS[i])
		const py = Math.round(y + radius * DISTANT_SKY_SIN[i])
		if (px < STAR_BORDER_MARGIN || py < STAR_BORDER_MARGIN || px > xMax || py > yMax) continue
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

	// The background-limited SNR, on the signed sum of the aperture: the positive-only flux of a sky aperture is about
	// 0.4 N noise against an uncertainty of sqrt(N) noise, so noise peaks would read several sigma. The shot noise of the
	// star needs the electrons per sample unit, which a normalized image does not carry.
	const snr = netFlux / Math.max(noise * Math.sqrt(aperturePixels), Number.EPSILON)
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
