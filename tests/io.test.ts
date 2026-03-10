import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FitsKeywordReader, FitsKeywordWriter } from '../src/fits'
import { type Base64Alphabet, base64Sink, base64Source, bufferSink, bufferSource, fileHandleSink, fileHandleSource, GrowableBuffer, rangeHttpSource, readableStreamSource, readLines, readUntil } from '../src/io'

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

describe('growableBuffer', () => {
	test('writeInt8', () => {
		const buffer = new GrowableBuffer(4)
		buffer.writeInt8(48)
		buffer.writeInt8(49)
		buffer.writeInt8(50)
		buffer.writeInt8(51)

		expect(buffer.length).toBe(4)

		buffer.writeInt8(52)

		expect(buffer.length).toBe(5)
		expect(buffer.toString()).toBe('01234')

		buffer.reset()

		expect(buffer.length).toBe(0)

		buffer.writeInt8(10)
		buffer.writeInt8(33)
		buffer.writeInt8(10)

		expect(buffer.length).toBe(3)
		expect(buffer.toString(true, 'ascii')).toBe('!')
	})

	test('grows for multi-byte writes', () => {
		const buffer = new GrowableBuffer(1)
		buffer.writeUInt32BE(0x01020304)

		expect(buffer.length).toBe(4)
		expect(Array.from(buffer.toBuffer())).toEqual([1, 2, 3, 4])
	})

	test('trim preserves non-ascii bytes', () => {
		const buffer = new GrowableBuffer(4)

		for (const byte of Buffer.from(' é ', 'utf8')) buffer.writeUInt8(byte)

		expect(buffer.toString(true, 'utf8')).toBe('é')
	})
})

describe('base64', () => {
	const output = Buffer.allocUnsafe(8192)

	test('source', async () => {
		for (let i = 0; i <= 1000; i++) {
			const [encoded, raw] = randomBase64(i, i % 2 === 0 ? 'base64' : 'base64url')
			const source = base64Source(bufferSource(encoded))
			const n = await readUntil(source, output, i)

			expect(n).toBe(i)
			expect(raw.subarray(0, n)).toEqual(output.subarray(0, n))
		}
	})

	test('string', async () => {
		for (let i = 0; i <= 1000; i++) {
			const [encoded, raw] = randomBase64(i, i % 2 === 0 ? 'base64' : 'base64url')
			const source = base64Source(encoded.toString('ascii'))
			const n = await readUntil(source, output, i)

			expect(n).toBe(i)
			expect(raw.subarray(0, n)).toEqual(output.subarray(0, n))
		}
	})

	test('source honors offset when size is omitted', async () => {
		const source = base64Source('YWJjZGVm')
		const buffer = Buffer.alloc(8, 32)

		expect(await source.read(buffer, 2)).toBe(6)
		expect(buffer.toString('ascii')).toBe('  abcdef')
	})

	test('sink', async () => {
		for (let i = 0; i <= 1000; i++) {
			const alphabet = i % 2 === 0 ? 'base64' : 'base64url'
			const sink = base64Sink(bufferSink(output), alphabet)
			const [encoded, raw] = randomBase64(i, alphabet)
			const n = (await sink.write(raw)) + (await sink.end())

			expect(n).toBe(encoded.byteLength)
			expect(output.subarray(0, n)).toEqual(encoded.subarray(0, n))
		}
	})

	test('fits header', async () => {
		const writer = new FitsKeywordWriter()
		const output = Buffer.alloc(2880, 32)
		const card = ['BITPIX', -32, 'number of bits used to represent a data value in the image array'] as const
		let position = 0

		for (let i = 0; i < 35; i++) position += writer.write(card, output, position)
		writer.write(['END'], output, position)

		const source = base64Source(output.toString('base64'))
		const line = Buffer.alloc(80)
		const reader = new FitsKeywordReader()

		for (let i = 0; i < 35; i++) {
			await readUntil(source, line)
			const [key, value, comment] = reader.read(line)

			expect(key).toBe('BITPIX')
			expect(value).toBe(-32)
			expect(comment).toBe('number of bits used to represent a data value in the image array')
		}

		await readUntil(source, line)
		const [key] = reader.read(line)
		expect(key).toBe('END')
	})
})

describe('rangeHttpSource', () => {
	test('advances position across sequential reads', async () => {
		const restore = mockRangeFetch(Buffer.from('abcdefghijklmnopqrstuvwxyz'))

		try {
			const source = rangeHttpSource('https://example.test/data')
			const first = Buffer.allocUnsafe(5)
			const second = Buffer.allocUnsafe(5)

			expect(await source.read(first)).toBe(5)
			expect(first.toString('ascii')).toBe('abcde')
			expect(source.position).toBe(5)

			expect(await source.read(second)).toBe(5)
			expect(second.toString('ascii')).toBe('fghij')
			expect(source.position).toBe(10)
		} finally {
			globalThis.fetch = restore
		}
	})

	test('reads large ranges across multiple stream chunks', async () => {
		const data = Buffer.allocUnsafe(0x10000 + 257)
		for (let i = 0; i < data.byteLength; i++) data[i] = i & 0xff

		const restore = mockRangeFetch(data, 4096)

		try {
			const source = rangeHttpSource('https://example.test/data')
			const output = Buffer.allocUnsafe(data.byteLength)

			expect(await source.read(output)).toBe(data.byteLength)
			expect(output).toEqual(data)
			expect(source.position).toBe(data.byteLength)
		} finally {
			globalThis.fetch = restore
		}
	})
})

function randomBase64(n: number, alphabet: Base64Alphabet) {
	const bytes = Buffer.allocUnsafe(n)
	for (let i = 0; i < n; i++) bytes.writeUInt8(Math.trunc(Math.random() * 256), i)
	const base64 = bytes.toBase64({ alphabet })
	return [Buffer.from(base64, 'ascii'), bytes] as const
}

function mockRangeFetch(data: Buffer, chunkSize?: number) {
	const restore = globalThis.fetch

	// biome-ignore lint/suspicious/useAwait: mock
	globalThis.fetch = (async (_input, init) => {
		const headers = new Headers(init?.headers)
		const range = headers.get('Range')
		const match = range?.match(/^bytes=(\d+)-(\d+)$/)

		if (!match) return new Response(null, { status: 400 })

		const start = Number.parseInt(match[1], 10)
		const end = Number.parseInt(match[2], 10)
		const slice = data.subarray(start, Math.min(end + 1, data.byteLength))
		const body = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength)

		if (!chunkSize || slice.byteLength <= chunkSize) {
			const copy = new Uint8Array(body.byteLength)
			copy.set(body)
			return new Response(new Blob([copy.buffer]), { status: 206 })
		}

		let position = 0

		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (position >= slice.byteLength) {
						controller.close()
						return
					}

					const next = Math.min(position + chunkSize, slice.byteLength)
					controller.enqueue(slice.subarray(position, next))
					position = next
				},
			}),
			{ status: 206 },
		)
	}) as typeof fetch

	return restore
}
