import { describe, expect, test } from 'bun:test'
import { arcmin, arcsec, deg, dms, formatAngle, formatDMS, formatHMS, formatSignedDMS, hms, hour, mas, normalize, parseAngle, toArcmin, toArcsec, toDeg, toDms, toHms, toHour, toMas, type FormatAngleOptions } from './angle'
import { PI, PIOVERTWO, TAU } from './constants'

test('normalize', () => {
	expect(normalize(0)).toBeCloseTo(0, 16)
	expect(normalize(0.5)).toBeCloseTo(0.5, 16)
	expect(normalize(PI)).toBeCloseTo(PI, 16)
	expect(normalize(TAU)).toBeCloseTo(0, 16)
	expect(normalize(TAU + PI)).toBeCloseTo(PI, 16)
	expect(normalize(-0.5)).toBeCloseTo(TAU - 0.5, 16)
	expect(normalize(-PI)).toBeCloseTo(PI, 16)
	expect(normalize(-TAU)).toBeCloseTo(0, 16)
	expect(normalize(-TAU - PI)).toBeCloseTo(PI, 16)
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
})

test('hms', () => {
	expect(hms(23, 44, 2.22)).toBeCloseTo(hour(23.73395), 16)
	expect(hms(-23, 44, 2.22)).toBeCloseTo(hour(-23.73395), 16)
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
		expect(parseAngle('abc', { defaultValue: PI })).toBeCloseTo(PI, 18)
	})

	test('numeric hour', () => {
		expect(parseAngle('90')).toBeCloseTo(PIOVERTWO, 18)
		expect(parseAngle('-90d')).toBeCloseTo(-PIOVERTWO, 18)
		expect(parseAngle('23.5634453')).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle('12°', { isHour: true })).toBeCloseTo(PI, 18)
		expect(parseAngle('-12', { isHour: true })).toBeCloseTo(-PI, 18)
		expect(parseAngle('23.5634453', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
	})

	test('numeric min', () => {
		expect(parseAngle('12m')).toBeCloseTo(arcmin(12), 18)
		expect(parseAngle("-12'")).toBeCloseTo(-arcmin(12), 18)
		expect(parseAngle('23.5634453m')).toBeCloseTo(arcmin(23.5634453), 18)
		expect(parseAngle("-23.5634453'")).toBeCloseTo(arcmin(-23.5634453), 18)
		expect(parseAngle('12m', { isHour: true })).toBeCloseTo(arcmin(12) * 15, 18)
		expect(parseAngle("-12'", { isHour: true })).toBeCloseTo(-arcmin(12) * 15, 18)
		expect(parseAngle('23.5634453m', { isHour: true })).toBeCloseTo(arcmin(23.5634453) * 15, 16)
		expect(parseAngle("-23.5634453'", { isHour: true })).toBeCloseTo(arcmin(-23.5634453) * 15, 16)
	})

	test('numeric sec', () => {
		expect(parseAngle('12s')).toBeCloseTo(arcsec(12), 18)
		expect(parseAngle('-12"')).toBeCloseTo(-arcsec(12), 18)
		expect(parseAngle('23.5634453s')).toBeCloseTo(arcsec(23.5634453), 18)
		expect(parseAngle('-23.5634453"')).toBeCloseTo(arcsec(-23.5634453), 18)
		expect(parseAngle('12s', { isHour: true })).toBeCloseTo(arcsec(12) * 15, 18)
		expect(parseAngle('-12"', { isHour: true })).toBeCloseTo(-arcsec(12) * 15, 18)
		expect(parseAngle('23.5634453s', { isHour: true })).toBeCloseTo(arcsec(23.5634453) * 15, 16)
		expect(parseAngle('-23.5634453"', { isHour: true })).toBeCloseTo(arcsec(-23.5634453) * 15, 16)
	})

	test('number', () => {
		expect(parseAngle(90)).toBeCloseTo(PIOVERTWO, 18)
		expect(parseAngle(-90)).toBeCloseTo(-PIOVERTWO, 18)
		expect(parseAngle(12, { isHour: true })).toBeCloseTo(PI, 18)
		expect(parseAngle(-12, { isHour: true })).toBeCloseTo(-PI, 18)
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

	test('hour, minute and second', () => {
		expect(parseAngle('23h 33m 48.40308s')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33m 48.40308s', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23h 33 48.40308s')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23h 33m 48.40308')).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33 48.40308s', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23 33 48.40308', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
	})

	test('negative hour, minute and second', () => {
		expect(parseAngle('-23h 33m 48.40308s')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33m 48.40308s', { isHour: true })).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23h 33 48.40308s')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23h 33m 48.40308')).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308s', { isHour: true })).toBeCloseTo(hour(-23.5634453), 18)
		expect(parseAngle('-23 33 48.40308', { isHour: true })).toBeCloseTo(hour(-23.5634453), 18)
	})

	test('hour and minute', () => {
		expect(parseAngle('23h 33m')).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle('23 33m', { isHour: true })).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle("23 33'", { isHour: true })).toBeCloseTo(hour(23.55), 18)
		expect(parseAngle('23 33', { isHour: true })).toBeCloseTo(hour(23.55), 18)
	})

	test('negative hour and minute', () => {
		expect(parseAngle('-23h 33m')).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle('-23 33m', { isHour: true })).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle("-23 33'", { isHour: true })).toBeCloseTo(hour(-23.55), 18)
		expect(parseAngle('-23 33', { isHour: true })).toBeCloseTo(hour(-23.55), 18)
	})

	test('hour and second', () => {
		expect(parseAngle('23h 48.40308s')).toBeCloseTo(hour(23.0134453), 18)
		expect(parseAngle('23 48.40308s', { isHour: true })).toBeCloseTo(hour(23.0134453), 18)
		expect(parseAngle('23 48.40308"', { isHour: true })).toBeCloseTo(hour(23.0134453), 18)
	})

	test('negative hour and second', () => {
		expect(parseAngle('-23h 48.40308s')).toBeCloseTo(hour(-23.0134453), 18)
		expect(parseAngle('-23 48.40308s', { isHour: true })).toBeCloseTo(hour(-23.0134453), 18)
		expect(parseAngle('-23 48.40308"', { isHour: true })).toBeCloseTo(hour(-23.0134453), 18)
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
		expect(parseAngle('23 33 48.40308', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
		expect(parseAngle('23:33:48.40308', { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
	})

	test('formatAngle', () => {
		expect(parseAngle(formatAngle(deg(23.5634453), { fractionDigits: 5 }))).toBeCloseTo(deg(23.5634453), 18)
		expect(parseAngle(formatAngle(hour(23.5634453), { isHour: true, fractionDigits: 5 }), { isHour: true })).toBeCloseTo(hour(23.5634453), 18)
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
		expect(formatAngle(deg(23.5634453), options)).toBe('+23 33')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23 33')
	})

	test('isHourAndNoSecond', () => {
		const options: FormatAngleOptions = { isHour: true, noSecond: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('+23 33')
		expect(formatAngle(hour(-23.5634453), options)).toBe('+00 26')
	})

	test('hourAndNoSignAndNoSecond', () => {
		const options: FormatAngleOptions = { isHour: true, noSign: true, noSecond: true }
		expect(formatAngle(hour(23.5634453), options)).toBe('23 33')
		expect(formatAngle(hour(-23.5634453), options)).toBe('00 26')
	})

	test('fractionDigits', () => {
		const options: FormatAngleOptions = { fractionDigits: 8 }
		expect(formatAngle(deg(23.5634453), options)).toBe('+23 33 48.40308000')
		expect(formatAngle(deg(-23.5634453), options)).toBe('-23 33 48.40308000')
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

test('formatHMS', () => {
	expect(formatHMS(hour(23.5634453))).toBe('23:33:48.40')
	expect(formatHMS(hour(-23.5634453))).toBe('00:26:11.60')
	expect(formatHMS(hour(10))).toBe('10:00:00.00')
	expect(formatHMS(hour(24))).toBe('00:00:00.00')
	expect(formatHMS(hour(25))).toBe('01:00:00.00')
})

test('formatDMS', () => {
	expect(formatDMS(deg(23.5634453))).toBe('23d33m48.40s')
	expect(formatDMS(deg(-23.5634453))).toBe('-23d33m48.40s')
	expect(formatDMS(deg(10))).toBe('10d00m00.00s')
	expect(formatDMS(deg(-10))).toBe('-10d00m00.00s')
})

test('formatSignedDMS', () => {
	expect(formatSignedDMS(deg(23.5634453))).toBe('+23d33m48.40s')
	expect(formatSignedDMS(deg(-23.5634453))).toBe('-23d33m48.40s')
	expect(formatSignedDMS(deg(10))).toBe('+10d00m00.00s')
	expect(formatSignedDMS(deg(-10))).toBe('-10d00m00.00s')
})
