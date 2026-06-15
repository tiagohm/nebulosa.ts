import { type Angle, normalizeAngle, normalizePI } from './angle'
import { parallacticAngle } from './astrometry'
import { DAYSEC, PI, WGS84_FLATTENING } from './constants'
import { equatorialToHorizontal } from './coordinate'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import type { LunarEclipse } from './moon'
import { lunarEclipseEvents, type LunarEclipseContact, type LunarEclipseContactKind } from './moon.eclipse.map'
import type { SunMoonPosition } from './sun.eclipse.map'
import { timeShift, tt, type Time } from './time'
import type { Writable } from './types'

// Local lunar eclipse circumstances and Local View geometry.
//
// A lunar eclipse happens on the Moon, so its contact instants (P1..P4) are GLOBAL: every observer shares the
// same times. Only two things vary with the observer's location: whether the Moon is above the horizon at each
// contact (and across the phases), and the topocentric Alt/Az and the P/Z orientation angles. This module
// therefore consumes the already-computed LunarEclipse contact times plus an apparent Sun/Moon position
// provider, and does not rebuild any global eclipse geometry.
//
// Unit conventions: angles in radians; longitude east-positive; latitude geodetic; durations in seconds;
// times are Time (contact times are TT) or Julian Day.

// Shadow model constants (mirrored from moon.ts so the per-contact magnitudes stay consistent with the
// contact times computed there). All radii are in equatorial Earth radii projected on the eclipse plane.

// Enlarged umbra contact limit: |shadow-axis distance| at the umbral external contacts U1/U4.
const LUNAR_ECLIPSE_UMBRA_LIMIT = 1.0128
// Totality limit: |shadow-axis distance| at the total internal contacts U2/U3.
const LUNAR_ECLIPSE_TOTAL_LIMIT = 0.4678
// Enlarged penumbra contact limit: |shadow-axis distance| at the penumbral external contacts P1/P4.
const LUNAR_ECLIPSE_PENUMBRA_LIMIT = 1.5573
// Magnitude denominator: twice the lunar plane radius (the Moon spans 0..1 magnitude over 2 * 0.2725).
const LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR = 0.545
// Lunar radius in plane Earth radii (half the magnitude denominator); constant in the Meeus model.
const MOON_RADIUS_EARTH_RADII = 0.2725
// Mean angular size (radians) of one Earth equatorial radius seen from the Moon (mean distance ~60.27 Earth
// radii). Used only to scale the schematic Local View horizon offset; not a precise per-event value.
const MEAN_EARTH_RADIUS_ANGULAR_AT_MOON: Angle = Math.asin(1 / 60.27)
// Earth polar/equatorial radius ratio (1 - flattening).
const F = 1 - WGS84_FLATTENING

// Coarse local visibility classification of a lunar eclipse for one observer.
export type LocalLunarEclipseVisibilityKind = 'notVisible' | 'penumbralOnlyVisible' | 'partialVisible' | 'totalVisible' | 'completelyVisible' | 'geometricOnlyBelowHorizon'

// Apparent Sun/Moon position provider at a dynamical time (TT/TDB), as produced by computeSunMoonPositionAt.
export type LunarEclipsePositionProvider = (time: Time) => SunMoonPosition

// Options controlling the local circumstances computation.
export interface LocalLunarEclipseCircumstancesOptions {
	// Altitude (radians) of the apparent horizon; the Moon is observable when at or above it. Default 0.
	readonly horizonAltitude?: Angle
	// Number of altitude samples across the penumbral interval for the continuous visibility check. The check
	// detects observable stretches even when every contact is below the horizon (e.g. moonrise mid-eclipse).
	// Default 48 (~7 min spacing for a 6 h eclipse), which resolves any lunar phase comfortably.
	readonly altitudeSamples?: number
}

// One resolved local contact event.
export interface LocalLunarEclipseEvent {
	// Which contact this is.
	readonly kind: LunarEclipseContactKind
	// Instant of the contact (TT).
	readonly time: Time
	// Julian Day of the contact.
	readonly jd: number
	// Whether the Moon is at or above the configured horizon at the contact (topocentric center altitude).
	readonly observable: boolean
	// Topocentric apparent Moon altitude (radians) at the contact for this observer (diurnal parallax applied).
	readonly altitude: Angle
	// Topocentric apparent Moon azimuth (radians) at the contact, measured from North through East, in [0, TAU).
	readonly azimuth: Angle
	// Position angle of the Earth-shadow center on the lunar disk, from celestial north toward east, in
	// [0, TAU). This is the P angle of the contact tables.
	readonly positionAngle: Angle
	// Same direction in the local zenith-oriented frame (Z = P - parallacticAngle), in [0, TAU).
	readonly zenithAngle: Angle
	// Umbral magnitude at the contact. 0 at U1/U4, 1 at U2/U3, the eclipse magnitude at MAX; negative when the
	// Moon is wholly outside the umbra (e.g. at the penumbral contacts P1/P4).
	readonly umbralMagnitude: number
	// Penumbral magnitude at the contact. 0 at P1/P4.
	readonly penumbralMagnitude: number
}

// Coarse local visibility summary.
export interface LocalLunarEclipseVisibility {
	// Classification kind.
	readonly kind: LocalLunarEclipseVisibilityKind
	// Human-readable description of the classification.
	readonly text: string
	// Whether the eclipse touches the Moon geometrically (always true for a real eclipse, regardless of horizon).
	readonly hasGeometricEclipse: boolean
	// Whether any part of the eclipse is observable with the Moon at or above the configured horizon (true even
	// when every contact is below the horizon but the Moon rises above it between contacts).
	readonly hasObservableEclipse: boolean
}

// Maximal magnitudes and phase durations for the local circumstances panel.
export interface LocalLunarEclipseDetails {
	// Maximal umbral magnitude (eclipse magnitude for total/partial), or null for a penumbral eclipse.
	readonly maximalUmbralMagnitude: number | null
	// Maximal penumbral magnitude at greatest eclipse.
	readonly maximalPenumbralMagnitude: number
	// Penumbral-phase duration P4 - P1 in seconds.
	readonly penumbralPhaseDuration: number
	// Partial (umbral) phase duration U4 - U1 in seconds, or null when there is no umbral phase.
	readonly partialPhaseDuration: number | null
	// Total phase duration U3 - U2 in seconds, or null when there is no total phase.
	readonly totalPhaseDuration: number | null
	// Total time (seconds) the Moon is at or above the horizon within the penumbral interval. Approximated from
	// the altitude samples used by the continuous visibility check.
	readonly observableDuration: number
}

// Full local circumstances for one geographic point.
export interface LocalLunarEclipseCircumstances {
	readonly location: {
		// Geographic longitude in radians, east-positive.
		readonly longitude: Angle
		// Geodetic latitude in radians.
		readonly latitude: Angle
	}
	// Coarse visibility classification.
	readonly visibility: LocalLunarEclipseVisibility
	// Maximal magnitudes and durations.
	readonly details: LocalLunarEclipseDetails
	// Resolved per-contact events keyed by contact kind.
	readonly events: Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>
}

// Greenwich apparent sidereal time (radians) at a contact, consistent with the apparent Moon position. The
// UT1 fraction comes from the dynamical time and the sample Delta T, matching the global engine.
function contactGast(time: Time, deltaT: number) {
	const ttTime = tt(time)
	const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
	return eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
}

// Position angle (radians, [0, TAU)) of point 2 as seen from point 1, measured from celestial north toward
// east. Uses the stable atan2 formulation; the Earth shadow center is the antisolar point.
function positionAngleBetween(ra1: Angle, dec1: Angle, ra2: Angle, dec2: Angle) {
	const dRA = ra2 - ra1
	const sinDRA = Math.sin(dRA)
	const cosDRA = Math.cos(dRA)
	const y = Math.cos(dec2) * sinDRA
	const x = Math.cos(dec1) * Math.sin(dec2) - Math.sin(dec1) * Math.cos(dec2) * cosDRA
	return normalizeAngle(Math.atan2(y, x))
}

// |shadow-axis distance| (plane Earth radii) of the Moon at one contact, fixed by the contact kind in the
// Meeus model: this is what makes the per-contact magnitudes exact (0 at the external contacts, 1 at the
// total contacts, the eclipse magnitude at MAX).
//   kind: contact kind.
//   u: penumbra/umbra enlargement term (eclipse.u).
//   gamma: least shadow-axis distance at maximum (eclipse.gamma).
function contactShadowDistance(kind: LunarEclipseContactKind, u: number, gamma: number): number {
	switch (kind) {
		case 'P1':
		case 'P4':
			return LUNAR_ECLIPSE_PENUMBRA_LIMIT + u
		case 'U1':
		case 'U4':
			return LUNAR_ECLIPSE_UMBRA_LIMIT - u
		case 'U2':
		case 'U3':
			return LUNAR_ECLIPSE_TOTAL_LIMIT - u
		case 'MAX':
			return Math.abs(gamma)
	}
}

// Umbral and penumbral magnitudes from the shadow-axis distance and enlargement term. Negative values mean the
// Moon is wholly outside that shadow (kept signed so callers can see how far outside).
function shadowMagnitudes(shadowDistance: number, u: number): [umbral: number, penumbral: number] {
	const umbral = (LUNAR_ECLIPSE_UMBRA_LIMIT - u - shadowDistance) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR
	const penumbral = (LUNAR_ECLIPSE_PENUMBRA_LIMIT + u - shadowDistance) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR
	return [umbral, penumbral]
}

// Topocentric Moon equatorial coordinates (radians) corrected for diurnal parallax. The geocentric apparent
// Moon direction is shifted by the observer's geocentric position before re-deriving right ascension and
// declination. Omitting this (~0.95 deg horizontal parallax) would overstate the altitude near the horizon by
// up to one parallax, marking sub-horizon locations as observable, and would bias the Alt/Az and zenith angle.
//   moonRA, moonDEC: geocentric apparent Moon right ascension/declination (radians).
//   moonDistance: geocentric Moon distance in Earth equatorial radii (position.moon.distance).
//   latitude: observer geodetic latitude (radians).
//   lst: local apparent sidereal time (radians) = GAST + longitude.
//   returns: [topocentric right ascension, topocentric declination] in radians.
function moonTopocentric(moonRA: Angle, moonDEC: Angle, moonDistance: number, latitude: Angle, lst: Angle): [ra: Angle, dec: Angle] {
	// Observer geocentric coordinates (Earth equatorial radii), reduced for Earth flattening (F = b / a). The
	// observer's zenith points to right ascension = lst, geocentric declination = phi'.
	const u = Math.atan(F * Math.tan(latitude))
	const rhoSinPhi = F * Math.sin(u)
	const rhoCosPhi = Math.cos(u)

	const cosD = Math.cos(moonDEC)
	const x = moonDistance * cosD * Math.cos(moonRA) - rhoCosPhi * Math.cos(lst)
	const y = moonDistance * cosD * Math.sin(moonRA) - rhoCosPhi * Math.sin(lst)
	const z = moonDistance * Math.sin(moonDEC) - rhoSinPhi
	const r = Math.hypot(x, y, z)

	return [Math.atan2(y, x), Math.asin(clamp(z / r, -1, 1))]
}

// Topocentric apparent Moon altitude (radians) at one instant for one observer. Applies diurnal parallax, then
// converts to horizontal coordinates. Used by the continuous visibility scan.
function moonAltitudeAt(time: Time, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider) {
	const position = getPosition(time)
	const lst = contactGast(time, position.deltaT ?? 0) + longitude
	const [topoRA, topoDEC] = moonTopocentric(position.moon.rightAscension, position.moon.declination, position.moon.distance, latitude, lst)
	const [, altitude] = equatorialToHorizontal(topoRA, topoDEC, latitude, lst)
	return altitude
}

// Builds one resolved local event: altitude/azimuth, the P/Z orientation angles, and the per-contact
// magnitudes.
function computeLocalEvent(contact: LunarEclipseContact, eclipse: LunarEclipse, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, horizonAltitude: Angle): LocalLunarEclipseEvent {
	const position = getPosition(contact.time)
	const gast = contactGast(contact.time, position.deltaT ?? 0)
	const lst = gast + longitude

	const moonRA = position.moon.rightAscension
	const moonDEC = position.moon.declination

	// Topocentric (parallax-corrected) Moon position drives the observer-dependent quantities: altitude,
	// azimuth and the parallactic angle. The shadow-disk position angle P stays geocentric (the conventional
	// table value): parallax shifts the Moon and the shadow, which lies at the Moon's distance, almost equally.
	const [topoRA, topoDEC] = moonTopocentric(moonRA, moonDEC, position.moon.distance, latitude, lst)
	const [azimuth, altitude] = equatorialToHorizontal(topoRA, topoDEC, latitude, lst)

	// Earth-shadow center = antisolar point. Its position angle on the lunar disk is the table P angle.
	const shadowRA = position.sun.rightAscension + PI
	const shadowDEC = -position.sun.declination
	const positionAngle = positionAngleBetween(moonRA, moonDEC, shadowRA, shadowDEC)

	// Lunar parallactic angle converts the celestial-north P angle into the zenith-oriented Z angle.
	const hourAngle = normalizePI(lst - topoRA)
	const q = parallacticAngle(hourAngle, topoDEC, latitude)
	const zenithAngle = normalizeAngle(positionAngle - q)

	const shadowDistance = contactShadowDistance(contact.kind, eclipse.u, eclipse.gamma)
	const [umbralMagnitude, penumbralMagnitude] = shadowMagnitudes(shadowDistance, eclipse.u)

	return {
		kind: contact.kind,
		time: contact.time,
		jd: contact.jd,
		observable: altitude >= horizonAltitude,
		altitude,
		azimuth,
		positionAngle,
		zenithAngle,
		umbralMagnitude,
		penumbralMagnitude,
	}
}

// Human-readable text for each local visibility classification.
export function localLunarVisibilityText(kind: LocalLunarEclipseVisibilityKind) {
	switch (kind) {
		case 'completelyVisible':
			return 'Entire eclipse visible'
		case 'totalVisible':
			return 'Total phase visible'
		case 'partialVisible':
			return 'Partial (umbral) phase visible'
		case 'penumbralOnlyVisible':
			return 'Only the penumbral phase visible'
		case 'geometricOnlyBelowHorizon':
			return 'Eclipse occurs with the Moon below the horizon'
		case 'notVisible':
			return 'Eclipse not visible'
	}
}

// Result of the continuous altitude scan across the penumbral interval.
interface AltitudeScan {
	// Julian Days of the samples, ascending.
	readonly jds: number[]
	// Moon altitudes (radians) at each sample.
	readonly altitudes: number[]
	// Sample spacing in days.
	readonly step: number
}

// Samples the Moon altitude across the penumbral interval [P1, P4] so the classifier can detect observable
// stretches between contacts. Returns empty arrays when the interval is degenerate.
function scanAltitudes(fromJd: number, toJd: number, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, samples: number, reference: Time): AltitudeScan {
	const jds: number[] = []
	const altitudes: number[] = []
	const span = toJd - fromJd
	if (!(span > 0) || samples < 1) return { jds, altitudes, step: 0 }

	const step = span / samples
	for (let i = 0; i <= samples; i++) {
		const jd = fromJd + i * step
		const time = timeAtJulianDay(reference, jd)
		jds.push(jd)
		altitudes.push(moonAltitudeAt(time, longitude, latitude, getPosition))
	}

	return { jds, altitudes, step }
}

// Whether the Moon is at or above the horizon at any sample within [fromJd, toJd].
function anyAboveDuring(scan: AltitudeScan, fromJd: number, toJd: number, horizonAltitude: Angle) {
	const { jds, altitudes } = scan

	for (let i = 0; i < jds.length; i++) {
		if (jds[i] < fromJd || jds[i] > toJd) continue
		if (altitudes[i] >= horizonAltitude) return true
	}

	return false
}

// Builds a Time at a Julian Day, preserving the reference time scale and providers.
function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction)
}

// Computes the full local circumstances of a lunar eclipse for one geographic point.
//   eclipse: lunar eclipse with its TT contact times, magnitude, u and gamma.
//   longitude: observer geographic longitude (radians, east-positive).
//   latitude: observer geodetic latitude (radians).
//   getSunMoonPosition: apparent Sun/Moon position provider at a dynamical time.
//   options: horizon altitude and altitude-sampling options.
export function computeLocalLunarEclipseCircumstances(eclipse: LunarEclipse, longitude: Angle, latitude: Angle, getSunMoonPosition: LunarEclipsePositionProvider, options: LocalLunarEclipseCircumstancesOptions = {}): LocalLunarEclipseCircumstances {
	const horizonAltitude = options.horizonAltitude ?? 0
	const samples = options.altitudeSamples ?? 48

	const contacts = lunarEclipseEvents(eclipse)
	const events: Writable<Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>> = {}

	for (const contact of contacts) {
		events[contact.kind] = computeLocalEvent(contact, eclipse, longitude, latitude, getSunMoonPosition, horizonAltitude)
	}

	const p1 = events.P1
	const p4 = events.P4
	const reference = eclipse.maximalTime

	// Continuous altitude scan across the penumbral interval, reused for every phase visibility test.
	const scan = p1 && p4 ? scanAltitudes(p1.jd, p4.jd, longitude, latitude, getSunMoonPosition, samples, reference) : { jds: [], altitudes: [], step: 0 }

	const hasGeometricEclipse = contacts.length > 0
	const penumbralVisible = p1 && p4 ? anyAboveDuring(scan, p1.jd, p4.jd, horizonAltitude) : false
	const hasObservableEclipse = penumbralVisible

	const umbralVisible = events.U1 && events.U4 ? anyAboveDuring(scan, events.U1.jd, events.U4.jd, horizonAltitude) : false
	const totalVisible = events.U2 && events.U3 ? anyAboveDuring(scan, events.U2.jd, events.U3.jd, horizonAltitude) : false
	const allContactsObservable = contacts.length > 0 && contacts.every((c) => events[c.kind]!.observable)

	let kind: LocalLunarEclipseVisibilityKind
	if (!hasGeometricEclipse) kind = 'notVisible'
	else if (!penumbralVisible) kind = 'geometricOnlyBelowHorizon'
	else if (allContactsObservable) kind = 'completelyVisible'
	else if (totalVisible) kind = 'totalVisible'
	else if (umbralVisible) kind = 'partialVisible'
	else kind = 'penumbralOnlyVisible'

	// Observable duration: count samples above the horizon, scaled by the sample spacing.
	let aboveCount = 0
	for (const altitude of scan.altitudes) if (altitude >= horizonAltitude) aboveCount++
	const observableDuration = aboveCount * scan.step * DAYSEC

	const [, maximalPenumbralMagnitude] = shadowMagnitudes(Math.abs(eclipse.gamma), eclipse.u)

	const details: LocalLunarEclipseDetails = {
		maximalUmbralMagnitude: eclipse.type === 'PENUMBRAL' ? null : eclipse.magnitude,
		maximalPenumbralMagnitude,
		penumbralPhaseDuration: p1 && p4 ? (p4.jd - p1.jd) * DAYSEC : 0,
		partialPhaseDuration: events.U1 && events.U4 ? (events.U4.jd - events.U1.jd) * DAYSEC : null,
		totalPhaseDuration: events.U2 && events.U3 ? (events.U3.jd - events.U2.jd) * DAYSEC : null,
		observableDuration,
	}

	return {
		location: { longitude, latitude },
		visibility: { kind, text: localLunarVisibilityText(kind), hasGeometricEclipse, hasObservableEclipse },
		details,
		events,
	}
}

// Local View geometry

// Orientation of the Local View diagram: 'zenith' puts the local zenith up; 'north' puts celestial north up.
export type LocalLunarViewOrientationMode = 'zenith' | 'north'

// Horizontal handedness: 'eastRight' (default, map-like) puts celestial east to the right; 'eastLeft' mirrors
// it for the naked-eye / sky-chart convention.
export type LocalLunarViewHandedness = 'eastRight' | 'eastLeft'

// Options controlling the Local View geometry.
export interface LocalLunarEclipseViewOptions {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number
	// Contact drawn as the primary (highlighted) state and as the frame reference for the zenith rotation.
	readonly selectedEvent: LunarEclipseContactKind
	// Diagram orientation. Only geometry changes; no UI is implied.
	readonly orientationMode: LocalLunarViewOrientationMode
	// Horizontal handedness. Defaults to 'eastRight'.
	readonly handedness?: LocalLunarViewHandedness
	// Umbra circle radius in SVG pixels; the global scale anchor for the diagram.
	readonly umbraRadiusPx: number
	// Whether to draw ghost Moon disks for the non-selected contacts.
	readonly includeGhostDisks: boolean
	// Whether to draw the apparent-horizon line and below-horizon band for the selected contact.
	readonly includeHorizon: boolean
	// Optional padding (px) for the horizon band polygon.
	readonly horizonBandPaddingPx?: number
}

// A circle shape: shadow rings or a Moon disk.
export interface LocalLunarEclipseSvgCircle {
	readonly kind: 'circle'
	// Semantic role.
	readonly role: 'penumbra' | 'umbra' | 'moonDisk' | 'ghostMoonDisk'
	// Contact this disk was drawn for (for the Moon disks), so the UI can label it.
	readonly event?: LunarEclipseContactKind
	// Center x in SVG pixels.
	readonly cx: number
	// Center y in SVG pixels.
	readonly cy: number
	// Radius in SVG pixels.
	readonly r: number
}

// A straight line: the horizon or a trajectory segment.
export interface LocalLunarEclipseSvgLine {
	readonly kind: 'line'
	readonly role: 'horizonLine'
	readonly x1: number
	readonly y1: number
	readonly x2: number
	readonly y2: number
}

// A path: the Moon-center trajectory through the contacts.
export interface LocalLunarEclipseSvgPath {
	readonly kind: 'path'
	readonly role: 'trajectoryPath'
	// SVG path data string.
	readonly d: string
}

// A filled polygon: the below-horizon band.
export interface LocalLunarEclipseSvgPolygon {
	readonly kind: 'polygon'
	readonly role: 'horizonBand'
	readonly points: readonly Point[]
}

export type LocalLunarEclipseSvgShape = LocalLunarEclipseSvgCircle | LocalLunarEclipseSvgLine | LocalLunarEclipseSvgPath | LocalLunarEclipseSvgPolygon

// Serializable Local View geometry: plain shapes only, no text and no UI.
export interface LocalLunarEclipseViewGeometry {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number
	// Orientation frame the geometry was built in.
	readonly orientationMode: LocalLunarViewOrientationMode
	// The contact the caller requested as the primary state.
	readonly requestedEvent: LunarEclipseContactKind
	// The contact actually drawn as primary: the requested one when available, else MAX, else the first
	// available contact, or null when no contact exists.
	readonly selectedEvent: LunarEclipseContactKind | null
	// Umbra circle radius in SVG pixels.
	readonly umbraRadiusPx: number
	// All drawable shapes, in painter order.
	readonly shapes: readonly LocalLunarEclipseSvgShape[]
}

// Default Local View options.
const DEFAULT_LOCAL_LUNAR_VIEW_OPTIONS: LocalLunarEclipseViewOptions = {
	width: 300,
	height: 300,
	selectedEvent: 'MAX',
	orientationMode: 'zenith',
	handedness: 'eastRight',
	umbraRadiusPx: 70,
	includeGhostDisks: true,
	includeHorizon: true,
	horizonBandPaddingPx: 4,
}

// Chronological contact order used to lay out the trajectory and pick a fallback primary contact.
const CONTACT_ORDER: readonly LunarEclipseContactKind[] = ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4']

// Picks the primary contact: the requested one, else MAX, else the first available.
function selectPrimaryEvent(events: Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>, requested: LunarEclipseContactKind) {
	const requestedEvent = events[requested]
	if (requestedEvent) return requestedEvent
	if (events.MAX) return events.MAX

	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (event) return event
	}

	return null
}

// SVG screen offset (px) of a Moon disk from the shadow center. The Moon sits opposite the shadow-center
// direction (position angle P + PI) at distance ell. In the zenith frame the celestial-north angle is rotated
// by the frame parallactic angle q so the zenith is up; in the north frame q is 0.
//   event: the contact to place.
//   ell: shadow-axis distance (plane Earth radii).
//   scale: pixels per plane Earth radius.
//   frameParallactic: parallactic angle (radians) of the frame's selected event, applied in zenith mode.
//   orientationMode: diagram orientation.
//   eastSign: +1 for eastRight, -1 for eastLeft.
function moonDiskOffset(event: LocalLunarEclipseEvent, ell: number, scale: number, frameParallactic: Angle, orientationMode: LocalLunarViewOrientationMode, eastSign: number): Point {
	const q = orientationMode === 'zenith' ? frameParallactic : 0
	const angle = event.positionAngle + PI - q
	return { x: eastSign * scale * ell * Math.sin(angle), y: -scale * ell * Math.cos(angle) }
}

// Builds the apparent-horizon line and below-horizon band for the selected contact. The horizon sits at the
// Moon altitude away from the zenith; its distance from the shadow center is scaled by the mean angular size of
// one Earth radius at the Moon, which is a schematic approximation (the shadow is tiny next to the altitude).
function buildHorizonShapes(primary: LocalLunarEclipseEvent, options: LocalLunarEclipseViewOptions, cx: number, cy: number, scale: number, eastSign: number): LocalLunarEclipseSvgShape[] {
	// Zenith direction in SVG pixels (y grows downward). In the north frame the zenith is rotated from "up" by
	// the frame parallactic angle; here the zenith frame keeps it straight up, so the rotation is folded into
	// the disk angles instead and the horizon is drawn straight.
	const q = options.orientationMode === 'north' ? primary.positionAngle - primary.zenithAngle : 0
	const zenithX = eastSign * Math.sin(q)
	const zenithY = -Math.cos(q)

	// Altitude offset (px) from the shadow center along the zenith direction.
	const offsetPx = clamp((primary.altitude / MEAN_EARTH_RADIUS_ANGULAR_AT_MOON) * scale, -Math.hypot(options.width, options.height) * 2, Math.hypot(options.width, options.height) * 2)
	const horizonX = cx - offsetPx * zenithX
	const horizonY = cy - offsetPx * zenithY

	const tangentX = -zenithY
	const tangentY = zenithX
	const half = Math.hypot(options.width, options.height)
	const line: LocalLunarEclipseSvgLine = {
		kind: 'line',
		role: 'horizonLine',
		x1: horizonX - tangentX * half,
		y1: horizonY - tangentY * half,
		x2: horizonX + tangentX * half,
		y2: horizonY + tangentY * half,
	}

	const padding = options.horizonBandPaddingPx ?? 0
	const awayX = -zenithX
	const awayY = -zenithY
	const near = -padding
	const far = padding + 4 * half
	const band: LocalLunarEclipseSvgPolygon = {
		kind: 'polygon',
		role: 'horizonBand',
		points: [
			{ x: horizonX - tangentX * half + awayX * near, y: horizonY - tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * near, y: horizonY + tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * far, y: horizonY + tangentY * half + awayY * far },
			{ x: horizonX - tangentX * half + awayX * far, y: horizonY - tangentY * half + awayY * far },
		],
	}

	return [band, line]
}

// Builds the serializable Local View geometry from the resolved circumstances. Emits only geometric shapes: no
// labels, text or UI. The shadow center is fixed at the diagram center; the Moon disks are placed by their P
// angle and shadow-axis distance, so the eclipse is read off the disk positions relative to the umbra and
// penumbra rings.
//   circumstances: resolved events (from computeLocalLunarEclipseCircumstances) and the eclipse geometry.
//   eclipse: the lunar eclipse (umbra radius sigma, penumbra radius rho).
//   options: Local View options.
export function computeLocalLunarEclipseViewGeometry(circumstances: Pick<LocalLunarEclipseCircumstances, 'events'>, eclipse: LunarEclipse, options: Partial<LocalLunarEclipseViewOptions> = {}): LocalLunarEclipseViewGeometry {
	const resolved: LocalLunarEclipseViewOptions = { ...DEFAULT_LOCAL_LUNAR_VIEW_OPTIONS, ...options }
	const events = circumstances.events
	const cx = resolved.width * 0.5
	const cy = resolved.height * 0.5
	const eastSign = resolved.handedness === 'eastLeft' ? -1 : 1

	// Pixels per plane Earth radius, anchored on the umbra radius. Guard a degraded sigma so the rings never
	// collapse or invert.
	const umbraRadius = eclipse.sigma > 0 && Number.isFinite(eclipse.sigma) ? eclipse.sigma : LUNAR_ECLIPSE_TOTAL_LIMIT
	const scale = resolved.umbraRadiusPx / umbraRadius
	const penumbraRadiusPx = scale * eclipse.rho
	const moonRadiusPx = scale * MOON_RADIUS_EARTH_RADII

	const primary = selectPrimaryEvent(events, resolved.selectedEvent)
	const frameParallactic = primary ? primary.positionAngle - primary.zenithAngle : 0

	const shapes: LocalLunarEclipseSvgShape[] = []

	// Below-horizon band first (painted behind), then shadow rings, ghosts, trajectory, primary disk, then the
	// horizon line on top.
	if (resolved.includeHorizon && primary) {
		shapes.push(buildHorizonShapes(primary, resolved, cx, cy, scale, eastSign)[0])
	}

	shapes.push({ kind: 'circle', role: 'penumbra', cx, cy, r: penumbraRadiusPx })
	shapes.push({ kind: 'circle', role: 'umbra', cx, cy, r: resolved.umbraRadiusPx })

	// Trajectory through the available contacts, in chronological order.
	const trajectory: Point[] = []
	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (!event) continue
		const ell = contactShadowDistance(kind, eclipse.u, eclipse.gamma)
		const offset = moonDiskOffset(event, ell, scale, frameParallactic, resolved.orientationMode, eastSign)
		trajectory.push({ x: cx + offset.x, y: cy + offset.y })
	}
	if (trajectory.length >= 2) {
		const tokens: string[] = [`M${formatCoordinate(trajectory[0].x)} ${formatCoordinate(trajectory[0].y)}`]
		for (let i = 1; i < trajectory.length; i++) tokens.push(`L${formatCoordinate(trajectory[i].x)} ${formatCoordinate(trajectory[i].y)}`)
		shapes.push({ kind: 'path', role: 'trajectoryPath', d: tokens.join('') })
	}

	// Ghost Moon disks for the non-selected contacts, drawn before the primary so it sits on top.
	if (resolved.includeGhostDisks) {
		for (const kind of CONTACT_ORDER) {
			const event = events[kind]
			if (!event || event === primary) continue
			const ell = contactShadowDistance(kind, eclipse.u, eclipse.gamma)
			const offset = moonDiskOffset(event, ell, scale, frameParallactic, resolved.orientationMode, eastSign)
			shapes.push({ kind: 'circle', role: 'ghostMoonDisk', event: kind, cx: cx + offset.x, cy: cy + offset.y, r: moonRadiusPx })
		}
	}

	if (primary) {
		const ell = contactShadowDistance(primary.kind, eclipse.u, eclipse.gamma)
		const offset = moonDiskOffset(primary, ell, scale, frameParallactic, resolved.orientationMode, eastSign)
		shapes.push({ kind: 'circle', role: 'moonDisk', event: primary.kind, cx: cx + offset.x, cy: cy + offset.y, r: moonRadiusPx })
	}

	// Horizon line on top of the disks, so the ground occludes the part of the diagram below it.
	if (resolved.includeHorizon && primary) {
		shapes.push(buildHorizonShapes(primary, resolved, cx, cy, scale, eastSign)[1])
	}

	return {
		width: resolved.width,
		height: resolved.height,
		orientationMode: resolved.orientationMode,
		requestedEvent: resolved.selectedEvent,
		selectedEvent: primary ? primary.kind : null,
		umbraRadiusPx: resolved.umbraRadiusPx,
		shapes,
	}
}

// Formats an SVG coordinate with two decimals, dropping trailing zeros.
function formatCoordinate(value: number) {
	return Number(value.toFixed(2)).toString()
}
