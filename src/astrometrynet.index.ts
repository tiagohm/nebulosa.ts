// Deterministic selection of the minimum practical set of Astrometry.net index files
// required to plate-solve an image. This module only computes index-file descriptors:
// it never downloads, reads, or otherwise touches the filesystem or network.
//
// Index files store star quads whose angular diameters fall in narrow intervals. A field
// is solvable when the catalogue contains quads roughly 10% to 100% of the image size, so
// selection is driven by the field's angular geometry, not by pixel scale alone.
//
// The 5200-series families are spatially tiled with Astrometry.net's internal HEALPix XY
// numbering (resolution 2 -> 48 tiles). The HEALPix XY scheme below is a clean-room port of
// Astrometry.net's `util/healpix.c` (3-clause BSD licensed; see that file's LICENSE header).
// It must NOT be replaced by a standard HEALPix RING or NESTED identifier: the 5200 filename
// suffix is the XY tile id, which differs from RING/NESTED ids for the same coordinate.

import { type Angle, normalizeAngle } from './angle'
import { AMIN2RAD, DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { eraS2c } from './erfa'
import { clamp } from './math'
import type { MutVec3, Vec3 } from './vec3'

// Request describing the imaging system and the desired quad-diameter window.
export interface AstrometryNetIndexRequest {
	// Effective focal length in millimetres, including every optical multiplier
	// (reducers, extenders, Barlows). Must be finite and greater than zero.
	focalLength: number

	// Effective physical pixel pitch in micrometres, including binning
	// (2x2 binning uses twice the native pitch). Must be finite and greater than zero.
	pixelPitch: number

	// Active image width in pixels. Must be a positive safe integer.
	width: number

	// Active image height in pixels. Must be a positive safe integer.
	height: number

	// Optional approximate optical-axis coordinate, in the same inertial frame as the
	// selected index catalogue. Both components are radians. When supplied it lets the
	// selector reduce the tiled 5200-series files to those overlapping the search disc.
	center?: EquatorialCoordinate

	// Maximum angular error of `center`, in radians. Applied only when `center` is supplied.
	// Must be finite and non-negative when provided. Default: 0.
	pointingUncertainty?: Angle

	// Additional conservative allowance for metadata, mount, optical-model, and numerical
	// boundary error, in radians. Applied only when `center` is supplied. Must be finite and
	// non-negative when provided. Default: 0.25 degrees.
	safetyMargin?: Angle

	// Minimum accepted quad diameter as a fraction of the largest image axis. Default: 0.10.
	minQuadFraction?: number

	// Maximum accepted quad diameter as a fraction of the largest image axis. Default: 1.00.
	maxQuadFraction?: number
}

export type AstrometryNetIndexFamily = '5200' | '4100'

// One supported index scale described by its quad-diameter interval.
export interface AstrometryNetIndexScale {
	// Zero-based scale index into the supported manifest (0..19).
	scale: number

	// Index family: spatially tiled '5200' or all-sky '4100'.
	family: AstrometryNetIndexFamily

	// Numeric index identifier used in filenames (e.g. 5203, 4107).
	indexNumber: number

	// Minimum quad diameter represented by the index, in radians.
	minimumQuadDiameter: Angle

	// Maximum quad diameter represented by the index, in radians.
	maximumQuadDiameter: Angle

	// HEALPix resolution (Nside) for tiled families only. Present for 5200-series entries
	// and absent for all-sky 4100-series entries.
	tileResolution?: number
}

// Why a given index file was included in the plan.
export type AstrometryNetIndexFileReason = 'no-field-center' | 'all-sky-index' | 'tile-intersects-search-disc'

// One concrete index file to be fetched by a downstream downloader.
export interface AstrometryNetIndexFile {
	// Index filename without any directory or URL prefix.
	filename: string

	// Index family of the originating scale.
	family: AstrometryNetIndexFamily

	// Numeric index identifier of the originating scale.
	indexNumber: number

	// Zero-based scale index of the originating scale.
	scale: number

	// Astrometry.net internal HEALPix XY tile id. Present only for tiled 5200-series files.
	tileId?: number

	// Reason the file was selected.
	reason: AstrometryNetIndexFileReason
}

export type AstrometryNetIndexCoverageStatus = 'complete' | 'partial' | 'none'

// Whether the requested quad-diameter interval is represented by the supported manifest.
export interface AstrometryNetIndexCoverage {
	// 'complete': the entire requested interval lies inside the continuous manifest range.
	// 'partial': at least one scale overlaps, but part of the requested interval is outside it.
	// 'none': no supported scale overlaps the requested interval.
	status: AstrometryNetIndexCoverageStatus

	// Lowest quad diameter represented by the supported manifest, in radians.
	supportedMinimum: Angle

	// Highest quad diameter represented by the supported manifest, in radians.
	supportedMaximum: Angle
}

// Complete, deterministic index-selection plan with diagnostics.
export interface AstrometryNetIndexPlan {
	// Central pixel angular scale, in radians per pixel.
	pixelScale: Angle

	// Sensor width in millimetres.
	sensorWidth: number

	// Sensor height in millimetres.
	sensorHeight: number

	// Horizontal rectilinear field of view, in radians.
	fieldWidth: Angle

	// Vertical rectilinear field of view, in radians.
	fieldHeight: Angle

	// Largest horizontal or vertical field dimension, in radians. Intentionally the largest
	// image axis, not the diagonal, following Astrometry.net's 10%-to-100%-of-image convention.
	largestFieldDimension: Angle

	// Exact angular distance from the optical axis to an image corner, in radians. Used only
	// for conservative spatial-tile filtering.
	fieldCornerRadius: Angle

	// Normalized center used for spatial filtering. Absent when no center was supplied.
	center?: EquatorialCoordinate

	// Radius of the conservative search disc, in radians and clamped to PI. Absent when no
	// center was supplied.
	tileSearchRadius?: Angle

	// Lower endpoint of the requested quad-diameter interval, in radians.
	minimumRequiredQuadDiameter: Angle

	// Upper endpoint of the requested quad-diameter interval, in radians.
	maximumRequiredQuadDiameter: Angle

	// Coverage status of the requested interval against the supported manifest.
	coverage: AstrometryNetIndexCoverage

	// Selected supported scales in ascending scale order.
	scales: readonly AstrometryNetIndexScale[]

	// Selected index files in deterministic order.
	files: readonly AstrometryNetIndexFile[]
}

// Boundary z where a HEALPix coordinate transitions between the equatorial and polar regimes.
const TWO_THIRDS = 2 / 3

// Height of the equatorial z band (from -2/3 to +2/3), used to project z into unit-square units.
const FOUR_THIRDS = 4 / 3

// Quarter turn in radians, the angular width of a HEALPix base-pixel column in longitude.
const PIOVERFOUR = PI / 4

// Convergence tolerance (in dx/dy units) for the closed-tile edge distance binary search.
// Matches Astrometry.net's `healpix_distance_to_xyz` EPS.
const DISTANCE_SEARCH_EPSILON = 1e-16

// Inclusive boundary tolerance for disc/tile intersection, in radians. Small enough to only
// absorb floating-point rounding near exact boundary contact.
const INTERSECTION_EPSILON = 1e-9

// HEALPix resolution (Nside) for the tiled 5200 families.
const TILE_RESOLUTION = 2

// Number of tiles per tiled scale: 12 * Nside^2 = 48 for resolution 2.
const TILE_FILE_COUNT = 12 * TILE_RESOLUTION * TILE_RESOLUTION

// Default minimum quad diameter as a fraction of the largest image axis.
const DEFAULT_MIN_QUAD_FRACTION = 0.1

// Default maximum quad diameter as a fraction of the largest image axis.
const DEFAULT_MAX_QUAD_FRACTION = 1

// Default conservative safety margin added to the search disc radius, in radians (0.25 degrees).
const DEFAULT_SAFETY_MARGIN = 0.25 * DEG2RAD

// Per-corner dx offsets for a tile's four corners, ordered as Astrometry.net's i/2 (i in 0..3).
const CORNER_DX = [0, 0, 1, 1] as const

// Per-corner dy offsets for a tile's four corners, ordered as Astrometry.net's i%2 (i in 0..3).
const CORNER_DY = [0, 1, 0, 1] as const

// Immutable manifest of every supported scale, with quad-diameter limits converted from the
// documented arcminute reference values to radians once, here at module initialization.
// Family metadata is explicit per entry and must not be inferred from the index number.
export const ASTROMETRY_INDEX_MANIFEST: readonly AstrometryNetIndexScale[] = [
	{ scale: 0, family: '5200', indexNumber: 5200, minimumQuadDiameter: AMIN2RAD * 2, maximumQuadDiameter: AMIN2RAD * 2.8, tileResolution: TILE_RESOLUTION },
	{ scale: 1, family: '5200', indexNumber: 5201, minimumQuadDiameter: AMIN2RAD * 2.8, maximumQuadDiameter: AMIN2RAD * 4, tileResolution: TILE_RESOLUTION },
	{ scale: 2, family: '5200', indexNumber: 5202, minimumQuadDiameter: AMIN2RAD * 4, maximumQuadDiameter: AMIN2RAD * 5.6, tileResolution: TILE_RESOLUTION },
	{ scale: 3, family: '5200', indexNumber: 5203, minimumQuadDiameter: AMIN2RAD * 5.6, maximumQuadDiameter: AMIN2RAD * 8, tileResolution: TILE_RESOLUTION },
	{ scale: 4, family: '5200', indexNumber: 5204, minimumQuadDiameter: AMIN2RAD * 8, maximumQuadDiameter: AMIN2RAD * 11, tileResolution: TILE_RESOLUTION },
	{ scale: 5, family: '5200', indexNumber: 5205, minimumQuadDiameter: AMIN2RAD * 11, maximumQuadDiameter: AMIN2RAD * 16, tileResolution: TILE_RESOLUTION },
	{ scale: 6, family: '5200', indexNumber: 5206, minimumQuadDiameter: AMIN2RAD * 16, maximumQuadDiameter: AMIN2RAD * 22, tileResolution: TILE_RESOLUTION },
	{ scale: 7, family: '4100', indexNumber: 4107, minimumQuadDiameter: AMIN2RAD * 22, maximumQuadDiameter: AMIN2RAD * 30 },
	{ scale: 8, family: '4100', indexNumber: 4108, minimumQuadDiameter: AMIN2RAD * 30, maximumQuadDiameter: AMIN2RAD * 42 },
	{ scale: 9, family: '4100', indexNumber: 4109, minimumQuadDiameter: AMIN2RAD * 42, maximumQuadDiameter: AMIN2RAD * 60 },
	{ scale: 10, family: '4100', indexNumber: 4110, minimumQuadDiameter: AMIN2RAD * 60, maximumQuadDiameter: AMIN2RAD * 85 },
	{ scale: 11, family: '4100', indexNumber: 4111, minimumQuadDiameter: AMIN2RAD * 85, maximumQuadDiameter: AMIN2RAD * 120 },
	{ scale: 12, family: '4100', indexNumber: 4112, minimumQuadDiameter: AMIN2RAD * 120, maximumQuadDiameter: AMIN2RAD * 170 },
	{ scale: 13, family: '4100', indexNumber: 4113, minimumQuadDiameter: AMIN2RAD * 170, maximumQuadDiameter: AMIN2RAD * 240 },
	{ scale: 14, family: '4100', indexNumber: 4114, minimumQuadDiameter: AMIN2RAD * 240, maximumQuadDiameter: AMIN2RAD * 340 },
	{ scale: 15, family: '4100', indexNumber: 4115, minimumQuadDiameter: AMIN2RAD * 340, maximumQuadDiameter: AMIN2RAD * 480 },
	{ scale: 16, family: '4100', indexNumber: 4116, minimumQuadDiameter: AMIN2RAD * 480, maximumQuadDiameter: AMIN2RAD * 680 },
	{ scale: 17, family: '4100', indexNumber: 4117, minimumQuadDiameter: AMIN2RAD * 680, maximumQuadDiameter: AMIN2RAD * 1000 },
	{ scale: 18, family: '4100', indexNumber: 4118, minimumQuadDiameter: AMIN2RAD * 1000, maximumQuadDiameter: AMIN2RAD * 1400 },
	{ scale: 19, family: '4100', indexNumber: 4119, minimumQuadDiameter: AMIN2RAD * 1400, maximumQuadDiameter: AMIN2RAD * 2000 },
]

// Lowest quad diameter represented by the manifest (scale 0 lower bound), in radians.
const SUPPORTED_MINIMUM: Angle = ASTROMETRY_INDEX_MANIFEST[0].minimumQuadDiameter

// Highest quad diameter represented by the manifest (scale 19 upper bound), in radians.
const SUPPORTED_MAXIMUM: Angle = ASTROMETRY_INDEX_MANIFEST.at(-1)!.maximumQuadDiameter

// Returns the square of a number, avoiding Math.pow overhead.
function square(value: number) {
	return value * value
}

// Normalizes a HEALPix base-pixel column offset into [0, 3].
function normalizeColumnOffset(offset: number) {
	return ((offset % 4) + 4) % 4
}

// Computes the angle, in radians, between a unit vector given as scalars and a unit vector `b`.
// Uses the stable atan2(|a x b|, a . b) form instead of acos to preserve small separations.
function unitAngle(ax: number, ay: number, az: number, b: Vec3): Angle {
	const cx = ay * b[2] - az * b[1]
	const cy = az * b[0] - ax * b[2]
	const cz = ax * b[1] - ay * b[0]
	const dot = ax * b[0] + ay * b[1] + az * b[2]
	return Math.atan2(Math.hypot(cx, cy, cz), dot)
}

// Converts a unit direction (vx, vy, vz) to an Astrometry.net HEALPix XY tile id at resolution
// `nside`. Clean-room port of Astrometry.net `xyztohp` + `healpix_compose_xy`. Handles both
// polar caps and the equatorial belt, including RA wraparound through `phi` normalization.
// The result is `(bighp * nside + x) * nside + y`, in [0, 12 * nside^2).
function unitVectorToTile(vx: number, vy: number, vz: number, nside: number): number {
	let phi = Math.atan2(vy, vx)
	if (phi < 0) phi += TAU
	// Longitude within the current base-pixel column, in [0, PI/2).
	const phiT = phi % PIOVERTWO

	let basehp: number
	let x: number
	let y: number

	if (vz >= TWO_THIRDS || vz <= -TWO_THIRDS) {
		// North or south polar cap.
		const north = vz >= TWO_THIRDS
		const zfactor = north ? 1 : -1

		let root = (1 - vz * zfactor) * 3 * square((nside * (2 * phiT - PI)) / PI)
		const kx = root <= 0 ? 0 : Math.sqrt(root)
		root = (1 - vz * zfactor) * 3 * square((nside * 2 * phiT) / PI)
		const ky = root <= 0 ? 0 : Math.sqrt(root)

		let xx: number
		let yy: number
		if (north) {
			xx = nside - kx
			yy = nside - ky
		} else {
			xx = ky
			yy = kx
		}

		x = Math.min(nside - 1, Math.floor(xx))
		y = Math.min(nside - 1, Math.floor(yy))

		const column = normalizeColumnOffset(Math.round((phi - phiT) / PIOVERTWO))
		basehp = north ? column : 8 + column
	} else {
		// Equatorial belt: project into the unit square (z in [-2/3, 2/3], phi_t in [0, PI/2])
		// and rotate into the diagonal (X = northeast, Y = northwest) coordinates.
		const zunits = (vz + TWO_THIRDS) / FOUR_THIRDS
		const phiunits = phiT / PIOVERTWO
		let xx = (zunits + phiunits) * nside
		let yy = (zunits - phiunits + 1) * nside

		const offset = normalizeColumnOffset(Math.round((phi - phiT) / PIOVERTWO))

		if (xx >= nside) {
			xx -= nside
			if (yy >= nside) {
				// North polar base pixel.
				yy -= nside
				basehp = offset
			} else {
				// Right equatorial base pixel.
				basehp = ((offset + 1) % 4) + 4
			}
		} else if (yy >= nside) {
			// Left equatorial base pixel.
			yy -= nside
			basehp = offset + 4
		} else {
			// South polar base pixel.
			basehp = 8 + offset
		}

		x = Math.max(0, Math.min(nside - 1, Math.floor(xx)))
		y = Math.max(0, Math.min(nside - 1, Math.floor(yy)))
	}

	return (basehp * nside + x) * nside + y
}

// Converts a tile id and sub-tile offset (dx, dy in [0, 1]) to a unit direction, writing into
// `out` and returning it. Clean-room port of Astrometry.net `hp_to_xyz`. The base pixel and the
// (x + dx, y + dy) position determine whether the point lies in the equatorial or a polar regime.
function tileToUnitVector(tileId: number, nside: number, dx: number, dy: number, out: MutVec3): MutVec3 {
	const pixelsPerFace = nside * nside
	const bighp = Math.floor(tileId / pixelsPerFace)
	const local = tileId - bighp * pixelsPerFace
	const xp = Math.floor(local / nside)
	const yp = local - xp * nside

	let x = xp + dx
	let y = yp + dy
	let equatorial = true
	let zfactor = 1

	// North polar base pixels (0..3) cover the equatorial regime below the x + y = Nside diagonal.
	if (bighp <= 3 && x + y > nside) {
		equatorial = false
		zfactor = 1
	}
	// South polar base pixels (8..11) cover the equatorial regime above the x + y = Nside diagonal.
	if (bighp >= 8 && x + y < nside) {
		equatorial = false
		zfactor = -1
	}

	let z: number
	let phi: number

	if (equatorial) {
		let column = bighp
		x /= nside
		y /= nside

		let zoff = 0
		let phioff = 0
		if (column <= 3) {
			phioff = 1
		} else if (column <= 7) {
			zoff = -1
			column -= 4
		} else {
			phioff = 1
			zoff = -2
			column -= 8
		}

		z = TWO_THIRDS * (x + y + zoff)
		phi = PIOVERFOUR * (x - y + phioff + 2 * column)
	} else {
		// Polar regime: recover phi_t and z from the (x, y) position (eqns 19/20 of Calabretta &
		// Roukema). South pixels are mirrored into the northern solution via zfactor.
		if (zfactor === -1) {
			const swap = x
			x = nside - y
			y = nside - swap
		}

		let phiT: number
		if (y === nside && x === nside) phiT = 0
		else phiT = (PI * (nside - y)) / (2 * (nside - x + (nside - y)))

		if (phiT < PIOVERFOUR) z = 1 - square((PI * (nside - x)) / ((2 * phiT - PI) * nside)) / 3
		else z = 1 - square((PI * (nside - y)) / (2 * phiT * nside)) / 3

		z *= zfactor

		if (bighp >= 8) phi = PIOVERTWO * (bighp - 8) + phiT
		else phi = PIOVERTWO * bighp + phiT
	}

	if (phi < 0) phi += TAU

	const clampedZ = clamp(z, -1, 1)
	const rad = Math.sqrt(Math.max(0, 1 - clampedZ * clampedZ))
	out[0] = rad * Math.cos(phi)
	out[1] = rad * Math.sin(phi)
	out[2] = clampedZ
	return out
}

// Reusable scratch unit vector for the closest point on a tile during distance evaluation.
const DISTANCE_BEST_SCRATCH: MutVec3 = [0, 0, 0]

// Reusable scratch unit vector for the midpoint probe during distance evaluation.
const DISTANCE_MID_SCRATCH: MutVec3 = [0, 0, 0]

// Reusable squared chord distances to the four tile corners.
const CORNER_DISTANCES = [0, 0, 0, 0]

// Computes the minimum spherical angular distance, in radians, from a unit direction to the
// closed HEALPix tile. Clean-room port of Astrometry.net `healpix_distance_to_xyz`: it finds the
// two nearest corners and binary-searches the shared edge for the closest boundary point.
// Returns 0 when the point lies inside the tile.
function tileDistanceFromUnitVector(tileId: number, nside: number, vx: number, vy: number, vz: number): Angle {
	if (unitVectorToTile(vx, vy, vz, nside) === tileId) return 0

	for (let i = 0; i < 4; i++) {
		tileToUnitVector(tileId, nside, CORNER_DX[i], CORNER_DY[i], DISTANCE_MID_SCRATCH)
		const ddx = vx - DISTANCE_MID_SCRATCH[0]
		const ddy = vy - DISTANCE_MID_SCRATCH[1]
		const ddz = vz - DISTANCE_MID_SCRATCH[2]
		CORNER_DISTANCES[i] = ddx * ddx + ddy * ddy + ddz * ddz
	}

	// Index of the nearest corner and the second nearest corner (stable on ties).
	let nearest = 0
	for (let i = 1; i < 4; i++) {
		if (CORNER_DISTANCES[i] < CORNER_DISTANCES[nearest]) nearest = i
	}
	let second = -1
	for (let i = 0; i < 4; i++) {
		if (i === nearest) continue
		if (second < 0 || CORNER_DISTANCES[i] < CORNER_DISTANCES[second]) second = i
	}

	let dxA: number = CORNER_DX[nearest]
	let dyA: number = CORNER_DY[nearest]
	let dist2A = CORNER_DISTANCES[nearest]
	let dxB: number = CORNER_DX[second]
	let dyB: number = CORNER_DY[second]
	let dist2B = CORNER_DISTANCES[second]

	// The two nearest corners should share an edge. If they do not (a degenerate, near-antipodal
	// configuration), the closest corner is the answer.
	if (dxA !== dxB && dyA !== dyB) {
		tileToUnitVector(tileId, nside, dxA, dyA, DISTANCE_BEST_SCRATCH)
		return unitAngle(vx, vy, vz, DISTANCE_BEST_SCRATCH)
	}

	// Initialize the running best with the nearest corner, then binary-search the shared edge.
	tileToUnitVector(tileId, nside, dxA, dyA, DISTANCE_BEST_SCRATCH)
	let dist2mid = dist2A

	while (true) {
		const dxmid = (dxA + dxB) / 2
		const dymid = (dyA + dyB) / 2

		if ((dxA !== dxB && (Math.abs(dxmid - dxA) < DISTANCE_SEARCH_EPSILON || Math.abs(dxmid - dxB) < DISTANCE_SEARCH_EPSILON)) || (dyA !== dyB && (Math.abs(dymid - dyA) < DISTANCE_SEARCH_EPSILON || Math.abs(dymid - dyB) < DISTANCE_SEARCH_EPSILON))) {
			break
		}

		tileToUnitVector(tileId, nside, dxmid, dymid, DISTANCE_MID_SCRATCH)
		const ddx = vx - DISTANCE_MID_SCRATCH[0]
		const ddy = vy - DISTANCE_MID_SCRATCH[1]
		const ddz = vz - DISTANCE_MID_SCRATCH[2]
		dist2mid = ddx * ddx + ddy * ddy + ddz * ddz

		// The midpoint is a local minimum along the edge; stop when it stops improving.
		if (dist2mid >= dist2A && dist2mid >= dist2B) {
			DISTANCE_BEST_SCRATCH[0] = DISTANCE_MID_SCRATCH[0]
			DISTANCE_BEST_SCRATCH[1] = DISTANCE_MID_SCRATCH[1]
			DISTANCE_BEST_SCRATCH[2] = DISTANCE_MID_SCRATCH[2]
			break
		}

		DISTANCE_BEST_SCRATCH[0] = DISTANCE_MID_SCRATCH[0]
		DISTANCE_BEST_SCRATCH[1] = DISTANCE_MID_SCRATCH[1]
		DISTANCE_BEST_SCRATCH[2] = DISTANCE_MID_SCRATCH[2]

		if (dist2A < dist2B) {
			dist2B = dist2mid
			dxB = dxmid
			dyB = dymid
		} else {
			dist2A = dist2mid
			dxA = dxmid
			dyA = dymid
		}
	}

	// The nearest corner can still beat the converged edge point.
	if (CORNER_DISTANCES[nearest] < dist2mid) {
		tileToUnitVector(tileId, nside, CORNER_DX[nearest], CORNER_DY[nearest], DISTANCE_BEST_SCRATCH)
	}

	return unitAngle(vx, vy, vz, DISTANCE_BEST_SCRATCH)
}

// Validates a HEALPix resolution (Nside). Must be a positive integer.
function validateResolution(resolution: number) {
	if (!Number.isInteger(resolution) || resolution < 1) {
		throw new RangeError(`invalid HEALPix resolution: ${resolution}. Expected a positive integer`)
	}
}

// Validates a tile id against the resolution. Must be an integer in [0, 12 * Nside^2).
function validateTileId(tileId: number, resolution: number) {
	const tileCount = 12 * resolution * resolution
	if (!Number.isInteger(tileId) || tileId < 0 || tileId >= tileCount) {
		throw new RangeError(`invalid HEALPix tile id: ${tileId}. Expected an integer in [0, ${tileCount - 1}]`)
	}
}

// Scratch unit vector reused by the public HEALPix XY operations.
const COORD_SCRATCH: MutVec3 = [0, 0, 0]

// Converts normalized right ascension and declination (radians) to an Astrometry.net XY tile id.
// Right ascension is normalized to [0, TAU); declination is used as supplied.
export function coordinateToTile(rightAscension: Angle, declination: Angle, resolution: number): number {
	validateResolution(resolution)
	eraS2c(normalizeAngle(rightAscension), declination, COORD_SCRATCH)
	return unitVectorToTile(COORD_SCRATCH[0], COORD_SCRATCH[1], COORD_SCRATCH[2], resolution)
}

// Returns the minimum spherical angular distance, in radians, from a coordinate to a closed tile.
export function distanceToTile(tileId: number, resolution: number, rightAscension: Angle, declination: Angle): Angle {
	validateResolution(resolution)
	validateTileId(tileId, resolution)
	eraS2c(normalizeAngle(rightAscension), declination, COORD_SCRATCH)
	return tileDistanceFromUnitVector(tileId, resolution, COORD_SCRATCH[0], COORD_SCRATCH[1], COORD_SCRATCH[2])
}

// Returns true when the closed disc of the given radius (radians) intersects the closed tile.
// Boundary contact counts as intersection, with a minimal rounding tolerance.
export function tileIntersectsDisc(tileId: number, resolution: number, rightAscension: Angle, declination: Angle, radius: Angle): boolean {
	return distanceToTile(tileId, resolution, rightAscension, declination) <= radius + INTERSECTION_EPSILON
}

// Validates that a value is a finite number greater than zero.
function requirePositiveFinite(value: number, name: string) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number`)
	}
}

// Validates that a value is a positive safe integer.
function requirePositiveSafeInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`)
	}
}

// Validates that a value is a finite, non-negative number.
function requireNonNegativeFinite(value: number, name: string) {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite, non-negative number`)
	}
}

// Builds a 5200-series tile file descriptor with a zero-padded two-digit tile id.
function tileFile(scale: AstrometryNetIndexScale, tileId: number, reason: AstrometryNetIndexFileReason): AstrometryNetIndexFile {
	return { filename: `index-${scale.indexNumber}-${tileId.toString().padStart(2, '0')}.fits`, family: '5200', indexNumber: scale.indexNumber, scale: scale.scale, tileId, reason }
}

// Builds an all-sky 4100-series file descriptor (no tile suffix).
function allSkyFile(scale: AstrometryNetIndexScale): AstrometryNetIndexFile {
	return { filename: `index-${scale.indexNumber}.fits`, family: '4100', indexNumber: scale.indexNumber, scale: scale.scale, reason: 'all-sky-index' }
}

// Selects the minimum practical set of Astrometry.net index files for an imaging system.
//
// Index selection is driven by the field's angular quad-diameter window, not by pixel scale
// alone, so all four of `focalLength`, `pixelPitch`, `width`, and `height` are required to derive
// the rectilinear field geometry. The default requested interval spans 10% to 100% of the largest
// image axis (Astrometry.net's documented convention). Every supported scale whose quad-diameter
// interval overlaps the requested interval is included; this is the robust selection mode.
//
// When `center` is supplied, the tiled 5200-series files are reduced to those whose closed
// HEALPix tile intersects a conservative search disc of radius
// `fieldCornerRadius + pointingUncertainty + safetyMargin` (clamped to PI). The 4100-series
// all-sky files are never reduced by a center, since each scale is a single all-sky file.
//
// The selector is pure, synchronous, and deterministic: the same logical request yields the same
// ordered descriptors. It computes descriptors only and performs no I/O.
//
// Throws RangeError for invalid geometry, fractions, dimensions, margins, or center coordinates.
export function selectAstrometryIndexes(request: AstrometryNetIndexRequest): AstrometryNetIndexPlan {
	const { focalLength, pixelPitch, width, height } = request

	requirePositiveFinite(focalLength, 'focalLength')
	requirePositiveFinite(pixelPitch, 'pixelPitch')
	requirePositiveSafeInteger(width, 'width')
	requirePositiveSafeInteger(height, 'height')

	const minQuadFraction = request.minQuadFraction ?? DEFAULT_MIN_QUAD_FRACTION
	const maxQuadFraction = request.maxQuadFraction ?? DEFAULT_MAX_QUAD_FRACTION
	requirePositiveFinite(minQuadFraction, 'minQuadFraction')
	requirePositiveFinite(maxQuadFraction, 'maxQuadFraction')
	if (minQuadFraction > maxQuadFraction) {
		throw new RangeError('minQuadFraction must not exceed maxQuadFraction')
	}

	const pointingUncertainty = request.pointingUncertainty ?? 0
	if (request.pointingUncertainty !== undefined) requireNonNegativeFinite(pointingUncertainty, 'pointingUncertainty')
	const safetyMargin = request.safetyMargin ?? DEFAULT_SAFETY_MARGIN
	if (request.safetyMargin !== undefined) requireNonNegativeFinite(safetyMargin, 'safetyMargin')

	// Rectilinear, pinhole-equivalent focal-plane geometry. Distances in millimetres; angles in
	// radians. This is appropriate for ordinary telescope/camera systems but is not a substitute
	// for a calibrated WCS or distortion model for fisheye or strongly distorted optics.
	const pitchInMillimetres = pixelPitch / 1000
	const sensorWidth = width * pitchInMillimetres
	const sensorHeight = height * pitchInMillimetres
	const pixelScale = 2 * Math.atan(pitchInMillimetres / (2 * focalLength))
	const fieldWidth = 2 * Math.atan(sensorWidth / (2 * focalLength))
	const fieldHeight = 2 * Math.atan(sensorHeight / (2 * focalLength))
	const largestFieldDimension = Math.max(fieldWidth, fieldHeight)
	const halfDiagonal = Math.hypot(sensorWidth * 0.5, sensorHeight * 0.5)
	const fieldCornerRadius = Math.atan(halfDiagonal / focalLength)

	const minimumRequiredQuadDiameter = largestFieldDimension * minQuadFraction
	const maximumRequiredQuadDiameter = largestFieldDimension * maxQuadFraction

	// Normalize and validate the optional field center.
	let center: EquatorialCoordinate | undefined
	let normalizedRA = 0
	let declination = 0
	if (request.center !== undefined) {
		const ra = request.center.rightAscension
		const dec = request.center.declination
		if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
			throw new RangeError('center.rightAscension and center.declination must be finite')
		}
		if (dec < -PIOVERTWO || dec > PIOVERTWO) {
			throw new RangeError('center.declination must be within [-PI/2, PI/2]')
		}
		normalizedRA = normalizeAngle(ra)
		declination = dec
		center = { rightAscension: normalizedRA, declination }
	}

	// Select every supported scale whose closed quad-diameter interval overlaps the requested
	// interval. Boundary contact counts as overlap.
	const scales: AstrometryNetIndexScale[] = []
	for (let i = 0; i < ASTROMETRY_INDEX_MANIFEST.length; i++) {
		const entry = ASTROMETRY_INDEX_MANIFEST[i]
		if (entry.maximumQuadDiameter >= minimumRequiredQuadDiameter && entry.minimumQuadDiameter <= maximumRequiredQuadDiameter) {
			scales.push(entry)
		}
	}

	let status: AstrometryNetIndexCoverageStatus
	if (scales.length === 0) {
		status = 'none'
	} else if (minimumRequiredQuadDiameter >= SUPPORTED_MINIMUM && maximumRequiredQuadDiameter <= SUPPORTED_MAXIMUM) {
		status = 'complete'
	} else {
		status = 'partial'
	}

	const coverage: AstrometryNetIndexCoverage = { status, supportedMinimum: SUPPORTED_MINIMUM, supportedMaximum: SUPPORTED_MAXIMUM }

	// Conservative search disc covering the whole rectangular frame plus the uncertainty envelope.
	let tileSearchRadius: Angle | undefined
	// Center unit vector, computed once and reused across the 48-tile intersection loop.
	let centerVx = 0
	let centerVy = 0
	let centerVz = 0
	if (center !== undefined) {
		tileSearchRadius = Math.min(PI, fieldCornerRadius + pointingUncertainty + safetyMargin)
		eraS2c(normalizedRA, declination, COORD_SCRATCH)
		centerVx = COORD_SCRATCH[0]
		centerVy = COORD_SCRATCH[1]
		centerVz = COORD_SCRATCH[2]
	}

	// Expand selected scales into concrete files in deterministic order: ascending scale, and for
	// each tiled scale ascending tile id.
	const files: AstrometryNetIndexFile[] = []
	for (let i = 0; i < scales.length; i++) {
		const scale = scales[i]

		if (scale.family === '4100') {
			files.push(allSkyFile(scale))
			continue
		}

		if (center === undefined) {
			for (let tile = 0; tile < TILE_FILE_COUNT; tile++) {
				files.push(tileFile(scale, tile, 'no-field-center'))
			}
		} else if (tileSearchRadius! >= PI) {
			for (let tile = 0; tile < TILE_FILE_COUNT; tile++) {
				files.push(tileFile(scale, tile, 'tile-intersects-search-disc'))
			}
		} else {
			const radius = tileSearchRadius! + INTERSECTION_EPSILON
			for (let tile = 0; tile < TILE_FILE_COUNT; tile++) {
				if (tileDistanceFromUnitVector(tile, TILE_RESOLUTION, centerVx, centerVy, centerVz) <= radius) {
					files.push(tileFile(scale, tile, 'tile-intersects-search-disc'))
				}
			}
		}
	}

	return {
		pixelScale,
		sensorWidth,
		sensorHeight,
		fieldWidth,
		fieldHeight,
		largestFieldDimension,
		fieldCornerRadius,
		center,
		tileSearchRadius,
		minimumRequiredQuadDiameter,
		maximumRequiredQuadDiameter,
		coverage,
		scales,
		files,
	}
}
