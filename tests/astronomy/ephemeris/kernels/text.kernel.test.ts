import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readTextKernel, SpiceKernelPool } from '../../../../src/astronomy/ephemeris/kernels/text.kernel'
import { bufferSource, fileHandleSource } from '../../../../src/io/io'
import { downloadPerTag } from '../../../download'

await downloadPerTag('text.kernel')

// Builds a seekable source from a text-kernel string.
function kernelSource(text: string) {
	return bufferSource(Buffer.from(text, 'ascii'))
}

// Parses `text` into a pool so `=` / `+=` are applied as they would be on load.
async function poolFrom(text: string) {
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(kernelSource(text)))
	return pool
}

test('parses scalars, lists, quoted strings, and Fortran D exponents', async () => {
	const pool = await poolFrom(`KPL/PCK

\\begindata

      FRAME_MOON_PA                 = 31000
      FRAME_31000_NAME              = 'MOON_PA'
      BODY399_GM                    = ( 3.9860043543609598D+05 )
      BODY000_GMLIST=( 1 2 3 )

\\begintext
`)

	expect(pool.get('FRAME_MOON_PA')).toEqual([31000])
	expect(pool.get('FRAME_31000_NAME')).toEqual(['MOON_PA'])
	expect(pool.get('BODY399_GM')![0]).toBeCloseTo(3.9860043543609598e5, 12)
	expect(pool.get('BODY000_GMLIST')).toEqual([1, 2, 3])
})

test('replaces with = and appends with +=', async () => {
	const pool = await poolFrom(`KPL/FK

\\begindata

      ITEMS = ( 1 2 )
      ITEMS += ( 3 )
      ITEMS = ( 4 )
      ITEMS += 5

\\begintext
`)

	expect(pool.get('ITEMS')).toEqual([4, 5])
})

test('parses multiline parenthesized lists and names without spaces around =', async () => {
	const pool = await poolFrom(`KPL/FK

\\begindata

      TKFRAME_31000_MATRIX          = ( 1 0 0
                                        0 1 0
                                        0 0 1 )
      TKFRAME_31007_AXES            = (   3,        2,        1       )
      BODY000_GMLIST=(10,20)

\\begintext
`)

	expect(pool.get('TKFRAME_31000_MATRIX')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
	expect(pool.get('TKFRAME_31007_AXES')).toEqual([3, 2, 1])
	expect(pool.get('BODY000_GMLIST')).toEqual([10, 20])
})

test('ignores begintext comments and later begindata sections', async () => {
	const pool = await poolFrom(`KPL/PCK
commented FRAME_X = 1
\\begindata

      A = 1

\\begintext

      B = 2

\\begindata

      C = 3

\\begintext
`)

	expect(pool.get('A')).toEqual([1])
	expect(pool.get('B')).toBeUndefined()
	expect(pool.get('C')).toEqual([3])
})

test('stores names case-insensitively', async () => {
	const pool = await poolFrom(`KPL/FK

\\begindata

      frame_Moon_PA = 31000

\\begintext
`)

	expect(pool.get('FRAME_MOON_PA')).toEqual([31000])
})

test('rejects a file that is not a text kernel', () => {
	expect(readTextKernel(kernelSource('DAF/PCK\n'))).rejects.toThrow('text kernel must start with KPL/PCK or KPL/FK')
})

test('rejects an unterminated list', () => {
	expect(
		readTextKernel(
			kernelSource(`KPL/PCK
\\begindata
      A = ( 1 2
\\begintext
`),
		),
	).rejects.toThrow('unterminated list')
})

test('rejects an unterminated string', () => {
	expect(
		readTextKernel(
			kernelSource(`KPL/FK
\\begindata
      NAME = 'MOON
\\begintext
`),
		),
	).rejects.toThrow('unterminated string')
})

test('rejects @ calendar dates', () => {
	expect(
		readTextKernel(
			kernelSource(`KPL/PCK
\\begindata
      EPOCH = @01-MAY-1991
\\begintext
`),
		),
	).rejects.toThrow('@ dates are not supported')
})

test('rejects a missing equals sign', () => {
	expect(
		readTextKernel(
			kernelSource(`KPL/FK
\\begindata
      FRAME_MOON_PA 31000
\\begintext
`),
		),
	).rejects.toThrow('an equals sign is expected after FRAME_MOON_PA')
})

test('pool load replaces overlapping keys and keeps the rest', () => {
	const pool = new SpiceKernelPool()
	pool.load(
		new Map([
			['A', [1]],
			['B', [2]],
		]),
	)
	pool.load(new Map([['A', [3]]]))

	expect(pool.get('a')).toEqual([3])
	expect(pool.numbers('B')).toEqual([2])
	expect(pool.get('C')).toBeUndefined()
	expect(pool.strings('FRAME_X')).toBeUndefined()
})

test('+= appends to values already in the pool from another file', async () => {
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS = ( 1 2 )\n\\begintext\n`)))
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS += ( 3 )\n\\begintext\n`)))

	expect(pool.get('ITEMS')).toEqual([1, 2, 3])
})

test('+= creates the name when it is absent from the pool', async () => {
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS += ( 1 )\n\\begintext\n`)))

	expect(pool.get('ITEMS')).toEqual([1])
})

test('a later = in another file replaces a previous incremental assignment', async () => {
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS += ( 1 2 )\n\\begintext\n`)))
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS = ( 9 )\n\\begintext\n`)))

	expect(pool.get('ITEMS')).toEqual([9])
})

test('two += assignments in different files concatenate in load order', async () => {
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS += ( 1 )\n\\begintext\n`)))
	pool.load(await readTextKernel(kernelSource(`KPL/PCK\n\\begindata\nITEMS += ( 2 3 )\n\\begintext\n`)))

	expect(pool.get('ITEMS')).toEqual([1, 2, 3])
})

test('pool numbers and strings filter by value type', () => {
	const pool = new SpiceKernelPool()
	pool.load(
		new Map<string, readonly (number | string)[]>([
			['MIXED', [31000, 'MOON_PA', 1]],
			['NAME', ['MOON_PA']],
		]),
	)

	expect(pool.numbers('MIXED')).toEqual([31000, 1])
	expect(pool.strings('MIXED')).toEqual(['MOON_PA'])
	expect(pool.strings('NAME')).toEqual(['MOON_PA'])
	expect(pool.numbers('NAME')).toEqual([])
})

test('reads moon_080317.tf frame assignments', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_080317.tf'))
	const pool = new SpiceKernelPool()
	pool.load(await readTextKernel(source))

	expect(pool.get('FRAME_MOON_PA')).toEqual([31000])
	expect(pool.get('FRAME_31000_NAME')).toEqual(['MOON_PA'])
	expect(pool.get('FRAME_31006_CLASS')).toEqual([2])
	expect(pool.get('TKFRAME_31007_SPEC')).toEqual(['ANGLES'])
	expect(pool.get('TKFRAME_31007_RELATIVE')).toEqual(['MOON_PA_DE421'])
	expect(pool.get('TKFRAME_31007_ANGLES')).toEqual([67.92, 78.56, 0.3])
	expect(pool.get('TKFRAME_31007_AXES')).toEqual([3, 2, 1])
	expect(pool.get('TKFRAME_31007_UNITS')).toEqual(['ARCSECONDS'])
})

test('reads pck00008.tpc body radii', async () => {
	await using source = fileHandleSource(await fs.open('data/pck00008.tpc'))
	const values = await readTextKernel(source)
	const pool = new SpiceKernelPool()
	pool.load(values)

	expect(pool.numbers('BODY301_RADII')).toEqual([1737.4, 1737.4, 1737.4])
})
