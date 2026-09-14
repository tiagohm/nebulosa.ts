import { describe, expect, test } from 'bun:test'
import type { EquatorialCoordinate } from '../../../src/astronomy/coordinates/coordinate'
import { linearInterpolator, type EphemerisPoint } from '../../../src/astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, time, toJulianDay } from '../../../src/astronomy/time/time'
import { ASEC2RAD, DAYSEC, PI, TAU } from '../../../src/core/constants'
import type { GuideTracker, GuideTrackerContext, GuideTrackerFrame, GuideTrackerResult } from '../../../src/observation/guiding/tracker'
import { baseTrackerOf, nonSiderealAngularOffset, calibratedNonSiderealTransform, estimateNonSiderealDerivative, InterpolatedNonSiderealEphemeris, NonSiderealError, NonSiderealTracker, type NonSiderealEphemeris } from '../../../src/observation/guiding/tracker.nonsidereal'
import { starTrackingOf } from '../../../src/observation/guiding/tracker.star'

const J0 = 2460000

function instant(seconds: number) {
	return time(J0, seconds / DAYSEC, Timescale.TT)
}

function point(seconds: number, rightAscension: number, declination: number): EphemerisPoint {
	return { time: instant(seconds), rightAscension, declination }
}

function linearEphemeris(rateEast: number, rateNorth: number, durationSeconds: number = 2400) {
	const interpolator = linearInterpolator([point(0, 0, 0), point(durationSeconds, rateEast * durationSeconds, rateNorth * durationSeconds)])
	return new InterpolatedNonSiderealEphemeris(interpolator)
}

function trackerFrame(seconds: number, captureMonotonic: number = seconds): GuideTrackerFrame {
	return { width: 100, height: 100, timestamp: seconds, captureTime: instant(seconds), captureMonotonic, frameId: seconds }
}

function guideContext(lockEstablished: boolean): GuideTrackerContext {
	return { phase: 'guiding', allowAcquisition: true, preserveIdentity: true, lockEstablished }
}

function baseResult(targetOffset: readonly [number, number] = [3, 4]): GuideTrackerResult & { readonly detections: readonly []; readonly accepted: readonly [] } {
	return {
		measurement: { x: 10, y: 20, confidence: 1 },
		candidateCount: 1,
		acceptedCount: 1,
		qualityScore: 1,
		rejectedReasons: {},
		notes: ['base'],
		targetOffset,
		detections: [],
		accepted: [],
	}
}

function baseStub(result: GuideTrackerResult): GuideTracker {
	return { reset: () => undefined, track: () => result, commit: () => undefined }
}

test('uses an inclusive TT validity window instead of the interpolator clamp', () => {
	const ephemeris = linearEphemeris(1e-6, 2e-6, 100)
	const output: EquatorialCoordinate = { rightAscension: 0, declination: 0 }

	expect(ephemeris.position(instant(0), output)).toBe(output)
	expect(output.rightAscension).toBe(0)
	expect(output.declination).toBe(0)
	expect(() => ephemeris.position(instant(-1), output)).toThrow(NonSiderealError)
	expect(() => ephemeris.position(instant(101), output)).toThrow('outside the inclusive interpolation window')
})

test('computes wrap-safe east/north tangent offsets with finite pole behavior', () => {
	const wrapped = nonSiderealAngularOffset({ rightAscension: TAU - 0.001, declination: 0 }, { rightAscension: 0.001, declination: 0 })
	expect(wrapped.east).toBeCloseTo(0.002, 12)
	expect(wrapped.north).toBeCloseTo(0, 12)

	const nearPole = nonSiderealAngularOffset({ rightAscension: 1, declination: PI / 2 - 1e-8 }, { rightAscension: 1.2, declination: PI / 2 - 2e-8 })
	expect(Number.isFinite(nearPole.east)).toBeTrue()
	expect(Number.isFinite(nearPole.north)).toBeTrue()
	expect(() => nonSiderealAngularOffset({ rightAscension: 0, declination: 0 }, { rightAscension: PI, declination: 0 })).toThrow(NonSiderealError)
})

test('converts arcsec per pixel with explicit calibration orientation', () => {
	const transform = calibratedNonSiderealTransform({
		pixelScaleArcsecPerPixel: 1,
		calibration: { ra: { unitX: 1, unitY: 0 }, dec: { unitX: 0, unitY: 1 } },
	})

	expect(transform.offsetToImage([ASEC2RAD, -ASEC2RAD], instant(0), { width: 10, height: 10, timestamp: 1, frameId: 1 })).toEqual([1, -1])
})

describe('finite-difference derivatives', () => {
	test('uses a centered five-point stencil for a smooth local trajectory', () => {
		const eastRate = 1.2e-6
		const northRate = -0.8e-6
		const ephemeris = linearEphemeris(eastRate, northRate)
		const derivative = estimateNonSiderealDerivative(ephemeris, instant(1200), { stepSeconds: 30 })

		expect(derivative.available).toBeTrue()
		expect(derivative.oneSided).toBeFalse()
		expect(derivative.rate?.[0]).toBeCloseTo(eastRate, 10)
		expect(derivative.rate?.[1]).toBeCloseTo(northRate, 10)
		expect(derivative.acceleration?.[0]).toBeCloseTo(0, 12)
		expect(derivative.acceleration?.[1]).toBeCloseTo(0, 12)
	})

	test('falls back to a one-sided stencil at a validity boundary', () => {
		const derivative = estimateNonSiderealDerivative(linearEphemeris(1e-6, 0, 2400), instant(0), { stepSeconds: 30 })

		expect(derivative.available).toBeTrue()
		expect(derivative.oneSided).toBeTrue()
		expect(derivative.rate?.[0]).toBeCloseTo(1e-6, 10)
	})

	test('reports unavailable rate when no stencil fits', () => {
		const source: NonSiderealEphemeris = {
			validTime: [J0, J0 + 30 / DAYSEC],
			position: (_time, out) => {
				out.rightAscension = 0
				out.declination = 0
				return out
			},
		}
		const derivative = estimateNonSiderealDerivative(source, instant(0), { stepSeconds: 30 })

		expect(derivative.available).toBeFalse()
		expect(derivative.reason).toBe('rateUnavailable')
	})
})

describe('NonSiderealTracker decorator', () => {
	test('does not call the ephemeris before a visual lock and preserves base fields', () => {
		let providerCalls = 0
		const result = baseResult()
		const base = baseStub(result)
		const tracker = new NonSiderealTracker(base)
		tracker.arm(
			{
				position: (_time, out) => {
					providerCalls++
					out.rightAscension = 0
					out.declination = 0
					return out
				},
			},
			{ offsetToImage: () => [0, 0] },
		)

		const calibrationResult = tracker.track(trackerFrame(0), { ...guideContext(false), phase: 'calibrating' })
		const acquisitionResult = tracker.track(trackerFrame(1), guideContext(false))

		expect(providerCalls).toBe(0)
		expect(starTrackingOf(calibrationResult)?.detections).toBe(result.detections)
		expect(acquisitionResult.targetOffset).toEqual([3, 4])
		expect(baseTrackerOf(tracker)).toBe(base)
		expect(starTrackingOf(acquisitionResult)?.accepted).toBe(result.accepted)
	})

	test('anchors once, adds the base offset, and delegates commit', () => {
		let commits = 0
		let providerCalls = 0
		const base: GuideTracker = {
			reset: () => undefined,
			track: () => baseResult(),
			commit: () => {
				commits++
			},
		}
		const tracker = new NonSiderealTracker(base)
		tracker.arm(
			{
				position: (captureTime, out) => {
					providerCalls++
					const seconds = (toJulianDay(captureTime) - J0) * DAYSEC
					out.rightAscension = seconds * 1e-6
					out.declination = -seconds * 2e-6
					return out
				},
			},
			{ offsetToImage: ([east, north]) => [east * 1e6, north * 1e6] },
		)

		const anchor = tracker.track(trackerFrame(0), guideContext(true))
		const moved = tracker.track(trackerFrame(60), guideContext(true))
		tracker.commit()

		expect(anchor.nonSidereal.state).toBe('active')
		expect(anchor.targetOffset).toEqual([3, 4])
		expect(moved.targetOffset?.[0]).toBeCloseTo(63, 4)
		expect(moved.targetOffset?.[1]).toBeCloseTo(-116, 4)
		expect(moved.nonSidereal.angularOffset?.[0]).toBeCloseTo(60e-6, 10)
		expect(providerCalls).toBeGreaterThan(2)
		expect(commits).toBe(1)
	})

	test('fails closed on a duplicate frame and requires an explicit reset', () => {
		let providerCalls = 0
		const tracker = new NonSiderealTracker(baseStub(baseResult()))
		tracker.arm(
			{
				position: (_time, out) => {
					providerCalls++
					out.rightAscension = 0
					out.declination = 0
					return out
				},
			},
			{ offsetToImage: () => [0, 0] },
		)

		tracker.track(trackerFrame(0), guideContext(true))
		const duplicate = tracker.track(trackerFrame(0), guideContext(true))
		const blocked = tracker.track(trackerFrame(60), guideContext(true))

		expect(duplicate.nonSidereal.reason).toBe('outOfOrder')
		expect(duplicate.measurement).toBeUndefined()
		expect(duplicate.targetOffset).toBeUndefined()
		expect(blocked.nonSidereal.state).toBe('faulted')
		expect(providerCalls).toBe(1)

		tracker.reset()
		const recovered = tracker.track(trackerFrame(120), guideContext(true))
		expect(recovered.nonSidereal.state).toBe('active')
		expect(providerCalls).toBe(2)
	})

	test('keeps an absolute offset when the derivative is unavailable', () => {
		const source: NonSiderealEphemeris = {
			validTime: [J0, J0 + 30 / DAYSEC],
			position: (captureTime, out) => {
				out.rightAscension = (toJulianDay(captureTime) - J0) * DAYSEC * 1e-6
				out.declination = 0
				return out
			},
		}
		const tracker = new NonSiderealTracker(baseStub(baseResult([0, 0])))
		tracker.arm(source, { offsetToImage: ([east, north]) => [east * 1e6, north * 1e6] })
		tracker.track(trackerFrame(0), guideContext(true))
		const result = tracker.track(trackerFrame(30), guideContext(true))

		expect(result.nonSidereal.state).toBe('rateDegraded')
		expect(result.nonSidereal.reason).toBe('rateUnavailable')
		expect(result.targetOffset?.[0]).toBeCloseTo(30, 4)
	})

	test('converts provider and transform failures into safe results', () => {
		const tracker = new NonSiderealTracker(baseStub(baseResult()))
		tracker.arm(
			{
				position: () => {
					throw new Error('provider unavailable')
				},
			},
			{ offsetToImage: () => [0, 0] },
		)

		const result = tracker.track(trackerFrame(0), guideContext(true))

		expect(result.nonSidereal.state).toBe('faulted')
		expect(result.nonSidereal.reason).toBe('providerError')
		expect(result.measurement).toBeUndefined()
		expect(result.targetOffset).toBeUndefined()
	})
})
