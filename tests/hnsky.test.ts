import { expect, test } from 'bun:test'

import { deg, hour, normalizeAngle } from '../src/angle'
import { PIOVERTWO, TAU } from '../src/constants'
import { findHnsky290Areas, findHnsky290Region, findHnsky290Stars, formatHnskyId, type Hnsky290RegionQuery, type HnskyRecordSize, hnsky290AreaFile, openHnskyCatalog, readHnsky290Area, readHnsky290Header } from '../src/hnsky'
import { downloadPerTag } from './download'

await downloadPerTag('hnsky')

const RA_SCALE = TAU / 0xffffff
const DEC_SCALE = PIOVERTWO / 0x7fffff

interface SyntheticStar {
	readonly rightAscension: number
	readonly declination: number
	readonly magnitude: number
	readonly bpRp?: number
	readonly designation?: number
}

interface SyntheticCase {
	readonly recordSize: HnskyRecordSize
	readonly star: SyntheticStar
	readonly outside: SyntheticStar
}

const REGION_QUERY: Hnsky290RegionQuery = { rightAscension: hour(2), declination: deg(5), radius: deg(1) }

const FORMAT_CASES: readonly SyntheticCase[] = [
	{
		recordSize: 5,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4 },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.4 },
	},
	{
		recordSize: 6,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4, bpRp: 1.2 },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.4, bpRp: 0.3 },
	},
	{
		recordSize: 7,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4 },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.5 },
	},
	{
		recordSize: 9,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4, designation: -((1234 << 16) | 42) },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.4, designation: -((1234 << 16) | 43) },
	},
	{
		recordSize: 10,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4, designation: (321 << 20) | 12345 },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.4, designation: (321 << 20) | 12346 },
	},
	{
		recordSize: 11,
		star: { rightAscension: hour(2.02), declination: deg(5.1), magnitude: 1.4, designation: -((200 << 16) | 55 | 0x40000000) },
		outside: { rightAscension: hour(4), declination: deg(5.12), magnitude: 1.5, designation: -((200 << 16) | 56 | 0x40000000) },
	},
] as const

test('findHnsky290Areas selects intersecting tiles around an RA boundary', () => {
	const areas = findHnsky290Areas(deg(11.1), deg(5), deg(4))
	const files = areas.map((area) => area.fileName).sort()

	expect(files).toEqual(['1001.290', '1002.290'])
	expect(areas[0]!.fraction).toBeGreaterThan(0)
	expect(areas[1]!.fraction).toBeGreaterThan(0)
})

test('readHnsky290Area decodes documented record formats', () => {
	for (const entry of FORMAT_CASES) {
		const buffer = makeSyntheticFile(entry)
		const header = readHnsky290Header(buffer)
		const stars = []

		for (const star of readHnsky290Area(header, buffer, 146, REGION_QUERY)) {
			stars.push(star)
		}

		expect(stars).toHaveLength(1)

		const [star] = stars
		expect(star!.area).toBe(146)
		expect(star!.rightAscension).toBeCloseTo(entry.star.rightAscension, 6)
		expect(star!.declination).toBeCloseTo(entry.star.declination, 6)
		expect(star!.magnitude).toBeCloseTo(entry.star.magnitude, 6)

		if (entry.star.bpRp === undefined) {
			expect(star!.bpRp).toBeUndefined()
		} else {
			expect(star!.bpRp).toBeCloseTo(entry.star.bpRp, 6)
		}

		if (entry.recordSize === 9) {
			expect(star!.designation?.label).toBe('TYC 1234-42-1')
		} else if (entry.recordSize === 10) {
			expect(star!.designation?.label).toBe('UCAC4 321-12345')
		} else if (entry.recordSize === 11) {
			expect(star!.designation?.label).toBe('TYC 200-55-2')
		} else {
			expect(star!.designation).toBeUndefined()
		}
	}
})

test('findHnsky290Region merges stars from intersecting files', async () => {
	const query: Hnsky290RegionQuery = { rightAscension: deg(11.1), declination: deg(5), radius: deg(2) }

	const archive = {
		[`g14_${hnsky290AreaFile(146).fileName}`]: makeSyntheticFile({ recordSize: 11, star: { rightAscension: deg(10.5), declination: deg(5.1), magnitude: 2.2, designation: (100 << 20) | 1 }, outside: { rightAscension: deg(30), declination: deg(5.1), magnitude: 2.3, designation: (100 << 20) | 2 } }),
		[`g14_${hnsky290AreaFile(147).fileName}`]: makeSyntheticFile({ recordSize: 11, star: { rightAscension: deg(11.7), declination: deg(4.9), magnitude: 1.1, designation: (101 << 20) | 1 }, outside: { rightAscension: deg(40), declination: deg(4.9), magnitude: 1.2, designation: (101 << 20) | 2 } }),
	}

	const result = await findHnsky290Region(archive, 'g14', query)
	const files = result.areas.map((area) => area.fileName).sort()

	expect(files).toEqual(['1001.290', '1002.290'])
	expect(result.headers).toHaveLength(2)
	expect(result.stars).toHaveLength(2)
	expect(result.stars[0]!.magnitude).toBeCloseTo(1.1, 6)
	expect(result.stars[1]!.magnitude).toBeCloseTo(2.2, 6)
	expect(result.stars[0]!.designation?.label).toBe('UCAC4 101-1')
	expect(result.stars[1]!.designation?.label).toBe('UCAC4 100-1')
})

test('HnskyCatalog exposes .290 archives through the generic star catalog API', async () => {
	const archive = {
		[`g14_${hnsky290AreaFile(146).fileName}`]: makeSyntheticFile({ recordSize: 11, star: { rightAscension: deg(10.5), declination: deg(5.1), magnitude: 2.2, designation: (100 << 20) | 1 }, outside: { rightAscension: deg(30), declination: deg(5.1), magnitude: 2.3, designation: (100 << 20) | 2 } }),
		[`g14_${hnsky290AreaFile(147).fileName}`]: makeSyntheticFile({ recordSize: 11, star: { rightAscension: deg(11.7), declination: deg(4.9), magnitude: 1.1, designation: (101 << 20) | 1 }, outside: { rightAscension: deg(40), declination: deg(4.9), magnitude: 1.2, designation: (101 << 20) | 2 } }),
	}

	const catalog = openHnskyCatalog(archive, 'g14')

	try {
		const cone = await catalog.queryCone(deg(11.1), deg(5), deg(2))
		const box = await catalog.queryBox(deg(10), deg(12), deg(4.5), deg(5.5))

		expect(cone.map((e) => e.id).sort()).toEqual([formatHnskyId('g14', 146, 1), formatHnskyId('g14', 147, 1)])
		expect(box.map((e) => e.id).sort()).toEqual([formatHnskyId('g14', 146, 1), formatHnskyId('g14', 147, 1)])
		expect(cone[0]!.epoch).toBe(2000)

		const star = await catalog.get(cone[1]!.id)

		expect(star?.id).toBe(formatHnskyId('g14', 147, 1))
		expect(star?.magnitude).toBeCloseTo(1.1, 6)
		expect(star?.designation?.label).toBe('UCAC4 101-1')
	} finally {
		await catalog.close()
	}
})

test('read g14 database', async () => {
	const files = new Bun.Archive(await Bun.file('data/HNSKY_g14.tar').arrayBuffer())
	const stars = await findHnsky290Stars(await files.files(), 'g14', { rightAscension: 0, declination: 0, radius: deg(0.5) })
	expect(stars.length).toBe(97)
})

// Builds a minimal synthetic .290 file for one record format.
function makeSyntheticFile(entry: SyntheticCase) {
	const records = []

	switch (entry.recordSize) {
		case 5:
			records.push(makeCompactHeaderRecord(entry.star))
			records.push(makeCompactRecord(entry.star))
			records.push(makeCompactRecord(entry.outside))
			break
		case 6:
			records.push(makeCompactHeaderRecord(entry.star, true))
			records.push(makeCompactRecord(entry.star, true))
			records.push(makeCompactRecord(entry.outside, true))
			break
		case 7:
			records.push(makeFullRecord(entry.star, 7))
			records.push(makeFullRecord(entry.outside, 7))
			break
		case 9:
			records.push(makeCompactHeaderRecord(entry.star, false, true))
			records.push(makeCompactRecord(entry.star, false, true))
			records.push(makeCompactRecord(entry.outside, false, true))
			break
		case 10:
			records.push(makeMagnitudeHeaderRecord(entry.star))
			records.push(makeFullRecord(entry.star, 10))
			records.push(makeFullRecord(entry.outside, 10))
			break
		case 11:
			records.push(makeFullRecord(entry.star, 11))
			records.push(makeFullRecord(entry.outside, 11))
			break
	}

	return Buffer.concat([makeHeader(entry.recordSize), ...records])
}

// Creates the shared 110-byte .290 file header.
function makeHeader(recordSize: SyntheticCase['recordSize']) {
	const header = Buffer.alloc(110, 0x20)
	header.write('synthetic hnsky test', 'ascii')
	header[109] = recordSize
	return header
}

// Creates the compact 5/6/9 header record carrying magnitude and dec-high.
function makeCompactHeaderRecord(star: SyntheticStar, withColor: boolean = false, withDesignation: boolean = false) {
	const { decHigh } = encodeDeclination(star.declination)
	const buffer = Buffer.alloc(withDesignation ? 9 : withColor ? 6 : 5)
	let offset = 0

	if (withDesignation) {
		buffer.writeInt32LE(0, 0)
		offset += 4
	}

	buffer.writeUIntLE(0xffffff, offset, 3)
	buffer[offset + 3] = decHigh + 128
	buffer[offset + 4] = encodeMagnitudeHeader(star.magnitude)

	if (withColor) {
		buffer.writeInt8(0, offset + 5)
	}

	return buffer
}

// Creates a compact 5/6/9 star record using the header-provided fields.
function makeCompactRecord(star: SyntheticStar, withColor: boolean = false, withDesignation: boolean = false) {
	const { raBytes, decBytes } = encodeCoordinates(star.rightAscension, star.declination)
	const buffer = Buffer.alloc(withDesignation ? 9 : withColor ? 6 : 5)
	let offset = 0

	if (withDesignation) {
		buffer.writeInt32LE(star.designation ?? 0, 0)
		offset += 4
	}

	raBytes.copy(buffer, offset)
	buffer[offset + 3] = decBytes[0]!
	buffer[offset + 4] = decBytes[1]!

	if (withColor) {
		buffer.writeInt8(Math.round((star.bpRp ?? 0) * 10), offset + 5)
	}

	return buffer
}

// Creates the 10-byte magnitude section header record.
function makeMagnitudeHeaderRecord(star: SyntheticStar) {
	const buffer = Buffer.alloc(10)
	buffer.writeInt32LE(0, 0)
	buffer.writeUIntLE(0xffffff, 4, 3)
	buffer[7] = 0
	buffer[8] = 0
	buffer.writeInt8(Math.round(star.magnitude * 10), 9)
	return buffer
}

// Creates a full 7/10/11 record with explicit declination high bits.
function makeFullRecord(star: SyntheticStar, recordSize: 7 | 10 | 11) {
	const { raBytes, decBytes } = encodeCoordinates(star.rightAscension, star.declination)
	const buffer = Buffer.alloc(recordSize)
	let offset = 0

	if (recordSize >= 10) {
		buffer.writeInt32LE(star.designation ?? 0, 0)
		offset += 4
	}

	raBytes.copy(buffer, offset)
	buffer[offset + 3] = decBytes[0]!
	buffer[offset + 4] = decBytes[1]!
	buffer.writeInt8(decBytes.readInt8(2), offset + 5)

	if (recordSize === 7) {
		buffer.writeInt8(Math.round(star.magnitude * 10), offset + 6)
	} else if (recordSize === 11) {
		buffer.writeInt8(decBytes.readInt8(2), offset + 5)
		buffer.writeInt8(Math.round(star.magnitude * 10), offset + 6)
	}

	return buffer
}

// Encodes RA and declination into the packed .290 coordinate bytes.
function encodeCoordinates(rightAscension: number, declination: number) {
	const raBytes = Buffer.alloc(3)
	const raRaw = Math.round(normalizeAngle(rightAscension) / RA_SCALE)
	raBytes.writeUIntLE(raRaw === 0x1000000 ? 0xffffff : raRaw, 0, 3)
	const decBytes = encodeDeclination(declination).decBytes
	return { raBytes, decBytes }
}

// Encodes the signed 24-bit declination representation.
function encodeDeclination(declination: number) {
	const decRaw = Math.max(-0x800000, Math.min(0x7fffff, Math.round(declination / DEC_SCALE)))
	const decBytes = Buffer.alloc(3)
	decBytes.writeIntLE(decRaw, 0, 3)
	return { decBytes, decHigh: decBytes.readInt8(2) }
}

// Encodes the 5/6/9 magnitude header byte with the documented +16 offset.
function encodeMagnitudeHeader(magnitude: number) {
	return Math.round(magnitude * 10) + 16
}
