import type { Angle } from './angle'
import { DAYSEC, DEG2RAD, PIOVERTWO, TAU } from './constants'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import type { LunarEclipse } from './moon'
import type { Projection } from './projection'
import { geoPolylinesToSvgPathData, normalizeLongitude, type GeoBranch, type GeoCurve, type GeoPoint, type SolarEclipseMapSvgProjectionOptions, type SunMoonPosition } from './sun.eclipse.map'
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
// Geometry of one contact curve: the locus where the apparent Moon altitude equals a chosen visibility
// horizon h0 is a small circle on the sphere centered at the sublunar point (the place where the Moon is at
// the zenith) at angular radius (PI/2 - h0). The sublunar point is at latitude = declination and longitude =
// rightAscension - GAST. This is computed by a direct bearing sweep, which is robust at high declination and
// near the poles, where a longitude scan would be double-valued or undefined.
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

// Mean lunar semidiameter (radians) used as a fallback upper-limb lift when no distance is available. The
// Moon's geocentric semidiameter is ~0.259 deg on average; the sublunar-point altitude criterion uses the
// geocentric direction, so a mean value is sufficient for the visibility horizon.
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
	// Effective visibility-horizon altitude (radians) used to draw this contact's curve.
	readonly horizonAltitude: Angle
	// Sublunar point: where the Moon is at the local zenith (latitude = declination, longitude = RA - GAST).
	readonly sublunar: GeoPoint
}

// Per-contact moon rise/set (horizon) curves. Each curve is the small circle where the Moon altitude equals
// the contact's visibility horizon; it is kept unsplit (one closed branch) and projection-agnostic, the
// antimeridian split happening only at serialization time.
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

// SVG path data strings per contact horizon curve, plus projected sublunar points.
export interface LunarEclipseMapSvgPaths {
	// Horizon-curve path data per contact (empty string when the contact does not exist).
	readonly moonRiseSet: {
		readonly P1: string
		readonly U1: string
		readonly U2: string
		readonly MAX: string
		readonly U3: string
		readonly U4: string
		readonly P4: string
	}
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

// Whether a Time refers to an existing contact: the absent contacts keep the default minimal time (day 0).
function isExistingContactTime(time: Time) {
	return time.day > 0
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

// Effective visibility-horizon altitude (radians) for the Moon center, combining the configured horizon, the
// optional refraction lift, and the optional upper-limb lowering by the Moon semidiameter.
function effectiveHorizonAltitude(horizonAltitude: Angle, refraction: boolean, limbVisibility: LunarLimbVisibility) {
	let h0 = horizonAltitude
	if (refraction) h0 -= HORIZON_REFRACTION
	if (limbVisibility === 'upperLimb') h0 -= MEAN_MOON_SEMIDIAMETER
	return h0
}

// Generates the small circle where the Moon altitude equals h0, centered at the sublunar point. The circle has
// spherical radius (PI/2 - h0); points are swept by bearing so spacing stays near maxAngularStep along the
// circle and the curve is well behaved at high declination and near the poles. The returned branch is closed
// (first point repeated) and projection-agnostic; the antimeridian split happens at serialization time.
//   sublunarLat: latitude of the sublunar point (= Moon declination), radians.
//   sublunarLon: longitude of the sublunar point (= RA - GAST), radians, east-positive.
//   h0: visibility-horizon altitude, radians.
//   jd: Julian Day stamped on every point of the curve.
//   maxAngularStep: target geodesic spacing between neighboring points, radians.
function horizonCircle(sublunarLat: Angle, sublunarLon: Angle, h0: Angle, jd: number, maxAngularStep: Angle) {
	const rho = PIOVERTWO - h0
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
// the sublunar point.
function buildMapEvent(contact: LunarEclipseContact, sunMoonPosition: (time: Time) => SunMoonPosition, h0: Angle): LunarEclipseMapEvent {
	const position = sunMoonPosition(contact.time)
	const gast = contactGast(contact.time, position.deltaT ?? 0)
	const rightAscension = position.moon.rightAscension
	const declination = position.moon.declination
	const sublunarLon = normalizeLongitude(rightAscension - gast)

	return {
		...contact,
		rightAscension,
		declination,
		gast,
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
	const maxAngularStep = options.maxAngularStep ?? DEFAULT_MAX_ANGULAR_STEP
	const h0 = effectiveHorizonAltitude(options.horizonAltitude ?? 0, options.refraction ?? false, options.limbVisibility ?? 'center')

	const contacts = lunarEclipseEvents(eclipse)
	const events: LunarEclipseMapEvent[] = new Array(contacts.length)
	const moonRiseSet: Writable<LunarEclipseContactCurves> = {}

	for (let i = 0; i < contacts.length; i++) {
		const event = buildMapEvent(contacts[i], sunMoonPosition, h0)
		events[i] = event
		moonRiseSet[event.kind] = [horizonCircle(event.declination, event.sublunar.x, h0, event.jd, maxAngularStep)]
	}

	return { eclipse, events, lines: { moonRiseSet } }
}

// Serializes one optional contact curve into SVG path data, splitting at the antimeridian during projection.
function curveToSvgPath(curve: GeoCurve | undefined, projection: Projection, options: SolarEclipseMapSvgProjectionOptions) {
	return curve && curve.length > 0 ? geoPolylinesToSvgPathData(curve, projection, options) : ''
}

// Projects the lunar eclipse map geometry and serializes each contact's horizon curve into an SVG path data
// string, plus the projected sublunar points. Antimeridian wraps are split into separate subpaths at
// projection time only; the geometry itself is never mutated.
export function lunarEclipseMapToSvgPaths(geometry: LunarEclipseMapGeometry, projection: Projection, options: SolarEclipseMapSvgProjectionOptions = {}): LunarEclipseMapSvgPaths {
	const { moonRiseSet } = geometry.lines
	const sublunarPoints: Writable<LunarEclipseMapPoints> = {}

	for (const event of geometry.events) {
		const projected = projection.project(event.sublunar.x, event.sublunar.y, undefined, options)
		if (projected) sublunarPoints[event.kind] = { x: projected.x, y: projected.y }
	}

	return {
		moonRiseSet: {
			P1: curveToSvgPath(moonRiseSet.P1, projection, options),
			U1: curveToSvgPath(moonRiseSet.U1, projection, options),
			U2: curveToSvgPath(moonRiseSet.U2, projection, options),
			MAX: curveToSvgPath(moonRiseSet.MAX, projection, options),
			U3: curveToSvgPath(moonRiseSet.U3, projection, options),
			U4: curveToSvgPath(moonRiseSet.U4, projection, options),
			P4: curveToSvgPath(moonRiseSet.P4, projection, options),
		},
		sublunarPoints,
	}
}
