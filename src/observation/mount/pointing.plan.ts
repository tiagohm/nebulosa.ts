import { horizonMinimumAltitudeLookup, type HorizonSample } from '../../astronomy/observer/horizon'
import { PI, PIOVERTWO, TAU } from '../../core/constants'
import { expectedPierSide, type PierSide } from '../../devices/indi/device'
import { sphericalSeparation } from '../../math/numerical/geometry'
import { type Angle, deg, normalizeAngle, normalizePI } from '../../math/units/angle'
import { evaluateMountLimits, type MountLimits } from './limits'

// Deterministic sky sampling for a pointing model calibration run. A plan is a list of waypoints fixed on
// the local sky, as hour angle and declination, so a waypoint keeps its altitude and azimuth however long
// the run takes; the caller turns one into a right ascension with the sidereal time of its dispatch and
// checks it again there. Nothing here reads a device or a clock. Angles are radians, azimuth is north
// through east, and hour angle is positive west of the meridian, in [-π, π).

// Pattern of a plan: rings of altitude with area-aware azimuth steps, or a golden-angle spiral.
export type PointingPlanPattern = 'altAzGrid' | 'goldenSpiral'

// Whether a waypoint trains the model or is withheld to measure its predictions on unseen sky.
export type PointingWaypointRole = 'training' | 'heldOut'

// A sky position in the mount's hour angle and declination.
export interface PointingPlanPosition {
	// Hour angle in radians, positive west of the meridian.
	readonly hourAngle: Angle
	// Declination in radians.
	readonly declination: Angle
}

// What a plan must cover and what it must avoid.
export interface PointingPlanOptions {
	// Pattern of the waypoints.
	readonly pattern: PointingPlanPattern
	// Number of waypoints asked for, at least 1.
	readonly count: number
	// Geodetic latitude of the site in radians, north positive.
	readonly latitude: Angle
	// Lowest altitude of a waypoint in radians. Defaults to 20°.
	readonly minimumAltitude?: Angle
	// Highest altitude of a waypoint in radians, which keeps away from the fast azimuth motion near the
	// zenith. Defaults to 85°.
	readonly maximumAltitude?: Angle
	// Half width in radians of the hour-angle band around the upper meridian left without waypoints, so no
	// slew ends where the mount may flip. Defaults to 0.
	readonly meridianAvoidance?: Angle
	// Local horizon mask that waypoints must clear. Defaults to no mask.
	readonly horizon?: readonly HorizonSample[]
	// Mount limits that waypoints must respect, such as a declination range that keeps away from the pole.
	readonly limits?: MountLimits
	// Position the mount starts from, which the slew order begins at. Defaults to the waypoint farthest from
	// the meridian.
	readonly start?: PointingPlanPosition
	// Fraction of the waypoints withheld from the fit, in [0, 1). Defaults to 0.2.
	readonly heldOutFraction?: number
	// Fewest waypoints withheld, while a third of the plan allows it. Defaults to 6.
	readonly minimumHeldOut?: number
}

// One position of a plan, in slew order.
export interface PointingWaypoint extends PointingPlanPosition {
	// Position in the slew order, from 0.
	readonly index: number
	// Azimuth in radians, north through east, in [0, 2π).
	readonly azimuth: Angle
	// Geometric altitude in radians.
	readonly altitude: Angle
	// Pier side a German equatorial mount is expected to take there, which a real slew may not follow.
	readonly expectedPierSide: PierSide
	// Role of the waypoint in the fit.
	readonly role: PointingWaypointRole
}

// A plan and what it could not reach.
export interface PointingPlan {
	// Waypoints in slew order.
	readonly waypoints: readonly PointingWaypoint[]
	// Waypoints that were asked for; more than the plan holds when the allowed sky was too small.
	readonly requestedCount: number
	// Waypoints withheld from the fit.
	readonly heldOutCount: number
	// Waypoints per expected pier side.
	readonly pierSideCounts: Readonly<Record<PierSide, number>>
}

// Default lowest altitude of a waypoint, in radians.
const DEFAULT_MINIMUM_ALTITUDE = deg(20)

// Default highest altitude of a waypoint, in radians.
const DEFAULT_MAXIMUM_ALTITUDE = deg(85)

// Default fraction of the waypoints withheld from the fit.
const DEFAULT_HELD_OUT_FRACTION = 0.2

// Default fewest withheld waypoints.
const DEFAULT_MINIMUM_HELD_OUT = 6

// Golden angle in radians, the azimuth step that never lines up with an earlier turn of the spiral.
const GOLDEN_ANGLE = PI * (3 - Math.sqrt(5))

// Largest candidates per requested waypoint, which bounds the search when the allowed sky is small.
const MAXIMUM_OVERSAMPLING = 16

// A candidate position on the local sky.
interface SkyCandidate extends PointingPlanPosition {
	// Azimuth in radians, north through east.
	readonly azimuth: Angle
	// Geometric altitude in radians.
	readonly altitude: Angle
}

// Converts an azimuth and altitude to the hour angle and declination at a latitude, all in radians.
function candidateAt(azimuth: Angle, altitude: Angle, latitude: Angle): SkyCandidate {
	const sinAltitude = Math.sin(altitude)
	const cosAltitude = Math.cos(altitude)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const declination = Math.asin(Math.min(1, Math.max(-1, sinLatitude * sinAltitude + cosLatitude * cosAltitude * Math.cos(azimuth))))
	const hourAngle = Math.atan2(-cosAltitude * Math.sin(azimuth), sinAltitude * cosLatitude - cosAltitude * Math.cos(azimuth) * sinLatitude)
	return { azimuth: normalizeAngle(azimuth), altitude, hourAngle: normalizePI(hourAngle), declination }
}

// Returns the pier side expected at a position, which is also its side of the meridian: EAST west of it.
function pierSideOf({ hourAngle, declination }: PointingPlanPosition) {
	return expectedPierSide(-hourAngle, declination, 0)
}

// Places count points in altitude rings between low and high, in radians. Rings have about the spacing of
// the points on the sky and hold points in proportion to their circumference, so the zenith gets no pile of
// them. Every other ring starts half a step around. Returns the azimuth and altitude of each point.
function altAzGrid(count: number, low: Angle, high: Angle): (readonly [Angle, Angle])[] {
	const spacing = Math.sqrt((TAU * (Math.sin(high) - Math.sin(low))) / count)
	const rings = Math.max(1, Math.round((high - low) / spacing))
	const altitudes = Array.from({ length: rings }, (_, ring) => low + ((ring + 0.5) * (high - low)) / rings)
	const circumference = altitudes.reduce((sum, altitude) => sum + Math.cos(altitude), 0)
	const shares = altitudes.map((altitude) => (count * Math.cos(altitude)) / circumference)
	const counts = shares.map(Math.floor)
	const order = shares.map((share, ring) => [share - Math.floor(share), ring] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
	const remaining = count - counts.reduce((sum, value) => sum + value, 0)

	for (let i = 0; i < remaining; i++) counts[order[i % rings][1]]++

	const points: (readonly [Angle, Angle])[] = []

	for (let ring = 0; ring < rings; ring++) {
		const size = counts[ring]
		for (let i = 0; i < size; i++) points.push([((i + (ring % 2) / 2) * TAU) / size, altitudes[ring]])
	}

	return points
}

// Places count points along a golden-angle spiral with equal area per point between low and high, in
// radians. Returns the azimuth and altitude of each point.
function goldenSpiral(count: number, low: Angle, high: Angle): (readonly [Angle, Angle])[] {
	const sinLow = Math.sin(low)
	const sinHigh = Math.sin(high)
	return Array.from({ length: count }, (_, i) => [i * GOLDEN_ANGLE, Math.asin(sinHigh - ((i + 0.5) * (sinHigh - sinLow)) / count)] as const)
}

// Keeps the candidates of a generated sky that the mask, the meridian band, and the limits allow.
function allowedCandidates(options: PointingPlanOptions, count: number, low: Angle, high: Angle, horizon: ((azimuth: Angle) => Angle) | undefined): SkyCandidate[] {
	const { pattern, latitude, limits, meridianAvoidance = 0 } = options
	const points = pattern === 'altAzGrid' ? altAzGrid(count, low, high) : goldenSpiral(count, low, high)
	const candidates: SkyCandidate[] = []

	for (const [azimuth, altitude] of points) {
		const candidate = candidateAt(azimuth, altitude, latitude)
		if (Math.abs(candidate.hourAngle) < meridianAvoidance) continue
		if (horizon !== undefined && altitude < horizon(candidate.azimuth)) continue
		if (limits !== undefined && !evaluateMountLimits(candidate, limits).accepted) continue
		candidates.push(candidate)
	}

	return candidates
}

// Removes the candidate closest to its neighbor until count remain, which keeps the spread of the plan.
function trimmed(candidates: SkyCandidate[], count: number) {
	while (candidates.length > count) {
		let crowded = 0
		let smallest = Number.POSITIVE_INFINITY

		for (let i = 0; i < candidates.length; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				const separation = sphericalSeparation(candidates[i].hourAngle, candidates[i].declination, candidates[j].hourAngle, candidates[j].declination)
				if (separation < smallest) {
					smallest = separation
					crowded = j
				}
			}
		}

		candidates.splice(crowded, 1)
	}

	return candidates
}

// Generates a growing sky until count candidates are allowed or the search bound is reached.
function candidatesFor(options: PointingPlanOptions) {
	const { count, minimumAltitude = DEFAULT_MINIMUM_ALTITUDE, maximumAltitude = DEFAULT_MAXIMUM_ALTITUDE } = options
	const horizon = options.horizon?.length ? horizonMinimumAltitudeLookup(options.horizon) : undefined
	const low = Math.max(minimumAltitude, -PIOVERTWO)
	const high = Math.min(maximumAltitude, PIOVERTWO)
	const limit = count * MAXIMUM_OVERSAMPLING
	let generated = count
	let candidates = allowedCandidates(options, generated, low, high, horizon)

	while (candidates.length < count && generated < limit) {
		generated = Math.min(limit, Math.max(generated + 1, Math.ceil((generated * count) / Math.max(1, candidates.length))))
		candidates = allowedCandidates(options, generated, low, high, horizon)
	}

	return trimmed(candidates, count)
}

// Orders one side of the sky by nearest neighbor from a position, appending to the slew order. Returns the
// last position, where the next side continues.
function appendNearest(side: SkyCandidate[], from: PointingPlanPosition | undefined, order: SkyCandidate[]) {
	let current = from

	while (side.length > 0) {
		let next = 0
		let nearest = Number.POSITIVE_INFINITY

		for (let i = 0; i < side.length; i++) {
			const distance = current === undefined ? -Math.abs(side[i].hourAngle) : sphericalSeparation(current.hourAngle, current.declination, side[i].hourAngle, side[i].declination)
			if (distance < nearest) {
				nearest = distance
				next = i
			}
		}

		const [candidate] = side.splice(next, 1)
		order.push(candidate)
		current = candidate
	}

	return current
}

// Orders candidates for short slews: one side of the meridian is finished before the other, so the mount
// flips at most once, and the side the start position is on comes first. Without a start, the west side
// comes first from the waypoint farthest from the meridian.
function slewOrder(candidates: readonly SkyCandidate[], start: PointingPlanPosition | undefined) {
	const west = candidates.filter((candidate) => pierSideOf(candidate) === 'EAST')
	const east = candidates.filter((candidate) => pierSideOf(candidate) !== 'EAST')
	const [first, second] = start !== undefined && pierSideOf(start) !== 'EAST' ? [east, west] : [west, east]
	const order: SkyCandidate[] = []
	const last = appendNearest(first, start, order)
	appendNearest(second, last, order)
	return order
}

// Picks count waypoint indices spread evenly by azimuth over one side of the meridian.
function spreadBySide(side: readonly SkyCandidate[], indices: readonly number[], count: number, heldOut: Set<number>) {
	const sorted = indices.toSorted((a, b) => side[a].azimuth - side[b].azimuth || a - b)
	for (let i = 0; i < count; i++) heldOut.add(sorted[Math.floor(((i + 0.5) * sorted.length) / count)])
}

// Chooses the waypoints withheld from the fit: the larger of the fraction and the minimum, at most a third
// of the plan, split between both sides of the meridian in proportion to their waypoints.
function heldOutIndices(order: readonly SkyCandidate[], fraction: number, minimum: number) {
	const heldOut = new Set<number>()
	const size = order.length
	const count = Math.min(Math.max(Math.ceil(size * fraction), minimum), Math.floor(size / 3))
	const west: number[] = []
	const east: number[] = []

	for (let i = 0; i < size; i++) (pierSideOf(order[i]) === 'EAST' ? west : east).push(i)

	const westCount = Math.min(west.length, Math.max(west.length > 0 && count > 1 && east.length > 0 ? 1 : 0, Math.round((count * west.length) / Math.max(1, size))))
	const eastCount = Math.min(east.length, count - westCount)

	spreadBySide(order, west, westCount, heldOut)
	spreadBySide(order, east, eastCount, heldOut)

	return heldOut
}

// Plans the waypoints of a calibration run. The same options give the same plan. Fewer waypoints than asked
// are returned when the allowed sky cannot hold them; requestedCount tells them apart. Pure, and it does not
// check anything that changes during a run, such as the current position of the mount.
export function planPointingWaypoints(options: PointingPlanOptions): PointingPlan {
	const { count, start, heldOutFraction = DEFAULT_HELD_OUT_FRACTION, minimumHeldOut = DEFAULT_MINIMUM_HELD_OUT } = options
	const order = slewOrder(candidatesFor(options), start)
	const heldOut = heldOutIndices(order, heldOutFraction, minimumHeldOut)
	const pierSideCounts: Record<PierSide, number> = { EAST: 0, WEST: 0, NEITHER: 0 }

	const waypoints = order.map(({ azimuth, altitude, hourAngle, declination }, index): PointingWaypoint => {
		const pierSide = pierSideOf({ hourAngle, declination })
		pierSideCounts[pierSide]++
		return { index, azimuth, altitude, hourAngle, declination, expectedPierSide: pierSide, role: heldOut.has(index) ? 'heldOut' : 'training' }
	})

	return { waypoints, requestedCount: count, heldOutCount: heldOut.size, pierSideCounts }
}
