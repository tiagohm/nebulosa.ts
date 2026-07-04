import { expect, test } from 'bun:test'
import { astap1476AreaFile, ASTAP_1476_DEC_BOUNDARIES, findAstap1476Areas, openAstapCatalog, readAstap1476Area, readAstap1476Header, type Astap1476RegionQuery } from '../../../src/catalogs/stars/astap'
import { PIOVERTWO, TAU } from '../../../src/core/constants'
import { deg, hour, normalizeAngle, toDeg } from '../../../src/math/units/angle'

const RA_SCALE = TAU / 0xffffff
const DEC_SCALE = PIOVERTWO / 0x7fffff

test('astap1476AreaFile maps area numbers to band/cell file names', () => {
	expect(astap1476AreaFile(1)).toMatchObject({ area: 1, ring: 1, index: 1, fileName: '0101.1476' })
	// Band 18 (0-based 17) holds 69 RA cells and starts at area 670 (the first 17 bands hold 669 areas).
	expect(astap1476AreaFile(670)).toMatchObject({ ring: 18, index: 1, fileName: '1801.1476' })
	expect(astap1476AreaFile(738)).toMatchObject({ ring: 18, index: 69, fileName: '1869.1476' })
	expect(astap1476AreaFile(1476)).toMatchObject({ area: 1476, ring: 36, index: 1, fileName: '3601.1476' })
})

test('the 1476 tiling has 36 bands summing to 1476 areas', () => {
	expect(ASTAP_1476_DEC_BOUNDARIES).toHaveLength(37)
	expect(ASTAP_1476_DEC_BOUNDARIES[0]).toBeCloseTo(-PIOVERTWO, 12)
	expect(ASTAP_1476_DEC_BOUNDARIES[36]).toBeCloseTo(PIOVERTWO, 12)
	// The last area number returned for the north pole cap must be exactly 1476.
	expect(astap1476AreaFile(1476).area).toBe(1476)
})

test('findAstap1476Areas selects the polar cap and equatorial cells', () => {
	const southCap = findAstap1476Areas(deg(0), deg(-89.9), deg(0.5))
	expect(southCap.map((a) => a.fileName)).toEqual(['0101.1476'])

	const northCap = findAstap1476Areas(deg(0), deg(89.9), deg(0.5))
	expect(northCap.map((a) => a.fileName)).toEqual(['3601.1476'])

	// A small equatorial field falls in band 18/19 (0 deg boundary) and touches a couple of RA cells.
	const equator = findAstap1476Areas(deg(0.1), deg(0), deg(1))
	expect(equator.length).toBeGreaterThanOrEqual(1)
	expect(equator.every((a) => a.ring === 18 || a.ring === 19)).toBe(true)
})

test('readAstap1476Area decodes a 6-byte record and recovers Johnson B-V', () => {
	const star = { rightAscension: hour(2.02), declination: deg(2.1), magnitude: 7.3, bv: 0.62 }
	const outside = { rightAscension: hour(4), declination: deg(2.12), magnitude: 7.3, bv: -0.2 }
	const buffer = makeColorTile(star, outside)

	const header = readAstap1476Header(buffer)
	expect(header.recordSize).toBe(6)
	expect(header.version).toBe(2)
	expect(header.epoch).toBe(2020)

	const query: Astap1476RegionQuery = { rightAscension: hour(2), declination: deg(2), radius: deg(1) }
	const stars = [...readAstap1476Area(header, buffer, 760, query)]

	expect(stars).toHaveLength(1)
	expect(stars[0].area).toBe(760)
	expect(stars[0].rightAscension).toBeCloseTo(star.rightAscension, 6)
	expect(stars[0].declination).toBeCloseTo(star.declination, 6)
	expect(stars[0].magnitude).toBeCloseTo(star.magnitude, 6)
	expect(stars[0].bv).toBeCloseTo(star.bv, 2)
})

test('reads the real d05 south polar cap fixture', async () => {
	const buffer = Buffer.from(await Bun.file('data/d05_0101.1476').arrayBuffer())

	const header = readAstap1476Header(buffer)
	expect(header.recordSize).toBe(5)
	// The header description advertises the catalog epoch, which must be parsed and used for entries.
	expect(header.epoch).toBe(2025)

	using catalog = openAstapCatalog({ 'd05_0101.1476': buffer }, 'd05')

	// The cap tile is a whole-ring area; a box over its full declination band returns every star.
	const cap = await catalog.queryBox(deg(0), deg(360), deg(-90), deg(-87.42857143))
	expect(cap).toHaveLength(10387)
	expect(cap.every((s) => s.area === 1 && s.epoch === 2025 && s.bv === undefined)).toBe(true)
	expect(cap.every((s) => toDeg(s.declination) <= -87.42857143 + 1e-6)).toBe(true)

	// Results are merged in ascending magnitude order across the tile.
	for (let i = 1; i < cap.length; i++) {
		expect(cap[i].magnitude).toBeGreaterThanOrEqual(cap[i - 1].magnitude)
	}

	expect(await catalog.queryCone(deg(0), deg(-89.5), deg(0.5))).toHaveLength(374)
	expect(await catalog.queryCone(deg(0), deg(-88.5), deg(1))).toHaveLength(1468)

	const record = await catalog.get('d05', 1, 2)
	expect(record?.area).toBe(1)
	expect(record?.recordNumber).toBe(2)
	expect(record?.magnitude).toBeCloseTo(5.5, 6)
	expect(record?.epoch).toBe(2025)
})

// Builds a minimal synthetic 6-byte .1476 tile: a compact header record followed by an in-field star and
// an out-of-field star, all sharing the header-provided magnitude and declination-high byte.
function makeColorTile(star: SyntheticStar, outside: SyntheticStar) {
	return Buffer.concat([makeHeader(6, 2), makeColorHeaderRecord(star), makeColorRecord(star), makeColorRecord(outside)])
}

interface SyntheticStar {
	readonly rightAscension: number
	readonly declination: number
	readonly magnitude: number
	readonly bv: number
}

// Creates the shared 110-byte .1476 header carrying a version byte and an "Epoch=" tag in the description.
function makeHeader(recordSize: number, version: number) {
	const header = Buffer.alloc(110, 0x20)
	header.write('synthetic astap test, Epoch=2020', 'ascii')
	header[108] = version
	header[109] = recordSize
	return header
}

// Creates the compact 6-byte header record carrying magnitude and dec-high shared by following records.
function makeColorHeaderRecord(star: SyntheticStar) {
	const { decHigh } = encodeDeclination(star.declination)
	const buffer = Buffer.alloc(6)
	buffer.writeUIntLE(0xffffff, 0, 3)
	buffer[3] = decHigh + 128
	buffer[4] = Math.round(star.magnitude * 10) + 16
	buffer.writeInt8(0, 5)
	return buffer
}

// Creates a compact 6-byte star record with a signed B-V*50 color byte.
function makeColorRecord(star: SyntheticStar) {
	const { raBytes, decBytes } = encodeCoordinates(star.rightAscension, star.declination)
	const buffer = Buffer.alloc(6)
	raBytes.copy(buffer, 0)
	buffer[3] = decBytes[0]!
	buffer[4] = decBytes[1]!
	buffer.writeInt8(Math.round(star.bv * 50), 5)
	return buffer
}

// Encodes RA and declination into the packed .1476 coordinate bytes.
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
