import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { equatorial } from '../../../../src/astronomy/coordinates/astrometry'
import { frameAt, frameToBase } from '../../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { bodyRadii, SpiceFrames } from '../../../../src/astronomy/ephemeris/kernels/frame.kernel'
import { Naif } from '../../../../src/astronomy/ephemeris/kernels/naif'
import { readPck } from '../../../../src/astronomy/ephemeris/kernels/pck'
import { readSpk } from '../../../../src/astronomy/ephemeris/kernels/spk'
import { readTextKernel, SpiceKernelPool } from '../../../../src/astronomy/ephemeris/kernels/text.kernel'
import { Timescale, time, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, J2000, PI } from '../../../../src/core/constants'
import { fileHandleSource } from '../../../../src/io/io'
import { type Mat3, matIdentity, matMul, matMulTranspose, matMulVec, matRotZ } from '../../../../src/math/linear-algebra/mat3'
import { type MutVec3, vecMinus } from '../../../../src/math/linear-algebra/vec3'
import { normalizePI, toDeg } from '../../../../src/math/units/angle'
import { kilometer } from '../../../../src/math/units/distance'
import { downloadPerTag } from '../../../download'
import { expectNumberArrayToBeCloseTo } from '../../../util'

await downloadPerTag('frame.kernel')

// Skyfield 1.55 / jplephem 2.24. TDB = T0 − 11150, MOON_PA_DE421.
const T0_MINUS_11150_PA: Mat3 = [0.9994150897380264, 0.032310270603926675, 0.011203785852719871, -0.034157426811763446, 0.9272642685944782, 0.37284614304233643, 0.0016578894811167893, -0.3730107540024127, 0.9278255379116378]

// Skyfield 1.55 / jplephem 2.24. TDB = T0 − 11150, MOON_ME_DE421.
const T0_MINUS_11150_ME: Mat3 = [0.9994268420493244, 0.03186286343877705, 0.011434392191818011, -0.03382833397374688, 0.9272754001640859, 0.37284846261060917, 0.0012771890522186643, -0.37302156798771835, 0.927821792481783]

// Skyfield 1.55 / jplephem 2.24. TDB = T0, MOON_PA_DE421.
const T0_PA: Mat3 = [0.7840447406961362, 0.5582359944893811, 0.2713787372716964, -0.6203032939745002, 0.7203957219351799, 0.31024800934393754, -0.02230847532023746, -0.41158544468183367, 0.9110981032001678]

// Loads the lunar FK, text PCK, and DE421 binary PCK into a resolver.
// Keeps the binary PCK handle open so Type 2 records can be decoded on demand.
async function lunarFrames() {
	const pool = new SpiceKernelPool()

	await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
	pool.load(await readTextKernel(fk))

	await using tpc = fileHandleSource(await fs.open('data/pck00008.tpc'))
	pool.load(await readTextKernel(tpc))

	const bpc = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(bpc))
	await pck.initialize()

	return {
		pool,
		pck,
		frames: new SpiceFrames(pool, pck),
		async [Symbol.asyncDispose]() {
			await bpc[Symbol.asyncDispose]()
		},
	}
}

test('J2000 is the identity base frame without a kernel', async () => {
	const frames = new SpiceFrames(new SpiceKernelPool())
	const frame = await frames.frame('J2000')

	expect(frame.rotationAt(time(J2000, 0, Timescale.TDB))).toEqual(matIdentity())
	expect(frame.dRdtTimesRtAt).toBeUndefined()
	expect((await frames.frame(1)).rotationAt(time(J2000, 0, Timescale.TDB))).toEqual(matIdentity())
})

test('bodyRadii converts BODY301_RADII kilometres to AU', async () => {
	await using lunar = await lunarFrames()
	const { pool } = lunar
	const radii = bodyRadii(pool, Naif.MOON)!

	expect(radii.x).toBe(kilometer(1737.4))
	expect(radii.y).toBe(kilometer(1737.4))
	expect(radii.z).toBe(kilometer(1737.4))
	expect(bodyRadii(pool, 999999)).toBeUndefined()
})

test('MOON_PA_DE421 matches Skyfield at T0 − 11150 and T0', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const frame = await frames.frame('MOON_PA_DE421')

	expectNumberArrayToBeCloseTo(frame.rotationAt(time(J2000 - 11150, 0, Timescale.TDB)), T0_MINUS_11150_PA, 15)
	expectNumberArrayToBeCloseTo(frame.rotationAt(time(J2000, 0, Timescale.TDB)), T0_PA, 12)
	expect(frame.dRdtTimesRtAt).toBeDefined()
})

test('MOON_ME_DE421 is the ANGLES TK frame relative to MOON_PA_DE421', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const frame = await frames.frame('MOON_ME_DE421')

	expectNumberArrayToBeCloseTo(frame.rotationAt(time(J2000 - 11150, 0, Timescale.TDB)), T0_MINUS_11150_ME, 15)
})

test('MOON_PA is an identity alias of MOON_PA_DE421', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const pa = await frames.frame('MOON_PA')
	const paDe421 = await frames.frame(31006)
	const t = time(J2000, 0, Timescale.TDB)

	expectNumberArrayToBeCloseTo(pa.rotationAt(t), paDe421.rotationAt(t), 15)
})

test('TKFRAME MATRIX applies a non-identity rotation relative to J2000', async () => {
	const matrix = matRotZ(PI / 2)
	const pool = new SpiceKernelPool()
	pool.load([
		{ name: 'FRAME_TEST_MATRIX', append: false, values: [99001] },
		{ name: 'FRAME_99001_CLASS', append: false, values: [4] },
		{ name: 'FRAME_99001_CLASS_ID', append: false, values: [99001] },
		{ name: 'TKFRAME_99001_SPEC', append: false, values: ['MATRIX'] },
		{ name: 'TKFRAME_99001_RELATIVE', append: false, values: ['J2000'] },
		{ name: 'TKFRAME_99001_MATRIX', append: false, values: [...matrix] },
	])

	const frame = await new SpiceFrames(pool).frame('TEST_MATRIX')
	expectNumberArrayToBeCloseTo(frame.rotationAt(time(J2000, 0, Timescale.TDB)), matrix, 15)
	expect(frame.dRdtTimesRtAt).toBeUndefined()
})

test('TKFRAME MATRIX composes onto MOON_PA_DE421', async () => {
	await using lunar = await lunarFrames()
	const { pool, pck, frames } = lunar
	const matrix = matRotZ(PI / 2)
	pool.load([
		{ name: 'FRAME_TEST_MATRIX', append: false, values: [99001] },
		{ name: 'FRAME_99001_CLASS', append: false, values: [4] },
		{ name: 'FRAME_99001_CLASS_ID', append: false, values: [99001] },
		{ name: 'TKFRAME_99001_SPEC', append: false, values: ['MATRIX'] },
		{ name: 'TKFRAME_99001_RELATIVE', append: false, values: ['MOON_PA_DE421'] },
		{ name: 'TKFRAME_99001_MATRIX', append: false, values: [...matrix] },
	])

	const t = time(J2000, 0, Timescale.TDB)
	const pa = await frames.frame('MOON_PA_DE421')
	const composed = await new SpiceFrames(pool, pck).frame('TEST_MATRIX')

	expectNumberArrayToBeCloseTo(composed.rotationAt(t), matMul(matrix, pa.rotationAt(t)), 12)

	const w = composed.dRdtTimesRtAt!(t)
	expectNumberArrayToBeCloseTo(w, matMulTranspose(matMul(matrix, pa.dRdtTimesRtAt!(t)), matrix), 12)
})

test('unknown frames and missing binary PCK segments fail explicitly', async () => {
	const empty = new SpiceFrames(new SpiceKernelPool())
	expect(empty.frame('MOON_PA')).rejects.toThrow('unknown frame: MOON_PA')
	expect(empty.frame(31006)).rejects.toThrow('unknown frame: 31006')

	const pool = new SpiceKernelPool()
	await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
	pool.load(await readTextKernel(fk))

	const frames = new SpiceFrames(pool)
	expect(frames.frame('MOON_PA_DE421')).rejects.toThrow('missing binary PCK segment for frame 31006')
})

test('cyclic TK chains are rejected', () => {
	const pool = new SpiceKernelPool()
	pool.load(
		new Map([
			['FRAME_A', [100]],
			['FRAME_100_CLASS', [4]],
			['FRAME_100_CLASS_ID', [100]],
			['TKFRAME_100_SPEC', ['MATRIX']],
			['TKFRAME_100_RELATIVE', ['B']],
			['TKFRAME_100_MATRIX', [1, 0, 0, 0, 1, 0, 0, 0, 1]],
			['FRAME_B', [101]],
			['FRAME_101_CLASS', [4]],
			['FRAME_101_CLASS_ID', [101]],
			['TKFRAME_101_SPEC', ['MATRIX']],
			['TKFRAME_101_RELATIVE', ['A']],
			['TKFRAME_101_MATRIX', [1, 0, 0, 0, 1, 0, 0, 0, 1]],
		]),
	)

	expect(new SpiceFrames(pool).frame('A')).rejects.toThrow('cyclic frame definition: 100')
})

test('unsupported frame classes are rejected', () => {
	const pool = new SpiceKernelPool()
	pool.load(
		new Map([
			['FRAME_CK', [3]],
			['FRAME_3_CLASS', [3]],
			['FRAME_3_CLASS_ID', [3]],
		]),
	)

	expect(new SpiceFrames(pool).frame('CK')).rejects.toThrow('unsupported frame class 3 for frame 3')
})

test('lunar libration at 2019-12-20 11:05 UTC matches Skyfield', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const moonMe = await frames.frame('MOON_ME_DE421')
	const t = timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC)

	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(source))
	const earth = (await spk.segment(Naif.EMB, Naif.EARTH))!.at(t)[0]
	const moon = (await spk.segment(Naif.EMB, Naif.MOON))!.at(t)[0]
	const earthFromMoon = vecMinus(earth, moon)
	const framed = frameAt(earthFromMoon, moonMe, t)
	const [longitude, latitude] = equatorial(framed)

	// Skyfield 1.55: (earth - moon).at(t).frame_latlon(MOON_ME_DE421), longitude wrapped to (−180°, 180°].
	expect(toDeg(latitude)).toBeCloseTo(-6.749410378629279, 9)
	expect(toDeg(normalizePI(longitude))).toBeCloseTo(1.5199462712205616, 9)
})

test('a rotating lunar state round-trips through frameAt and frameToBase', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const moonMe = await frames.frame('MOON_ME_DE421')
	const t = timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC)
	const pv: [MutVec3, MutVec3] = [
		[0.01, -0.02, 0.03],
		[1e-4, 2e-4, -3e-4],
	]

	const framed = frameAt(pv, moonMe, t)
	const back = frameToBase(framed, moonMe, t)
	const w = moonMe.dRdtTimesRtAt!(t)

	expect(back[0][0]).toBeCloseTo(pv[0][0], 14)
	expect(back[0][1]).toBeCloseTo(pv[0][1], 14)
	expect(back[0][2]).toBeCloseTo(pv[0][2], 14)
	expect(back[1][0]).toBeCloseTo(pv[1][0], 14)
	expect(back[1][1]).toBeCloseTo(pv[1][1], 14)
	expect(back[1][2]).toBeCloseTo(pv[1][2], 14)

	expect(Math.abs(w[1])).toBeGreaterThan(0.2)

	const withoutDrag = matMulVec(moonMe.rotationAt(t), pv[1])
	expect(Math.abs(framed[1][0] - withoutDrag[0])).toBeGreaterThan(1e-6)
})

test('moon_080317.tf sample vector rotates into MOON_PA and MOON_ME', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const pa = await frames.frame('MOON_PA_DE421')
	const me = await frames.frame('MOON_ME_DE421')
	const t = time(J2000, 259056665.1855896 / DAYSEC, Timescale.TDB)
	const vector: MutVec3 = [2.4798273371071659e5 / AU_KM, -2.6189996683651494e5 / AU_KM, -1.24558308760974e5 / AU_KM]
	const meter = 1e-3 / AU_KM

	const paXyz = frameAt(vector, pa, t)
	expect(paXyz[0] * AU_KM).toBeCloseTo(379908.634, 3)
	expect(paXyz[1] * AU_KM).toBeCloseTo(33385.003, 3)
	expect(paXyz[2] * AU_KM).toBeCloseTo(-12516.8859, 3)
	expect(Math.abs(paXyz[0] - 379908.634 / AU_KM)).toBeLessThan(meter)

	const meXyz = frameAt(vector, me, t)
	expect(meXyz[0] * AU_KM).toBeCloseTo(379892.825, 3)
	expect(meXyz[1] * AU_KM).toBeCloseTo(33510.118, 3)
	expect(meXyz[2] * AU_KM).toBeCloseTo(-12661.5278, 3)
})

test('resolved frames are cached by integer id', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const a = await frames.frame('MOON_ME_DE421')
	const b = await frames.frame(31007)

	expect(a).toBe(b)
})

test('lookup by name is case-insensitive', async () => {
	await using lunar = await lunarFrames()
	const { frames } = lunar
	const a = await frames.frame('moon_pa_de421')
	const b = await frames.frame('MOON_PA_DE421')

	expect(a).toBe(b)
})
