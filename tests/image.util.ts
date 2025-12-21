import { expect } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, type Fits, readFits } from '../src/fits'
import { type Image, readImageFromFits, type WriteImageToFormatOptions, writeImageToFormat } from '../src/image'
import { fileHandleSource } from '../src/io'

export const BITPIXES: readonly Bitpix[] = [8, 16, 32, -32, -64]
export const CHANNELS = [1, 3] as const

export async function openFits<T = void>(bitpix: Bitpix, channel: number, action: (fits: Fits, key: string) => Promise<T> | T, format: string = 'fit', name: string = 'NGC3372') {
	const key = `${name}-${bitpix}.${channel}.${format}`
	const handle = await fs.open(`data/${key}`)
	await using source = fileHandleSource(handle)
	const fits = await readFits(source)
	return await action(fits!, key)
}

export function readImage(bitpix: Bitpix, channel: number, action?: (image: Image, fits: Fits) => Promise<Image> | Image, format: string = 'fit', name: string = 'NGC3372') {
	const readImageFromFitsAndAction = async (fits: Fits, key: string) => {
		const image = await readImageFromFits(fits)
		return [(await action?.(image!, fits)) ?? image!, fits] as const
	}

	return openFits(bitpix, channel, readImageFromFitsAndAction, format, name)
}

export async function saveImageAndCompareHash(image: Image, name: string, hash?: string, options?: WriteImageToFormatOptions) {
	const output = `out/${name}.png`
	await writeImageToFormat(image, output, 'png', options)
	const hex = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	if (hash) expect(hex).toBe(hash)
	else console.info(name, hex)
	return image
}

export async function readImageTransformAndSave(action: (image: Image) => Promise<Image> | Image, outputName: string, hash?: string, bitpix: Bitpix = Bitpix.FLOAT, channel: number = 3, format?: string, inputName?: string) {
	const [image] = await readImage(bitpix, channel, action, format, inputName)
	return saveImageAndCompareHash(image, outputName, hash)
}

export async function readImageAndSaveWithOptions(options: WriteImageToFormatOptions, outputName: string, hash?: string, bitpix: Bitpix = Bitpix.FLOAT, channel: number = 3, format?: string, inputName?: string) {
	const [image] = await readImage(bitpix, channel, undefined, format, inputName)
	return saveImageAndCompareHash(image, outputName, hash, options)
}

export async function saveAndCompareHash(input: NodeJS.TypedArray | ArrayBufferLike | Blob, name: string, hash?: string) {
	await Bun.write(`out/${name}`, input)
	const hex = Bun.MD5.hash(input, 'hex')
	if (hash) expect(hex).toBe(hash)
	else console.info(name, hex)
}
