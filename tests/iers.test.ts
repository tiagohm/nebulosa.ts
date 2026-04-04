import { expect, test } from 'bun:test'
import { arcsec } from '../src/angle'
import { IersA, IersAB, IersB, iersa, iersb } from '../src/iers'
import { bufferSource, readableStreamSource } from '../src/io'
import { Timescale, timeMJD, timeYMDHMS } from '../src/time'
import { downloadPerTag } from './download'

await downloadPerTag('iers')

class IersATest extends IersA {
	// Installs a synthetic table for interpolation and source-selection tests.
	set(mjd: number[], pmX: number[], pmY: number[], ut1MinusUtc: number[]) {
		this.setTable(mjd, pmX, pmY, ut1MinusUtc)
	}
}

class IersBTest extends IersB {
	// Installs a synthetic table for interpolation and source-selection tests.
	set(mjd: number[], pmX: number[], pmY: number[], ut1MinusUtc: number[]) {
		this.setTable(mjd, pmX, pmY, ut1MinusUtc)
	}
}

// Builds one fixed-width test record.
function fixedWidthLine(width: number, fields: readonly (readonly [number, number, string])[]) {
	const chars = Array.from({ length: width }, () => ' ')

	for (const [start, end, value] of fields) {
		const text = value.padStart(end - start)
		for (let i = 0; i < text.length; i++) chars[start + i] = text[i]
	}

	return chars.join('')
}

// Compares polar motion pairs with a tight floating-point tolerance.
function expectXY(actual: readonly [number, number], x: number, y: number) {
	expect(actual[0]).toBeCloseTo(x, 15)
	expect(actual[1]).toBeCloseTo(y, 15)
}

// Compares DUT1 values with tolerance near double-precision interpolation noise.
function expectDut1(actual: number, expected: number) {
	expect(actual).toBeCloseTo(expected, 14)
}

test('iersA', async () => {
	await using source = readableStreamSource(Bun.file('data/finals2000A.txt').stream())
	await iersa.load(source)
	let t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersa.dut1(t), -0.17181135242592593)
	expectXY(iersa.xy(t), arcsec(0.1878143362962963), arcsec(0.3180433324074074))

	t = timeYMDHMS(2050, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersa.dut1(t), 0.0862207)
	expectXY(iersa.xy(t), arcsec(0.094347), arcsec(0.293316))

	t = timeYMDHMS(1900, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersa.dut1(t), 0.8075)
	expectXY(iersa.xy(t), arcsec(0.143), arcsec(0.137))
})

test('iersB', async () => {
	await using source = readableStreamSource(Bun.file('data/eopc04.1962-now.txt').stream())
	await iersb.load(source)
	let t = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersb.dut1(t), -0.17180533112962962)
	expectXY(iersb.xy(t), arcsec(0.1878133848148148), arcsec(0.3179746625925926))

	t = timeYMDHMS(2050, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersb.dut1(t), 0.0523072)
	expectXY(iersb.xy(t), arcsec(0.202982), arcsec(0.338377))

	t = timeYMDHMS(1900, 10, 7, 12, 34, 56, Timescale.UTC)
	expectDut1(iersb.dut1(t), 0.0326338)
	expectXY(iersb.xy(t), arcsec(-0.0127), arcsec(0.213))
})

test('iers interpolation boundaries', () => {
	const iers = new IersATest()
	iers.set([60000, 60002], [0, 2], [0, 4], [0, 6])

	let t = timeMJD(60000.5, Timescale.UTC)
	expectDut1(iers.dut1(t), 1.5)
	expectXY(iers.xy(t), arcsec(0.5), arcsec(1))

	t = timeMJD(60002.5, Timescale.UTC)
	expectDut1(iers.dut1(t), 6)
	expectXY(iers.xy(t), arcsec(2), arcsec(4))
})

test('iersAB prefers B in range and falls back to A outside B coverage', () => {
	const a = new IersATest()
	const b = new IersBTest()
	a.set([60002, 60003], [2, 2], [3, 3], [4, 4])
	b.set([60000, 60001], [0, 0], [0, 0], [0, 0])

	const iers = new IersAB(a, b)

	let t = timeMJD(60000, Timescale.UTC)
	expectDut1(iers.dut1(t), 0)
	expectXY(iers.xy(t), 0, 0)

	t = timeMJD(60002, Timescale.UTC)
	expectDut1(iers.dut1(t), 4)
	expectXY(iers.xy(t), arcsec(2), arcsec(3))
})

test('iersA load keeps zero-valued finals columns', async () => {
	const rows = [
		fixedWidthLine(188, [
			[7, 15, '60000'],
			[18, 27, '2.0'],
			[37, 46, '3.0'],
			[58, 68, '4.0'],
			[134, 144, '0.0'],
			[144, 154, '0.0'],
			[154, 165, '0.0'],
		]),
		fixedWidthLine(188, [
			[7, 15, '60001'],
			[18, 27, '2.0'],
			[37, 46, '3.0'],
			[58, 68, '4.0'],
			[134, 144, '1.0'],
			[144, 154, '2.0'],
			[154, 165, '3.0'],
		]),
	].join('\n')

	const iers = new IersA()
	await iers.load(bufferSource(Buffer.from(rows)))

	const t = timeMJD(60000.5, Timescale.UTC)
	expectDut1(iers.dut1(t), 1.5)
	expectXY(iers.xy(t), arcsec(0.5), arcsec(1))
})

test('iersB load keeps zero-valued rows', async () => {
	const rows = [
		fixedWidthLine(219, [
			[16, 26, '60000'],
			[26, 38, '0.0'],
			[38, 50, '0.0'],
			[50, 62, '0.0'],
		]),
		fixedWidthLine(219, [
			[16, 26, '60001'],
			[26, 38, '1.0'],
			[38, 50, '2.0'],
			[50, 62, '3.0'],
		]),
	].join('\n')

	const iers = new IersB()
	await iers.load(bufferSource(Buffer.from(rows)))

	const t = timeMJD(60000.5, Timescale.UTC)
	expectDut1(iers.dut1(t), 1.5)
	expectXY(iers.xy(t), arcsec(0.5), arcsec(1))
})
