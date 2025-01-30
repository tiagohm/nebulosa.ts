import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { bufferSink, bufferSource, fileHandleSink, fileHandleSource, rangeHttpSource, readLines, readableStreamSource } from './io'

test('bufferSink', () => {
	const buffer = Buffer.allocUnsafe(16)
	const sink = bufferSink(buffer)

	expect(sink.write('abcdefg')).toBe(7)
	expect(sink.write('h')).toBe(1)
	expect(sink.write('ijklmnop')).toBe(8)

	expect(buffer.toString()).toBe('abcdefghijklmnop')
	expect(sink.exhausted).toBeTrue()

	sink.seek(4)
	expect(sink.write('abcd')).toBe(4)

	expect(buffer.toString()).toBe('abcdabcdijklmnop')
	expect(sink.exhausted).toBeFalse()

	sink.seek(-4)
	expect(sink.write('abcd')).toBe(4)

	expect(buffer.toString()).toBe('abcdabcdijklabcd')
	expect(sink.exhausted).toBeTrue()

	sink.seek(0)
	expect(sink.write('abcd', 1)).toBe(3)

	expect(buffer.toString()).toBe('bcddabcdijklabcd')
	expect(sink.exhausted).toBeFalse()

	sink.seek(0)
	expect(sink.write('abcd', 2, 2)).toBe(2)

	expect(buffer.toString()).toBe('cdddabcdijklabcd')
	expect(sink.exhausted).toBeFalse()

	sink.seek(0)
	expect(sink.write(Buffer.from('xyz'))).toBe(3)

	expect(buffer.toString()).toBe('xyzdabcdijklabcd')
	expect(sink.exhausted).toBeFalse()

	expect(sink.write(Buffer.from('xyz'), 1)).toBe(2)

	expect(buffer.toString()).toBe('xyzyzbcdijklabcd')
	expect(sink.exhausted).toBeFalse()

	expect(sink.write(Buffer.from('xyz'), 1, 1)).toBe(1)

	expect(buffer.toString()).toBe('xyzyzycdijklabcd')
	expect(sink.exhausted).toBeFalse()
})

test('fileHandleSink', async () => {
	const path = join(tmpdir(), 'a.txt')
	const handle = await fs.open(path, 'w+', 0o666)
	await using sink = fileHandleSink(handle)

	async function read() {
		const buffer = Buffer.allocUnsafe(16)
		const ret = await handle.read(buffer, 0, buffer.byteLength, 0)
		return ret.buffer.toString()
	}

	expect(await sink.write('abcdefg')).toBe(7)
	expect(await sink.write('h')).toBe(1)
	expect(await sink.write('ijklmnop')).toBe(8)

	expect(await read()).toBe('abcdefghijklmnop')

	sink.seek(4)
	expect(await sink.write('abcd')).toBe(4)

	expect(await read()).toBe('abcdabcdijklmnop')

	sink.seek(0)
	expect(await sink.write('abcd', 1)).toBe(3)

	expect(await read()).toBe('bcddabcdijklmnop')

	sink.seek(0)
	expect(await sink.write('abcd', 2, 2)).toBe(2)

	expect(await read()).toBe('cdddabcdijklmnop')

	sink.seek(0)
	expect(await sink.write(Buffer.from('xyz'))).toBe(3)

	expect(await read()).toBe('xyzdabcdijklmnop')

	expect(await sink.write(Buffer.from('xyz'), 1)).toBe(2)

	expect(await read()).toBe('xyzyzbcdijklmnop')

	expect(await sink.write(Buffer.from('xyz'), 1, 1)).toBe(1)

	expect(await read()).toBe('xyzyzycdijklmnop')
})

test('bufferSource', () => {
	const buffer = Buffer.alloc(17, 32)
	const source = bufferSource(Buffer.from('abcdefghijklmnop'))

	expect(source.read(buffer)).toBe(16)

	expect(buffer.toString()).toBe('abcdefghijklmnop ')
	expect(source.exhausted).toBeTrue()

	buffer.fill(32)
	source.seek(0)
	expect(source.read(buffer, 1)).toBe(16)

	expect(buffer.toString()).toBe(' abcdefghijklmnop')
	expect(source.exhausted).toBeTrue()

	buffer.fill(32)
	source.seek(0)
	expect(source.read(buffer, 1, 6)).toBe(6)

	expect(buffer.toString()).toBe(' abcdef          ')
	expect(source.exhausted).toBeFalse()

	expect(source.read(buffer, undefined, 1)).toBe(1)

	expect(buffer.toString()).toBe('gabcdef          ')
	expect(source.exhausted).toBeFalse()
})

test('fileHandleSource', async () => {
	const path = join(tmpdir(), 'b.txt')
	const handle = await fs.open(path, 'w+', 0o666)
	await using source = fileHandleSource(handle)
	const buffer = Buffer.allocUnsafe(17)

	await handle.write('abcdefghijklmnop ', 0, 'ascii')

	expect(await source.read(buffer)).toBe(17)

	expect(buffer.toString()).toBe('abcdefghijklmnop ')

	buffer.fill(32)
	source.seek(0)
	expect(await source.read(buffer, 1)).toBe(16)

	expect(buffer.toString()).toBe(' abcdefghijklmnop')

	buffer.fill(32)
	source.seek(0)
	expect(await source.read(buffer, 1, 6)).toBe(6)

	expect(buffer.toString()).toBe(' abcdef          ')

	expect(await source.read(buffer, undefined, 1)).toBe(1)

	expect(buffer.toString()).toBe('gabcdef          ')
})

describe('readableStreamSource', async () => {
	const path = join(tmpdir(), 'c.txt')
	const handle = await fs.open(path, 'w+', 0o666)

	await handle.write('abcdefghijklmnop ', 0, 'ascii')
	await handle.close()

	test('fully', async () => {
		await using source = readableStreamSource(Bun.file(path).stream())
		const buffer = Buffer.allocUnsafe(17)

		expect(await source.read(buffer)).toBe(17)
		expect(buffer.toString()).toBe('abcdefghijklmnop ')
		expect(await source.read(buffer)).toBe(0)
	})

	test('withOffset', async () => {
		await using source = readableStreamSource(Bun.file(path).stream())
		const buffer = Buffer.allocUnsafe(17)

		buffer.fill(32)
		expect(await source.read(buffer, 6)).toBe(11)
		expect(buffer.toString()).toBe('      abcdefghijk')
		expect(await source.read(buffer)).toBe(6)
	})

	test('withSize', async () => {
		await using source = readableStreamSource(Bun.file(path).stream())
		const buffer = Buffer.allocUnsafe(17)

		buffer.fill(32)
		expect(await source.read(buffer, undefined, 8)).toBe(8)
		expect(buffer.toString()).toBe('abcdefgh         ')
		expect(await source.read(buffer)).toBe(9)
	})

	test('withOffsetAndSize', async () => {
		await using source = readableStreamSource(Bun.file(path).stream())
		const buffer = Buffer.allocUnsafe(17)

		buffer.fill(32)
		expect(await source.read(buffer, 2, 8)).toBe(8)
		expect(buffer.toString()).toBe('  abcdefgh       ')
		expect(await source.read(buffer)).toBe(9)
	})
})

describe('readLines', () => {
	test('withoutFinalNewLine', async () => {
		const data = Buffer.from('C\nJava\nPython\nC++\nC#\nJavaScript\nPHP\n\nGo')

		for (let i = 1; i <= 64; i++) {
			const source = bufferSource(data)
			const lines = await Array.fromAsync(readLines(source, i))
			expect(lines).toEqual(['C', 'Java', 'Python', 'C++', 'C#', 'JavaScript', 'PHP', '', 'Go'])
		}
	})

	test('withFinalNewLine', async () => {
		const data = Buffer.from('C\nJava\nPython\nC++\nC#\nJavaScript\nPHP\n\nGo\n')

		for (let i = 1; i <= 64; i++) {
			const source = bufferSource(data)
			const lines = await Array.fromAsync(readLines(source, i))
			expect(lines).toEqual(['C', 'Java', 'Python', 'C++', 'C#', 'JavaScript', 'PHP', '', 'Go', ''])
		}
	})

	test('excludeEmptyLines', async () => {
		const data = Buffer.from('C\nJava\nPython\nC++\nC#\nJavaScript\nPHP\n\nGo\n')

		for (let i = 1; i <= 64; i++) {
			const source = bufferSource(data)
			const lines = await Array.fromAsync(readLines(source, i, { emptyLines: false }))
			expect(lines).toEqual(['C', 'Java', 'Python', 'C++', 'C#', 'JavaScript', 'PHP', 'Go'])
		}
	})

	test('unicode', async () => {
		const data = new Uint8Array([
			0xf0, 0x9f, 0x87, 0xaf, 0xf0, 0x9f, 0x87, 0xb5, 0x0a, 0xf0, 0x9f, 0x87, 0xb0, 0xf0, 0x9f, 0x87, 0xb7, 0x0a, 0xf0, 0x9f, 0x87, 0xa9, 0xf0, 0x9f, 0x87, 0xaa, 0x0a, 0xf0, 0x9f, 0x87, 0xa8, 0xf0, 0x9f, 0x87, 0xb3, 0xf0, 0x9f, 0x87, 0xba, 0xf0, 0x9f, 0x87, 0xb8, 0x0a, 0xf0, 0x9f, 0x87, 0xab, 0xf0, 0x9f, 0x87,
			0xb7, 0x0a, 0xf0, 0x9f, 0x87, 0xaa, 0xf0, 0x9f, 0x87, 0xb8, 0xf0, 0x9f, 0x87, 0xae, 0xf0, 0x9f, 0x87, 0xb9, 0xf0, 0x9f, 0x87, 0xb7, 0xf0, 0x9f, 0x87, 0xba, 0x0a, 0xf0, 0x9f, 0x87, 0xac, 0xf0, 0x9f, 0x87, 0xa7,
		])

		for (let i = 1; i <= 64; i++) {
			const source = bufferSource(Buffer.from(data))
			const lines = await Array.fromAsync(readLines(source, i, { encoding: 'utf-8' }))
			expect(lines).toEqual(['🇯🇵', '🇰🇷', '🇩🇪', '🇨🇳🇺🇸', '🇫🇷', '🇪🇸🇮🇹🇷🇺', '🇬🇧'])
		}
	})
})

test('rangeHttpSource', async () => {
	const buffer = Buffer.allocUnsafe(10)
	const source = rangeHttpSource('https://raw.githubusercontent.com/tiagohm/nebulosa.ts/refs/heads/main/LICENSE')
	source.seek(32)
	expect(await source.read(buffer)).toBe(10)
	expect(buffer.toString()).toBe('Tiago Melo')
})
