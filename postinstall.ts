import { arch, platform } from 'process'

// actions/upload-artifact stores one shared library in a ZIP. Method 8 is raw DEFLATE (RFC 1951), and the
// data-descriptor flag leaves the local-header sizes at zero, so the compressed range comes from the central
// directory. Bun has no ZIP reader; DecompressionStream inflates that range without a dependency.

const LIBS = ['libwcs', 'libturbojpeg', 'libastrometry'] as const

// ISO-HDLC CRC-32, the checksum ZIP stores for each entry.
const CRC_TABLE = new Uint32Array(256)

// A hostile uncompressed-size field must not allocate before it is rejected.
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MAGIC = 0xffffffff

for (let n = 0; n < CRC_TABLE.length; n++) {
	let crc = n
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
	CRC_TABLE[n] = crc >>> 0
}

// CRC-32 of `data`, matching the value stored in a ZIP central-directory header.
function crc32(data: Uint8Array<ArrayBuffer>) {
	let crc = 0xffffffff
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

// Byte offset of the end-of-central-directory record. A signature inside the comment is ignored unless the
// record also ends at the last byte of the archive.
function findEocd(view: DataView, label: string) {
	const length = view.byteLength
	const min = Math.max(0, length - 22 - 0xffff)

	for (let offset = length - 22; offset >= min; offset--) {
		if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue
		if (offset + 22 + view.getUint16(offset + 20, true) === length) return offset
	}

	throw new Error(`${label}: missing end of central directory`)
}

// Inflates one raw DEFLATE block. ZIP method 8 has no zlib or gzip wrapper.
async function inflateRaw(compressed: Uint8Array<ArrayBuffer>) {
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Reads the single entry described by the central directory. The entry name inside the archive is not the
// installed filename; the caller writes `native/<lib>.shared`.
function zipEntry(bytes: Uint8Array<ArrayBuffer>, label: string) {
	if (bytes.length < 22) throw new Error(`${label}: truncated zip`)

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const eocd = findEocd(view, label)
	const entries = view.getUint16(eocd + 10, true)

	if (entries !== 1) throw new Error(`${label}: expected one entry, found ${entries}`)

	const central = view.getUint32(eocd + 16, true)

	if (central + 46 > bytes.length || view.getUint32(central, true) !== CENTRAL_SIGNATURE) throw new Error(`${label}: invalid central directory`)

	const flags = view.getUint16(central + 8, true)
	const method = view.getUint16(central + 10, true)
	const expectedCrc = view.getUint32(central + 16, true)
	const compressedSize = view.getUint32(central + 20, true)
	const uncompressedSize = view.getUint32(central + 24, true)
	const local = view.getUint32(central + 42, true)

	if (flags & 1) throw new Error(`${label}: encrypted entries are not supported`)
	if (compressedSize === ZIP64_MAGIC || uncompressedSize === ZIP64_MAGIC || local === ZIP64_MAGIC) throw new Error(`${label}: zip64 is not supported`)
	if (!(uncompressedSize > 0 && uncompressedSize <= MAX_LIBRARY_BYTES)) throw new Error(`${label}: uncompressed size ${uncompressedSize} is outside 1..${MAX_LIBRARY_BYTES}`)
	if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) throw new Error(`${label}: invalid local header`)

	const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)

	if (dataStart + compressedSize > bytes.length) throw new Error(`${label}: entry exceeds the archive`)

	return { method, expectedCrc, uncompressedSize, compressed: bytes.subarray(dataStart, dataStart + compressedSize) }
}

// Extracts the current platform archive to `native/<lib>.shared`.
async function unzip(lib: (typeof LIBS)[number]) {
	const label = `native/${lib}-${platform}-${arch}.zip`
	const archive = Bun.file(new URL(label, import.meta.url))

	if (!(await archive.exists())) throw new Error(`missing ${label}`)

	const bytes = new Uint8Array(await archive.arrayBuffer())
	const { method, expectedCrc, uncompressedSize, compressed } = zipEntry(bytes, label)
	let raw: Uint8Array<ArrayBuffer>

	if (method === 0) raw = compressed
	else if (method === 8) raw = await inflateRaw(compressed)
	else throw new Error(`${label}: unsupported method ${method}`)

	if (raw.length !== uncompressedSize) throw new Error(`${label}: inflated ${raw.length} bytes, expected ${uncompressedSize}`)
	if (crc32(raw) !== expectedCrc) throw new Error(`${label}: crc mismatch`)

	const path = `native/${lib}.shared`
	const output = new URL(path, import.meta.url)
	const written = await Bun.write(output, raw)

	if (written !== raw.length) throw new Error(`failed to write ${path}`)

	console.info('extracted', lib)
}

await Promise.all(LIBS.map(unzip))
