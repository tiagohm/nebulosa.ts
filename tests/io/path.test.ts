import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { directoryExists, isPathSegment } from '../../src/io/path'

describe('path segment', () => {
	test('accepts ordinary portable file names', () => {
		for (const name of ['m42-lum-0.fit', '20261009.203015123.xisf', 'Camera Simulator.fit', '.hidden', 'a', 'NGC 7000 (Ha).fits', 'Órion_ñ.fit', '星雲.fit', 'CONSOLE.fit', 'nullable.fit', 'COM10', 'LPT', 'a..b', 'x'.repeat(255)]) {
			expect(isPathSegment(name)).toBeTrue()
		}
	})

	test('rejects empty and relative names', () => {
		expect(isPathSegment('')).toBeFalse()
		expect(isPathSegment('.')).toBeFalse()
		expect(isPathSegment('..')).toBeFalse()
	})

	test('rejects names carrying a separator', () => {
		for (const name of ['../m42.fit', '..\\m42.fit', 'a/b', 'a\\b', '/', '\\', '/etc', 'C:\\x']) {
			expect(isPathSegment(name)).toBeFalse()
		}
	})

	test('rejects control characters', () => {
		for (const code of [0, 1, 9, 10, 13, 31, 127]) {
			expect(isPathSegment(`m42${String.fromCharCode(code)}.fit`)).toBeFalse()
		}
	})

	test('rejects characters windows forbids', () => {
		for (const character of '<>:"|?*') {
			expect(isPathSegment(`m42${character}.fit`)).toBeFalse()
		}

		// An NTFS alternate data stream.
		expect(isPathSegment('m42.fit:stream')).toBeFalse()
	})

	test('rejects a trailing space or dot', () => {
		expect(isPathSegment('m42.fit ')).toBeFalse()
		expect(isPathSegment('m42.fit.')).toBeFalse()
		expect(isPathSegment('m42...')).toBeFalse()
		expect(isPathSegment(' m42.fit')).toBeTrue()
	})

	test('rejects windows reserved device names in any case and with any extension', () => {
		for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'NUL.fit', 'nul.tar.gz', 'COM0', 'com1', 'COM9.txt', 'LPT1', 'lpt9.fit', 'COM¹', 'LPT³.fit']) {
			expect(isPathSegment(name)).toBeFalse()
		}
	})

	test('rejects names longer than 255 utf-8 bytes', () => {
		expect(isPathSegment('x'.repeat(256))).toBeFalse()
		// 86 three-byte characters are 258 bytes in only 86 UTF-16 units.
		expect(isPathSegment('星'.repeat(85))).toBeTrue()
		expect(isPathSegment('星'.repeat(86))).toBeFalse()
	})
})

describe('directory exists', () => {
	test('reports directories, missing paths and regular files', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nebulosa-path-'))

		try {
			const file = join(directory, 'm42.fit')
			await Bun.write(file, 'frame')

			expect(await directoryExists(directory)).toBeTrue()
			expect(await directoryExists(file)).toBeFalse()
			expect(await directoryExists(join(directory, 'missing'))).toBeFalse()
			expect(await directoryExists(join(file, 'child'))).toBeFalse()
			expect(await directoryExists(relative(process.cwd(), directory))).toBeTrue()
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
