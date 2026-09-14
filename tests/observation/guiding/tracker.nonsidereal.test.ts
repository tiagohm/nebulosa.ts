import { describe, expect, test } from 'bun:test'
import type { EquatorialCoordinate } from '../../../src/astronomy/coordinates/coordinate'
import { linearInterpolator, type EphemerisPoint } from '../../../src/astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, time, toJulianDay } from '../../../src/astronomy/time/time'
import { ASEC2RAD, DAYSEC, PI, TAU } from '../../../src/core/constants'
import { Guider } from '../../../src/observation/guiding/guider'
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
		calibration: { rightAscension: { unitX: 1, unitY: 0 }, declination: { unitX: 0, unitY: 1 } },
	})

	expect(transform.offsetToImage([ASEC2RAD, -ASEC2RAD], instant(0), { width: 10, height: 10, timestamp: 1, frameId: 1 })).toEqual([1, -1])
})

test.each([1e-11, -1e-11, 1e-14])('computes tiny same-direction offsets of %s radians', (angle) => {
	const anchor = { rightAscension: 0, declination: 0 }
	const east = nonSiderealAngularOffset(anchor, { rightAscension: angle, declination: 0 })
	const north = nonSiderealAngularOffset(anchor, { rightAscension: 0, declination: angle })
	expect(east.east).toBeCloseTo(angle, 20)
	expect(east.north).toBe(0)
	expect(east.separation).toBeCloseTo(Math.abs(angle), 20)
	expect(north.east).toBe(0)
	expect(north.north).toBeCloseTo(angle, 20)
	expect(north.separation).toBeCloseTo(Math.abs(angle), 20)
	expect(nonSiderealAngularOffset(anchor, anchor)).toEqual({ east: 0, north: 0, separation: 0 })
	expect(() => nonSiderealAngularOffset(anchor, { rightAscension: PI - 1e-8, declination: 0 }, { maxAngularSeparation: PI - 1e-9, antipodalTolerance: 1e-7 })).toThrow('no unique tangent direction')
})

describe('finite-difference derivatives', () => {
	test('uses a centered five-point stencil for a smooth local trajectory', () => {
		const eastRate = 1.2e-6
		const northRate = -0.8e-6
		const ephemeris = linearEphemeris(eastRate, northRate)
		const derivative = estimateNonSiderealDerivative(ephemeris, instant(1200), { step: 30 })

		expect(derivative.available).toBeTrue()
		expect(derivative.oneSided).toBeFalse()
		expect(derivative.rate?.[0]).toBeCloseTo(eastRate, 10)
		expect(derivative.rate?.[1]).toBeCloseTo(northRate, 10)
		expect(derivative.acceleration?.[0]).toBeCloseTo(0, 12)
		expect(derivative.acceleration?.[1]).toBeCloseTo(0, 12)
	})

	test('falls back to a one-sided stencil at a validity boundary', () => {
		const derivative = estimateNonSiderealDerivative(linearEphemeris(1e-6, 0, 2400), instant(0), { step: 30 })

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
		const derivative = estimateNonSiderealDerivative(source, instant(0), { step: 30 })

		expect(derivative.available).toBeFalse()
		expect(derivative.reason).toBe('rateUnavailable')
	})
})

describe('NonSiderealTracker decorator', () => {
	test('keeps a tiny trajectory active near its anchor with an available derivative', () => {
		const tracker = new NonSiderealTracker(baseStub(baseResult([0, 0])))
		tracker.arm(linearEphemeris(1e-13, 0), { offsetToImage: ([east, north]) => [east * 1e6, north * 1e6] })
		tracker.track(trackerFrame(0), guideContext(true))
		const result = tracker.track(trackerFrame(100), guideContext(true))
		expect(result.nonSidereal.state).toBe('active')
		expect(result.measurement).toBeDefined()
		expect(result.targetOffset?.[0]).toBeCloseTo(1e-5, 10)
		expect(result.nonSidereal.rate?.[0]).toBeCloseTo(1e-13, 18)
	})

	test.each(['calibration', 'provider', 'limit'] as const)('suppresses controller pulses through lost lock after a %s fault', (failure) => {
		const guider = new Guider({ lockAveragingFrames: 1, lostStarFrameCount: 1 })
		const measurement = { x: 10, y: 20, confidence: 1 }
		const result = { ...baseResult([0, 0]), measurement }
		const tracker = new NonSiderealTracker(baseStub(result), { geometry: { maxAngularSeparation: 0.001 } })
		let providerFailed = false
		let limitExceeded = false
		tracker.arm(
			{
				position: (_time, out) => {
					if (providerFailed) throw new Error('provider unavailable')
					out.rightAscension = limitExceeded ? 0.002 : 0
					out.declination = 0
					return out
				},
			},
			{ offsetToImage: () => [0, 0] },
		)
		const process = (seconds: number) => {
			const state = guider.currentState.state
			const frame = trackerFrame(seconds)
			const tracking = tracker.track(frame, { ...guideContext(state === 'guiding'), phase: state === 'lost' ? 'lostLock' : 'guiding' })
			return guider.processFrame({ ...frame, tracking })
		}
		expect(process(0).state).toBe('guiding')
		process(1)
		measurement.x += 1
		if (failure === 'calibration') tracker.onCalibrationChanged()
		if (failure === 'provider') providerFailed = true
		if (failure === 'limit') limitExceeded = true
		for (const seconds of [2, 3, 4]) {
			const command = process(seconds)
			expect(command.state).toBe('lost')
			expect(command.ra.duration).toBe(0)
			expect(command.dec.duration).toBe(0)
			expect(command.tracking.measurement).toBeUndefined()
		}
		providerFailed = false
		if (failure === 'calibration') tracker.onCalibrationChanged({ offsetToImage: () => [0, 0] })
		tracker.reanchor(instant(5))
		expect(process(6).state).toBe('guiding')
	})

	test.each(['reset', 'reanchor'] as const)('preserves calibration invalidation after %s until a replacement is supplied', (transition) => {
		let staleTransformCalls = 0
		const tracker = new NonSiderealTracker(baseStub(baseResult([0, 0])))
		tracker.arm(linearEphemeris(1e-6, 0), {
			offsetToImage: ([east, north]) => {
				staleTransformCalls++
				return [east * 1e6, north * 1e6]
			},
		})
		tracker.track(trackerFrame(0), guideContext(true))
		tracker.onCalibrationChanged()
		if (transition === 'reset') tracker.reset()
		else tracker.reanchor(instant(10))
		expect(tracker.state).toBe('faulted')
		for (const context of [guideContext(false), guideContext(true), { ...guideContext(false), phase: 'lostLock' as const }]) {
			const blocked = tracker.track(trackerFrame(20), context)
			expect(blocked.measurement).toBeUndefined()
			expect(blocked.targetOffset).toBeUndefined()
			expect(blocked.nonSidereal.reason).toBe('invalidTransform')
		}
		expect(staleTransformCalls).toBe(0)
		tracker.onCalibrationChanged({ offsetToImage: ([east, north]) => [-east * 1e6, north * 1e6] })
		tracker.track(trackerFrame(30), guideContext(true))
		const recovered = tracker.track(trackerFrame(40), guideContext(true))
		expect(recovered.nonSidereal.state).toBe('active')
		expect(recovered.measurement).toBeDefined()
		expect(recovered.targetOffset?.[0]).toBeCloseTo(transition === 'reset' ? -10 : -30, 4)
		expect(staleTransformCalls).toBe(0)
	})

	test('retains the celestial anchor and offset while reacquiring a lost lock', () => {
		const tracker = new NonSiderealTracker(baseStub(baseResult([0, 0])))
		tracker.arm(linearEphemeris(1e-6, 0), { offsetToImage: ([east, north]) => [east * 1e6, north * 1e6] })
		tracker.track(trackerFrame(0), guideContext(true))
		const recovered = tracker.track(trackerFrame(10), { ...guideContext(false), phase: 'lostLock' })
		expect(recovered.nonSidereal.state).toBe('active')
		expect(recovered.targetOffset?.[0]).toBeCloseTo(10, 4)
		const guiding = tracker.track(trackerFrame(20), guideContext(true))
		expect(guiding.targetOffset?.[0]).toBeCloseTo(20, 4)
	})

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

	test('fails closed when calibration changes without a replacement transform', () => {
		const tracker = new NonSiderealTracker(baseStub(baseResult([0, 0])))
		tracker.arm(
			{
				position: (captureTime, out) => {
					out.rightAscension = (toJulianDay(captureTime) - J0) * DAYSEC * 1e-6
					out.declination = 0
					return out
				},
			},
			{ offsetToImage: ([east, north]) => [east * 1e6, north * 1e6] },
		)

		const anchor = tracker.track(trackerFrame(0), guideContext(true))
		expect(anchor.nonSidereal.state).toBe('active')

		tracker.onCalibrationChanged()
		expect(tracker.state).toBe('faulted')

		const blocked = tracker.track(trackerFrame(60), guideContext(true))
		expect(blocked.nonSidereal.reason).toBe('invalidTransform')
		expect(blocked.targetOffset).toBeUndefined()

		tracker.onCalibrationChanged({ offsetToImage: ([east, north]) => [-east * 1e6, north * 1e6] })
		const recovered = tracker.track(trackerFrame(120), guideContext(true))
		expect(recovered.nonSidereal.state).toBe('active')
		expect(recovered.targetOffset?.[0]).toBeCloseTo(-120, 4)
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
