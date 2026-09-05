// Almanac usage demonstrations.
//
// Each function below demonstrates the use of an existing public function
// whenever one is available. A few requirements are satisfied by existing API that
// cannot run as a self-contained offline snippet — it is network-backed, needs a
// real observation arc, or is only a thin composition of existing helpers — and
// those bodies document WHAT to call instead. Such cases are tagged with `NOTE:`.
//
// Run a single demonstration by calling its function, or run the curated
// offline subset at the bottom with `bun run examples/almanac.ts`.

import fs from 'fs/promises'
import { matchStars } from '../src/astrometry/matching/star.matching'
import { crescentWidth, moonParallax, moonSemidiameter, nearestLunarApsis, nearestLunarEclipse, nearestLunarPhase, nearestLunarStandstill } from '../src/astronomy/bodies/moon'
import { JUPITER_ROTATION, MARS_ROTATION, MOON_ROTATION, positionAngleOfPole, SATURN_ROTATION, subObserverPoint as bodySubObserver, subSolarPoint as bodySubSolar, SUN_ROTATION } from '../src/astronomy/bodies/orientation'
import { planetMagnitude, type Planet } from '../src/astronomy/bodies/photometry'
import { spaceMotion, star } from '../src/astronomy/bodies/star'
import { carringtonRotationNumber, equationOfTime, nearestSolarEclipse, season } from '../src/astronomy/bodies/sun'
// oxfmt-ignore
import { cirsToObserved, distance as vectorDistance, equatorial as vectorToEquatorial, icrsToCirs, icrsToObserved, parallacticAngle, phaseAngle, refractedAltitude, relativePositionAndVelocity, separationFrom, unrefractedAltitude, type PositionAndVelocity, type PositionAndVelocityOverTime } from '../src/astronomy/coordinates/astrometry'
import { angularDistance, eclipticToEquatorial, equatorialFromJ2000, equatorialToEcliptic, equatorialToGalatic, equatorialToHorizontal, galacticToEquatorial, horizontalToEquatorial, zenith } from '../src/astronomy/coordinates/coordinate'
import { annualAberration, observerState, radialVelocityCorrection } from '../src/astronomy/coordinates/correction'
import { eraAnpm, eraC2s, eraLd, eraLdSun, eraPmpx, eraS2c, eraSeps, eraStarpm, eraStarpv } from '../src/astronomy/coordinates/erfa/erfa'
import { precessFk5FromJ2000 } from '../src/astronomy/coordinates/fk5'
import { GALACTIC, ICRS, SUPERGALACTIC, TEME, fk5ToIcrs, frameToFrame, icrsToFk5, temeToItrf } from '../src/astronomy/coordinates/frame'
import { icrs as icrsVector } from '../src/astronomy/coordinates/icrs'
import { itrs } from '../src/astronomy/coordinates/itrs'
import { Base as Meeus } from '../src/astronomy/ephemeris/meeus'
import { moon as moonGeocentric } from '../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, jupiter, mars, mercury, saturn, sun, venus } from '../src/astronomy/ephemeris/models/analytical/vsop87e'
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse'
import { computeLocalLunarEclipseCircumstances } from '../src/astronomy/events/eclipse/lunar/local'
import { computeGreatestEclipseCircumstances, computeLocalSolarEclipseCircumstances } from '../src/astronomy/events/eclipse/solar/local'
import { computePolynomialBesselianElements } from '../src/astronomy/events/eclipse/solar/map'
import { heliacalPhases } from '../src/astronomy/events/heliacal'
import { ASTRONOMICAL_TWILIGHT, CIVIL_TWILIGHT, NAUTICAL_TWILIGHT, riseTransitSet, STANDARD_HORIZON, SUN_HORIZON } from '../src/astronomy/events/horizon'
import { greatRedSpotTransits, jupiterCentralMeridian } from '../src/astronomy/events/jupiter'
import { galileanMutualEvents, saturnianMutualEvents } from '../src/astronomy/events/mutual'
import { occultationCandidates } from '../src/astronomy/events/occultation'
import { satelliteConjunctions, satelliteEclipses, satelliteLookAngles, satelliteMagnitude, satellitePasses, satelliteShadowState } from '../src/astronomy/events/satellite'
import { searchExtrema, searchRoots } from '../src/astronomy/events/search'
import { planetaryTransits } from '../src/astronomy/events/transit'
import { airmass, airmassKastenYoung, altitudeAtTransit, asteroidMagnitudeEstimate, atmosphericRefraction, cometMagnitudeEstimate, objectAngularDiameter } from '../src/astronomy/formulas'
import { Ellipsoid, geodeticLocation, localSiderealTime, subpoint } from '../src/astronomy/observer/location'
import { KeplerOrbit, asteroid, comet, eccentricAnomalyFromMean, meanMotion, period, tisserandParameter, trueAnomalyClosed, trueAnomalyHyperbolic } from '../src/astronomy/orbits/asteroid'
import { closeApproachBPlane as computeBPlane } from '../src/astronomy/orbits/bplane'
import { ephemerisUncertaintyEllipse as skyUncertaintyEllipse, propagateStateCovariance } from '../src/astronomy/orbits/covariance'
import { gibbs } from '../src/astronomy/orbits/determination/gibbs'
import { herrickGibbs } from '../src/astronomy/orbits/determination/herrickgibbs'
import { moid } from '../src/astronomy/orbits/moid'
import { parseTLE, recordFromTLE, sgp4 } from '../src/astronomy/orbits/propagation/sgp4'
import { HealpixIndex } from '../src/astronomy/sky/spatial/healpix'
import { deltaT } from '../src/astronomy/time/deltat'
import { iersab, iersb } from '../src/astronomy/time/iers'
import { fileHandleSource } from '../src/io/io'
import { matIdentity } from '../src/math/linear-algebra/mat3'
import { Matrix } from '../src/math/linear-algebra/matrix'
// oxfmt-ignore
import { Timescale, dut1 as dut1FromTime, earthRotationAngle, equationOfEquinoxes, greenwichApparentSiderealTime, greenwichMeanSiderealTime, nutationAngles, pmAngles, pmMatrix, tai, taiMinusUtc, tcb, tdb, timeBesselianYear, timeJulianYear, timeMJD, timeShift, timeSubtract, timeToDate, timeUnix, timeYMDHMS, toJulianDay, toJulianEpoch, tt, ut1, utc, type Time } from '../src/astronomy/time/time'
import { formatTemporal, temporalFromTime } from '../src/astronomy/time/temporal'
import { AU_KM, DAYSEC, DAYSPERSY, DAYSPERTY, EARTH_RADIUS_KM, GM_EARTH, GM_EARTH_KM3_S2, GM_SUN_PITJEVA_2005, PI, PIOVERTWO, SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU, TAU } from '../src/core/constants'
import { type Vec3, vecAngle, vecCross, vecLatitude, vecLength, vecLongitude, vecMinus, vecMulScalar, vecNormalize } from '../src/math/linear-algebra/vec3'
import { sphericalDestination, sphericalInterpolate, sphericalPolygonArea, sphericalPositionAngle, sphericalProjectTangentPlane, sphericalSeparation, sphericalTriangleAngles, sphericalTriangleArea, sphericalUnprojectTangentPlane } from '../src/math/numerical/geometry'
import { type Angle, arcsec, deg, formatAZ, formatHMS, formatSignedDMS, hms, hour, normalizeAngle, normalizePI, toArcsec, toDeg, toHour } from '../src/math/units/angle'
import { kilometer, toKilometer } from '../src/math/units/distance'
import { toKilometerPerSecond } from '../src/math/units/velocity'

await fs.access('data/eopc04.1962-now.txt')
const handle = await fs.open('data/eopc04.1962-now.txt')
await using source = fileHandleSource(handle)
source.seek(4640029)
await iersb.load(source)

// Shared reference instant (UTC) used by most demonstrations.
const NOW = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Shared observer: a mid-northern site (longitude east-positive, latitude, elevation).
const SITE = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)
NOW.location = SITE

// A bright reference star (Sirius, ICRS J2000) reused across the coordinate examples.
const SIRIUS_RA = hms(6, 45, 8.917)
const SIRIUS_DEC = deg(-16.716116)
const SIRIUS_ICRF = icrsVector(SIRIUS_RA, SIRIUS_DEC)

// ##### Time and Earth Orientation #####

// Julian Date Conversion: build a Time then read back its Julian Day.
function julianDateConversion() {
	const t = timeYMDHMS(2026, 6, 29, 12, 0, 0, Timescale.UTC)
	console.info('Julian Date for 2026-06-29 12:00 UTC:', toJulianDay(t))
}

// Modified Julian Date Conversion: create a Time from an MJD and recover the JD.
function modifiedJulianDateConversion() {
	const t = timeMJD(61500, Timescale.UTC)
	console.info('Time from MJD 61500 -> JD:', toJulianDay(t))
}

// Julian Date to Calendar Date: decompose a Time into Y/M/D/h/m/s/ns.
function julianDateToCalendarDate() {
	console.info('Calendar date of NOW:', formatTemporal(temporalFromTime(NOW)))
}

// Unix Time Conversion: build a Time from Unix seconds.
function unixTimeConversion() {
	const t = timeUnix(1782777600)
	console.info('Time from Unix 1782777600 -> JD:', toJulianDay(t))
}

// UTC to TAI Conversion: convert a UTC instant to the TAI timescale.
function utcToTaiConversion() {
	const t = tai(NOW)
	console.info('TAI day/fraction:', t.day, t.fraction, 'scale:', Timescale[t.scale])
}

// TAI to TT Conversion: TT = TAI + 32.184 s, applied via the TT timescale.
function taiToTtConversion() {
	const t = tt(NOW)
	console.info('TT day/fraction:', t.day, t.fraction, 'scale:', Timescale[t.scale])
}

// UTC to UT1 Conversion: applies the DUT1 (UT1-UTC) offset from IERS.
function utcToUt1Conversion() {
	const t = ut1(NOW)
	console.info('UT1 day/fraction:', t.day, t.fraction)
}

// TT to TDB Conversion: barycentric dynamical time, periodic relativistic terms.
function ttToTdbConversion() {
	const t = tdb(NOW)
	console.info('TDB day/fraction:', t.day, t.fraction)
}

// TT to TCB Conversion: barycentric coordinate time (secular rate vs TDB).
function ttToTcbConversion() {
	const t = tcb(NOW)
	console.info('TCB day/fraction:', t.day, t.fraction)
}

// Delta T Estimation: ΔT = TT-UT1 polynomial estimate for a decimal year.
function deltaTEstimation() {
	console.info('delta T estimated for year 2026:', deltaT(2026), 's')
}

// DUT1 Interpolation: UT1-UTC in seconds interpolated from IERS bulletins.
function dut1Interpolation() {
	console.info('DUT1 at NOW (seconds):', dut1FromTime(NOW))
}

// Leap Second Lookup: TAI-UTC (accumulated leap seconds) at the instant.
function leapSecondLookup() {
	console.info('TAI-UTC leap seconds at NOW:', taiMinusUtc(NOW), 's')
}

// Earth Rotation Angle: ERA from the IAU 2000 definition.
function earthRotationAngleComputation() {
	console.info('Earth Rotation Angle:', formatHMS(earthRotationAngle(NOW)))
}

// Greenwich Mean Sidereal Time.
function greenwichMeanSiderealTimeComputation() {
	console.info('GMST:', formatHMS(greenwichMeanSiderealTime(NOW)))
}

// Greenwich Apparent Sidereal Time (GMST + equation of the equinoxes).
function greenwichApparentSiderealTimeComputation() {
	console.info('GAST:', formatHMS(greenwichApparentSiderealTime(NOW)))
}

// Local Mean Sidereal Time at the observer's longitude.
function localMeanSiderealTime() {
	console.info('LMST:', formatHMS(localSiderealTime(NOW, SITE, true)))
}

// Local Apparent Sidereal Time at the observer's longitude.
function localApparentSiderealTime() {
	console.info('LAST:', formatHMS(localSiderealTime(NOW, SITE, false)))
}

// Equation of the Equinoxes: GAST - GMST.
function equationOfTheEquinoxes() {
	console.info('Equation of the equinoxes (arcsec):', toArcsec(equationOfEquinoxes(NOW)))
}

// Polar Motion Matrix: rotation accounting for the wandering of the pole.
function polarMotionMatrix() {
	const [sprime, x, y] = pmAngles(NOW)
	console.info('Polar motion angles (sprime,x,y arcsec):', toArcsec(sprime), toArcsec(x), toArcsec(y))
	console.info('Polar motion matrix:', pmMatrix(NOW))
}

// Earth Orientation Interpolation: DUT1 and polar motion straight from the IERS tables.
function earthOrientationInterpolation() {
	console.info('IERS DUT1 (s):', iersab.dut1(NOW))
	const [x, y] = iersab.xy(NOW)
	console.info('IERS polar motion (arcsec):', toArcsec(x), toArcsec(y))
}

// Julian Epoch Conversion: Time <-> Julian epoch year (J2026.5).
function julianEpochConversion() {
	const t = timeJulianYear(2026.5, Timescale.TT)
	console.info('Round-trip Julian epoch:', toJulianEpoch(t))
}

// Besselian Epoch Conversion: Time from a Besselian epoch year (B1950).
function besselianEpochConversion() {
	const t = timeBesselianYear(1950, Timescale.TT)
	console.info('Besselian B1950 -> JD(TT):', toJulianDay(tt(t)))
}

// Tropical Year Length: time for the Sun to return to the same equinox.
function tropicalYearLength() {
	// DAYSPERTY is the B1900 tropical-year length; the value drifts slowly.
	console.info('Tropical year length (days):', DAYSPERTY)
}

// Sidereal Year Length: one revolution of the Earth relative to the fixed stars.
function siderealYearLength() {
	console.info('Sidereal year length (days):', DAYSPERSY)
}

// ##### Coordinate Systems and Geometry #####

// Spherical to Cartesian Coordinates: unit vector from (theta, phi).
function sphericalToCartesian() {
	console.info('Unit vector for Sirius:', eraS2c(SIRIUS_RA, SIRIUS_DEC))
}

// Cartesian to Spherical Coordinates: recover angles from a unit vector.
function cartesianToSpherical() {
	const [theta, phi] = eraC2s(...SIRIUS_ICRF)
	console.info('Recovered RA/DEC:', formatHMS(normalizeAngle(theta)), formatSignedDMS(phi))
}

// Right Ascension and Declination to Vector: ICRS direction with a distance.
function raDecToVector() {
	console.info('ICRS position vector (AU):', SIRIUS_ICRF)
}

// Vector to Right Ascension and Declination.
function vectorToRaDec() {
	const v = SIRIUS_ICRF
	console.info('RA:', formatHMS(normalizeAngle(vecLongitude(v))), 'DEC:', formatSignedDMS(vecLatitude(v)))
}

// ICRS to FK5 Transformation (apply the frame bias).
function icrsToFk5Transformation() {
	console.info('FK5 vector:', icrsToFk5(SIRIUS_ICRF))
}

// FK5 to ICRS Transformation (remove the frame bias).
function fk5ToIcrsTransformation() {
	console.info('ICRS vector:', fk5ToIcrs(SIRIUS_ICRF))
}

// ICRS to Galactic Transformation.
function icrsToGalactic() {
	const [l, b] = equatorialToGalatic(SIRIUS_RA, SIRIUS_DEC)
	console.info('Galactic l/b (deg):', toDeg(l), toDeg(b))
}

// Galactic to ICRS Transformation.
function galacticToIcrs() {
	const [ra, dec] = galacticToEquatorial(deg(227.23), deg(-8.89))
	console.info('Equatorial RA/DEC:', formatHMS(normalizeAngle(ra)), formatSignedDMS(dec))
}

// ICRS to Ecliptic Transformation.
function icrsToEcliptic() {
	const [lon, lat] = equatorialToEcliptic(SIRIUS_RA, SIRIUS_DEC, NOW)
	console.info('Ecliptic lon/lat (deg):', toDeg(lon), toDeg(lat))
}

// Ecliptic to ICRS Transformation.
function eclipticToIcrs() {
	const [ra, dec] = eclipticToEquatorial(deg(104), deg(-39.6), NOW)
	console.info('Equatorial RA/DEC:', formatHMS(normalizeAngle(ra)), formatSignedDMS(dec))
}

// Galactic to Supergalactic Transformation (through the ICRS base frame).
function galacticToSupergalactic() {
	const direction = SIRIUS_ICRF
	const sg = frameToFrame(direction, GALACTIC, SUPERGALACTIC, NOW)
	console.info('Supergalactic SGL/SGB (deg):', toDeg(normalizeAngle(vecLongitude(sg))), toDeg(vecLatitude(sg)))
}

// Equatorial to Horizontal Coordinates: azimuth/altitude from the hour angle.
function equatorialToHorizontalComputation() {
	const lst = localSiderealTime(NOW, SITE, false)
	const [az, alt] = equatorialToHorizontal(SIRIUS_RA, SIRIUS_DEC, SITE.latitude, lst)
	console.info('Azimuth:', formatAZ(az), 'Altitude:', formatSignedDMS(alt))
}

// Horizontal to Equatorial Coordinates: the exact inverse of equatorialToHorizontal.
function horizontalToEquatorialComputation() {
	const lst = localSiderealTime(NOW, SITE, false)
	const [ra, dec] = horizontalToEquatorial(deg(120), deg(35), SITE.latitude, lst)
	console.info('Recovered RA/DEC:', formatHMS(ra), formatSignedDMS(dec))
}

// Hour Angle Calculation: HA = LST - RA.
function hourAngleCalculation() {
	const ha = normalizeAngle(localSiderealTime(NOW, SITE, false) - SIRIUS_RA)
	console.info('Hour angle:', formatHMS(ha), `(${toHour(ha).toFixed(3)} h)`)
}

// Parallactic Angle: orientation of the celestial pole at the target.
function parallacticAngleCalculation() {
	const ha = normalizeAngle(localSiderealTime(NOW, SITE, false) - SIRIUS_RA)
	console.info('Parallactic angle (deg):', toDeg(parallacticAngle(ha, SIRIUS_DEC, SITE.latitude)))
}

// Great Circle Distance between two sky positions.
function greatCircleDistance() {
	const d = sphericalSeparation(SIRIUS_RA, SIRIUS_DEC, deg(101.287), deg(-16.716))
	console.info('Great-circle distance (deg):', toDeg(d))
	// angularDistance / eraSeps compute the same quantity.
	console.info('Same via eraSeps (deg):', toDeg(eraSeps(SIRIUS_RA, SIRIUS_DEC, deg(101.287), deg(-16.716))))
	console.info('Same via angularDistance (deg):', toDeg(angularDistance(SIRIUS_RA, SIRIUS_DEC, deg(101.287), deg(-16.716))))
}

// Great Circle Bearing: initial position angle from A to B.
function greatCircleBearing() {
	const pa = sphericalPositionAngle(SIRIUS_RA, SIRIUS_DEC, deg(101.287), deg(-10))
	console.info('Bearing / position angle (deg):', toDeg(normalizeAngle(pa)))
}

// Great Circle Midpoint: spherical interpolation at fraction 0.5.
function greatCircleMidpoint() {
	const [lon, lat] = sphericalInterpolate(SIRIUS_RA, SIRIUS_DEC, deg(101.287), deg(-10), 0.5)
	console.info('Midpoint RA/DEC:', formatHMS(normalizeAngle(lon)), formatSignedDMS(lat))
}

// Spherical Polygon Area: spherical excess of the boundary, in steradians.
function sphericalPolygonAreaComputation() {
	const vertices: [number, number][] = [
		[deg(0), deg(0)],
		[deg(10), deg(0)],
		[deg(10), deg(10)],
		[deg(0), deg(10)],
	]
	console.info('Spherical polygon area (steradians):', sphericalPolygonArea(vertices))
}

// Spherical Triangle Area: spherical excess E = A + B + C - PI (steradians).
function sphericalTriangleAreaComputation() {
	const area = sphericalTriangleArea(deg(0), deg(0), deg(10), deg(0), deg(0), deg(10))
	console.info('Spherical triangle area (steradians):', area)
}

// Spherical Triangle Angles: interior angles from the three vertices.
function sphericalTriangleAnglesComputation() {
	const [a, b, c] = sphericalTriangleAngles(deg(0), deg(0), deg(40), deg(0), deg(0), deg(40))
	console.info('Interior angles (deg):', toDeg(a), toDeg(b), toDeg(c))
}

// Tangent Plane Projection (gnomonic): project a direction about a tangent point.
function tangentPlaneProjection() {
	const origin = eraS2c(SIRIUS_RA, SIRIUS_DEC)
	const direction = eraS2c(SIRIUS_RA + deg(0.5), SIRIUS_DEC + deg(0.2))
	const offset = sphericalProjectTangentPlane(direction, origin)
	console.info('Tangent-plane offset (arcsec):', offset ? [toArcsec(offset.x), toArcsec(offset.y)] : 'behind plane')
}

// Inverse Tangent Plane Projection: recover a direction from tangent offsets.
function inverseTangentPlaneProjection() {
	const origin = eraS2c(SIRIUS_RA, SIRIUS_DEC)
	const v = sphericalUnprojectTangentPlane(deg(0.5), deg(0.2), origin)
	console.info('Recovered RA/DEC:', formatHMS(normalizeAngle(vecLongitude(v))), formatSignedDMS(vecLatitude(v)))
}

// Position Angle Between Sky Coordinates (re-using the geometry helper).
function positionAngleBetween() {
	const pa = sphericalPositionAngle(SIRIUS_RA, SIRIUS_DEC, deg(101.5), deg(-15))
	console.info('Position angle (deg):', toDeg(normalizeAngle(pa)))
}

// Coordinate Offset by Position Angle: destination given PA and distance.
function coordinateOffsetByPositionAngle() {
	const [lon, lat] = sphericalDestination(SIRIUS_RA, SIRIUS_DEC, deg(45), deg(2))
	console.info('Offset RA/DEC:', formatHMS(normalizeAngle(lon)), formatSignedDMS(lat))
}

// Small Angle Offset: same helper with an arcsecond-scale separation.
function smallAngleOffset() {
	const [lon, lat] = sphericalDestination(SIRIUS_RA, SIRIUS_DEC, deg(90), arcsec(30))
	console.info('30-arcsec east offset RA/DEC:', formatHMS(normalizeAngle(lon)), formatSignedDMS(lat))
}

// Celestial Pole Distance: co-declination = 90deg - DEC.
function celestialPoleDistance() {
	console.info('Distance to north celestial pole (deg):', toDeg(PIOVERTWO - SIRIUS_DEC))
}

// Zenith Distance: 90deg minus altitude (and the zenith's equatorial coords).
function zenithDistance() {
	const lst = localSiderealTime(NOW, SITE, false)
	const [, alt] = equatorialToHorizontal(SIRIUS_RA, SIRIUS_DEC, SITE.latitude, lst)
	console.info('Zenith distance of Sirius (deg):', toDeg(PIOVERTWO - alt))
	const [zra, zdec] = zenith(SITE.longitude, SITE.latitude, NOW)
	console.info('Zenith equatorial RA/DEC:', formatHMS(normalizeAngle(zra)), formatSignedDMS(zdec))
}

// ##### Shared ephemeris helpers (used by Sections 3-5) #####

// Heliocentric position of the Earth (AU), i.e. Earth minus Sun.
function earthHeliocentric(time: Time = NOW) {
	return relativePositionAndVelocity(earth, sun, time)[0]
}

// Geocentric astrometric direction toward a barycentric body (AU). No light-time
// iteration: good enough for demonstrations but not for sub-arcsecond ephemerides.
function geocentricDirection(body: PositionAndVelocityOverTime, time: Time = NOW) {
	return relativePositionAndVelocity(body, earth, time)[0]
}

// Observe an ICRS direction (or AU vector) from the site, applying frame bias,
// precession-nutation, aberration and refraction through the ERFA pipeline.
function observeDirection(direction: Vec3, time: Time = NOW) {
	const [ep, ev] = earth(time)
	return icrsToObserved(direction, time, [ep, ev], earthHeliocentric(time))
}

// ##### Astrometric Corrections and Stellar Motion #####

// Precession Transformation: precess an FK5 direction from J2000 to the epoch of date.
function precessionTransformation() {
	const ofDate = precessFk5FromJ2000(SIRIUS_ICRF, NOW)
	console.info('Precessed RA/DEC of date:', formatHMS(normalizeAngle(vecLongitude(ofDate))), formatSignedDMS(vecLatitude(ofDate)))
}

// Nutation Correction: the (Δψ, Δε) nutation angles in longitude and obliquity.
function nutationCorrection() {
	const [dpsi, deps] = nutationAngles(NOW)
	console.info('Nutation Δψ, Δε (arcsec):', toArcsec(dpsi), toArcsec(deps))
}

// Annual Aberration: stellar aberration from the Earth's orbital velocity.
function annualAberrationComputation() {
	const natural = vecNormalize(SIRIUS_ICRF)
	// Pass the Earth's barycentric velocity (AU/day) and observer-Sun distance (AU).
	const proper = annualAberration(natural, earth(NOW)[1], vecLength(earthHeliocentric(NOW)))
	console.info('Aberration shift (arcsec):', toArcsec(eraSeps(vecLongitude(natural), vecLatitude(natural), vecLongitude(proper), vecLatitude(proper))))
}

// Diurnal Aberration: the small extra aberration from the observer's daily rotation.
// The diurnal velocity is the observer's topocentric velocity (from observerState)
// minus the geocentric (Earth) velocity; feeding it to annualAberration gives the
// diurnal-only shift (~0.3" at the equator).
function diurnalAberration() {
	const earthState = earth(NOW)
	const [, topocentricVelocity] = observerState(NOW, earthState, SITE)
	const diurnalVelocity: Vec3 = [topocentricVelocity[0] - earthState[1][0], topocentricVelocity[1] - earthState[1][1], topocentricVelocity[2] - earthState[1][2]]
	const natural = vecNormalize(SIRIUS_ICRF)
	const proper = annualAberration(natural, diurnalVelocity, vecLength(earthHeliocentric(NOW)))
	console.info('Diurnal aberration shift (arcsec):', toArcsec(eraSeps(vecLongitude(natural), vecLatitude(natural), vecLongitude(proper), vecLatitude(proper))))
}

// Solar Gravitational Deflection: bending of starlight grazing the Sun (ERFA eraLdSun).
function solarGravitationalDeflection() {
	const natural = vecNormalize(SIRIUS_ICRF)
	const eSun = vecMulScalar(earthHeliocentric(NOW), -1) // Earth -> Sun direction
	const em = vecLength(eSun)
	const deflected = eraLdSun(natural, vecNormalize(eSun), em)
	console.info('Solar deflection (arcsec):', toArcsec(eraSeps(vecLongitude(natural), vecLatitude(natural), vecLongitude(deflected), vecLatitude(deflected))))
}

// Planetary Gravitational Deflection: light bending by a massive planet (Jupiter),
// computed with ERFA eraLd for a star grazing Jupiter's limb (~0.017"). For a full
// pipeline, pass all major bodies to eraLdn instead.
function planetaryGravitationalDeflection() {
	const jupiterGeo = geocentricDirection(jupiter) // observer -> Jupiter (AU)
	const em = vecLength(jupiterGeo) // observer-Jupiter distance (AU)
	const jupiterToObserver = vecNormalize(vecMulScalar(jupiterGeo, -1))
	// Place the star at Jupiter's limb: offset Jupiter's direction by its angular radius.
	const angularRadius = Math.asin(71492 / AU_KM / em)
	const [lon, lat] = sphericalDestination(vecLongitude(jupiterGeo), vecLatitude(jupiterGeo), 0, angularRadius)
	const star = eraS2c(lon, lat)
	const JUPITER_MASS_IN_SOLAR_MASSES = 1 / 1047.348644
	// Small deflection limiter so the grazing-limb geometry is not clamped (Jupiter subtends far less than the Sun).
	const deflected = eraLd(JUPITER_MASS_IN_SOLAR_MASSES, star, star, jupiterToObserver, em, 1e-9 / Math.max(1, em * em))
	console.info('Jupiter limb deflection (arcsec):', toArcsec(eraSeps(vecLongitude(star), vecLatitude(star), vecLongitude(deflected), vecLatitude(deflected))))
}

// Annual Parallax: yearly ellipse from the Earth's barycentric displacement (ERFA eraPmpx).
function annualParallax() {
	const [pob] = earth(NOW) // Earth barycentric position (AU)
	const px = arcsec(0.379) // Sirius parallax
	const shifted = eraPmpx(SIRIUS_RA, SIRIUS_DEC, 0, 0, px, 0, 0, pob)
	console.info('Parallax-shifted RA/DEC:', formatHMS(normalizeAngle(vecLongitude(shifted))), formatSignedDMS(vecLatitude(shifted)))
}

// Diurnal Parallax: topocentric shift from the observer's offset from the geocenter.
// NOTE: no packaged helper for stars; the offset is the observer's ITRS vector
// (itrs(location)) rotated to ICRS and subtracted from the geocentric direction.
// Significant only for nearby bodies (Moon/asteroids), where the topocentric
// body-state helper in Section 4 already accounts for it.
function diurnalParallax() {
	const offset = itrs(SITE) // geocentric observer position, Earth radii
	console.info('Observer geocentric offset (Earth radii):', vecLength(offset))
}

// Proper Motion Propagation: move a catalog star between two epochs (ERFA eraStarpm).
function properMotionPropagation() {
	const ep1 = toJulianDay(tt(timeJulianYear(2000, Timescale.TT)))
	const ep2 = toJulianDay(tt(timeJulianYear(2050, Timescale.TT)))
	const r = eraStarpm(SIRIUS_RA, SIRIUS_DEC, arcsec(-0.546) / Math.cos(SIRIUS_DEC), arcsec(-1.223), arcsec(0.379), 0, ep1, 0, ep2, 0)
	if (r) console.info('Star at 2050:', formatHMS(normalizeAngle(r[0])), formatSignedDMS(r[1]))
}

// Radial Velocity Propagation: RV changes the distance, feeding back into the angles.
function radialVelocityPropagation() {
	// eraStarpv embeds the radial velocity into the space-motion vector.
	const pv = eraStarpv(SIRIUS_RA, SIRIUS_DEC, 0, 0, arcsec(0.379), 5.5)
	console.info('Space-motion velocity (AU/day):', pv[1])
}

// Full Space Motion Propagation: combine position, proper motion, parallax and RV.
function fullSpaceMotionPropagation() {
	const s = star(SIRIUS_RA, SIRIUS_DEC, arcsec(-0.546) / Math.cos(SIRIUS_DEC), arcsec(-1.223), arcsec(0.379), 5.5)
	const [p] = spaceMotion(s, NOW)
	console.info('BCRS position at NOW:', formatHMS(normalizeAngle(vecLongitude(p))), formatSignedDMS(vecLatitude(p)))
}

// Perspective Acceleration: proper motion itself changes as a fast, nearby star
// approaches or recedes. NOTE: not exposed as its own function; it falls out of
// eraStarpm naturally. Here we difference the proper motion over a century.
function perspectiveAcceleration() {
	const ep0 = toJulianDay(tt(timeJulianYear(2000, Timescale.TT)))
	const epA = toJulianDay(tt(timeJulianYear(2001, Timescale.TT)))
	const epB = toJulianDay(tt(timeJulianYear(2101, Timescale.TT)))
	const a = eraStarpm(SIRIUS_RA, SIRIUS_DEC, arcsec(-0.546) / Math.cos(SIRIUS_DEC), arcsec(-1.223), arcsec(0.379), 5.5, ep0, 0, epA, 0)
	const b = eraStarpm(SIRIUS_RA, SIRIUS_DEC, arcsec(-0.546) / Math.cos(SIRIUS_DEC), arcsec(-1.223), arcsec(0.379), 5.5, ep0, 0, epB, 0)
	if (a && b) console.info('Δ(pmDEC) over 100 yr (mas/yr):', (toArcsec(b[3]) - toArcsec(a[3])) * 1000)
}

// Barycentric Radial Velocity Correction: project the observer velocity onto the line of sight.
function barycentricRadialVelocityCorrection() {
	const rv = radialVelocityCorrection(SIRIUS_RA, SIRIUS_DEC, NOW, earth(NOW), SITE)
	console.info('Barycentric RV correction (km/s):', rv * 1731.4568) // AU/day -> km/s
}

// Heliocentric Radial Velocity Correction: reference the Sun's center instead of
// the barycenter by passing the heliocentric Earth state (Earth minus Sun) to the
// same radialVelocityCorrection; the difference from the barycentric value is the
// Sun's barycentric motion projected onto the line of sight.
function heliocentricRadialVelocityCorrection() {
	const heliocentricEarth = relativePositionAndVelocity(earth, sun, NOW)
	const rv = radialVelocityCorrection(SIRIUS_RA, SIRIUS_DEC, NOW, heliocentricEarth, SITE)
	console.info('Heliocentric RV correction (km/s):', toKilometerPerSecond(rv))
}

// Astrometric to Apparent Place: ICRS -> CIRS (apparent equator/equinox of date).
function astrometricToApparentPlace() {
	const [ep, ev] = earth(NOW)
	const [ra, dec] = icrsToCirs([SIRIUS_RA, SIRIUS_DEC], NOW, [ep, ev], earthHeliocentric(NOW))
	console.info('Apparent CIRS RA/DEC:', formatHMS(normalizeAngle(ra)), formatSignedDMS(dec))
}

// Apparent to Observed Place: CIRS -> observed azimuth/altitude with refraction.
function apparentToObservedPlace() {
	const [ep, ev] = earth(NOW)
	const [ra, dec] = icrsToCirs([SIRIUS_RA, SIRIUS_DEC], NOW, [ep, ev], earthHeliocentric(NOW))
	const o = cirsToObserved([ra, dec], NOW)
	console.info('Observed Az/Alt:', formatAZ(o.azimuth), formatSignedDMS(o.altitude))
}

// Atmospheric Refraction: raise the apparent altitude of a low object.
function atmosphericRefractionComputation() {
	const trueAltitude = deg(10)
	// atmosphericRefraction returns the refraction in arcminutes (Bennett's formula).
	console.info('Refraction at 10deg altitude (arcmin):', atmosphericRefraction(trueAltitude))
	console.info('Refracted altitude (deg):', toDeg(refractedAltitude(trueAltitude)))
}

// Inverse Atmospheric Refraction: recover the true altitude from an observed one,
// the ERFA-consistent inverse of refractedAltitude.
function inverseAtmosphericRefraction() {
	const observed = deg(10)
	console.info('Recovered true altitude (deg):', toDeg(unrefractedAltitude(observed)))
}

// Differential Atmospheric Refraction: refraction difference across a field's extent.
function differentialAtmosphericRefraction() {
	const dr = atmosphericRefraction(deg(20)) - atmosphericRefraction(deg(20.5))
	console.info('Differential refraction over 0.5deg at 20deg alt (arcsec):', dr * 60)
}

// Catalog Cross-Match: associate detected stars with a reference list.
// NOTE: crossMatchStars() matches a detected list against a StarCatalog (async,
// catalog-backed). For an offline demonstration we use matchStars(), which solves
// the geometric transform between two star frames; the same machinery underpins
// catalog association once a catalog is supplied.
function catalogCrossMatch() {
	const reference = [
		{ x: 100, y: 120, hfd: 3, snr: 50, flux: 1000 },
		{ x: 320, y: 150, hfd: 3, snr: 40, flux: 900 },
		{ x: 250, y: 400, hfd: 3, snr: 30, flux: 800 },
		{ x: 470, y: 320, hfd: 3, snr: 20, flux: 700 },
		{ x: 60, y: 430, hfd: 3, snr: 18, flux: 650 },
		{ x: 410, y: 90, hfd: 3, snr: 16, flux: 600 },
		{ x: 190, y: 260, hfd: 3, snr: 14, flux: 550 },
		{ x: 360, y: 470, hfd: 3, snr: 12, flux: 500 },
	]
	const current = reference.map((s) => ({ ...s, x: s.x + 12, y: s.y - 7 }))
	const result = matchStars(reference, current)
	console.info('Matched pairs:', result.matches.length, 'translation tx/ty:', result.similarity?.tx, result.similarity?.ty)
}

// Nearest Celestial Neighbor: HEALPix cone query, then pick the closest object.
function nearestCelestialNeighbor() {
	const index = new HealpixIndex({ nside: 64, ordering: 'nested' })
	index.add(1, deg(101), deg(-16.5))
	index.add(2, deg(101.3), deg(-16.7))
	index.add(3, deg(105), deg(-20))
	const found = index.queryCone(SIRIUS_RA, SIRIUS_DEC, deg(2))
	let best: { id: unknown; sep: number } | undefined
	for (const e of found) {
		const sep = sphericalSeparation(SIRIUS_RA, SIRIUS_DEC, e.rightAscension, e.declination)
		if (!best || sep < best.sep) best = { id: e.id, sep }
	}
	console.info('Nearest neighbor id/separation(deg):', best?.id, best ? toDeg(best.sep) : undefined)
}

// ##### Solar System Ephemerides #####

// Barycentric Body State: ICRF position (AU) and velocity (AU/day) about the SSB.
function barycentricBodyState() {
	const [p, v] = mars(NOW)
	console.info('Mars barycentric position (AU):', p, 'velocity (AU/day):', v)
}

// Heliocentric Body State: subtract the Sun's barycentric state.
function heliocentricBodyState() {
	const helio = vecMinus(mars(NOW)[0], sun(NOW)[0])
	console.info('Mars heliocentric distance (AU):', vecLength(helio))
}

// Geocentric Body State: position relative to the Earth's center.
function geocentricBodyState() {
	const geo = geocentricDirection(mars)
	console.info('Mars geocentric distance (AU):', vectorDistance(geo))
}

// Topocentric Body State: position relative to the observer on the surface.
function topocentricBodyState() {
	const [observer] = observerState(NOW, earth(NOW), SITE)
	const topo = vecMinus(mars(NOW)[0], observer)
	console.info('Mars topocentric distance (AU):', vecLength(topo))
}

// Apparent Planet Position: geocentric apparent RA/DEC.
function apparentPlanetPosition() {
	const eq = vectorToEquatorial(geocentricDirection(jupiter))
	console.info('Jupiter apparent RA/DEC:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]))
}

// Planet Altitude and Azimuth.
function planetAltitudeAndAzimuth() {
	const o = observeDirection(geocentricDirection(jupiter))
	console.info('Jupiter Az/Alt:', formatAZ(o.azimuth), formatSignedDMS(o.altitude))
}

// Planetary Elongation: Sun-Earth-planet angle (planet's angular distance from the Sun).
function planetaryElongation() {
	const sunDir = vecMinus(sun(NOW)[0], earth(NOW)[0])
	const planetDir = geocentricDirection(venus)
	console.info('Venus elongation (deg):', toDeg(separationFrom(sunDir, planetDir)))
}

// Planetary Phase Angle: Sun-planet-Earth angle at the planet.
function planetaryPhaseAngle() {
	const i = planetPhaseAngle(venus)
	console.info('Venus phase angle (deg):', toDeg(i))
}

// Sun-planet-Earth angle at the planet (radians).
function planetPhaseAngle(body: PositionAndVelocityOverTime, time: Time = NOW) {
	return phaseAngle(body(time)[0], sun(time)[0], earth(time)[0])
}

// Sun-Earth-body elongation (radians) as a function of time, for the event scanners.
function elongationAt(body: PositionAndVelocityOverTime, time: Time) {
	return separationFrom(geocentricSun(time), geocentricDirection(body, time))
}

// Planetary Illuminated Fraction: from the phase angle (Meeus).
function planetaryIlluminatedFraction() {
	console.info('Venus illuminated fraction:', Meeus.illuminated(planetPhaseAngle(venus)))
}

// Planetary Angular Diameter: physical diameter over geocentric distance.
function planetaryAngularDiameter() {
	const distanceKm = toKilometer(vectorDistance(geocentricDirection(jupiter)))
	const JUPITER_DIAMETER_KM = 142984
	console.info('Jupiter angular diameter (arcsec):', toArcsec(objectAngularDiameter(JUPITER_DIAMETER_KM, distanceKm)))
}

// Planetary Visual Magnitude: the Mallama & Hilton (2018) photometric model, from the
// heliocentric and geocentric vectors (and the year for Neptune's secular term).
function planetaryVisualMagnitude() {
	const year = toJulianEpoch(NOW)
	const magnitude = (planet: Planet, body: PositionAndVelocityOverTime) => planetMagnitude(planet, vecMinus(body(NOW)[0], sun(NOW)[0]), vecMinus(body(NOW)[0], earth(NOW)[0]), { year })
	console.info('Visual magnitude V (Venus, Mars, Jupiter, Saturn):', magnitude('venus', venus), magnitude('mars', mars), magnitude('jupiter', jupiter), magnitude('saturn', saturn))
}

// Planetary Heliocentric Longitude: ecliptic longitude of the heliocentric position.
function planetaryHeliocentricLongitude() {
	const helio = vecMinus(mars(NOW)[0], sun(NOW)[0])
	const eq = vectorToEquatorial(helio)
	const [lon] = equatorialToEcliptic(eq[0], eq[1], NOW)
	console.info('Mars heliocentric ecliptic longitude (deg):', toDeg(normalizeAngle(lon)))
}

// Planetary Geocentric Longitude: ecliptic longitude as seen from the Earth.
function planetaryGeocentricLongitude() {
	const eq = vectorToEquatorial(geocentricDirection(mars))
	const [lon] = equatorialToEcliptic(eq[0], eq[1], NOW)
	console.info('Mars geocentric ecliptic longitude (deg):', toDeg(normalizeAngle(lon)))
}

// Planetary Ecliptic Latitude.
function planetaryEclipticLatitude() {
	const eq = vectorToEquatorial(geocentricDirection(mars))
	const [, lat] = equatorialToEcliptic(eq[0], eq[1], NOW)
	console.info('Mars ecliptic latitude (deg):', toDeg(lat))
}

// Planetary Apparent Motion: daily change in geocentric RA/DEC (finite difference).
function planetaryApparentMotion() {
	const a = vectorToEquatorial(geocentricDirection(mars, NOW))
	const tomorrow = timeYMDHMS(2026, 6, 30, 0, 0, 0, Timescale.UTC)
	const b = vectorToEquatorial(geocentricDirection(mars, tomorrow))
	console.info('Mars daily motion ΔRA, ΔDEC (arcsec/day):', toArcsec(eraAnpm(b[0] - a[0])), toArcsec(b[1] - a[1]))
}

// Planetary Stationary Point: the apparent geocentric RA rate changes sign. The daily
// RA change (wrap-safe via eraAnpm) is scanned over the next ~14 months and the sign
// changes are refined with searchRoots.
function planetaryStationaryPoint() {
	const half = 0.5 // central-difference half-step (days)
	const raRate = (time: Time) => {
		const before = vectorToEquatorial(geocentricDirection(mars, timeShift(time, -half)))[0]
		const after = vectorToEquatorial(geocentricDirection(mars, timeShift(time, half)))[0]
		return eraAnpm(after - before)
	}
	const stationary = searchRoots(raRate, NOW, timeShift(NOW, 420), { step: 5 })
	console.info('Mars stationary points (local):', stationary.length > 0 ? stationary.map((t) => formatTemporal(temporalFromTime(utc(t)))).join(', ') : 'none in the next 420 days')
}

// Planetary Greatest Elongation: the maxima of the Sun-Earth-planet elongation over a
// synodic period, found with searchExtrema (for the inner planets).
function planetaryGreatestElongation() {
	const maxima = searchExtrema((time) => elongationAt(venus, time), NOW, timeShift(NOW, 584), { step: 5 }).filter((e) => e.kind === 'maximum')
	console.info('Venus greatest elongations:', maxima.map((e) => `${toDeg(e.value).toFixed(1)}deg @ ${formatTemporal(temporalFromTime(utc(e.time)))}`).join('; ') || 'none in the next synodic period')
}

// Planetary Opposition / Conjunction: opposition is the elongation maximum (~180deg)
// for an outer planet, conjunction its minimum; both are extrema of the elongation.
function planetaryOpposition() {
	const opposition = searchExtrema((time) => elongationAt(mars, time), NOW, timeShift(NOW, 800), { step: 5 }).find((e) => e.kind === 'maximum')
	console.info('Mars opposition (local):', opposition ? `${formatTemporal(temporalFromTime(utc(opposition.time)))} (elongation ${toDeg(opposition.value).toFixed(1)}deg)` : 'none in the next synodic period')
}

function planetaryConjunction() {
	const conjunction = searchExtrema((time) => elongationAt(mars, time), NOW, timeShift(NOW, 800), { step: 5 }).find((e) => e.kind === 'minimum')
	console.info('Mars conjunction (local):', conjunction ? `${formatTemporal(temporalFromTime(utc(conjunction.time)))} (elongation ${toDeg(conjunction.value).toFixed(1)}deg)` : 'none in the next synodic period')
}

// Planetary Quadrature: the instants an outer planet's Sun-Earth-planet elongation passes through 90deg,
// found by root-finding elongationAt - PI/2 over a synodic period. Each crossing is labelled east or west
// from the sign of the geocentric ecliptic longitude difference planet - Sun: a planet east of the Sun is
// at east (evening) quadrature, one west of it at west (morning) quadrature.
function planetaryQuadrature() {
	const quadratures = searchRoots((time) => elongationAt(mars, time) - PIOVERTWO, NOW, timeShift(NOW, 800), { step: 5 })
	if (quadratures.length === 0) return console.info('Mars quadratures: none in the next synodic period.')
	const labelled = quadratures.map((time) => {
		const planetEq = vectorToEquatorial(geocentricDirection(mars, time))
		const [planetLon] = equatorialToEcliptic(planetEq[0], planetEq[1], time)
		const sunEq = sunEquatorial(time)
		const [sunLon] = equatorialToEcliptic(sunEq[0], sunEq[1], time)
		const side = normalizePI(planetLon - sunLon) > 0 ? 'east' : 'west'
		return `${side} ${formatTemporal(temporalFromTime(utc(time)))}`
	})
	console.info('Mars quadratures (local):', labelled.join('; '))
}

// Planetary Closest Geocentric Approach: the minimum of the geocentric distance over a synodic period,
// reached near opposition for an outer planet. The largest apparent disk is the same extremum reexpressed,
// since the apparent diameter is the physical diameter over that minimum distance; it is reported here from
// objectAngularDiameter at the closest-approach instant rather than scanned separately.
function planetaryClosestApproach() {
	const MARS_DIAMETER_KM = 6779
	const minimum = searchExtrema((time) => vectorDistance(geocentricDirection(mars, time)), NOW, timeShift(NOW, 800), { step: 5 }).find((e) => e.kind === 'minimum')
	if (minimum === undefined) return console.info('Mars closest approach: no distance minimum in the next synodic period.')
	const diameter = objectAngularDiameter(MARS_DIAMETER_KM, toKilometer(minimum.value))
	console.info('Mars closest approach (local):', formatTemporal(temporalFromTime(utc(minimum.time))), `distance ${minimum.value.toFixed(4)} AU, apparent diameter ${toArcsec(diameter).toFixed(1)} arcsec`)
}

// Inferior / Superior Conjunction (inner planets): the elongation minima, classified by
// whether the planet is nearer than the Sun (inferior) or beyond it (superior).
function inferiorConjunction() {
	const minima = searchExtrema((time) => elongationAt(venus, time), NOW, timeShift(NOW, 584), { step: 5 }).filter((e) => e.kind === 'minimum')
	const inferior = minima.find((e) => vectorDistance(geocentricDirection(venus, e.time)) < 1)
	console.info('Venus inferior conjunction (local):', inferior ? formatTemporal(temporalFromTime(utc(inferior.time))) : 'none in the next synodic period')
}

function superiorConjunction() {
	const minima = searchExtrema((time) => elongationAt(venus, time), NOW, timeShift(NOW, 584), { step: 5 }).filter((e) => e.kind === 'minimum')
	const superior = minima.find((e) => vectorDistance(geocentricDirection(venus, e.time)) > 1)
	console.info('Venus superior conjunction (local):', superior ? formatTemporal(temporalFromTime(utc(superior.time))) : 'none in the next synodic period')
}

// Perihelion and Aphelion: osculating apsis distances from the heliocentric state.
function perihelionAndAphelion() {
	const [bp, bv] = mars(NOW)
	const [sp, sv] = sun(NOW)
	const orbit = new KeplerOrbit(vecMinus(bp, sp), vecMinus(bv, sv), NOW)
	console.info('Mars perihelion/aphelion (AU):', orbit.periapsisDistance, orbit.apoapsisDistance)
}

// Ascending and Descending Node: longitude of the ascending node of the orbit.
function ascendingAndDescendingNode() {
	const [bp, bv] = mars(NOW)
	const [sp, sv] = sun(NOW)
	const orbit = new KeplerOrbit(vecMinus(bp, sp), vecMinus(bv, sv), NOW)
	console.info('Mars ascending node longitude (deg):', toDeg(normalizeAngle(orbit.longitudeOfAscendingNode)))
}

// Planetary Central Meridian: the sub-observer longitude from the IAU rotation model.
// subObserverPoint returns planetocentric east longitude; the System III longitude that
// observers quote increases westward, so it is 360deg minus the east value.
function planetaryCentralMeridian() {
	const sub = bodySubObserver(JUPITER_ROTATION, NOW, vecMinus(earth(NOW)[0], jupiter(NOW)[0]))
	console.info('Jupiter central meridian System III (deg, west):', toDeg(normalizeAngle(-sub.longitude)).toFixed(2))
}

// Sub-Observer Point / Sub-Solar Point: the body-fixed longitude/latitude beneath the
// observer and beneath the Sun, from the IAU rotation model (light-time corrected).
function subObserverPoint() {
	const o = bodySubObserver(MARS_ROTATION, NOW, vecMinus(earth(NOW)[0], mars(NOW)[0]))
	console.info('Mars sub-observer (east lon, lat deg):', toDeg(o.longitude).toFixed(2), toDeg(o.latitude).toFixed(2))
}

function subSolarPoint() {
	const s = bodySubSolar(MARS_ROTATION, NOW, vecMinus(earth(NOW)[0], mars(NOW)[0]), vecMinus(sun(NOW)[0], mars(NOW)[0]))
	console.info('Mars sub-solar (east lon, lat deg):', toDeg(s.longitude).toFixed(2), toDeg(s.latitude).toFixed(2))
}

// Saturn Ring Opening Angle: the ring tilt B equals the sub-Earth planetocentric
// latitude in Saturn's body frame (negative when the south face is toward the Earth).
function saturnRingOpeningAngle() {
	const b = bodySubObserver(SATURN_ROTATION, NOW, vecMinus(earth(NOW)[0], saturn(NOW)[0]))
	console.info('Saturn ring opening angle B (deg):', toDeg(b.latitude).toFixed(3))
}

// Saturn Ring Orientation: how the ring plane is tilted on the sky. The rings lie in Saturn's equator, so
// their axis is the planet's north pole; positionAngleOfPole gives that pole's position angle from
// celestial north through east, which is the orientation of the rings' minor axis (the major axis lies
// 90deg from it). Together with the opening angle B this fixes the projected ellipse of the rings.
function saturnRingOrientation() {
	const toEarth = vecMinus(earth(NOW)[0], saturn(NOW)[0])
	const p = positionAngleOfPole(SATURN_ROTATION, NOW, toEarth)
	console.info('Saturn north-pole position angle (deg):', toDeg(normalizeAngle(p)).toFixed(2))
}

// Jupiter Great Red Spot Transit: jupiterCentralMeridian gives the System II central meridian and
// greatRedSpotTransits finds when the spot (at its observed System II longitude, supplied by the caller
// from the ALPO/JUPOS bulletins) crosses it.
function jupiterGreatRedSpotTransit() {
	const jupiterToObserver = (time: Time) => vecMinus(earth(time)[0], jupiter(time)[0])
	const grsLongitude = deg(52) // observed System II longitude of the Great Red Spot
	const cm = toDeg(jupiterCentralMeridian('II', NOW, jupiterToObserver(NOW)))
	const [next] = greatRedSpotTransits(grsLongitude, jupiterToObserver, NOW, timeShift(NOW, 1))
	console.info('Jupiter System II central meridian (deg):', cm, 'next GRS transit:', formatTemporal(temporalFromTime(next)))
}

// ##### Sun and Moon helpers #####

// Geocentric direction toward the Sun (AU).
function geocentricSun(time: Time = NOW) {
	return vecMinus(sun(time)[0], earth(time)[0])
}

// Apparent geocentric equatorial coordinates of the Sun.
function sunEquatorial(time: Time = NOW) {
	return vectorToEquatorial(geocentricSun(time))
}

// Apparent geocentric equatorial coordinates of the Moon.
function moonEquatorial(time: Time = NOW) {
	return vectorToEquatorial(moonGeocentric(time)[0])
}

// ##### Sun and Moon #####

// Apparent Solar Position: geocentric apparent RA/DEC of the Sun.
function apparentSolarPosition() {
	const eq = sunEquatorial()
	console.info('Sun apparent RA/DEC:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]))
}

// Solar Altitude and Azimuth (topocentric horizon coordinates).
function solarAltitudeAndAzimuth() {
	const eq = sunEquatorial()
	const lst = localSiderealTime(NOW, SITE, false)
	const [az, alt] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, normalizeAngle(lst - eq[0]) + eq[0])
	console.info('Sun Az/Alt:', formatAZ(az), formatSignedDMS(alt))
}

// Solar Equation of Time: apparent minus mean solar time, at Greenwich.
function solarEquationOfTime() {
	// equationOfTime needs the apparent RA of date (true equinox), so precess and
	// nutate the ICRS Sun direction to the epoch of date first.
	const eq = sunEquatorial()
	const [raOfDate] = equatorialFromJ2000(eq[0], eq[1], NOW)
	const eot = equationOfTime(NOW, raOfDate)
	console.info('Equation of time (minutes):', toDeg(eot) * 4)
}

// Solar Declination.
function solarDeclination() {
	console.info('Sun declination (deg):', toDeg(sunEquatorial()[1]))
}

// Solar Hour Angle at the observer.
function solarHourAngle() {
	const ha = normalizePI(localSiderealTime(NOW, SITE, false) - sunEquatorial()[0])
	console.info('Sun hour angle (hours):', toHour(ha))
}

// Solar Noon: instant of the Sun's upper transit (HA = 0), found as the altitude
// maximum by the rise/transit/set finder.
function solarNoon() {
	const transit = riseTransitSet(geocentricSun, SITE, NOW, { horizon: SUN_HORIZON }).transit
	console.info('Solar noon (local):', transit ? formatTemporal(temporalFromTime(utc(transit))) : 'no transit in the window')
}

// Solar Disk Orientation (P, B0, L0): the position angle of the rotation axis and the
// heliographic latitude/longitude of the disk centre, from the IAU solar rotation model.
// The Sun's IAU prime meridian is the Carrington meridian, so the sub-observer longitude
// is L0 directly and the sub-observer latitude is B0.
function solarDiskOrientation() {
	const toEarth = vecMinus(earth(NOW)[0], sun(NOW)[0])
	const disk = bodySubObserver(SUN_ROTATION, NOW, toEarth)
	const p = positionAngleOfPole(SUN_ROTATION, NOW, toEarth)
	console.info('Solar disk orientation P, B0, L0 (deg):', toDeg(p).toFixed(2), toDeg(disk.latitude).toFixed(2), toDeg(disk.longitude).toFixed(2))
}

// Carrington Rotation Number.
function carringtonRotationNumberComputation() {
	console.info('Carrington rotation number:', carringtonRotationNumber(NOW))
}

// Solar Analemma Point: the (equation-of-time, declination) pair for the day.
function solarAnalemmaPoint() {
	const eq = sunEquatorial()
	const eot = normalizePI(greenwichApparentSiderealTime(NOW) - eq[0] - utc(NOW).fraction * TAU)
	console.info('Analemma point (EoT minutes, declination deg):', toDeg(eot) * 4, toDeg(eq[1]))
}

// Solar Shadow Length: gnomon shadow length = height / tan(solar altitude).
function solarShadowLength() {
	const eq = sunEquatorial()
	const ha = normalizePI(localSiderealTime(NOW, SITE, false) - eq[0])
	const [, alt] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, ha + eq[0])
	console.info('Shadow length of a 1 m gnomon (m):', alt > 0 ? 1 / Math.tan(alt) : 'Sun below horizon')
}

// Solar Shadow Direction: opposite the Sun's azimuth.
function solarShadowDirection() {
	const eq = sunEquatorial()
	const lst = localSiderealTime(NOW, SITE, false)
	const [az] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, normalizeAngle(lst - eq[0]) + eq[0])
	console.info('Shadow direction azimuth (deg):', toDeg(normalizeAngle(az + PI)))
}

// Earth Perihelion and Aphelion: the extrema of the Earth-Sun distance over the next
// year. The distance minimum is perihelion, the maximum is aphelion.
function earthPerihelionAndAphelion() {
	const helioDistance = (time: Time) => vecLength(vecMinus(earth(time)[0], sun(time)[0]))
	for (const e of searchExtrema(helioDistance, NOW, timeShift(NOW, 366), { step: 5 })) {
		const label = e.kind === 'minimum' ? 'perihelion' : 'aphelion'
		console.info(`Earth ${label} (local):`, formatTemporal(temporalFromTime(utc(e.time))), 'distance (AU):', e.value.toFixed(6))
	}
}

// Equinox and Solstice Times.
function equinoxAndSolsticeTimes() {
	const t = season(2026, 'winter')
	console.info('2026 December solstice:', formatTemporal(temporalFromTime(t)))
}

// Lunar Geocentric Position: apparent RA/DEC and geocentric distance.
function lunarGeocentricPosition() {
	const eq = moonEquatorial()
	console.info('Moon RA/DEC:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]), 'distance (km):', toKilometer(vecLength(moonGeocentric(NOW)[0])))
}

// Lunar Topocentric Position: geocentric coordinates corrected for parallax in altitude.
function lunarTopocentricPosition() {
	const eq = moonEquatorial()
	const lst = localSiderealTime(NOW, SITE, false)
	const [az, geoAlt] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, normalizeAngle(lst - eq[0]) + eq[0])
	const parallax = moonParallax(vecLength(moonGeocentric(NOW)[0]))
	const topoAlt = geoAlt - parallax * Math.cos(geoAlt)
	console.info('Moon topocentric Az/Alt:', formatAZ(az), formatSignedDMS(topoAlt))
}

// Lunar Altitude and Azimuth (geocentric horizon coordinates).
function lunarAltitudeAndAzimuth() {
	const eq = moonEquatorial()
	const lst = localSiderealTime(NOW, SITE, false)
	const [az, alt] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, normalizeAngle(lst - eq[0]) + eq[0])
	console.info('Moon Az/Alt:', formatAZ(az), formatSignedDMS(alt))
}

// Sun-Moon-Earth phase angle at the Moon (radians).
function computeLunarPhaseAngle(time: Time = NOW) {
	const m = moonGeocentric(time)[0]
	const s = geocentricSun(time)
	return vecAngle(vecMulScalar(m, -1), vecMinus(s, m))
}

// Lunar Phase Angle.
function lunarPhaseAngle() {
	console.info('Moon phase angle (deg):', toDeg(computeLunarPhaseAngle()))
}

// Lunar Illuminated Fraction (Meeus).
function lunarIlluminatedFraction() {
	console.info('Moon illuminated fraction:', Meeus.illuminated(computeLunarPhaseAngle()))
}

// Lunar Age: days elapsed since the previous new moon.
function lunarAge() {
	const lastNew = nearestLunarPhase(NOW, 'NEW', false)
	console.info('Moon age (days):', timeSubtract(tt(NOW), tt(lastNew)))
}

// Lunar Phase Name: derived from elongation and the waxing/waning sense.
// NOTE: nearestLunarPhase finds phase instants but does not name the current phase.
// We classify here from elongation and the Sun-Moon RA order.
function lunarPhaseName() {
	const sunEq = sunEquatorial()
	const moonEq = moonEquatorial()
	const elong = toDeg(separationFrom(geocentricSun(), moonGeocentric(NOW)[0]))
	const waxing = normalizeAngle(moonEq[0] - sunEq[0]) < PI
	let name = 'New'
	if (elong > 170) name = 'Full'
	else if (elong > 100) name = waxing ? 'Waxing Gibbous' : 'Waning Gibbous'
	else if (elong > 80) name = waxing ? 'First Quarter' : 'Last Quarter'
	else if (elong > 10) name = waxing ? 'Waxing Crescent' : 'Waning Crescent'
	console.info('Moon phase name:', name, `(elongation ${elong.toFixed(1)}deg)`)
}

// Lunar Bright Limb Position Angle (Meeus).
function lunarBrightLimbPositionAngle() {
	const s = sunEquatorial()
	const m = moonEquatorial()
	console.info('Bright limb position angle (deg):', toDeg(normalizeAngle(Meeus.limb(m[0], m[1], s[0], s[1]))))
}

// Lunar Angular Diameter: 2 * semidiameter at the current distance.
function lunarAngularDiameter() {
	const sd = moonSemidiameter(vecLength(moonGeocentric(NOW)[0]))
	console.info('Moon angular diameter (arcmin):', toArcsec(2 * sd) / 60)
}

// Lunar Horizontal Parallax.
function lunarHorizontalParallax() {
	console.info('Moon horizontal parallax (arcmin):', toArcsec(moonParallax(vecLength(moonGeocentric(NOW)[0]))) / 60)
}

// Geocentric direction from the Moon centre to the Earth (AU): the Moon's geocentric
// position negated, which feeds the lunar sub-observer/libration geometry.
function moonToEarth(time: Time = NOW) {
	return vecMulScalar(moonGeocentric(time)[0], -1)
}

// Geocentric direction from the Moon centre to the Sun (AU).
function moonToSun(time: Time = NOW) {
	return vecMinus(geocentricSun(time), moonGeocentric(time)[0])
}

// Lunar Libration: the selenographic longitude/latitude of the sub-Earth point (the
// optical+physical libration in longitude l and latitude b) and the position angle of
// the lunar axis P, from the IAU lunar rotation model.
function lunarLibration() {
	const toEarth = moonToEarth()
	const disk = bodySubObserver(MOON_ROTATION, NOW, toEarth)
	const p = positionAngleOfPole(MOON_ROTATION, NOW, toEarth)
	console.info('Lunar libration l, b, P (deg):', toDeg(normalizePI(disk.longitude)).toFixed(2), toDeg(disk.latitude).toFixed(2), toDeg(p).toFixed(2))
}

// Lunar Libration Extremes: the greatest tilts of the disc over a month, when a limb is best presented.
// searchExtrema scans the sub-Earth libration in longitude l and latitude b separately; l is wrapped to
// -PI..PI first so the small (+/-8deg) swing stays continuous across the 0/TAU seam and does not fool the
// extremum finder. The longitude maxima/minima expose the east/west limbs, the latitude ones the north/
// south limbs.
function lunarLibrationExtremes() {
	const stop = timeShift(NOW, 28)
	const librationLongitude = (time: Time) => normalizePI(bodySubObserver(MOON_ROTATION, time, moonToEarth(time)).longitude)
	const librationLatitude = (time: Time) => bodySubObserver(MOON_ROTATION, time, moonToEarth(time)).latitude
	const describe = (e: { value: Angle; time: Time }) => `${toDeg(e.value).toFixed(2)}deg @ ${formatTemporal(temporalFromTime(utc(e.time)))}`
	const lonExtrema = searchExtrema(librationLongitude, NOW, stop, { step: 1 })
	const latExtrema = searchExtrema(librationLatitude, NOW, stop, { step: 1 })
	console.info('Lunar libration longitude extremes (l):', lonExtrema.map(describe).join('; ') || 'none in the month')
	console.info('Lunar libration latitude extremes (b):', latExtrema.map(describe).join('; ') || 'none in the month')
}

// Lunar Colongitude: the selenographic colongitude of the Sun, 90deg minus the
// sub-solar selenographic longitude. It locates the morning terminator (0deg near first
// quarter, 90deg near full, 180deg near last quarter, 270deg near new).
function lunarColongitude() {
	const sub = bodySubSolar(MOON_ROTATION, NOW, moonToEarth(), moonToSun())
	console.info('Lunar (Sun) colongitude (deg):', toDeg(normalizeAngle(deg(90) - sub.longitude)).toFixed(2))
}

// Lunar Terminator Position: the morning terminator is the meridian 90deg west of the
// sub-solar point, i.e. its selenographic longitude equals the colongitude.
function lunarTerminatorPosition() {
	const sub = bodySubSolar(MOON_ROTATION, NOW, moonToEarth(), moonToSun())
	console.info('Lunar morning terminator selenographic longitude (deg):', toDeg(normalizeAngle(deg(90) - sub.longitude)).toFixed(2))
}

// Lunar Sunrise and Sunset at a Selenographic Point: the Sun's elevation above the local horizon at a
// surface feature crosses zero once upward (sunrise, the morning terminator reaching the feature) and once
// downward (sunset) per synodic month. The elevation is the sub-solar-point formula on a sphere,
// sin(alt) = sin(phi) sin(b) + cos(phi) cos(b) cos(lambda - l), where (l, b) is the sub-solar selenographic
// longitude/latitude from bodySubSolar and (lambda, phi) the feature's. The zero crossings are root-found
// over a lunation and labelled by the elevation's slope. Shown for the crater Copernicus (~9.62N, 20.08W;
// west longitude is negative in the east-positive selenographic convention).
function lunarSunriseSunsetAtFeature() {
	const featureLon = deg(-20.08)
	const featureLat = deg(9.62)
	const sinLat = Math.sin(featureLat)
	const cosLat = Math.cos(featureLat)
	const solarAltitude = (time: Time) => {
		const sub = bodySubSolar(MOON_ROTATION, time, moonToEarth(time), moonToSun(time))
		// Clamp guards asin against rounding just outside [-1, 1] near grazing illumination.
		const sinAlt = sinLat * Math.sin(sub.latitude) + cosLat * Math.cos(sub.latitude) * Math.cos(featureLon - sub.longitude)
		return Math.asin(Math.max(-1, Math.min(1, sinAlt)))
	}
	const crossings = searchRoots(solarAltitude, NOW, timeShift(NOW, 30), { step: 1 })
	if (crossings.length === 0) return console.info('Copernicus sunrise/sunset: no terminator crossing in the next lunation.')
	const labelled = crossings.map((time) => `${solarAltitude(timeShift(time, 0.05)) > solarAltitude(time) ? 'sunrise' : 'sunset'} ${formatTemporal(temporalFromTime(utc(time)))}`)
	console.info('Copernicus lunar sunrise/sunset (local):', labelled.join('; '))
}

// Lunar Sub-Solar / Sub-Observer Point (selenographic east longitude, latitude).
function lunarSubSolarPoint() {
	const sub = bodySubSolar(MOON_ROTATION, NOW, moonToEarth(), moonToSun())
	console.info('Lunar sub-solar (east lon, lat deg):', toDeg(sub.longitude).toFixed(2), toDeg(sub.latitude).toFixed(2))
}

function lunarSubObserverPoint() {
	const obs = bodySubObserver(MOON_ROTATION, NOW, moonToEarth())
	console.info('Lunar sub-observer (east lon, lat deg):', toDeg(obs.longitude).toFixed(2), toDeg(obs.latitude).toFixed(2))
}

// Lunar Ascending and Descending Nodes: a node passage is where the Moon's geocentric
// ecliptic latitude crosses zero; ascending when the latitude is increasing.
function lunarAscendingAndDescendingNodes() {
	const eclipticLatitude = (time: Time) => {
		const eq = vectorToEquatorial(moonGeocentric(time)[0])
		return equatorialToEcliptic(eq[0], eq[1], time)[1]
	}
	const nodes = searchRoots(eclipticLatitude, NOW, timeShift(NOW, 30), { step: 0.5 })
	const labelled = nodes.map((t) => `${eclipticLatitude(timeShift(t, 0.01)) > eclipticLatitude(t) ? 'ascending' : 'descending'} ${formatTemporal(temporalFromTime(utc(t)))}`)
	console.info('Lunar node passages (local):', labelled.join('; ') || 'none in the next 30 days')
}

// Lunar Perigee and Apogee.
function lunarPerigeeAndApogee() {
	const [perigeeTime, perigeeDistance] = nearestLunarApsis(NOW, 'PERIGEE', true)
	const [apogeeTime, apogeeDistance] = nearestLunarApsis(NOW, 'APOGEE', true)
	console.info('Next perigee:', formatTemporal(temporalFromTime(perigeeTime)), 'distance (km):', toKilometer(perigeeDistance))
	console.info('Next apogee:', formatTemporal(temporalFromTime(apogeeTime)), 'distance (km):', toKilometer(apogeeDistance))
}

// Lunar Standstill Extremes: the next major and minor standstills, when the Moon's monthly declination extreme
// reaches the largest (~28.6 deg) or smallest (~18.3 deg) amplitude of the 18.6-year nodal cycle.
function lunarStandstillExtremes() {
	const [majorTime, majorDec] = nearestLunarStandstill(NOW, 'MAJOR', 'NORTH', true)
	const [minorTime, minorDec] = nearestLunarStandstill(NOW, 'MINOR', 'NORTH', true)
	console.info('Next major standstill:', formatTemporal(temporalFromTime(majorTime)), 'northern declination (deg):', toDeg(majorDec))
	console.info('Next minor standstill:', formatTemporal(temporalFromTime(minorTime)), 'northern declination (deg):', toDeg(minorDec))
}

// Crescent Moon Width: angular width of the illuminated crescent at its midpoint.
function crescentMoonWidth() {
	const sd = moonSemidiameter(vecLength(moonGeocentric(NOW)[0]))
	const width = crescentWidth(sd, Meeus.illuminated(computeLunarPhaseAngle()))
	console.info('Crescent width (arcmin):', toArcsec(width) / 60)
}

// ##### Visibility and Almanac Events #####

// Object Rise / Set Time: the standard-horizon crossings from the rise/transit/set
// finder, reported as civil UTC instants.
function objectRiseTime() {
	const rise = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: STANDARD_HORIZON }).rise
	console.info('Sirius rise (local):', rise ? formatTemporal(temporalFromTime(utc(rise))) : 'does not rise in the window')
}

function objectSetTime() {
	const set = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: STANDARD_HORIZON }).set
	console.info('Sirius set (local):', set ? formatTemporal(temporalFromTime(utc(set))) : 'does not set in the window')
}

// Object Upper / Lower Transit: the upper culmination from the finder; the lower
// transit stays expressed as a local sidereal time (HA = 12h).
function objectUpperTransit() {
	const transit = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: STANDARD_HORIZON }).transit
	console.info('Sirius upper transit (local):', transit ? formatTemporal(temporalFromTime(utc(transit))) : 'no transit in the window')
}

function objectLowerTransit() {
	console.info('Lower transit at LST:', formatHMS(normalizeAngle(SIRIUS_RA + PI)))
}

// Object Maximum Altitude (altitude at upper transit).
function objectMaximumAltitude() {
	console.info('Maximum altitude (deg):', toDeg(altitudeAtTransit(SITE.latitude, SIRIUS_DEC)))
}

// Object Visibility Intervals: the above-horizon duration between rise and set.
function objectVisibilityIntervals() {
	const rts = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: STANDARD_HORIZON })
	if (rts.alwaysUp) return console.info('Sirius is circumpolar (above the horizon all day).')
	if (rts.alwaysDown) return console.info('Sirius never rises.')
	if (rts.rise && rts.set) console.info('Sirius time above horizon (hours):', (timeSubtract(tt(rts.set), tt(rts.rise)) * 24).toFixed(2))
	else console.info('Sirius rise/set straddles the window boundary.')
}

// Circumpolar Classification: always-up, always-down, or rising/setting.
function circumpolarClassification() {
	const lat = SITE.latitude
	let kind = 'rises and sets'
	if (SIRIUS_DEC > PIOVERTWO - Math.abs(lat) && lat > 0) kind = 'circumpolar (always up)'
	else if (SIRIUS_DEC < -(PIOVERTWO - Math.abs(lat)) && lat > 0) kind = 'never rises'
	else if (SIRIUS_DEC < -(PIOVERTWO - Math.abs(lat)) && lat < 0) kind = 'circumpolar (always up)'
	else if (SIRIUS_DEC > PIOVERTWO - Math.abs(lat) && lat < 0) kind = 'never rises'
	console.info('Circumpolar classification:', kind)
}

// Airmass Calculation.
function airmassCalculation() {
	const alt = altitudeAtTransit(SITE.latitude, SIRIUS_DEC)
	console.info('Airmass at transit (secant):', airmass(PIOVERTWO - alt), 'Kasten-Young:', airmassKastenYoung(alt))
}

// Airmass Time Series across hour angles around transit.
function airmassTimeSeries() {
	const series: number[] = []
	for (let h = -3; h <= 3; h++) {
		const ha = hour(h)
		const sinAlt = Math.sin(SITE.latitude) * Math.sin(SIRIUS_DEC) + Math.cos(SITE.latitude) * Math.cos(SIRIUS_DEC) * Math.cos(ha)
		series.push(sinAlt > 0 ? airmassKastenYoung(Math.asin(sinAlt)) : Number.POSITIVE_INFINITY)
	}
	console.info('Airmass at HA -3h..+3h:', series)
}

// Astronomical / Nautical / Civil Twilight: the Sun crossing -18deg, -12deg, -6deg.
// The rising crossing is dawn, the setting crossing is dusk.
function twilightReport(label: string, horizon: Angle) {
	const rts = riseTransitSet(geocentricSun, SITE, NOW, { horizon })
	const dawn = rts.rise ? formatTemporal(temporalFromTime(utc(rts.rise))) : 'none'
	const dusk = rts.set ? formatTemporal(temporalFromTime(utc(rts.set))) : 'none'
	console.info(`${label} dawn/dusk (local):`, dawn, '/', dusk)
}

function astronomicalTwilight() {
	twilightReport('Astronomical', ASTRONOMICAL_TWILIGHT)
}

function nauticalTwilight() {
	twilightReport('Nautical', NAUTICAL_TWILIGHT)
}

function civilTwilight() {
	twilightReport('Civil', CIVIL_TWILIGHT)
}

// Night Darkness Intervals: the fully-dark span between this evening's astronomical
// dusk and the next morning's astronomical dawn.
function nightDarknessIntervals() {
	const dusk = riseTransitSet(geocentricSun, SITE, NOW, { horizon: ASTRONOMICAL_TWILIGHT }).set
	const dawn = riseTransitSet(geocentricSun, SITE, timeShift(NOW, 1), { horizon: ASTRONOMICAL_TWILIGHT }).rise
	if (dusk && dawn) console.info('Astronomical night (local):', formatTemporal(temporalFromTime(utc(dusk))), '->', formatTemporal(temporalFromTime(utc(dawn))), `(${(timeSubtract(tt(dawn), tt(dusk)) * 24).toFixed(2)} h)`)
	else console.info('No astronomical night in the window (twilight all night).')
}

// Moonless Observation Windows: the dark window intersected with the Moon-down
// interval. Both rise/set pairs come from the same finder.
function moonlessObservationWindows() {
	const dusk = riseTransitSet(geocentricSun, SITE, NOW, { horizon: ASTRONOMICAL_TWILIGHT }).set
	const moon = riseTransitSet((time) => moonGeocentric(time)[0], SITE, NOW, { horizon: STANDARD_HORIZON })
	const moonSet = moon.set ? formatTemporal(temporalFromTime(utc(moon.set))) : moon.alwaysUp ? 'Moon up all day' : 'Moon down all day'
	console.info('Astronomical dusk (local):', dusk ? formatTemporal(temporalFromTime(utc(dusk))) : 'none', '; Moon set (local):', moonSet)
}

// Target Above Altitude Window: the time a target stays above a chosen altitude,
// found by using that altitude as the rise/set horizon.
function targetAboveAltitudeWindow() {
	const rts = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: deg(30) })
	if (rts.rise && rts.set) console.info('Sirius time above 30deg (hours):', (timeSubtract(tt(rts.set), tt(rts.rise)) * 24).toFixed(2))
	else console.info('Sirius above 30deg:', rts.alwaysUp ? 'all day' : 'never')
}

// Target Meridian Window.
// NOTE: the centered meridian window is +/- a chosen hour angle around the upper
// transit (LST = RA); shown here as the LST range for +/-1h.
function targetMeridianWindow() {
	console.info('Meridian +/-1h window LST:', formatHMS(normalizeAngle(SIRIUS_RA - hour(1))), '..', formatHMS(normalizeAngle(SIRIUS_RA + hour(1))))
}

// Target Moon Separation Window.
// NOTE: no dedicated helper; a window would scan the night with searchRoots and
// bracket where the separation exceeds a threshold. Here the current separation is
// shown.
function targetMoonSeparationWindow() {
	const sep = separationFrom(SIRIUS_ICRF, moonGeocentric(NOW)[0])
	console.info('Current target-Moon separation (deg):', toDeg(sep))
}

// Target Sun Separation Window.
function targetSunSeparationWindow() {
	const sep = separationFrom(SIRIUS_ICRF, geocentricSun())
	console.info('Current target-Sun separation (deg):', toDeg(sep))
}

// Target Airmass Window: the time a target spends below an airmass limit follows from
// the matching altitude threshold (airmass ~2 at altitude 30deg).
function targetAirmassWindow() {
	const rts = riseTransitSet(() => SIRIUS_ICRF, SITE, NOW, { horizon: deg(30) })
	if (rts.rise && rts.set) console.info('Sirius time below airmass ~2 (hours):', (timeSubtract(tt(rts.set), tt(rts.rise)) * 24).toFixed(2))
	else console.info('Sirius below airmass ~2:', rts.alwaysUp ? 'all day' : 'never')
}

// Heliacal Rising / Setting, Acronychal Rising, Cosmical Setting: heliacalPhases scans the year for the four
// classical first/last-visibility transitions of an object, testing the Sun's depression at each rise/set
// against an arc of vision (11 deg for a first-magnitude star). Here Sirius is screened from the site over a
// year; the coarse step keeps the day scan quick.
function heliacalPhaseEvents() {
	const phases = heliacalPhases(() => SIRIUS_ICRF, geocentricSun, SITE, NOW, timeShift(NOW, 366), { step: 1 / 6 })
	if (phases.length === 0) return console.info('Heliacal phases: Sirius shows no phase transitions from this site in the window.')
	for (const phase of phases) {
		console.info(`${phase.kind}:`, formatTemporal(temporalFromTime(utc(phase.time))), `(arc of vision ${toDeg(phase.arcusVisionis).toFixed(1)}deg)`)
	}
}

// Field Rotation Angle: the parallactic angle (alt-az field orientation).
function fieldRotationAngle() {
	const ha = normalizePI(localSiderealTime(NOW, SITE, false) - SIRIUS_RA)
	console.info('Field rotation (parallactic) angle (deg):', toDeg(parallacticAngle(ha, SIRIUS_DEC, SITE.latitude)))
}

// Field Rotation Rate at an alt-az mount (deg/hour).
function fieldRotationRate() {
	const lst = localSiderealTime(NOW, SITE, false)
	const [az, alt] = equatorialToHorizontal(SIRIUS_RA, SIRIUS_DEC, SITE.latitude, normalizeAngle(lst - SIRIUS_RA) + SIRIUS_RA)
	// Sidereal rate 15.041 deg/hr times cos(lat)cos(Az)/cos(Alt).
	const rate = (15.041 * (Math.cos(SITE.latitude) * Math.cos(az))) / Math.cos(alt)
	console.info('Field rotation rate (deg/hour):', rate)
}

// Parallactic Angle Time Series across hour angles.
function parallacticAngleTimeSeries() {
	const series: number[] = []
	for (let h = -3; h <= 3; h++) series.push(toDeg(parallacticAngle(hour(h), SIRIUS_DEC, SITE.latitude)))
	console.info('Parallactic angle at HA -3h..+3h (deg):', series)
}

// ##### Eclipses, Occultations, and Transits #####

// Solar Eclipse Classification: the type of the next solar eclipse.
function solarEclipseClassification() {
	const e = nearestSolarEclipse(NOW, true)
	console.info('Next solar eclipse:', timeToDate(e.maximalTime).slice(0, 3).join('-'), 'type:', e.type, 'magnitude:', e.magnitude.toFixed(3))
}

// Solar Eclipse Besselian Elements: the polynomial elements of the next eclipse.
function solarEclipseBesselianElements() {
	const e = nearestSolarEclipse(NOW, true)
	const pbe = computePolynomialBesselianElements(e.maximalTime, sunMoonPosition)
	console.info('Besselian t0 (JD), tanF1:', toJulianDay(pbe.time0), pbe.tanF1)
}

// Local Solar Eclipse Circumstances at the observer.
function localSolarEclipseCircumstances() {
	const e = nearestSolarEclipse(NOW, true)
	const pbe = computePolynomialBesselianElements(e.maximalTime, sunMoonPosition)
	const c = computeLocalSolarEclipseCircumstances(pbe, SITE.longitude, SITE.latitude, { sunMoonPosition })
	console.info('Local eclipse visibility:', c.visibility, 'max event present:', !!c.events.MAX)
}

// Solar Eclipse Central Line, Path Limits, Partial Limits, Path Width, Shadow
// Velocity, Maximum Duration, Sun Altitude.
// NOTE: the full path geometry (central line, north/south limits, rise/set curves)
// is produced by computeSolarEclipseMapGeometry; the greatest-eclipse circumstances
// (path width, central duration, Sun altitude) come from
// computeGreatestEclipseCircumstances. Per-item finders for shadow velocity and the
// partial limits are part of the same map module. We show the greatest-eclipse
// summary here.
function solarEclipsePathSummary() {
	const e = nearestSolarEclipse(NOW, true)
	const pbe = computePolynomialBesselianElements(e.maximalTime, sunMoonPosition)
	const greatest = computeGreatestEclipseCircumstances(pbe)
	if (greatest) console.info('Greatest eclipse Sun altitude (deg):', toDeg(greatest.sunAltitude), 'path width (km):', greatest.pathWidthKm)
	else console.info('Greatest eclipse: no central line (partial eclipse).')
}

// Lunar Eclipse Classification.
function lunarEclipseClassification() {
	const e = nearestLunarEclipse(NOW, true)
	console.info('Next lunar eclipse:', timeToDate(e.maximalTime).slice(0, 3).join('-'), 'type:', e.type, 'magnitude:', e.magnitude.toFixed(3))
}

// Local Lunar Eclipse Circumstances at the observer.
function localLunarEclipseCircumstances() {
	const e = nearestLunarEclipse(NOW, true)
	const c = computeLocalLunarEclipseCircumstances(e, SITE.longitude, SITE.latitude, sunMoonPosition)
	console.info('Local lunar eclipse visibility:', c.visibility.kind)
}

// Lunar Eclipse Magnitude (umbral/penumbral).
function lunarEclipseMagnitude() {
	console.info('Next lunar eclipse magnitude:', nearestLunarEclipse(NOW, true).magnitude.toFixed(3))
}

// Lunar Eclipse Moon Altitude at maximum, for the observer.
function lunarEclipseMoonAltitude() {
	const e = nearestLunarEclipse(NOW, true)
	const eq = moonEquatorial(e.maximalTime)
	const lst = localSiderealTime(e.maximalTime, SITE, false)
	const [, alt] = equatorialToHorizontal(eq[0], eq[1], SITE.latitude, normalizeAngle(lst - eq[0]) + eq[0])
	console.info('Moon altitude at eclipse maximum (deg):', toDeg(alt))
}

// Stellar / Asteroid Occultation Prediction: occultationCandidates scans the topocentric star-asteroid
// separation for the observer and flags the appulse as an occultation when it falls within the asteroid's
// angular radius (the per-site question, with no shadow-path geometry). The sample asteroid is screened
// against a star placed on its own mid-window line of sight, so the demonstration reports a real hit; in
// practice you pass a catalog star direction (proper-motion corrected). A stellar occultation by a minor
// body is the same computation seen from the star's side.
function asteroidOccultationPrediction() {
	const orbit = asteroidKeplerOrbit()
	// Barycentric samplers sharing one origin: asteroid = Sun + heliocentric state; observer = topocentric.
	const target = (time: Time): PositionAndVelocity => {
		const [sp, sv] = sun(time)
		const [hp, hv] = orbit.at(time)
		return [
			[sp[0] + hp[0], sp[1] + hp[1], sp[2] + hp[2]],
			[sv[0] + hv[0], sv[1] + hv[1], sv[2] + hv[2]],
		]
	}
	const observer = (time: Time): PositionAndVelocity => observerState(time, earth(time), SITE) as PositionAndVelocity
	const anchor = timeShift(NOW, 0.5)
	// Star on the asteroid's geometric line of sight at the anchor; screening without light time keeps the
	// synthetic star consistent, so the demonstration yields a real hit. Real use passes a catalog star with
	// the default light-time correction enabled.
	const star = vecMinus(target(anchor)[0], observer(anchor)[0])
	const ASTEROID_RADIUS = kilometer(470) // ~Ceres radius, AU
	const [event] = occultationCandidates(target, star, observer, NOW, timeShift(NOW, 1), { radius: ASTEROID_RADIUS, lightTimeIterations: 0, step: 300 / DAYSEC })
	if (event === undefined) return console.info('Asteroid occultation: no appulse in the window.')
	console.info('Asteroid occultation appulse: separation', toArcsec(event.separation).toFixed(3), 'arcsec; disk radius', toArcsec(event.angularRadius).toFixed(3), 'arcsec; occultation:', event.occultation, event.duration ? `(~${event.duration.toFixed(1)} s)` : '')
}

// Planetary / Mercury / Venus Transit Prediction: planetaryTransits scans the topocentric planet-Sun
// separation for the observer and root-finds the four contacts where it crosses the sum (exterior I/IV) and
// difference (interior II/III) of the angular radii, with the limb position angles and the I->IV duration.
// This is the per-site question, without any Besselian path engine. Windows are set at the actual transit
// dates: the next Mercury transit is 2032-11-13, the next Venus transit 2117-12-11.

// Screens one planetary transit from SITE and prints its circumstances (existence, exterior contacts, chord
// depth, and contact position angles).
function reportTransit(label: string, planet: PositionAndVelocityOverTime, planetRadiusKm: number, start: Time, stop: Time) {
	const observer = (time: Time): PositionAndVelocity => observerState(time, earth(time), SITE) as PositionAndVelocity
	const [transit] = planetaryTransits(planet, sun, observer, start, stop, { sunRadius: SUN_RADIUS_AU, planetRadius: kilometer(planetRadiusKm) })
	if (transit === undefined) return console.info(`${label}: no transit visible from the site in the window.`)
	const contact = (t?: Time) => (t ? formatTemporal(temporalFromTime(utc(t))) : 'outside window')
	const pa = (a?: Angle) => (a === undefined ? 'n/a' : `${toDeg(a).toFixed(1)}deg`)
	console.info(
		`${label}: ${transit.full ? 'full' : 'grazing'}; contact I`,
		contact(transit.exteriorIngress),
		'IV',
		contact(transit.exteriorEgress),
		`; min sep ${toArcsec(transit.minSeparation).toFixed(1)} arcsec; PA I/IV ${pa(transit.ingressPositionAngle)}/${pa(transit.egressPositionAngle)}`,
		transit.duration ? `; duration ${(transit.duration / 3600).toFixed(2)} h` : '',
	)
}

function planetaryTransitPrediction() {
	reportTransit('Mercury transit 2032-11-13', mercury, 2439.7, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC))
}

function mercuryTransitCircumstances() {
	reportTransit('Mercury transit circumstances', mercury, 2439.7, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC))
}

function venusTransitCircumstances() {
	reportTransit('Venus transit 2117-12-11', venus, 6051.8, timeYMDHMS(2117, 12, 10, 23, 0, 0, Timescale.UTC), timeYMDHMS(2117, 12, 11, 6, 0, 0, Timescale.UTC))
}

// Mutual Satellite Event: galileanMutualEvents and saturnianMutualEvents screen the Galilean and main
// Saturnian moon pairs for mutual occultations and eclipses over a window (here days in the 2026-2027
// Jupiter and 2025 Saturn mutual-event seasons).
function mutualSatelliteEvent() {
	const jovian = galileanMutualEvents(timeYMDHMS(2026, 12, 2, 0, 0, 0, Timescale.UTC), timeYMDHMS(2026, 12, 3, 0, 0, 0, Timescale.UTC))
	const [first] = jovian
	console.info('Galilean mutual events in the day:', jovian.length, first ? `(first: ${first.front} ${first.kind === 'occultation' ? 'occults' : 'eclipses'} ${first.back})` : '')

	const saturnian = saturnianMutualEvents(timeYMDHMS(2025, 3, 12, 0, 0, 0, Timescale.UTC), timeYMDHMS(2025, 3, 13, 0, 0, 0, Timescale.UTC))
	console.info('Saturnian mutual events in the day:', saturnian.length)
}

// ##### Orbits and Small Bodies #####

// A sample main-belt asteroid orbit (Ceres-like elements at J2000) reused below.
function asteroidKeplerOrbit() {
	return asteroid(2.7691651, 0.0760091, deg(10.59407), deg(80.30553), deg(73.597694), deg(95.989), timeJulianYear(2000, Timescale.TT))
}

// Keplerian Elements to State Vector.
function keplerianElementsToStateVector() {
	const [p, v] = asteroidKeplerOrbit().at(NOW)
	console.info('Heliocentric state (AU, AU/day):', p, v)
}

// State Vector to Keplerian Elements (osculating).
function stateVectorToKeplerianElements() {
	const [p, v] = asteroidKeplerOrbit().at(NOW)
	const orbit = new KeplerOrbit(p, v, NOW)
	console.info('a, e, i (AU, -, deg):', orbit.semiMajorAxis, orbit.eccentricity, toDeg(orbit.inclination))
}

// Mean Anomaly to Eccentric Anomaly (Kepler's equation), solved by eccentricAnomalyFromMean.
function meanAnomalyToEccentricAnomaly() {
	console.info('Eccentric anomaly E (deg):', toDeg(eccentricAnomalyFromMean(deg(120), 0.2)))
}

// Eccentric Anomaly to True Anomaly.
function eccentricAnomalyToTrueAnomaly() {
	console.info('True anomaly (deg):', toDeg(trueAnomalyClosed(0.2, deg(125))))
}

// Hyperbolic Anomaly Solution (true anomaly from the hyperbolic anomaly).
function hyperbolicAnomalySolution() {
	console.info('Hyperbolic true anomaly (deg):', toDeg(trueAnomalyHyperbolic(1.5, 0.8)))
}

// Universal Variable Propagation.
// NOTE: KeplerOrbit.at() propagates using the universal-variable / Stumpff
// formulation internally; stumpff() is exported for the Stumpff functions. We
// propagate the sample orbit 100 days as the demonstration.
function universalVariablePropagation() {
	const orbit = asteroidKeplerOrbit()
	const [p] = orbit.at(timeYMDHMS(2026, 10, 7, 0, 0, 0, Timescale.TT))
	console.info('Propagated heliocentric distance after ~100 d (AU):', vecLength(p))
}

// Two-Body Orbit Propagation (state at a later epoch).
function twoBodyOrbitPropagation() {
	const [p, v] = asteroidKeplerOrbit().at(timeJulianYear(2030, Timescale.TT))
	console.info('State at 2030 (AU, AU/day):', vecLength(p), vecLength(v))
}

// Orbital Period.
function orbitalPeriod() {
	console.info('Orbital period (years):', period(2.7691651, GM_SUN_PITJEVA_2005) / 365.25)
}

// Mean Motion.
function meanMotionComputation() {
	console.info('Mean motion (deg/day):', toDeg(meanMotion(2.7691651, GM_SUN_PITJEVA_2005)))
}

// Periapsis and Apoapsis Distance.
function periapsisAndApoapsisDistance() {
	const orbit = asteroidKeplerOrbit()
	console.info('Periapsis/apoapsis (AU):', orbit.periapsisDistance, orbit.apoapsisDistance)
}

// Orbital Energy: specific orbital energy = -mu / (2a).
function orbitalEnergy() {
	const energy = -GM_SUN_PITJEVA_2005 / (2 * 2.7691651)
	console.info('Specific orbital energy (AU^2/day^2):', energy)
}

// Semi-major axes (AU) of the Earth and Mars orbits, reused by the synodic-period and Hill-sphere demos.
const EARTH_SEMI_MAJOR_AXIS = 1.00000011
const MARS_SEMI_MAJOR_AXIS = 1.52371034

// Synodic Period: the time between successive identical Sun-Earth-planet configurations (e.g. oppositions),
// from the sidereal periods via 1 / S = |1/P1 - 1/P2|. Here the Earth and Mars sidereal periods come from
// their semi-major axes through period(); the ~780 d result matches the spacing of the opposition scans.
function synodicPeriodComputation() {
	const earthPeriod = period(EARTH_SEMI_MAJOR_AXIS, GM_SUN_PITJEVA_2005)
	const marsPeriod = period(MARS_SEMI_MAJOR_AXIS, GM_SUN_PITJEVA_2005)
	const synodic = 1 / Math.abs(1 / earthPeriod - 1 / marsPeriod)
	console.info('Earth-Mars synodic period (days):', synodic.toFixed(1))
}

// Orbital Resonance: whether two orbits are locked in a small-integer mean-motion ratio. The outer/inner
// period ratio is matched against every reduced fraction p/q up to a small order, and the closest one
// within a tolerance is reported as the resonance. Neptune and Pluto sit near a 3:2 mean-motion resonance:
// Pluto completes 2 orbits for every 3 of Neptune, so its period ratio is close to 3/2.
function orbitalResonance() {
	const NEPTUNE_SEMI_MAJOR_AXIS = 30.06992 // AU
	const PLUTO_SEMI_MAJOR_AXIS = 39.48211 // AU
	const ratio = period(PLUTO_SEMI_MAJOR_AXIS, GM_SUN_PITJEVA_2005) / period(NEPTUNE_SEMI_MAJOR_AXIS, GM_SUN_PITJEVA_2005)

	// Greatest common divisor, used to keep only reduced fractions in the search.
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

	// Scan reduced p/q up to MAX_ORDER for the best match to the period ratio (p >= q since the ratio > 1).
	const MAX_ORDER = 6
	let best: { p: number; q: number; error: number } | undefined
	for (let q = 1; q <= MAX_ORDER; q++) {
		for (let p = q; p <= MAX_ORDER; p++) {
			if (gcd(p, q) !== 1) continue
			const error = Math.abs(ratio - p / q)
			if (best === undefined || error < best.error) best = { p, q, error }
		}
	}

	// Accept the match only when it is within 2% of an exact resonance.
	const resonance = best !== undefined && best.error / (best.p / best.q) < 0.02 ? `${best.p}:${best.q}` : 'no low-order resonance'
	console.info('Neptune-Pluto period ratio:', ratio.toFixed(4), 'nearest resonance:', resonance, best ? `(mismatch ${((best.error / (best.p / best.q)) * 100).toFixed(1)}%)` : '')
}

// Escape Velocity: the speed needed to reach infinity from a spherical body, v = sqrt(2 mu / r). Evaluated
// at the Earth's surface with the Earth GM (km^3/s^2) and radius (km), so the result is km/s directly.
function escapeVelocityComputation() {
	const v = Math.sqrt((2 * GM_EARTH_KM3_S2) / EARTH_RADIUS_KM)
	console.info('Earth surface escape velocity (km/s):', v.toFixed(3))
}

// Hill Sphere Radius: the region where a body's gravity dominates the primary's tide, r_H = a (1 - e)
// (m / 3M)^(1/3). The mass ratio m/M equals the GM ratio; the Earth-about-Sun value is ~0.0098 AU
// (~1.5 million km), comfortably enclosing the Moon's orbit.
function hillSphereRadius() {
	const EARTH_ECCENTRICITY = 0.01671
	const hill = EARTH_SEMI_MAJOR_AXIS * (1 - EARTH_ECCENTRICITY) * Math.cbrt(GM_EARTH / GM_SUN_PITJEVA_2005 / 3)
	console.info('Earth Hill sphere radius (AU):', hill.toFixed(5), '(km):', toKilometer(hill).toFixed(0))
}

// Roche Limit: the distance inside which a fluid satellite is torn apart by tides, d = 2.44 R_primary
// (rho_primary / rho_satellite)^(1/3). Shown for the Earth-Moon densities; the ~18400 km result is well
// inside the Moon's actual orbit, so the Moon is safe.
function rocheLimitComputation() {
	const EARTH_DENSITY = 5514 // kg/m^3
	const MOON_DENSITY = 3344 // kg/m^3
	const roche = 2.44 * EARTH_RADIUS_KM * Math.cbrt(EARTH_DENSITY / MOON_DENSITY)
	console.info('Earth-Moon fluid Roche limit (km):', roche.toFixed(0))
}

// Angular Momentum Vector: h = r x v.
function angularMomentumVector() {
	const [p, v] = asteroidKeplerOrbit().at(NOW)
	console.info('Specific angular momentum vector (AU^2/day):', vecCross(p, v))
}

// Orbit Classification by eccentricity.
function orbitClassification() {
	const e = new KeplerOrbit(...asteroidKeplerOrbit().at(NOW), NOW).eccentricity
	const kind = e < 1e-8 ? 'circular' : e < 1 ? 'elliptical' : e === 1 ? 'parabolic' : 'hyperbolic'
	console.info('Orbit classification:', kind, `(e=${e.toFixed(4)})`)
}

// Osculating Elements: full set from the instantaneous state.
function osculatingElements() {
	const orbit = new KeplerOrbit(...asteroidKeplerOrbit().at(NOW), NOW)
	console.info('Osculating: a, e, i, Omega, w, M (deg):', orbit.semiMajorAxis, orbit.eccentricity, toDeg(orbit.inclination), toDeg(normalizeAngle(orbit.longitudeOfAscendingNode)), toDeg(normalizeAngle(orbit.argumentOfPeriapsis)), toDeg(normalizeAngle(orbit.meanAnomaly)))
}

// Heliocentric Minor Body Position.
function heliocentricMinorBodyPosition() {
	const eq = vectorToEquatorial(asteroidKeplerOrbit().at(NOW)[0])
	console.info('Heliocentric RA/DEC of asteroid:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]))
}

// Geocentric Minor Body Position: helio position + (Sun - Earth) offset.
function geocentricMinorBodyPosition() {
	// Heliocentric body position plus the Sun's geocentric position (Sun - Earth).
	const helio = asteroidKeplerOrbit().at(NOW)[0]
	const geocentric = vecMinus(helio, vecMinus(earth(NOW)[0], sun(NOW)[0]))
	const eq = vectorToEquatorial(geocentric)
	console.info('Geocentric RA/DEC of asteroid:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]))
}

function cometKeplerOrbit() {
	// 1P/Halley-like elements (q, e, i, node, argp, epoch).
	return comet(0.586, 0.967, deg(162.26), deg(58.42), deg(111.33), timeJulianYear(1994, Timescale.TT))
}

// Apparent Comet Position (geocentric apparent RA/DEC of a sample comet).
function apparentCometPosition() {
	const geocentric = vecMinus(cometKeplerOrbit().at(NOW)[0], vecMinus(earth(NOW)[0], sun(NOW)[0]))
	const eq = vectorToEquatorial(geocentric)
	console.info('Comet geocentric RA/DEC:', formatHMS(normalizeAngle(eq[0])), formatSignedDMS(eq[1]))
}

// Comet Solar Elongation.
function cometSolarElongation() {
	const helio = cometKeplerOrbit().at(NOW)[0]
	const geocentric = vecMinus(helio, vecMinus(earth(NOW)[0], sun(NOW)[0]))
	console.info('Comet solar elongation (deg):', toDeg(separationFrom(geocentricSun(), geocentric)))
}

// Comet Magnitude Estimate.
function cometMagnitudeEstimation() {
	const helio = cometKeplerOrbit().at(NOW)[0]
	const r = vecLength(helio)
	const geocentric = vecMinus(helio, vecMinus(earth(NOW)[0], sun(NOW)[0]))
	const delta = vecLength(geocentric)
	console.info('Comet magnitude (H=5.5, k=10):', cometMagnitudeEstimate(5.5, delta, r, 10))
}

// Asteroid Phase Angle: Sun-asteroid-Earth angle.
function asteroidPhaseAngle() {
	const helio = asteroidKeplerOrbit().at(NOW)[0]
	const earthHelio = vecMinus(earth(NOW)[0], sun(NOW)[0])
	const astToSun = vecMulScalar(helio, -1)
	const astToEarth = vecMinus(earthHelio, helio)
	console.info('Asteroid phase angle (deg):', toDeg(vecAngle(astToSun, astToEarth)))
}

// Asteroid Magnitude Estimate (H-G system).
function asteroidMagnitudeEstimation() {
	const helio = asteroidKeplerOrbit().at(NOW)[0]
	const r = vecLength(helio)
	const geocentric = vecMinus(helio, vecMinus(earth(NOW)[0], sun(NOW)[0]))
	const delta = vecLength(geocentric)
	console.info('Asteroid magnitude (H=3.4):', asteroidMagnitudeEstimate(3.4, r, delta, 0))
}

// Minor Planet Closest Approach.
// NOTE: the SBD adapter exposes closeApproaches() (network); there is no local
// close-approach propagator, so this is network-backed rather than an offline scan.
function minorPlanetClosestApproach() {
	console.info('Minor planet closest approach: use the SBD closeApproaches() endpoint (network); no local propagator.')
}

// Minimum Orbit Intersection Distance (MOID): moid minimizes the inter-orbit distance over both true
// anomalies. Here the sample asteroid is screened against Earth's osculating heliocentric orbit.
function minimumOrbitIntersectionDistance() {
	const earthOrbit = new KeplerOrbit(vecMinus(earth(NOW)[0], sun(NOW)[0]), vecMinus(earth(NOW)[1], sun(NOW)[1]), NOW, GM_SUN_PITJEVA_2005, matIdentity())
	console.info('Sample asteroid Earth MOID (AU):', moid(asteroidKeplerOrbit(), earthOrbit).distance)
}

// Tisserand Parameter (relative to Jupiter).
function tisserandParameterComputation() {
	const orbit = new KeplerOrbit(...asteroidKeplerOrbit().at(NOW), NOW)
	const JUPITER_SEMI_MAJOR_AXIS = 5.2044 // AU
	const T = tisserandParameter(orbit.semiMajorAxis, orbit.eccentricity, orbit.inclination, JUPITER_SEMI_MAJOR_AXIS)
	console.info('Tisserand parameter w.r.t. Jupiter:', T)
}

// Gauss Initial Orbit Determination.
// NOTE: gauss() is available but needs three real angles-only observations with an
// Earth-position provider. Documented here; see gibbs/herrickGibbs below for a
// runnable position-based determination.
function gaussInitialOrbitDetermination() {
	console.info('Gauss IOD: gauss(obs1, obs2, obs3, options) with three angles-only observations and Earth positions.')
}

// Gibbs Orbit Determination from three position vectors.
function gibbsOrbitDetermination() {
	const orbit = asteroidKeplerOrbit()
	const r1 = orbit.at(timeJulianYear(2026, Timescale.TT))[0]
	const r2 = orbit.at(timeJulianYear(2026.02, Timescale.TT))[0]
	const r3 = orbit.at(timeJulianYear(2026.04, Timescale.TT))[0]
	const result = gibbs(r1, r2, r3, GM_SUN_PITJEVA_2005)
	console.info('Gibbs reliability:', result.diagnostics.reliability, 'velocity at r2 (AU/day):', vecLength(result.v))
}

// Herrick-Gibbs Orbit Determination (closely-spaced observations).
function herrickGibbsOrbitDetermination() {
	const orbit = asteroidKeplerOrbit()
	const t1 = timeJulianYear(2026, Timescale.TT)
	const t2 = timeJulianYear(2026.001, Timescale.TT)
	const t3 = timeJulianYear(2026.002, Timescale.TT)
	const result = herrickGibbs(orbit.at(t1)[0], orbit.at(t2)[0], orbit.at(t3)[0], t1, t2, t3, GM_SUN_PITJEVA_2005)
	console.info('Herrick-Gibbs reliable:', result.diagnostics.reliable, 'velocity at r2 (AU/day):', vecLength(result.v))
}

// Differential Orbit Correction.
// NOTE: fitOrbit(observations, epoch, position, velocity, options) performs the
// least-squares differential correction; it needs a set of RA/DEC observations and
// an initial state. Documented here to avoid fabricating an observation arc.
function differentialOrbitCorrection() {
	console.info('Differential orbit correction: fitOrbit(observations, epoch, position, velocity, options).')
}

// Sample uncertain orbit for the covariance demos: a main-belt asteroid in the identity (ICRF equatorial)
// state frame, so its state, covariance and sky projection share one frame.
function uncertainOrbit() {
	return KeplerOrbit.meanAnomaly(2.5 * (1 - 0.15 * 0.15), 0.15, deg(8), deg(100), deg(60), deg(30), timeJulianYear(2026, Timescale.TDB), GM_SUN_PITJEVA_2005, matIdentity())
}

// Its epoch state covariance: a diagonal 1e-6 AU (~150 km) position and 1e-8 AU/day velocity 1-sigma,
// standing in for the covariance fitOrbit returns.
function epochStateCovariance() {
	const covariance = new Matrix(6, 6)
	for (let k = 0; k < 3; k++) {
		covariance.set(k, k, 1e-6 * 1e-6)
		covariance.set(k + 3, k + 3, 1e-8 * 1e-8)
	}
	return covariance
}

// Orbit Covariance Propagation: propagateStateCovariance carries the epoch state covariance forward via
// the two-body state-transition matrix, C(t) = Phi C0 Phi^T.
function orbitCovariancePropagation() {
	const orbit = uncertainOrbit()
	const covariance = propagateStateCovariance(orbit, epochStateCovariance(), timeShift(orbit.epoch, 180))
	console.info(
		'Position 1-sigma 180 d after epoch (km):',
		[0, 1, 2].map((k) => toKilometer(Math.sqrt(covariance.get(k, k)))),
	)
}

// Ephemeris Uncertainty Ellipse: ephemerisUncertaintyEllipse projects the propagated position covariance
// onto the plane of sky at the object's geocentric direction.
function ephemerisUncertaintyEllipse() {
	const orbit = uncertainOrbit()
	const time = timeShift(orbit.epoch, 180)
	const covariance = propagateStateCovariance(orbit, epochStateCovariance(), time)
	const ellipse = skyUncertaintyEllipse(covariance, vecMinus(orbit.at(time)[0], earth(time)[0]), { sigma: 3 })
	console.info('3-sigma sky ellipse (arcsec):', toArcsec(ellipse.semiMajor), 'x', toArcsec(ellipse.semiMinor), 'PA (deg):', toDeg(ellipse.positionAngle))
}

// Close Approach B-Plane: computeBPlane reduces a planetocentric hyperbolic flyby to its target-plane
// coordinates. Here the Apophis 2029 Earth encounter (geocentric state from JPL Horizons) reproduces the
// ~38000 km closest approach.
function closeApproachBPlane() {
	const position: Vec3 = [-3.739382606686898e-4, 6.252835449470995e-5, -1.687341276876984e-5]
	const velocity: Vec3 = [3.04338798147783e-3, 1.743343223811018e-3, 1.940149213856787e-3]
	const bplane = computeBPlane(position, velocity)
	console.info('Apophis 2029 b-plane: closest approach (km):', toKilometer(bplane.periapsisDistance), 'v_infinity (km/s):', toKilometerPerSecond(bplane.vInfinity), 'B_T/B_R (km):', toKilometer(bplane.bt), toKilometer(bplane.br))
}

// ##### Artificial Satellites #####

// A sample ISS TLE reused below. SGP4 is only valid near the TLE epoch, so the
// satellite demonstrations evaluate at the TLE's own epoch (SAT_TIME).
const ISS_TLE = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS (ZARYA)')
const SAT_TIME = ISS_TLE.epoch

// TLE Propagation: TEME position (AU -> km) and velocity (AU/day -> km/s) at the epoch.
function tlePropagation() {
	const [p, v] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	console.info('ISS TEME position (km):', p.map(toKilometer), 'velocity (km/s):', v.map(toKilometerPerSecond))
}

// Satellite Topocentric Position: TEME -> ITRF (Earth-fixed) geocentric vector.
function satelliteTopocentricPosition() {
	const [p] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	const ecef = temeToItrf(p, SAT_TIME)
	console.info('ISS ECEF position (km):', ecef.map(toKilometer))
}

// Satellite Pass Prediction / Rise, Culmination, Set: satellitePasses brackets the topocentric-altitude
// crossings of the horizon over the visibility window and refines the culmination between them.
function satellitePassPrediction() {
	const passes = satellitePasses(recordFromTLE(ISS_TLE), SITE, SAT_TIME, timeShift(SAT_TIME, 1))
	console.info('ISS passes in the next day:', passes.length)
}

function satelliteRiseCulminationSet() {
	const rec = recordFromTLE(ISS_TLE)
	const [pass] = satellitePasses(rec, SITE, SAT_TIME, timeShift(SAT_TIME, 1))
	if (pass === undefined) return console.info('ISS rise/culmination/set: no pass in the window.')
	console.info('ISS culmination altitude (deg):', toDeg(pass.culmination.altitude), 'azimuth (deg):', toDeg(pass.culmination.azimuth), 'range (km):', toKilometer(pass.culmination.range))
}

// Satellite Ground Track: sub-satellite geographic point.
function satelliteGroundTrack() {
	const [p] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	const ecef = temeToItrf(p, SAT_TIME)
	// subpoint expects a geocentric vector in Earth radii.
	const sub = subpoint([toKilometer(ecef[0]) / EARTH_RADIUS_KM, toKilometer(ecef[1]) / EARTH_RADIUS_KM, toKilometer(ecef[2]) / EARTH_RADIUS_KM], SAT_TIME)
	console.info('ISS sub-point lon/lat (deg):', toDeg(sub.longitude), toDeg(sub.latitude))
}

// Satellite Illumination State: satelliteShadowState classifies the satellite against the Earth's
// conical umbra/penumbra using the geocentric Sun direction.
function satelliteIlluminationState() {
	console.info('ISS illumination at epoch:', satelliteShadowState(recordFromTLE(ISS_TLE), geocentricSun, SAT_TIME))
}

// Satellite Shadow Entry and Exit: satelliteEclipses root-finds the umbra-boundary crossings that bound
// each eclipse over the window.
function satelliteShadowEntryAndExit() {
	const eclipses = satelliteEclipses(recordFromTLE(ISS_TLE), geocentricSun, SAT_TIME, timeShift(SAT_TIME, 1))
	const eclipse = eclipses.find((e) => e.entry !== undefined && e.exit !== undefined)!
	console.info('ISS umbra entry:', formatTemporal(temporalFromTime(eclipse.entry!)), 'exit:', formatTemporal(temporalFromTime(eclipse.exit!)))
}

// Satellite Angular Speed: topocentric angular rate (finite difference).
function satelliteAngularSpeed() {
	const rec = recordFromTLE(ISS_TLE)
	const a = temeToItrf(sgp4(SAT_TIME, rec)[0], SAT_TIME)
	const t2 = timeShift(SAT_TIME, 1 / DAYSEC)
	const b = temeToItrf(sgp4(t2, rec)[0], t2)
	console.info('ISS angular speed (deg/s):', toDeg(vecAngle(a, b)))
}

// Satellite Visual Magnitude Estimate: satelliteMagnitude applies the Molczan/McCants standard-magnitude
// model (phase-angle + range) for a sunlit satellite over the observer. The ISS standard magnitude is
// about -1.8; the estimate is only meaningful while the satellite is illuminated.
function satelliteVisualMagnitudeEstimate() {
	const rec = recordFromTLE(ISS_TLE)
	const [pass] = satellitePasses(rec, SITE, SAT_TIME, timeShift(SAT_TIME, 1))
	if (pass === undefined) return console.info('ISS visual magnitude: no pass in the window.')
	const mag = satelliteMagnitude(rec, SITE, geocentricSun, pass.culmination.time, -1.8)
	console.info('ISS magnitude at culmination:', mag.illuminated ? mag.magnitude : 'eclipsed', 'phase (deg):', toDeg(mag.phaseAngle))
}

// Satellite Sun / Lunar Avoidance Angle: separation between the satellite and the
// Sun or Moon as seen from the observer.
function satelliteSunAvoidanceAngle() {
	const p = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))[0]
	console.info('Satellite-Sun separation (deg):', toDeg(separationFrom(p, geocentricSun(SAT_TIME))))
}

function satelliteLunarAvoidanceAngle() {
	const p = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))[0]
	console.info('Satellite-Moon separation (deg):', toDeg(separationFrom(p, moonGeocentric(SAT_TIME)[0])))
}

// Satellite Conjunction Screening: satelliteConjunctions propagates both objects and refines the minima
// of their separation over the window. Here the ISS is screened against a co-inclined companion (its
// elements with the node shifted +10 deg) so the demonstration has real separation minima to report.
function satelliteConjunctionScreening() {
	const companion = recordFromTLE(parseTLE('1 25545U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25545  51.6442  31.4611 0001363  85.7790 274.3535 15.49180547 25697', 'COMPANION'))
	const [closest] = satelliteConjunctions(recordFromTLE(ISS_TLE), companion, SAT_TIME, timeShift(SAT_TIME, 100 / 1440))
	if (closest === undefined) return console.info('Satellite conjunction screening: no separation minimum in the window.')
	console.info('Closest approach (km):', toKilometer(closest.distance), 'relative speed (km/s):', toKilometerPerSecond(closest.relativeSpeed))
}

// Geostationary Satellite Longitude: the sub-point longitude (ground track latitude ~0).
function geostationarySatelliteLongitude() {
	console.info('Geostationary longitude: equals the satellite sub-point longitude (see satelliteGroundTrack); near-constant for a GEO TLE.')
}

// Satellite Eclipse Duration: the seconds each satelliteEclipses interval spends inside the umbra.
function satelliteEclipseDuration() {
	const eclipses = satelliteEclipses(recordFromTLE(ISS_TLE), geocentricSun, SAT_TIME, timeShift(SAT_TIME, 1))
	const complete = eclipses.find((e) => e.entry !== undefined && e.exit !== undefined)
	console.info('ISS eclipse duration (s):', complete?.duration)
}

// Satellite Beta Angle: the elevation of the Sun above the orbital plane, the driver of the eclipse
// fraction and thermal/power load. The orbit normal is the specific angular momentum direction r x v from
// the SGP4 state, rotated out of TEME into the geocentric ICRS frame the Sun vector lives in; the beta
// angle is 90deg minus the Sun-normal angle, so it is positive when the Sun is on the +h side of the plane
// and near +/-90deg for a Sun-synchronous, permanently-lit geometry.
function satelliteBetaAngle() {
	const [p, v] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	const normal = frameToFrame(vecCross(p, v), TEME, ICRS, SAT_TIME)
	const beta = PIOVERTWO - vecAngle(geocentricSun(SAT_TIME), normal)
	console.info('ISS beta angle (deg):', toDeg(beta).toFixed(2))
}

// Satellite Range-Rate and Doppler: the line-of-sight closing speed and the frequency shift it induces on
// a downlink. The slant range from satelliteLookAngles is differenced over one second (a central-scale
// finite difference is unnecessary here) to give the range-rate in AU/day; a negative value means the pass
// is approaching. The classical Doppler shift of a received carrier is -(range-rate / c) * f, evaluated in
// AU/day with SPEED_OF_LIGHT_AU_DAY so no unit conversion is needed before scaling by the frequency.
function satelliteRangeRateAndDoppler() {
	const rec = recordFromTLE(ISS_TLE)
	const dt = 1 / DAYSEC // one second expressed in days
	const rangeRate = (satelliteLookAngles(rec, SITE, timeShift(SAT_TIME, dt)).range - satelliteLookAngles(rec, SITE, SAT_TIME).range) / dt
	const DOWNLINK_MHZ = 145.8 // ISS VHF voice downlink
	const dopplerKHz = (-rangeRate / SPEED_OF_LIGHT_AU_DAY) * DOWNLINK_MHZ * 1000
	console.info('ISS range-rate (km/s):', toKilometerPerSecond(rangeRate).toFixed(3), 'Doppler at 145.8 MHz (kHz):', dopplerKHz.toFixed(2))
}

// Satellite Ground Footprint: the circle of the Earth's surface within the satellite's geometric horizon.
// From the geocentric radius Re + h (the SGP4 TEME position magnitude), the Earth central angle from the
// sub-point to the horizon is lambda = acos(Re / (Re + h)); the footprint radius along the surface is
// Re * lambda. This is the ideal-horizon coverage cap (no terrain or minimum-elevation mask).
function satelliteGroundFootprint() {
	const [p] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	const geocentricRadiusKm = toKilometer(vecLength(p))
	const lambda = Math.acos(EARTH_RADIUS_KM / geocentricRadiusKm)
	console.info('ISS altitude (km):', (geocentricRadiusKm - EARTH_RADIUS_KM).toFixed(1), 'coverage half-angle (deg):', toDeg(lambda).toFixed(2), 'footprint radius (km):', (EARTH_RADIUS_KM * lambda).toFixed(0))
}

// Visible Pass Prediction: the practical "when can I actually see it" question, composing the three
// primitives. satellitePasses brackets the passes that clear a minimum culmination altitude (the
// minAltitude horizon), then each pass is screened at its culmination with satelliteMagnitude, which
// reports both whether the satellite is sunlit (out of the Earth's umbra) and its apparent magnitude.
// Only sunlit passes at or brighter than a magnitude limit are kept. A full naked-eye prediction would
// also require the observer to be in darkness (Sun sufficiently below the horizon); that gate reuses the
// twilight machinery shown earlier and is left out here to keep the demonstration focused.
function visiblePassPrediction() {
	const rec = recordFromTLE(ISS_TLE)
	const minAltitude = deg(20) // ignore low passes lost in horizon murk
	const magnitudeLimit = 3.5 // roughly the naked-eye limit under suburban skies
	const passes = satellitePasses(rec, SITE, SAT_TIME, timeShift(SAT_TIME, 1), { minAltitude })
	const visible = passes.map((pass) => ({ pass, mag: satelliteMagnitude(rec, SITE, geocentricSun, pass.culmination.time, -1.8) })).filter(({ mag }) => mag.illuminated && mag.magnitude <= magnitudeLimit)
	if (visible.length === 0) return console.info('Visible passes: none above 20deg, sunlit and brighter than', magnitudeLimit, 'in the next day.')
	for (const { pass, mag } of visible) {
		console.info('Visible ISS pass (local):', formatTemporal(temporalFromTime(utc(pass.culmination.time))), `culmination ${toDeg(pass.culmination.altitude).toFixed(0)}deg, magnitude ${mag.magnitude.toFixed(1)}`)
	}
}

function run() {
	// Time and Earth Orientation
	julianDateConversion()
	modifiedJulianDateConversion()
	julianDateToCalendarDate()
	unixTimeConversion()
	utcToTaiConversion()
	taiToTtConversion()
	utcToUt1Conversion()
	ttToTdbConversion()
	ttToTcbConversion()
	deltaTEstimation()
	dut1Interpolation()
	leapSecondLookup()
	earthRotationAngleComputation()
	greenwichMeanSiderealTimeComputation()
	greenwichApparentSiderealTimeComputation()
	localMeanSiderealTime()
	localApparentSiderealTime()
	equationOfTheEquinoxes()
	polarMotionMatrix()
	earthOrientationInterpolation()
	julianEpochConversion()
	besselianEpochConversion()
	tropicalYearLength()
	siderealYearLength()

	// Coordinate Systems and Geometry
	sphericalToCartesian()
	cartesianToSpherical()
	raDecToVector()
	vectorToRaDec()
	icrsToFk5Transformation()
	fk5ToIcrsTransformation()
	icrsToGalactic()
	galacticToIcrs()
	icrsToEcliptic()
	eclipticToIcrs()
	galacticToSupergalactic()
	equatorialToHorizontalComputation()
	horizontalToEquatorialComputation()
	hourAngleCalculation()
	parallacticAngleCalculation()
	greatCircleDistance()
	greatCircleBearing()
	greatCircleMidpoint()
	sphericalPolygonAreaComputation()
	sphericalTriangleAreaComputation()
	sphericalTriangleAnglesComputation()
	tangentPlaneProjection()
	inverseTangentPlaneProjection()
	positionAngleBetween()
	coordinateOffsetByPositionAngle()
	smallAngleOffset()
	celestialPoleDistance()
	zenithDistance()

	// Astrometric Corrections and Stellar Motion
	precessionTransformation()
	nutationCorrection()
	annualAberrationComputation()
	diurnalAberration()
	solarGravitationalDeflection()
	planetaryGravitationalDeflection()
	annualParallax()
	diurnalParallax()
	properMotionPropagation()
	radialVelocityPropagation()
	fullSpaceMotionPropagation()
	perspectiveAcceleration()
	barycentricRadialVelocityCorrection()
	heliocentricRadialVelocityCorrection()
	astrometricToApparentPlace()
	apparentToObservedPlace()
	atmosphericRefractionComputation()
	inverseAtmosphericRefraction()
	differentialAtmosphericRefraction()
	catalogCrossMatch()
	nearestCelestialNeighbor()

	// Solar System Ephemerides
	barycentricBodyState()
	heliocentricBodyState()
	geocentricBodyState()
	topocentricBodyState()
	apparentPlanetPosition()
	planetAltitudeAndAzimuth()
	planetaryElongation()
	planetaryPhaseAngle()
	planetaryIlluminatedFraction()
	planetaryAngularDiameter()
	planetaryVisualMagnitude()
	planetaryHeliocentricLongitude()
	planetaryGeocentricLongitude()
	planetaryEclipticLatitude()
	planetaryApparentMotion()
	planetaryStationaryPoint()
	planetaryGreatestElongation()
	planetaryOpposition()
	planetaryConjunction()
	planetaryQuadrature()
	planetaryClosestApproach()
	inferiorConjunction()
	superiorConjunction()
	perihelionAndAphelion()
	ascendingAndDescendingNode()
	planetaryCentralMeridian()
	subObserverPoint()
	subSolarPoint()
	saturnRingOpeningAngle()
	saturnRingOrientation()
	jupiterGreatRedSpotTransit()

	// Sun and Moon
	apparentSolarPosition()
	solarAltitudeAndAzimuth()
	solarEquationOfTime()
	solarDeclination()
	solarHourAngle()
	solarNoon()
	solarDiskOrientation()
	carringtonRotationNumberComputation()
	solarAnalemmaPoint()
	solarShadowLength()
	solarShadowDirection()
	earthPerihelionAndAphelion()
	equinoxAndSolsticeTimes()
	lunarGeocentricPosition()
	lunarTopocentricPosition()
	lunarAltitudeAndAzimuth()
	lunarPhaseAngle()
	lunarIlluminatedFraction()
	lunarAge()
	lunarPhaseName()
	lunarBrightLimbPositionAngle()
	lunarAngularDiameter()
	lunarHorizontalParallax()
	lunarLibration()
	lunarLibrationExtremes()
	lunarColongitude()
	lunarTerminatorPosition()
	lunarSunriseSunsetAtFeature()
	lunarSubSolarPoint()
	lunarSubObserverPoint()
	lunarAscendingAndDescendingNodes()
	lunarPerigeeAndApogee()
	lunarStandstillExtremes()
	crescentMoonWidth()

	// Visibility and Almanac Events
	objectRiseTime()
	objectSetTime()
	objectUpperTransit()
	objectLowerTransit()
	objectMaximumAltitude()
	objectVisibilityIntervals()
	circumpolarClassification()
	airmassCalculation()
	airmassTimeSeries()
	astronomicalTwilight()
	nauticalTwilight()
	civilTwilight()
	nightDarknessIntervals()
	moonlessObservationWindows()
	targetAboveAltitudeWindow()
	targetMeridianWindow()
	targetMoonSeparationWindow()
	targetSunSeparationWindow()
	targetAirmassWindow()
	heliacalPhaseEvents()
	fieldRotationAngle()
	fieldRotationRate()
	parallacticAngleTimeSeries()

	// Eclipses, Occultations, and Transits
	solarEclipseClassification()
	solarEclipseBesselianElements()
	localSolarEclipseCircumstances()
	solarEclipsePathSummary()
	lunarEclipseClassification()
	localLunarEclipseCircumstances()
	lunarEclipseMagnitude()
	lunarEclipseMoonAltitude()
	asteroidOccultationPrediction()
	planetaryTransitPrediction()
	mercuryTransitCircumstances()
	venusTransitCircumstances()
	mutualSatelliteEvent()

	// Orbits and Small Bodies
	keplerianElementsToStateVector()
	stateVectorToKeplerianElements()
	meanAnomalyToEccentricAnomaly()
	eccentricAnomalyToTrueAnomaly()
	hyperbolicAnomalySolution()
	universalVariablePropagation()
	twoBodyOrbitPropagation()
	orbitalPeriod()
	meanMotionComputation()
	periapsisAndApoapsisDistance()
	orbitalEnergy()
	synodicPeriodComputation()
	orbitalResonance()
	escapeVelocityComputation()
	hillSphereRadius()
	rocheLimitComputation()
	angularMomentumVector()
	orbitClassification()
	osculatingElements()
	heliocentricMinorBodyPosition()
	geocentricMinorBodyPosition()
	apparentCometPosition()
	cometSolarElongation()
	cometMagnitudeEstimation()
	asteroidPhaseAngle()
	asteroidMagnitudeEstimation()
	minorPlanetClosestApproach()
	minimumOrbitIntersectionDistance()
	tisserandParameterComputation()
	gaussInitialOrbitDetermination()
	gibbsOrbitDetermination()
	herrickGibbsOrbitDetermination()
	differentialOrbitCorrection()
	orbitCovariancePropagation()
	ephemerisUncertaintyEllipse()
	closeApproachBPlane()

	// Artificial Satellites
	tlePropagation()
	satelliteTopocentricPosition()
	satellitePassPrediction()
	satelliteRiseCulminationSet()
	satelliteGroundTrack()
	satelliteIlluminationState()
	satelliteShadowEntryAndExit()
	satelliteAngularSpeed()
	satelliteVisualMagnitudeEstimate()
	satelliteSunAvoidanceAngle()
	satelliteLunarAvoidanceAngle()
	satelliteConjunctionScreening()
	geostationarySatelliteLongitude()
	satelliteEclipseDuration()
	satelliteBetaAngle()
	satelliteRangeRateAndDoppler()
	satelliteGroundFootprint()
	visiblePassPrediction()
}

run()
