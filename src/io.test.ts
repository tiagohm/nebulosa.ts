import { expect, test } from 'bun:test'
import { readLinesFromArrayBuffer } from './io'

test('readLinesFromArrayBuffer', async () => {
	const blob = new Blob(['line 1\n', 'line 2\n', '', 'line 3\nline 4\n\n'])
	const lines: string[] = []

	await readLinesFromArrayBuffer(await blob.arrayBuffer(), (line) => {
		lines.push(line)
	})

	expect(lines).toHaveLength(4)
	expect(lines).toContainAllValues(['line 1', 'line 2', 'line 3', 'line 4'])
})
