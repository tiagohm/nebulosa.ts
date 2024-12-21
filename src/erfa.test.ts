import { expect, test } from 'bun:test'
import { kilometer } from './distance'
import { eraCalToJd, eraDat, eraDtDb, eraJdToCal, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'

test('eraTaiUt1', () => {
	const [a, b] = eraTaiUt1(2453750.5, 0.892482639, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045614537037037, 12)
})

test('eraTaiUtc', () => {
	const [a, b] = eraTaiUtc(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006945555555556, 12)
})

test('eraUtcTai', () => {
	const [a, b] = eraUtcTai(2453750.5, 0.892100694)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826384444444444, 12)
})

test('eraUtcUt1', () => {
	const [a, b] = eraUtcUt1(2453750.5, 0.892100694, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045608981481481, 12)
})

test('eraUt1Utc', () => {
	const [a, b] = eraUt1Utc(2453750.5, 0.892104561, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006941018518519, 12)
})

test('eraTaiTt', () => {
	const [a, b] = eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTai', () => {
	const [a, b] = eraTtTai(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892110139, 12)
})

test('eraTaiTt', () => {
	const [a, b] = eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTdb', () => {
	const [a, b] = eraTtTdb(2453750.5, 0.892855139, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551366736111111, 12)
})

test('eraTdbTt', () => {
	const [a, b] = eraTdbTt(2453750.5, 0.892855137, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551393263888889, 12)
})

test('eraTcbTdb', () => {
	const [a, b] = eraTcbTdb(2453750.5, 0.893019599)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551362746343397, 12)
})

test('eraTcgTt', () => {
	const [a, b] = eraTcgTt(2453750.5, 0.892862531)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551387488816828, 12)
})

test('eraTdbTcb', () => {
	const [a, b] = eraTdbTcb(2453750.5, 0.892855137)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8930195997253656716, 12)
})

test('eraTtTcg', () => {
	const [a, b] = eraTtTcg(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924900312508587113, 12)
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

test('eraDtDb', () => {
	expect(eraDtDb(2448939.5, 0.123, 0.76543, 5.0123, kilometer(5525.242), kilometer(3190))).toBeCloseTo(-0.1280368005936998991e-2, 15)
})
