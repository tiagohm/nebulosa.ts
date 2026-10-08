import { DAYSPERJY, J2000, PIOVERTWO } from '../../../core/constants'
import type { MutVec2 } from '../../../math/linear-algebra/vec2'
import { type Angle, mas, normalizeAngle } from '../../../math/units/angle'
import { kilometerPerSecond } from '../../../math/units/velocity'
import type { StarCatalogEntry } from '../catalog'

// Pure decoders for the Stellarium Gaia DR3/Hipparcos star catalog files (`stars_<level>_<type>v<major>_<minor>.cat`).
// A file is a 28-byte little-endian header, a table of `20 × 4^level + 1` unsigned 32-bit star counts (one per
// geodesic zone, the last one being the global zone) and the star records grouped by zone, each zone sorted by
// ascending V magnitude. Three record layouts exist: Star1 (48 bytes, absolute direction vector, vector proper
// motion, parallax, radial velocity and Hipparcos identifier), Star2 (32 bytes, RA/Dec in mas, dα/dt and dδ/dt
// in µas/yr, parallax) and Star3 (16 bytes, RA/Dec in 0.1″, no motion). Angles are returned in radians,
// proper motions in radians per Julian year, radial velocities in AU/day and magnitudes in mag. The decoders
// read from caller-owned Buffers at absolute byte offsets (respecting the Buffer's own byteOffset), never
// allocate except for the returned entry, and do not perform any I/O.
// Format reference: Stellarium src/core/modules/Star.hpp and ZoneArray.cpp (stars-3.0 catalogs, version 25.1+).

// Header magic of the canonical little-endian files, read as a little-endian uint32 (bytes 0a 04 5f 83).
export const STELLARIUM_STAR_FILE_MAGIC = 0x835f040a
// Header magic of a byte-swapped (big-endian) file, as read little-endian; rejected because only the header and
// counts would be swappable while upstream stores the records little-endian anyway.
export const STELLARIUM_STAR_FILE_MAGIC_OTHER_ENDIAN = 0x0a045f83
// Header magic of a host-native file written by old Stellarium builds; rejected because its record layout is
// not verified.
export const STELLARIUM_STAR_FILE_MAGIC_NATIVE = 0x835f040b
// Byte size of the fixed file header: magic, type, major, minor, level, minimum magnitude and epoch.
export const STELLARIUM_STAR_HEADER_SIZE = 28
// Highest supported major file version; upstream also reads only major 0 and accepts any minor version.
export const STELLARIUM_STAR_MAX_MAJOR_VERSION = 0
// Highest accepted geodesic level. The published catalogs stop at level 8; the bound keeps the zone table of a
// malformed header (4 × (20 × 4^level + 1) bytes, about 84 MB at level 10) from becoming a huge allocation.
export const STELLARIUM_STAR_MAX_LEVEL = 10
// Byte size of one zone count in the zone table.
export const STELLARIUM_STAR_ZONE_COUNT_SIZE = 4
// Upper bound (exclusive) of the records of one file, so that the zone prefix sums fit in a Uint32Array.
export const STELLARIUM_STAR_MAX_RECORDS = 0x100000000

// Record layout code stored in the header: 0 = Star1, 1 = Star2, 2 = Star3.
export type StellariumStarDataType = 0 | 1 | 2

// Bytes per record of each layout: 48 (Star1), 32 (Star2) and 16 (Star3).
export type StellariumStarRecordSize = 48 | 32 | 16

// Record size of each data type, indexed by the data type code.
const RECORD_SIZES = [48, 32, 16] as const

// Smallest cos(δ) for which dα/dt = μα* / cos δ is reported; closer to a pole the RA rate is left undefined.
const MIN_COS_DEC_FOR_PMRA = 1e-9
// Star3 declination offset, in 0.1″ units: the stored value is δ + 90°.
const STAR3_DEC_OFFSET = 90 * 36000

// Parsed and validated header of one Stellarium star file.
export interface StellariumStarFileHeader {
	// Record layout code.
	readonly dataType: StellariumStarDataType
	// Bytes per record implied by the data type.
	readonly recordSize: StellariumStarRecordSize
	// Major format version (always 0 for the supported files).
	readonly majorVersion: number
	// Minor format version, informational.
	readonly minorVersion: number
	// Geodesic subdivision level of the zone table, 0..STELLARIUM_STAR_MAX_LEVEL.
	readonly level: number
	// Lower bound of the V magnitudes of the file, mag (the stored millimag value / 1000); it may be negative.
	readonly magnitudeMin: number
	// Catalog epoch as a Julian Date (TDB-like catalog convention, stored as float32; 2457389.0 = J2016.0).
	readonly epochJD: number
	// Catalog epoch as a Julian year: 2000 + (epochJD − 2451545) / 365.25.
	readonly epoch: number
	// Number of zones of the table, including the global zone: 20 × 4^level + 1.
	readonly zoneCount: number
	// Absolute byte offset of the first star record: 28 + 4 × zoneCount.
	readonly dataOffset: number
}

// Prefix sums of a zone table: zone `z` owns the records [starts[z], starts[z + 1]).
export interface StellariumStarZoneIndex {
	// zoneCount + 1 non-decreasing record numbers, starting at 0.
	readonly starts: Uint32Array
	// Total number of records of the file (starts[zoneCount]).
	readonly recordCount: number
}

// One star of a Stellarium star file, at the catalog epoch, with its physical address in the file set.
// Positions are astrometric ICRS directions at `epoch` (no precession, aberration or topocentric correction).
export interface StellariumStarCatalogEntry extends StarCatalogEntry {
	// Right ascension, radians, in [0, 2π).
	readonly rightAscension: Angle
	// Declination, radians, in [-π/2, π/2].
	readonly declination: Angle
	// Catalog epoch as a Julian year, from the file header (2016.0 for the Gaia DR3 files).
	readonly epoch: number
	// V magnitude, mag (Johnson-like V of the Stellarium processing, not Gaia G).
	readonly magnitude: number
	// Gaia DR3 source identifier, exact 64-bit value; 0n for Hipparcos stars without a Gaia counterpart.
	readonly gaiaId: bigint
	// Hipparcos number (Star1 only); undefined when the star has none.
	readonly hipId?: number
	// Hipparcos multiple-star component code (Star1 only, 5 bits; 0 means no component letter, 1 = A, 2 = B...).
	readonly componentId?: number
	// Johnson B−V color index, mag.
	readonly bv: number
	// Parallax standard error, radians; undefined when the stored value is 0 (no error).
	readonly parallaxError?: Angle
	// Index into the Hipparcos spectral type table of the catalog directory (Star1 only, raw value).
	readonly spectralIndex?: number
	// Index into the object type table of the catalog directory (Star1 only, raw value).
	readonly objectTypeIndex?: number
	// Geodesic level (file) of the star.
	readonly level: number
	// Zone of the star, 0..20 × 4^level; the last value is the global zone.
	readonly zone: number
	// Zero-based record number inside the zone.
	readonly recordNumber: number
}

// Context shared by every record of one file, needed to materialize an entry.
export interface StellariumStarRecordContext {
	// Record layout code of the file.
	readonly dataType: StellariumStarDataType
	// Catalog epoch of the file, Julian year.
	readonly epoch: number
	// Geodesic level of the file.
	readonly level: number
}

// Returns the record size of a data type.
export function stellariumStarRecordSize(dataType: StellariumStarDataType): StellariumStarRecordSize {
	return RECORD_SIZES[dataType]
}

// Returns the zone count of a level, including the global zone: 20 × 4^level + 1.
export function stellariumStarZoneCount(level: number) {
	return 20 * 4 ** level + 1
}

// Converts a Julian Date epoch to a Julian year.
export function stellariumStarEpochYear(epochJD: number) {
	return 2000 + (epochJD - J2000) / DAYSPERJY
}

// Parses and validates the 28-byte header at `offset` of `buffer` (which must hold at least 28 bytes there).
// Throws an Error naming the reason for an unknown or unsupported magic, a data type outside 0..2, a major
// version above 0, a level above STELLARIUM_STAR_MAX_LEVEL or a non-finite epoch.
export function parseStellariumStarHeader(buffer: Buffer, offset: number = 0): StellariumStarFileHeader {
	if (buffer.byteLength - offset < STELLARIUM_STAR_HEADER_SIZE) throw new Error('truncated Stellarium star file header')

	const magic = buffer.readUInt32LE(offset)

	if (magic !== STELLARIUM_STAR_FILE_MAGIC) {
		if (magic === STELLARIUM_STAR_FILE_MAGIC_OTHER_ENDIAN) throw new Error('unsupported byte-swapped Stellarium star file')
		if (magic === STELLARIUM_STAR_FILE_MAGIC_NATIVE) throw new Error('unsupported native-endian Stellarium star file')
		throw new Error(`invalid Stellarium star file magic 0x${magic.toString(16)}`)
	}

	const dataType = buffer.readUInt32LE(offset + 4)
	if (dataType !== 0 && dataType !== 1 && dataType !== 2) throw new Error(`unsupported Stellarium star data type ${dataType}`)

	const majorVersion = buffer.readUInt32LE(offset + 8)
	if (majorVersion > STELLARIUM_STAR_MAX_MAJOR_VERSION) throw new Error(`unsupported Stellarium star file major version ${majorVersion}`)

	const minorVersion = buffer.readUInt32LE(offset + 12)
	const level = buffer.readUInt32LE(offset + 16)
	if (level > STELLARIUM_STAR_MAX_LEVEL) throw new Error(`unsupported Stellarium star file level ${level}`)

	const magnitudeMin = buffer.readInt32LE(offset + 20) / 1000
	const epochJD = buffer.readFloatLE(offset + 24)
	if (!Number.isFinite(epochJD)) throw new Error('invalid Stellarium star file epoch')

	const zoneCount = stellariumStarZoneCount(level)

	return {
		dataType,
		recordSize: RECORD_SIZES[dataType],
		majorVersion,
		minorVersion,
		level,
		magnitudeMin,
		epochJD,
		epoch: stellariumStarEpochYear(epochJD),
		zoneCount,
		dataOffset: STELLARIUM_STAR_HEADER_SIZE + STELLARIUM_STAR_ZONE_COUNT_SIZE * zoneCount,
	}
}

// Builds the zone prefix sums from the little-endian count table at `offset` of `buffer`, which must hold
// 4 × zoneCount bytes there. Allocates one Uint32Array of zoneCount + 1 entries. Throws when the table is
// truncated or the total reaches 2^32 records.
export function parseStellariumStarZoneTable(buffer: Buffer, zoneCount: number, offset: number = 0): StellariumStarZoneIndex {
	if (buffer.byteLength - offset < zoneCount * STELLARIUM_STAR_ZONE_COUNT_SIZE) throw new Error('truncated Stellarium star zone table')

	const starts = new Uint32Array(zoneCount + 1)
	let total = 0

	for (let i = 0, p = offset; i < zoneCount; i++, p += STELLARIUM_STAR_ZONE_COUNT_SIZE) {
		total += buffer.readUInt32LE(p)
		// Uint32Array would silently wrap a larger running total into wrong record ranges.
		if (total >= STELLARIUM_STAR_MAX_RECORDS) throw new Error('too many records in Stellarium star file')
		starts[i + 1] = total
	}

	return { starts, recordCount: total }
}

// Reads the V magnitude of the record at byte `offset`, mag. It is exactly the `magnitude` of the decoded entry,
// so it can be compared with the query bounds before materializing the record.
export function readStellariumStarMagnitude(buffer: Buffer, offset: number, dataType: StellariumStarDataType) {
	if (dataType === 0) return buffer.readInt16LE(offset + 34) / 1000
	if (dataType === 1) return buffer.readInt16LE(offset + 26) / 1000
	return (buffer[offset + 15] * 20 + 16000) / 1000
}

// Reads the right ascension (radians, [0, 2π)) and declination (radians) of the record at byte `offset` into
// `out`, which is mutated and returned. The values are exactly those of the decoded entry.
export function readStellariumStarPosition(buffer: Buffer, offset: number, dataType: StellariumStarDataType, out: MutVec2): MutVec2 {
	if (dataType === 0) {
		const x = buffer.readInt32LE(offset + 8)
		const y = buffer.readInt32LE(offset + 12)
		const z = buffer.readInt32LE(offset + 16)
		// The common fixed-point scale cancels in both ratios, so the raw integers are used directly.
		out[0] = normalizeAngle(Math.atan2(y, x))
		out[1] = Math.atan2(z, Math.hypot(x, y))
	} else if (dataType === 1) {
		out[0] = normalizeAngle(mas(buffer.readInt32LE(offset + 8)))
		out[1] = clampDeclination(mas(buffer.readInt32LE(offset + 12)))
	} else {
		out[0] = normalizeAngle(mas(readUInt24LE(buffer, offset + 8) * 100))
		out[1] = clampDeclination(mas((readUInt24LE(buffer, offset + 11) - STAR3_DEC_OFFSET) * 100))
	}

	return out
}

// Decodes the record at byte `offset` into a fresh entry with a stable object shape.
// Missing values follow the upstream accessors, where a stored 0 means "no data": a zero parallax, parallax
// error or radial velocity is undefined, an all-zero proper motion leaves pmRA and pmDEC undefined, and a zero
// Hipparcos number leaves hipId and componentId undefined. Star1 proper motion is a tangential vector projected
// on the local east/north directions; pmRA = μα* / cos δ is undefined within cos δ < 1e-9 of a pole, and both
// rates are undefined exactly on a pole. Star2 stores dα/dt directly. Star3 has no motion, parallax or velocity.
export function decodeStellariumStar(buffer: Buffer, offset: number, context: StellariumStarRecordContext, zone: number, recordNumber: number): StellariumStarCatalogEntry {
	const { dataType } = context
	const gaiaId = buffer.readBigInt64LE(offset)

	let rightAscension: Angle
	let declination: Angle
	let magnitude: number
	let bv: number
	let pmRA: Angle | undefined
	let pmDEC: Angle | undefined
	let parallax: Angle | undefined
	let parallaxError: Angle | undefined
	let rv: number | undefined
	let hipId: number | undefined
	let componentId: number | undefined
	let spectralIndex: number | undefined
	let objectTypeIndex: number | undefined

	if (dataType === 0) {
		// Raw direction integers (unit vector × 2e9); the common scale cancels in every ratio below.
		const x = buffer.readInt32LE(offset + 8)
		const y = buffer.readInt32LE(offset + 12)
		const z = buffer.readInt32LE(offset + 16)
		const rho = Math.hypot(x, y)
		const norm = Math.hypot(rho, z)

		rightAscension = normalizeAngle(Math.atan2(y, x))
		declination = Math.atan2(z, rho)

		// Tangential proper motion vector, mas/yr.
		const dx = buffer.readInt32LE(offset + 20) / 1000
		const dy = buffer.readInt32LE(offset + 24) / 1000
		const dz = buffer.readInt32LE(offset + 28) / 1000

		if ((dx !== 0 || dy !== 0 || dz !== 0) && rho > 0) {
			// East p = (-y, x, 0) / ρ and north q = (-x z, -y z, ρ²) / (ρ |r|) unit vectors at the star.
			const pmRACosDec = (x * dy - y * dx) / rho
			pmDEC = mas((rho * rho * dz - z * (x * dx + y * dy)) / (rho * norm))
			const cosDec = rho / norm
			if (cosDec >= MIN_COS_DEC_FOR_PMRA) pmRA = mas(pmRACosDec / cosDec)
		}

		bv = buffer.readInt16LE(offset + 32) / 1000
		magnitude = buffer.readInt16LE(offset + 34) / 1000

		const plx = buffer.readUInt16LE(offset + 36)
		if (plx !== 0) parallax = mas(plx * 0.02)
		const plxErr = buffer.readUInt16LE(offset + 38)
		if (plxErr !== 0) parallaxError = mas(plxErr / 100)
		const rvRaw = buffer.readInt16LE(offset + 40)
		if (rvRaw !== 0) rv = kilometerPerSecond(rvRaw / 10)

		spectralIndex = buffer.readUInt16LE(offset + 42)
		objectTypeIndex = buffer[offset + 44]

		const hip = readUInt24LE(buffer, offset + 45)

		if (hip >>> 5 !== 0) {
			hipId = hip >>> 5
			componentId = hip & 0x1f
		}
	} else if (dataType === 1) {
		rightAscension = normalizeAngle(mas(buffer.readInt32LE(offset + 8)))
		declination = clampDeclination(mas(buffer.readInt32LE(offset + 12)))

		const pmRaRaw = buffer.readInt32LE(offset + 16)
		const pmDecRaw = buffer.readInt32LE(offset + 20)

		if (pmRaRaw !== 0 || pmDecRaw !== 0) {
			pmRA = mas(pmRaRaw / 1000)
			pmDEC = mas(pmDecRaw / 1000)
		}

		bv = buffer.readInt16LE(offset + 24) / 1000
		magnitude = buffer.readInt16LE(offset + 26) / 1000

		const plx = buffer.readUInt16LE(offset + 28)
		if (plx !== 0) parallax = mas(plx / 100)
		const plxErr = buffer.readUInt16LE(offset + 30)
		if (plxErr !== 0) parallaxError = mas(plxErr / 100)
	} else {
		rightAscension = normalizeAngle(mas(readUInt24LE(buffer, offset + 8) * 100))
		declination = clampDeclination(mas((readUInt24LE(buffer, offset + 11) - STAR3_DEC_OFFSET) * 100))
		// The executable upstream accessor uses 0.025 mag steps, although the struct comment says 0.05.
		bv = 0.025 * buffer[offset + 14] - 1
		magnitude = (buffer[offset + 15] * 20 + 16000) / 1000
	}

	return {
		rightAscension,
		declination,
		epoch: context.epoch,
		magnitude,
		pmRA,
		pmDEC,
		rv,
		parallax,
		gaiaId,
		hipId,
		componentId,
		bv,
		parallaxError,
		spectralIndex,
		objectTypeIndex,
		level: context.level,
		zone,
		recordNumber,
	}
}

// Reads an unsigned little-endian 24-bit integer.
function readUInt24LE(buffer: Buffer, offset: number) {
	return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

// Clamps a declination to [-π/2, π/2]; the stored ±90° in mas or 0.1″ units converts one ulp beyond π/2.
function clampDeclination(declination: Angle) {
	return Math.max(-PIOVERTWO, Math.min(PIOVERTWO, declination))
}
