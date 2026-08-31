import type { Rect } from '../../../math/numerical/geometry'
import type { DigitalImage } from '../../model/types'
import { resolveImagePlaneGeometry } from '../plane'
import { RobustReservoir } from '../robust'
import type { FlatClipping, FlatClippingSide, FlatEffectiveClipLimits, FlatPlane, FlatSampleStatistics } from './types'

// Bounded-memory scalar reductions for digital flat planes. Clipping always uses observed samples,
// while an optional compatible reference is subtracted in line for corrected statistics. Masks are
// row-major per image pixel and therefore exclude all interleaved RGB channels at that coordinate.

// Fully resolved clipping limit used during one observed traversal.
interface ResolvedClipLimit {
	// Whether the limit describes effective sensor behavior or only representable storage.
	readonly source: 'effective' | 'storage'
	// Lower or upper clipping code in observed digital numbers.
	readonly limit: number
}

// Lower and upper clipping limits selected independently from effective and storage metadata.
export interface ResolvedFlatClippingLimits {
	// Effective lower limit or storage-range fallback.
	readonly lower?: ResolvedClipLimit
	// Effective upper limit or storage-range fallback.
	readonly upper?: ResolvedClipLimit
}

// Inputs required to reduce one plane inside one inclusive-exclusive image area.
export interface FlatRegionMeasurementInput {
	// Observed digital flat image.
	readonly image: DigitalImage
	// Explicit CFA offset applied once to image.metadata.bayer.
	readonly cfaOffset?: readonly [number, number]
	// Compatible bias or dark-flat image subtracted only for corrected statistics.
	readonly reference?: DigitalImage
	// Explicit CFA offset applied once to reference.metadata.bayer.
	readonly referenceCfaOffset?: readonly [number, number]
	// Optional row-major per-pixel exclusion mask.
	readonly mask?: Readonly<Uint8Array>
	// Inclusive-exclusive region to reduce.
	readonly area: Readonly<Rect>
	// Physical mono, RGB, or CFA plane.
	readonly plane: FlatPlane
	// Observed clipping limits resolved for the flat image.
	readonly clippingLimits: ResolvedFlatClippingLimits
}

// Scalar statistics and observed clipping measured for one region and plane.
export interface FlatRegionMeasurement {
	// Statistics before reference subtraction.
	readonly observed: FlatSampleStatistics
	// Statistics after reference subtraction when a reference was provided.
	readonly corrected?: FlatSampleStatistics
	// Observed clipping at the resolved effective or storage limits.
	readonly clipping: FlatClipping
}

// Mutable bounded-memory accumulator for one observed or corrected region.
class SampleAccumulator {
	// Deterministic finite sample used for median and MAD.
	readonly #reservoir: RobustReservoir
	// Number of finite values reduced.
	#count = 0
	// Number of masked plane samples.
	#masked = 0
	// Number of non-finite, non-masked plane samples.
	#nonFinite = 0
	// Smallest finite value.
	#minimum = Number.POSITIVE_INFINITY
	// Largest finite value.
	#maximum = Number.NEGATIVE_INFINITY
	// Incremental finite mean.
	#mean = 0

	// Creates an accumulator whose robust storage is bounded by the region's plane population.
	constructor(populationCapacity: number) {
		this.#reservoir = new RobustReservoir(populationCapacity)
	}

	// Records one plane sample as excluded by the shared per-pixel mask.
	mask(): void {
		this.#masked++
	}

	// Records one value, separating non-finite values and updating stable finite scalar reductions.
	push(value: number): void {
		if (!Number.isFinite(value)) {
			this.#nonFinite++
			return
		}

		const previousCount = this.#count++
		if (previousCount === 0) this.#mean = value
		else if (Math.sign(this.#mean) === Math.sign(value)) this.#mean += (value - this.#mean) / this.#count
		else this.#mean = (this.#mean * previousCount) / this.#count + value / this.#count
		if (value < this.#minimum) this.#minimum = value
		if (value > this.#maximum) this.#maximum = value
		this.#reservoir.push(value)
	}

	// Returns a fresh public summary, omitting numerical fields that cannot remain finite.
	finish(): FlatSampleStatistics {
		if (this.#count === 0) {
			return {
				count: 0,
				masked: this.#masked,
				nonFinite: this.#nonFinite,
				retainedSamples: 0,
				approximate: false,
			}
		}

		const median = this.#reservoir.median()
		const mad = this.#reservoir.mad()
		return {
			count: this.#count,
			masked: this.#masked,
			nonFinite: this.#nonFinite,
			minimum: this.#minimum,
			maximum: this.#maximum,
			mean: Number.isFinite(this.#mean) ? this.#mean : undefined,
			median: Number.isFinite(median) ? median : undefined,
			mad: Number.isFinite(mad) ? mad : undefined,
			retainedSamples: this.#reservoir.retainedCount,
			approximate: this.#reservoir.approximate,
		}
	}
}

// Chooses effective limits first and independently falls back to representable storage endpoints.
export function resolveFlatClippingLimits(image: DigitalImage, effective: FlatEffectiveClipLimits | undefined): ResolvedFlatClippingLimits {
	return {
		lower: effective?.lower !== undefined ? { source: 'effective', limit: effective.lower } : image.digitalRange ? { source: 'storage', limit: image.digitalRange[0] } : undefined,
		upper: effective?.upper !== undefined ? { source: 'effective', limit: effective.upper } : image.digitalRange ? { source: 'storage', limit: image.digitalRange[1] } : undefined,
	}
}

// Measures one image plane over one region without materializing a corrected image or plane buffer.
export function measureFlatRegion(input: FlatRegionMeasurementInput): FlatRegionMeasurement {
	const geometry = resolveImagePlaneGeometry(input.image, input.area, input.plane, input.cfaOffset)
	const referenceGeometry = input.reference ? resolveImagePlaneGeometry(input.reference, input.area, input.plane, input.referenceCfaOffset) : undefined
	if (referenceGeometry && (referenceGeometry.sourceLeft !== geometry.sourceLeft || referenceGeometry.sourceTop !== geometry.sourceTop || referenceGeometry.width !== geometry.width || referenceGeometry.height !== geometry.height || referenceGeometry.step !== geometry.step))
		throw new RangeError('flat reference plane geometry does not match the observed image')

	const capacity = geometry.width * geometry.height
	const observed = new SampleAccumulator(capacity)
	const corrected = referenceGeometry ? new SampleAccumulator(capacity) : undefined
	const raw = input.image.raw
	const referenceRaw = input.reference?.raw
	const mask = input.mask
	const imageWidth = input.image.metadata.width
	let valid = 0
	let lowerCount = 0
	let upperCount = 0

	for (let planeY = 0; planeY < geometry.height; planeY++) {
		const sourceY = geometry.sourceTop + planeY * geometry.step
		let rawIndex = geometry.rawStart + planeY * geometry.rawRowStep
		let referenceIndex = referenceGeometry ? referenceGeometry.rawStart + planeY * referenceGeometry.rawRowStep : 0
		let maskIndex = sourceY * imageWidth + geometry.sourceLeft
		for (let planeX = 0; planeX < geometry.width; planeX++, rawIndex += geometry.rawColumnStep, maskIndex += geometry.step) {
			if (mask?.[maskIndex]) {
				observed.mask()
				corrected?.mask()
				if (referenceGeometry) referenceIndex += referenceGeometry.rawColumnStep
				continue
			}

			const value = raw[rawIndex]
			observed.push(value)
			if (Number.isFinite(value)) {
				valid++
				if (input.clippingLimits.lower && value <= input.clippingLimits.lower.limit) lowerCount++
				if (input.clippingLimits.upper && value >= input.clippingLimits.upper.limit) upperCount++
			}
			if (referenceGeometry) {
				corrected!.push(value - referenceRaw![referenceIndex])
				referenceIndex += referenceGeometry.rawColumnStep
			}
		}
	}

	return {
		observed: observed.finish(),
		corrected: corrected?.finish(),
		clipping: {
			lower: clippingSide(input.clippingLimits.lower, lowerCount, valid),
			upper: clippingSide(input.clippingLimits.upper, upperCount, valid),
		},
	}
}

// Builds one public clipping side without emitting a non-finite fraction for an empty region.
function clippingSide(resolved: ResolvedClipLimit | undefined, count: number, valid: number): FlatClippingSide | undefined {
	if (!resolved) return undefined
	return {
		source: resolved.source,
		limit: resolved.limit,
		count,
		fraction: valid > 0 ? count / valid : 0,
		status: count > 0 ? 'present' : valid === 0 || resolved.source === 'storage' ? 'unknown' : 'absent',
	}
}
