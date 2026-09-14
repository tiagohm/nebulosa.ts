import { describe, expect, test } from 'bun:test'
import type { EquatorialCoordinate } from '../../../src/astronomy/coordinates/coordinate'
import { linearInterpolator, type EphemerisPoint } from '../../../src/astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, time } from '../../../src/astronomy/time/time'
import { ASEC2RAD, DAYSEC, PI, TAU } from '../../../src/core/constants'
import { nonSiderealAngularOffset, calibratedNonSiderealTransform, estimateNonSiderealDerivative, InterpolatedNonSiderealEphemeris, NonSiderealError, type NonSiderealEphemeris } from '../../../src/observation/guiding/tracker.nonsidereal'

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
