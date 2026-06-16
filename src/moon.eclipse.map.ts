import type { Angle } from './angle'
import { DAYSEC, DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import { geoPolylinesToSvgPathData, normalizeLongitude, pointsToSvgPathData, splitPolygonAtAntimeridian, type EclipseGeoBranch, type EclipseGeoCurve, type EclipseGeoPoint, type SunMoonProvider } from './eclipse'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import type { LunarEclipse } from './moon'
import type { CylindricalProjection, ProjectionOptions, RaAxisDirection } from './projection'
import type { SolarEclipseMapSvgProjectionOptions } from './sun.eclipse.map'
import { tt, type Time, toJulianDay } from './time'
import type { Writable } from './types'

// Lunar eclipse map geometry engine.
//
// Unlike a solar eclipse, the lunar event happens ON the Moon, not on the Earth's surface, so the terrestrial
// map does not represent the umbra/penumbra sweeping the ground. Instead, each global curve marks WHERE THE
// MOON IS ON THE HORIZON at a given contact instant (P1, U1, U2, MAX, U3, U4, P4): the boundary between the
// hemisphere that sees the Moon above the horizon and the hemisphere that does not. The physical umbra and
// penumbra geometry belongs to the Moon's plane and is exposed by the local view, not by this global map.
//
// Geometry of one contact curve: rise/set is a TOPOCENTRIC condition, so the curve is the locus where the
// observer's topocentric Moon altitude equals a chosen visibility horizon h0. That locus is still a small
// circle on the sphere centered at the sublunar point (the place where the Moon is at the zenith), but its
// geocentric angular radius is (PI/2 - h0 - p), where p = asin(cos(h0) / d) is the lunar parallax in altitude
// at zenith distance (90 deg - h0) and d is the Moon distance in Earth equatorial radii. Folding the parallax
// into the radius keeps the topocentric center on the horizon h0; using the bare geocentric radius (PI/2 - h0)
// would leave every point about one horizontal parallax (~0.95 deg) above the rise/set boundary it should mark.
// The reduction uses a spherical observer (geocentric radius 1 equatorial Earth radius); the residual flattening
// term is well under the curve resolution. The sublunar point is at latitude = declination and longitude =
// rightAscension - GAST. The circle is swept by bearing, which is robust at high declination and near the poles,
// where a longitude scan would be double-valued or undefined.
//
// Unit conventions:
//   - angles (right ascension, declination, longitude, latitude, altitudes) in radians;
//   - longitude is east-positive in [-PI, PI], latitude is geodetic in [-PI/2, PI/2];
//   - times are Time (the LunarEclipse contact times are TT) or Julian Day.

// The seven possible lunar eclipse contacts, in chronological order around maximum.
export type LunarEclipseContactKind = 'P1' | 'U1' | 'U2' | 'MAX' | 'U3' | 'U4' | 'P4'

// Atmospheric refraction lift at the geometric horizon (radians, ~34'). Applied to h0 when refraction is on so
// the curve marks where the Moon is seen on the apparent horizon rather than the true horizon.
const HORIZON_REFRACTION: Angle = (34 / 60) * DEG2RAD

// Mean lunar radius as a fraction of the Earth's equatorial radius (the IAU k factor for the apparent disk).
// The apparent lunar semidiameter at geocentric Moon distance d (Earth equatorial radii) is
// asin(MOON_RADIUS_EARTH_RADII / d): ~0.259 deg at the mean distance, ~0.279 deg near perigee. This is the
// physical disk radius, distinct from the Meeus shadow-plane lunar radius used by the local magnitudes.
export const MOON_RADIUS_EARTH_RADII = 0.2725076

// Mean lunar semidiameter (radians, ~0.259 deg), used only as the upper-limb fallback when the Moon distance is
// unusable. With a usable distance the per-event semidiameter asin(MOON_RADIUS_EARTH_RADII / distance) is used.
const MEAN_MOON_SEMIDIAMETER: Angle = 0.259 * DEG2RAD

// Default angular spacing (radians, 1 deg) between neighboring horizon-curve points.
const DEFAULT_MAX_ANGULAR_STEP: Angle = DEG2RAD

// Hard ceiling on the number of points per horizon circle. A pathologically small but finite maxAngularStep
// (e.g. a unit-conversion typo, or Number.MIN_VALUE) passes the finite-positive option check yet would derive a
// count that overflows the maximum safe array length and throw a RangeError from new Array(...). Capping keeps
// geometry generation robust; the ceiling is far above any useful map resolution (~0.0036 deg spacing).
const MAX_HORIZON_CIRCLE_POINTS = 100000

// Visibility criterion for the horizon curve.
//   'center': the Moon's center is on the horizon h0 (the conventional reference-map choice);
//   'upperLimb': the horizon is lowered by the Moon's semidiameter so the curve marks where the upper limb
//   first appears.
export type LunarLimbVisibility = 'center' | 'upperLimb'

// Options controlling the lunar eclipse map geometry.
export interface LunarEclipseMapGeometryOptions {
	// Maximum geodesic spacing (radians) between neighboring horizon-curve points. Default 1 deg.
	readonly maxAngularStep?: Angle
	// Altitude (radians) of the visibility horizon for the Moon center. Default 0 (geometric horizon).
	readonly horizonAltitude?: Angle
	// Whether to lower the horizon by the standard atmospheric refraction (~34'). Default false.
	readonly refraction?: boolean
	// Whether to mark the center on the horizon or the upper limb. Default 'center'.
	readonly limbVisibility?: LunarLimbVisibility
}

// One contact in the lunar eclipse sequence, with its instant.
export interface LunarEclipseContact {
	// Which contact this is.
	readonly kind: LunarEclipseContactKind
	// Instant of the contact (TT, taken from the LunarEclipse).
	readonly time: Time
	// Julian Day of the contact.
	readonly jd: number
}

// One contact enriched with the apparent Moon position and the sublunar point, used to draw the global map.
export interface LunarEclipseMapEvent extends LunarEclipseContact {
	// Apparent geocentric Moon right ascension (radians) at the contact.
	readonly rightAscension: Angle
	// Apparent geocentric Moon declination (radians) at the contact.
	readonly declination: Angle
	// Greenwich apparent sidereal time (radians) at the contact.
	readonly gast: Angle
	// Apparent geocentric Moon distance in Earth equatorial radii, used for the parallax-reduced curve radius.
	readonly distance: number
	// Effective visibility-horizon altitude (radians) used to draw this contact's curve.
	readonly horizonAltitude: Angle
	// Sublunar point: where the Moon is at the local zenith (latitude = declination, longitude = RA - GAST).
	readonly sublunar: EclipseGeoPoint
}

// Per-contact moon rise/set (horizon) curves. Each curve is the small circle where the observer's topocentric
// Moon altitude equals the contact's visibility horizon; it is kept unsplit (one closed branch) and
// projection-agnostic, the antimeridian split happening only at serialization time.
export interface LunarEclipseContactCurves {
	readonly P1?: EclipseGeoCurve
	readonly U1?: EclipseGeoCurve
	readonly U2?: EclipseGeoCurve
	readonly MAX?: EclipseGeoCurve
	readonly U3?: EclipseGeoCurve
	readonly U4?: EclipseGeoCurve
	readonly P4?: EclipseGeoCurve
}

// Projection-agnostic lunar eclipse map geometry: the contact events and their horizon curves.
export interface LunarEclipseMapGeometry {
	// The eclipse this geometry was built from.
	readonly eclipse: LunarEclipse
	// Contact events in chronological order, with apparent Moon positions and sublunar points.
	readonly events: readonly LunarEclipseMapEvent[]
	// Drawable geographic curves.
	readonly lines: {
		// Moon rise/set (horizon) curves, one per existing contact.
		readonly moonRiseSet: LunarEclipseContactCurves
	}
}

// Projected sublunar points (pixel coordinates) per contact.
export interface LunarEclipseMapPoints {
	readonly P1?: Point
	readonly U1?: Point
	readonly U2?: Point
	readonly MAX?: Point
	readonly U3?: Point
	readonly U4?: Point
	readonly P4?: Point
}

// One SVG path data string per contact (empty string when the contact does not exist).
export interface LunarEclipseContactPaths {
	readonly P1: string
	readonly U1: string
	readonly U2: string
	readonly MAX: string
	readonly U3: string
	readonly U4: string
	readonly P4: string
}

// Which side of a contact's horizon curve a fill polygon covers.
//   'aboveHorizon': the visibility cap, where the Moon is up;
//   'belowHorizon': the complementary region, where the Moon is down.
export type LunarEclipseFillRegion = 'aboveHorizon' | 'belowHorizon'

// Options for serializing the lunar eclipse map to SVG, extending the shared projection/polyline options.
export interface LunarEclipseMapSvgOptions extends SolarEclipseMapSvgProjectionOptions {
	// When true, replace each contact's open horizon curve with a closed region polygon, suitable for filling or
	// gradients. Render these paths with fill-rule "evenodd": a near-equatorial cap's complement is emitted as
	// the map rectangle with the cap punched out (two subpaths), which only fills correctly under evenodd.
	//
	// This assumes a cylindrical, full-longitude projection (e.g. PlateCarree) able to represent the +-90 deg
	// latitude edges. When the visibility cap encloses a geographic pole (the usual case) the region is closed
	// along that pole's map edge; when it encloses neither pole (|declination| below the lunar parallax, i.e. a
	// near-equatorial eclipse) the cap ring is filled directly instead.
	readonly fill?: boolean
	// Which side of each horizon curve to fill. Default 'belowHorizon' (the not-visible region, for shading).
	readonly fillRegion?: LunarEclipseFillRegion
}

// SVG path data strings per contact horizon curve, plus projected sublunar points.
export interface LunarEclipseMapSvgPaths {
	// When fill=false, open horizon-curve path data per contact, split at the antimeridian.
	// When fill=true, closed region-polygon path data per contact, present only when the fill option is set.
	readonly moonRiseSet: LunarEclipseContactPaths
	// Projected sublunar points, when present.
	readonly sublunarPoints: LunarEclipseMapPoints
}

const DEFAULT_LUNAR_ECLIPSE_MAP_SVG_OPTIONS: LunarEclipseMapSvgOptions = {
	fill: false,
	fillRegion: 'belowHorizon',
	precision: 2,
}

// Maps each contact kind to the LunarEclipse time field that holds its instant. A field left at the default
// minimal time (day 0) signals that contact does not exist for this eclipse.
const CONTACT_TIME_FIELDS = {
	P1: 'firstContactPenumbraTime',
	U1: 'firstContactUmbraTime',
	U2: 'totalBeginTime',
	MAX: 'maximalTime',
	U3: 'totalEndTime',
	U4: 'lastContactUmbraTime',
	P4: 'lastContactPenumbraTime',
} as const satisfies Record<LunarEclipseContactKind, keyof LunarEclipse>

// The contact sequence per eclipse type, in chronological order.
//   PENUMBRAL: P1, MAX, P4;
//   PARTIAL: P1, U1, MAX, U4, P4;
//   TOTAL: P1, U1, U2, MAX, U3, U4, P4.
const CONTACT_SEQUENCE = {
	PENUMBRAL: ['P1', 'MAX', 'P4'],
	PARTIAL: ['P1', 'U1', 'MAX', 'U4', 'P4'],
	TOTAL: ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4'],
} as const satisfies Record<LunarEclipse['type'], readonly LunarEclipseContactKind[]>

// Whether a Time refers to an existing contact. Absent contacts keep the default minimal time (Julian Day 0, i.e.
// day 0 and fraction 0), so the test is for that exact sentinel rather than a positive day: real contacts before
// JD 0 (ancient eclipses) have negative days and must not be dropped.
function isExistingContactTime(time: Time) {
	return !(time.day === 0 && time.fraction === 0)
}

// Resolves the ordered contact sequence of an eclipse from its type and existing contact times. Absent
// contacts (default minimal time) are filtered out, so a malformed eclipse never yields a zero-time contact.
//   eclipse: lunar eclipse with its TT contact times.
//   returns: contacts in chronological order, each with its instant and Julian Day.
export function lunarEclipseEvents(eclipse: LunarEclipse): LunarEclipseContact[] {
	const contacts: LunarEclipseContact[] = []

	for (const kind of CONTACT_SEQUENCE[eclipse.type]) {
		const time = eclipse[CONTACT_TIME_FIELDS[kind]]
		if (!isExistingContactTime(time)) continue
		contacts.push({ kind, time, jd: toJulianDay(time) })
	}

	return contacts
}

// Greenwich apparent sidereal time (radians) at a contact, consistent with the apparent Moon position. The
// UT1 fraction is derived from the dynamical time and the sample's Delta T, matching the solar eclipse
// engine's mu construction.
//   time: contact instant in a dynamical scale (TT/TDB).
//   deltaT: Delta T (TT - UT1) in seconds for the sample, defaulting to 0 when unavailable.
function contactGast(time: Time, deltaT: number) {
	const ttTime = tt(time)
	const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
	return eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
}

// Distance-independent base visibility-horizon altitude (radians): the configured horizon lowered by the
// standard atmospheric refraction when enabled. The distance-dependent upper-limb lowering is applied per event
// (see buildMapEvent), because the apparent semidiameter varies by ~0.02 deg between apogee and perigee.
function baseHorizonAltitude(horizonAltitude: Angle, refraction: boolean) {
	return refraction ? horizonAltitude - HORIZON_REFRACTION : horizonAltitude
}

// Apparent lunar semidiameter (radians) from the geocentric Moon distance in Earth equatorial radii. Falls back
// to the mean value when the distance is unusable (non-finite, or not larger than the Moon radius).
function moonSemidiameter(distance: number): Angle {
	return distance > MOON_RADIUS_EARTH_RADII && Number.isFinite(distance) ? Math.asin(MOON_RADIUS_EARTH_RADII / distance) : MEAN_MOON_SEMIDIAMETER
}

// Geocentric angular radius (radians) of the topocentric horizon circle: PI/2 - h0 - p, where p =
// asin(cos(h0) / distance) is the lunar parallax in altitude (a degraded distance falls back to no parallax).
// It exceeds PI/2 (a visibility cap larger than a hemisphere, enclosing the sublunar point and both poles) when
// h0 is below the negative parallax, e.g. a sufficiently negative configured horizon.
//   h0: topocentric visibility-horizon altitude (radians).
//   distance: apparent geocentric Moon distance in Earth equatorial radii.
function capRadius(h0: Angle, distance: number): Angle {
	const parallax = distance > 1 && Number.isFinite(distance) ? Math.asin(clamp(Math.cos(h0) / distance, -1, 1)) : 0
	return PIOVERTWO - h0 - parallax
}

// Generates the small circle where the observer's TOPOCENTRIC Moon altitude equals h0, centered at the sublunar
// point. The geocentric angular radius is (PI/2 - h0 - p), where p = asin(cos(h0) / distance) is the parallax in
// altitude that pushes the Moon down for a surface observer; this keeps the topocentric center on the horizon h0
// rather than ~one horizontal parallax above it. Points are swept by bearing so spacing stays near maxAngularStep
// along the circle and the curve is well behaved at high declination and near the poles. The returned branch is
// closed (first point repeated) and projection-agnostic; the antimeridian split happens at serialization time.
//   sublunarLat: latitude of the sublunar point (= Moon declination), radians.
//   sublunarLon: longitude of the sublunar point (= RA - GAST), radians, east-positive.
//   h0: topocentric visibility-horizon altitude, radians.
//   distance: apparent geocentric Moon distance in Earth equatorial radii (sets the parallax reduction).
//   jd: Julian Day stamped on every point of the curve.
//   maxAngularStep: target geodesic spacing between neighboring points, radians.
function horizonCircle(sublunarLat: Angle, sublunarLon: Angle, h0: Angle, distance: number, jd: number, maxAngularStep: Angle) {
	const rho = capRadius(h0, distance)
	const sinClat = Math.sin(sublunarLat)
	const cosClat = Math.cos(sublunarLat)
	const sinRho = Math.sin(rho)
	const cosRho = Math.cos(rho)

	// Bearing step so the along-circle spacing (~sinRho * dTheta) stays within maxAngularStep; clamped so a
	// degenerate tiny circle (h0 near PI/2) still produces a bounded number of samples. The count is also capped
	// at MAX_HORIZON_CIRCLE_POINTS so an extremely small maxAngularStep (which makes bearingStep underflow toward
	// zero) cannot derive a non-finite or unsafe array length and throw a RangeError from new Array(...).
	const bearingStep = maxAngularStep / Math.max(sinRho, 0.05)
	const count = Math.min(Math.max(24, Math.ceil(TAU / bearingStep)), MAX_HORIZON_CIRCLE_POINTS)
	const points: EclipseGeoBranch = new Array(count + 1)

	for (let i = 0; i <= count; i++) {
		const theta = (i % count) * (TAU / count)
		const cosTheta = Math.cos(theta)
		const sinTheta = Math.sin(theta)
		const sinLat = sinClat * cosRho + cosClat * sinRho * cosTheta
		const lat = Math.asin(clamp(sinLat, -1, 1))
		const lon = sublunarLon + Math.atan2(sinTheta * sinRho * cosClat, cosRho - sinClat * sinLat)
		points[i] = { x: normalizeLongitude(lon), y: lat, jd }
	}

	return points
}

// Builds one map event from a contact: computes the apparent Moon position, GAST, the effective horizon and
// the sublunar point. For 'upperLimb' the base horizon is lowered by this event's actual apparent semidiameter
// (from the Moon distance), not a mean, so a near-perigee eclipse marks the upper limb on the right boundary.
//   baseHorizon: distance-independent horizon altitude (configured horizon minus refraction).
//   limbVisibility: 'center' marks the Moon center on the horizon; 'upperLimb' marks the upper limb.
function buildMapEvent(contact: LunarEclipseContact, sunMoonPosition: SunMoonProvider, baseHorizon: Angle, limbVisibility: LunarLimbVisibility): LunarEclipseMapEvent {
	const position = sunMoonPosition(contact.time)
	const gast = contactGast(contact.time, position.deltaT ?? 0)
	const rightAscension = position.moon.rightAscension
	const declination = position.moon.declination
	const distance = position.moon.distance
	const sublunarLon = normalizeLongitude(rightAscension - gast)
	const h0 = limbVisibility === 'upperLimb' ? baseHorizon - moonSemidiameter(distance) : baseHorizon

	return {
		...contact,
		rightAscension,
		declination,
		gast,
		distance,
		horizonAltitude: h0,
		sublunar: { x: sublunarLon, y: declination, jd: contact.jd },
	}
}

// Computes the projection-agnostic lunar eclipse map geometry: the contact events and their moon rise/set
// horizon curves.
//   eclipse: lunar eclipse with its TT contact times.
//   sunMoonPosition: apparent Sun/Moon position provider at a dynamical time (see computeSunMoonPositionAt).
//   options: curve sampling and visibility-horizon options.
export function computeLunarEclipseMapGeometry(eclipse: LunarEclipse, sunMoonPosition: SunMoonProvider, options: LunarEclipseMapGeometryOptions = {}): LunarEclipseMapGeometry {
	const maxAngularStep = options.maxAngularStep !== undefined && Number.isFinite(options.maxAngularStep) && options.maxAngularStep > 0 ? options.maxAngularStep : DEFAULT_MAX_ANGULAR_STEP
	const horizonAltitude = options.horizonAltitude !== undefined && Number.isFinite(options.horizonAltitude) ? options.horizonAltitude : 0
	const baseHorizon = baseHorizonAltitude(horizonAltitude, options.refraction ?? false)
	const limbVisibility = options.limbVisibility ?? 'center'

	const contacts = lunarEclipseEvents(eclipse)
	const events = new Array<LunarEclipseMapEvent>(contacts.length)
	const moonRiseSet: Writable<LunarEclipseContactCurves> = {}

	for (let i = 0; i < contacts.length; i++) {
		const event = buildMapEvent(contacts[i], sunMoonPosition, baseHorizon, limbVisibility)
		events[i] = event
		moonRiseSet[event.kind] = [horizonCircle(event.declination, event.sublunar.x, event.horizonAltitude, event.distance, event.jd, maxAngularStep)]
	}

	return { eclipse, events, lines: { moonRiseSet } }
}

// Serializes one optional contact curve into SVG path data, splitting at the antimeridian during projection.
function curveToSvgPath(curve: EclipseGeoCurve | undefined, projection: CylindricalProjection, options: SolarEclipseMapSvgProjectionOptions) {
	return curve && curve.length > 0 ? geoPolylinesToSvgPathData(curve, projection, options.precision, options.projectionOptions) : ''
}

// Whether the horizon ring encircles a geographic pole, from its total signed longitude winding: a cap that
// contains a pole sweeps all longitudes (winding ~ +-TAU), while a cap that contains neither pole (a
// near-equatorial eclipse, |declination| below the lunar parallax) is a bounded loop (winding ~ 0).
function ringEnclosesPole(ring: EclipseGeoBranch) {
	let winding = 0

	for (let i = 1; i < ring.length; i++) {
		let delta = ring[i].x - ring[i - 1].x
		if (delta > PI) delta -= TAU
		else if (delta < -PI) delta += TAU
		winding += delta
	}

	return Math.abs(winding) > PI
}

// Projects a closed geographic ring into pixel polygon pieces, splitting at the antimeridian first so each
// piece is a self-contained drawable ring.
function projectRingPieces(ring: EclipseGeoBranch, projection: CylindricalProjection, options: ProjectionOptions) {
	const pieces: Point[][] = []

	for (const sub of splitPolygonAtAntimeridian(ring)) {
		const piece: Point[] = []

		for (const point of sub) {
			const projected = projection.project(point.x, point.y, undefined, options)
			if (projected) piece.push(projected)
		}

		if (piece.length >= 3) pieces.push(piece)
	}

	return pieces
}

const WORLD_RECT_BORDERS = [
	[-PI, -PIOVERTWO],
	[PI, -PIOVERTWO],
	[PI, PIOVERTWO],
	[-PI, PIOVERTWO],
] as const

// Projects the four geographic corners of the full map (the +-PI longitude, +-90 deg latitude rectangle).
function projectedWorldRect(projection: CylindricalProjection, options: ProjectionOptions) {
	const rect: Point[] = []

	for (const [lon, lat] of WORLD_RECT_BORDERS) {
		const projected = projection.project(lon, lat, undefined, options)
		projected && rect.push(projected)
	}

	return rect
}

// Fill polygon for a POLE-ENCLOSING cap. The boundary is single-valued in longitude (each meridian crosses it
// once), so the points are sorted into a left-to-right profile and closed along a map pole edge: the enclosed
// pole for the 'aboveHorizon' cap, the opposite pole for its 'belowHorizon' complement. The result is one
// simple polygon.
function polarCapFillPath(ring: EclipseGeoBranch, declination: Angle, projection: CylindricalProjection, region: LunarEclipseFillRegion, precision: number, options: ProjectionOptions) {
	const capPoleLat = declination >= 0 ? PIOVERTWO : -PIOVERTWO
	const edgeLat = region === 'aboveHorizon' ? capPoleLat : -capPoleLat

	// Sort the boundary into a left-to-right profile, dropping the duplicated closing vertex.
	const sorted = ring.slice(0, ring.length - 1).sort((a, b) => a.x - b.x)
	const polygon: Point[] = []

	for (const point of sorted) {
		const projected = projection.project(point.x, point.y, undefined, options)
		if (projected) polygon.push(projected)
	}

	if (polygon.length < 2) return ''

	// Close along the pole edge: from the rightmost boundary point to the +PI corner, across to the -PI corner.
	const right = projection.project(PI, edgeLat, undefined, options)
	const left = projection.project(-PI, edgeLat, undefined, options)
	if (right) polygon.push(right)
	if (left) polygon.push(left)
	if (polygon.length < 3) return ''

	return pointsToSvgPathData([polygon], true, precision)
}

// Fill polygon for a horizon ring that encloses NEITHER pole. Two topologies share this branch:
//   - the usual near-equatorial cap, a bounded ring smaller than a hemisphere around the sublunar point, so the
//     ring bounds the 'aboveHorizon' region;
//   - a cap larger than a hemisphere (a sufficiently negative horizon), where the above-horizon region contains
//     the sublunar point AND both poles and the bounded ring is instead the small antipodal 'belowHorizon' hole.
// The capExceedsHemisphere flag selects which side the ring bounds; the other side is the map rectangle with the
// ring punched out as a hole, which (like the ring's own antimeridian pieces) fills correctly under fill-rule
// "evenodd": a point inside the ring is covered by the rectangle and a ring piece (even -> not filled), a point
// outside only by the rectangle (odd -> filled).
function nonPolarCapFillPath(ring: EclipseGeoBranch, projection: CylindricalProjection, region: LunarEclipseFillRegion, capExceedsHemisphere: boolean, precision: number, options: ProjectionOptions) {
	const ringPieces = projectRingPieces(ring, projection, options)
	if (ringPieces.length === 0) return ''

	// The ring bounds the above-horizon region for a sub-hemisphere cap, and the below-horizon region otherwise;
	// fill it directly when the side it bounds is the requested side, else fill the complement.
	const ringIsAbove = !capExceedsHemisphere
	const wantAbove = region === 'aboveHorizon'
	if (ringIsAbove === wantAbove) return pointsToSvgPathData(ringPieces, true, precision)

	const rect = projectedWorldRect(projection, options)
	if (rect.length < 3) return ''
	return pointsToSvgPathData([rect, ...ringPieces], true, precision)
}

// Recenters a geographic ring's longitudes on the projection's central meridian, mapping each into the signed
// wrapped offset in (-PI, PI] (east-positive). Latitudes and jd are preserved. After recentering, the projection's
// antimeridian seam and its +-PI map edges sit at +-PI in the ring's own longitudes, so the fill's raw-longitude
// split, left-to-right sort and pole-edge close operate in the actual map frame rather than in geographic
// longitude. A zero central meridian with an east axis is the identity and returns the input ring unchanged
// (no allocation), preserving the common-case behavior exactly.
//   ring: closed geographic ring (first vertex repeated as last), longitudes east-positive in [-PI, PI].
//   centralMeridian: projection central meridian (radians): the geographic longitude drawn at the map center.
//   direction: 'east' when longitude increases to the right (the usual map), 'west' otherwise.
function recenterRing(ring: EclipseGeoBranch, centralMeridian: Angle, direction: RaAxisDirection): EclipseGeoBranch {
	if (centralMeridian === 0 && direction === 'east') return ring

	const out: EclipseGeoBranch = new Array(ring.length)

	for (let i = 0; i < ring.length; i++) {
		const point = ring[i]
		const delta = direction === 'west' ? centralMeridian - point.x : point.x - centralMeridian
		out[i] = { x: normalizeLongitude(delta), y: point.y, jd: point.jd }
	}

	return out
}

// Serialize the recentered geometry in a central-meridian-neutral frame: recenterRing already shifted every
// longitude by the central meridian, so projecting must NOT subtract it again. Without this override project()
// re-applies the projection's central meridian (a double shift) and the +-PI pole-edge corners and complement
// rectangle collapse onto the map center, inverting the fill. Scale, false origin and y-axis still come from
// the projection. The fill contract assumes a 'pi'-wrap full-longitude cylindrical map.
const POLAR_CAP_FILL_PROJECTION_OPTIONS: ProjectionOptions = { centralMeridian: 0, raAxisDirection: 'east', longitudeWrapMode: 'pi' }

// Closes one contact's horizon curve into a fillable region polygon and serializes it. The visibility cap either
// encloses a geographic pole (closed along the pole edge, correct whatever its size) or encloses neither pole; in
// the latter case the cap radius distinguishes the usual sub-hemisphere cap from a larger-than-hemisphere cap
// (whose ring is the antipodal below-horizon hole), so the correct side is filled in every case. The geographic
// geometry is not mutated; the closing happens here.
//
// The ring is first recentered into the projection's wrapped-longitude frame and the closing is done with the
// central meridian neutralized to 0 and an east axis, so the +-PI raw-longitude seam, the +-PI map edges (the
// pole-edge corners and the complement rectangle) and the left-to-right ordering coincide with the actual map for
// any cylindrical central meridian. Without this a non-zero central meridian would order and close the cap in the
// geographic frame and fill the side opposite the open curve. The fill contract assumes a 'pi'-wrap cylindrical
// full-longitude projection, so the wrapped serialization forces that mode.
//   event: the map event for the contact (declination selects the enclosed pole; horizon and distance set the
//   cap radius), or undefined.
//   curve: the contact's horizon curve (a single closed ring as its first branch), or undefined.
//   region: which side of the curve to fill.
//   precision: SVG coordinate precision.
//   projectionOptions: projection options with the ring's central-meridian-neutral frame already applied.
//   centralMeridian: effective central meridian (radians) the open curves and sublunar points are projected with
//   (call-time options.projectionOptions first, then the projection's own options); recenters the ring into it.
//   direction: effective longitude axis ('east'/'west'), resolved the same way, so the fill follows the curves.
function contactFillPath(event: LunarEclipseMapEvent | undefined, curve: EclipseGeoCurve | undefined, projection: CylindricalProjection, region: LunarEclipseFillRegion, precision: number, projectionOptions: ProjectionOptions, centralMeridian: Angle, direction: RaAxisDirection) {
	if (!curve || curve.length === 0) return ''

	const ring = curve[0]
	if (ring.length < 4) return ''

	// Recenter the ring so its antimeridian seam and +-PI map edges land at +-PI in the ring's own longitudes,
	// using the SAME effective central meridian and axis the open curves and sublunar points are projected with.
	const wrappedRing = recenterRing(ring, centralMeridian, direction)

	if (ringEnclosesPole(wrappedRing)) return polarCapFillPath(wrappedRing, event?.declination ?? 0, projection, region, precision, projectionOptions)

	const capExceedsHemisphere = event ? capRadius(event.horizonAltitude, event.distance) > PIOVERTWO : false
	return nonPolarCapFillPath(wrappedRing, projection, region, capExceedsHemisphere, precision, projectionOptions)
}

// Projects the lunar eclipse map geometry and serializes each contact's horizon curve into an SVG path data
// string, plus the projected sublunar points. Antimeridian wraps are split into separate subpaths at
// projection time only; the geometry itself is never mutated. When options.fill is set, also returns closed
// region polygons per contact (see contactFillPath).
export function lunarEclipseMapToSvgPaths(geometry: LunarEclipseMapGeometry, projection: CylindricalProjection, options: LunarEclipseMapSvgOptions = DEFAULT_LUNAR_ECLIPSE_MAP_SVG_OPTIONS): LunarEclipseMapSvgPaths {
	const { moonRiseSet } = geometry.lines
	const sublunarPoints: Writable<LunarEclipseMapPoints> = Object.create(null)

	for (const event of geometry.events) {
		const projected = projection.project(event.sublunar.x, event.sublunar.y, undefined, options.projectionOptions)
		if (projected) sublunarPoints[event.kind] = projected
	}

	if (options.fill) {
		const region = options.fillRegion ?? 'belowHorizon'
		const precision = options.precision ?? 2
		const projectionOptions: ProjectionOptions = { ...options.projectionOptions, ...POLAR_CAP_FILL_PROJECTION_OPTIONS }

		// Effective central meridian and longitude axis: call-time projection options first, then the projection's
		// own options, then the defaults - the same resolution project() uses for the open curves and sublunar
		// points, so the recentered fill follows them (reading only projection.options here left the fill at the
		// projection's central meridian while the curves shifted with options.projectionOptions).
		const centralMeridian = options.projectionOptions?.centralMeridian ?? projection.options?.centralMeridian ?? 0
		const direction: RaAxisDirection = options.projectionOptions?.raAxisDirection ?? projection.options?.raAxisDirection ?? 'east'

		// The event per contact drives the fill topology (declination for the enclosed pole, horizon and distance
		// for the cap radius). Absent contacts have no event and no curve, so contactFillPath returns ''.
		const events: Partial<Record<LunarEclipseContactKind, LunarEclipseMapEvent>> = Object.create(null)
		for (const event of geometry.events) events[event.kind] = event

		return {
			sublunarPoints,
			moonRiseSet: {
				P1: contactFillPath(events.P1, moonRiseSet.P1, projection, region, precision, projectionOptions, centralMeridian, direction),
				U1: contactFillPath(events.U1, moonRiseSet.U1, projection, region, precision, projectionOptions, centralMeridian, direction),
				U2: contactFillPath(events.U2, moonRiseSet.U2, projection, region, precision, projectionOptions, centralMeridian, direction),
				MAX: contactFillPath(events.MAX, moonRiseSet.MAX, projection, region, precision, projectionOptions, centralMeridian, direction),
				U3: contactFillPath(events.U3, moonRiseSet.U3, projection, region, precision, projectionOptions, centralMeridian, direction),
				U4: contactFillPath(events.U4, moonRiseSet.U4, projection, region, precision, projectionOptions, centralMeridian, direction),
				P4: contactFillPath(events.P4, moonRiseSet.P4, projection, region, precision, projectionOptions, centralMeridian, direction),
			},
		}
	} else {
		return {
			sublunarPoints,
			moonRiseSet: {
				P1: curveToSvgPath(moonRiseSet.P1, projection, options),
				U1: curveToSvgPath(moonRiseSet.U1, projection, options),
				U2: curveToSvgPath(moonRiseSet.U2, projection, options),
				MAX: curveToSvgPath(moonRiseSet.MAX, projection, options),
				U3: curveToSvgPath(moonRiseSet.U3, projection, options),
				U4: curveToSvgPath(moonRiseSet.U4, projection, options),
				P4: curveToSvgPath(moonRiseSet.P4, projection, options),
			},
		}
	}
}
