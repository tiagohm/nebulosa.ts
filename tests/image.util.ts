import { expect } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, type Fits, readFits } from '../src/fits'
import { readImageFromFits, writeImageToFormat } from '../src/image'
import type { Image } from '../src/image.types'
import { bufferSource, fileHandleSource } from '../src/io'

export type ImageFormat = 'fit' | 'xisf'

export const BITPIXES: readonly Bitpix[] = [8, 16, 32, -32, -64]
export const CHANNELS = [1, 3] as const

export async function openFitsFromFileHandle<T = void>(bitpix: Bitpix, channel: number, action: (fits: Fits) => PromiseLike<T> | T, name?: string) {
	const handle = await fs.open(`data/${name || 'NGC3372'}-${bitpix}.${channel}.fit`)
	await using source = fileHandleSource(handle)
	const fits = await readFits(source)
	return await action(fits!)
}

export async function openFitsFromBuffer<T = void>(bitpix: Bitpix, channel: number, action: (fits: Fits) => PromiseLike<T> | T, name?: string | Buffer) {
	const buffer = !name || typeof name === 'string' ? Buffer.from(await Bun.file(`data/${name || 'NGC3372'}-${bitpix}.${channel}.fit`).arrayBuffer()) : name
	const fits = await readFits(bufferSource(buffer))
	return [await action(fits!), buffer] as const
}

export function readImage(bitpix: Bitpix, channel: number, action?: (image: Image, fits: Fits) => PromiseLike<Image> | Image, format: ImageFormat = 'fit', name?: string) {
	const readImageFromFitsAndAction = async (fits: Fits) => {
		const image = await readImageFromFits(fits)
		return [(await action?.(image!, fits)) ?? image!, fits] as const
	}

	return openFitsFromFileHandle(bitpix, channel, readImageFromFitsAndAction, name)
}

export async function saveImageAndCompareHash(image: Image, name: string, hash?: string) {
	const jpeg = writeImageToFormat(image, 'jpeg')
	expect(jpeg).toBeDefined()
	await saveAndCompareHash(jpeg!, `${name}.jpg`, hash)
	return image
}

export async function readImageTransformAndSave(action: (image: Image) => PromiseLike<Image> | Image, outputName: string, hash?: string, bitpix: Bitpix = Bitpix.FLOAT, channel: number = 3, format?: ImageFormat, inputName?: string) {
	const [image] = await readImage(bitpix, channel, action, format, inputName)
	return saveImageAndCompareHash(image, outputName, hash)
}

export async function saveAndCompareHash(input: NodeJS.TypedArray | ArrayBufferLike | Blob, name: string, hash?: string, force?: boolean) {
	if (process.env.SAVE_IMAGE || force) await Bun.write(`out/${name}`, input)
	const hex = Bun.MD5.hash(input, 'hex')
	if (hash) expect(hex).toBe(hash)
	else console.info(name, hex)
}
