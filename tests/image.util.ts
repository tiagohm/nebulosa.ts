import { expect } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, type Fits, readFits } from '../src/fits'
import { type Image, readImageFromFits, writeImageToFormat } from '../src/image'
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

export async function saveImage(image: Image, name: string, hash?: string) {
	const output = `out/${name}.png`
	await writeImageToFormat(image, output, 'png')
	const hex = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	if (hash) expect(hex).toBe(hash)
	else console.info(name, hex)
}

export async function readImageAndTransformAndSaveImage(action: (image: Image) => Image, name: string, hash?: string, bitpix: Bitpix = Bitpix.DOUBLE, channel: number = 3) {
	const a = await readImage(bitpix, channel)
	saveImage(action(a[1]), name, hash)
	return a
}
