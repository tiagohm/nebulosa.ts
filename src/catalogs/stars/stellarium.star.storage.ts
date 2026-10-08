import { createHash } from 'crypto'
import fs, { type FileHandle } from 'fs/promises'
import { join } from 'path'
import { parseStellariumStarHeader, parseStellariumStarZoneTable, STELLARIUM_STAR_HEADER_SIZE, type StellariumStarFileHeader, type StellariumStarZoneIndex } from './stellarium.star.binary'

// File-system layer of the Stellarium star catalog: discovers the `stars_<level>_*.cat` files of a catalog
// directory (from the starsConfig.json or defaultStarsConfig.json manifest, or by file name when there is no
// manifest), opens one read-only FileHandle per level, validates each header and zone table against the file
// size, and keeps only the header and the Uint32Array zone prefix sums in memory. Star records are never
// loaded here; callers read them with explicit positional reads, so concurrent readers share no file cursor.
// Every failure names the file, its level when known and the reason, and closes the handles already opened.

// Manifest file names, in order of preference (the user configuration first, then the distribution default).
export const STELLARIUM_STAR_MANIFEST_NAMES = ['starsConfig.json', 'defaultStarsConfig.json'] as const

// Name pattern of a star catalog file; the first group is the level.
const STAR_FILE_PATTERN = /^stars_(\d+)_.*\.cat$/
// Manifest identifier pattern (`starsN`); the first group is the level.
const STAR_ID_PATTERN = /^stars(\d+)$/
// MD5 checksum pattern of the manifest entries.
const MD5_PATTERN = /^[0-9a-fA-F]{32}$/
// Chunk size of the checksum stream, bytes.
const CHECKSUM_CHUNK_BYTES = 1024 * 1024

// One star catalog entry of a manifest.
export interface StellariumStarManifestEntry {
	// Manifest identifier, such as `stars4`, when present.
	readonly id?: string
	// Plain file name of the catalog file, relative to the catalog directory.
	readonly fileName: string
	// Level of the file, from its file name or else its identifier.
	readonly level: number
	// Expected lowercase MD5 checksum of the whole file, when present.
	readonly checksum?: string
	// Descriptive [bright, faint] V magnitude range of the level, mag; not a guarantee about the records.
	readonly magnitudeRange?: readonly [number, number]
	// Upstream installation flag; informational, it does not certify the file.
	readonly checked?: boolean
}

// A parsed manifest.
export interface StellariumStarManifest {
	// File name of the manifest that was read.
	readonly fileName: string
	// Manifest format version, when present (27 for the Stellarium 25.x distribution).
	readonly version?: number
	// Star catalog entries, one per level.
	readonly entries: readonly StellariumStarManifestEntry[]
}

// One opened and validated level file.
export interface StellariumStarLevelFile {
	// Validated header.
	readonly header: StellariumStarFileHeader
	// Zone prefix sums of the file.
	readonly index: StellariumStarZoneIndex
	// Plain file name.
	readonly fileName: string
	// Full path of the file.
	readonly path: string
	// File size, bytes; equal to header.dataOffset + recordCount × recordSize.
	readonly fileSize: number
	// Read-only handle used for positional reads; owned by the file set.
	readonly handle: FileHandle
	// Manifest entry of the file, when it was found through a manifest.
	readonly manifest?: StellariumStarManifestEntry
}

// The level files of a catalog directory.
export interface StellariumStarFileSet {
	// Catalog directory.
	readonly root: string
	// Manifest used for the discovery, when there was one.
	readonly manifest?: StellariumStarManifest
	// Opened files sorted by ascending level, one per level.
	readonly files: readonly StellariumStarLevelFile[]
	// Ascending levels listed by the manifest whose file is absent; empty without manifest.
	readonly missingLevels: readonly number[]
}

// Parses and validates the text of a manifest. Only the `catalogs` entries are used; each needs a plain
// `fileName` (no directory separators, so a manifest cannot point outside the catalog directory) and a level
// given by a `stars_<level>_*.cat` file name or a `stars<level>` identifier. Throws an Error naming the
// manifest when the JSON is malformed, an entry is invalid or two entries share a level.
export function parseStellariumStarManifest(text: string, fileName: string): StellariumStarManifest {
	let json: unknown

	try {
		json = JSON.parse(text)
	} catch (cause) {
		throw new Error(`invalid Stellarium star manifest ${fileName}: malformed JSON`, { cause })
	}

	if (!isRecord(json) || !Array.isArray(json.catalogs)) throw new Error(`invalid Stellarium star manifest ${fileName}: missing catalogs list`)

	const entries: StellariumStarManifestEntry[] = []
	const levels = new Set<number>()

	for (const item of json.catalogs as unknown[]) {
		if (!isRecord(item) || typeof item.fileName !== 'string') throw new Error(`invalid Stellarium star manifest ${fileName}: entry without fileName`)

		const name = item.fileName
		if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error(`invalid Stellarium star manifest ${fileName}: file name ${name} is not a plain file name`)

		const id = typeof item.id === 'string' ? item.id : undefined
		const level = levelFromName(name) ?? (id !== undefined ? levelFromId(id) : undefined)
		if (level === undefined) throw new Error(`invalid Stellarium star manifest ${fileName}: no level for ${name}`)
		if (levels.has(level)) throw new Error(`invalid Stellarium star manifest ${fileName}: level ${level} is listed more than once`)
		levels.add(level)

		const checksum = typeof item.checksum === 'string' && MD5_PATTERN.test(item.checksum) ? item.checksum.toLowerCase() : undefined
		const range = item.magRange
		const magnitudeRange = Array.isArray(range) && range.length === 2 && typeof range[0] === 'number' && typeof range[1] === 'number' ? ([range[0], range[1]] as const) : undefined
		const checked = typeof item.checked === 'boolean' ? item.checked : undefined

		entries.push({ id, fileName: name, level, checksum, magnitudeRange, checked })
	}

	const version = typeof json.version === 'number' ? json.version : undefined

	return { fileName, version, entries }
}

// Discovers, opens and validates the star files of a catalog directory. The first manifest of
// STELLARIUM_STAR_MANIFEST_NAMES that exists is authoritative: its present files are opened and its absent
// files become missing levels, and other files of the directory are ignored. Without manifest, every
// `stars_<level>_*.cat` file is opened and two files with the same level are an ambiguity error. Each header
// level must match the level of its file name or manifest entry. Throws when the directory is not readable,
// when no star file is found, or when any file is invalid; on failure every opened handle is closed.
export async function openStellariumStarFiles(root: string): Promise<StellariumStarFileSet> {
	let names: string[]

	try {
		const entries = await fs.readdir(root, { withFileTypes: true })
		names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
	} catch (cause) {
		throw new Error(`Stellarium star catalog directory is not readable: ${root}`, { cause })
	}

	const present = new Set(names)
	let manifest: StellariumStarManifest | undefined

	for (const name of STELLARIUM_STAR_MANIFEST_NAMES) {
		if (present.has(name)) {
			manifest = parseStellariumStarManifest(await fs.readFile(join(root, name), 'utf-8'), name)
			break
		}
	}

	const candidates: { readonly fileName: string; readonly level: number; readonly manifest?: StellariumStarManifestEntry }[] = []
	const missingLevels: number[] = []

	if (manifest !== undefined) {
		for (const entry of manifest.entries) {
			if (present.has(entry.fileName)) candidates.push({ fileName: entry.fileName, level: entry.level, manifest: entry })
			else missingLevels.push(entry.level)
		}
	} else {
		const byLevel = new Map<number, string[]>()

		for (const name of names) {
			const level = levelFromName(name)
			if (level === undefined) continue
			const list = byLevel.get(level)
			if (list === undefined) byLevel.set(level, [name])
			else list.push(name)
		}

		for (const [level, list] of byLevel) {
			if (list.length > 1) throw new Error(`ambiguous Stellarium star catalog level ${level}: ${list.sort().join(', ')}`)
			candidates.push({ fileName: list[0], level })
		}
	}

	if (candidates.length === 0) throw new Error(`no Stellarium star catalog file found in ${root}`)

	const results = await Promise.allSettled(candidates.map((candidate) => openLevelFile(root, candidate.fileName, candidate.level, candidate.manifest)))
	const files: StellariumStarLevelFile[] = []
	let failure: Error | undefined

	for (const result of results) {
		if (result.status === 'fulfilled') files.push(result.value)
		else failure ??= result.reason instanceof Error ? result.reason : new Error('cannot open Stellarium star file', { cause: result.reason })
	}

	if (failure !== undefined) {
		await closeStellariumStarFiles(files)
		throw failure
	}

	files.sort((a, b) => a.header.level - b.header.level)
	missingLevels.sort((a, b) => a - b)

	return { root, manifest, files, missingLevels }
}

// Closes the handles of the files, ignoring close failures so every handle gets a close attempt.
export async function closeStellariumStarFiles(files: readonly StellariumStarLevelFile[]) {
	await Promise.allSettled(files.map((file) => file.handle.close()))
}

// Reads exactly `length` bytes at absolute file `position` into the start of `buffer`, looping over short
// reads. Throws when the file ends first, which for a validated file means it was truncated after opening.
export async function readStellariumStarBytes(handle: FileHandle, buffer: Buffer, length: number, position: number) {
	let done = 0

	while (done < length) {
		const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
		if (bytesRead === 0) throw new Error(`unexpected end of file at byte ${position + done}`)
		done += bytesRead
	}
}

// Computes the lowercase hexadecimal MD5 of the first `size` bytes of a file by streaming 1 MiB chunks.
// `read` performs each positional read (so callers can account for or cancel it) into the given buffer.
export async function computeStellariumStarChecksum(size: number, read: (buffer: Buffer, length: number, position: number) => Promise<void>) {
	const hash = createHash('md5')
	const buffer = Buffer.allocUnsafe(Math.min(CHECKSUM_CHUNK_BYTES, Math.max(1, size)))

	for (let position = 0; position < size;) {
		const length = Math.min(buffer.byteLength, size - position)
		await read(buffer, length, position)
		hash.update(buffer.subarray(0, length))
		position += length
	}

	return hash.digest('hex')
}

// Opens one level file and validates its header, zone table and exact size; closes the handle on failure.
async function openLevelFile(root: string, fileName: string, level: number, manifest: StellariumStarManifestEntry | undefined): Promise<StellariumStarLevelFile> {
	const path = join(root, fileName)
	let handle: FileHandle

	try {
		handle = await fs.open(path, 'r')
	} catch (cause) {
		throw new Error(`cannot open Stellarium star file ${fileName} (level ${level})`, { cause })
	}

	try {
		const fileSize = (await handle.stat()).size
		if (fileSize < STELLARIUM_STAR_HEADER_SIZE) throw new Error('file is smaller than the header')

		const headerBytes = Buffer.allocUnsafe(STELLARIUM_STAR_HEADER_SIZE)
		await readStellariumStarBytes(handle, headerBytes, STELLARIUM_STAR_HEADER_SIZE, 0)
		const header = parseStellariumStarHeader(headerBytes)

		if (header.level !== level) throw new Error(`header level ${header.level} does not match`)
		// Checked before allocating the zone table so a corrupt level cannot request more memory than the file holds.
		if (fileSize < header.dataOffset) throw new Error('zone table is truncated')

		const tableBytes = Buffer.allocUnsafe(header.dataOffset - STELLARIUM_STAR_HEADER_SIZE)
		await readStellariumStarBytes(handle, tableBytes, tableBytes.byteLength, STELLARIUM_STAR_HEADER_SIZE)
		const index = parseStellariumStarZoneTable(tableBytes, header.zoneCount)

		const expectedSize = header.dataOffset + index.recordCount * header.recordSize
		if (fileSize !== expectedSize) throw new Error(`file size ${fileSize} does not match the expected ${expectedSize} bytes`)

		return { header, index, fileName, path, fileSize, handle, manifest }
	} catch (cause) {
		await handle.close().catch(() => undefined)
		const reason = cause instanceof Error ? cause.message : String(cause)
		throw new Error(`invalid Stellarium star file ${fileName} (level ${level}): ${reason}`, { cause })
	}
}

// Returns the level encoded in a `stars_<level>_*.cat` file name, or undefined.
function levelFromName(name: string) {
	const match = STAR_FILE_PATTERN.exec(name)
	return match === null ? undefined : +match[1]
}

// Returns the level encoded in a `stars<level>` manifest identifier, or undefined.
function levelFromId(id: string) {
	const match = STAR_ID_PATTERN.exec(id)
	return match === null ? undefined : +match[1]
}

// Narrows an unknown JSON value to a plain object.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
