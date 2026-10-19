import { validatePositiveInteger } from '../../core/validation'
import type { Point } from '../../math/numerical/geometry'
import { medianBySelectionOf } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import { channelIndex, type DigitalImage, type Image, type ImageChannel, type ImageRawType } from '../model/types'

// Scientific aperture photometry with propagated uncertainties. Measures the background-subtracted
// flux of a batch of sources through circular or elliptical apertures, weighting each pixel by its
// exact geometric overlap (or a controlled subpixel or center approximation), and estimates the sky
// per source from a sigma-clipped annulus. The flux uncertainty combines the per-pixel variance
// (supplied variance or inverse-variance map, a CCD noise model with Poisson source+sky, read noise
// and dark current, or the empirical annulus scatter) with the uncertainty of the sky estimate, which
// is common to every aperture pixel. Pixel coordinates are zero-based sample centers: origin at the
// upper-left sample, +X right, +Y down, so pixel (i, j) covers [i - 0.5, i + 0.5] x [j - 0.5, j + 0.5];
// this matches the star detector and Photutils. Fluxes and levels use the sample unit of the image
// (DN for a DigitalImage, the normalized scale for an Image). Pixels are assumed statistically
// independent unless a noise-correlation factor is supplied. The image, mask and maps are never
// mutated; results are fresh objects and one annulus sample buffer is allocated and reused per batch.

// How the fraction of a pixel inside an aperture is computed.
// 'exact' integrates the geometric overlap of the pixel square with the ellipse.
// 'subpixel' splits the pixel into subpixels x subpixels cells and counts the cell centers inside.
// 'center' takes the whole pixel when its center is inside and nothing otherwise.
export type ApertureOverlapMethod = 'exact' | 'subpixel' | 'center'

// Sky estimator applied to the sigma-clipped annulus samples.
export type PhotometryBackgroundStatistic = 'median' | 'mean'

// Per-source quality flags.
// 'truncated': part of the aperture lies outside the image (see truncatedArea).
// 'masked': aperture pixels were excluded by the mask, a non-finite sample or an invalid uncertainty.
// 'saturated': an aperture pixel is at or above the saturation level; the flux is a lower limit.
// 'noBackground': the annulus has no usable sample, so no flux is reported.
// 'empty': no usable pixel overlaps the aperture.
export type AperturePhotometryFlag = 'truncated' | 'masked' | 'saturated' | 'noBackground' | 'empty'

// Sky annulus concentric with its aperture. For an elliptical aperture the bounds are semi-major axes
// and the annulus keeps the aperture's axis ratio and orientation. A pixel is a sky sample when its
// center satisfies inner <= r < outer, where r is the scaled elliptical radius.
export interface PhotometryAnnulus {
	// Inner radius or semi-major axis, pixels. Should be at least the aperture size to avoid source light.
	readonly inner: number
	// Outer radius or semi-major axis, pixels, greater than inner.
	readonly outer: number
}

// Circular aperture.
export interface CircularPhotometryAperture {
	// Discriminant.
	readonly shape: 'circle'
	// Aperture radius, pixels, positive.
	readonly radius: number
	// Sky annulus; when omitted the fixed background option is used.
	readonly annulus?: PhotometryAnnulus
}

// Elliptical aperture.
export interface EllipticalPhotometryAperture {
	// Discriminant.
	readonly shape: 'ellipse'
	// Semi-major axis, pixels, positive.
	readonly a: number
	// Semi-minor axis, pixels, positive and at most a.
	readonly b: number
	// Orientation of the major axis from +X toward +Y (clockwise on screen because +Y grows downward),
	// radians. Same convention as the detector's theta and the Photutils theta. Defaults to 0.
	readonly theta?: Angle
	// Sky annulus in semi-major axes; when omitted the fixed background option is used.
	readonly annulus?: PhotometryAnnulus
}

// Aperture geometry for one source.
export type PhotometryAperture = CircularPhotometryAperture | EllipticalPhotometryAperture

// Per-pixel uncertainty map of the selected channel, row-major with width * height entries.
export interface PhotometryPixelUncertainty {
	// 'variance' in squared sample units, or 'inverseVariance' (weight) in inverse squared sample units.
	// A non-finite or negative variance, or a non-finite or non-positive weight, masks the pixel.
	readonly kind: 'variance' | 'inverseVariance'
	// Map values; the map must already be the total per-pixel variance of the samples.
	readonly data: Readonly<ImageRawType>
}

// Accumulated dark signal that was subtracted from the samples but still contributes shot noise.
export interface PhotometryDarkSignal {
	// Dark current, electrons per pixel per second, non-negative.
	readonly current: number
	// Exposure time, seconds, non-negative.
	readonly exposureTime: number
}

// CCD noise model (Merline & Howell 1995) used when no uncertainty map is supplied.
export interface PhotometryNoiseModel {
	// Gain, electrons per sample unit (e-/DN for a DigitalImage), positive.
	readonly gain: number
	// Read noise, electrons RMS per pixel. Defaults to 0.
	readonly readNoise?: number
	// Dark signal removed from the samples whose shot noise remains. Defaults to none.
	readonly dark?: PhotometryDarkSignal
	// Pedestal (bias level) still present in the samples, sample units, removed before the Poisson
	// term. Defaults to 0, which assumes calibrated samples.
	readonly offset?: number
}

// Fixed sky level used for an aperture without an annulus.
export interface PhotometryFixedBackground {
	// Sky level per pixel, sample units.
	readonly level: number
	// Standard uncertainty of the sky level per pixel, sample units. Defaults to 0.
	readonly error?: number
}

// Options for aperturePhotometry.
export interface AperturePhotometryOptions {
	// Pixel overlap method. Defaults to 'exact'.
	readonly method?: ApertureOverlapMethod
	// Subpixel cells per axis for the 'subpixel' method, a positive integer. Cost grows as its square. Defaults to 5.
	readonly subpixels?: number
	// Channel of a multichannel image. Defaults to the first channel.
	readonly channel?: ImageChannel
	// Row-major bad-pixel mask of width * height bytes; a nonzero entry excludes the pixel everywhere.
	readonly mask?: Readonly<Uint8Array>
	// Sample value at and above which a pixel is saturated, sample units. Saturated aperture pixels are
	// kept and flagged; saturated annulus pixels are excluded from the sky. Defaults to none.
	readonly saturationLevel?: number
	// Per-pixel uncertainty map; takes precedence over the noise model.
	readonly uncertainty?: PhotometryPixelUncertainty
	// CCD noise model for the per-pixel variance when no uncertainty map is given.
	readonly noise?: PhotometryNoiseModel
	// Sky used for apertures without an annulus. Defaults to level 0 with no error.
	readonly background?: PhotometryFixedBackground
	// Sky estimator of the annulus. Defaults to 'median'.
	readonly backgroundStatistic?: PhotometryBackgroundStatistic
	// Symmetric sigma-clipping threshold about the median, in standard deviations. Defaults to 3.
	readonly clipSigma?: number
	// Maximum sigma-clipping iterations; 0 disables clipping. Defaults to 10.
	readonly clipIterations?: number
	// Ratio between the true variance of a sum of pixels and the variance computed for independent
	// pixels. 1 for unresampled frames; resampled, interpolated or drizzled frames have correlated
	// noise and need a larger value, or the uncertainties are underestimated. Defaults to 1.
	readonly noiseCorrelation?: number
}

// Photometry of one source. Levels, sums and fluxes are in sample units; areas are in square pixels.
export interface AperturePhotometry extends Readonly<Point> {
	// Weighted sum of the usable aperture samples, before background subtraction.
	readonly sum: number
	// Effective aperture area: summed overlap weights of the usable in-image pixels.
	readonly area: number
	// Overlap weight of the in-image pixels excluded by the mask, non-finite samples or invalid uncertainties.
	readonly maskedArea: number
	// Geometric aperture area outside the image (exact, independent of the overlap method).
	readonly truncatedArea: number
	// Number of usable aperture pixels at or above the saturation level.
	readonly saturatedCount: number
	// Sky level per pixel, undefined when the annulus has no usable sample.
	readonly background?: number
	// Standard deviation of the clipped annulus samples per pixel, undefined for a fixed background.
	readonly backgroundDeviation?: number
	// Standard uncertainty of the sky level per pixel, undefined when the sky is unknown.
	readonly backgroundError?: number
	// Number of annulus samples used for the sky after clipping.
	readonly backgroundCount: number
	// Number of annulus samples rejected by sigma clipping.
	readonly backgroundRejected: number
	// Net flux, sum - background * area, undefined when the sky is unknown.
	readonly flux?: number
	// Standard uncertainty of the net flux, undefined when no variance source is available.
	readonly fluxError?: number
	// Signal-to-noise ratio flux / fluxError, undefined when fluxError is undefined or zero.
	readonly snr?: number
	// Quality flags, empty for a clean measurement.
	readonly flags: readonly AperturePhotometryFlag[]
}

// Default subpixel subdivision per axis, matching Photutils.
const DEFAULT_SUBPIXELS = 5
// Default sigma-clipping threshold, standard deviations, matching Photutils SigmaClip.
const DEFAULT_CLIP_SIGMA = 3
// Default sigma-clipping iteration limit, matching Photutils SigmaClip.
const DEFAULT_CLIP_ITERATIONS = 10
// Asymptotic variance ratio of the sample median to the sample mean for Gaussian noise.
const MEDIAN_VARIANCE_FACTOR = Math.PI / 2
// Truncated area below which an aperture touching the border is not flagged, square pixels.
const TRUNCATION_TOLERANCE = 1e-9

// Normalized ellipse geometry of one aperture: semi-axes and rotation of the major axis.
interface ApertureEllipse {
	// Semi-major axis, pixels.
	readonly a: number
	// Semi-minor axis, pixels.
	readonly b: number
	// Cosine of the orientation.
	readonly cos: number
	// Sine of the orientation.
	readonly sin: number
	// Largest semi-axis, pixels; no point farther from the center is inside.
	readonly reach: number
	// Half extents of the axis-aligned bounding box, pixels.
	readonly halfWidth: number
	readonly halfHeight: number
}

// Measures aperture photometry for a batch of sources. positions are zero-based pixel centers (for
// example detectStars results); apertures is one aperture shared by all sources or one per position.
// Each source gets the weighted aperture sum, the sky from its annulus (sigma-clipped median or mean of
// the samples whose centers fall in the annulus, excluding masked and saturated pixels) or the fixed
// background, the net flux and its uncertainty:
//   fluxError^2 = noiseCorrelation * (sum(w_i^2 v_i) + area^2 backgroundError^2)
// where w_i is the overlap weight and v_i the per-pixel variance: the uncertainty map, else the noise
// model max(x_i - offset, 0) / gain + (readNoise^2 + dark) / gain^2, else the squared annulus
// deviation (sky noise only, without the source shot noise). backgroundError is the deviation divided
// by sqrt(count), times sqrt(PI / 2) for the median. Photutils sums w_i v_i instead of w_i^2 v_i, so its
// error is larger on partial pixels; both agree for the 'center' method. Masked pixels are excluded
// without correcting the flux for the missing area. Throws RangeError when the aperture list, mask or
// uncertainty map does not match the positions or the image, when the channel does not exist, or when
// subpixels is not a positive integer.
export function aperturePhotometry(image: Image | DigitalImage, positions: readonly Readonly<Point>[], apertures: PhotometryAperture | readonly PhotometryAperture[], options: AperturePhotometryOptions = {}): AperturePhotometry[] {
	const { raw, metadata } = image
	const { width, height, channels, stride } = metadata
	const pixelCount = width * height
	const { method = 'exact', subpixels = DEFAULT_SUBPIXELS, mask, saturationLevel = Number.POSITIVE_INFINITY, uncertainty, noise, background, backgroundStatistic = 'median', clipSigma = DEFAULT_CLIP_SIGMA, clipIterations = DEFAULT_CLIP_ITERATIONS, noiseCorrelation = 1 } = options
	const channel = channelIndex(options.channel)

	// Mismatched inputs would read undefined apertures or neighboring pixels and return plausible wrong photometry.
	if (!('shape' in apertures) && apertures.length !== positions.length) throw new RangeError('aperture list must have one aperture per position')
	if (mask !== undefined && mask.length !== pixelCount) throw new RangeError('photometry mask length must equal width times height')
	if (uncertainty !== undefined && uncertainty.data.length !== pixelCount) throw new RangeError('photometry uncertainty map length must equal width times height')
	if (channel >= channels) throw new RangeError('photometry channel does not exist in the image')
	// A non-integer or infinite subdivision would sample nothing or never finish.
	if (method === 'subpixel') validatePositiveInteger(subpixels)

	const readVariance = noise === undefined ? 0 : ((noise.readNoise ?? 0) ** 2 + (noise.dark === undefined ? 0 : noise.dark.current * noise.dark.exposureTime)) / (noise.gain * noise.gain)
	const offset = noise?.offset ?? 0
	const inverseGain = noise === undefined ? 0 : 1 / noise.gain
	const results = new Array<AperturePhotometry>(positions.length)
	let samples = new Float64Array(0)

	for (let i = 0; i < positions.length; i++) {
		const { x, y } = positions[i]
		const aperture = 'shape' in apertures ? apertures : apertures[i]
		const ellipse = apertureEllipse(aperture)
		const flags: AperturePhotometryFlag[] = []

		// Sky level and its uncertainty.
		let level: number | undefined
		let deviation: number | undefined
		let levelError: number | undefined
		let backgroundCount = 0
		let backgroundRejected = 0
		const annulus = aperture.annulus

		if (annulus === undefined) {
			level = background?.level ?? 0
			levelError = background?.error ?? 0
		} else {
			const outer = annulus.outer
			const x0 = Math.max(0, Math.ceil(x - ellipse.halfWidth * (outer / ellipse.a)))
			const x1 = Math.min(width - 1, Math.floor(x + ellipse.halfWidth * (outer / ellipse.a)))
			const y0 = Math.max(0, Math.ceil(y - ellipse.halfHeight * (outer / ellipse.a)))
			const y1 = Math.min(height - 1, Math.floor(y + ellipse.halfHeight * (outer / ellipse.a)))
			const capacity = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1)
			if (samples.length < capacity) samples = new Float64Array(capacity)

			const innerSq = annulus.inner * annulus.inner
			const outerSq = outer * outer
			const ratio = ellipse.a / ellipse.b
			let count = 0

			for (let py = y0; py <= y1; py++) {
				const dy = py - y

				for (let px = x0; px <= x1; px++) {
					const dx = px - x
					const u = dx * ellipse.cos + dy * ellipse.sin
					const v = (dy * ellipse.cos - dx * ellipse.sin) * ratio
					const r2 = u * u + v * v
					if (!(r2 >= innerSq && r2 < outerSq)) continue
					const pixel = py * width + px
					if (mask?.[pixel]) continue
					const value = raw[py * stride + px * channels + channel]
					if (!Number.isFinite(value) || value >= saturationLevel) continue
					samples[count++] = value
				}
			}

			if (count > 0) {
				const clipped = sigmaClipPrefix(samples, count, clipSigma, clipIterations)
				backgroundRejected = count - clipped
				backgroundCount = clipped
				let mean = 0
				for (let k = 0; k < clipped; k++) mean += samples[k]
				mean /= clipped
				let m2 = 0
				for (let k = 0; k < clipped; k++) m2 += (samples[k] - mean) ** 2
				deviation = Math.sqrt(m2 / clipped)
				level = backgroundStatistic === 'mean' ? mean : medianBySelectionOf(samples, clipped)
				levelError = deviation * Math.sqrt((backgroundStatistic === 'mean' ? 1 : MEDIAN_VARIANCE_FACTOR) / clipped)
			}
		}

		// Weighted aperture sum and per-pixel variance.
		const x0 = Math.max(0, Math.ceil(x - ellipse.halfWidth - 0.5))
		const x1 = Math.min(width - 1, Math.floor(x + ellipse.halfWidth + 0.5))
		const y0 = Math.max(0, Math.ceil(y - ellipse.halfHeight - 0.5))
		const y1 = Math.min(height - 1, Math.floor(y + ellipse.halfHeight + 0.5))
		let sum = 0
		let area = 0
		let weightSq = 0
		let varianceSum = 0
		let maskedArea = 0
		let saturatedCount = 0

		for (let py = y0; py <= y1; py++) {
			const dy = py - y

			for (let px = x0; px <= x1; px++) {
				const w = pixelOverlap(px - x, dy, ellipse, method, subpixels)
				if (w <= 0) continue
				const pixel = py * width + px
				const value = raw[py * stride + px * channels + channel]

				let variance = 0

				if (uncertainty !== undefined) {
					const data = uncertainty.data[pixel]
					variance = uncertainty.kind === 'variance' ? (data >= 0 ? data : Number.NaN) : data > 0 ? 1 / data : Number.NaN
				} else if (noise !== undefined) {
					variance = Math.max(value - offset, 0) * inverseGain + readVariance
				}

				if (mask?.[pixel] || !Number.isFinite(value) || !Number.isFinite(variance)) {
					maskedArea += w
					continue
				}

				sum += w * value
				area += w
				weightSq += w * w
				varianceSum += w * w * variance
				if (value >= saturationLevel) saturatedCount++
			}
		}

		const truncatedArea = apertureTruncatedArea(x, y, width, height, ellipse)

		if (truncatedArea > 0) flags.push('truncated')
		if (maskedArea > 0) flags.push('masked')
		if (saturatedCount > 0) flags.push('saturated')
		if (level === undefined) flags.push('noBackground')
		if (area <= 0) flags.push('empty')

		let flux: number | undefined
		let fluxError: number | undefined
		let snr: number | undefined

		if (level !== undefined) {
			flux = sum - level * area
			const pixelVariance = uncertainty !== undefined || noise !== undefined ? varianceSum : deviation === undefined ? undefined : deviation * deviation * weightSq

			if (pixelVariance !== undefined && levelError !== undefined) {
				fluxError = Math.sqrt(noiseCorrelation * (pixelVariance + area * area * levelError * levelError))
				if (fluxError > 0) snr = flux / fluxError
			}
		}

		results[i] = { x, y, sum, area, maskedArea, truncatedArea, saturatedCount, background: level, backgroundDeviation: deviation, backgroundError: levelError, backgroundCount, backgroundRejected, flux, fluxError, snr, flags }
	}

	return results
}

// Converts an aperture to its semi-axes, rotation and bounding box.
function apertureEllipse(aperture: PhotometryAperture): ApertureEllipse {
	const a = aperture.shape === 'circle' ? aperture.radius : aperture.a
	const b = aperture.shape === 'circle' ? aperture.radius : aperture.b
	const theta = aperture.shape === 'circle' ? 0 : (aperture.theta ?? 0)
	const cos = Math.cos(theta)
	const sin = Math.sin(theta)
	const halfWidth = Math.sqrt(a * a * cos * cos + b * b * sin * sin)
	const halfHeight = Math.sqrt(a * a * sin * sin + b * b * cos * cos)
	return { a, b, cos, sin, reach: Math.max(a, b), halfWidth, halfHeight }
}

// Fraction in [0, 1] of the unit pixel centered at (dx, dy) from the aperture center that lies inside the ellipse.
function pixelOverlap(dx: number, dy: number, ellipse: ApertureEllipse, method: ApertureOverlapMethod, subpixels: number) {
	if (method === 'center') return ellipseContains(dx, dy, ellipse) ? 1 : 0

	// The nearest point of the pixel is beyond the largest semi-axis: no overlap.
	const nx = Math.max(Math.abs(dx) - 0.5, 0)
	const ny = Math.max(Math.abs(dy) - 0.5, 0)
	if (nx * nx + ny * ny >= ellipse.reach * ellipse.reach) return 0

	// The ellipse is convex, so a pixel with its four corners inside is fully covered.
	if (ellipseContains(dx - 0.5, dy - 0.5, ellipse) && ellipseContains(dx + 0.5, dy - 0.5, ellipse) && ellipseContains(dx - 0.5, dy + 0.5, ellipse) && ellipseContains(dx + 0.5, dy + 0.5, ellipse)) return 1

	if (method === 'exact') return Math.min(1, ellipseRectangleArea(dx - 0.5, dy - 0.5, dx + 0.5, dy + 0.5, ellipse))

	const step = 1 / subpixels
	let inside = 0

	for (let j = 0; j < subpixels; j++) {
		const sy = dy - 0.5 + (j + 0.5) * step

		for (let i = 0; i < subpixels; i++) {
			if (ellipseContains(dx - 0.5 + (i + 0.5) * step, sy, ellipse)) inside++
		}
	}

	return inside / (subpixels * subpixels)
}

// Whether the offset (dx, dy) from the center lies strictly inside the ellipse.
function ellipseContains(dx: number, dy: number, ellipse: ApertureEllipse) {
	const u = (dx * ellipse.cos + dy * ellipse.sin) / ellipse.a
	const v = (dy * ellipse.cos - dx * ellipse.sin) / ellipse.b
	return u * u + v * v < 1
}

// Geometric aperture area outside the image rectangle [-0.5, width - 0.5] x [-0.5, height - 0.5],
// square pixels, or 0 when the bounding box is inside the image.
function apertureTruncatedArea(x: number, y: number, width: number, height: number, ellipse: ApertureEllipse) {
	const left = -0.5 - x
	const top = -0.5 - y
	const right = width - 0.5 - x
	const bottom = height - 0.5 - y
	if (-ellipse.halfWidth >= left && ellipse.halfWidth <= right && -ellipse.halfHeight >= top && ellipse.halfHeight <= bottom) return 0
	const outside = Math.PI * ellipse.a * ellipse.b - ellipseRectangleArea(left, top, right, bottom, ellipse)
	return outside > TRUNCATION_TOLERANCE ? outside : 0
}

// Exact area, square pixels, of the intersection of an axis-aligned rectangle (offsets from the
// ellipse center) with the ellipse. The affine map u = rotated x / a, v = rotated y / b turns the
// ellipse into the unit circle and the rectangle into a parallelogram; the circle-polygon overlap is
// the signed sum over polygon edges of circle-triangle overlaps with the origin, scaled back by a * b.
function ellipseRectangleArea(left: number, top: number, right: number, bottom: number, ellipse: ApertureEllipse) {
	const { a, b, cos, sin } = ellipse
	const u0 = (left * cos + top * sin) / a
	const v0 = (top * cos - left * sin) / b
	const u1 = (right * cos + top * sin) / a
	const v1 = (top * cos - right * sin) / b
	const u2 = (right * cos + bottom * sin) / a
	const v2 = (bottom * cos - right * sin) / b
	const u3 = (left * cos + bottom * sin) / a
	const v3 = (bottom * cos - left * sin) / b
	const area = unitCircleTriangleArea(u0, v0, u1, v1) + unitCircleTriangleArea(u1, v1, u2, v2) + unitCircleTriangleArea(u2, v2, u3, v3) + unitCircleTriangleArea(u3, v3, u0, v0)
	return Math.abs(area) * a * b
}

// Signed area of the intersection of the unit circle centered at the origin with the triangle
// (origin, A, B); positive when A to B turns counterclockwise in the (u, v) frame.
function unitCircleTriangleArea(ax: number, ay: number, bx: number, by: number) {
	const a2 = ax * ax + ay * ay
	const b2 = bx * bx + by * by
	if (a2 <= 1 && b2 <= 1) return 0.5 * (ax * by - ay * bx)

	// Intersections of A + t (B - A) with the unit circle, t1 <= t2.
	const dx = bx - ax
	const dy = by - ay
	const qa = dx * dx + dy * dy
	const qb = ax * dx + ay * dy
	const discriminant = qb * qb - qa * (a2 - 1)
	if (!(qa > 0) || discriminant <= 0) return circularSectorArea(ax, ay, bx, by)
	const root = Math.sqrt(discriminant)
	const t1 = (-qb - root) / qa
	const t2 = (-qb + root) / qa

	if (a2 <= 1) {
		const px = ax + t2 * dx
		const py = ay + t2 * dy
		return 0.5 * (ax * py - ay * px) + circularSectorArea(px, py, bx, by)
	}

	if (b2 <= 1) {
		const px = ax + t1 * dx
		const py = ay + t1 * dy
		return circularSectorArea(ax, ay, px, py) + 0.5 * (px * by - py * bx)
	}

	// Both ends outside: the segment crosses the circle only when both roots lie inside it.
	if (t1 <= 0 || t2 >= 1) return circularSectorArea(ax, ay, bx, by)
	const p1x = ax + t1 * dx
	const p1y = ay + t1 * dy
	const p2x = ax + t2 * dx
	const p2y = ay + t2 * dy
	return circularSectorArea(ax, ay, p1x, p1y) + 0.5 * (p1x * p2y - p1y * p2x) + circularSectorArea(p2x, p2y, bx, by)
}

// Signed area of the unit-circle sector between the directions of A and B (half the signed angle).
function circularSectorArea(ax: number, ay: number, bx: number, by: number) {
	return 0.5 * Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

// Iteratively rejects samples farther than sigma population standard deviations from the median,
// compacting the survivors into the prefix of values. Stops when nothing is rejected, the deviation
// is zero or after maxIterations. Reorders the prefix and returns the surviving count (at least 1).
function sigmaClipPrefix(values: Float64Array, count: number, sigma: number, maxIterations: number) {
	for (let iteration = 0; iteration < maxIterations && count > 1; iteration++) {
		const center = medianBySelectionOf(values, count)
		let mean = 0
		for (let i = 0; i < count; i++) mean += values[i]
		mean /= count
		let m2 = 0
		for (let i = 0; i < count; i++) m2 += (values[i] - mean) ** 2
		const limit = sigma * Math.sqrt(m2 / count)
		if (!(limit > 0)) break

		let kept = 0

		for (let i = 0; i < count; i++) {
			const value = values[i]
			if (Math.abs(value - center) <= limit) values[kept++] = value
		}

		if (kept === count || kept === 0) break
		count = kept
	}

	return count
}
