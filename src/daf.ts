import { readUntil, type Seekable, type Source } from './io'

export interface Summary {
	readonly name: string
	readonly doubles: readonly number[]
	readonly ints: readonly number[]
}

export interface Daf {
	readonly summaries: Summary[]
	readonly read: (start: number, end: number) => Promise<Float64Array>
}

export interface DafRecord {
	readonly be: boolean
	readonly nd: number
	readonly ni: number
	readonly fward: number
	readonly bward: number
}

const FTPSTR = Buffer.from('FTPSTR:\r:\n:\r\n:\r\x00:\x81:\x10\xCE:ENDFTP', 'ascii')

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/daf.html
export async function read(source: Source & Seekable): Promise<Daf> {
	const buffer = Buffer.allocUnsafe(1024)

	await readRecord(source, 1, buffer)

	const format = buffer.toString('ascii', 0, 8)

	async function read(start: number, end: number, { be }: DafRecord) {
		source.seek(8 * (start - 1))
		const length = 1 + end - start
		const buffer = Buffer.allocUnsafe(length * 8)
		await readUntil(source, buffer)

		const data = new Float64Array(length)

		for (let i = 0, m = 0; i < length; i++, m += 8) {
			data[i] = be ? buffer.readDoubleBE(m) : buffer.readDoubleLE(m)
		}

		return data
	}

	if (format === 'NAIF/DAF') {
		const record = readNaifDafRecord(buffer)
		const summaries = await readSummaries(source, record)

		return {
			summaries,
			read: (start, end) => read(start, end, record),
		}
	} else if (format.startsWith('DAF/')) {
		if (FTPSTR.equals(buffer.subarray(699, 699 + 28))) {
			const be = buffer.toString('ascii', 88, 96).toUpperCase() !== 'LTL-IEEE'
			const record = readNaifDafRecord(buffer, be)
			const summaries = await readSummaries(source, record)

			return {
				summaries,
				read: (start, end) => read(start, end, record),
			}
		} else {
			throw new Error('file has been damaged')
		}
	}

	throw new Error(`unsupported format: ${format}`)
}

async function readRecord(source: Source & Seekable, index: number, buffer: Buffer) {
	source.seek((index - 1) * 1024)
	return (await readUntil(source, buffer)) === 1024
}

function readNaifDafRecord(buffer: Buffer, be?: boolean): DafRecord {
	let nd: number

	if (be === undefined) {
		// Big-endian format?
		be = true
		// The number of double precision components in each array summary.
		nd = buffer.readUInt32BE(8)

		// Little-endian format?
		if (nd !== 2) {
			be = false
			nd = buffer.readUInt32LE(8)

			if (nd !== 2) throw new Error('neither a big nor a little-endian scan of this file produces the expected ND=2')
		}
	} else {
		// The number of integer components in each array summary.
		nd = be ? buffer.readUInt32BE(8) : buffer.readUInt32LE(8)
	}

	// The number of integer components in each array summary.
	const ni = be ? buffer.readUInt32BE(12) : buffer.readUInt32LE(12)
	// The record number of the initial summary record in the file.
	const fward = be ? buffer.readUInt32BE(76) : buffer.readUInt32LE(76)
	// The record number of the final summary record in the file.
	const bward = be ? buffer.readUInt32BE(80) : buffer.readUInt32LE(80)

	return { be, nd, ni, fward, bward }
}

async function readSummaries(source: Source & Seekable, record: DafRecord) {
	const buffer = Buffer.allocUnsafe(1024)
	const summaries: Summary[] = []

	let recordNumber = record.fward
	const length = record.nd * 8 + record.ni * 4
	const stepSize = length - (length % 8)

	while (recordNumber !== 0) {
		await readRecord(source, recordNumber, buffer)
		const { next, nsum } = readSummaryControl(buffer, record)
		await readRecordSummaries(record, recordNumber, nsum, source, buffer, stepSize, summaries)
		recordNumber = next
	}

	return summaries
}

async function readRecordSummaries(record: DafRecord, index: number, count: number, source: Source & Seekable, data: Buffer, stepSize: number, summaries: Summary[]) {
	const buffer = Buffer.allocUnsafe(1024)
	await readRecord(source, index + 1, buffer)

	const size = record.nd * 8 + record.ni * 4

	for (let i = 0; i < count * stepSize; i += stepSize) {
		const name = buffer.toString('ascii', i, i + stepSize).trim()
		const a = 24 + i
		const [doubles, ints] = readSummaryElements(data.subarray(a, a + size), record)
		summaries.push({ name, doubles, ints })
	}

	return summaries
}

function readSummaryControl(buffer: Buffer, { be }: DafRecord) {
	const next = Math.trunc(be ? buffer.readDoubleBE(0) : buffer.readDoubleLE(0))
	const prev = Math.trunc(be ? buffer.readDoubleBE(8) : buffer.readDoubleLE(8))
	const nsum = Math.trunc(be ? buffer.readDoubleBE(16) : buffer.readDoubleLE(16))
	return { next, prev, nsum }
}

function readSummaryElements(buffer: Buffer, { be, nd, ni }: DafRecord): readonly [readonly number[], readonly number[]] {
	const doubles = new Array<number>(nd)
	const ints = new Array<number>(ni)

	let offset = 0
	for (let i = 0; i < nd; i++, offset += 8) doubles[i] = be ? buffer.readDoubleBE(offset) : buffer.readDoubleLE(offset)
	for (let i = 0; i < ni; i++, offset += 4) ints[i] = be ? buffer.readInt32BE(offset) : buffer.readInt32LE(offset)

	return [doubles, ints]
}
