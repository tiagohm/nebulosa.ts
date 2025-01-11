import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { arrayBufferToLines, bufferSink, bufferSource, fileHandleSink, fileHandleSource, readableStreamToLines } from './io'

test('arrayBufferToLines', async () => {
	const blob = new Blob(['line 1\n', 'line 2\n', '', 'line 3\nline 4\n\n'])
	const lines: string[] = []

	for await (const line of arrayBufferToLines(await blob.arrayBuffer())) {
		lines.push(line)
	}

	expect(lines).toHaveLength(4)
	expect(lines).toContainAllValues(['line 1', 'line 2', 'line 3', 'line 4'])
})

test('readableStreamToLines', async () => {
	const blob = new Blob(['line 1\n', 'line 2\n', '', 'line 3\nline 4\n\n'])
	const lines: string[] = []

	for await (const line of readableStreamToLines(blob.stream())) {
		lines.push(line)
	}

	expect(lines).toHaveLength(4)
	expect(lines).toContainAllValues(['line 1', 'line 2', 'line 3', 'line 4'])
})

test('bufferSink', () => {
	const buffer = Buffer.alloc(16)
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
	const path = join(tmpdir(), 'fhs.tmp')
	const handle = await fs.open(path, 'w+', 0o666)
	const sink = fileHandleSink(handle)

	async function read() {
		const buffer = Buffer.alloc(16)
		const ret = await handle.read(buffer, 0, buffer.length, 0)
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

	await fs.unlink(path)
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
	const path = join(tmpdir(), 'fhs.tmp')
	const handle = await fs.open(path, 'w+', 0o666)
	const source = fileHandleSource(handle)
	const buffer = Buffer.alloc(17)

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
