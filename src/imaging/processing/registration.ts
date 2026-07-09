import { type AffineTransform, invertTransform, matchStars, type SimilarityTransform, type StarMatchingConfig, type StarMatchingResult } from '../../astrometry/matching/star.matching'
import { Bitpix } from '../../io/formats/fits/fits'
import { bitpixInBytes } from '../../io/formats/fits/util'
import type { Image, ImageRawPrecision, ImageRawType } from '../model/types'
import type { DetectedStar } from '../stars/detector'

// Star-based image registration and resampling. Registration maps target pixels onto a reference
// image grid without normalizing or combining samples. Transform translations and residuals are pixels.

// Resampling kernel used when warping an image onto a reference grid.
export type ImageInterpolationMode = 'nearest' | 'bilinear' | 'bicubic'

// An image and the stars detected in its pixel coordinate system.
export interface ImageRegistrationInput {
	// Image samples and metadata.
	readonly image: Image
	// Stars detected in image pixel coordinates.
	readonly stars: readonly DetectedStar[]
}

// Optional plausibility limits evaluated after matching and before resampling.
export interface ImageRegistrationAcceptanceOptions {
	// Minimum matched stars retained as inliers.
	readonly minInliers?: number
	// Largest accepted inlier RMS residual, pixels.
	readonly maxRmsError?: number
	// Largest accepted transform translation, pixels.
	readonly maxTranslation?: number
	// Largest accepted transform rotation, radians.
	readonly maxRotation?: number
	// Smallest accepted axis scale.
	readonly minScale?: number
	// Largest accepted axis scale.
	readonly maxScale?: number
	// Largest accepted affine shear.
	readonly maxShear?: number
}

// Options controlling matching, validation, interpolation, and output storage.
export interface ImageRegistrationOptions {
	// Star-matching configuration forwarded to matchStars.
	readonly matchStarsConfig?: StarMatchingConfig
	// Resampling kernel. Defaults to bilinear.
	readonly interpolationMode?: ImageInterpolationMode
	// Floating-point output storage. When omitted, preserves target.raw storage.
	readonly outputPrecision?: ImageRawPrecision
	// Optional reusable sample buffer for the warped reference grid.
	readonly outputRaw?: ImageRawType
	// Optional reusable one-byte-per-pixel coverage buffer.
	readonly validityMask?: Uint8Array
	// Optional criteria that reject a match before pixels are warped.
	readonly acceptance?: ImageRegistrationAcceptanceOptions
}

// Options controlling a direct image warp.
export interface WarpImageOptions {
	// Resampling kernel. Defaults to bilinear.
	readonly interpolationMode?: ImageInterpolationMode
	// Floating-point output storage. When omitted, preserves source.raw storage.
	readonly outputPrecision?: ImageRawPrecision
	// Optional reusable sample buffer for the warped reference grid.
	readonly outputRaw?: ImageRawType
	// Optional reusable one-byte-per-pixel coverage buffer.
	readonly validityMask?: Uint8Array
}

// Geometric summary of a transform mapping target coordinates onto reference coordinates.
export interface ImageTransformSummary {
	// Transform family fitted from the matched stars.
	readonly model: 'similarity' | 'affine'
	// Target-to-reference x translation, pixels.
	readonly translationX: number
	// Target-to-reference y translation, pixels.
	readonly translationY: number
	// Length of the transformed x basis vector.
	readonly scaleX: number
	// Length of the transformed y basis vector.
	readonly scaleY: number
	// Target-to-reference rotation, radians.
	readonly rotation: number
	// Normalized non-orthogonality of affine basis vectors.
	readonly shear: number
	// Whether the transform reverses parity.
	readonly mirrored: boolean
	// Number of inlier star correspondences.
	readonly inlierCount: number
	// Inlier RMS residual, pixels.
	readonly rmsError: number
}

// Forward and inverse transforms describing a successful registration.
export interface ImageRegistrationTransform {
	// Transform mapping target coordinates to reference coordinates.
	readonly transform: SimilarityTransform | AffineTransform
	// Transform mapping reference coordinates to target coordinates for resampling.
	readonly inverseTransform: SimilarityTransform | AffineTransform
	// Derived transform diagnostics.
	readonly summary: ImageTransformSummary
}

// Image samples resampled to the reference grid and their coverage mask.
export interface WarpedImage {
	// Fresh image on the reference coordinate grid.
	readonly image: Image
	// One byte per output pixel; one means the source covered that pixel.
	readonly validityMask: Uint8Array
	// Number of covered output pixels.
	readonly coveredPixels: number
}

// Registration failure categories that callers can handle without exceptions.
export type ImageRegistrationFailureReason = 'invalid-reference-image' | 'invalid-target-image' | 'channel-mismatch' | 'match-failed' | 'transform-error-too-high' | 'transform-out-of-bounds' | 'invalid-transform'

// Successful star-based registration, including the warped target image.
export interface ImageRegistrationSuccess extends WarpedImage {
	readonly success: true
	// Full output of the star matcher.
	readonly match: StarMatchingResult
	// Forward and inverse geometric transforms.
	readonly transform: ImageRegistrationTransform
}

// Failed star-based registration, preserving matching diagnostics when available.
export interface ImageRegistrationFailure {
	readonly success: false
	// Stable reason for rejecting the registration.
	readonly reason: ImageRegistrationFailureReason
	// Matching output when shape validation succeeded.
	readonly match?: StarMatchingResult
}

// Result of registering target onto reference.
export type ImageRegistrationResult = ImageRegistrationSuccess | ImageRegistrationFailure

// Registers target stars against reference stars and warps target pixels onto the reference grid.
export function registerImage(reference: ImageRegistrationInput, target: ImageRegistrationInput, options: ImageRegistrationOptions = {}): ImageRegistrationResult {
	if (!isImageShapeValid(reference.image)) return { success: false, reason: 'invalid-reference-image' }
	if (!isImageShapeValid(target.image)) return { success: false, reason: 'invalid-target-image' }
	if (reference.image.metadata.channels !== target.image.metadata.channels) return { success: false, reason: 'channel-mismatch' }

	const match = matchStars(reference.stars, target.stars, options.matchStarsConfig)
	if (!match.success || (options.acceptance?.minInliers !== undefined && match.inlierCount < options.acceptance.minInliers)) return { success: false, reason: 'match-failed', match }
	if (options.acceptance?.maxRmsError !== undefined && (match.rmsError ?? Infinity) > options.acceptance.maxRmsError) return { success: false, reason: 'transform-error-too-high', match }

	const transform = resolveRegistrationTransform(match)
	if (transform === undefined) return { success: false, reason: 'invalid-transform', match }
	if (!transformWithinBounds(transform.summary, options.acceptance)) return { success: false, reason: 'transform-out-of-bounds', match }

	const inverseTransform = invertTransform(transform.transform)
	if (inverseTransform === undefined) return { success: false, reason: 'invalid-transform', match }

	const warped = warpImage(target.image, reference.image, inverseTransform, options)
	return { success: true, match, transform: { ...transform, inverseTransform }, ...warped }
}

// Warps source pixels onto reference's grid using an inverse reference-to-source transform.
export function warpImage(source: Image, reference: Image, inverseTransform: SimilarityTransform | AffineTransform, options: WarpImageOptions = {}): WarpedImage {
	const { width, height, channels } = reference.metadata
	const pixelCount = width * height
	const sampleCount = pixelCount * channels
	const raw = options.outputRaw?.length === sampleCount ? options.outputRaw : createRaw(source.raw, sampleCount, options.outputPrecision ?? 'auto')
	const validityMask = options.validityMask?.length === pixelCount ? options.validityMask : new Uint8Array(pixelCount)
	const coveredPixels = warpIntoReference(source, inverseTransform, width, height, options.interpolationMode ?? 'bilinear', raw, validityMask)
	return { image: buildImage(raw, reference), validityMask, coveredPixels }
}

// Converts a successful star-match model into a forward target-to-reference transform and summary.
function resolveRegistrationTransform(match: StarMatchingResult): Omit<ImageRegistrationTransform, 'inverseTransform'> | undefined {
	if (!match.success || match.model === undefined) return undefined

	if (match.model === 'similarity' && match.similarity !== undefined) {
		const { a, b, tx, ty, mirrored } = match.similarity
		const scale = Math.hypot(a, b)
		return { transform: match.similarity, summary: { model: 'similarity', translationX: tx, translationY: ty, scaleX: scale, scaleY: scale, rotation: Math.atan2(b, a), shear: 0, mirrored, inlierCount: match.inlierCount, rmsError: match.rmsError ?? Infinity } }
	}

	if (match.model === 'affine' && match.affine !== undefined) {
		const { m00, m01, tx, m10, m11, ty } = match.affine
		const scaleX = Math.hypot(m00, m10)
		const scaleY = Math.hypot(m01, m11)
		const shear = Math.abs(m00 * m01 + m10 * m11) / Math.max(scaleX * scaleY, Number.EPSILON)
		return { transform: match.affine, summary: { model: 'affine', translationX: tx, translationY: ty, scaleX, scaleY, rotation: Math.atan2(m10, m00), shear, mirrored: m00 * m11 - m01 * m10 < 0, inlierCount: match.inlierCount, rmsError: match.rmsError ?? Infinity } }
	}
}

// Checks an accepted transform against optional caller-supplied plausibility limits.
function transformWithinBounds(summary: ImageTransformSummary, bounds: ImageRegistrationAcceptanceOptions | undefined) {
	if (bounds === undefined) return true
	if (bounds.maxTranslation !== undefined && Math.hypot(summary.translationX, summary.translationY) > bounds.maxTranslation) return false
	if (bounds.maxRotation !== undefined && Math.abs(summary.rotation) > bounds.maxRotation) return false
	if (bounds.minScale !== undefined && (summary.scaleX < bounds.minScale || summary.scaleY < bounds.minScale)) return false
	if (bounds.maxScale !== undefined && (summary.scaleX > bounds.maxScale || summary.scaleY > bounds.maxScale)) return false
	if (bounds.maxShear !== undefined && summary.shear > bounds.maxShear) return false
	return true
}

// Resamples source into caller-provided output buffers on the reference grid.
function warpIntoReference(image: Image, inverseTransform: SimilarityTransform | AffineTransform, outWidth: number, outHeight: number, interpolation: ImageInterpolationMode, outRaw: ImageRawType, outMask: Uint8Array) {
	const matrix = toAffineMatrix(inverseTransform)
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const widthMinus1 = width - 1
	const heightMinus1 = height - 1
	outRaw.fill(0)
	outMask.fill(0)
	let coveredPixels = 0

	if (interpolation === 'nearest') {
		for (let y = 0, pixel = 0, outIndex = 0; y < outHeight; y++) {
			let sourceX = matrix.m01 * y + matrix.tx
			let sourceY = matrix.m11 * y + matrix.ty
			for (let x = 0; x < outWidth; x++, pixel++, outIndex += channels) {
				if (sourceX >= 0 && sourceY >= 0 && sourceX <= widthMinus1 && sourceY <= heightMinus1) {
					const base = (Math.round(sourceY) * width + Math.round(sourceX)) * channels
					for (let channel = 0; channel < channels; channel++) outRaw[outIndex + channel] = raw[base + channel]
					outMask[pixel] = 1
					coveredPixels++
				}
				sourceX += matrix.m00
				sourceY += matrix.m10
			}
		}
		return coveredPixels
	}

	if (interpolation === 'bilinear') {
		for (let y = 0, pixel = 0, outIndex = 0; y < outHeight; y++) {
			let sourceX = matrix.m01 * y + matrix.tx
			let sourceY = matrix.m11 * y + matrix.ty
			for (let x = 0; x < outWidth; x++, pixel++, outIndex += channels) {
				if (sourceX >= 0 && sourceY >= 0 && sourceX <= widthMinus1 && sourceY <= heightMinus1) {
					const x0 = Math.floor(sourceX)
					const y0 = Math.floor(sourceY)
					const x1 = Math.min(x0 + 1, widthMinus1)
					const y1 = Math.min(y0 + 1, heightMinus1)
					const tx = sourceX - x0
					const ty = sourceY - y0
					const w00 = (1 - tx) * (1 - ty)
					const w10 = tx * (1 - ty)
					const w01 = (1 - tx) * ty
					const w11 = tx * ty
					const base00 = (y0 * width + x0) * channels
					const base10 = (y0 * width + x1) * channels
					const base01 = (y1 * width + x0) * channels
					const base11 = (y1 * width + x1) * channels
					for (let channel = 0; channel < channels; channel++) outRaw[outIndex + channel] = raw[base00 + channel] * w00 + raw[base10 + channel] * w10 + raw[base01 + channel] * w01 + raw[base11 + channel] * w11
					outMask[pixel] = 1
					coveredPixels++
				}
				sourceX += matrix.m00
				sourceY += matrix.m10
			}
		}
		return coveredPixels
	}

	const rowStride = width * channels
	for (let y = 0, pixel = 0, outIndex = 0; y < outHeight; y++) {
		let sourceX = matrix.m01 * y + matrix.tx
		let sourceY = matrix.m11 * y + matrix.ty
		for (let x = 0; x < outWidth; x++, pixel++, outIndex += channels) {
			if (sourceX >= 0 && sourceY >= 0 && sourceX <= widthMinus1 && sourceY <= heightMinus1) {
				const x1 = Math.floor(sourceX)
				const y1 = Math.floor(sourceY)
				const x0 = x1 > 0 ? x1 - 1 : 0
				const x2 = x1 < widthMinus1 ? x1 + 1 : widthMinus1
				const x3 = x1 + 2 <= widthMinus1 ? x1 + 2 : widthMinus1
				const y0 = y1 > 0 ? y1 - 1 : 0
				const y2 = y1 < heightMinus1 ? y1 + 1 : heightMinus1
				const y3 = y1 + 2 <= heightMinus1 ? y1 + 2 : heightMinus1
				const tx = sourceX - x1
				const ty = sourceY - y1
				const tx2 = tx * tx
				const tx3 = tx2 * tx
				const ty2 = ty * ty
				const ty3 = ty2 * ty
				const wx0 = 0.5 * (-tx3 + 2 * tx2 - tx)
				const wx1 = 0.5 * (3 * tx3 - 5 * tx2 + 2)
				const wx2 = 0.5 * (-3 * tx3 + 4 * tx2 + tx)
				const wx3 = 0.5 * (tx3 - tx2)
				const wy0 = 0.5 * (-ty3 + 2 * ty2 - ty)
				const wy1 = 0.5 * (3 * ty3 - 5 * ty2 + 2)
				const wy2 = 0.5 * (-3 * ty3 + 4 * ty2 + ty)
				const wy3 = 0.5 * (ty3 - ty2)
				const baseY0 = y0 * rowStride
				const baseY1 = y1 * rowStride
				const baseY2 = y2 * rowStride
				const baseY3 = y3 * rowStride
				const baseX0 = x0 * channels
				const baseX1 = x1 * channels
				const baseX2 = x2 * channels
				const baseX3 = x3 * channels
				for (let channel = 0; channel < channels; channel++) {
					const row0 = raw[baseY0 + baseX0 + channel] * wx0 + raw[baseY0 + baseX1 + channel] * wx1 + raw[baseY0 + baseX2 + channel] * wx2 + raw[baseY0 + baseX3 + channel] * wx3
					const row1 = raw[baseY1 + baseX0 + channel] * wx0 + raw[baseY1 + baseX1 + channel] * wx1 + raw[baseY1 + baseX2 + channel] * wx2 + raw[baseY1 + baseX3 + channel] * wx3
					const row2 = raw[baseY2 + baseX0 + channel] * wx0 + raw[baseY2 + baseX1 + channel] * wx1 + raw[baseY2 + baseX2 + channel] * wx2 + raw[baseY2 + baseX3 + channel] * wx3
					const row3 = raw[baseY3 + baseX0 + channel] * wx0 + raw[baseY3 + baseX1 + channel] * wx1 + raw[baseY3 + baseX2 + channel] * wx2 + raw[baseY3 + baseX3 + channel] * wx3
					outRaw[outIndex + channel] = row0 * wy0 + row1 * wy1 + row2 * wy2 + row3 * wy3
				}
				outMask[pixel] = 1
				coveredPixels++
			}
			sourceX += matrix.m00
			sourceY += matrix.m10
		}
	}
	return coveredPixels
}

// Converts similarity or affine parameters into a common matrix representation.
function toAffineMatrix(transform: SimilarityTransform | AffineTransform) {
	if ('mirrored' in transform) return { m00: transform.a, m01: transform.mirrored ? transform.b : -transform.b, tx: transform.tx, m10: transform.b, m11: transform.mirrored ? -transform.a : transform.a, ty: transform.ty }
	return transform
}

// Allocates a floating-point output buffer matching the requested storage precision.
function createRaw(source: ImageRawType, length: number, outputPrecision: ImageRawPrecision): ImageRawType {
	if (outputPrecision === 'auto') outputPrecision = source.BYTES_PER_ELEMENT === 8 ? 64 : 32
	return outputPrecision === 64 ? new Float64Array(length) : new Float32Array(length)
}

// Builds a valid reference-grid image whose storage metadata matches its raw buffer.
function buildImage(raw: ImageRawType, reference: Image): Image {
	const { width, height, channels, bayer } = reference.metadata
	const bitpix = raw instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT
	return { header: { ...reference.header }, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * bitpixInBytes(bitpix), pixelSizeInBytes: bitpixInBytes(bitpix), bitpix, bayer } }
}

// Verifies that an image has usable dimensions, supported channels, and matching raw storage.
function isImageShapeValid(image: Image) {
	return image.metadata.width > 0 && image.metadata.height > 0 && (image.metadata.channels === 1 || image.metadata.channels === 3) && image.raw.length === image.metadata.pixelCount * image.metadata.channels
}
