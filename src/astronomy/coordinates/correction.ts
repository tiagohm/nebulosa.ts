import { ANGVEL, AU_KM, AU_M, DAYSEC, EARTH_ANGULAR_VELOCITY_VECTOR, IERS2010_RADIUS, SCHWARZSCHILD_RADIUS_OF_THE_SUN, SPEED_OF_LIGHT, SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecClone, vecCross, vecDivScalar, vecDot, vecLength, vecMinus, vecNegate, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { Velocity } from '../../math/units/velocity'
import { Naif } from '../ephemeris/kernels/naif'
import { type EphemerisPath, naifEphemerisEndpoint, sameEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../ephemeris/path'
import type { GeographicPosition } from '../observer/location'
import { dut1, iersab, xy } from '../time/iers'
import { gcrsToItrsRotationMatrix, type Time, TIME_PROVIDERS, Timescale, tdb, timeNormalize, utc } from '../time/time'
import type { PositionAndVelocity, PositionAndVelocityMut } from './astrometry'
import { eraAb, eraS2c } from './erfa/erfa'
import { itrs } from './itrs'

// Observer-state and time/velocity corrections for precise timing and spectroscopy: the observer's
// barycentric/heliocentric position and velocity (adding the topocentric offset and diurnal rotation
// when a location is given), the radial-velocity correction projected onto a source direction, the
// first-order light-travel-time correction for barycentric/heliocentric date (BJD/HJD), and the
// two-part BJD_TDB service with Rømer and optional solar Shapiro delays, model flags, data-quality
// diagnostics, and an error budget. Positions are AU, velocities AU/day, in ICRS/BCRS axes; timing
// corrections are days for lightTravelTime and seconds for barycentricJulianDate.

// Computes the observer position (AU) and velocity (AU/day) in BCRS/ICRS axes,
// referred to the solar-system barycenter ('barycentric') or the Sun's center
// ('heliocentric').
//
// When `location` is provided the observer's topocentric offset and diurnal
// rotation are added; when omitted the geocenter is used (no diurnal term),
// matching the location-less behavior of Astropy.
//
//   pos = earthPos + R^T * r_itrs                 (topocentric offset in GCRS)
//   vel = earthVel + (R^T * omega_itrs) x (R^T * r_itrs)
//
// where R = `gcrsToItrsRotationMatrix` maps GCRS->ITRS, so R^T maps ITRS->GCRS,
// and omega_itrs ~ (0, 0, ANGVEL_PER_DAY) is the Earth rotation vector in ITRS.
// Returns freshly allocated vectors; the input `time` cache is not mutated.
export function observerState(time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): PositionAndVelocityMut {
	if (location === undefined) return [vecClone(earth[0]), vecClone(earth[1])]
	const r = gcrsToItrsRotationMatrix(time)
	// Observer offset and Earth rotation vector, rotated from ITRS into GCRS.
	const rGcrs = matTransposeMulVec(r, itrs(location))
	const w = vecClone(EARTH_ANGULAR_VELOCITY_VECTOR)
	const omegaGcrs = matTransposeMulVec(r, w, w)
	const diurnal = vecCross(omegaGcrs, rGcrs, omegaGcrs)
	return [vecPlus(earth[0], rGcrs, rGcrs), vecPlus(earth[1], diurnal, diurnal)]
}

// Applies stellar aberration to a natural source direction, returning the proper
// (aberrated) direction as a fresh unit vector. This is the ERFA `eraAb`
// special-relativistic model: the apparent shift of a source caused by the
// observer's motion, including annual aberration from the Earth's orbit and, when
// `observerVelocity` includes the diurnal term, diurnal aberration too.
//
// `direction` is a unit vector toward the source in ICRS/BCRS axes; passing the
// observer's full barycentric velocity in `observerVelocity` (AU/day) makes this
// the complete aberration correction. `sunDistance` is the observer-Sun distance
// in AU, used only for the tiny gravitational-light-bending companion term inside
// the model. The internal Lorentz factor bm1 = sqrt(1 - |v/c|^2) is derived from
// the velocity, so the caller supplies physical quantities only.
export function annualAberration(direction: Vec3, observerVelocity: Vec3, sunDistance: Distance): MutVec3 {
	const v = vecDivScalar(observerVelocity, SPEED_OF_LIGHT_AU_DAY)
	const bm1 = Math.sqrt(1 - vecDot(v, v))
	return eraAb(direction, v, sunDistance, bm1, v)
}

// Computes the barycentric/heliocentric radial-velocity correction (AU/day)
// toward an ICRS direction.
//
// The returned value is the velocity to ADD to a measured topocentric radial
// velocity so it is referred to the chosen reference center:
//   rvReferred = rvTopocentric + radialVelocityCorrection(...)
// A positive result means the observer is moving toward the source, so the
// topocentric measurement is blueshifted relative to the referred one.
//
// `ra`/`dec` are the ICRS source direction in radians; `location` is the
// observing site (omit for a geocentric correction without the diurnal term).
//
// This is the first-order (Newtonian) projection of the observer velocity onto
// the line of sight, rv = vObs . nHat, accurate to the cm/s level for the
// combined annual and diurnal terms. A fully relativistic variant would also
// require the source's own velocity and is intentionally not modeled here.
export function radialVelocityCorrection(ra: Angle, dec: Angle, time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): Velocity {
	const n = eraS2c(ra, dec)
	const [, vel] = observerState(time, earth, location)
	return vecDot(vel, n)
}

// Computes the light-travel-time correction (in days) to ADD to an observed time
// so it is referred to the solar-system barycenter ('barycentric') or the Sun's
// center ('heliocentric'):
//   timeReferred = timeShift(tdb(time), lightTravelTime(...))
//
//   ltt = (rObs . nHat) / c
//
// `rObs` is the observer's referred position (AU), `nHat` the ICRS unit vector
// toward the source, and c is in AU/day; the result is positive when the
// observer lies on the same side as the source, so light reaches it before the
// reference center.
//
// `ra`/`dec` are the ICRS source direction in radians; `location` is the
// observing site (omit for a geocentric correction). Accuracy is limited
// earth position and velocity, well within typical BJD/HJD requirements.
export function lightTravelTime(ra: Angle, dec: Angle, time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): number {
	const n = eraS2c(ra, dec)
	const [pos] = observerState(time, earth, location)
	return vecDot(pos, n) / SPEED_OF_LIGHT_AU_DAY
}

// Solar Shapiro-delay scale 2·GM☉/c³ in seconds (≈ 9.85 µs), from the solar Schwarzschild radius.
const SOLAR_SHAPIRO_SCALE = (SCHWARZSCHILD_RADIUS_OF_THE_SUN / SPEED_OF_LIGHT_AU_DAY) * DAYSEC

// Bound in seconds on the Rømer error of a ground site when UT1-UTC is unknown and taken as 0:
// |UT1-UTC| ≤ 0.9 s of Earth rotation moves the site by at most Ω·R_eq·0.9 s ≈ 419 m, i.e. ≈ 1.4 µs.
const MISSING_EOP_BOUND = (0.9 * ANGVEL * IERS2010_RADIUS * AU_M) / SPEED_OF_LIGHT

// Bound in seconds on the omitted topocentric TDB-TT term: the leading diurnal coefficient of the
// SOFA/ERFA dtdb series (3.17679e-10 s/km) times the equatorial radius in km, ≈ 2.0 µs.
const TOPOCENTRIC_TDB_BOUND = 3.17679e-10 * IERS2010_RADIUS * AU_KM

// Bound in AU on the Sun's distance from the solar-system barycenter: Σ (m_i / M☉) · Q_i over
// Jupiter, Saturn, Uranus, and Neptune at aphelion Q_i is ≈ 0.0106 AU (≈ 2.3 R☉); the terrestrial
// planets add ≈ 1e-5 AU. Rounded up to 0.011 AU.
const SUN_BARYCENTER_OFFSET_BOUND = 0.011

// The Earth geocenter endpoint, an observer that needs no Earth-orientation data.
const GEOCENTER = naifEphemerisEndpoint(Naif.EARTH)

// Availability of the Earth-orientation data (UT1-UTC, polar motion) behind a ground-site observer path:
// 'notRequired' for a geocentric observer, 'tabulated' when the default IERS providers cover the date,
// 'missing' when they do not (UT1-UTC and polar motion fall back to an edge value or 0), and 'custom'
// when a time or global provider override is in use and coverage cannot be assessed here.
export type EarthOrientationStatus = 'notRequired' | 'tabulated' | 'missing' | 'custom'

// How the reception instant was put on TDB: 'input' when it was already TDB (or TCB, converted
// exactly), 'topocentric' when time.location supplied the observer-dependent TDB-TT term, and
// 'geocentric' when that term was omitted.
export type ReceptionTdbModel = 'input' | 'topocentric' | 'geocentric'

// Optional model inputs for barycentricJulianDate.
export interface BarycentricJulianDateOptions {
	// SSB-to-Sun path (AU, AU/day). When supplied, the solar Shapiro delay is applied.
	readonly sun?: EphemerisPath
	// Barycentric distance to the source in AU. When supplied, the exact spherical-wavefront
	// Rømer delay is used; otherwise the source is at infinity (plane wave).
	readonly distance?: Distance
	// 1σ uncertainty of the reception timestamp in seconds, carried into the error budget (default 0).
	readonly timestampUncertainty?: number
}

// Terms included in a barycentricJulianDate result.
export interface BarycentricJulianDateModel {
	// Rømer delay geometry: source at infinity or at options.distance.
	readonly romer: 'planeWave' | 'sphericalWave'
	// Whether the solar Shapiro delay is applied.
	readonly shapiro: boolean
	// How the reception instant was converted to TDB.
	readonly tdb: ReceptionTdbModel
}

// Data-quality diagnostics of a barycentricJulianDate result.
export interface BarycentricJulianDateQuality {
	// Earth-orientation data availability for the observer path.
	readonly earthOrientation: EarthOrientationStatus
	// Angle between the source and the Sun's center seen by the observer, in radians [0, PI].
	// Measured from the Sun path when supplied, otherwise from the SSB as a Sun proxy.
	readonly sunElongation: Angle
	// The line of sight passes through the solar disk; the Shapiro term is clamped at the limb.
	readonly occultedBySun: boolean
}

// Estimated contributions to the BJD_TDB uncertainty, in seconds. Unmodeled planetary Shapiro
// delays (≲ 0.2 µs) and the wavefront curvature omitted by a plane-wave Rømer delay are not included.
export interface BarycentricJulianDateErrorBudget {
	// Caller-supplied 1σ timestamp uncertainty.
	readonly timestamp: number
	// Bound for missing Earth-orientation data (≈ 1.4 µs when 'missing', otherwise 0).
	readonly earthOrientation: number
	// Bound for the omitted topocentric TDB-TT term of a non-geocentric observer (≈ 2.0 µs, otherwise 0).
	readonly tdb: number
	// Worst-case bound on the omitted solar Shapiro correction when no Sun path is given, over every
	// Sun position within 0.011 AU of the SSB (≈ 0.2 µs at quadrature, ≈ 7 µs at opposition, ≈ 113 µs
	// at the limb); 0 when the Sun path is supplied and the term is applied.
	readonly shapiro: number
	// Root-sum-square of the contributions: a heuristic scale that mixes the 1σ timestamp uncertainty
	// with worst-case model bounds, not a confidence interval or a guaranteed limit.
	readonly total: number
}

// A Barycentric Julian Date in TDB and the correction that produced it.
export interface BarycentricJulianDate {
	// BJD_TDB: the reception instant referred to the solar-system barycenter, as a two-part TDB Time.
	readonly time: Time
	// Observed reception instant converted to TDB, before the barycentric correction.
	readonly reception: Time
	// Rømer (geometric light-travel) correction in seconds to add to the reception TDB.
	readonly romer: number
	// Solar Shapiro correction in seconds to add (negative near the Sun; 0 when not applied).
	readonly shapiro: number
	// Total correction BJD_TDB - reception TDB, in seconds.
	readonly correction: number
	// Terms included.
	readonly model: BarycentricJulianDateModel
	// Data-quality diagnostics.
	readonly quality: BarycentricJulianDateQuality
	// Estimated uncertainty contributions.
	readonly errorBudget: BarycentricJulianDateErrorBudget
}

// Computes the Barycentric Julian Date in TDB (BJD_TDB) of a signal received at `time`:
//
//   BJD_TDB = TDB(time) + Δ_Rømer + Δ_Shapiro
//
// The reception instant is converted to TDB (the Einstein delay); UTC input goes through the
// leap-second table, and time.location adds the topocentric TDB-TT term. The observer's barycentric
// position r (AU) is sampled from `observer` at that TDB instant. `direction` is the ICRS/BCRS
// direction to the source at the observation epoch (proper motion already applied); it is
// normalized here. The Rømer delay is (r · n) / c for a source at infinity, or the exact
// (d - |d·n - r|) / c when options.distance supplies d, both positive when the observer lies on the
// source side of the barycenter. With options.sun, the solar Shapiro propagation delay of the
// TEMPO2/PINT form -2GM☉/c³ · ln((|s| + s · n) / 1 AU) ≥ 0 near the Sun, s = Sun -> observer, is
// removed, so Δ_Shapiro = 2GM☉/c³ · ln((|s| + s · n) / 1 AU); a line of sight through the solar disk
// is clamped at the limb and flagged. Without options.sun the term is omitted and only bounded in the
// error budget, since the SSB -> observer vector alone does not fix the Sun's position. Planetary
// Shapiro delays, the source's motion during the light time, and dispersion are not modeled.
//
// `observer` must be SSB-centered: another center (for example the Sun, which would give HJD)
// throws, as does an options.sun path that is not SSB-centered. Path evaluation errors, such as
// an SPK segment that does not cover the date, propagate. The result is TDB, not UTC or TCB.
// For a terrestrial observer, compose the SSB-to-Earth and Earth-to-site paths and set
// time.location for the topocentric TDB term. Allocates the returned result.
export function barycentricJulianDate(time: Time, direction: Vec3, observer: EphemerisPath, options?: BarycentricJulianDateOptions): BarycentricJulianDate {
	// A non-SSB origin would return a plausible heliocentric or geocentric date labelled as BJD.
	if (!sameEphemerisEndpoint(observer.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('observer ephemeris path must be SSB-centered')

	const sun = options?.sun
	if (sun !== undefined && !sameEphemerisEndpoint(sun.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('sun ephemeris path must be SSB-centered')

	const reception = tdb(time)
	const n = vecNormalize(direction)

	// Copies the borrowed observer position before the Sun path may run.
	const r = vecClone(observer.stateAt(reception)[0])
	const p = vecDot(r, n)
	const distance = options?.distance
	let romer = p

	if (distance !== undefined) {
		// d - sqrt(d² - 2dp + r²) rewritten without cancellation for d >> |r|.
		const r2 = vecDot(r, r)
		romer = (2 * distance * p - r2) / (distance + Math.sqrt(distance * distance - 2 * distance * p + r2))
	}

	romer = (romer / SPEED_OF_LIGHT_AU_DAY) * DAYSEC

	// Sun -> observer vector; without a Sun path the SSB stands in for the Sun in the diagnostics only.
	const s = sun === undefined ? r : vecMinus(r, sun.stateAt(reception)[0], r)
	const solar = solarShapiro(s, n)
	const shapiro = sun === undefined ? 0 : solar.correction
	const correction = romer + shapiro

	const geocentric = sameEphemerisEndpoint(observer.target, GEOCENTER)
	const tdbModel: ReceptionTdbModel = time.scale === Timescale.TDB || time.scale === Timescale.TCB ? 'input' : time.location !== undefined ? 'topocentric' : 'geocentric'
	const earthOrientation = geocentric ? 'notRequired' : earthOrientationStatus(time)

	const timestamp = options?.timestampUncertainty ?? 0
	const eopError = earthOrientation === 'missing' ? MISSING_EOP_BOUND : 0
	const tdbError = tdbModel === 'geocentric' && !geocentric ? TOPOCENTRIC_TDB_BOUND : 0
	const shapiroError = sun === undefined ? unmodeledSolarShapiroBound(r, n) : 0

	return {
		time: timeNormalize(reception.day, reception.fraction + correction / DAYSEC, 0, Timescale.TDB),
		reception,
		romer,
		shapiro,
		correction,
		model: { romer: distance === undefined ? 'planeWave' : 'sphericalWave', shapiro: sun !== undefined, tdb: tdbModel },
		quality: { earthOrientation, sunElongation: solar.elongation, occultedBySun: solar.occulted },
		errorBudget: { timestamp, earthOrientation: eopError, tdb: tdbError, shapiro: shapiroError, total: Math.hypot(timestamp, eopError, tdbError, shapiroError) },
	}
}

// Computes the solar Shapiro correction in seconds to add (the negated excess delay) for an
// observer at `s` (AU, Sun -> observer) and unit source direction `n`, with the source-Sun
// elongation ε seen by the observer. |s| + s · n = 2|s|sin²(ε/2) is evaluated through ε to avoid
// cancellation near the Sun; inside the solar disk ε is clamped at the limb, keeping the result finite.
function solarShapiro(s: Vec3, n: Vec3) {
	const distance = vecLength(s)
	const elongation = vecAngle(n, vecNegate(s))
	const limb = Math.asin(Math.min(1, SUN_RADIUS_AU / distance))
	const occulted = elongation < limb
	const half = Math.sin(0.5 * (occulted ? limb : elongation))
	return { correction: SOLAR_SHAPIRO_SCALE * Math.log(2 * distance * half * half), elongation, occulted }
}

// Bounds in seconds the solar Shapiro correction omitted for an observer at SSB -> observer `r` (AU)
// and unit source direction `n`. The Sun lies within SUN_BARYCENTER_OFFSET_BOUND δ of the SSB, and
// f(s) = |s| + s · n changes by at most 2 per unit change of s, so f(Sun -> observer) lies within
// f(r) ± 2δ, floored at the limb clamp |s| - sqrt(|s|² - R☉²) of the farthest Sun, |s| = |r| + δ.
// Returns the largest |2GM☉/c³ · ln f| over that range.
function unmodeledSolarShapiroBound(r: Vec3, n: Vec3) {
	const distance = vecLength(r)
	const f = distance + vecDot(r, n)
	const far = distance + SUN_BARYCENTER_OFFSET_BOUND
	const limb = (SUN_RADIUS_AU * SUN_RADIUS_AU) / (far + Math.sqrt(far * far - SUN_RADIUS_AU * SUN_RADIUS_AU))
	const lower = Math.max(f - 2 * SUN_BARYCENTER_OFFSET_BOUND, limb)
	const upper = f + 2 * SUN_BARYCENTER_OFFSET_BOUND
	return SOLAR_SHAPIRO_SCALE * Math.max(-Math.log(lower), Math.log(upper))
}

// Classifies the Earth-orientation data behind a ground-site observer at the time.
function earthOrientationStatus(time: Time): EarthOrientationStatus {
	const dut1Provider = time.providers?.dut1 ?? TIME_PROVIDERS.dut1
	const pmProvider = time.providers?.pm ?? TIME_PROVIDERS.pm
	if (dut1Provider !== dut1 || pmProvider !== xy) return 'custom'
	return iersab.covers(utc(time)) ? 'tabulated' : 'missing'
}
