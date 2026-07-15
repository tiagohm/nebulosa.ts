import type { Point, Rect } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import type { Image } from '../model/types'
import { clone } from '../processing/arithmetic'
import { mean3x3 } from '../processing/convolution'
import { grayscale } from '../processing/geometry'
import { psf } from '../processing/psf'
import { starMomentShape } from './shape'

// Star detection and photometry for an image. Median-filters out hot pixels, runs a PSF-matched
// response to find candidate peaks, then measures each star's flux, SNR, half-flux diameter (HFD),
// and FWHM via integral-image aperture/annulus photometry. Coordinates are pixels; intensities use
// the normalized [0, 1] pixel scale. Also provides utilities to merge close detections and to clip
// stars to a central search region.

// A detected star: its pixel position plus measured photometry.
export interface DetectedStar extends Readonly<Point> {
	// Half-flux diameter, pixels.
	readonly hfd: number
	// Full width at half maximum, pixels (when estimable).
	readonly fwhm?: number
	// Shape eccentricity from 0 (round) toward 1 (elongated), when estimable.
	readonly eccentricity?: number
	// Major/minor axis ratio, at least 1, when estimable.
	readonly elongation?: number
	// Signal-to-noise ratio.
	readonly snr: number
	// Integrated flux above background.
	readonly flux: number
}

// Options controlling star detection.
export interface DetectStarOptions {
	// Maximum number of stars to return (brightest kept).
	readonly maxStars: number
	// Optional central square region (half-size, pixels) to restrict detection to.
	readonly searchRegion?: number
	// Minimum SNR a star must reach to be kept.
	readonly minSNR?: number
}

// Integral images for fast box statistics: [running sum, running sum of squares, padded width].
type IntegralImages = readonly [Float64Array, Float64Array, number] // sum, sumSq, width
// Measured photometry of one star as [flux, snr, hfd, fwhm].
export type StarPhotometry = readonly [number, number, number, number] // flux, snr, hfd, fwhm
// Internal photometry plus shape measurements as [flux, snr, hfd, fwhm, eccentricity, elongation].
type MeasuredStarPhotometry = readonly [number, number, number, number, number | undefined, number | undefined]

// Aperture radius (pixels) over which a star's signal flux is integrated.
const STAR_SIGNAL_RADIUS = 4
// Inner radius (pixels) of the background-estimation annulus.
const STAR_BACKGROUND_INNER_RADIUS = 5
// Outer radius (pixels) of the background-estimation annulus.
const STAR_BACKGROUND_OUTER_RADIUS = 7
// Border margin (pixels) excluded after PSF convolution to avoid edge artifacts.
const STAR_CONVOLVED_MARGIN = 4
// Minimum acceptable HFD (pixels); smaller measurements are treated as noise/hot pixels.
const STAR_MIN_HFD = 1
// Ratio between a peak's score and its neighborhood used to accept it as a distinct star.
const STAR_SCORE_GAP_RATIO = 4

// Default star-detection options.
const DEFAULT_DETECT_STARS_OPTIONS: Readonly<DetectStarOptions> = {
	maxStars: 500,
	searchRegion: 0,
	minSNR: 0,
}

// Detects stars in an image and returns them sorted by descending flux (up to maxStars), filtered by
// minSNR and optionally restricted to a central search region.
export function detectStars(image: Image, { maxStars = 500, searchRegion = 0, minSNR = 0 }: Partial<DetectStarOptions> = DEFAULT_DETECT_STARS_OPTIONS): DetectedStar[] {
	image = grayscale(image)

	const original = image.raw

	// Run a 3x3 median first to eliminate hot pixels
	image = mean3x3(clone(image))

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

			if (value <= 0) continue
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

			// Validate each candidate against the original image so ranking uses measured photometry instead of only convolution response.
			const [flux, snr, hfd, fwhm, eccentricity, elongation] = measureStarPhotometryRaw(original, width, height, stride, x, y, STAR_SIGNAL_RADIUS, STAR_BACKGROUND_INNER_RADIUS, STAR_BACKGROUND_OUTER_RADIUS, STAR_CONVOLVED_MARGIN)
			if (flux <= 0 || snr < minSNR || hfd < STAR_MIN_HFD) continue

			// Ranks detections by measured signal so real stars survive capacity limits better than noise artifacts.
			const rank = flux * snr

			stars.add(x, y, rank, flux, snr, hfd, fwhm, eccentricity, elongation)
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

	for (const { x, y, flux = 0, snr = 0, hfd = 0, fwhm = 0, eccentricity, elongation } of stars) {
		res[i++] = { x, y, flux, hfd, fwhm, snr, eccentricity, elongation }
	}

	return res
}

// Trims weak detections after a large score discontinuity between adjacent ranked candidates.
function trimStarsByScoreGap(stars: StarList) {
	if (stars.size <= 3) return

	const ranked = stars.array()
	const n = ranked.length
	const topWindowStart = Math.max(1, n - Math.min(n, 128))
	let keepFrom = 0
	let bestRatio = STAR_SCORE_GAP_RATIO

	for (let i = topWindowStart - 1; i < n - 1; i++) {
		const weaker = ranked[i].h
		const stronger = ranked[i + 1].h
		if (weaker <= 0 || stronger <= 0) continue
		const ratio = stronger / weaker
		if (ratio <= bestRatio) continue
		if (n - i - 1 < 3) continue
		bestRatio = ratio
		keepFrom = i + 1
	}

	for (let removeCount = keepFrom; removeCount > 0; removeCount--) {
		stars.deleteFirst()
	}
}

// Computes aperture flux, SNR, HFD and FWHM for a star centered on an image coordinate.
export function measureStarPhotometry(image: Image, x: number, y: number, radius: number): StarPhotometry {
	image = grayscale(image)

	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const [flux, snr, hfd, fwhm] = measureStarPhotometryRaw(raw, width, height, stride, x, y, radius, radius + 1, radius + 3, 0)
	return [flux, snr, hfd, fwhm]
}

// Computes aperture flux, SNR, HFD and FWHM for a detected star.
function measureStarPhotometryRaw(raw: Image['raw'], width: number, height: number, stride: number, x: number, y: number, signalRadius: number, backgroundInnerRadius: number, backgroundOuterRadius: number, margin: number): MeasuredStarPhotometry {
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(signalRadius) || signalRadius <= 0) return [0, 0, 0, 0, undefined, undefined]
	if (!Number.isFinite(backgroundInnerRadius) || !Number.isFinite(backgroundOuterRadius) || backgroundInnerRadius <= signalRadius || backgroundOuterRadius < backgroundInnerRadius) return [0, 0, 0, 0, undefined, undefined]

	const xMin = margin
	const yMin = margin
	const xMax = width - margin - 1
	const yMax = height - margin - 1
	if (x < xMin || x > xMax || y < yMin || y > yMax) return [0, 0, 0, 0, undefined, undefined]
	const x0 = Math.max(xMin, Math.ceil(x - backgroundOuterRadius))
	const y0 = Math.max(yMin, Math.ceil(y - backgroundOuterRadius))
	const x1 = Math.min(xMax, Math.floor(x + backgroundOuterRadius))
	const y1 = Math.min(yMax, Math.floor(y + backgroundOuterRadius))
	const signalRadiusSq = signalRadius * signalRadius
	const backgroundInnerRadiusSq = backgroundInnerRadius * backgroundInnerRadius
	const backgroundOuterRadiusSq = backgroundOuterRadius * backgroundOuterRadius
	let backgroundSum = 0
	let backgroundSumSq = 0
	let backgroundCount = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		const dy = py - y
		const dy2 = dy * dy

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const d2 = dx * dx + dy2
			if (d2 < backgroundInnerRadiusSq || d2 > backgroundOuterRadiusSq) continue
			const v = raw[row + px]
			backgroundSum += v
			backgroundSumSq += v * v
			backgroundCount++
		}
	}

	if (backgroundCount <= 0) return [0, 0, 0, 0, undefined, undefined]

	const backgroundMean = backgroundSum / backgroundCount
	const backgroundVariance = Math.max(0, backgroundSumSq / backgroundCount - backgroundMean * backgroundMean)
	let flux = 0
	let radialMoment = 0
	let radialMomentSq = 0
	let aperturePixels = 0
	let weightedX = 0
	let weightedY = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		const dy = py - y
		const dy2 = dy * dy

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const d2 = dx * dx + dy2
			if (d2 > signalRadiusSq) continue
			aperturePixels++
			const signal = raw[row + px] - backgroundMean
			if (signal <= 0) continue
			flux += signal
			radialMoment += signal * Math.sqrt(d2)
			radialMomentSq += signal * d2
			weightedX += signal * px
			weightedY += signal * py
		}
	}

	if (flux <= 0 || aperturePixels <= 0) return [0, 0, 0, 0, undefined, undefined]

	const snr = flux / Math.sqrt(Math.max(flux + aperturePixels * backgroundVariance, Number.EPSILON))
	const hfd = (2 * radialMoment) / flux
	// Gaussian-equivalent FWHM from the second radial moment; this avoids fitting a noisy radial profile.
	const fwhm = radialMomentSq > 0 ? 2 * Math.sqrt((Math.LN2 * radialMomentSq) / flux) : 0
	const centroidX = weightedX / flux
	const centroidY = weightedY / flux
	let momentXX = 0
	let momentXY = 0
	let momentYY = 0

	for (let py = y0; py <= y1; py++) {
		const row = py * stride
		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const dy = py - y
			if (dx * dx + dy * dy > signalRadiusSq) continue
			const signal = raw[row + px] - backgroundMean
			if (signal <= 0) continue
			const centerX = px - centroidX
			const centerY = py - centroidY
			momentXX += signal * centerX * centerX
			momentXY += signal * centerX * centerY
			momentYY += signal * centerY * centerY
		}
	}

	const { eccentricity, elongation } = starMomentShape(momentXX / flux, momentXY / flux, momentYY / flux)
	return [flux, snr, hfd, fwhm, eccentricity, elongation]
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
				stars.deleteAfter(previous)
				deleted = true
				break
			}

			b = b.next
		}

		current = a.next
		if (!deleted) previous = a
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
	addLast(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number) {
		const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation }

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
	addFirst(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number) {
		const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation }

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
	add(x: number, y: number, h: number, flux?: number, snr?: number, hfd?: number, fwhm?: number, eccentricity?: number, elongation?: number) {
		if (!this.#head || h <= this.#head.h) {
			if (this.size < this.capacity) this.addFirst(x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation)
		} else if (!this.#tail || h >= this.#tail.h) {
			this.addLast(x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation)
		} else {
			const star: Star = { x, y, h, flux, snr, hfd, fwhm, eccentricity, elongation }
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
