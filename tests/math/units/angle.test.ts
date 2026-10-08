import { describe, expect, test } from 'bun:test'
import { PI, PIOVERTWO, TAU } from '../../../src/core/constants'
// oxfmt-ignore
import { arcmin, arcsec, deg, dms, type FormatAngleOptions, formatALT, formatAngle, formatAZ, formatDEC, formatDMS, formatHMS, formatRA, formatSignedDMS, hms, hour, mas, normalizeAngle, normalizePI, parseAngle, safeAngularDifference, unwrapAngle, unwrapAngles, toArcmin, toArcsec, toDeg, toDms, toHms, toHour, toMas } from '../../../src/math/units/angle'

test('normalize', () => {
	expect(normalizeAngle(0)).toBeCloseTo(0, 16)
	expect(normalizeAngle(0.5)).toBeCloseTo(0.5, 16)
	expect(normalizeAngle(PI)).toBeCloseTo(PI, 16)
	expect(normalizeAngle(TAU)).toBeCloseTo(0, 16)
	expect(normalizeAngle(TAU + PI)).toBeCloseTo(PI, 16)
	expect(normalizeAngle(-0.5)).toBeCloseTo(TAU - 0.5, 16)
	expect(normalizeAngle(-PI)).toBeCloseTo(PI, 16)
	expect(normalizeAngle(-TAU)).toBeCloseTo(0, 16)
	expect(normalizeAngle(-TAU - PI)).toBeCloseTo(PI, 16)
})

test('normalize pi', () => {
	expect(normalizePI(-PI - PIOVERTWO)).toBe(PIOVERTWO)
	expect(normalizePI(-PI)).toBe(PI)
	expect(normalizePI(0)).toBe(0)
	expect(normalizePI(PI)).toBe(PI)
	expect(normalizePI(PI + PIOVERTWO)).toBe(-PIOVERTWO)
})

test('mas', () => {
	expect(mas(37000)).toBeCloseTo(0.00017938106201052831762826821774, 16)
})

test('arcsec', () => {
	expect(arcsec(37)).toBeCloseTo(0.00017938106201052831762826821774, 16)
})

test('arcmin', () => {
	expect(arcmin(45)).toBeCloseTo(0.01308996938995747182692768076345, 16)
})

test('deg', () => {
	expect(deg(6)).toBeCloseTo(0.10471975511965977461542144610932, 16)
})

test('hour', () => {
	expect(hour(4)).toBeCloseTo(1.04719755119659774615421446109317, 15)
})

test('dms', () => {
	expect(dms(45, 12, 56.22)).toBeCloseTo(deg(45.21561666666666666666666666666667), 16)
	expect(dms(-45, 12, 56.22)).toBeCloseTo(deg(-45.21561666666666666666666666666667), 16)
	expect(dms(45, 12, -56.22)).toBeCloseTo(deg(45.21561666666666666666666666666667), 16)
	expect(dms(-45, 12, -56.22)).toBeCloseTo(deg(-45.21561666666666666666666666666667), 16)
	expect(toDeg(dms(-0, 30, 0))).toBeCloseTo(-0.5)
})

test('hms', () => {
	expect(hms(23, 44, 2.22)).toBeCloseTo(hour(23.73395), 16)
	expect(hms(-23, 44, 2.22)).toBeCloseTo(hour(-23.73395), 16)
	expect(hms(23, 44, -2.22)).toBeCloseTo(hour(23.73395), 16)
	expect(hms(-23, 44, -2.22)).toBeCloseTo(hour(-23.73395), 16)
	expect(toHour(hms(-0, 30, 0))).toBeCloseTo(-0.5)
})

test('toMas', () => {
	expect(toMas(0.00017938106201052831762826821774)).toBeCloseTo(37000, 16)
})

test('toArcsec', () => {
	expect(toArcsec(0.00017938106201052831762826821774)).toBeCloseTo(37, 16)
})

test('toArcmin', () => {
	expect(toArcmin(0.01308996938995747182692768076345)).toBeCloseTo(45, 13)
})

test('toDeg', () => {
	expect(toDeg(0.10471975511965977461542144610932)).toBeCloseTo(6, 14)
})

test('toHour', () => {
	expect(toHour(1.04719755119659774615421446109317)).toBeCloseTo(4, 16)
})

test('toDms', () => {
	expect(toDms(deg(45.21561666666666666666666666666667))).toEqual([45, 12, 56.220000000009236, 1])
	expect(toDms(-deg(45.21561666666666666666666666666667))).toEqual([45, 12, 56.220000000009236, -1])
	expect(toDms(deg(0.1))).toEqual([0, 6, 0, 1])
	expect(toDms(-deg(0.1))).toEqual([0, 6, 0, -1])
})

test('toHms', () => {
	expect(toHms(hour(23.73395))).toEqual([23, 44, 2.2199999999875786])
	expect(toHms(-hour(23.73395))).toEqual([0, 15, 57.780000000004854])
})

describe('parseAngle', () => {
	test('undefined', () => {
		expect(parseAngle()).toBeUndefined()
		expect(parseAngle('')).toBeUndefined()
		expect(parseAngle('  ')).toBeUndefined()
		expect(parseAngle('abc')).toBeUndefined()
	})

	test('with default value', () => {
		expect(parseAngle(undefined, { defaultValue: PI })).toBeCloseTo(PI, 18)
		expect(parseAngle('', { defaultValue: PI })).toBeCloseTo(PI, 18)
		expect(parseAngle('  ', { defaultValue: PI })).toBeCloseTo(PI, 18)
		expect(parseAngle('abc', PI)).toBeCloseTo(PI, 18)
	})

	test('numeric hour', () => {
		expect(parseAngle('90')).toBeCloseTo(PIOVERTWO, 18)
		expect(parseAngle('-90d')).toBeCloseTo(-PIOVERTWO, 18)
		expect(parseAngle('23.5634453')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('12h')).toBeCloseTo(PI, 18)
		expect(parseAngle('12°', true)).toBeCloseTo(deg(12), 18)
		expect(parseAngle('-12', true)).toBeCloseTo(-PI, 18)
		expect(parseAngle('23.5634453', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
	})

	test('numeric min', () => {
		expect(parseAngle('12m')).toBeCloseTo(arcmin(12), 18)
		expect(parseAngle("-12'")).toBeCloseTo(-arcmin(12), 18)
		expect(parseAngle('23.5634453m')).toBeCloseTo(arcmin(23.5634453), 18)
		expect(parseAngle("-23.5634453'")).toBeCloseTo(arcmin(-23.5634453), 18)
		expect(parseAngle('12m', true)).toBeCloseTo(arcmin(12) * 15, 18)
		expect(parseAngle("-12'", true)).toBeCloseTo(-arcmin(12) * 15, 18)
		expect(parseAngle('23.5634453m', true)).toBeCloseTo(arcmin(23.5634453) * 15, 16)
		expect(parseAngle("-23.5634453'", true)).toBeCloseTo(arcmin(-23.5634453) * 15, 16)
	})

	test('numeric sec', () => {
		expect(parseAngle('12s')).toBeCloseTo(arcsec(12), 18)
		expect(parseAngle('-12"')).toBeCloseTo(-arcsec(12), 18)
		expect(parseAngle('23.5634453s')).toBeCloseTo(arcsec(23.5634453), 18)
		expect(parseAngle('-23.5634453"')).toBeCloseTo(arcsec(-23.5634453), 18)
		expect(parseAngle('12s', true)).toBeCloseTo(arcsec(12) * 15, 18)
		expect(parseAngle('-12"', true)).toBeCloseTo(-arcsec(12) * 15, 18)
		expect(parseAngle('23.5634453s', true)).toBeCloseTo(arcsec(23.5634453) * 15, 16)
		expect(parseAngle('-23.5634453"', true)).toBeCloseTo(arcsec(-23.5634453) * 15, 16)
	})

	test('number', () => {
		expect(parseAngle(90)).toBeCloseTo(PIOVERTWO, 18)
		expect(parseAngle(-90)).toBeCloseTo(-PIOVERTWO, 18)
		expect(parseAngle(12, true)).toBeCloseTo(PI, 18)
		expect(parseAngle(-12, true)).toBeCloseTo(-PI, 18)
	})

	test('deg, minute and second', () => {
		expect(parseAngle('23d 33m 48.40308s')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23° 33\' 48.40308"')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23 33m 48.40308s')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23d 33 48.40308s')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23d 33m 48.40308')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23 33 48.40308s')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23 33 48.40308')).toBeCloseTo(deg(23.5634453), 18)
	})

	test('negative deg, minute and second', () => {
		expect(parseAngle('-23d 33m 48.40308s')).toBeCloseTo(deg(-23.5634453), 18)
		expect(parseAngle('-23 33m 48.40308s')).toBeCloseTo(deg(-23.5634453), 18)
		expect(parseAngle('-23d 33 48.40308s')).toBeCloseTo(deg(-23.5634453), 18)
		expect(parseAngle('-23d 33m 48.40308')).toBeCloseTo(deg(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308s')).toBeCloseTo(deg(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308')).toBeCloseTo(deg(-23.5634453), 18)
	})

	test('deg and minute', () => {
		expect(parseAngle('23d 33m')).toBeCloseTo(deg(23.55), 18)
		expect(parseAngle('23 33m')).toBeCloseTo(deg(23.55), 18)
		expect(parseAngle("23 33'")).toBeCloseTo(deg(23.55), 18)
		expect(parseAngle('23 33')).toBeCloseTo(deg(23.55), 18)
	})

	test('negative deg and minute', () => {
		expect(parseAngle('-23d 33m')).toBeCloseTo(deg(-23.55), 18)
		expect(parseAngle('-23 33m')).toBeCloseTo(deg(-23.55), 18)
		expect(parseAngle("-23 33'")).toBeCloseTo(deg(-23.55), 18)
		expect(parseAngle('-23 33')).toBeCloseTo(deg(-23.55), 18)
	})

	test('deg and second', () => {
		expect(parseAngle('23d 48.40308s')).toBeCloseTo(deg(23.0134453), 18)
		expect(parseAngle('23 48.40308s')).toBeCloseTo(deg(23.0134453), 18)
		expect(parseAngle('23 48.40308"')).toBeCloseTo(deg(23.0134453), 18)
	})

	test('negative deg and second', () => {
		expect(parseAngle('-23d 48.40308s')).toBeCloseTo(deg(-23.0134453), 18)
		expect(parseAngle('-23 48.40308s')).toBeCloseTo(deg(-23.0134453), 18)
		expect(parseAngle('-23 48.40308"')).toBeCloseTo(deg(-23.0134453), 18)
	})

	test('negative angle with a zero degree/hour field keeps its sign', () => {
		// Regression: the sign came from `parsedField < 0`, but a zero integer field parses to -0 and
		// `-0 < 0` is false, so the sign was dropped and the angle flipped hemisphere (e.g. NASA "-000 38 00").
		expect(parseAngle('-000 38 00')).toBeCloseTo(deg(-(38 / 60)), 18)
		expect(parseAngle('-0 30')).toBeCloseTo(deg(-0.5), 18)
		expect(parseAngle('-00 00 02.1')).toBeCloseTo(arcsec(-2.1), 18)
		expect(parseAngle('-0h 30m')).toBeCloseTo(hour(-0.5), 18)
		expect(parseAngle('-0 0 2.1', true)).toBeCloseTo(arcsec(-2.1) * 15, 18)
		// A positive (or unsigned) zero-degree field stays positive.
		expect(parseAngle('00 38 00')).toBeCloseTo(deg(38 / 60), 18)
		expect(parseAngle('+00 38 00')).toBeCloseTo(deg(38 / 60), 18)
	})

	test('hour, minute and second', () => {
		expect(parseAngle('23h 33m 48.40308s')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33m 48.40308s', true)).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23h 33 48.40308s')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23h 33m 48.40308')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33 48.40308s', true)).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33 48.40308', true)).toBeCloseTo(hour(23.5634453), 18)
	})

	test('negative hour, minute and second', () => {
		expect(parseAngle('-23h 33m 48.40308s')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33m 48.40308s', true)).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23h 33 48.40308s')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23h 33m 48.40308')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308s', true)).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308', true)).toBeCloseTo(hour(-23.5634453), 18)
	})

	test('hour and minute', () => {
		expect(parseAngle('23h 33m')).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle('23 33m', true)).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle("23 33'", true)).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle('23 33', true)).toBeCloseTo(hour(23.55), 18)
	})

	test('negative hour and minute', () => {
		expect(parseAngle('-23h 33m')).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle('-23 33m', true)).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle("-23 33'", true)).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle('-23 33', true)).toBeCloseTo(hour(-23.55), 18)
	})

	test('hour and second', () => {
		expect(parseAngle('23h 48.40308s')).toBeCloseTo(hour(23.0134453), 18)
		expect(parseAngle('23 48.40308s', true)).toBeCloseTo(hour(23.0134453), 18)
		expect(parseAngle('23 48.40308"', true)).toBeCloseTo(hour(23.0134453), 18)
	})

	test('negative hour and second', () => {
		expect(parseAngle('-23h 48.40308s')).toBeCloseTo(hour(-23.0134453), 18)
		expect(parseAngle('-23 48.40308s', true)).toBeCloseTo(hour(-23.0134453), 18)
		expect(parseAngle('-23 48.40308"', true)).toBeCloseTo(hour(-23.0134453), 18)
	})

	test('unicode signs and separators', () => {
		expect(parseAngle('−23h 33′ 48.40308″')).toBeCloseTo(hour(-23.5634453), 18)
	})

	test('seconds overflow', () => {
		expect(parseAngle('23h59m60.0s')).toBeCloseTo(TAU, 18)
	})

	test('separators', () => {
		expect(parseAngle('23 33 48.40308')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23:33:48.40308')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('23 33 48.40308', true)).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23:33:48.40308', true)).toBeCloseTo(hour(23.5634453), 18)
	})

	test('formatAngle', () => {
		expect(parseAngle(formatAngle(deg(23.5634453), { fractionDigits: 5 }))).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle(formatAngle(hour(23.5634453), { isHour: true, fractionDigits: 5 }), true)).toBeCloseTo(hour(23.5634453), 18)
	})

	test('strictness', () => {
		expect(parseAngle('-00 30 00')).toBeCloseTo(dms(-0, 30, 0))
		expect(parseAngle('12h34m56s', { isHour: false })).toBeCloseTo(hms(12, 34, 56))
		expect(parseAngle('12H34M56S', { isHour: false })).toBeCloseTo(hms(12, 34, 56))
		expect(parseAngle('12D', { isHour: true })).toBeCloseTo(deg(12))

		expect(parseAngle('Infinity')).toBeUndefined()
		expect(parseAngle(Infinity)).toBeUndefined()

		expect(parseAngle('abc 12d')).toBeUndefined()
		// expect(parseAngle('12d junk 99')).toBeUndefined()
		// expect(parseAngle('12 -30')).toBeUndefined()
	})
})

describe('formatAngle', () => {
	test('default', () => {
		expect(formatAngle(deg(23.5634453))).toBe('+23 33 48.40')
		expect(formatAngle(deg(-23.5634453))).toBe('-23 33 48.40')
	})

	test('isHour', () => {
		const options: FormatAngleOptions = { isHour: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('+23 33 48.40')
		expect(formatAngle(hour(-23.5634453), options)).toBe('+00 26 11.60')
	})

	test('noSign', () => {
		const options: FormatAngleOptions = { noSign: true }
		expect(formatAngle(deg(23.5634453), options)).toBe('23 33 48.40')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23 33 48.40')
	})

	test('isHourAndNoSign', () => {
		const options: FormatAngleOptions = { isHour: true, noSign: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('23 33 48.40')
		expect(formatAngle(hour(-23.5634453), options)).toBe('00 26 11.60')
	})

	test('noSecond', () => {
		const options: FormatAngleOptions = { noSecond: true }
		expect(formatAngle(deg(23.5634453), options)).toBe('+23 34')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23 34')
		expect(formatAngle(deg(12 + 59 / 60 + 59.6 / 3600), options)).toBe('+13 00')
		expect(formatAngle(deg(-(12 + 59 / 60 + 59.6 / 3600)), options)).toBe('-13 00')
		expect(formatAngle(dms(12, 34, 59.9999), { noSecond: true, noSign: true, separators: ' ' })).toBe('12 35')
		expect(formatAngle(dms(12, 34, 29.999), { noSecond: true, noSign: true, separators: ' ' })).toBe('12 34')
		expect(formatAngle(dms(12, 34, 30), { noSecond: true, noSign: true, separators: ' ' })).toBe('12 35')
		expect(formatRA(hms(23, 59, 59.999))).toBe('00 00 00.00')
	})

	test('isHourAndNoSecond', () => {
		const options: FormatAngleOptions = { isHour: true, noSecond: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('+23 34')
		expect(formatAngle(hour(-23.5634453), options)).toBe('+00 26')
		expect(formatAngle(hour(23 + 59 / 60 + 59.6 / 3600), options)).toBe('+00 00')
	})

	test('hourAndNoSignAndNoSecond', () => {
		const options: FormatAngleOptions = { isHour: true, noSign: true, noSecond: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('23 34')
		expect(formatAngle(hour(-23.5634453), options)).toBe('00 26')
	})

	test('fractionDigits', () => {
		const options: FormatAngleOptions = { fractionDigits: 8 }
		expect(formatAngle(deg(23.5634453), options)).toBe('+23 33 48.40308000')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23 33 48.40308000')
	})

	test('padLength', () => {
		expect(formatAngle(deg(7.5), { padLength: 3, noSign: true })).toBe('007 30 00.00')
		expect(formatAngle(hour(3.25), { isHour: true, padLength: 3, noSign: true })).toBe('003 15 00.00')
	})

	test('ishourAndFractionDigits', () => {
		const options: FormatAngleOptions = { isHour: true, fractionDigits: 8 }
		expect(formatAngle(hour(23.5634453), options)).toBe('+23 33 48.40308000')
		expect(formatAngle(hour(-23.5634453), options)).toBe('+00 26 11.59692000')
	})

	test('separators', () => {
		const options: FormatAngleOptions = { separators: ['a', 'b', 'c'] }
		expect(formatAngle(deg(23.5634453), options)).toBe('+23a33b48.40c')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23a33b48.40c')
	})

	test('isHourAndSeparators', () => {
		const options: FormatAngleOptions = { isHour: true, separators: [':'] }
		expect(formatAngle(hour(23.5634453), options)).toBe('+23:33:48.40')
		expect(formatAngle(hour(-23.5634453), options)).toBe('+00:26:11.60')
	})

	test('plusSign', () => {
		const options: FormatAngleOptions = { plusSign: '*' }
		expect(formatAngle(deg(23.5634453), options)).toBe('*23 33 48.40')
		expect(formatAngle(hour(23.5634453), { ...options, isHour: true })).toBe('*23 33 48.40')
	})

	test('minusSign', () => {
		const options: FormatAngleOptions = { minusSign: '#' }
		expect(formatAngle(deg(-23.5634453), options)).toBe('#23 33 48.40')
	})
})

test('formatHms', () => {
	expect(formatHMS(hour(23.5634453))).toBe('23:33:48.40')
	expect(formatHMS(hour(-23.5634453))).toBe('00:26:11.60')
	expect(formatHMS(hour(10))).toBe('10:00:00.00')
	expect(formatHMS(hour(10), false)).toBe('10:00:00')
	expect(formatHMS(hour(10), 5)).toBe('10:00:00.00000')
	expect(formatHMS(hour(24))).toBe('00:00:00.00')
	expect(formatHMS(hour(25))).toBe('01:00:00.00')
})

test('formatDms', () => {
	expect(formatDMS(deg(23.5634453))).toBe('23d33m48.40s')
	expect(formatDMS(deg(-23.5634453))).toBe('-23d33m48.40s')
	expect(formatDMS(deg(10))).toBe('10d00m00.00s')
	expect(formatDMS(deg(10), false)).toBe('10d00m00s')
	expect(formatDMS(deg(10), 5)).toBe('10d00m00.00000s')
	expect(formatDMS(deg(-10))).toBe('-10d00m00.00s')
})

test('formatSignedDms', () => {
	expect(formatSignedDMS(deg(23.5634453))).toBe('+23d33m48.40s')
	expect(formatSignedDMS(deg(-23.5634453))).toBe('-23d33m48.40s')
	expect(formatSignedDMS(deg(10))).toBe('+10d00m00.00s')
	expect(formatSignedDMS(deg(10), false)).toBe('+10d00m00s')
	expect(formatSignedDMS(deg(10), 5)).toBe('+10d00m00.00000s')
	expect(formatSignedDMS(deg(-10))).toBe('-10d00m00.00s')
})

test('formatRA and formatDEC round-trip through parseAngle', () => {
	const ra = hour(13.123456)
	expect(parseAngle(formatRA(ra), true)).toBeCloseTo(ra, 6)

	const dec = deg(-41.987654)
	expect(parseAngle(formatDEC(dec))).toBeCloseTo(dec, 6)
})

test('formatRA', () => {
	expect(formatRA(hour(23.5634453))).toBe('23 33 48.40')
	expect(formatRA(hour(-23.5634453))).toBe('00 26 11.60')
	expect(formatRA(hour(10))).toBe('10 00 00.00')
	expect(formatRA(hour(24))).toBe('00 00 00.00')
	expect(formatRA(hour(25))).toBe('01 00 00.00')
	expect(formatRA(hour(25), false)).toBe('01 00 00')
	expect(formatRA(hour(25), 5)).toBe('01 00 00.00000')
})

test('formatDEC', () => {
	expect(formatDEC(deg(23.5634453))).toBe('+23 33 48.40')
	expect(formatDEC(deg(-23.5634453))).toBe('-23 33 48.40')
	expect(formatDEC(deg(10))).toBe('+10 00 00.00')
	expect(formatDEC(deg(-10))).toBe('-10 00 00.00')
	expect(formatDEC(deg(-10), false)).toBe('-10 00 00')
	expect(formatDEC(deg(-10), 5)).toBe('-10 00 00.00000')
})

test('formatAZ', () => {
	expect(formatAZ(deg(123.5634453))).toBe('123 33 48.40')
	expect(formatAZ(deg(10))).toBe('010 00 00.00')
	expect(formatAZ(0)).toBe('000 00 00.00')
	expect(formatAZ(-0)).toBe('000 00 00.00')
	expect(formatAZ(deg(10), false)).toBe('010 00 00')
	expect(formatAZ(deg(10), 5)).toBe('010 00 00.00000')
})

test('formatALT', () => {
	expect(formatALT(deg(83.5634453))).toBe('+83 33 48.40')
	expect(formatALT(deg(-83.5634453))).toBe('-83 33 48.40')
	expect(formatALT(deg(10))).toBe('+10 00 00.00')
	expect(formatALT(deg(-10))).toBe('-10 00 00.00')
	expect(formatALT(deg(-10), false)).toBe('-10 00 00')
	expect(formatALT(deg(-10), 5)).toBe('-10 00 00.00000')
})

describe('circular differences and unwrapping', () => {
	test('wraps degrees and uses the positive signed half-turn tie', () => {
		expect(normalizeAngle(deg(361))).toBeCloseTo(deg(1), 14)
		expect(normalizeAngle(deg(-1))).toBeCloseTo(deg(359), 14)
		expect(normalizePI(deg(359))).toBeCloseTo(deg(-1), 14)
		expect(normalizePI(3 * PI)).toBeCloseTo(PI, 14)
		expect(safeAngularDifference(deg(1), deg(359))).toBeCloseTo(deg(2), 14)
		expect(safeAngularDifference(deg(359), deg(1))).toBeCloseTo(deg(-2), 14)
		expect(safeAngularDifference(PI, 0)).toBeCloseTo(PI, 14)
		expect(safeAngularDifference(-PI, 0)).toBeCloseTo(-PI, 14)
	})

	test('retains small differences and characterizes modular rounding', () => {
		const tiny = Number.EPSILON / 4
		expect(safeAngularDifference(tiny, 0)).toBeCloseTo(tiny, 30)
		// The addition of PI in normalizePI rounds increments below half an ulp of PI to zero.
		expect(unwrapAngle(tiny, 0, 0)).toBe(0)
		for (const base of [0, PI, TAU]) {
			for (const step of [-1e-12, 1e-12]) {
				const delta = base + step - base
				expect(Math.abs(safeAngularDifference(base + step, base) - delta)).toBeLessThan(4 * Number.EPSILON)
				expect(Math.abs(unwrapAngle(base + step, base, base) - (base + step))).toBeLessThan(4 * Number.EPSILON)
			}
		}
	})

	test.each([
		[
			[357, 358, 359, 0, 1, 2],
			[357, 358, 359, 360, 361, 362],
		],
		[
			[2, 1, 0, 359, 358],
			[2, 1, 0, -1, -2],
		],
		[
			[359, 0, 1, 0, 359],
			[359, 360, 361, 360, 359],
		],
		[
			[-1, 0, 1],
			[-1, 0, 1],
		],
		[
			[719, 0, 1],
			[719, 720, 721],
		],
	])('reconstructs a continuous track from %j degrees', (degrees, expected) => {
		const input = degrees.map(deg)
		const result = unwrapAngles(input)
		expect(result).toBeInstanceOf(Float64Array)
		expect(input).toEqual(degrees.map(deg))
		const objects = input.map((angle) => ({ angle }))
		let continuous = objects[0].angle
		for (let i = 0; i < result.length; i++) {
			if (i > 0) continuous = unwrapAngle(objects[i].angle, objects[i - 1].angle, continuous)
			expect(result[i]).toBeCloseTo(deg(expected[i]), 13)
			expect(continuous).toBeCloseTo(result[i], 14)
		}
		const array = [...input]
		const typed = new Float64Array(input)
		expect(unwrapAngles(array, array)).toBe(array)
		expect(unwrapAngles(typed, typed)).toBe(typed)
		expect(array).toEqual(Array.from(result))
		expect(typed).toEqual(result)
	})

	test('uses positive half turns in both directions', () => {
		expect(Array.from(unwrapAngles([0, PI]))).toEqual([0, PI])
		expect(Array.from(unwrapAngles([0, -PI]))).toEqual([0, PI])
		expect(unwrapAngle(deg(1), deg(359), deg(359))).toBeCloseTo(deg(361), 14)
		expect(unwrapAngle(deg(359), deg(1), deg(1))).toBeCloseTo(deg(-1), 14)
	})

	test('handles empty/singleton sequences, fresh outputs and a destination tail', () => {
		expect(unwrapAngles([])).toHaveLength(0)
		const input = new Float64Array([-1])
		const fresh = unwrapAngles(input)
		expect(fresh).not.toBe(input)
		fresh[0] = 42
		expect(input[0]).toBe(-1)
		const out = new Float64Array([0, 22, 33])
		expect(unwrapAngles(input, out)).toBe(out)
		expect(Array.from(out)).toEqual([-1, 22, 33])
		expect(unwrapAngles([], out)).toBe(out)
		expect(Array.from(out)).toEqual([-1, 22, 33])
		const array = [0, 22]
		expect(unwrapAngles(input, array)).toBe(array)
		expect(array).toEqual([-1, 22])
	})

	test('rejects truncation and shifted overlaps before mutating storage', () => {
		expect(() => unwrapAngles([0, 1], new Float64Array(1))).toThrow(RangeError)
		expect(() => unwrapAngles([0, 1], [0])).toThrow(RangeError)
		const storage = new Float64Array([6, 0.1, 0.2, 0.3])
		const original = storage.slice()
		expect(() => unwrapAngles(storage.subarray(0, 3), storage.subarray(1))).toThrow(RangeError)
		expect(() => unwrapAngles(storage.subarray(1), storage.subarray(0, 3))).toThrow(RangeError)
		expect(() => unwrapAngles(storage.subarray(2), storage)).toThrow(RangeError)
		expect(storage).toEqual(original)
		expect(unwrapAngles(storage.subarray(2, 2), storage)).toBe(storage)
		const sameStart = storage.subarray(0, 3)
		expect(unwrapAngles(sameStart, storage)).toBe(storage)
		expect(storage[3]).toBe(0.3)
		const disjoint = new Float64Array([6, 0.1, 0, 0])
		unwrapAngles(disjoint.subarray(0, 2), disjoint.subarray(2))
		expect(disjoint[3]).toBeCloseTo(TAU + 0.1, 14)
	})

	test('deterministic wrap invariance and reconstruction over many turns', () => {
		let seed = 0x12345678
		const input = new Float64Array(1000)
		const expected = new Float64Array(1000)
		let continuous = 5
		for (let i = 0; i < input.length; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			// Positive steps in [0.05, 0.55] radians, safely below the ambiguous half turn.
			if (i > 0) continuous += 0.05 + (seed / 2 ** 32) * 0.5
			expected[i] = continuous
			input[i] = normalizeAngle(continuous)
			for (const turns of [-7, -1, 1, 7]) {
				expect(normalizeAngle(input[i] + turns * TAU)).toBeCloseTo(input[i], 13)
			}
		}
		const result = unwrapAngles(input)
		for (let i = 0; i < input.length; i++) {
			expect(result[i]).toBeCloseTo(expected[i], 11)
			expect(Math.abs(safeAngularDifference(result[i], input[i]))).toBeLessThan(1e-11)
		}
		expect(unwrapAngles(input, input)).toEqual(result)
	})
})
