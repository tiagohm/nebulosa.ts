import { expect, test } from 'bun:test'
import { eraCalToJd, eraDat, eraJdToCal, eraSp00, eraTaiUt1, eraTaiUtc, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'

test('eraTaiUt1', () => {
	const [u1, u2] = eraTaiUt1(2453750.5, 0.892482639, -32.6659)
	expect(u1).toBe(2453750.5)
	expect(u2).toBeCloseTo(0.8921045614537037037, 12)
})

test('eraTaiUtc', () => {
	const [u1, u2] = eraTaiUtc(2453750.5, 0.892482639)
	expect(u1).toBe(2453750.5)
	expect(u2).toBeCloseTo(0.8921006945555555556, 12)
})

test('eraUtcTai', () => {
	const [u1, u2] = eraUtcTai(2453750.5, 0.892100694)
	expect(u1).toBe(2453750.5)
	expect(u2).toBeCloseTo(0.8924826384444444444, 12)
})

test('eraUtcUt1', () => {
	const [u1, u2] = eraUtcUt1(2453750.5, 0.892100694, 0.3341)
	expect(u1).toBe(2453750.5)
	expect(u2).toBeCloseTo(0.8921045608981481481, 12)
})

test('eraUt1Utc', () => {
	const [u1, u2] = eraUt1Utc(2453750.5, 0.892104561, 0.3341)
	expect(u1).toBe(2453750.5)
	expect(u2).toBeCloseTo(0.8921006941018518519, 12)
})

test('eraDat', () => {
	expect(eraDat(2003, 6, 1, 0.0)).toBe(32.0)
	expect(eraDat(2008, 1, 17, 0.0)).toBe(33.0)
	expect(eraDat(2017, 9, 1, 0.0)).toBe(37.0)
})

test('eraCalToJd', () => {
	expect(eraCalToJd(2003, 6, 1)).toBe(52791.0)
})

test('eraJdToCal', () => {
	const [y, m, d, f] = eraJdToCal(2400000.5, 50123.9999)
	expect(y).toBe(1996)
	expect(m).toBe(2)
	expect(d).toBe(10)
	expect(f).toBeCloseTo(0.9999, 7)
})

test('eraSp00', () => {
	expect(eraSp00(2400000.5, 52541.0)).toBeCloseTo(-0.6216698469981019309e-11, 12)
})
