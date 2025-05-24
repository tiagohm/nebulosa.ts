import { expect } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, type Fits, readFits } from '../src/fits'
import { type Image, type WriteImageToFormatOptions, readImageFromFits, writeImageToFormat } from '../src/image'
import { fileHandleSource } from '../src/io'

export const BITPIXES: readonly Bitpix[] = [8, 16, 32, -32, -64]
export const CHANNELS = [1, 3] as const

const bucket = new Map<string, readonly [Fits, fs.FileHandle]>()

export async function openFits(bitpix: Bitpix, channel: number, format: string = 'fit', name: string = 'NGC3372') {
	const key = `${name}-${bitpix}.${channel}.${format}`

	let fits = bucket.get(key)

	if (!fits) {
		const handle = await fs.open(`data/${key}`)
		const source = fileHandleSource(handle)
		fits = [(await readFits(source))!, handle]
		bucket.set(key, fits)
	}

	return fits[0]
}

export async function readImage(bitpix: Bitpix, channel: number, format: string = 'fit', name: string = 'NGC3372') {
	const fits = await openFits(bitpix, channel, format, name)
	const image = await readImageFromFits(fits)
	return [fits, image!] as const
}

export async function saveImageAndCompareHash(image: Image, name: string, hash?: string, options?: WriteImageToFormatOptions) {
	const output = `out/${name}.png`
	await writeImageToFormat(image, output, 'png', options)
	const hex = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	if (hash) expect(hex).toBe(hash)
	else console.info(name, hex)
	return image
}

export async function readImageAndTransformAndSaveImage(action: (image: Image) => Image, outputName: string, hash?: string, bitpix: Bitpix = Bitpix.FLOAT, channel: number = 3, format?: string, inputName?: string) {
	const a = await readImage(bitpix, channel, format, inputName)
	const b = action(a[1])
	return saveImageAndCompareHash(b, outputName, hash)
}

export async function readImageAndSaveImageWithOptions(options: WriteImageToFormatOptions, outputName: string, hash?: string, bitpix: Bitpix = Bitpix.FLOAT, channel: number = 3, format?: string, inputName?: string) {
	const a = await readImage(bitpix, channel, format, inputName)
	return saveImageAndCompareHash(a[1], outputName, hash, options)
}
