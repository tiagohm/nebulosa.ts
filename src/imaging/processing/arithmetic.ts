import type { Image } from '../model/types'

// Verifies that two images share the same dimensions and channel layout.
export function checkDimensions(a: Image, b: Image) {
	if (a.metadata.channels !== b.metadata.channels) throw new Error(`channels does not match: ${a.metadata.channels} != ${b.metadata.channels}`)
	if (a.metadata.width !== b.metadata.width) throw new Error(`width does not match: ${a.metadata.width} != ${b.metadata.width}`)
	if (a.metadata.height !== b.metadata.height) throw new Error(`height does not match: ${a.metadata.height} != ${b.metadata.height}`)
}

// Deep-clones image header, metadata, and pixel storage.
export function clone(image: Image): Image {
	const header = structuredClone(image.header)
	const metadata = structuredClone(image.metadata)
	const { buffer } = Buffer.copyBytesFrom(image.raw)
	const raw = image.raw instanceof Float32Array ? new Float32Array(buffer) : new Float64Array(buffer)
	return { header, metadata, raw }
}

// Copies pixel samples from one image into another with matching dimensions.
export function copyInto(from: Image, to: Image) {
	checkDimensions(from, to)

	const a = from.raw
	const b = to.raw
	const n = a.length
	for (let i = 0; i < n; i++) b[i] = a[i]
	return to
}

// Adds two images sample by sample and clamps the result to [0,1].
export function plus(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.min(1, a.raw[i] + b.raw[i])
	return out
}

// Adds a scalar to every sample and clamps the result to [0,1].
export function plusScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.min(1, a.raw[i] + scalar)
	return out
}

// Subtracts one image from another sample by sample and clamps at zero.
export function subtract(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.max(0, a.raw[i] - b.raw[i])
	return out
}

// Subtracts a scalar from every sample and clamps at zero.
export function subtractScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.max(0, a.raw[i] - scalar)
	return out
}

// Multiplies two images sample by sample.
export function multiply(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * b.raw[i]
	return out
}

// Multiplies every sample by a scalar.
export function multiplyScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * scalar
	return out
}

// Divides one image by another sample by sample.
export function divide(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] / b.raw[i]
	return out
}

// Divides every sample by a scalar.
export function divideScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] / scalar
	return out
}
