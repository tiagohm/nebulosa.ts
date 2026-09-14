import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { plotStar } from '../../../src/imaging/stars/generator'
import { estimateTranslation, filterGuideStars, type GuideStar, selectGuideStar, type StarDetectionFrame, StarTracker } from '../../../src/observation/guiding/tracker.star'

const WIDTH = 800
const HEIGHT = 600

// Builds one synthetic star with configurable quality and optional id.
function star(index: number, patch: Partial<GuideStar> = {}): GuideStar {
	return { x: 120 + index * 90, y: 140 + index * 50, snr: 20 + (index % 3), flux: 2400 + index * 150, hfd: 2.5 + index * 0.05, ellipticity: 0.18, fwhm: 4, ...patch }
}

// Builds a star-only fixture for tracker filter and selection tests.
function starFrame(stars: readonly GuideStar[], width = WIDTH, height = HEIGHT, searchPosition?: readonly [number, number], searchRegion?: number): StarDetectionFrame {
	return { stars, width, height, searchPosition, searchRegion }
}

// Shifts stars by dx/dy with deterministic optional mutation.
function shiftStars(stars: readonly GuideStar[], dx: number, dy: number, mutate?: (star: GuideStar, index: number) => GuideStar) {
	return stars.map((star, index) => {
		const shifted: GuideStar = { ...star, x: star.x + dx, y: star.y + dy }
		return mutate ? mutate(shifted, index) : shifted
	})
}

// Builds a detector image with a flat normalized background and configurable stellar fluxes.
function imageWithStars(stars: readonly (readonly [number, number, number])[]): Image {
	const width = WIDTH
	const height = HEIGHT
	const background = 0.005
	const raw = new Float32Array(width * height).fill(background)
	const options = { background, saturationLevel: 1 }

	for (const [x, y, flux] of stars) plotStar(raw, width, height, 1, x, y, flux, 3, 80, 0, undefined, options)

	return {
		header: {},
		raw,
		metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 4, stride: width, strideInBytes: width * 4, bitpix: -32, bayer: undefined },
	}
}

test('star filtering rejects low quality detections', () => {
	const stars: GuideStar[] = [
		{ x: 8, y: 20, snr: 20, flux: 1000, hfd: 2 },
		{ x: 100, y: 100, snr: 2, flux: 1000, hfd: 2 },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, saturated: true },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, ellipticity: 0.8 },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, fwhm: 40 },
		{ x: 120, y: 120, snr: 20, flux: 1000, hfd: 2, ellipticity: 0.2, fwhm: 4 },
	]

	const filtered = filterGuideStars(starFrame(stars), { minStarSnr: 8, minFlux: 100, maxHfd: 8, borderMarginPx: 10, maxEllipticity: 0.5, maxFwhm: 10, saturationPeak: 65000 })

	expect(filtered.accepted).toHaveLength(1)
	expect(filtered.rejectedReasons.border).toBe(1)
	expect(filtered.rejectedReasons.low_snr).toBe(1)
	expect(filtered.rejectedReasons.saturated).toBe(1)
	expect(filtered.rejectedReasons.elongated).toBe(1)
	expect(filtered.rejectedReasons.high_fwhm).toBe(1)
})

test('star filtering rejects detector eccentricity as elongation', () => {
	const filtered = filterGuideStars(starFrame([{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, eccentricity: 0.9 }]), {
		minStarSnr: 8,
		minFlux: 100,
		maxHfd: 8,
		borderMarginPx: 10,
		maxEllipticity: 0.5,
		maxFwhm: 10,
		saturationPeak: 65000,
	})

	expect(filtered.accepted).toHaveLength(0)
	expect(filtered.rejectedReasons.elongated).toBe(1)
})

describe('star filtering and star matching', () => {
	test('filters mixed star list with per-edge border rejection', () => {
		const stars = [star(0, { x: 15, y: 15 }), star(1, { x: 5 }), star(2, { x: WIDTH - 8 }), star(3, { y: 4 }), star(4, { y: HEIGHT - 1 }), star(5, { snr: 2 }), star(6, { saturated: true }), star(7, { valid: false }), star(8, { ellipticity: 0.9 }), star(9, { fwhm: 100 })]
		const filtered = filterGuideStars(starFrame(stars), {
			minStarSnr: 8,
			minFlux: 100,
			maxHfd: 8,
			borderMarginPx: 10,
			maxEllipticity: 0.5,
			maxFwhm: 10,
			saturationPeak: 65000,
		})
		expect(filtered.accepted).toHaveLength(1)
		expect(filtered.rejectedReasons.border).toBe(4)
		expect(filtered.rejectedReasons.low_snr).toBe(1)
		expect(filtered.rejectedReasons.saturated).toBe(1)
		expect(filtered.rejectedReasons.invalid).toBe(1)
		expect(filtered.rejectedReasons.elongated).toBe(1)
		expect(filtered.rejectedReasons.high_fwhm).toBe(1)
	})

	test('classifies detector artifacts like clipped peaks and NaN centroids', () => {
		const stars = [star(0, { peak: 70000 }), star(1, { x: Number.NaN }), star(2, { flux: 80 }), star(3, { hfd: 12 }), star(4, { peak: 64000 })]
		const filtered = filterGuideStars(starFrame(stars), {
			minStarSnr: 8,
			minFlux: 100,
			maxHfd: 8,
			borderMarginPx: 10,
			maxEllipticity: 0.5,
			maxFwhm: 10,
			saturationPeak: 65000,
		})
		expect(filtered.accepted).toHaveLength(1)
		expect(filtered.rejectedReasons.saturated_peak).toBe(1)
		expect(filtered.rejectedReasons.nan).toBe(1)
		expect(filtered.rejectedReasons.low_flux).toBe(1)
		expect(filtered.rejectedReasons.high_hfd).toBe(1)
	})

	test('selects an isolated guide star and spaced alternatives', () => {
		const crowdedA = star(0, { x: 395, y: 300, flux: 6200, snr: 38, hfd: 2.2 })
		const crowdedB = star(1, { x: 402, y: 304, flux: 5400, snr: 34, hfd: 2.1 })
		const primary = star(2, { x: 430, y: 320, flux: 4300, snr: 30, hfd: 2.4 })
		const closeAlternative = star(3, { x: 452, y: 331, flux: 4100, snr: 28, hfd: 2.5 })
		const wideAlternativeA = star(4, { x: 245, y: 215, flux: 3600, snr: 24, hfd: 2.6 })
		const wideAlternativeB = star(5, { x: 610, y: 395, flux: 3500, snr: 23, hfd: 2.7 })
		const edge = star(6, { x: 8, y: 300, flux: 9000, snr: 70, hfd: 2 })
		const saturated = star(7, { x: 470, y: 260, flux: 12000, snr: 90, hfd: 2.1, peak: 70000 })

		const selection = selectGuideStar([crowdedA, crowdedB, primary, closeAlternative, wideAlternativeA, wideAlternativeB, edge, saturated], WIDTH, HEIGHT, undefined, { minNeighborDistancePx: 12, alternativeSeparationPx: 32, maxAlternatives: 2 })

		expect(selection.primary?.x).toBe(primary.x)
		expect(selection.primary?.y).toBe(primary.y)
		expect(selection.alternatives).toHaveLength(2)
		expect(selection.alternatives.some((value) => value.x === closeAlternative.x && value.y === closeAlternative.y)).toBeFalse()
		expect(selection.alternatives.some((value) => value.x === wideAlternativeA.x && value.y === wideAlternativeA.y)).toBeTrue()
		expect(selection.alternatives.some((value) => value.x === wideAlternativeB.x && value.y === wideAlternativeB.y)).toBeTrue()
		expect(selection.rejectedReasons.double_star).toBe(2)
		expect(selection.rejectedReasons.border).toBe(1)
		expect(selection.rejectedReasons.saturated_peak).toBe(1)
	})

	test('uses image peaks to reject saturated guide stars when the catalog lacks peak data', () => {
		const width = 96
		const height = 96
		const raw = new Float64Array(width * height)
		const image: Image = {
			header: {},
			raw,
			metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width, strideInBytes: width * 8, bayer: undefined },
		}
		const saturated = star(0, { x: 48, y: 48, flux: 4200, snr: 28, hfd: 2.5, peak: undefined })
		const safe = star(1, { x: 26, y: 28, flux: 3300, snr: 24, hfd: 2.6, peak: undefined })

		raw[48 * width + 48] = 70000
		raw[28 * width + 26] = 32000

		const selection = selectGuideStar([saturated, safe], width, height, image, {
			filter: {
				minStarSnr: 8,
				minFlux: 100,
				maxHfd: 10,
				borderMarginPx: 8,
				maxEllipticity: 0.5,
				maxFwhm: 12,
				saturationPeak: 65000,
			},
			maxAlternatives: 1,
		})

		expect(selection.primary?.x).toBe(safe.x)
		expect(selection.primary?.y).toBe(safe.y)
		expect(selection.rejectedReasons.saturated_peak).toBe(1)
		expect(selection.candidates[0].peak).toBe(32000)
	})

	test('does not reject a lone valid star as double star on a small frame', () => {
		const width = 20
		const height = 18
		const lone = star(0, { x: 10, y: 9, flux: 1800, snr: 18, hfd: 2.4 })

		const selection = selectGuideStar([lone], width, height, undefined, {
			filter: { minStarSnr: 8, minFlux: 100, maxHfd: 10, borderMarginPx: 4, maxEllipticity: 0.5, maxFwhm: 12, saturationPeak: 65000 },
			minNeighborDistancePx: 40,
		})

		expect(selection.primary?.x).toBe(lone.x)
		expect(selection.primary?.y).toBe(lone.y)
		expect(selection.rejectedReasons.double_star).toBeUndefined()
		expect(selection.candidates[0].nearestNeighborDistance).toBe(Infinity)
	})

	test('enforces one-to-one nearest matching and max radius', () => {
		const reference = [star(0), star(1), star(2)]
		const current = [star(20, { x: reference[0].x + 1, y: reference[0].y }), star(21, { x: reference[1].x + 1, y: reference[1].y })]
		const ok = estimateTranslation(reference, current, 3, 2)
		expect(ok).toBeDefined()
		expect(ok!.matches).toBe(2)
		const far = shiftStars(reference, 20, 20, (value) => ({ ...value }))
		expect(estimateTranslation(reference, far, 3, 2)).toBeUndefined()
	})
})

test('multi-star translation rejects outlier and keeps weighted estimate', () => {
	const reference = [star(0), star(1), star(2), star(3), star(4)]
	const moved = shiftStars(reference, 1.5, -0.8, (value, index) => (index === 3 ? { ...value, x: value.x + 20, y: value.y - 15 } : value))
	const translation = estimateTranslation(reference, moved, 8, 2.5)
	expect(translation).toBeDefined()
	expect(translation!.matches).toBe(4)
	expect(translation!.dx).toBeCloseTo(1.5, 1)
	expect(translation!.dy).toBeCloseTo(-0.8, 1)
})

test('keeps the last accepted stellar identity after an uncommitted frame', () => {
	const tracker = new StarTracker()
	const context = { phase: 'guiding' as const, searchPosition: [100, 100] as const, searchRegion: 64, allowAcquisition: true, preserveIdentity: true }
	const initial = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 10],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		context,
	)

	expect(initial.measurement?.x).toBeCloseTo(100, 0)
	tracker.commit()
	const rejected = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 0.5],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 1,
			frameId: 2,
		},
		context,
	)
	expect(rejected.measurement).toBeUndefined()
	expect(rejected.notes).toContain('no_usable_measurement')

	const recovered = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 10],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 2,
			frameId: 3,
		},
		context,
	)
	expect(recovered.measurement?.x).toBeCloseTo(100, 0)
	expect(recovered.measurement?.y).toBeCloseTo(100, 0)
})

test('does not commit an initial acquisition before consumer acceptance', () => {
	const tracker = new StarTracker()
	const context = { phase: 'guiding' as const, searchPosition: [100, 100] as const, searchRegion: 64, initialPosition: [100, 100] as const, allowAcquisition: true, preserveIdentity: true }
	const initial = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 10],
				[120, 120, 0.5],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		context,
	)

	expect(initial.notes).toContain('acquired')
	const next = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 10],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 1,
			frameId: 2,
		},
		context,
	)

	expect(next.notes).toContain('acquired')
})

test('exposes a quality-approved primary separately from the nearest raw detection', () => {
	const tracker = new StarTracker()
	const result = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 0.5],
				[120, 120, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		{ phase: 'looping', searchPosition: [100, 100], searchRegion: 64, allowAcquisition: true, preserveIdentity: false },
	)

	expect(result.primary?.x).toBeCloseTo(100, 0)
	expect(result.selectionPrimary?.x).toBeCloseTo(120, 0)
	expect(result.rejectedReasons.low_snr).toBe(1)
	const selected = tracker.select(result)!
	expect(selected[0]).toBeCloseTo(120, 0)
	expect(selected[1]).toBeCloseTo(120, 0)
	const nearest = tracker.select(result, [100, 100])!
	expect(nearest[0]).toBeCloseTo(100, 0)
	expect(nearest[1]).toBeCloseTo(100, 0)
	expect(tracker.lastResult).toBe(result)
	const tied = { ...result, detections: [star(0, { x: 100, y: 100 }), star(1, { x: 120, y: 100 })] }
	expect(tracker.select(tied, [110, 100])).toEqual([100, 100])
	const empty = { ...result, detections: [] }
	expect(tracker.select(empty, [100, 100])).toBeUndefined()
})

test('keeps the raw primary for telemetry when no search region is active', () => {
	const tracker = new StarTracker()
	const result = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 100],
				[120, 120, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		{ phase: 'looping', allowAcquisition: true, preserveIdentity: false },
	)

	expect(result.primary?.x).toBeCloseTo(100, 0)
	expect(result.selectionPrimary?.x).toBeCloseTo(120, 0)
	expect(result.rejectedReasons.saturated_peak).toBe(1)
})

test('uses initialPosition to seed unbounded acquisition', () => {
	const tracker = new StarTracker()
	const result = tracker.track(
		{
			image: imageWithStars([
				[180, 180, 20],
				[500, 400, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		{ phase: 'looping', initialPosition: [500, 400], allowAcquisition: true, preserveIdentity: false },
	)

	expect(result.measurement?.x).toBeCloseTo(500, 0)
	expect(result.measurement?.y).toBeCloseTo(400, 0)
})

test('honors nested selection filter overrides', () => {
	const tracker = new StarTracker({ filter: { minStarSnr: 2 }, selection: { filter: { minStarSnr: 100 } } })
	const result = tracker.track(
		{
			image: imageWithStars([[300, 300, 10]]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		{ phase: 'looping', allowAcquisition: true, preserveIdentity: false },
	)

	expect(result.measurement).toBeUndefined()
	expect(result.selectionPrimary).toBeUndefined()
	expect(tracker.select(result)).toBeUndefined()
})

test('does not measure a field star when the search box has no acceptable candidate', () => {
	const tracker = new StarTracker()
	const context = { phase: 'guiding' as const, searchPosition: [100, 100] as const, searchRegion: 64, allowAcquisition: true, preserveIdentity: true }

	tracker.track(
		{
			image: imageWithStars([
				[100, 100, 10],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 0,
			frameId: 1,
		},
		context,
	)
	tracker.commit()

	const result = tracker.track(
		{
			image: imageWithStars([
				[100, 100, 0.5],
				[200, 200, 10],
			]),
			width: WIDTH,
			height: HEIGHT,
			timestamp: 1,
			frameId: 2,
		},
		context,
	)

	expect(result.measurement).toBeUndefined()
	expect(result.acceptedCount).toBe(1)
	expect(result.notes).toContain('no_usable_measurement')
})
