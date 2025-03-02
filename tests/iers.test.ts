import { expect, test } from 'bun:test'
import { arcsec } from '../src/angle'
import { iersa, iersb } from '../src/iers'
import { readableStreamSource } from '../src/io'
import { Timescale, timeYMDHMS } from '../src/time'

test('iersA', async () => {
	await using source = readableStreamSource(Bun.file('data/finals2000A.txt').stream())
	await iersa.load(source)
	let t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersa.delta(t)).toBe(-0.17181135242592593)
	expect(iersa.xy(t)).toEqual([arcsec(0.1878143362962963), arcsec(0.3180433324074074)])

	t = timeYMDHMS(2050, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersa.delta(t)).toBe(0.0862207)
	expect(iersa.xy(t)).toEqual([arcsec(0.094347), arcsec(0.293316)])

	t = timeYMDHMS(1900, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersa.delta(t)).toBe(0.8075)
	expect(iersa.xy(t)).toEqual([arcsec(0.143), arcsec(0.137)])
})

test('iersB', async () => {
	await using source = readableStreamSource(Bun.file('data/eopc04.1962-now.txt').stream())
	await iersb.load(source)
	let t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersb.delta(t)).toBe(-0.17180533112962962)
	expect(iersb.xy(t)).toEqual([arcsec(0.1878133848148148), arcsec(0.3179746625925926)])

	t = timeYMDHMS(2050, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersb.delta(t)).toBe(0.0523072)
	expect(iersb.xy(t)).toEqual([arcsec(0.202982), arcsec(0.338377)])

	t = timeYMDHMS(1900, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersb.delta(t)).toBe(0.0326338)
	expect(iersb.xy(t)).toEqual([arcsec(-0.0127), arcsec(0.213)])
})
