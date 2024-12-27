import { expect, test } from 'bun:test'
import { arrayBufferToLines, readableStreamToLines } from './io'

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
