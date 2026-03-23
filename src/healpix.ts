import { type Angle, normalizeAngle } from './angle'
import { PI, PIOVERTWO } from './constants'
import { clamp, pmod } from './math'
import { type MutVec3, type Vec3, vecCross, vecDot, vecNegateMut, vecNormalize, vecTripleProduct } from './vec3'

const HEALPIX_MAX_NSIDE = 2 ** 24
const HEALPIX_FACE_COUNT = 12
const EQUATORIAL_Z_LIMIT = 2 / 3
const COVER_BOUND_FACTOR = PI / 2
const EPSILON = 1e-14
const VERTEX_EPSILON = 1e-12

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4] as const
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7] as const

export type HealpixOrdering = 'nested' | 'ring'

export type HealpixVertex = readonly [Angle, Angle]

export interface HealpixCoverOptions {
	readonly targetNside?: number
	readonly maxDepth?: number
	readonly ordering?: HealpixOrdering
	// Conservative covers are always used to avoid missing intersecting pixels.
	readonly conservative?: boolean
}

export interface HealpixIndexOptions {
	readonly nside: number
	readonly ordering?: HealpixOrdering
	readonly coordinateMode?: 'lonlat' | 'radec'
	readonly validateInputs?: boolean
}

export interface HealpixInsertObject<T, M = unknown> {
	readonly id: T
	readonly longitude: Angle
	readonly latitude: Angle
	readonly metadata?: M
}

export type HealpixVertexInput = readonly [Angle, Angle] | Vec3

interface HealpixRegion {
	readonly vertices: readonly Vec3[]
	readonly edgeNormals: readonly Vec3[]
}

interface HealpixObject<T, M> {
	readonly id: T
	longitude: Angle
	latitude: Angle
	metadata?: M
	readonly vector: MutVec3
	pixel: number
	bucketIndex: number
}

interface HealpixCoverState {
	readonly nside: number
	readonly order: number
	readonly maxDepth: number
	readonly pixels: number[]
	readonly intersects: (center: Vec3, bound: number) => boolean
}

// Converts spherical coordinates to a HEALPix pixel.
export function coordToPixel(nside: number, longitude: number, latitude: number, ordering: HealpixOrdering = 'nested') {
	validateNside(nside)
	const normalizedLongitude = normalizeLongitude(longitude)
	const normalizedLatitude = normalizeLatitude(latitude)
	const nestedPixel = vectorToPixel(nside, lonLatToVec(normalizedLongitude, normalizedLatitude))
	return ordering === 'nested' ? nestedPixel : nestedToRing(nside, nestedPixel)
}

// Converts a HEALPix pixel to the center spherical coordinates.
export function pixelToCenter(nside: number, pixel: number, ordering: HealpixOrdering = 'nested') {
	validateNside(nside)
	validatePixelIndex(pixel, nside)
	if (ordering === 'ring') return ringPixelToLonLat(nside, pixel)
	const [face, ix, iy] = pixelToFaceXY(pixel, nside)
	return faceXYToLonLat(face, ix + 0.5, iy + 0.5, nside)
}

// Converts a HEALPix pixel to its boundary vertices.
export function pixelToBoundary(nside: number, pixel: number, ordering: HealpixOrdering = 'nested') {
	validateNside(nside)
	validatePixelIndex(pixel, nside)

	const [face, ix, iy] = pixelToFaceXY(ordering === 'nested' ? pixel : ringToNested(nside, pixel), nside)

	return [faceXYToLonLat(face, ix, iy, nside), faceXYToLonLat(face, ix + 1, iy, nside), faceXYToLonLat(face, ix + 1, iy + 1, nside), faceXYToLonLat(face, ix, iy + 1, nside)] as const
}

// Converts a nested pixel index to ring ordering.
export function nestedToRing(nside: number, pixel: number) {
	validateNside(nside)
	validatePixelIndex(pixel, nside)
	const [face, ix, iy] = pixelToFaceXY(pixel, nside)
	return faceXYToRing(face, ix, iy, nside)
}

// Converts a ring pixel index to nested ordering.
export function ringToNested(nside: number, pixel: number) {
	validateNside(nside)
	validatePixelIndex(pixel, nside)
	const [longitude, latitude] = ringPixelToLonLat(nside, pixel)
	return coordToPixel(nside, longitude, latitude, 'nested')
}

// Computes a conservative circle cover in nested ordering.
export function circleToPixels(nside: number, centerLongitude: number, centerLatitude: number, radius: number, options: HealpixCoverOptions = {}) {
	validateNside(nside)
	validateRadius(radius)

	const center = lonLatToVec(normalizeLongitude(centerLongitude), normalizeLatitude(centerLatitude))

	return coverPixels(nside, options, {
		intersects(centerPoint: Vec3, bound: number) {
			return angularDistance(centerPoint, center) <= radius + bound + EPSILON
		},
	})
}

// Computes a conservative triangle cover in nested ordering.
export function triangleToPixels(nside: number, a: HealpixVertexInput, b: HealpixVertexInput, c: HealpixVertexInput, options: HealpixCoverOptions = {}) {
	validateNside(nside)
	const region = buildRegion([a, b, c], 'triangle')

	return coverPixels(nside, options, {
		intersects(centerPoint: Vec3, bound: number) {
			return distanceToRegion(centerPoint, region) <= bound + EPSILON
		},
	})
}

// Computes a conservative convex polygon cover in nested ordering.
export function polygonToPixels(nside: number, vertices: readonly HealpixVertexInput[], options: HealpixCoverOptions = {}) {
	validateNside(nside)
	const region = buildRegion(vertices, 'polygon')

	return coverPixels(nside, options, {
		intersects(centerPoint: Vec3, bound: number) {
			return distanceToRegion(centerPoint, region) <= bound + EPSILON
		},
	})
}

// HEALPix spatial index for spherical coordinates.
export class HealpixIndex<T, M = unknown> {
	readonly nside: number
	readonly ordering: HealpixOrdering
	readonly coordinateMode: 'lonlat' | 'radec'
	readonly validateInputs: boolean

	#pixelBuckets = new Map<number, HealpixObject<T, M>[]>()
	#entriesById = new Map<T, HealpixObject<T, M>>()

	// Creates a new index instance.
	constructor(options: HealpixIndexOptions) {
		validateNside(options.nside)

		this.nside = options.nside
		this.ordering = options.ordering ?? 'nested'
		this.coordinateMode = options.coordinateMode ?? 'lonlat'
		this.validateInputs = options.validateInputs ?? true
	}

	// Returns the number of indexed objects.
	get size() {
		return this.#entriesById.size
	}

	// Converts coordinates to a nested HEALPix pixel using the index resolution.
	coordToPixel(longitude: number, latitude: number) {
		return coordToPixel(this.nside, longitude, latitude, this.ordering)
	}

	// Converts a nested HEALPix pixel to its center.
	pixelToCenter(pixel: number) {
		return pixelToCenter(this.nside, pixel, this.ordering)
	}

	// Converts a nested HEALPix pixel to its boundary vertices.
	pixelToBoundary(pixel: number) {
		return pixelToBoundary(this.nside, pixel, this.ordering)
	}

	// Inserts a single object into the index.
	insert(id: T, longitude: number, latitude: number, metadata?: M): HealpixObject<T, M> {
		if (this.#entriesById.has(id)) {
			throw new Error(`duplicate HEALPix object id: ${String(id)}`)
		}

		return this.#insertNormalized(id, longitude, latitude, metadata)
	}

	// Inserts a single object into the index.
	add(id: T, longitude: number, latitude: number, metadata?: M): HealpixObject<T, M> {
		return this.insert(id, longitude, latitude, metadata)
	}

	// Inserts many objects after validating the whole batch first.
	insertMany(objects: readonly HealpixInsertObject<T, M>[]): HealpixObject<T, M>[] {
		const normalized: HealpixInsertObject<T, M>[] = []
		const ids = new Set<T>()

		for (const object of objects) {
			if (ids.has(object.id)) {
				throw new Error(`duplicate HEALPix object id in batch: ${String(object.id)}`)
			}

			if (this.#entriesById.has(object.id)) {
				throw new Error(`duplicate HEALPix object id: ${String(object.id)}`)
			}

			ids.add(object.id)
			normalized.push({ id: object.id, longitude: normalizeLongitude(object.longitude), latitude: normalizeLatitude(object.latitude), metadata: object.metadata })
		}

		const inserted: HealpixObject<T, M>[] = []

		for (const object of normalized) {
			inserted.push(this.#insertNormalized(object.id, object.longitude, object.latitude, object.metadata))
		}

		return inserted
	}

	// Removes an object from the index.
	remove(id: T) {
		const entry = this.#entriesById.get(id)
		if (!entry) return false

		this.#removeEntry(entry)
		return true
	}

	// Updates an object's coordinates and optional metadata.
	update(id: T, longitude: number, latitude: number, metadata?: M) {
		const entry = this.#entriesById.get(id)
		if (!entry) return false

		const normalizedLongitude = normalizeLongitude(longitude)
		const normalizedLatitude = normalizeLatitude(latitude)
		const nextPixel = coordToPixel(this.nside, normalizedLongitude, normalizedLatitude, this.ordering)

		entry.longitude = normalizedLongitude
		entry.latitude = normalizedLatitude
		lonLatToVecInto(normalizedLongitude, normalizedLatitude, entry.vector)

		entry.metadata = metadata

		if (nextPixel !== entry.pixel) {
			this.#moveEntry(entry, nextPixel)
		}

		return true
	}

	// Removes every object from the index.
	clear() {
		this.#pixelBuckets.clear()
		this.#entriesById.clear()
	}

	// Queries objects inside a spherical cap.
	queryCircle(centerLongitude: number, centerLatitude: number, radius: number, options: HealpixCoverOptions = {}) {
		validateRadius(radius)

		const normalizedLongitude = normalizeLongitude(centerLongitude)
		const normalizedLatitude = normalizeLatitude(centerLatitude)
		const center = lonLatToVec(normalizedLongitude, normalizedLatitude)
		const radiusCos = Math.cos(radius)
		const pixels = circleToPixels(this.nside, normalizedLongitude, normalizedLatitude, radius, withOrdering(options, this.ordering))

		return this.#collectMatches(pixels, (entry) => {
			return vecDot(entry.vector, center) >= radiusCos - EPSILON
		})
	}

	// Queries objects inside a spherical triangle.
	queryTriangle(a: HealpixVertexInput, b: HealpixVertexInput, c: HealpixVertexInput, options: HealpixCoverOptions = {}) {
		const region = buildRegion([a, b, c], 'triangle')
		const pixels = triangleToPixels(this.nside, a, b, c, withOrdering(options, this.ordering))
		return this.#collectMatches(pixels, (entry) => pointInRegion(entry.vector, region))
	}

	// Queries objects inside a convex spherical polygon.
	queryPolygon(vertices: readonly HealpixVertexInput[], options: HealpixCoverOptions = {}) {
		const region = buildRegion(vertices, 'polygon')
		const pixels = polygonToPixels(this.nside, vertices, withOrdering(options, this.ordering))
		return this.#collectMatches(pixels, (entry) => pointInRegion(entry.vector, region))
	}

	// Inserts a validated object into the index.
	#insertNormalized(id: T, longitude: number, latitude: number, metadata?: M): Readonly<HealpixObject<T, M>> {
		const pixel = coordToPixel(this.nside, longitude, latitude, this.ordering)
		const bucket = this.#pixelBuckets.get(pixel) ?? []
		const entry: HealpixObject<T, M> = { id, longitude, latitude, metadata, vector: lonLatToVec(longitude, latitude), pixel, bucketIndex: bucket.length }

		bucket.push(entry)
		this.#pixelBuckets.set(pixel, bucket)
		this.#entriesById.set(id, entry)

		return entry
	}

	// Moves an existing entry between buckets.
	#moveEntry(entry: HealpixObject<T, M>, nextPixel: number) {
		this.#detachEntry(entry)

		const bucket = this.#pixelBuckets.get(nextPixel) ?? []
		entry.pixel = nextPixel
		entry.bucketIndex = bucket.length
		bucket.push(entry)
		this.#pixelBuckets.set(nextPixel, bucket)
	}

	// Removes an existing entry from all internal tables.
	#removeEntry(entry: HealpixObject<T, M>) {
		this.#detachEntry(entry)
		this.#entriesById.delete(entry.id)
	}

	// Detaches an entry from its current bucket using swap-remove.
	#detachEntry(entry: HealpixObject<T, M>) {
		const bucket = this.#pixelBuckets.get(entry.pixel)
		if (!bucket) return

		const lastIndex = bucket.length - 1
		const last = bucket[lastIndex]

		if (entry.bucketIndex !== lastIndex) {
			bucket[entry.bucketIndex] = last
			last.bucketIndex = entry.bucketIndex
		}

		bucket.pop()

		if (bucket.length === 0) {
			this.#pixelBuckets.delete(entry.pixel)
		}
	}

	// Collects query matches from candidate pixels.
	#collectMatches(pixels: readonly number[], predicate: (entry: HealpixObject<T, M>) => boolean): readonly Readonly<HealpixObject<T, M>>[] {
		const matches: HealpixObject<T, M>[] = []

		for (const pixel of pixels) {
			const bucket = this.#pixelBuckets.get(pixel)

			if (!bucket) continue

			for (let i = 0; i < bucket.length; i++) {
				const entry = bucket[i]

				if (predicate(entry)) {
					matches.push(entry)
				}
			}
		}

		return matches
	}
}

// Forces query-cover outputs to match the index ordering.
function withOrdering(options: HealpixCoverOptions, ordering: HealpixOrdering): HealpixCoverOptions {
	if (options.ordering === ordering) return options
	if (options.ordering === undefined && ordering === 'nested') return options
	return { ...options, ordering }
}

// Validates an NSIDE value against HEALPix constraints.
function validateNside(nside: number) {
	if (!Number.isInteger(nside) || nside < 1 || nside > HEALPIX_MAX_NSIDE || !Number.isInteger(Math.log2(nside))) {
		throw new Error(`invalid HEALPix NSIDE: ${nside}. Expected a power of two in [1, ${HEALPIX_MAX_NSIDE}]`)
	}
}

// Validates a public radius argument.
function validateRadius(radius: number) {
	if (!Number.isFinite(radius) || radius < 0 || radius > PI) {
		throw new Error(`invalid spherical radius: ${radius}. Expected a finite value in [0, PI]`)
	}
}

// Validates a pixel index for a specific NSIDE.
function validatePixelIndex(pixel: number, nside: number) {
	const pixelCount = HEALPIX_FACE_COUNT * nside * nside

	if (!Number.isInteger(pixel) || pixel < 0 || pixel >= pixelCount) {
		throw new Error(`invalid HEALPix pixel index: ${pixel}. Expected an integer in [0, ${pixelCount - 1}]`)
	}
}

// Normalizes and validates a longitude.
function normalizeLongitude(longitude: number) {
	if (!Number.isFinite(longitude)) {
		throw new Error(`invalid longitude/right ascension: ${longitude}`)
	}

	return normalizeAngle(longitude)
}

// Normalizes and validates a latitude.
function normalizeLatitude(latitude: number) {
	if (!Number.isFinite(latitude)) {
		throw new Error(`invalid latitude/declination: ${latitude}`)
	}

	if (latitude < -PIOVERTWO - EPSILON || latitude > PIOVERTWO + EPSILON) {
		throw new Error(`invalid latitude/declination: ${latitude}. Expected a finite value in [-pi/2, pi/2]`)
	}

	return clamp(latitude, -PIOVERTWO, PIOVERTWO)
}

// Converts spherical coordinates to a unit vector.
function lonLatToVec(longitude: number, latitude: number) {
	const cosLatitude = Math.cos(latitude)
	return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)] as MutVec3
}

// Writes spherical coordinates into an existing mutable unit vector.
function lonLatToVecInto(longitude: number, latitude: number, out: MutVec3) {
	const cosLatitude = Math.cos(latitude)
	out[0] = cosLatitude * Math.cos(longitude)
	out[1] = cosLatitude * Math.sin(longitude)
	out[2] = Math.sin(latitude)
}

// Computes the angular separation between two unit vectors.
function angularDistance(a: Vec3, b: Vec3) {
	return Math.acos(clamp(vecDot(a, b), -1, 1))
}

// Converts a unit vector to a nested HEALPix pixel.
function vectorToPixel(nside: number, vector: Vec3) {
	const longitude = normalizeAngle(Math.atan2(vector[1], vector[0]))
	const z = clamp(vector[2], -1, 1)
	const absZ = Math.abs(z)
	const tt = longitude * (2 / PI)

	let face: number
	let ix: number
	let iy: number

	if (absZ <= EQUATORIAL_Z_LIMIT) {
		const temp1 = nside * (0.5 + tt)
		const temp2 = nside * z * 0.75
		const jp = Math.floor(temp1 - temp2)
		const jm = Math.floor(temp1 + temp2)
		const ifp = Math.floor(jp / nside)
		const ifm = Math.floor(jm / nside)

		if (ifp === ifm) face = ifp | 4
		else if (ifp < ifm) face = ifp
		else face = ifm + 8

		ix = pmod(jm, nside)
		iy = nside - pmod(jp, nside) - 1
	} else {
		const ntt = Math.min(3, Math.floor(tt))
		const tp = tt - ntt
		const tmp = nside * Math.sqrt(3 * (1 - absZ))
		const jp = Math.min(nside - 1, Math.floor(tp * tmp))
		const jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp))

		if (z >= 0) {
			face = ntt
			ix = nside - jm - 1
			iy = nside - jp - 1
		} else {
			face = ntt + 8
			ix = jp
			iy = jm
		}
	}

	return faceXYToPixel(face, ix, iy, nside)
}

// Converts a nested pixel to its face-local coordinates.
function pixelToFaceXY(pixel: number, nside: number) {
	const pixelsPerFace = nside * nside
	const face = Math.floor(pixel / pixelsPerFace)
	const nested = pixel - face * pixelsPerFace
	const order = nsideToOrder(nside)
	const [ix, iy] = deinterleaveBits(nested, order)
	return [face, ix, iy] as const
}

// Converts face-local coordinates to a nested pixel.
function faceXYToPixel(face: number, ix: number, iy: number, nside: number) {
	return face * nside * nside + interleaveBits(ix, iy, nsideToOrder(nside))
}

// Converts face-local coordinates to a ring-ordered pixel.
function faceXYToRing(face: number, ix: number, iy: number, nside: number) {
	const jr = JRLL[face] * nside - ix - iy - 1
	const npix = HEALPIX_FACE_COUNT * nside * nside
	const ncap = 2 * nside * (nside - 1)

	let nr = nside
	let start = 0
	let kshift = 0

	if (jr < nside) {
		nr = jr
		start = 2 * nr * (nr - 1)
	} else if (jr > 3 * nside) {
		nr = 4 * nside - jr
		start = npix - 2 * nr * (nr + 1)
	} else {
		start = ncap + (jr - nside) * 4 * nside
		kshift = pmod(jr - nside, 2)
	}

	let jp = (JPLL[face] * nr + ix - iy + 1 + kshift) / 2

	if (jp > 4 * nside) jp -= 4 * nside
	else if (jp < 1) jp += 4 * nside

	return start + jp - 1
}

// Converts a ring-ordered pixel to face-local coordinates.
function ringToFaceXY(pixel: number, nside: number) {
	const npix = HEALPIX_FACE_COUNT * nside * nside
	const ncap = 2 * nside * (nside - 1)

	let jr: number
	let nr: number
	let jp: number
	let kshift = 0

	if (pixel < ncap) {
		jr = Math.floor((1 + Math.sqrt(1 + 2 * pixel)) / 2)
		nr = jr
		jp = pixel + 1 - 2 * jr * (jr - 1)
	} else if (pixel < npix - ncap) {
		const offset = pixel - ncap
		jr = Math.floor(offset / (4 * nside)) + nside
		nr = nside
		jp = pmod(offset, 4 * nside) + 1
		kshift = pmod(jr - nside, 2)
	} else {
		const offset = npix - pixel
		nr = Math.floor((1 + Math.sqrt(2 * offset - 1)) / 2)
		jr = 4 * nside - nr
		jp = 4 * nr + 1 - (offset - 2 * nr * (nr - 1))
	}

	for (let face = 0; face < HEALPIX_FACE_COUNT; face++) {
		const sum = JRLL[face] * nside - jr - 1
		const diff = 2 * jp - JPLL[face] * nr - 1 - kshift
		const ix = (sum + diff) / 2
		const iy = (sum - diff) / 2

		if (!Number.isInteger(ix) || !Number.isInteger(iy)) continue
		if (ix < 0 || ix >= nside || iy < 0 || iy >= nside) continue
		if (faceXYToRing(face, ix, iy, nside) === pixel) return [face, ix, iy] as const
	}

	throw new Error(`unable to convert ring pixel ${pixel} to face coordinates`)
}

// Converts a ring-ordered pixel to spherical center coordinates.
function ringPixelToLonLat(pixelNside: number, pixel: number) {
	const npix = HEALPIX_FACE_COUNT * pixelNside * pixelNside
	const ncap = 2 * pixelNside * (pixelNside - 1)

	let iring: number
	let iphi: number
	let z: number
	let phi: number

	if (pixel < ncap) {
		iring = Math.floor((1 + Math.sqrt(1 + 2 * pixel)) / 2)
		iphi = pixel + 1 - 2 * iring * (iring - 1)
		z = 1 - (iring * iring) / (3 * pixelNside * pixelNside)
		phi = ((iphi - 0.5) * PI) / (2 * iring)
	} else if (pixel < npix - ncap) {
		const offset = pixel - ncap
		iring = Math.floor(offset / (4 * pixelNside)) + pixelNside
		iphi = pmod(offset, 4 * pixelNside) + 1
		const kshift = pmod(iring - pixelNside, 2)
		z = (2 * (2 * pixelNside - iring)) / (3 * pixelNside)
		phi = ((iphi - (kshift + 1) * 0.5) * PI) / (2 * pixelNside)
	} else {
		const offset = npix - pixel
		iring = Math.floor((1 + Math.sqrt(2 * offset - 1)) / 2)
		iphi = 4 * iring + 1 - (offset - 2 * iring * (iring - 1))
		z = (iring * iring) / (3 * pixelNside * pixelNside) - 1
		phi = ((iphi - 0.5) * PI) / (2 * iring)
	}

	return [normalizeAngle(phi), Math.asin(clamp(z, -1, 1))] as const
}

// Converts a face-local position to spherical coordinates.
function faceXYToLonLat(face: number, x: number, y: number, nside: number) {
	const jr = JRLL[face] * nside - x - y

	let nr = nside
	let z: number
	let poleLatitude = 0

	if (jr < nside) {
		nr = jr
		z = 1 - (jr * jr) / (3 * nside * nside)
		poleLatitude = PIOVERTWO
	} else if (jr > 3 * nside) {
		nr = 4 * nside - jr
		z = (nr * nr) / (3 * nside * nside) - 1
		poleLatitude = -PIOVERTWO
	} else {
		z = (2 * (2 * nside - jr)) / (3 * nside)
	}

	if (nr <= EPSILON) {
		return [normalizeAngle((JPLL[face] * PI) / 4), poleLatitude] as const
	}

	const longitude = normalizeAngle(((JPLL[face] * nr + x - y) * PI) / (4 * nr))

	return [longitude, Math.asin(clamp(z, -1, 1))] as const
}

// Converts a face-local position to a unit vector.
function faceXYToVec(face: number, x: number, y: number, nside: number) {
	const [longitude, latitude] = faceXYToLonLat(face, x, y, nside)
	return lonLatToVec(longitude, latitude)
}

// Interleaves the X and Y nested bits.
function interleaveBits(ix: number, iy: number, order: number) {
	let pixel = 0
	let bit = 1
	let offset = 1

	for (let i = 0; i < order; i++) {
		if ((ix & bit) !== 0) pixel |= offset
		offset <<= 1
		if ((iy & bit) !== 0) pixel |= offset
		offset <<= 1
		bit <<= 1
	}

	return pixel
}

// Extracts the X and Y nested bits.
function deinterleaveBits(pixel: number, order: number) {
	let ix = 0
	let iy = 0
	let bit = 1

	for (let i = 0; i < order; i++) {
		const digit = pixel & 3
		if ((digit & 1) !== 0) ix |= bit
		if (digit >= 2) iy |= bit
		pixel >>= 2
		bit <<= 1
	}

	return [ix, iy] as const
}

// Converts a valid NSIDE to its order.
function nsideToOrder(nside: number) {
	return Math.round(Math.log2(nside))
}

// Builds a convex spherical region from coordinate or vector vertices.
function buildRegion(vertices: readonly HealpixVertexInput[], label: 'triangle' | 'polygon'): HealpixRegion {
	const cleaned = normalizeRegionVertices(vertices)

	if (cleaned.length < 3) {
		throw new Error(`${label} requires at least three distinct vertices`)
	}

	if (label === 'triangle' && cleaned.length !== 3) {
		throw new Error('triangle requires exactly three vertices')
	}

	const centroid: MutVec3 = [0, 0, 0]

	for (let i = 0; i < cleaned.length; i++) {
		const vertex = cleaned[i]
		centroid[0] += vertex[0]
		centroid[1] += vertex[1]
		centroid[2] += vertex[2]
	}

	if (Math.hypot(centroid[0], centroid[1], centroid[2]) <= EPSILON) {
		throw new Error(`${label} vertices do not define a stable convex region`)
	}

	const normalizedCentroid = vecNormalize(centroid)

	const edgeNormals: Vec3[] = []
	let orientation = 0

	for (let i = 0; i < cleaned.length; i++) {
		const a = cleaned[i]
		const b = cleaned[(i + 1) % cleaned.length]
		const normal = vecCross(a, b)
		const normalLength = Math.hypot(normal[0], normal[1], normal[2])

		if (normalLength <= EPSILON) {
			throw new Error(`${label} contains repeated or antipodal vertices`)
		}

		edgeNormals.push([normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength])

		const side = vecDot(normal, normalizedCentroid)
		if (Math.abs(side) <= EPSILON) continue

		const nextOrientation = side > 0 ? 1 : -1
		if (orientation === 0) orientation = nextOrientation
		else if (orientation !== nextOrientation) {
			throw new Error(`${label} must be an ordered convex spherical polygon`)
		}
	}

	if (orientation === 0) {
		throw new Error(`${label} vertices do not define a stable interior orientation`)
	}

	if (orientation < 0) {
		for (let i = 0; i < edgeNormals.length; i++) {
			vecNegateMut(edgeNormals[i] as MutVec3)
		}
	}

	if (label === 'triangle' && Math.abs(vecTripleProduct(cleaned[0], cleaned[1], cleaned[2])) <= EPSILON) {
		throw new Error('triangle vertices are degenerate')
	}

	return { vertices: cleaned, edgeNormals }
}

// Normalizes region vertices and removes repeated closing vertices.
function normalizeRegionVertices(vertices: readonly HealpixVertexInput[]) {
	const normalized: Vec3[] = []

	for (const vertex of vertices) {
		const vector = normalizeVertexInput(vertex)

		if (normalized.length > 0 && sameUnitVector(vector, normalized[normalized.length - 1])) {
			continue
		}

		normalized.push(vector)
	}

	if (normalized.length > 1 && sameUnitVector(normalized[0], normalized[normalized.length - 1])) {
		normalized.pop()
	}

	return normalized
}

// Normalizes a vertex input into a unit vector.
function normalizeVertexInput(vertex: HealpixVertexInput) {
	if (vertex.length === 2) {
		return lonLatToVec(normalizeLongitude(vertex[0]), normalizeLatitude(vertex[1]))
	}

	return vecNormalize(vertex)
}

// Tests whether two unit vectors represent the same spherical position.
function sameUnitVector(a: Vec3, b: Vec3) {
	return vecDot(a, b) >= 1 - VERTEX_EPSILON
}

// Computes whether a unit vector lies inside a convex spherical region.
function pointInRegion(point: Vec3, region: HealpixRegion) {
	for (let i = 0; i < region.edgeNormals.length; i++) {
		const side = vecDot(region.edgeNormals[i], point)
		if (side < -EPSILON) return false
	}

	return true
}

// Computes the minimum angular distance from a point to a convex spherical region.
function distanceToRegion(point: Vec3, region: HealpixRegion) {
	if (pointInRegion(point, region)) return 0

	let distance = PI

	for (let i = 0; i < region.vertices.length; i++) {
		const a = region.vertices[i]
		const b = region.vertices[(i + 1) % region.vertices.length]
		const edgeDistance = pointToArcDistance(point, a, b)
		if (edgeDistance < distance) distance = edgeDistance
	}

	return distance
}

// Computes the angular distance from a point to a great-circle arc.
function pointToArcDistance(point: Vec3, start: Vec3, end: Vec3) {
	const normal = vecCross(start, end)
	const normalLength = Math.hypot(normal[0], normal[1], normal[2])

	if (normalLength <= EPSILON) {
		return Math.min(angularDistance(point, start), angularDistance(point, end))
	}

	const unitNormal = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength] as const
	const projection = [point[0] - unitNormal[0] * vecDot(point, unitNormal), point[1] - unitNormal[1] * vecDot(point, unitNormal), point[2] - unitNormal[2] * vecDot(point, unitNormal)] as const
	const projectionLength = Math.hypot(projection[0], projection[1], projection[2])

	if (projectionLength <= EPSILON) {
		return Math.min(angularDistance(point, start), angularDistance(point, end))
	}

	const closest = [projection[0] / projectionLength, projection[1] / projectionLength, projection[2] / projectionLength] as const
	const arcLength = angularDistance(start, end)

	if (angularDistance(start, closest) + angularDistance(closest, end) <= arcLength + 1e-12) {
		return angularDistance(point, closest)
	}

	return Math.min(angularDistance(point, start), angularDistance(point, end))
}

// Recursively covers a region with nested pixels.
function coverPixels(nside: number, options: HealpixCoverOptions, tester: { intersects(center: Vec3, bound: number): boolean }) {
	const targetNside = options.targetNside ?? nside
	validateNside(targetNside)

	const order = nsideToOrder(targetNside)
	const maxDepth = options.maxDepth === undefined ? order : validateMaxDepth(options.maxDepth, order)
	const pixels: number[] = []
	const state: HealpixCoverState = {
		nside: targetNside,
		order,
		maxDepth,
		pixels,
		intersects: tester.intersects,
	}

	for (let face = 0; face < HEALPIX_FACE_COUNT; face++) {
		coverFace(state, face, 0, 0, targetNside, 0)
	}

	if (options.ordering === 'ring') {
		for (let i = 0; i < pixels.length; i++) {
			pixels[i] = nestedToRing(targetNside, pixels[i])
		}
	}

	return pixels
}

// Validates an optional maximum recursion depth.
function validateMaxDepth(maxDepth: number, order: number) {
	if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > order) {
		throw new Error(`invalid HEALPix cover maxDepth: ${maxDepth}. Expected an integer in [0, ${order}]`)
	}

	return maxDepth
}

// Covers a single recursive face cell.
function coverFace(state: HealpixCoverState, face: number, x0: number, y0: number, span: number, depth: number) {
	const center = faceXYToVec(face, x0 + span * 0.5, y0 + span * 0.5, state.nside)
	const bound = Math.min(PI, (COVER_BOUND_FACTOR * span) / state.nside)

	if (!state.intersects(center, bound)) {
		return
	}

	if (span === 1 || depth >= state.maxDepth) {
		appendPixels(state.pixels, face, x0, y0, span, state.nside)
		return
	}

	const half = span / 2

	coverFace(state, face, x0, y0, half, depth + 1)
	coverFace(state, face, x0 + half, y0, half, depth + 1)
	coverFace(state, face, x0, y0 + half, half, depth + 1)
	coverFace(state, face, x0 + half, y0 + half, half, depth + 1)
}

// Appends every nested descendant pixel inside a face-local cell.
function appendPixels(pixels: number[], face: number, x0: number, y0: number, span: number, nside: number) {
	for (let iy = y0; iy < y0 + span; iy++) {
		for (let ix = x0; ix < x0 + span; ix++) {
			pixels.push(faceXYToPixel(face, ix, iy, nside))
		}
	}
}
