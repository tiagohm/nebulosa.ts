import { expect, test } from 'bun:test'
import { arcsec } from './angle'
import { iersa, iersb } from './iers'
import { Timescale, timeYMDHMS } from './time'

test('iersA', async () => {
	await iersa.load(await Bun.file('data/finals2000A.txt').arrayBuffer())
	const t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersa.delta(t)).toBe(-0.17181135242592593)
	expect(iersa.xy(t)).toEqual([arcsec(0.1878143362962963), arcsec(0.3180433324074074)])
})

test('iersB', async () => {
	await iersb.load(await Bun.file('data/eopc04.1962-now.txt').arrayBuffer())
	const t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expect(iersb.delta(t)).toBe(-0.17180533112962962)
	expect(iersb.xy(t)).toEqual([arcsec(0.1878133848148148), arcsec(0.3179746625925926)])
})
