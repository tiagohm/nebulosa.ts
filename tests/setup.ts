import fs from 'fs/promises'
import { eraNut06a, eraPmat06, eraPnm06a } from '../src/astronomy/coordinates/erfa/erfa'
import { iersb } from '../src/astronomy/time/iers'
import { TIME_PROVIDERS, toJulianEpoch } from '../src/astronomy/time/time'
import { fileHandleSource } from '../src/io/io'
import type { MutMat3 } from '../src/math/linear-algebra/mat3'
import type { Angle } from '../src/math/units/angle'
import { download } from './download'

Bun.dns.prefetch('github.com')

// IERS

try {
	await download('eopc04.1962-now.txt')

	try {
		await fs.access('data/eopc04.1962-now.txt')
		const handle = await fs.open('data/eopc04.1962-now.txt')
		await using source = fileHandleSource(handle)
		source.seek(4640029)
		await iersb.load(source)
	} catch (e) {
		console.error('failed to load eopc04.1962-now.txt', e)
	}
} catch (e) {
	console.error('failed to download eopc04.1962-now.txt', e)
}

// Speed up Time by caching some expensive ERFA calls.
// The cache is keyed by the rounded Julian epoch, which is the same for all times in a given year.

const PNM_CACHE = new Map<number, MutMat3>()
const PMAT_CACHE = new Map<number, MutMat3>()
const NUT_CACHE = new Map<number, [Angle, Angle]>()

TIME_PROVIDERS.pnm = (time) => PNM_CACHE.getOrInsertComputed(Math.round(toJulianEpoch(time)), () => eraPnm06a(time.day, time.fraction))
TIME_PROVIDERS.pmat = (time) => PMAT_CACHE.getOrInsertComputed(Math.round(toJulianEpoch(time)), () => eraPmat06(time.day, time.fraction))
TIME_PROVIDERS.nut = (time) => NUT_CACHE.getOrInsertComputed(Math.round(toJulianEpoch(time)), () => eraNut06a(time.day, time.fraction))
