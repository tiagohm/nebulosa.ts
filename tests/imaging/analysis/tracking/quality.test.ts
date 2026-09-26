import { expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import type { Streak } from '../../../../src/imaging/analysis/streak/types'
import { measureTrackingQuality } from '../../../../src/imaging/analysis/tracking/quality'
import type { Image } from '../../../../src/imaging/model/types'
import { STAR_SIGNAL_RADIUS, type DetectedStar, detectStars } from '../../../../src/imaging/stars/detector'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'
import { deg } from '../../../../src/math/units/angle'

function image(width: number = 100, height: number = 100): Image {
	return { raw: new Float32Array(width * height), header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

// A symmetric Gaussian with sigma=1 px convolved with a line of length L has major variance 1+L²/12.
function star(x: number, y: number, trail: number, theta: number, overrides: Partial<DetectedStar> = {}): DetectedStar {
	return { x, y, flux: 100, snr: 20, hfd: 2.5, majorVariance: 1 + (trail * trail) / 12, minorVariance: 1, theta, ...overrides }
}

function field(trail: number, theta: number): DetectedStar[] {
	const stars: DetectedStar[] = []
	for (const y of [15, 35, 65, 85]) for (const x of [15, 35, 65, 85]) stars.push(star(x, y, trail, theta))
	return stars
}

function streak(startX: number, endX: number, y: number): Streak {
	const start = { x: startX, y }
	const end = { x: endX, y }
	return { start, end, center: { x: (startX + endX) / 2, y }, length: endX - startX, width: 2, angle: 0, linearity: 1, rmsResidual: 0, coverage: 1, supportPixels: endX - startX, clippedAtBorder: false, flux: 100, meanSignal: 1, peakSignal: 1, confidence: 1 }
}

test('round, one-, two- and five-pixel tracking trails retain physical lengths and rising score', () => {
	const frame = image()
	const round = measureTrackingQuality(frame, field(0, 0))
	expect(round.starCount).toBe(16)
	expect(round.usableStarCount).toBe(16)
	expect(round.elongatedFraction).toBe(0)
	expect(round.directionCoherence).toBe(0)
	expect(round.medianTrail).toBeUndefined()
	expect(round.score).toBe(0)

	const scores: number[] = []
	for (const length of [1, 2, 5]) {
		const result = measureTrackingQuality(frame, field(length, 0))
		expect(result.elongatedFraction).toBe(1)
		expect(result.directionCoherence).toBeCloseTo(1, 12)
		expect(result.angle).toBeCloseTo(0, 12)
		expect(result.medianTrail).toBeCloseTo(length, 12)
		expect(result.p90Trail).toBeCloseTo(length, 12)
		expect(result.maxTrail).toBeCloseTo(length, 12)
		expect(result.medianCrossWidth).toBeCloseTo(2 * Math.sqrt(2 * Math.LN2), 12)
		expect(result.diagnostics.quadrantCoverage).toBe(1)
		scores.push(result.score)
	}
	expect(scores[0]).toBeGreaterThan(0)
	expect(scores[1]).toBeGreaterThan(scores[0])
	expect(scores[2]).toBeGreaterThanOrEqual(scores[1])
})

test('axial mean handles vertical, diagonal and zero/pi wrap but conflicting axes remain incoherent', () => {
	const frame = image()
	const vertical = measureTrackingQuality(frame, field(3, PI / 2))
	expect(vertical.angle).toBeCloseTo(PI / 2, 12)
	expect(vertical.directionCoherence).toBeCloseTo(1, 12)
	const diagonal = measureTrackingQuality(frame, field(3, PI / 4))
	expect(diagonal.angle).toBeCloseTo(PI / 4, 12)

	const wrapped = field(3, 0).map((sample, i) => star(sample.x, sample.y, 3, i % 2 ? PI - 0.02 : 0.02))
	const wrap = measureTrackingQuality(frame, wrapped)
	expect(wrap.directionCoherence).toBeGreaterThan(0.99)
	expect(Math.min(wrap.angle!, PI - wrap.angle!)).toBeLessThan(0.03)

	const random = field(3, 0).map((sample, i) => star(sample.x, sample.y, 3, ((i + 0.5) * PI) / 16))
	expect(measureTrackingQuality(frame, random).directionCoherence).toBeLessThan(0.01)
	const conflicting = field(3, 0).map((sample, i) => star(sample.x, sample.y, 3, i % 2 ? PI / 2 : 0))
	expect(measureTrackingQuality(frame, conflicting).directionCoherence).toBeLessThan(0.01)
	const outlier = [...field(3, 0), star(50, 50, 3, PI / 2)]
	const robust = measureTrackingQuality(frame, outlier)
	expect(robust.directionCoherence).toBeCloseTo(1, 12)
	expect(robust.angle).toBeCloseTo(0, 12)
})

test('a strong outlier, a crossing streak and poor SNR do not dominate a tracked field', () => {
	const frame = image()
	const stars = field(3, 0)
	stars.push(star(50, 50, 40, PI / 2))
	stars.push(star(50, 70, 3, 0, { snr: 0.1 }))
	const result = measureTrackingQuality(frame, stars, {}, { streaks: [streak(45, 55, 50)] })
	expect(result.usableStarCount).toBe(16)
	expect(result.diagnostics.rejectedStars).toBe(2)
	expect(result.diagnostics.isolatedStreakCount).toBe(1)
	expect(result.medianTrail).toBeCloseTo(3, 12)
	expect(result.directionCoherence).toBeCloseTo(1, 12)
	expect(result.score).toBeGreaterThan(0.9)

	const round = measureTrackingQuality(frame, [...field(0, 0), star(50, 50, 40, 0)], {}, { streaks: [streak(45, 55, 50)] })
	expect(round.score).toBe(0)
	expect(round.elongatedFraction).toBe(0)
	expect(round.usableStarCount).toBe(16)
	expect(round.diagnostics.isolatedStreakCount).toBe(1)
	const isolated = measureTrackingQuality(frame, [...field(0, 0), star(50, 50, 40, 0)])
	expect(isolated.score).toBe(0)
})

test('distributed stellar streaks preserve the evidence of a severe tracking failure', () => {
	const frame = image()
	const stars = field(15, 0)
	const stellarStreaks = stars.map((sample) => streak(sample.x - 7.5, sample.x + 7.5, sample.y))
	const baseline = measureTrackingQuality(frame, stars)
	const measured = measureTrackingQuality(frame, stars, {}, { streaks: stellarStreaks })
	expect(baseline.score).toBeGreaterThan(0.9)
	expect(measured.usableStarCount).toBe(16)
	expect(measured.elongatedFraction).toBe(1)
	expect(measured.directionCoherence).toBeCloseTo(1, 12)
	expect(measured.diagnostics.quadrantCoverage).toBe(1)
	expect(measured.diagnostics.isolatedStreakCount).toBe(0)
	expect(measured.score).toBeCloseTo(baseline.score, 12)
	const sparse = [stars[0], stars[1], stars[2], stars[3], stars[8], stars[9], stars[10], stars[11]]
	const fewDetectedStreaks = [sparse[0], sparse[2], sparse[4], sparse[6]].map((sample) => streak(sample.x - 7.5, sample.x + 7.5, sample.y))
	const sparseResult = measureTrackingQuality(frame, sparse, {}, { streaks: fewDetectedStreaks })
	expect(sparseResult.usableStarCount).toBe(8)
	expect(sparseResult.diagnostics.quadrantCoverage).toBe(1)
	expect(sparseResult.score).toBeGreaterThan(0.9)
})

test('detector-measured long stellar trails retain field evidence despite aperture-truncated moments', () => {
	const frame = image(256, 256)
	frame.raw.fill(0.1)
	for (const y of [35, 95, 155, 215]) {
		for (const x of [35, 95, 155, 215]) {
			renderSyntheticStreak(frame, { start: { x: x - 19, y }, end: { x: x + 19, y }, width: 3, intensity: 0.8 })
		}
	}

	const stars = detectStars(frame)
	const streaks = detectStreaks(frame, { minLength: 30, maxWidth: 8, backgroundCellSize: 32 })
	const baseline = measureTrackingQuality(frame, stars)
	const measured = measureTrackingQuality(frame, stars, {}, { streaks })
	expect(stars.length).toBeGreaterThanOrEqual(16)
	expect(streaks.length).toBeGreaterThan(0)
	expect(baseline.score).toBeGreaterThan(0.6)
	expect(baseline.medianTrail).toBeLessThan(2 * STAR_SIGNAL_RADIUS)
	expect(streaks.some((sample) => sample.length > 2 * baseline.medianTrail!)).toBeTrue()
	expect(measured.usableStarCount).toBeGreaterThanOrEqual(0.75 * baseline.usableStarCount)
	expect(measured.score).toBeGreaterThanOrEqual(0.75 * baseline.score)
})

test('one external streak cannot validate the field from stars it crosses', () => {
	const frame = image()
	frame.raw.fill(0.1)
	function roundStar(x: number, y: number): void {
		for (let py = Math.floor(y - 5); py <= Math.ceil(y + 5); py++) {
			for (let px = Math.floor(x - 5); px <= Math.ceil(x + 5); px++) {
				frame.raw[py * frame.metadata.stride + px] += 0.25 * Math.exp((-0.5 * ((px - x) ** 2 + (py - y) ** 2)) / 1.2 ** 2)
			}
		}
	}
	for (const x of [12, 25, 38, 52, 62, 72, 82, 92]) roundStar(x, 0.6 * x + 10)
	roundStar(15, 85)
	roundStar(85, 15)
	renderSyntheticStreak(frame, { start: { x: 10, y: 16 }, end: { x: 94, y: 66.4 }, width: 3, intensity: 0.5 })

	const stars = detectStars(frame)
	const streaks = detectStreaks(frame, { minLength: 50, maxWidth: 8, backgroundCellSize: 24, maxStreaks: 1 })
	const baseline = measureTrackingQuality(frame, stars)
	const measured = measureTrackingQuality(frame, stars, {}, { streaks })
	expect(stars.length).toBeGreaterThanOrEqual(8)
	expect(streaks).toHaveLength(1)
	expect(baseline.score).toBeGreaterThan(0.8)
	expect(measured.usableStarCount).toBeLessThan(baseline.usableStarCount)
	expect(measured.score).toBeLessThan(0.1)
})

test('an isolated aligned streak crossing a round star or scale outlier is not stellar tracking', () => {
	const frame = image()
	for (const outlierTrail of [0, 10]) {
		const stars = [...field(3, 0), star(50, 50, outlierTrail, 0)]
		const result = measureTrackingQuality(frame, stars, {}, { streaks: [streak(30, 70, 50)] })
		expect(result.usableStarCount).toBe(16)
		expect(result.diagnostics.isolatedStreakCount).toBe(1)
		expect(result.score).toBeGreaterThan(0.9)
	}
})

test('median, p90 and maximum trail are invariant to star order', () => {
	const frame = image()
	const stars = field(0, 0).map((sample, index) => star(sample.x, sample.y, 2 + index * 0.1, 0))
	const lengths = stars.map((sample) => Math.sqrt(12 * (sample.majorVariance! - sample.minorVariance!))).sort((left, right) => left - right)
	const p90Rank = 0.9 * (lengths.length - 1)
	const lower = Math.floor(p90Rank)
	const expectedP90 = lengths[lower] + (lengths[lower + 1] - lengths[lower]) * (p90Rank - lower)
	const first = measureTrackingQuality(frame, stars)
	const reversed = measureTrackingQuality(frame, stars.toReversed())
	const permuted = measureTrackingQuality(
		frame,
		stars.map((_, index) => stars[(index * 5) % stars.length]),
	)
	for (const result of [first, reversed, permuted]) {
		expect(result.medianTrail).toBeCloseTo(2.75, 12)
		expect(result.p90Trail).toBeCloseTo(expectedP90, 12)
		expect(result.maxTrail).toBeCloseTo(3.5, 12)
	}
})

test('measured detector moments distinguish a trailed raster from a round raster', () => {
	function raster(trail: number): Image {
		const frame = image()
		frame.raw.fill(0.02)
		for (const y of [15, 35, 65, 85]) {
			for (const x of [15, 35, 65, 85]) {
				for (let py = y - 6; py <= y + 6; py++) {
					for (let px = x - 7; px <= x + 7; px++) {
						let signal = 0
						for (let sample = 0; sample < 11; sample++) {
							const dx = px - x - (trail * (sample - 5)) / 10
							const dy = py - y
							signal += Math.exp((-0.5 * (dx * dx + dy * dy)) / (1.2 * 1.2))
						}
						frame.raw[py * 100 + px] += (0.8 * signal) / 11
					}
				}
			}
		}
		return frame
	}
	const roundImage = raster(0)
	const trailedImage = raster(3)
	const roundStars = detectStars(roundImage)
	const trailedStars = detectStars(trailedImage)
	expect(roundStars).toHaveLength(16)
	expect(trailedStars).toHaveLength(16)
	const round = measureTrackingQuality(roundImage, roundStars)
	const trailed = measureTrackingQuality(trailedImage, trailedStars)
	expect(round.score).toBe(0)
	expect(trailed.usableStarCount).toBe(16)
	expect(trailed.medianTrail).toBeGreaterThan(1)
	expect(trailed.directionCoherence).toBeGreaterThan(0.95)
	expect(trailed.score).toBeGreaterThan(round.score)
})

test('single-region and radial optical patterns do not score as field-wide tracking', () => {
	const frame = image()
	const cluster = Array.from({ length: 12 }, (_, i) => star(10 + (i % 4) * 6, 10 + Math.floor(i / 4) * 6, 4, 0))
	const local = measureTrackingQuality(frame, cluster)
	expect(local.diagnostics.quadrantCoverage).toBe(0.25)
	expect(local.diagnostics.opticalPatternSuspected).toBe(true)
	expect(local.score).toBeLessThan(0.4)

	const radial = field(4, 0).map((sample) => star(sample.x, sample.y, 4, Math.atan2(sample.y - 50, sample.x - 50)))
	const optics = measureTrackingQuality(frame, radial)
	expect(optics.directionCoherence).toBeLessThan(0.1)
	expect(optics.diagnostics.opticalPatternSuspected).toBe(true)
	expect(optics.score).toBeLessThan(0.1)
	const edgeOnly = field(4, 0).map((sample) => star(sample.x, sample.y, sample.x === 35 || sample.x === 65 ? (sample.y === 35 || sample.y === 65 ? 0 : 4) : 4, 0))
	const edge = measureTrackingQuality(frame, edgeOnly)
	expect(edge.diagnostics.opticalPatternSuspected).toBe(true)
	expect(edge.score).toBeLessThan(0.3)

	const few = measureTrackingQuality(frame, field(4, 0).slice(0, 4))
	expect(few.score).toBe(0)
})

test('optional saturation cut excludes a star without scanning or modifying the image', () => {
	const frame = image()
	frame.raw[15 * 100 + 15] = 1
	const before = frame.raw.slice()
	const result = measureTrackingQuality(frame, field(3, 0), { saturationLevel: 0.9 })
	expect(result.usableStarCount).toBe(15)
	expect(result.diagnostics.rejectedStars).toBe(1)
	expect(frame.raw).toEqual(before)
	const rgb: Image = { ...image(), raw: new Float32Array(100 * 100 * 3), metadata: { ...frame.metadata, channels: 3, stride: 300, strideInBytes: 1200 } }
	rgb.raw[15 * 300 + 15 * 3 + 2] = 1
	expect(measureTrackingQuality(rgb, field(3, 0), { saturationLevel: 0.9 }).usableStarCount).toBe(15)
})

test('linear calibration and TAN WCS transform east, north, rotation and parity in radians', () => {
	const frame = image()
	const scale = deg(0.01)
	const east = measureTrackingQuality(frame, field(3, 0), {}, { pixelToSky: [scale, 0, 0, scale] }).sky!
	expect(east.medianTrail).toBeCloseTo(3 * scale, 12)
	expect(east.east).toBeCloseTo(3 * scale, 12)
	expect(east.north).toBeCloseTo(0, 12)
	expect(east.angle).toBeCloseTo(0, 12)
	const rotated = measureTrackingQuality(frame, field(3, 0), {}, { pixelToSky: [0, -scale, scale, 0] }).sky!
	expect(rotated.north).toBeCloseTo(3 * scale, 12)
	expect(rotated.angle).toBeCloseTo(PI / 2, 12)
	const mirrored = measureTrackingQuality(frame, field(3, 0), {}, { pixelToSky: [-scale, 0, 0, scale] }).sky!
	expect(mirrored.east).toBeCloseTo(-3 * scale, 12)
	expect(mirrored.angle).toBeCloseTo(0, 12)

	const wcs = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50.5, CRPIX2: 50.5, CRVAL1: 359.9, CRVAL2: 80, CD1_1: 0.01, CD1_2: 0, CD2_1: 0, CD2_2: 0.01 }
	const highDec = measureTrackingQuality(frame, field(3, 0), {}, { wcs }).sky!
	expect(highDec.east).toBeCloseTo(3 * scale, 7)
	expect(highDec.north).toBeCloseTo(0, 7)
	expect(highDec.medianTrail).toBeCloseTo(3 * scale, 7)
})
