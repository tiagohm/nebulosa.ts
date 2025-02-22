import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readFits } from './fits'
import { fromFits, stf, toFormat } from './image'
import { fileHandleSource } from './io'

describe('fits', () => {
	describe('mono', () => {
		test('byte', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-byte.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-mono-byte.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-byte.png').arrayBuffer(), 'hex')).toBe('f56de59c02a6ba90a0159c972ba1b0b5')
		})

		test('short', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-short.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-mono-short.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-short.png').arrayBuffer(), 'hex')).toBe('468ec0bb58e382228977c1f109c426d2')
		})

		test('integer', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-integer.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-mono-integer.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-integer.png').arrayBuffer(), 'hex')).toBe('e02aafba8e06005cef8666d425d6476d')
		})

		test('float', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-float.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-mono-float.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-float.png').arrayBuffer(), 'hex')).toBe('e67940309bcc520ff79bbbde35530750')
		})

		test('double', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-double.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-mono-double.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-double.png').arrayBuffer(), 'hex')).toBe('e67940309bcc520ff79bbbde35530750')
		})
	})

	describe('color', () => {
		test('byte', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-byte.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-color-byte.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-byte.png').arrayBuffer(), 'hex')).toBe('870ac19a84ef38ec58f27c9f3fcf9624')
		})

		test('short', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-short.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-color-short.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-short.png').arrayBuffer(), 'hex')).toBe('425102b2ef786309ac746e0af5ec463f')
		})

		test('integer', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-integer.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-color-integer.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-integer.png').arrayBuffer(), 'hex')).toBe('5879055756829ed1455ab50de84babe8')
		})

		test('float', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-float.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-color-float.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-float.png').arrayBuffer(), 'hex')).toBe('edefee01963ff38abbb83e258fc18310')
		})

		test('double', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-double.fits'))
			const image = await fromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await toFormat(stf(image!, 0.001), '.cache/NGC3372-color-double.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-double.png').arrayBuffer(), 'hex')).toBe('edefee01963ff38abbb83e258fc18310')
		})
	})
})
