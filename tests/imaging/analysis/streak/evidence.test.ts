import { expect, describe, test } from 'bun:test'
import { time, Timescale } from '../../../../src/astronomy/time/time'
import { PI } from '../../../../src/core/constants'
import { celestialStreakTrack } from '../../../../src/imaging/analysis/streak/celestial'
import type { StreakClassificationStar, StreakEvidenceContribution } from '../../../../src/imaging/analysis/streak/classification.types'
import { FieldCoherenceStreakEvidence, IntensityStreakEvidence, MeteorRadiantStreakEvidence, MorphologyStreakEvidence, OpticalStreakEvidence, SensorStreakEvidence, TrajectoryStreakEvidence } from '../../../../src/imaging/analysis/streak/evidence'
import { normalizeStreakAngle } from '../../../../src/imaging/analysis/streak/geometry'
import type { Streak } from '../../../../src/imaging/analysis/streak/types'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'
import type { FitsHeader } from '../../../../src/io/formats/fits/fits'
import { sphericalDestination } from '../../../../src/math/numerical/geometry'
import { deg, normalizeAngle } from '../../../../src/math/units/angle'

function image(width: number, height: number, fill = 0): Image {
	const raw = new Float32Array(width * height).fill(fill)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function colorImage(width: number, height: number): Image {
	const stride = width * 3
	return { raw: new Float32Array(stride * height), header: {}, metadata: { width, height, channels: 3, stride, pixelCount: width * height, strideInBytes: stride * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
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

function star(x: number, y: number, overrides: Partial<StreakClassificationStar> = {}): StreakClassificationStar {
	return { x, y, hfd: 3, fwhm: 3, snr: 30, flux: 80, elongation: 1.05, ...overrides }
}

function voteOf(votes: readonly StreakEvidenceContribution[], kind: string): StreakEvidenceContribution | undefined {
	return votes.find((vote) => vote.evidence.some((item) => item.kind === kind))
}

function skyStreak(): Streak {
	return measured({ start: { x: 29.5, y: 49.5 }, end: { x: 69.5, y: 49.5 } })
}

describe('MorphologyStreakEvidence', () => {
	const provider = new MorphologyStreakEvidence()

	test('votes a saturated secondary satellite score for a long narrow trail', () => {
		expect(provider.id).toBe('morphology')
		const votes = provider.evaluate(measured({ start: { x: 10, y: 40 }, end: { x: 190, y: 40 } }), {})
		const satellite = voteOf(votes, 'morphologyLinear')
		expect(satellite).toMatchObject({ class: 'satellite', score: 1, weight: 0.35, tier: 'secondary' })
		expect(voteOf(votes, 'morphologyPsf')).toBeUndefined()
		expect(voteOf(votes, 'morphologyBroad')).toBeUndefined()
	})

	test('matches a short trail to the stellar width and ignores too few or mismatched stars', () => {
		const streak = measured({ start: { x: 30, y: 40 }, end: { x: 52, y: 40 }, width: 3 })
		const matched = provider.evaluate(streak, { stars: [0, 1, 2, 3, 4].map((index) => star(10 + index, 12)) })
		expect(voteOf(matched, 'morphologyPsf')).toMatchObject({ class: 'movingObject', score: 1, weight: 0.4, tier: 'secondary' })
		expect(voteOf(matched, 'morphologyLinear')).toBeUndefined()

		const withoutStars = provider.evaluate(streak, {})
		expect(voteOf(withoutStars, 'morphologyPsf')?.score).toBeGreaterThan(0.8)

		const wideStars = [0, 1, 2, 3, 4].map((index) => star(10 + index, 12, { fwhm: 12, hfd: 12 }))
		expect(voteOf(provider.evaluate(streak, { stars: wideStars }), 'morphologyPsf')).toBeUndefined()
		expect(voteOf(provider.evaluate(streak, { stars: wideStars.slice(0, 4) }), 'morphologyPsf')).toBeDefined()

		const hfdStars = [0, 1, 2, 3, 4].map((index) => star(10 + index, 12, { fwhm: undefined, hfd: 3 }))
		expect(voteOf(provider.evaluate(streak, { stars: hfdStars }), 'morphologyPsf')?.score).toBe(1)
		const faintStars = [0, 1, 2, 3, 4].map((index) => star(10 + index, 12, { snr: 7, fwhm: 12 }))
		expect(voteOf(provider.evaluate(streak, { stars: faintStars }), 'morphologyPsf')).toBeDefined()
	})

	test('withholds the moving-object vote when the trail is faint and votes airplane only for a broad or bent trail', () => {
		const faint = measured({ start: { x: 10, y: 20 }, end: { x: 30, y: 20 }, width: 2.5, snr: 3 })
		expect(provider.evaluate(faint, {})).toEqual([])
		const unspecified = measured({ start: { x: 10, y: 20 }, end: { x: 30, y: 20 }, width: 2.5, snr: undefined })
		expect(voteOf(provider.evaluate(unspecified, {}), 'morphologyPsf')?.score).toBeGreaterThan(0.5)

		const broad = measured({ start: { x: 10, y: 40 }, end: { x: 130, y: 40 }, width: 14, linearity: 0.8 })
		const broadVotes = provider.evaluate(broad, {})
		expect(voteOf(broadVotes, 'morphologyBroad')).toMatchObject({ class: 'airplane', weight: 0.2, tier: 'secondary' })
		expect(voteOf(broadVotes, 'morphologyBroad')?.score).toBeGreaterThan(0.7)
		expect(voteOf(broadVotes, 'morphologyLinear')).toBeUndefined()

		const bent = measured({ start: { x: 10, y: 20 }, end: { x: 50, y: 20 }, width: 3, linearity: 0.7 })
		const bentVotes = provider.evaluate(bent, {})
		expect(voteOf(bentVotes, 'morphologyBroad')?.score).toBeGreaterThan(0.3)
		expect(voteOf(bentVotes, 'morphologyLinear')).toBeUndefined()
		expect(voteOf(bentVotes, 'morphologyPsf')).toBeUndefined()
	})
})

describe('IntensityStreakEvidence', () => {
	const provider = new IntensityStreakEvidence()

	test('returns no profile without a usable frame or a measurable peak', () => {
		expect(provider.id).toBe('intensity')
		const streak = measured({ start: { x: 20, y: 32 }, end: { x: 180, y: 32 } })
		expect(provider.evaluate(streak, {})).toEqual([])
		const shortRaw = image(32, 32)
		expect(provider.evaluate(streak, { image: { ...shortRaw, raw: new Float32Array(4) } })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 8, y: 8 }, end: { x: 8, y: 8 } }), { image: image(32, 32) })).toEqual([])
		expect(provider.evaluate(streak, { image: image(220, 64) })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: -30, y: 10 }, end: { x: 10, y: 10 } }), { image: image(40, 30) })).toEqual([])
	})

	test('reads a smooth green centerline and ignores a trail stored only in red', () => {
		const streak = measured({ start: { x: 10, y: 20 }, end: { x: 90, y: 20 }, width: 2 })
		const green = colorImage(120, 50)
		const red = colorImage(120, 50)
		for (let x = 10; x <= 90; x++) {
			green.raw[20 * green.metadata.stride + x * 3 + 1] = 0.8
			red.raw[20 * red.metadata.stride + x * 3] = 0.8
		}
		const smooth = provider.evaluate(streak, { image: green })
		expect(voteOf(smooth, 'intensitySmooth')).toMatchObject({ class: 'satellite', score: 1, weight: 0.15, tier: 'secondary' })
		expect(voteOf(smooth, 'intensityPeriodic')).toBeUndefined()
		expect(voteOf(smooth, 'intensityTapered')).toBeUndefined()
		expect(provider.evaluate(streak, { image: red })).toEqual([])
	})

	test('separates periodic, tapered, and flared profiles', () => {
		const dashed = image(240, 64)
		const intervals = []
		for (let start = 0; start < 1; start += 16 / 200) intervals.push({ start, end: Math.min(1, start + 8 / 200) })
		const segment = { start: { x: 20, y: 32 }, end: { x: 220, y: 32 } }
		renderSyntheticStreak(dashed, { ...segment, width: 2, intensity: 0.9, profile: { type: 'segments', intervals } })
		const periodic = provider.evaluate(measured({ ...segment, width: 2, coverage: 0.4 }), { image: dashed })
		expect(voteOf(periodic, 'intensityPeriodic')).toMatchObject({ class: 'airplane', weight: 0.55, tier: 'secondary' })
		expect(voteOf(periodic, 'intensityPeriodic')?.score).toBeGreaterThan(0.5)
		expect(voteOf(periodic, 'intensitySmooth')).toBeUndefined()

		const taperedFrame = image(220, 64)
		renderSyntheticStreak(taperedFrame, { start: { x: 20, y: 32 }, end: { x: 180, y: 32 }, width: 2.5, intensity: 0.9, profile: { type: 'linear', start: 1, end: 0 } })
		const tapered = provider.evaluate(measured({ start: { x: 20, y: 32 }, end: { x: 180, y: 32 } }), { image: taperedFrame })
		expect(voteOf(tapered, 'intensityTapered')).toMatchObject({ class: 'meteor', weight: 0.55, tier: 'secondary' })
		expect(voteOf(tapered, 'intensityTapered')?.score).toBeGreaterThan(0.6)
		expect(voteOf(tapered, 'intensityFlared')).toBeUndefined()

		const flaredFrame = image(220, 64)
		renderSyntheticStreak(flaredFrame, { start: { x: 20, y: 32 }, end: { x: 180, y: 32 }, width: 2.5, intensity: 0.9, profile: { type: 'gaussian', center: 0.5, sigma: 0.08 } })
		const flared = provider.evaluate(measured({ start: { x: 20, y: 32 }, end: { x: 180, y: 32 } }), { image: flaredFrame })
		expect(voteOf(flared, 'intensityFlared')).toMatchObject({ class: 'meteor', weight: 0.55, tier: 'secondary' })
		expect(voteOf(flared, 'intensityFlared')?.score).toBeGreaterThan(0.6)
		expect(voteOf(flared, 'intensityPeriodic')).toBeUndefined()
	})
})

describe('TrajectoryStreakEvidence', () => {
	const provider = new TrajectoryStreakEvidence()
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!

	test('matches the best caller-supplied track and ignores a disjoint window', () => {
		expect(provider.id).toBe('trajectory')
		expect(provider.evaluate(streak, {})).toEqual([])
		expect(provider.evaluate(streak, { wcs: {} })).toEqual([])
		expect(provider.evaluate(streak, { wcs: header })).toEqual([])

		const matched = provider.evaluate(streak, { wcs: header, satelliteTracks: [{ id: 'ISS', start: track.start, end: track.end }] })
		expect(matched).toHaveLength(1)
		expect(matched[0]).toMatchObject({ class: 'satellite', weight: 0.8, tier: 'primary' })
		expect(matched[0]?.score).toBeGreaterThan(0.9)
		expect(matched[0]?.evidence[0]).toMatchObject({ kind: 'predictedTrack', id: 'ISS' })

		const reversed = provider.evaluate(streak, { wcs: header, satelliteTracks: [{ id: 'REV', start: track.end, end: track.start }] })
		expect(reversed[0]?.evidence[0]?.id).toBe('REV')
		expect(reversed[0]?.score).toBeGreaterThan(0.9)

		const ahead = sphericalDestination(track.start[0], track.start[1], track.positionAngle, deg(20))
		const farther = sphericalDestination(track.start[0], track.start[1], track.positionAngle, deg(24))
		expect(provider.evaluate(streak, { wcs: header, satelliteTracks: [{ id: 'AHEAD', start: ahead, end: farther }] })).toEqual([])

		const offset = { start: [track.start[0], track.start[1] + deg(10)] as const, end: [track.end[0], track.end[1] + deg(10)] as const }
		const best = provider.evaluate(streak, {
			wcs: header,
			satelliteTracks: [
				{ id: 'BAD', ...offset },
				{ id: 'GOOD', start: track.start, end: track.end },
			],
		})
		expect(best).toHaveLength(1)
		expect(best[0]?.evidence[0]?.id).toBe('GOOD')
	})

	test('applies exposure overlap only when both windows share a timescale', () => {
		const startTime = time(2460000, 0, Timescale.UTC)
		const prediction = { start: track.start, end: track.end }
		const overlapping = provider.evaluate(streak, {
			wcs: header,
			exposure: 30,
			startTime,
			movingObjectTracks: [{ id: 'NEO', ...prediction, startTime: time(2460000, -0.01, Timescale.UTC), endTime: time(2460000, 0.01, Timescale.UTC) }],
		})
		expect(overlapping[0]).toMatchObject({ class: 'movingObject', tier: 'primary', weight: 0.8 })
		expect(provider.evaluate(streak, { wcs: header, exposure: 30, startTime, satelliteTracks: [{ ...prediction, startTime: time(2460000, 0.4, Timescale.UTC), endTime: time(2460000, 0.5, Timescale.UTC) }] })).toEqual([])
		expect(provider.evaluate(streak, { wcs: header, exposure: 0, startTime, satelliteTracks: [{ id: 'OPEN', ...prediction, startTime, endTime: time(2460000, 0.5, Timescale.UTC) }] })[0]?.evidence[0]?.id).toBe('OPEN')
		expect(provider.evaluate(streak, { wcs: header, exposure: 30, startTime, satelliteTracks: [{ ...prediction, startTime }] })).toHaveLength(1)
		const mismatchedScale = provider.evaluate(streak, {
			wcs: header,
			exposure: 30,
			startTime,
			satelliteTracks: [{ id: 'TDB', ...prediction, startTime: time(2460000, 0.4, Timescale.TDB), endTime: time(2460000, 0.5, Timescale.TDB) }],
		})
		expect(mismatchedScale[0]?.evidence[0]?.id).toBe('TDB')
		expect(mismatchedScale[0]?.score).toBeGreaterThan(0.9)
	})
})

describe('MeteorRadiantStreakEvidence', () => {
	const provider = new MeteorRadiantStreakEvidence()
	const header = tanWcs()
	const streak = skyStreak()
	const track = celestialStreakTrack(streak, header)!
	const outward = sphericalDestination(track.start[0], track.start[1], normalizeAngle(track.positionAngle + PI), deg(5))

	test('accepts both great-circle extensions and records an off-plane radiant without weight', () => {
		expect(provider.id).toBe('meteorRadiant')
		expect(provider.evaluate(streak, {})).toEqual([])
		expect(provider.evaluate(streak, { wcs: header, meteorRadiants: [] })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 10, y: 10 }, end: { x: 10, y: 10 } }), { wcs: header, meteorRadiants: [{ rightAscension: 0, declination: 0 }] })).toEqual([])

		const compatible = provider.evaluate(streak, {
			wcs: header,
			meteorRadiants: [
				{ id: 'FAR', rightAscension: track.start[0], declination: track.start[1] + deg(30) },
				{ id: 'PER', rightAscension: outward[0], declination: outward[1] },
			],
		})
		expect(compatible).toHaveLength(1)
		expect(compatible[0]).toMatchObject({ class: 'meteor', weight: 0.8, tier: 'primary' })
		expect(compatible[0]?.score).toBeGreaterThan(0.95)
		expect(compatible[0]?.evidence[0]).toMatchObject({ kind: 'meteorRadiant', id: 'PER' })

		const inward = sphericalDestination(track.end[0], track.end[1], track.positionAngle, deg(5))
		const opposite = provider.evaluate(streak, { wcs: header, meteorRadiants: [{ id: 'OPP', rightAscension: inward[0], declination: inward[1] }] })
		expect(opposite[0]).toMatchObject({ class: 'meteor', weight: 0.8, tier: 'primary' })
		expect(opposite[0]?.score).toBeGreaterThan(0.95)
		expect(opposite[0]?.evidence[0]).toMatchObject({ kind: 'meteorRadiant', id: 'OPP' })

		const offset = provider.evaluate(streak, { wcs: header, meteorRadiants: [{ id: 'OFF', rightAscension: track.start[0], declination: track.start[1] + deg(30) }] })
		expect(offset[0]).toMatchObject({ class: 'meteor', score: 0, weight: 0, tier: 'secondary' })
		expect(offset[0]?.evidence[0]?.kind).toBe('meteorRadiantIncompatible')
		expect(offset[0]?.evidence[0]?.id).toBe('OFF')
	})
})

describe('FieldCoherenceStreakEvidence', () => {
	const provider = new FieldCoherenceStreakEvidence()
	const aligned = measured({ start: { x: 15, y: 50 }, end: { x: 85, y: 50 } })
	const snapshot = { starCount: 40, usableStarCount: 30, elongatedFraction: 0.85, directionCoherence: 0.93, angle: 0, medianTrail: 70, score: 0.9 }

	function orientedStars(origins: readonly (readonly [number, number])[], overrides: Partial<StreakClassificationStar> = {}): StreakClassificationStar[] {
		const stars: StreakClassificationStar[] = []
		for (let origin = 0; origin < origins.length; origin++) {
			for (let offset = 0; offset < 4; offset++) stars.push(star(origins[origin][0] + offset, origins[origin][1], { elongation: 2.2, theta: 0, ...overrides }))
		}
		return stars
	}

	test('trusts an aligned tracking snapshot and does not fall through to stars', () => {
		expect(provider.id).toBe('fieldCoherence')
		expect(provider.evaluate(aligned, {})).toEqual([])
		const voted = provider.evaluate(aligned, { tracking: snapshot })
		expect(voted[0]).toMatchObject({ class: 'trackingFailure', score: 1, weight: 0.8, tier: 'primary' })
		expect(voted[0]?.evidence[0]?.kind).toBe('trackingField')
		expect(provider.evaluate(aligned, { tracking: { ...snapshot, angle: undefined } })[0]).toMatchObject({ score: 1, tier: 'secondary' })
		expect(provider.evaluate(measured({ start: { x: 10, y: 40 }, end: { x: 210, y: 40 } }), { tracking: { ...snapshot, medianTrail: 6 } })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 10, y: 40 }, end: { x: 18, y: 40 } }), { tracking: { ...snapshot, medianTrail: 6 } })[0]).toMatchObject({ score: 1, tier: 'primary' })
		expect(provider.evaluate(measured({ start: { x: 40, y: 20 }, end: { x: 70, y: 70 }, width: 4 }), { tracking: snapshot })).toEqual([])
		expect(provider.evaluate(aligned, { tracking: { ...snapshot, angle: deg(13) } })).toEqual([])
		expect(provider.evaluate(aligned, { tracking: { ...snapshot, usableStarCount: 7 } })).toEqual([])
		expect(provider.evaluate(aligned, { tracking: { ...snapshot, elongatedFraction: 0.4 } })).toEqual([])
		expect(provider.evaluate(aligned, { tracking: { ...snapshot, directionCoherence: 0.65 } })).toEqual([])

		const frame = image(100, 100)
		const stars = orientedStars([
			[18, 18],
			[72, 18],
			[18, 72],
		])
		expect(provider.evaluate(aligned, { image: frame, stars, tracking: { ...snapshot, elongatedFraction: 0.05, directionCoherence: 0.2, score: 0.1 } })).toEqual([])
	})

	test('uses oriented stars only when they cover three quadrants and share the streak axis', () => {
		const frame = image(100, 100)
		const stars = orientedStars([
			[18, 18],
			[72, 18],
			[18, 72],
		])
		const voted = provider.evaluate(aligned, { image: frame, stars })
		expect(voted[0]).toMatchObject({ class: 'trackingFailure', score: 1, weight: 0.8, tier: 'primary' })
		expect(voted[0]?.evidence[0]?.kind).toBe('stellarField')
		expect(provider.evaluate(measured({ start: { x: 50, y: 20 }, end: { x: 50, y: 70 }, width: 4 }), { image: frame, stars })).toEqual([])
		expect(provider.evaluate(aligned, { stars })).toEqual([])
		expect(
			provider.evaluate(aligned, {
				image: frame,
				stars: orientedStars([
					[18, 18],
					[22, 22],
					[26, 26],
					[30, 30],
				]),
			}),
		).toEqual([])
		expect(
			provider.evaluate(aligned, {
				image: frame,
				stars: orientedStars([
					[18, 18],
					[72, 18],
				]),
			}),
		).toEqual([])
		expect(
			provider.evaluate(aligned, {
				image: frame,
				stars: orientedStars(
					[
						[18, 18],
						[72, 18],
						[18, 72],
					],
					{ theta: undefined },
				),
			}),
		).toEqual([])
		expect(
			provider.evaluate(aligned, {
				image: frame,
				stars: orientedStars(
					[
						[18, 18],
						[72, 18],
						[18, 72],
					],
					{ snr: 7 },
				),
			}),
		).toEqual([])
	})
})

describe('OpticalStreakEvidence', () => {
	const provider = new OpticalStreakEvidence()
	const bright = star(50, 100, { snr: 80, flux: 500 })
	const horizontal = measured({ start: { x: 20, y: 100 }, end: { x: 80, y: 100 }, width: 2.5 })

	function throughStar(angle: number): Streak {
		const dx = Math.cos(angle) * 30
		const dy = Math.sin(angle) * 30
		return measured({ start: { x: bright.x - dx, y: bright.y - dy }, end: { x: bright.x + dx, y: bright.y + dy }, width: 2.5 })
	}

	test('votes one alignment for a bright star and a family only for a second axis', () => {
		expect(provider.id).toBe('optical')
		expect(provider.evaluate(horizontal, {}, [])).toEqual([])
		expect(provider.evaluate(horizontal, { stars: [star(50, 100, { snr: 24 })] }, [])).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 10, y: 50 }, end: { x: 40, y: 50 } }), { stars: [star(120, 50, { snr: 80 })] }, [])).toEqual([])
		expect(provider.evaluate(horizontal, { stars: [star(50, 100, { snr: 25 })] }, [])[0]).toMatchObject({ class: 'opticalArtifact', score: 1, weight: 0.45, tier: 'secondary' })

		const alone = provider.evaluate(horizontal, { stars: [bright] }, [horizontal])
		expect(alone).toHaveLength(1)
		expect(alone[0]?.evidence[0]?.kind).toBe('opticalAlignment')

		const parallel = measured({ start: { x: 20, y: 100 }, end: { x: 90, y: 100 }, width: 2.5 })
		expect(provider.evaluate(horizontal, { stars: [bright] }, [horizontal, parallel])).toHaveLength(1)
		expect(provider.evaluate(horizontal, { stars: [bright] }, [horizontal, throughStar(deg(10))])).toHaveLength(1)

		const family = provider.evaluate(horizontal, { stars: [bright] }, [horizontal, throughStar(deg(25))])
		expect(family.map((vote) => vote.tier)).toEqual(['secondary', 'primary'])
		expect(family[1]).toMatchObject({ class: 'opticalArtifact', score: 1, weight: 0.8 })
		expect(family[1]?.evidence[0]?.kind).toBe('opticalSpikeFamily')

		const elsewhere = measured({ start: { x: 80, y: 70 }, end: { x: 80, y: 130 }, width: 2.5 })
		expect(provider.evaluate(horizontal, { stars: [bright] }, [horizontal, elsewhere])).toHaveLength(1)
	})
})

describe('SensorStreakEvidence', () => {
	const provider = new SensorStreakEvidence()

	test('votes a full-span row or column and not a short or diagonal trail', () => {
		expect(provider.id).toBe('sensor')
		const column = measured({ start: { x: 40, y: 1 }, end: { x: 40, y: 99 }, width: 1.1, clippedAtBorder: true })
		const columnVote = provider.evaluate(column, { image: image(80, 100) })
		expect(columnVote).toHaveLength(1)
		expect(columnVote[0]).toMatchObject({ class: 'sensorArtifact', score: 1, weight: 0.8, tier: 'primary' })
		expect(columnVote[0]?.evidence[0]?.kind).toBe('sensorLine')

		const row = measured({ start: { x: 1, y: 40 }, end: { x: 99, y: 40 }, width: 1.1, clippedAtBorder: true })
		expect(provider.evaluate(row, { image: image(100, 80) })[0]?.score).toBe(1)
		expect(provider.evaluate(column, {})).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 10, y: 20 }, end: { x: 40, y: 20 }, width: 1.1 }), { image: image(200, 200) })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 20, y: 20 }, end: { x: 90, y: 90 }, width: 1.1 }), { image: image(120, 120) })).toEqual([])
		expect(provider.evaluate(measured({ start: { x: 40, y: 1 }, end: { x: 40, y: 99 }, width: 4 }), { image: image(80, 100) })).toEqual([])

		const fullRow = measured({ start: { x: 0, y: 500 }, end: { x: 999, y: 500 }, width: 1, linearity: 0.99, coverage: 0.99, rmsResidual: 0.1 })
		expect(provider.evaluate(fullRow, { image: image(1000, 1000) })[0]?.score).toBe(1)
		const interior = measured({ start: { x: 40, y: 500 }, end: { x: 960, y: 500 }, width: 1, linearity: 0.99, coverage: 0.99, rmsResidual: 0.1, clippedAtBorder: false })
		expect(provider.evaluate(interior, { image: image(1000, 1000) })).toEqual([])
		const fullColumn = measured({ start: { x: 500, y: 0 }, end: { x: 500, y: 999 }, width: 1, linearity: 0.99, coverage: 0.99, rmsResidual: 0.1 })
		expect(provider.evaluate(fullColumn, { image: image(1000, 1000) })[0]?.score).toBe(1)
		const oneBorder = measured({ start: { x: 0, y: 500 }, end: { x: 500, y: 500 }, width: 1, linearity: 0.99, coverage: 0.99, rmsResidual: 0.1, clippedAtBorder: true })
		expect(provider.evaluate(oneBorder, { image: image(1000, 1000) })).toEqual([])
	})

	test('counts repeated loci by frame and rejects a shifted or poorly overlapping line', () => {
		const diagonal = measured({ start: { x: 20, y: 20 }, end: { x: 90, y: 90 }, width: 4 })
		const copy = measured({ start: { x: 20.2, y: 20.2 }, end: { x: 90.2, y: 90.2 }, width: 4 })
		const once = provider.evaluate(diagonal, { priorFrames: [{ streaks: [copy, copy] }] })
		expect(once).toHaveLength(1)
		expect(once[0]).toMatchObject({ class: 'sensorArtifact', score: 0.95, weight: 0.8, tier: 'primary' })
		expect(once[0]?.evidence[0]?.kind).toBe('sensorPersistence')
		expect(provider.evaluate(diagonal, { priorFrames: [{ streaks: [copy] }, { streaks: [copy] }] })[0]?.score).toBe(1)
		expect(provider.evaluate(diagonal, { priorFrames: [{ streaks: [measured({ start: { x: 20, y: 32 }, end: { x: 90, y: 102 }, width: 4 })] }] })).toEqual([])
		expect(provider.evaluate(diagonal, { priorFrames: [{ streaks: [measured({ start: diagonal.start, end: diagonal.end, angle: deg(5) })] }] })).toEqual([])

		const line = measured({ start: { x: 10, y: 30 }, end: { x: 110, y: 30 }, width: 2 })
		const partial = measured({ start: { x: 90, y: 30 }, end: { x: 190, y: 30 }, width: 2 })
		expect(provider.evaluate(line, { priorFrames: [{ streaks: [partial] }] })).toEqual([])
		expect(provider.evaluate(line, { priorFrames: [] })).toEqual([])
	})
})
