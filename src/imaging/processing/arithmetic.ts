import type { Image, ImageRawType } from '../model/types'

// Per-sample image arithmetic and buffer utilities. Operations preserve the full floating-point range,
// accept exact input/output aliasing, and reject incompatible layouts or partially overlapping views.

// Verifies that one image has a dense buffer consistent with its declared geometry.
function validateImageLayout(image: Image, name: string) {
	const { width, height, channels, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`${name} width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`${name} height must be a positive integer: ${height}`)
	if (!Number.isInteger(channels) || channels <= 0) throw new Error(`${name} channels must be a positive integer: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`${name} pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`${name} raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
	if (image.metadata.bayer && channels !== 1) throw new Error(`${name} CFA data must have one channel: ${channels}`)
}

// Verifies that two images share the same geometry, channel layout, and CFA phase.
export function checkDimensions(a: Image, b: Image) {
	validateImageLayout(a, 'first image')
	validateImageLayout(b, 'second image')
	if (a.metadata.channels !== b.metadata.channels) throw new Error(`channels do not match: ${a.metadata.channels} != ${b.metadata.channels}`)
	if (a.metadata.width !== b.metadata.width) throw new Error(`width does not match: ${a.metadata.width} != ${b.metadata.width}`)
	if (a.metadata.height !== b.metadata.height) throw new Error(`height does not match: ${a.metadata.height} != ${b.metadata.height}`)
	const aPattern = a.metadata.bayer || undefined
	const bPattern = b.metadata.bayer || undefined
	if (aPattern !== bPattern) throw new Error(`CFA patterns do not match: ${aPattern ?? 'none'} != ${bPattern ?? 'none'}`)
}

// Returns whether two typed-array views cover exactly the same bytes.
function isSameView(a: ImageRawType, b: ImageRawType) {
	return a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.byteLength === b.byteLength
}

// Returns whether two typed-array views overlap any byte in the same backing buffer.
function viewsOverlap(a: ImageRawType, b: ImageRawType) {
	if (a.buffer !== b.buffer) return false
	const aEnd = a.byteOffset + a.byteLength
	const bEnd = b.byteOffset + b.byteLength
	return a.byteOffset < bEnd && b.byteOffset < aEnd
}

// Rejects shifted output aliasing that would overwrite samples before they are read.
function checkOutputAliasing(source: Image, out: Image, name: string) {
	if (viewsOverlap(source.raw, out.raw) && !isSameView(source.raw, out.raw)) throw new Error(`${name} and output raw buffers partially overlap`)
}

// Rejects a scalar that would inject a non-finite value into the output.
function checkScalar(scalar: number) {
	if (!Number.isFinite(scalar)) throw new Error(`scalar must be finite: ${scalar}`)
}

// Deep-clones image header, metadata, and pixel storage while preserving scale and future properties.
export function clone(image: Image): Image {
	return { ...image, header: { ...image.header }, metadata: { ...image.metadata }, raw: image.raw.slice() }
}

// Copies pixel samples into a matching image. TypedArray.set handles exact and shifted buffer overlap.
export function copyInto(from: Image, to: Image) {
	checkDimensions(from, to)
	to.raw.set(from.raw)
	return to
}

// Adds two images sample by sample without clipping.
export function plus(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'first image')
	checkOutputAliasing(b, out, 'second image')
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] + b.raw[i]
	return out
}

// Adds a finite scalar to every sample without clipping.
export function plusScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'image')
	checkScalar(scalar)
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] + scalar
	return out
}

// Subtracts one image from another sample by sample without clipping.
export function subtract(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'first image')
	checkOutputAliasing(b, out, 'second image')
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] - b.raw[i]
	return out
}

// Subtracts a finite scalar from every sample without clipping.
export function subtractScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'image')
	checkScalar(scalar)
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] - scalar
	return out
}

// Multiplies two images sample by sample without clipping.
export function multiply(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'first image')
	checkOutputAliasing(b, out, 'second image')
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * b.raw[i]
	return out
}

// Multiplies every sample by a finite scalar without clipping.
export function multiplyScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'image')
	checkScalar(scalar)
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * scalar
	return out
}

// Divides two images sample by sample after atomically validating every divisor.
export function divide(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'first image')
	checkOutputAliasing(b, out, 'second image')
	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = b.raw[i] === 0 ? 0 : a.raw[i] / b.raw[i]
	return out
}

// Divides every sample by a finite non-zero scalar without clipping.
export function divideScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)
	checkOutputAliasing(a, out, 'image')
	checkScalar(scalar)
	if (scalar === 0) throw new Error(`scalar must be non-zero: ${scalar}`)
	const n = a.raw.length
	// Direct division is deliberately retained: multiplying by a precomputed reciprocal changes many
	// Float64 results by one ULP and is therefore not an equivalent numerical optimization.
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] / scalar
	return out
}
