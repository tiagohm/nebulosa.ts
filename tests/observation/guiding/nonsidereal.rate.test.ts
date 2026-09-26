import { describe, expect, test } from 'bun:test'
import type { EquatorialCoordinate } from '../../../src/astronomy/coordinates/coordinate'
import { time, Timescale } from '../../../src/astronomy/time/time'
import { DAYSEC, PI, TAU } from '../../../src/core/constants'
import { TrackingRateEstimator, trackingMotionSampleFromAstrometry, trackingMotionSampleFromBackgroundStars, trackingMotionSampleFromImage, trackingRateFromStreak, type TrackingMotionSample } from '../../../src/observation/guiding/nonsidereal.rate'
import { TrackingRateController } from '../../../src/observation/guiding/nonsidereal.rate.controller'

const EPOCH = 2460000

function instant(seconds: number) {
	return time(EPOCH, seconds / DAYSEC, Timescale.TT)
}

function sample(seconds: number, east: number, north = 0, overrides: Partial<TrackingMotionSample> = {}): TrackingMotionSample {
	return { time: instant(seconds), offset: [east, north], source: 'targetAstrometry', ...overrides }
}

describe('TrackingRateEstimator', () => {
	test('fits combined constant tangent-plane rates at irregular observation times', () => {
		const estimator = new TrackingRateEstimator()
		const eastRate = 2e-6
		const northRate = -3e-6
		for (const seconds of [0, 7, 23, 51]) expect(estimator.add(sample(seconds, eastRate * seconds, northRate * seconds))).toBeTrue()
		expect(estimator.estimate(instant(51))).toBeUndefined()
		expect(estimator.add(sample(90, eastRate * 90, northRate * 90))).toBeTrue()

		const estimate = estimator.estimate(instant(100))
		expect(estimate?.rate[0]).toBeCloseTo(eastRate, 12)
		expect(estimate?.rate[1]).toBeCloseTo(northRate, 12)
		expect(estimate?.source).toBe('measured')
		expect(estimate?.sampleCount).toBe(5)
	})

	test('downweights a large positional outlier without losing the known rate', () => {
		const estimator = new TrackingRateEstimator({ robustOutlierThreshold: 2e-5 })
		for (const [seconds, error] of [
			[0, 0],
			[10, 0],
			[20, 0.02],
			[35, 0],
			[60, 0],
		] as const) {
			expect(estimator.add(sample(seconds, 1e-5 * seconds + error))).toBeTrue()
		}

		expect(estimator.estimate(instant(60))?.rate[0]).toBeCloseTo(1e-5, 6)
	})

	test('uses reported uncertainties when weighting observations', () => {
		const estimator = new TrackingRateEstimator({ robustOutlierThreshold: 0.01 })
		for (const seconds of [0, 10, 20, 30, 40]) {
			const noise = seconds === 20 ? 1e-4 : 0
			const uncertainty = seconds === 20 ? 1e-3 : 1e-8
			expect(estimator.add(sample(seconds, 1e-6 * seconds + noise, 0, { uncertainty: [uncertainty, uncertainty] }))).toBeTrue()
		}
		expect(estimator.estimate(instant(40))?.rate[0]).toBeCloseTo(1e-6, 12)
	})

	test('keeps samples without uncertainty influential in a mixed fit', () => {
		const mixed = new TrackingRateEstimator({ robustOutlierThreshold: 1e-4 })
		const unweighted = new TrackingRateEstimator({ robustOutlierThreshold: 1e-4 })
		for (const seconds of [0, 10, 20, 30, 40]) {
			const offset = 1e-6 * seconds + (seconds === 40 ? 5e-6 : 0)
			expect(mixed.add(sample(seconds, offset, 0, seconds === 40 ? { uncertainty: [1e-6, 1e-6] } : {}))).toBeTrue()
			expect(unweighted.add(sample(seconds, offset))).toBeTrue()
		}

		const mixedEstimate = mixed.estimate(instant(40))
		const unweightedEstimate = unweighted.estimate(instant(40))
		if (mixedEstimate === undefined || unweightedEstimate === undefined) throw new Error('both mixed and unweighted fits must be resolved')
		expect(mixedEstimate.rate[0]).toBeCloseTo(1.1e-6, 10)
		expect(mixedEstimate.rate[0]).toBeCloseTo(unweightedEstimate.rate[0], 14)
	})

	test('uses acceleration only when the sample span resolves curvature', () => {
		const acceleration = 2e-8
		const rate = 3e-6
		const estimator = new TrackingRateEstimator({ fitAcceleration: true, minimumAccelerationSpanSeconds: 100 })
		for (const seconds of [0, 30, 80, 140, 210, 300]) {
			expect(estimator.add(sample(seconds, rate * seconds + 0.5 * acceleration * seconds * seconds))).toBeTrue()
		}

		const estimate = estimator.estimate(instant(300))
		expect(estimate?.rate[0]).toBeCloseTo(rate + acceleration * 300, 12)
		expect(estimate?.acceleration?.[0]).toBeCloseTo(acceleration, 13)

		const linear = new TrackingRateEstimator({ robustOutlierThreshold: 2e-5 })
		for (const seconds of [0, 30, 80, 140, 210, 300]) {
			expect(linear.add(sample(seconds, rate * seconds + 0.5 * acceleration * seconds * seconds))).toBeTrue()
		}
		const linearEstimate = linear.estimate(instant(300))
		if (estimate?.position === undefined || estimate.acceleration === undefined || linearEstimate?.position === undefined) throw new Error('both motion models must be resolved')
		let linearSquaredResidual = 0
		let quadraticSquaredResidual = 0
		for (const seconds of [0, 30, 80, 140, 210, 300]) {
			const delta = seconds - 300
			const observed = rate * seconds + 0.5 * acceleration * seconds * seconds
			const linearPosition = linearEstimate.position[0] + linearEstimate.rate[0] * delta
			const quadraticPosition = estimate.position[0] + estimate.rate[0] * delta + 0.5 * estimate.acceleration[0] * delta * delta
			linearSquaredResidual += (observed - linearPosition) ** 2
			quadraticSquaredResidual += (observed - quadraticPosition) ** 2
		}
		expect(quadraticSquaredResidual).toBeLessThan(linearSquaredResidual)

		const robust = new TrackingRateEstimator({ fitAcceleration: true, minimumAccelerationSpanSeconds: 100, robustOutlierThreshold: 2e-5 })
		for (const seconds of [0, 30, 80, 140, 210, 300]) {
			const outlier = seconds === 140 ? 0.02 : 0
			expect(robust.add(sample(seconds, rate * seconds + 0.5 * acceleration * seconds * seconds + outlier))).toBeTrue()
		}
		expect(robust.estimate(instant(300))?.rate[0]).toBeCloseTo(rate + acceleration * 300, 6)
		expect(robust.estimate(instant(300))?.acceleration?.[0]).toBeCloseTo(acceleration, 9)

		const short = new TrackingRateEstimator({ fitAcceleration: true, minimumAccelerationSpanSeconds: 100 })
		for (const seconds of [0, 1, 2, 3, 4]) expect(short.add(sample(seconds, rate * seconds + 0.5 * acceleration * seconds * seconds))).toBeTrue()
		expect(short.estimate(instant(4))?.acceleration).toBeUndefined()
	})

	test('fits very slow and fast motion across dropped-frame intervals', () => {
		for (const rate of [1e-12, 1e-3]) {
			const estimator = new TrackingRateEstimator()
			for (const seconds of [0, 2, 9, 21, 50]) expect(estimator.add(sample(seconds, rate * seconds))).toBeTrue()
			expect(estimator.estimate(instant(50))?.rate[0]).toBeCloseTo(rate, rate < 1e-10 ? 18 : 12)
		}
	})

	test('fits tangent motion from astrometry near the celestial pole', () => {
		const declination = PI / 2 - 1e-5
		const anchor: EquatorialCoordinate = { rightAscension: 1, declination }
		const eastRate = 1e-9
		const estimator = new TrackingRateEstimator()
		for (const seconds of [0, 10, 20, 30, 40, 50]) {
			const position: EquatorialCoordinate = { rightAscension: anchor.rightAscension + (eastRate * seconds) / Math.cos(declination), declination }
			const observation = trackingMotionSampleFromAstrometry(instant(seconds), anchor, position)
			expect(Number.isFinite(observation.offset[0])).toBeTrue()
			expect(Number.isFinite(observation.offset[1])).toBeTrue()
			expect(estimator.add(observation)).toBeTrue()
		}
		expect(estimator.estimate(instant(50))?.rate[0]).toBeCloseTo(eastRate, 11)
	})

	test('fits ephemeris residuals without replacing the absolute ephemeris trajectory', () => {
		const estimator = new TrackingRateEstimator()
		for (const seconds of [0, 10, 20, 30, 40]) {
			const residualRate = -2e-7
			const ephemerisOffset = [1e-3 + seconds * 1e-6, -2e-3] as const
			const residualOffset = [seconds * residualRate, 0] as const
			expect(estimator.add(sample(seconds, ephemerisOffset[0] + residualOffset[0], ephemerisOffset[1], { ephemerisOffset }))).toBeTrue()
		}

		const estimate = estimator.estimate(instant(40))
		expect(estimate?.source).toBe('ephemerisAssisted')
		expect(estimate?.rate[0]).toBeCloseTo(-2e-7, 12)
		expect(estimate?.position?.[0]).toBeCloseTo(-8e-6, 12)
	})

	test('keeps a fixed timestamp offset as residual position bias instead of rate bias', () => {
		const ephemerisRate = 8e-6
		const residualRate = -2e-7
		const timestampOffsetSeconds = 2
		const estimator = new TrackingRateEstimator()
		for (const seconds of [0, 10, 20, 30, 40]) {
			const actualEphemeris = 1e-3 + ephemerisRate * seconds
			const reportedEphemeris = actualEphemeris + ephemerisRate * timestampOffsetSeconds
			const residual = 3e-5 + residualRate * seconds
			const reportedTime = seconds + timestampOffsetSeconds
			expect(estimator.add(sample(reportedTime, actualEphemeris + residual, 0, { ephemerisOffset: [reportedEphemeris, 0] }))).toBeTrue()
		}
		const estimate = estimator.estimate(instant(42))
		expect(estimate?.rate[0]).toBeCloseTo(residualRate, 12)
		expect(estimate?.position?.[0]).toBeCloseTo(3e-5 + residualRate * 40 - ephemerisRate * timestampOffsetSeconds, 12)
	})

	test('resolves a slowly changing ephemeris residual bias as acceleration', () => {
		const residualRate = -3e-7
		const acceleration = 2e-10
		const estimator = new TrackingRateEstimator({ fitAcceleration: true, minimumAccelerationSpanSeconds: 100 })
		for (const seconds of [0, 35, 90, 155, 230, 320]) {
			const ephemerisOffset = [1e-3 + 4e-6 * seconds, -2e-3 + seconds * 1e-6] as const
			const residualOffset = [2e-5 + residualRate * seconds + 0.5 * acceleration * seconds * seconds, 0] as const
			expect(estimator.add(sample(seconds, ephemerisOffset[0] + residualOffset[0], ephemerisOffset[1], { ephemerisOffset }))).toBeTrue()
		}
		const estimate = estimator.estimate(instant(320))
		expect(estimate?.source).toBe('ephemerisAssisted')
		expect(estimate?.rate[0]).toBeCloseTo(residualRate + acceleration * 320, 12)
		expect(estimate?.acceleration?.[0]).toBeCloseTo(acceleration, 13)
	})

	test('rejects non-monotonic samples and ends prediction after the configured horizon', () => {
		const estimator = new TrackingRateEstimator({ minimumSampleCount: 3, maximumPredictionSeconds: 30, staleTimeoutSeconds: 25 })
		expect(() => new TrackingRateEstimator({ maximumSampleCount: 257 })).toThrow(RangeError)
		for (const seconds of [0, 10, 20]) expect(estimator.add(sample(seconds, 1e-6 * seconds))).toBeTrue()
		expect(estimator.add(sample(19, 19e-6))).toBeFalse()
		expect(estimator.estimate(instant(50))).toBeDefined()
		expect(estimator.estimate(instant(51))).toBeUndefined()
		expect(estimator.estimate(instant(49))?.stale).toBeTrue()
		estimator.reset()
		expect(estimator.estimate(instant(20))).toBeUndefined()
	})

	test('uses wrap-safe astrometry and robust opposite background-star drift', () => {
		const anchor: EquatorialCoordinate = { rightAscension: TAU - 0.001, declination: 1.2 }
		const astrometric = trackingMotionSampleFromAstrometry(instant(0), anchor, { rightAscension: 0.001, declination: 1.2 })
		expect(astrometric.offset[0]).toBeCloseTo(0.0007247155, 8)
		expect(Math.abs(astrometric.offset[1])).toBeLessThan(1e-6)

		const image = trackingMotionSampleFromImage(instant(1), [2, -3], { pixelDeltaToSky: ([x, y]) => [-y * 2e-6, -x * 3e-6] })
		expect(image?.offset).toEqual([6e-6, -6e-6])

		const reference = [0, 1, 2, 3].map((id) => ({ id: String(id), x: id * 10, y: id * 5 }))
		const current = reference.map((star) => ({ ...star, x: star.x + 4, y: star.y - 2 }))
		current[3] = { ...current[3], x: current[3].x + 100, y: current[3].y - 80 }
		const transform = { pixelDeltaToSky: ([x, y]: readonly [number, number]) => [x * 1e-6, y * 1e-6] as const }
		const field = trackingMotionSampleFromBackgroundStars(instant(5), reference, current, transform)
		expect(field?.offset).toEqual([-4e-6, 2e-6])
		expect(field?.source).toBe('backgroundStars')
	})

	test('single streak direction stays ambiguous until supplied by temporal context', () => {
		const transform = { pixelDeltaToSky: ([x, y]: readonly [number, number]) => [3 * x * 2e-6 - 2 * y * 2e-6, 2 * x * 2e-6 + 3 * y * 2e-6] as const }
		const streak = { axisPixels: [5, -2] as const, exposureSeconds: 10, role: 'target' as const }
		expect(trackingRateFromStreak(instant(10), streak, transform)).toBeUndefined()
		const target = trackingRateFromStreak(instant(10), { ...streak, direction: -1 }, transform)
		const backgroundStar = trackingRateFromStreak(instant(10), { ...streak, role: 'backgroundStar', direction: -1 }, transform)
		expect(target?.rate[0]).toBeCloseTo(-3.8e-6, 18)
		expect(target?.rate[1]).toBeCloseTo(-8e-7, 18)
		expect(backgroundStar?.rate[0]).toBeCloseTo(3.8e-6, 18)
		expect(backgroundStar?.rate[1]).toBeCloseTo(8e-7, 18)
	})

	test('simulates calibrated image motion through estimation and residual control', () => {
		const transform = { pixelDeltaToSky: ([x, y]: readonly [number, number]) => [2e-6 * x - 1e-6 * y, 1e-6 * x + 3e-6 * y] as const }
		const eastRate = 4e-6
		const northRate = -2e-6
		const estimator = new TrackingRateEstimator()
		for (const seconds of [0, 10, 20, 30, 40]) {
			const deltaPixels: readonly [number, number] = [(10 / 7) * seconds, (-8 / 7) * seconds]
			const observation = trackingMotionSampleFromImage(instant(seconds), deltaPixels, transform)
			if (observation === undefined) throw new Error('simulated image transform must return an observation')
			expect(estimator.add(observation)).toBeTrue()
		}

		const estimate = estimator.estimate(instant(40))
		expect(estimate?.rate[0]).toBeCloseTo(eastRate, 12)
		expect(estimate?.rate[1]).toBeCloseTo(northRate, 12)
		const command = new TrackingRateController({ smoothingTimeConstantSeconds: 0, maximumRateChangePerUpdate: 1 }).update([0, 0], estimate, 1)
		expect(command?.correction[0]).toBeCloseTo(eastRate, 12)
		expect(command?.correction[1]).toBeCloseTo(northRate, 12)
	})
})

describe('TrackingRateController', () => {
	test('clips, slews, and combines residual correction with feed-forward rate', () => {
		const controller = new TrackingRateController({ minimumConfidence: 0.5, maximumCorrection: 5, maximumRateChangePerUpdate: 1, smoothingTimeConstantSeconds: 0 })
		const estimate = { time: instant(1), rate: [10, 0] as const, sampleCount: 4, span: 30, rmsResidual: [0, 0] as const, confidence: 1, source: 'measured' as const, stale: false }
		const command = controller.update([1, 2], estimate, 1)
		expect(command?.correction).toEqual([1, 0])
		expect(command?.rate).toEqual([2, 2])
		expect(command?.limited).toBeTrue()

		const next = controller.update([1, 2], estimate, 1)
		expect(next?.correction).toEqual([2, 0])
		const expired = controller.update([1, 2], { ...estimate, stale: true }, 1)
		expect(expired?.correction).toEqual([1, 0])
		expect(expired?.rate).toEqual([2, 2])
	})

	test('slews rejected estimates safely and suspends after temporary measurement loss', () => {
		const controller = new TrackingRateController({ minimumConfidence: 0.5, maximumCorrection: 10, maximumRateChangePerUpdate: 1, smoothingTimeConstantSeconds: 0 })
		const estimate = { time: instant(1), rate: [5, 0] as const, sampleCount: 3, span: 10, rmsResidual: [0, 0] as const, confidence: 1, source: 'measured' as const, stale: false }
		for (let i = 0; i < 5; i++) expect(controller.update([0, 0], estimate, 1)?.correction).toEqual([i + 1, 0])

		const rejected = controller.update([0, 0], { ...estimate, confidence: 0.49 }, 1)
		expect(rejected?.correction).toEqual([4, 0])
		expect(rejected?.confidence).toBe(0)
		expect(rejected?.limited).toBeTrue()
		expect(controller.update([0, 0], { ...estimate, stale: true }, 1)?.correction).toEqual([3, 0])
		expect(controller.update([0, 0], undefined, 1)?.correction).toEqual([2, 0])
		expect(controller.update([0, 0], undefined, 1)?.correction).toEqual([1, 0])
		expect(controller.update([0, 0], undefined, 1)?.correction).toEqual([0, 0])

		controller.update([0, 0], estimate, 1)
		controller.reset()
		expect(controller.update([0, 0], estimate, 1)?.correction).toEqual([1, 0])
	})

	test('holds the current correction when elapsed time cannot advance the slew filter', () => {
		const controller = new TrackingRateController({ maximumCorrection: 10, maximumRateChangePerUpdate: 1, smoothingTimeConstantSeconds: 0 })
		const estimate = { time: instant(1), rate: [5, 0] as const, sampleCount: 3, span: 10, rmsResidual: [0, 0] as const, confidence: 1, source: 'measured' as const, stale: false }
		controller.update([0, 0], estimate, 1)
		const command = controller.update([0, 0], undefined, 0)
		expect(command?.correction).toEqual([1, 0])
		expect(command?.limited).toBeTrue()
	})
})
