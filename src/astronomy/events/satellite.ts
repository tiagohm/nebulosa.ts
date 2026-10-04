import { AU_KM, DAYSEC, EARTH_RADIUS_AU, ONE_SECOND, SUN_RADIUS_AU } from '../../core/constants'
import type { Writable } from '../../core/types'
import { validatePositiveFinite } from '../../core/validation'
import { type Vec3, vecCross, vecDot, vecLength, vecMinus, vecZero } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { brentMinimize } from '../../math/numerical/optimization'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { zeroPositionAndVelocity, type PositionOverTime } from '../coordinates/astrometry'
import { observerState } from '../coordinates/correction'
import { frameToFrame, ICRS, ITRS, TEME, temeToItrf } from '../coordinates/frame'
import { itrs } from '../coordinates/itrs'
import { Ellipsoid, geocentricLocation, type GeographicCoordinate, type GeographicPosition } from '../observer/location'
import { sgp4, type SatRec } from '../orbits/propagation/sgp4'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { searchExtrema, searchIntervals, searchRoots, type TimeSearchOptions } from './search'

// Ground-station and shadow events for an SGP4 satellite, layered on the SGP4 propagator, the observer
// transforms and the time-domain event scanner. Two families of events are provided: topocentric passes
// over a ground observer (rise, culmination and set, bracketed where the geometric altitude crosses a
// configurable horizon) and Earth-shadow events (the sunlit/penumbra/umbra illumination state and the
// umbra or penumbra entry/exit crossings that bound each eclipse). All angles are radians, distances AU
// and durations seconds.
// Tracking rates use an observer-relative inertial state (AU/day and radians/day), and visible
// intervals combine altitude, umbra, empirical magnitude and observer solar altitude throughout
// each interval. The footprint is explicitly a spherical ideal-horizon approximation.
//
// Look angles are computed entirely in the Earth-fixed ITRS frame: the satellite is propagated in TEME,
// rotated to ITRS, and differenced against the observer's ITRS position; the topocentric vector is then
// resolved onto the local South-East-Zenith axes of the geodetic vertical. The altitude is geometric
// (no refraction). Shadow geometry is computed in the geocentric ICRS frame, where the satellite and the
// Sun share the Earth-centred origin, using the apparent angular radii of the Sun and the Earth as seen
// from the satellite (the conical umbra/penumbra model of Montenbruck & Gill).

// Default coarse sampling step for the satellite scanners: 30 s. Fine enough to bracket every low-Earth
// pass and every shadow crossing without missing a short grazing pass between two samples.
const DEFAULT_STEP = 30 * ONE_SECOND

// Geocentric Earth rest state, used to obtain the observer's inertial position/diurnal velocity.
const ZERO_EARTH_STATE = zeroPositionAndVelocity()

// Topocentric look angles of a satellite as seen by a ground observer.
export interface SatelliteLookAngles {
	// Azimuth measured from North through East, radians in [0, TAU).
	readonly azimuth: Angle
	// Geometric elevation above the local horizon, radians in [-PI/2, PI/2]; no refraction applied.
	readonly altitude: Angle
	// Observer-to-satellite slant range in AU.
	readonly range: Distance
}

// One resolved instant of a satellite pass: the time and the look angles at that instant.
export interface SatellitePassEvent extends SatelliteLookAngles {
	// Instant of the event.
	readonly time: Time
}

// A single visible pass of a satellite over a ground observer.
export interface SatellitePass {
	// Rise: the instant the satellite climbs through the horizon altitude.
	readonly rise: SatellitePassEvent
	// Culmination: the instant of greatest altitude between rise and set.
	readonly culmination: SatellitePassEvent
	// Set: the instant the satellite drops back through the horizon altitude.
	readonly set: SatellitePassEvent
}

// Options for the pass finder.
export interface SatellitePassOptions extends TimeSearchOptions {
	// Minimum altitude (radians) that defines the horizon for rise/set. Defaults to 0 (the ideal
	// horizon); raise it to model a local obstruction or a minimum-elevation observing constraint.
	readonly minAltitude?: Angle
}

// Illumination state of a satellite relative to the Earth's shadow.
export type SatelliteShadowState = 'sunlit' | 'penumbra' | 'umbra'

// A single Earth-shadow eclipse interval for a satellite over the search window.
export interface SatelliteEclipse {
	// Instant the satellite enters the shadow boundary, or undefined when it is already inside the
	// shadow at the start of the window.
	readonly entry?: Time
	// Instant the satellite leaves the shadow boundary, or undefined when it is still inside the shadow
	// at the end of the window.
	readonly exit?: Time
	// Duration of the eclipse in seconds within the window (entry and exit clipped to the window edges
	// for intervals that are open at either end).
	readonly duration: number
}

// Options for the eclipse finder.
export interface SatelliteEclipseOptions extends TimeSearchOptions {
	// Shadow boundary the crossings are measured against: 'umbra' (total geometric eclipse, the default)
	// or 'penumbra' (any partial obscuration of the solar disk).
	readonly boundary?: 'umbra' | 'penumbra'
}

// Computes the topocentric look angles of a satellite for a ground observer at an instant.
//
// The satellite is propagated with SGP4 (TEME) and rotated to the Earth-fixed ITRS frame; the observer's
// ITRS position is subtracted to form the topocentric vector, which is resolved onto the observer's local
// South-East-Zenith axes about the geodetic vertical. The returned altitude is geometric (no refraction),
// the azimuth runs North-through-East, and the range is the observer-to-satellite slant distance in AU.
export function satelliteLookAngles(satrec: SatRec, location: GeographicPosition, time: Time): SatelliteLookAngles {
	const teme = sgp4(time, satrec)[0]
	return lookAngles(temeToItrf(teme, time), location)
}

// Resolves an Earth-fixed geocentric satellite position (AU) onto a ground site's geodetic horizon.
// Allocates the three look-angle quantities without computing velocities.
function lookAngles(s: Vec3, location: GeographicPosition): SatelliteLookAngles {
	const o = itrs(location)

	// Topocentric vector in Earth-fixed axes.
	const [dx, dy, dz] = vecMinus(s, o)

	const sinLat = Math.sin(location.latitude)
	const cosLat = Math.cos(location.latitude)
	const sinLon = Math.sin(location.longitude)
	const cosLon = Math.cos(location.longitude)

	// South-East-Zenith projection of the topocentric vector at the geodetic vertical.
	const south = sinLat * cosLon * dx + sinLat * sinLon * dy - cosLat * dz
	const east = -sinLon * dx + cosLon * dy
	const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz

	const range = Math.hypot(dx, dy, dz)
	const altitude = Math.asin(clamp(up / range, -1, 1))
	// Azimuth is measured from North (= -South) through East.
	const azimuth = normalizeAngle(Math.atan2(east, -south))

	return { azimuth, altitude, range }
}

// Builds a resolved pass event from the look angles at a given instant.
function passEvent(satrec: SatRec, location: GeographicPosition, time: Time): SatellitePassEvent {
	const event = satelliteLookAngles(satrec, location, time) as Writable<SatellitePassEvent>
	event.time = time
	return event
}

// Finds every visible pass of a satellite over a ground observer in a time window.
//
// The topocentric altitude is sampled at the coarse step and its crossings of `minAltitude` are located
// with the shared time-domain root finder; each rising crossing is paired with the following setting
// crossing to delimit a pass. Only complete passes (a rise and a set both inside the window) are
// returned; a pass already in progress at the start of the window, or still in progress at its end, is
// skipped. The culmination is the altitude maximum between rise and set, refined with Brent's minimizer
// on the negated altitude (the altitude is unimodal across a single pass). Passes are chronological.
export function satellitePasses(satrec: SatRec, location: GeographicPosition, start: Time, stop: Time, { minAltitude = 0, step = DEFAULT_STEP, tolerance }: SatellitePassOptions = {}): SatellitePass[] {
	const altitudeAt = (time: Time) => satelliteLookAngles(satrec, location, time).altitude
	const crossings = searchRoots((time) => altitudeAt(time) - minAltitude, start, stop, { step, tolerance })

	const passes: SatellitePass[] = []
	let rise: Time | undefined

	const negated = (x: number) => -altitudeAt(timeShift(rise!, x))
	const minimizationOptions = { tolerance }

	for (const crossing of crossings) {
		// A rising crossing has an increasing altitude one second later; a setting crossing a decreasing one.
		const rising = altitudeAt(timeShift(crossing, ONE_SECOND)) > altitudeAt(crossing)

		if (rising) {
			rise = crossing
		} else if (rise !== undefined) {
			// Close the open pass at this setting crossing and locate the culmination between them.
			const span = timeSubtract(crossing, rise)
			const peak = brentMinimize(negated, 0, span, minimizationOptions)
			const culmination = passEvent(satrec, location, timeShift(rise, peak.minimum))
			passes.push({ rise: passEvent(satrec, location, rise), culmination, set: passEvent(satrec, location, crossing) })
			rise = undefined
		}
	}

	return passes
}

// Geocentric ICRS position of a satellite (AU), rotated out of the SGP4 TEME frame so it shares the
// Earth-centred origin and inertial axes of the geocentric Sun vector used by the shadow geometry.
function satelliteGeocentric(satrec: SatRec, time: Time): Vec3 {
	return frameToFrame(sgp4(time, satrec)[0], TEME, ICRS, time)
}

// Satellite-view angular geometry of the Sun and Earth's spherical reference limb.
interface ShadowGeometry {
	// Sun angular radius in radians.
	readonly sunApparentRadius: Angle
	// Earth angular radius in radians.
	readonly earthApparentRadius: Angle
	// Sun-Earth-center separation as seen from the satellite, radians in [0, PI].
	readonly separation: Angle
}

// Apparent angular radii and separation used by the conical shadow model, evaluated from a satellite and
// Sun geocentric position pair (AU).
//
// `sunApparentRadius` is the Sun's angular radius seen from the satellite, `earthApparentRadius` the
// Earth's, and `separation` the angle at the satellite between the Earth-centre direction and the Sun
// direction. The umbra margin is `separation - (earthApparentRadius - sunApparentRadius)` (negative deep
// inside the total-shadow cone) and the penumbra margin is `separation - (earthApparentRadius +
// sunApparentRadius)` (negative once the solar disk is partly obscured).
function shadowGeometry(satellite: Vec3, sun: Vec3): ShadowGeometry {
	const rMag = Math.sqrt(satellite[0] * satellite[0] + satellite[1] * satellite[1] + satellite[2] * satellite[2])

	// Vector from the satellite to the Sun and from the satellite to the Earth centre.
	const wx = sun[0] - satellite[0]
	const wy = sun[1] - satellite[1]
	const wz = sun[2] - satellite[2]
	const wMag = Math.sqrt(wx * wx + wy * wy + wz * wz)
	const ux = -satellite[0]
	const uy = -satellite[1]
	const uz = -satellite[2]

	const sunApparentRadius = Math.asin(clamp(SUN_RADIUS_AU / wMag, -1, 1))
	const earthApparentRadius = Math.asin(clamp(EARTH_RADIUS_AU / rMag, -1, 1))

	// Angle between the Earth-centre and Sun directions at the satellite, from a stable atan2 of the
	// cross-product magnitude over the dot product.
	const cx = uy * wz - uz * wy
	const cy = uz * wx - ux * wz
	const cz = ux * wy - uy * wx
	const cross = Math.sqrt(cx * cx + cy * cy + cz * cz)
	const dot = ux * wx + uy * wy + uz * wz
	const separation = Math.atan2(cross, dot)

	return { sunApparentRadius, earthApparentRadius, separation } as const
}

// Classifies the illumination state from a satellite and Sun geocentric position pair (AU, ICRS).
//
// The satellite is 'umbra' when the solar disk is fully occulted by the Earth, 'penumbra' when it is
// partly occulted, and 'sunlit' otherwise. For Earth-orbiting satellites the Earth's apparent radius
// exceeds the Sun's, so an annular geometry never occurs; when it would (very distant orbits where the
// Earth appears smaller than the Sun) the state is reported as 'penumbra'.
function classifyShadow(satellite: Vec3, sun: Vec3): SatelliteShadowState {
	return classifyShadowGeometry(shadowGeometry(satellite, sun))
}

// Classifies precomputed angular-radius geometry, sharing the shadow calculation with photometry
// and interval margins. Returns umbra only when the Earth's disk fully covers the solar disk.
function classifyShadowGeometry({ sunApparentRadius, earthApparentRadius, separation }: ShadowGeometry): SatelliteShadowState {
	if (separation >= sunApparentRadius + earthApparentRadius) return 'sunlit'
	if (earthApparentRadius > sunApparentRadius && separation <= earthApparentRadius - sunApparentRadius) return 'umbra'
	return 'penumbra'
}

// Classifies the illumination state of a satellite relative to the Earth's shadow at an instant.
//
// `sunAt` returns the geocentric Sun position (AU, ICRS) at a time, e.g. `sun(t)[0] - earth(t)[0]` from
// the VSOP87E ephemeris. See classifyShadow for the umbra/penumbra/sunlit definition.
export function satelliteShadowState(satrec: SatRec, sunAt: PositionOverTime, time: Time): SatelliteShadowState {
	return classifyShadow(satelliteGeocentric(satrec, time), sunAt(time))
}

// True when the satellite's solar disk is unobscured by the Earth at an instant. See satelliteShadowState.
export function isSatelliteSunlit(satrec: SatRec, sunAt: PositionOverTime, time: Time): boolean {
	return satelliteShadowState(satrec, sunAt, time) === 'sunlit'
}

// Finds every Earth-shadow eclipse interval of a satellite in a time window.
//
// The signed margin to the selected shadow boundary (umbra by default, or penumbra) is sampled at the
// coarse step and its zero crossings are located with the shared time-domain root finder. A crossing
// where the margin falls through zero is an entry into shadow; one where it rises is an exit. Entries and
// exits are paired into eclipse intervals, with the reported duration in seconds. If the satellite is
// already in shadow at the start of the window the first interval has no `entry` (its duration is clipped
// to the window start); if it is still in shadow at the end the last interval has no `exit` (clipped to
// the window end). `sunAt` returns the geocentric Sun position (AU, ICRS) at a time.
export function satelliteEclipses(satrec: SatRec, sunAt: PositionOverTime, start: Time, stop: Time, { boundary = 'umbra', step = DEFAULT_STEP, tolerance }: SatelliteEclipseOptions = {}): SatelliteEclipse[] {
	const marginAt = (time: Time) => {
		const { sunApparentRadius, earthApparentRadius, separation } = shadowGeometry(satelliteGeocentric(satrec, time), sunAt(time))
		return boundary === 'umbra' ? separation - (earthApparentRadius - sunApparentRadius) : separation - (earthApparentRadius + sunApparentRadius)
	}

	const crossings = searchRoots(marginAt, start, stop, { step, tolerance })
	const eclipses: SatelliteEclipse[] = []

	// Track the currently open eclipse. `open` is set when the window starts inside the shadow (a
	// negative margin) so the leading exit closes it; `entry` stays undefined for an interval that began
	// before the window, and its duration is then clipped to the window start.
	let open = marginAt(start) < 0
	let entry: Time | undefined

	for (const crossing of crossings) {
		// Falling margin (negative just after) marks an entry into shadow; rising margin marks an exit.
		const entering = marginAt(timeShift(crossing, ONE_SECOND)) < marginAt(crossing)

		if (entering) {
			entry = crossing
			open = true
		} else if (open) {
			eclipses.push({ entry, exit: crossing, duration: timeSubtract(crossing, entry ?? start) * DAYSEC })
			open = false
			entry = undefined
		}
	}

	// A shadow interval still open at the end of the window is clipped to the window stop.
	if (open) {
		eclipses.push({ entry, exit: undefined, duration: timeSubtract(stop, entry ?? start) * DAYSEC })
	}

	return eclipses
}

// Apparent visual magnitude of a satellite and the geometry it was computed from.
export interface SatelliteMagnitude {
	// Apparent visual magnitude (smaller is brighter). Only physically meaningful while `illuminated`.
	readonly magnitude: number
	// Solar phase angle at the satellite: the Sun-satellite-observer angle, radians in [0, PI]. Zero is
	// full phase (Sun behind the observer), PI is a thin crescent (satellite between observer and Sun).
	readonly phaseAngle: Angle
	// Observer-to-satellite slant range in AU.
	readonly range: Distance
	// False when the satellite is inside the Earth's umbra, where it reflects no sunlight and the
	// magnitude is not meaningful.
	readonly illuminated: boolean
}

// Reference-magnitude offset for the standard-magnitude photometric model. A "standard magnitude" is
// defined at a range of 1000 km and half illumination (phase angle 90 deg); the constant -15.75 makes
// the apparent magnitude reduce to the standard magnitude at that reference (2.5*log10(1000^2/0.5) =
// 15.75). See Molczan/McCants standard magnitudes.
const STANDARD_MAGNITUDE_OFFSET = -15.75

// Estimates the apparent visual magnitude of a satellite for a ground observer at an instant.
//
// Uses the Molczan/McCants standard-magnitude model: apparent magnitude = standardMagnitude - 15.75 +
// 2.5*log10(range_km^2 / fractionIlluminated), where fractionIlluminated = (1 + cos(phaseAngle)) / 2 is
// the illuminated fraction of a diffuse sphere and the phase angle is the Sun-satellite-observer angle.
// `standardMagnitude` is the satellite's intrinsic brightness at 1000 km range and 90 deg phase (e.g.
// about -1.8 for the ISS); it is an empirical per-object constant. `sunAt` returns the geocentric Sun
// position (AU, ICRS) at a time. The reported magnitude is only meaningful while `illuminated` is true;
// inside the Earth's umbra the satellite is dark. Refraction, atmospheric extinction near the horizon
// and specular flares are not modelled.
export function satelliteMagnitude(satrec: SatRec, location: GeographicPosition, sunAt: PositionOverTime, time: Time, standardMagnitude: number): SatelliteMagnitude {
	const satellite = satelliteGeocentric(satrec, time)
	const sun = sunAt(time)
	// Observer geocentric position rotated from the Earth-fixed ITRS into the same ICRS frame as the
	// satellite and the Sun, so the phase angle and range are formed from a consistent triple.
	const observer = frameToFrame(itrs(location), ITRS, ICRS, time)
	return magnitudeGeometry(satellite, sun, observer, standardMagnitude)
}

// Resolves standard-magnitude photometry from same-epoch geocentric base-frame positions in AU.
// Standard magnitude is empirical at 1000 km and half illumination; inputs are not mutated.
// shadow optionally supplies an already computed state; otherwise conical geometry is evaluated.
function magnitudeGeometry(satellite: Vec3, sun: Vec3, observer: Vec3, standardMagnitude: number, shadow: SatelliteShadowState = classifyShadow(satellite, sun)): SatelliteMagnitude {
	// Directions from the satellite to the observer and to the Sun.
	const ox = observer[0] - satellite[0]
	const oy = observer[1] - satellite[1]
	const oz = observer[2] - satellite[2]
	const sx = sun[0] - satellite[0]
	const sy = sun[1] - satellite[1]
	const sz = sun[2] - satellite[2]

	const range = Math.sqrt(ox * ox + oy * oy + oz * oz)

	// Phase angle from a stable atan2 of the cross-product magnitude over the dot product.
	const cx = oy * sz - oz * sy
	const cy = oz * sx - ox * sz
	const cz = ox * sy - oy * sx
	const cross = Math.sqrt(cx * cx + cy * cy + cz * cz)
	const dot = ox * sx + oy * sy + oz * sz
	const phaseAngle = Math.atan2(cross, dot)

	// Illuminated fraction of a diffuse sphere at this phase.
	const fractionIlluminated = 0.5 * (1 + Math.cos(phaseAngle))
	const rangeKm = range * AU_KM
	const magnitude = standardMagnitude + STANDARD_MAGNITUDE_OFFSET + 2.5 * Math.log10((rangeKm * rangeKm) / fractionIlluminated)

	const illuminated = shadow !== 'umbra'

	return { magnitude, phaseAngle, range, illuminated }
}

// Topocentric geometry plus analytic inertial tracking rates.
export interface SatelliteTrackingState extends SatelliteLookAngles {
	// Slant range derivative in AU/day; positive when receding.
	readonly rangeRate: number
	// Speed of the line of sight in inertial axes, radians/day, non-negative.
	// This is not an azimuth/altitude derivative in the rotating horizon frame.
	readonly angularRate: number
}

// Computes geometric azimuth/altitude/range and analytic rates for satrec, location and time.
// SGP4 TEME position/velocity is rotated to base axes and the observer's geocentric position and
// diurnal velocity subtracted, consistently with sgp4EphemerisPath/earthObserverEphemerisPath.
// rangeRate = r.v/|r| and angularRate = |r cross v|/|r|^2, AU/day and radians/day.
// No refraction/light time is applied; SGP4 should be used only near the supplied TLE epoch.
export function satelliteTrackingState(satrec: SatRec, location: GeographicPosition, time: Time): SatelliteTrackingState {
	const state = frameToFrame(sgp4(time, satrec), TEME, ICRS, time)
	const observer = observerState(time, ZERO_EARTH_STATE, location)
	const position = vecMinus(state[0], observer[0])
	const velocity = vecMinus(state[1], observer[1])
	const range = vecLength(position)
	const angles = lookAngles(frameToFrame(state[0], ICRS, ITRS, time), location)
	return { ...angles, rangeRate: vecDot(position, velocity) / range, angularRate: vecLength(vecCross(position, velocity)) / (range * range) }
}

// Geographic location beneath the satellite, using SGP4 TEME -> ITRS and the chosen ellipsoid.
// Longitude is east-positive (-PI, PI], latitude geodetic radians, elevation AU above ellipsoid.
// The default matches existing geographic-position APIs (IERS2010); no vector normalization is used.
// Propagation is meaningful only near satrec's epoch. Returns a newly allocated position record.
export function satelliteSubpoint(satrec: SatRec, time: Time, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const [x, y, z] = temeToItrf(sgp4(time, satrec)[0], time)
	const point = geocentricLocation(x, y, z, ellipsoid)
	return { ...point, longitude: normalizePI(point.longitude) }
}

// Ideal coverage cap on a caller-selected spherical Earth, with no terrain/refraction/elevation mask.
export interface SatelliteGroundFootprint {
	// Spherical subpoint: east-positive longitude and geocentric latitude in radians, elevation AU.
	readonly subpoint: Readonly<GeographicCoordinate>
	// Height above the reference sphere in AU.
	readonly altitude: Distance
	// Radius of the reference sphere in AU.
	readonly referenceRadius: Distance
	// Geocentric half-angle to the geometric horizon in radians.
	readonly halfAngle: Angle
	// Arc length on the sphere from subpoint to horizon in AU.
	readonly surfaceRadius: Distance
}

// Computes an ideal spherical footprint for satrec at time above referenceRadius (AU, defaults to
// EARTH_RADIUS_AU). Throws unless referenceRadius is positive/finite and no greater than the
// satellite radius: an interior point has no external tangent horizon. Uses a stable atan2 horizon angle
// and reports spherical latitude, not ellipsoidal geodetic latitude. No terrain, atmosphere, or
// minimum elevation mask. Returns an allocated record; SGP4 is valid only near satrec's epoch.
export function satelliteGroundFootprint(satrec: SatRec, time: Time, referenceRadius: Distance = EARTH_RADIUS_AU): SatelliteGroundFootprint {
	// A nonphysical sphere would otherwise yield a plausible but impossible coverage cap.
	validatePositiveFinite(referenceRadius)
	const [x, y, z] = temeToItrf(sgp4(time, satrec)[0], time)
	const radius = Math.hypot(x, y, z)
	if (!(radius >= referenceRadius)) throw new RangeError('satellite radius must be at least the reference radius')
	const altitude = radius - referenceRadius
	const halfAngle = Math.atan2(Math.sqrt(Math.max(0, altitude * (radius + referenceRadius))), referenceRadius)
	return { subpoint: { longitude: normalizePI(Math.atan2(y, x)), latitude: Math.atan2(z, Math.hypot(x, y)), elevation: altitude }, altitude, referenceRadius, halfAngle, surfaceRadius: referenceRadius * halfAngle }
}

// Signed Sun elevation above the SGP4 orbital plane at time, radians in [-PI/2, PI/2].
// sunAt returns geocentric Sun base-frame position in AU. The TEME angular momentum r cross v
// is rotated to ICRS; positive beta means Sun lies on its +normal side. No ephemeris is selected.
// SGP4 propagation should remain near satrec's epoch. The input provider is not mutated.
export function satelliteBetaAngle(satrec: SatRec, sunAt: PositionOverTime, time: Time): Angle {
	const [position, velocity] = sgp4(time, satrec)
	const normal = frameToFrame(vecCross(position, velocity), TEME, ICRS, time)
	const solar = sunAt(time)
	return Math.asin(clamp(vecDot(normal, solar) / (vecLength(normal) * vecLength(solar)), -1, 1))
}

// Explicit observing criteria plus scanner settings; no subjective brightness/twilight defaults.
export interface SatelliteVisibilityOptions extends TimeSearchOptions {
	// Empirical standard magnitude at 1000 km and half illumination.
	readonly standardMagnitude: number
	// Minimum geometric satellite altitude above the observer horizon, radians.
	readonly minimumAltitude: Angle
	// Largest (faintest) permitted apparent visual magnitude.
	readonly maximumMagnitude: number
	// Largest permitted geometric observer-relative solar altitude, radians.
	readonly maximumSunAltitude: Angle
}

// Circumstances at an endpoint or altitude maximum of a visible interval.
export interface SatelliteVisibilityEvent extends SatellitePassEvent {
	// Empirical apparent visual magnitude at this epoch.
	readonly magnitude: number
	// Observer-relative geometric solar altitude, radians.
	readonly sunAltitude: Angle
	// Conical Earth-shadow state at this epoch; endpoints can sit on an umbra boundary.
	readonly shadow: SatelliteShadowState
}

// A contiguous interval satisfying all observing criteria, clipped to the supplied window.
export interface SatelliteVisibleInterval {
	// First accepted epoch and its circumstances, possibly clipped to window start.
	readonly start: SatelliteVisibilityEvent
	// Last accepted epoch and its circumstances, possibly clipped to window stop.
	readonly end: SatelliteVisibilityEvent
	// Greatest altitude inside this accepted interval, including its endpoints.
	readonly culmination: SatelliteVisibilityEvent
}

// Finds intervals throughout which satellite altitude >= minimumAltitude, magnitude <=
// maximumMagnitude, Sun altitude <= maximumSunAltitude, and the satellite is outside the umbra.
// sunAt supplies same-epoch geocentric Sun positions in AU/base axes. satrec/location and start/stop
// specify the satellite, observer and window, which should lie near the TLE epoch. Uses the shared
// independent-margin interval scanner; options.step (default 30 s) must resolve each crossing.
// No refraction, extinction, flares, terrain, or penumbral attenuation is modelled. Partial passes
// at window boundaries are retained. Returns only endpoints/altitude peaks, not dense tracks.
export function satelliteVisibleIntervals(satrec: SatRec, location: GeographicPosition, sunAt: PositionOverTime, start: Time, stop: Time, options: SatelliteVisibilityOptions): SatelliteVisibleInterval[] {
	const scanOptions = { step: options.step ?? DEFAULT_STEP, tolerance: options.tolerance }
	const satellite = vecZero()
	const observer = vecZero()
	const fixed = vecZero()
	let cached: { event: SatelliteVisibilityEvent; umbraMargin: number } | undefined
	const circumstancesAt = (time: Time) => {
		if (cached && timeSubtract(time, cached.event.time) === 0) return cached
		frameToFrame(sgp4(time, satrec)[0], TEME, ICRS, time, satellite)
		const solar = sunAt(time)
		frameToFrame(itrs(location), ITRS, ICRS, time, observer)
		const shadow = shadowGeometry(satellite, solar)
		const state = classifyShadowGeometry(shadow)
		const magnitude = magnitudeGeometry(satellite, solar, observer, options.standardMagnitude, state)
		const angles = lookAngles(frameToFrame(satellite, ICRS, ITRS, time, fixed), location)
		const sunAltitude = lookAngles(frameToFrame(solar, ICRS, ITRS, time, fixed), location).altitude
		const umbraMargin = shadow.earthApparentRadius > shadow.sunApparentRadius ? shadow.separation - (shadow.earthApparentRadius - shadow.sunApparentRadius) : 1
		cached = { event: { time, ...angles, magnitude: magnitude.magnitude, sunAltitude, shadow: state }, umbraMargin }
		return cached
	}
	const intervals = searchIntervals(
		[
			(time) => circumstancesAt(time).event.altitude - options.minimumAltitude,
			(time) => circumstancesAt(time).umbraMargin,
			// Zero illuminated fraction has infinite magnitude. A bounded monotone margin preserves
			// its brightness crossing while keeping Brent's endpoints finite at exact new phase.
			(time) => Math.tanh(options.maximumMagnitude - circumstancesAt(time).event.magnitude),
			(time) => options.maximumSunAltitude - circumstancesAt(time).event.sunAltitude,
		],
		start,
		stop,
		scanOptions,
	)
	return intervals.map((interval) => {
		const first = circumstancesAt(interval.start).event
		const last = circumstancesAt(interval.end).event
		let culmination = first.altitude > last.altitude ? first : last
		for (const peak of searchExtrema((time) => circumstancesAt(time).event.altitude, interval.start, interval.end, scanOptions)) {
			if (peak.kind === 'maximum' && peak.value > culmination.altitude) culmination = circumstancesAt(peak.time).event
		}
		return { start: first, end: last, culmination }
	})
}

// A close approach between two satellites: the time of closest approach and the geometry there.
export interface SatelliteConjunction {
	// Instant of closest approach (the local minimum of the inter-satellite range).
	readonly time: Time
	// Minimum separation between the two satellites at that instant, in AU.
	readonly distance: Distance
	// Relative speed of the two satellites at closest approach, in AU/day; at a true minimum the relative
	// velocity is perpendicular to the separation, so this is the rate the objects sweep past each other.
	readonly relativeSpeed: number
}

// Options for the conjunction screener.
export interface SatelliteConjunctionOptions extends TimeSearchOptions {
	// Only report approaches whose minimum separation is at or below this distance (AU). Defaults to
	// Number.POSITIVE_INFINITY, which returns every separation minimum in the window.
	readonly threshold?: Distance
}

// Squared inter-satellite distance is cheaper to sample than the distance and shares its extrema, so the
// coarse sieve minimizes it; the distance itself is taken only at the refined closest-approach instants.
function separationSquaredAt(a: SatRec, b: SatRec, time: Time): number {
	const pa = sgp4(time, a)[0]
	const pb = sgp4(time, b)[0]
	const dx = pa[0] - pb[0]
	const dy = pa[1] - pb[1]
	const dz = pa[2] - pb[2]
	return dx * dx + dy * dy + dz * dz
}

// Screens two satellites for close approaches over a time window.
//
// Both objects are propagated with SGP4 in the shared TEME frame, so their separation is the direct
// difference of the two position vectors and needs no frame conversion. The squared separation is sampled
// at the coarse step, its local minima are bracketed by the shared time-domain scanner and refined with
// Brent's minimizer (the sieve-and-refine screening the almanac calls for), and each refined minimum is
// reported as a conjunction with its true separation and the relative speed there. Only minima at or below
// `threshold` are returned; conjunctions are chronological.
//
// SGP4 is only valid near each TLE epoch, so `start`/`stop` should stay within a few days of both epochs.
// The coarse `step` must be finer than the approach it should catch: a deep, brief minimum between two
// coarse samples can be missed, so tighten `step` when screening for very close, high-relative-velocity
// passes.
export function satelliteConjunctions(a: SatRec, b: SatRec, start: Time, stop: Time, { threshold = Number.POSITIVE_INFINITY, step = DEFAULT_STEP, tolerance }: SatelliteConjunctionOptions = {}): SatelliteConjunction[] {
	const extrema = searchExtrema((time) => separationSquaredAt(a, b, time), start, stop, { step, tolerance })
	const conjunctions: SatelliteConjunction[] = []

	for (const extremum of extrema) {
		if (extremum.kind !== 'minimum') continue

		const distance = Math.sqrt(extremum.value)
		if (distance > threshold) continue

		// Relative speed from the SGP4 velocities at closest approach (AU/day).
		const va = sgp4(extremum.time, a)[1]
		const vb = sgp4(extremum.time, b)[1]
		const dvx = va[0] - vb[0]
		const dvy = va[1] - vb[1]
		const dvz = va[2] - vb[2]
		const relativeSpeed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz)

		conjunctions.push({ time: extremum.time, distance, relativeSpeed })
	}

	return conjunctions
}
