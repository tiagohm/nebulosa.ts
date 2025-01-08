import type { PathLike } from 'fs'
import type { FileHandle } from 'fs/promises'
import fs from 'fs/promises'

export type FitsHeader = Record<string, FitsHeaderItem | undefined>

export interface FitsHeaderItem {
	value: string | number | boolean | undefined
	comment?: string
}

export interface FitsData {
	handle?: FileHandle
	buffer?: Buffer
	size: number
	offset: number
}

export interface FitsHdu {
	header: FitsHeader
	data?: FitsData
}

export interface Fits {
	hdus: FitsHdu[]
	close: () => Promise<void>
}

export enum BitPix {
	BYTE = 8,
	SHORT = 16,
	INTEGER = 32,
	LONG = 64,
	FLOAT = -32,
	DOUBLE = -64,
}

export function naxis(header: FitsHeader, value: number = 0) {
	return (header.NAXIS?.value as number | undefined) ?? value
}

export function naxisn(header: FitsHeader, n: number, value: number = 0) {
	return (header[`NAXIS${n}`]?.value as number | undefined) ?? value
}

export function bitPix(header: FitsHeader): BitPix | 0 {
	return (header.BITPIX?.value as BitPix | undefined) ?? 0
}

const BLOCK_SIZE = 2880
const MAGIC_BYTES = Buffer.from('SIMPLE', 'ascii')

export async function read(path: PathLike): Promise<Fits | undefined> {
	const handle = await fs.open(path, 'r')
	const buffer = Buffer.alloc(BLOCK_SIZE)

	await handle.read(buffer, 0, 6, 0)

	if (!buffer.subarray(0, 6).equals(MAGIC_BYTES)) {
		await handle.close()
		return undefined
	}

	let position = 0
	const hdus: FitsHdu[] = []

	while (true) {
		if (position > 0 && hdus.length === 0) {
			await handle.close()
			return undefined
		}

		const result = await handle.read(buffer, 0, BLOCK_SIZE, position)
		if (result.bytesRead === 0) break
		position += BLOCK_SIZE

		for (let i = 0; i < 36; i++) {
			const [keyword, item] = parseHeader(buffer, i)

			if (keyword === 'SIMPLE' || keyword === 'XTENSION') {
				hdus.push({ header: { [keyword]: item } })
			} else {
				const hdu = hdus[hdus.length - 1]
				const { header } = hdu

				if (!keyword || keyword === 'END') {
					const size = naxis(header) * naxisn(header, 1) * naxisn(header, 2) * Math.abs(bitPix(header) / 8)

					if (size <= 0) {
						await handle.close()
						return undefined
					}

					const offset = position

					if (size % BLOCK_SIZE !== 0) position += BLOCK_SIZE - (size % BLOCK_SIZE)
					position += size

					hdu.data = { handle, size, offset }
					break
				} else if (item.value === undefined && !item.comment) {
					continue
				} else if (item.value === undefined) {
					const card = header[keyword]

					if (card) card.comment! += `\n${item.comment}`
					else header[keyword] = item
				} else {
					header[keyword] = item
				}
			}
		}
	}

	return { hdus, close: () => handle.close() }
}

const HEADER_CARD_SIZE = 80
const MAX_KEYWORD_LENGTH = 8

function parseHeader(data: Buffer, offset: number): [string, FitsHeaderItem] {
	const size = offset * HEADER_CARD_SIZE
	const card = data.toString('ascii', size, size + HEADER_CARD_SIZE)

	const key = card.slice(0, MAX_KEYWORD_LENGTH).trim()

	const commentStartIndex = card.indexOf('/')
	const keyEndIndex = card.indexOf('=')

	if (commentStartIndex >= 0) {
		const comment = card.slice(commentStartIndex + 1).trim()
		const value = card.slice(MAX_KEYWORD_LENGTH + 1, commentStartIndex).trim()
		return [key, { value: parseValue(value), comment }]
	} else if (keyEndIndex >= 0 && keyEndIndex <= MAX_KEYWORD_LENGTH) {
		const value = card.slice(keyEndIndex + 1).trim()
		return [key, { value: parseValue(value) }]
	} else {
		const comment = card.slice(key.length + 1).trim()
		return [key, { value: undefined, comment }]
	}
}

const DECIMAL_REGEX = new RegExp('^[+-]?\\d+(\\.\\d*)?([dDeE][+-]?\\d+)?$')
const INT_REGEX = new RegExp('^[+-]?\\d+$')

function parseValue(value: string) {
	if (!value) return undefined
	else if (value === 'T') return true
	else if (value === 'F') return false
	else if (value.startsWith("'") && value.endsWith("'")) return value.substring(1, value.length - 1).trim()
	else if (DECIMAL_REGEX.test(value)) return parseFloat(value.toUpperCase().replace('D', 'E'))
	else if (INT_REGEX.test(value)) return parseInt(value)
	else return value
}
