import { expect, test } from 'bun:test'
import { tanUnproject } from '../../../../src/astrometry/wcs/fits.wcs'
import { time, Timescale } from '../../../../src/astronomy/time/time'
import { PI, TAU } from '../../../../src/core/constants'
import { type CelestialStreakTrack, celestialStreakTrack, matchPredictedStreakTrack } from '../../../../src/imaging/analysis/streak/celestial'
import type { StreakClass, StreakClassification, StreakClassificationContext, StreakClassificationStar, StreakEvidenceProvider } from '../../../../src/imaging/analysis/streak/classification.types'
import { classifyStreak, classifyStreaks } from '../../../../src/imaging/analysis/streak/classifier'
import { normalizeStreakAngle } from '../../../../src/imaging/analysis/streak/geometry'
import type { Streak } from '../../../../src/imaging/analysis/streak/types'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'
import type { FitsHeader } from '../../../../src/io/formats/fits/fits'
import { sphericalDestination, sphericalSeparation } from '../../../../src/math/numerical/geometry'
import { type Angle, arcsec, deg, normalizeAngle, normalizePI } from '../../../../src/math/units/angle'

function image(width: number, height: number, fill = 0): Image {
	const raw = new Float32Array(width * height).fill(fill)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function measured(overrides: Partial<Streak> & Pick<Streak, 'start' | 'end'>): Streak {
	const { start, end } = overrides
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	const base: Streak = {
		start,
		end,
		center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
		length,
		width: 2.5,
		angle: normalizeStreakAngle(Math.atan2(end.y - start.y, end.x - start.x)),
		linearity: 0.99,
		rmsResidual: 0.2,
		coverage: 0.97,
		supportPixels: Math.max(1, Math.round(length)),
		clippedAtBorder: false,
		flux: 20,
		meanSignal: 0.3,
		peakSignal: 0.9,
		snr: 25,
		confidence: 0.9,
	}
	return { ...base, ...overrides, start, end, center: overrides.center ?? base.center, length: overrides.length ?? base.length, angle: overrides.angle ?? base.angle }
}

function tanWcs(overrides: Partial<FitsHeader> = {}): FitsHeader {
	return { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50.5, CRPIX2: 50.5, CRVAL1: 0, CRVAL2: 0, CD1_1: -0.05, CD1_2: 0, CD2_1: 0, CD2_2: 0.05, ...overrides }
}

function score(result: StreakClassification, kind: StreakClass): number {
	if (result.class === kind) return result.confidence
	return result.alternatives.find((item) => item.class === kind)?.score ?? 0
}

function evidenceScore(result: StreakClassification, kind: string): number {
	return result.evidence.find((item) => item.kind === kind)?.score ?? 0
}

function skyStreak(): Streak {
	return measured({ start: { x: 29.5, y: 49.5 }, end: { x: 69.5, y: 49.5 } })
}

function outwardRadiant(track: CelestialStreakTrack, id = 'PER') {
	const [rightAscension, declination] = sphericalDestination(track.start[0], track.start[1], normalizeAngle(track.positionAngle + PI), deg(5))
	return { id, rightAscension, declination }
}

function star(x: number, y: number, overrides: Partial<StreakClassificationStar> = {}): StreakClassificationStar {
	return { x, y, hfd: 3, fwhm: 3, snr: 30, flux: 80, elongation: 1.05, ...overrides }
}

function trailedStars(): StreakClassificationStar[] {
	const stars: StreakClassificationStar[] = []
	for (const x of [18, 72]) {
		for (const y of [18, 72]) {
			for (let offset = 0; offset < 4; offset++) stars.push(star(x + offset, y + offset, { hfd: 5, fwhm: 4, elongation: 2.2, eccentricity: 0.8, theta: 0 }))
		}
	}
	return stars
}

test('keeps strong satellite morphology unnamed and below a track match', () => {
	const streak = measured({ start: { x: 10, y: 40 }, end: { x: 190, y: 40 } })
	const morphology = classifyStreak(streak)
	expect(morphology.class).toBe('unknown')
	expect(score(morphology, 'satellite')).toBeGreaterThan(0.3)
	expect(score(morphology, 'satellite')).toBeLessThan(0.62)
	expect(morphology.alternatives[0]?.class).toBe('satellite')
	expect(evidenceScore(morphology, 'morphologyLinear')).toBeGreaterThan(0.9)

	const frame = image(240, 80)
	renderSyntheticStreak(frame, { start: streak.start, end: streak.end, width: 2.5, intensity: 0.8 })
	const smooth = classifyStreak(streak, { image: frame })
	expect(smooth.class).toBe('unknown')
	expect(evidenceScore(smooth, 'intensitySmooth')).toBeGreaterThan(0.5)
	expect(evidenceScore(smooth, 'intensityPeriodic')).toBe(0)
	expect(score(smooth, 'satellite')).toBeGreaterThan(score(smooth, 'airplane'))
})

test('names a satellite only when a caller-supplied track matches', () => {
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)
	expect(track).toBeDefined()
	const context: StreakClassificationContext = { wcs: header, satelliteTracks: [{ id: 'ISS', start: track!.start, end: track!.end }] }
	const matched = classifyStreak(streak, context)
	expect(matched.class).toBe('satellite')
	expect(matched.confidence).toBeGreaterThan(0.75)
	expect(matched.evidence.find((item) => item.kind === 'predictedTrack')?.id).toBe('ISS')

	const reversed = classifyStreak(streak, { wcs: header, satelliteTracks: [{ id: 'REV', start: track!.end, end: track!.start }] })
	expect(reversed.class).toBe('satellite')

	const ahead = sphericalDestination(track!.start[0], track!.start[1], track!.positionAngle, deg(20))
	const farther = sphericalDestination(track!.start[0], track!.start[1], track!.positionAngle, deg(24))
	const disjoint = classifyStreak(streak, { wcs: header, satelliteTracks: [{ start: ahead, end: farther }] })
	expect(disjoint.class).not.toBe('satellite')
})

test('drops a geometric satellite match whose exposure window misses the prediction', () => {
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!
	const startTime = time(2460000, 0, Timescale.UTC)
	const overlapping = classifyStreak(streak, {
		wcs: header,
		exposure: 30,
		startTime,
		satelliteTracks: [{ id: 'TIMED', start: track.start, end: track.end, startTime: time(2460000, -0.01, Timescale.UTC), endTime: time(2460000, 0.01, Timescale.UTC) }],
	})
	const missed = classifyStreak(streak, {
		wcs: header,
		exposure: 30,
		startTime,
		satelliteTracks: [{ start: track.start, end: track.end, startTime: time(2460000, 0.4, Timescale.UTC), endTime: time(2460000, 0.5, Timescale.UTC) }],
	})
	expect(overlapping.class).toBe('satellite')
	expect(missed.class).not.toBe('satellite')
	expect(matchPredictedStreakTrack(track, { start: track.start, end: track.end })?.score).toBeGreaterThan(0.9)

	const fast = classifyStreak(streak, {
		wcs: header,
		exposure: 30,
		startTime,
		satelliteTracks: [{ id: 'FAST', start: track.start, end: track.end, startTime: time(2460000, 10 / 86400, Timescale.UTC), endTime: time(2460000, 11 / 86400, Timescale.UTC) }],
	})
	expect(fast.class).toBe('satellite')
	const fastComparison = matchPredictedStreakTrack(
		track,
		{ start: track.start, end: track.end, startTime: time(2460000, 10 / 86400, Timescale.UTC), endTime: time(2460000, 11 / 86400, Timescale.UTC) },
		{ start: startTime, end: { day: startTime.day, fraction: startTime.fraction + 30 / 86400, scale: startTime.scale } },
	)
	expect(fastComparison?.temporalOverlap).toBeCloseTo(1, 6)
	const partial = matchPredictedStreakTrack(track, { start: track.start, end: track.end, startTime: time(2460000, 20 / 86400, Timescale.UTC), endTime: time(2460000, 40 / 86400, Timescale.UTC) }, { start: startTime, end: { day: startTime.day, fraction: startTime.fraction + 30 / 86400, scale: startTime.scale } })
	expect(partial?.temporalOverlap).toBeCloseTo(0.5, 6)
})

test('keeps a dashed trail unnamed and ahead of a smooth satellite hypothesis', () => {
	const frame = image(240, 64)
	const intervals = []
	for (let start = 0; start < 1; start += 16 / 200) intervals.push({ start, end: Math.min(1, start + 8 / 200) })
	renderSyntheticStreak(frame, { start: { x: 20, y: 32 }, end: { x: 220, y: 32 }, width: 2, intensity: 0.9, profile: { type: 'segments', intervals } })
	const streak = measured({ start: { x: 20, y: 32 }, end: { x: 220, y: 32 }, width: 2, coverage: 0.4 })
	const result = classifyStreak(streak, { image: frame })
	expect(result.class).toBe('unknown')
	expect(evidenceScore(result, 'intensityPeriodic')).toBeGreaterThan(0.5)
	expect(score(result, 'airplane')).toBeGreaterThan(score(result, 'satellite'))
	expect(score(result, 'airplane')).toBeLessThan(0.62)
})

test('ranks a tapered or flared trail as a meteor without naming it from brightness alone', () => {
	const taperedFrame = image(220, 64)
	renderSyntheticStreak(taperedFrame, { start: { x: 20, y: 32 }, end: { x: 180, y: 32 }, width: 2.5, intensity: 0.9, profile: { type: 'linear', start: 1, end: 0 } })
	const tapered = classifyStreak(measured({ start: { x: 20, y: 32 }, end: { x: 180, y: 32 } }), { image: taperedFrame })
	expect(tapered.class).toBe('unknown')
	expect(evidenceScore(tapered, 'intensityTapered')).toBeGreaterThan(0.6)
	expect(score(tapered, 'meteor')).toBeGreaterThan(score(tapered, 'satellite'))

	const flaredFrame = image(220, 64)
	renderSyntheticStreak(flaredFrame, { start: { x: 20, y: 32 }, end: { x: 180, y: 32 }, width: 2.5, intensity: 0.9, profile: { type: 'gaussian', center: 0.5, sigma: 0.08 } })
	const flared = classifyStreak(measured({ start: { x: 20, y: 32 }, end: { x: 180, y: 32 } }), { image: flaredFrame })
	expect(flared.class).toBe('unknown')
	expect(evidenceScore(flared, 'intensityFlared')).toBeGreaterThan(0.6)
	expect(evidenceScore(flared, 'intensityPeriodic')).toBe(0)
})

test('names a meteor from either extension of the great circle', () => {
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!
	const outward = classifyStreak(streak, { wcs: header, meteorRadiants: [outwardRadiant(track)] })
	expect(outward.class).toBe('meteor')
	expect(outward.confidence).toBeGreaterThan(0.7)
	expect(outward.evidence.find((item) => item.kind === 'meteorRadiant')?.id).toBe('PER')

	const [rightAscension, declination] = sphericalDestination(track.end[0], track.end[1], track.positionAngle, deg(5))
	const opposite = classifyStreak(streak, { wcs: header, meteorRadiants: [{ id: 'OPP', rightAscension, declination }] })
	expect(opposite.class).toBe('meteor')
	expect(opposite.confidence).toBeGreaterThan(0.7)
	expect(opposite.evidence.find((item) => item.kind === 'meteorRadiant')?.id).toBe('OPP')

	const offset = classifyStreak(streak, { wcs: header, meteorRadiants: [{ rightAscension: track.start[0], declination: track.start[1] + deg(30) }] })
	expect(offset.class).not.toBe('meteor')
	expect(score(offset, 'meteor')).toBeLessThan(score(outward, 'meteor'))
})

test('associates a high-declination trail with a radiant on its great circle', () => {
	const header = tanWcs({ CRVAL2: 80 })
	const streak = measured({ start: { x: 40.5, y: 49.5 }, end: { x: 60.5, y: 49.5 } })
	const track = celestialStreakTrack(streak, header)!
	const result = classifyStreak(streak, { wcs: header, meteorRadiants: [outwardRadiant(track, 'QUA')] })
	expect(result.class).toBe('meteor')
	expect(result.evidence.find((item) => item.kind === 'meteorRadiant')?.id).toBe('QUA')
})

test('keeps a short PSF-width trail unnamed until an ephemeris track matches', () => {
	const stars = [0, 1, 2, 3, 4].map((index) => star(10 + index * 8, 12))
	const streak = measured({ start: { x: 30, y: 40 }, end: { x: 52, y: 40 }, width: 3.1, length: 22 })
	const morphology = classifyStreak(streak, { stars })
	expect(morphology.class).toBe('unknown')
	expect(morphology.alternatives[0]?.class).toBe('movingObject')
	expect(evidenceScore(morphology, 'morphologyPsf')).toBeGreaterThan(0.7)

	const header = tanWcs()
	const track = celestialStreakTrack(streak, header)!
	const matched = classifyStreak(streak, { stars, wcs: header, movingObjectTracks: [{ id: '2024 AB', start: track.start, end: track.end }] })
	expect(matched.class).toBe('movingObject')
	expect(matched.evidence.find((item) => item.kind === 'predictedTrack')?.id).toBe('2024 AB')
})

test('leaves competing satellite and moving-object predictions unnamed', () => {
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!
	const prediction = { start: track.start, end: track.end }
	const result = classifyStreak(streak, { wcs: header, satelliteTracks: [{ id: 'SAT', ...prediction }], movingObjectTracks: [{ id: 'NEO', ...prediction }] })
	expect(result.class).toBe('unknown')
	expect(score(result, 'satellite')).toBeGreaterThan(0.7)
	expect(score(result, 'movingObject')).toBeGreaterThan(0.7)
	expect(
		result.evidence
			.filter((item) => item.kind === 'predictedTrack')
			.map((item) => item.id)
			.sort((left, right) => (left === right ? 0 : left !== undefined && right !== undefined && left > right ? 1 : -1)),
	).toEqual(['NEO', 'SAT'])
})

test('names tracking failure only for a coherent field aligned with the streak', () => {
	const aligned = measured({ start: { x: 15, y: 50 }, end: { x: 85, y: 50 } })
	const snapshot = { starCount: 40, usableStarCount: 30, elongatedFraction: 0.85, directionCoherence: 0.93, angle: 0 as Angle, medianTrail: 6, score: 0.9 }
	expect(classifyStreak(aligned, { tracking: snapshot }).class).toBe('trackingFailure')
	expect(classifyStreak(measured({ start: { x: 40, y: 20 }, end: { x: 70, y: 70 }, width: 4 }), { tracking: snapshot }).class).not.toBe('trackingFailure')
	expect(classifyStreak(aligned, { tracking: { ...snapshot, elongatedFraction: 0.05, directionCoherence: 0.2, score: 0.1 } }).class).not.toBe('trackingFailure')

	const frame = image(100, 100)
	expect(classifyStreak(aligned, { image: frame, stars: trailedStars() }).class).toBe('trackingFailure')
	const source = trailedStars()
	const oneQuadrant: StreakClassificationStar[] = []
	for (let index = 0; index < source.length; index++) {
		const item = source[index]
		oneQuadrant.push({ x: item.x > 50 ? item.x - 50 : item.x, y: item.y > 50 ? item.y - 50 : item.y, hfd: item.hfd, fwhm: item.fwhm, snr: item.snr, flux: item.flux, elongation: item.elongation, eccentricity: item.eccentricity, theta: item.theta })
	}
	expect(classifyStreak(aligned, { image: frame, stars: oneQuadrant }).class).not.toBe('trackingFailure')
	expect(classifyStreak(measured({ start: { x: 50, y: 20 }, end: { x: 50, y: 60 }, width: 4 }), { image: frame, stars: trailedStars() }).class).not.toBe('trackingFailure')
})

test('does not treat a parallel train of long trails as tracking failure', () => {
	const streaks = [20, 40, 60, 80, 100, 120].map((y) => measured({ start: { x: 10, y }, end: { x: 180, y } }))
	const results = classifyStreaks(streaks)
	expect(results.every((result) => result.class !== 'trackingFailure')).toBeTrue()
	expect(results.every((result) => result.class === 'unknown')).toBeTrue()
})

test('names a full-span hot column and a repeated sensor locus, but not a short trail', () => {
	const frame = image(80, 100)
	const column = measured({ start: { x: 40, y: 1 }, end: { x: 40, y: 99 }, width: 1.1, clippedAtBorder: true })
	expect(classifyStreak(column, { image: frame }).class).toBe('sensorArtifact')
	expect(evidenceScore(classifyStreak(column, { image: frame }), 'sensorLine')).toBeGreaterThan(0.8)

	const short = measured({ start: { x: 10, y: 20 }, end: { x: 40, y: 20 }, width: 3 })
	expect(classifyStreak(short, { image: image(200, 200) }).class).not.toBe('sensorArtifact')

	const diagonal = measured({ start: { x: 20, y: 20 }, end: { x: 90, y: 90 }, width: 4 })
	const repeated = classifyStreak(diagonal, { priorFrames: [{ streaks: [measured({ start: { x: 20.2, y: 20.2 }, end: { x: 90.2, y: 90.2 }, width: 4 })] }] })
	expect(repeated.class).toBe('sensorArtifact')
	expect(evidenceScore(repeated, 'sensorPersistence')).toBeGreaterThan(0.9)
	const moved = classifyStreak(diagonal, { priorFrames: [{ streaks: [measured({ start: { x: 20, y: 32 }, end: { x: 90, y: 102 }, width: 4 })] }] })
	expect(moved.class).not.toBe('sensorArtifact')
})

test('requires more than one axis through a bright star before naming an optical artifact', () => {
	const bright = star(50, 100, { snr: 80, flux: 500 })
	const horizontal = measured({ start: { x: 20, y: 100 }, end: { x: 80, y: 100 }, width: 2.5 })
	const single = classifyStreak(horizontal, { stars: [bright] })
	expect(single.class).toBe('unknown')
	expect(single.alternatives[0]?.class).toBe('opticalArtifact')
	expect(evidenceScore(single, 'opticalAlignment')).toBe(1)
	expect(evidenceScore(single, 'opticalSpikeFamily')).toBe(0)

	const vertical = measured({ start: { x: 50, y: 70 }, end: { x: 50, y: 130 }, width: 2.5 })
	const family = classifyStreaks([horizontal, vertical], { stars: [bright], image: image(200, 200) })
	expect(family.map((result) => result.class)).toEqual(['opticalArtifact', 'opticalArtifact'])

	expect(evidenceScore(classifyStreak(horizontal, { stars: [star(50, 100, { snr: 8 })] }), 'opticalAlignment')).toBe(0)
	expect(evidenceScore(classifyStreak(measured({ start: { x: 10, y: 50 }, end: { x: 40, y: 50 } }), { stars: [star(120, 50, { snr: 80 })] }), 'opticalAlignment')).toBe(0)
})

test('stays unknown without WCS, time, or other context and repeats deterministically', () => {
	const streak = measured({ start: { x: 5, y: 5 }, end: { x: 12, y: 7 }, width: 4, linearity: 0.6, coverage: 0.4, snr: 3 })
	const once = classifyStreak(streak)
	const twice = classifyStreak(streak)
	expect(once.class).toBe('unknown')
	expect(twice).toEqual(once)

	const header = tanWcs()
	const sky = skyStreak()
	const track = celestialStreakTrack(sky, header)!
	const contextual = classifyStreak(sky, { wcs: header, satelliteTracks: [{ id: 'A', start: track.start, end: track.end }] })
	expect(classifyStreak(sky, { wcs: header, satelliteTracks: [{ id: 'A', start: track.start, end: track.end }] })).toEqual(contextual)
	expect(() => classifyStreak(sky, { satelliteTracks: [{ start: track.start, end: track.end }], meteorRadiants: [{ rightAscension: 0, declination: 0 }] })).not.toThrow()
	expect(classifyStreak(sky, { meteorRadiants: [{ rightAscension: 0, declination: 0 }] }).class).toBe('unknown')
})

test('converts streaks across the right-ascension branch cut and near the pole', () => {
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!
	const start = tanUnproject(header, streak.start.x + 1, streak.start.y + 1)!
	const end = tanUnproject(header, streak.end.x + 1, streak.end.y + 1)!
	expect(track.start[0]).toBeCloseTo(start[0], 10)
	expect(track.start[1]).toBeCloseTo(start[1], 10)
	expect(track.end[0]).toBeCloseTo(end[0], 10)
	expect(Math.abs(track.end[0] - track.start[0])).toBeGreaterThan(PI)
	expect(track.length).toBeLessThan(deg(5))
	expect(track.length).toBeCloseTo(sphericalSeparation(track.start[0], track.start[1], track.end[0], track.end[1]), 8)
	expect(track.positionAngle).toBeGreaterThanOrEqual(0)
	expect(track.positionAngle).toBeLessThan(TAU)
	expect(Math.hypot(track.normal[0], track.normal[1], track.normal[2])).toBeCloseTo(1, 10)
	expect(celestialStreakTrack(streak, {})).toBeUndefined()
	expect(celestialStreakTrack(measured({ start: { x: 10, y: 10 }, end: { x: 10, y: 10 } }), header)).toBeUndefined()

	const polarHeader = tanWcs({ CRVAL2: 89 })
	const polar = celestialStreakTrack(streak, polarHeader)!
	const polarStart = tanUnproject(polarHeader, streak.start.x + 1, streak.start.y + 1)!
	const polarEnd = tanUnproject(polarHeader, streak.end.x + 1, streak.end.y + 1)!
	const separation = sphericalSeparation(polarStart[0], polarStart[1], polarEnd[0], polarEnd[1])
	expect(polar.length).toBeCloseTo(separation, 8)
	expect(Math.abs(normalizePI(polarEnd[0] - polarStart[0]))).toBeGreaterThan(polar.length * 5)
	expect(classifyStreak(streak, { wcs: header, satelliteTracks: [{ id: 'WRAP', start: track.start, end: track.end }] }).class).toBe('satellite')
})

test('preserves input order and lets a caller replace the providers', () => {
	const frame = image(80, 100)
	const blob = measured({ start: { x: 5, y: 5 }, end: { x: 12, y: 6 }, width: 4, linearity: 0.5, coverage: 0.3, snr: 2 })
	const column = measured({ start: { x: 40, y: 1 }, end: { x: 40, y: 99 }, width: 1.1, clippedAtBorder: true })
	expect(classifyStreaks([blob, column, blob], { image: frame }).map((result) => result.class)).toEqual(['unknown', 'sensorArtifact', 'unknown'])

	const provider: StreakEvidenceProvider = { id: 'forced', evaluate: () => [{ class: 'airplane', score: 1, weight: 1, tier: 'primary', evidence: [{ kind: 'test-provider', score: 1 }] }] }
	const forced = classifyStreak(blob, {}, { providers: [provider] })
	expect(forced.class).toBe('airplane')
	expect(forced.confidence).toBe(1)
	expect(forced.evidence.map((item) => item.kind)).toEqual(['test-provider'])
	expect(classifyStreaks([], {}, { providers: [] })).toEqual([])
})

test('reports a direct cross-track residual below an arcsecond for identical arcs', () => {
	const track = celestialStreakTrack(skyStreak(), tanWcs())!
	const comparison = matchPredictedStreakTrack(track, { start: track.start, end: track.end })
	expect(comparison?.crossTrack).toBeLessThan(arcsec(1))
	expect(comparison?.overlap).toBeGreaterThan(0.95)
	expect(comparison?.temporalOverlap).toBeUndefined()
})
