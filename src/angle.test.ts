import { expect, test } from 'bun:test'
import { arcmin, arcsec, deg, dms, hms, hour, mas, normalize, toArcmin, toArcsec, toDeg, toDms, toHms, toHour, toMas } from './angle'
import { PI, TAU } from './constants'

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
	expect(toDms(deg(45.21561666666666666666666666666667))).toEqual([45, 12, 56.220000000009236])
	expect(toDms(-deg(45.21561666666666666666666666666667))).toEqual([-45, 12, 56.220000000009236])
})

test('toHms', () => {
	expect(toHms(hour(23.73395))).toEqual([23, 44, 2.2199999999875786])
	expect(toHms(-hour(23.73395))).toEqual([0, 15, 57.780000000004854])
})
