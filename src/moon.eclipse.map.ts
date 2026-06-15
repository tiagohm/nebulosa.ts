import type { Angle } from './angle'
import { DAYSEC, DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import type { LunarEclipse } from './moon'
import type { Projection } from './projection'
import { geoPolylinesToSvgPathData, normalizeLongitude, pointsToSvgPathData, splitPolygonAtAntimeridian, type GeoBranch, type GeoCurve, type GeoPoint, type SolarEclipseMapSvgProjectionOptions, type SunMoonPosition } from './sun.eclipse.map'
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
	readonly sublunar: GeoPoint
}

// Per-contact moon rise/set (horizon) curves. Each curve is the small circle where the observer's topocentric
// Moon altitude equals the contact's visibility horizon; it is kept unsplit (one closed branch) and
// projection-agnostic, the antimeridian split happening only at serialization time.
export interface LunarEclipseContactCurves {
	readonly P1?: GeoCurve
	readonly U1?: GeoCurve
	readonly U2?: GeoCurve
	readonly MAX?: GeoCurve
	readonly U3?: GeoCurve
	readonly U4?: GeoCurve
	readonly P4?: GeoCurve
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
	// Lunar parallax in altitude at zenith distance (90 deg - h0): sin(p) = cos(h0) / d for a spherical observer.
	// A degraded distance (non-finite or <= 1) falls back to the geocentric circle.
	const parallax = distance > 1 && Number.isFinite(distance) ? Math.asin(clamp(Math.cos(h0) / distance, -1, 1)) : 0
	const rho = PIOVERTWO - h0 - parallax
	const sinClat = Math.sin(sublunarLat)
	const cosClat = Math.cos(sublunarLat)
	const sinRho = Math.sin(rho)
	const cosRho = Math.cos(rho)

	// Bearing step so the along-circle spacing (~sinRho * dTheta) stays within maxAngularStep; clamped so a
	// degenerate tiny circle (h0 near PI/2) still produces a bounded number of samples.
	const bearingStep = maxAngularStep / Math.max(sinRho, 0.05)
	const count = Math.max(24, Math.ceil(TAU / bearingStep))
	const points: GeoBranch = new Array(count + 1)

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
function buildMapEvent(contact: LunarEclipseContact, sunMoonPosition: (time: Time) => SunMoonPosition, baseHorizon: Angle, limbVisibility: LunarLimbVisibility): LunarEclipseMapEvent {
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
export function computeLunarEclipseMapGeometry(eclipse: LunarEclipse, sunMoonPosition: (time: Time) => SunMoonPosition, options: LunarEclipseMapGeometryOptions = {}): LunarEclipseMapGeometry {
	// Use the requested spacing only when it is a finite positive angle; otherwise fall back to the default, so an
	// invalid maxAngularStep (0, negative, NaN or Infinity) can never make a curve's sample count non-finite and
	// throw a RangeError from new Array(...) before any geometry is returned.
	const maxAngularStep = options.maxAngularStep !== undefined && Number.isFinite(options.maxAngularStep) && options.maxAngularStep > 0 ? options.maxAngularStep : DEFAULT_MAX_ANGULAR_STEP
	const baseHorizon = baseHorizonAltitude(options.horizonAltitude ?? 0, options.refraction ?? false)
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
function curveToSvgPath(curve: GeoCurve | undefined, projection: Projection, options: SolarEclipseMapSvgProjectionOptions) {
	return curve && curve.length > 0 ? geoPolylinesToSvgPathData(curve, projection, options) : ''
}

// Whether the horizon ring encircles a geographic pole, from its total signed longitude winding: a cap that
// contains a pole sweeps all longitudes (winding ~ +-TAU), while a cap that contains neither pole (a
// near-equatorial eclipse, |declination| below the lunar parallax) is a bounded loop (winding ~ 0).
function ringEnclosesPole(ring: GeoBranch) {
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
function projectRingPieces(ring: GeoBranch, projection: Projection, options: SolarEclipseMapSvgProjectionOptions): Point[][] {
	const pieces: Point[][] = []

	for (const sub of splitPolygonAtAntimeridian(ring)) {
		const piece: Point[] = []
		for (const point of sub) {
			const projected = projection.project(point.x, point.y, undefined, options)
			if (projected) piece.push({ x: projected.x, y: projected.y })
		}
		if (piece.length >= 3) pieces.push(piece)
	}

	return pieces
}

// Projects the four geographic corners of the full map (the +-PI longitude, +-90 deg latitude rectangle).
function projectedWorldRect(projection: Projection, options: SolarEclipseMapSvgProjectionOptions): Point[] {
	const rect: Point[] = []
	for (const [lon, lat] of [
		[-PI, -PIOVERTWO],
		[PI, -PIOVERTWO],
		[PI, PIOVERTWO],
		[-PI, PIOVERTWO],
	] as const) {
		const projected = projection.project(lon, lat, undefined, options)
		if (projected) rect.push({ x: projected.x, y: projected.y })
	}
	return rect
}

// Fill polygon for a POLE-ENCLOSING cap. The boundary is single-valued in longitude (each meridian crosses it
// once), so the points are sorted into a left-to-right profile and closed along a map pole edge: the enclosed
// pole for the 'aboveHorizon' cap, the opposite pole for its 'belowHorizon' complement. The result is one
// simple polygon.
function polarCapFillPath(ring: GeoBranch, declination: Angle, projection: Projection, region: LunarEclipseFillRegion, precision: number, options: SolarEclipseMapSvgProjectionOptions): string {
	const capPoleLat = declination >= 0 ? PIOVERTWO : -PIOVERTWO
	const edgeLat = region === 'aboveHorizon' ? capPoleLat : -capPoleLat

	// Sort the boundary into a left-to-right profile, dropping the duplicated closing vertex.
	const sorted = ring.slice(0, ring.length - 1).sort((a, b) => a.x - b.x)

	const polygon: Point[] = []
	for (const point of sorted) {
		const projected = projection.project(point.x, point.y, undefined, options)
		if (projected) polygon.push({ x: projected.x, y: projected.y })
	}
	if (polygon.length < 2) return ''

	// Close along the pole edge: from the rightmost boundary point to the +PI corner, across to the -PI corner.
	const right = projection.project(PI, edgeLat, undefined, options)
	const left = projection.project(-PI, edgeLat, undefined, options)
	if (right) polygon.push({ x: right.x, y: right.y })
	if (left) polygon.push({ x: left.x, y: left.y })
	if (polygon.length < 3) return ''

	return pointsToSvgPathData([polygon], true, precision)
}

// Fill polygon for a cap that encloses NEITHER pole (a near-equatorial eclipse). The cap is the bounded ring
// itself, so 'aboveHorizon' is just the projected ring; 'belowHorizon' (the complement, which contains both
// poles) is the map rectangle with the cap punched out as a hole. Both rely on fill-rule "evenodd": for
// 'belowHorizon' a point inside the cap is covered by the rectangle and a cap piece (even -> not filled), and a
// point outside is covered only by the rectangle (odd -> filled).
function nonPolarCapFillPath(ring: GeoBranch, projection: Projection, region: LunarEclipseFillRegion, precision: number, options: SolarEclipseMapSvgProjectionOptions): string {
	const capPieces = projectRingPieces(ring, projection, options)
	if (capPieces.length === 0) return ''

	if (region === 'aboveHorizon') return pointsToSvgPathData(capPieces, true, precision)

	const rect = projectedWorldRect(projection, options)
	if (rect.length < 3) return ''
	return pointsToSvgPathData([rect, ...capPieces], true, precision)
}

// Closes one contact's horizon curve into a fillable region polygon and serializes it. The visibility cap
// either encloses a geographic pole (closed along the pole edge) or encloses neither pole for a near-equatorial
// eclipse (filled as the bounded ring, or its complement); the topology is read from the ring's winding so the
// correct side is filled in both cases. The geographic geometry is not mutated; the closing happens here.
//   declination: Moon declination at the contact (radians), selecting the enclosed pole for a polar cap.
//   curve: the contact's horizon curve (a single closed ring as its first branch), or undefined.
//   region: which side of the curve to fill.
//   precision: SVG coordinate precision.
//   options: projection polyline options shared with the open-curve serialization.
function contactFillPath(declination: Angle, curve: GeoCurve | undefined, projection: Projection, region: LunarEclipseFillRegion, precision: number, options: SolarEclipseMapSvgProjectionOptions): string {
	if (!curve || curve.length === 0) return ''

	const ring = curve[0]
	if (ring.length < 4) return ''

	if (ringEnclosesPole(ring)) return polarCapFillPath(ring, declination, projection, region, precision, options)
	return nonPolarCapFillPath(ring, projection, region, precision, options)
}

// Projects the lunar eclipse map geometry and serializes each contact's horizon curve into an SVG path data
// string, plus the projected sublunar points. Antimeridian wraps are split into separate subpaths at
// projection time only; the geometry itself is never mutated. When options.fill is set, also returns closed
// region polygons per contact (see contactFillPath).
export function lunarEclipseMapToSvgPaths(geometry: LunarEclipseMapGeometry, projection: Projection, options: LunarEclipseMapSvgOptions = {}): LunarEclipseMapSvgPaths {
	const { moonRiseSet } = geometry.lines
	const sublunarPoints: Writable<LunarEclipseMapPoints> = {}

	for (const event of geometry.events) {
		const projected = projection.project(event.sublunar.x, event.sublunar.y, undefined, options)
		if (projected) sublunarPoints[event.kind] = { x: projected.x, y: projected.y }
	}

	if (options.fill) {
		const region = options.fillRegion ?? 'belowHorizon'
		const precision = options.precision ?? 2

		// Declination per contact drives the enclosed pole; fall back to 0 (north) for an absent contact.
		const declination: Partial<Record<LunarEclipseContactKind, Angle>> = {}
		for (const event of geometry.events) declination[event.kind] = event.declination

		return {
			sublunarPoints,
			moonRiseSet: {
				P1: contactFillPath(declination.P1 ?? 0, moonRiseSet.P1, projection, region, precision, options),
				U1: contactFillPath(declination.U1 ?? 0, moonRiseSet.U1, projection, region, precision, options),
				U2: contactFillPath(declination.U2 ?? 0, moonRiseSet.U2, projection, region, precision, options),
				MAX: contactFillPath(declination.MAX ?? 0, moonRiseSet.MAX, projection, region, precision, options),
				U3: contactFillPath(declination.U3 ?? 0, moonRiseSet.U3, projection, region, precision, options),
				U4: contactFillPath(declination.U4 ?? 0, moonRiseSet.U4, projection, region, precision, options),
				P4: contactFillPath(declination.P4 ?? 0, moonRiseSet.P4, projection, region, precision, options),
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
