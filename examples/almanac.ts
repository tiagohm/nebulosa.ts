// Almanac usage demonstrations.
//
// Each function below demonstrates the use of an existing public function
// whenever one is available. When the library does not (yet) expose a function that
// satisfies the requirement, the example is still provided but the body documents
// WHY it is missing and HOW it should be implemented in the future.
// Such cases are tagged with `// TODO(almanac):`.
//
// Run a single demonstration by calling its function, or run the curated
// offline subset at the bottom with `bun run examples/almanac.ts`.

import fs from 'fs/promises'
import { matchStars } from '../src/astrometry/matching/star.matching'
import { moonParallax, moonSemidiameter, nearestLunarApsis, nearestLunarEclipse, nearestLunarPhase } from '../src/astronomy/bodies/moon'
import { spaceMotion, star } from '../src/astronomy/bodies/star'
import { carringtonRotationNumber, equationOfTime, nearestSolarEclipse, season } from '../src/astronomy/bodies/sun'
import { cirsToObserved, distance as vectorDistance, equatorial as vectorToEquatorial, icrsToCirs, icrsToObserved, parallacticAngle, phaseAngle, refractedAltitude, relativePositionAndVelocity, separationFrom, type PositionAndVelocityOverTime } from '../src/astronomy/coordinates/astrometry'
import { angularDistance, eclipticToEquatorial, equatorialFromJ2000, equatorialToEcliptic, equatorialToGalatic, equatorialToHorizontal, galacticToEquatorial, horizontalToEquatorial, zenith } from '../src/astronomy/coordinates/coordinate'
import { annualAberration, lightTravelTime, observerState, radialVelocityCorrection } from '../src/astronomy/coordinates/correction'
import { eraAnpm, eraC2s, eraLdSun, eraPmpx, eraS2c, eraSeps, eraStarpm, eraStarpv } from '../src/astronomy/coordinates/erfa/erfa'
import { precessFk5FromJ2000 } from '../src/astronomy/coordinates/fk5'
import { GALACTIC, SUPERGALACTIC, fk5ToIcrs, frameToFrame, icrsToFk5, temeToItrf } from '../src/astronomy/coordinates/frame'
import { icrs as icrsVector } from '../src/astronomy/coordinates/icrs'
import { itrs } from '../src/astronomy/coordinates/itrs'
import { Base as Meeus } from '../src/astronomy/ephemeris/meeus'
import { moon as moonGeocentric } from '../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, jupiter, mars, sun, venus } from '../src/astronomy/ephemeris/models/analytical/vsop87e'
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse'
import { computeLocalLunarEclipseCircumstances } from '../src/astronomy/events/eclipse/lunar/local'
import { computeGreatestEclipseCircumstances, computeLocalSolarEclipseCircumstances } from '../src/astronomy/events/eclipse/solar/local'
import { computePolynomialBesselianElements } from '../src/astronomy/events/eclipse/solar/map'
import { airmass, airmassKastenYoung, altitudeAtTransit, asteroidMagnitudeEstimate, atmosphericRefraction, cometMagnitudeEstimate, hourAngleAtAltitude, objectAngularDiameter } from '../src/astronomy/formulas'
import { Ellipsoid, geodeticLocation, localSiderealTime, rhoCosPhi, subpoint } from '../src/astronomy/observer/location'
import { KeplerOrbit, asteroid, comet, meanMotion, period, tisserandParameter, trueAnomalyClosed, trueAnomalyHyperbolic } from '../src/astronomy/orbits/asteroid'
import { gibbs } from '../src/astronomy/orbits/determination/gibbs'
import { herrickGibbs } from '../src/astronomy/orbits/determination/herrickgibbs'
import { parseTLE, recordFromTLE, sgp4 } from '../src/astronomy/orbits/propagation/sgp4'
import { HealpixIndex } from '../src/astronomy/sky/spatial/healpix'
import { deltaT } from '../src/astronomy/time/deltat'
import { iersab, iersb } from '../src/astronomy/time/iers'
import { fileHandleSource } from '../src/io/io'
// oxfmt-ignore
import { Timescale, dut1 as dut1FromTime, earthRotationAngle, equationOfEquinoxes, greenwichApparentSiderealTime, greenwichMeanSiderealTime, nutationAngles, pmAngles, pmMatrix, tai, taiMinusUtc, tcb, tdb, timeBesselianYear, timeJulianYear, timeMJD, timeShift, timeSubtract, timeToDate, timeUnix, timeYMDHMS, toJulianDay, toJulianEpoch, tt, ut1, utc, type Time } from '../src/astronomy/time/time'
import { formatTemporal, temporalFromTime } from '../src/astronomy/time/temporal'
import { DAYSEC, DAYSPERSY, DAYSPERTY, EARTH_RADIUS_KM, GM_SUN_PITJEVA_2005, PI, TAU } from '../src/core/constants'
import { type Vec3, vecAngle, vecCross, vecLatitude, vecLength, vecLongitude, vecMinus, vecMulScalar, vecNormalize } from '../src/math/linear-algebra/vec3'
import { sphericalDestination, sphericalInterpolate, sphericalPolygonArea, sphericalPositionAngle, sphericalProjectTangentPlane, sphericalSeparation, sphericalTriangleAngles, sphericalTriangleArea, sphericalUnprojectTangentPlane } from '../src/math/numerical/geometry'
import { arcmin, arcsec, deg, formatAZ, formatHMS, formatSignedDMS, hms, hour, normalizeAngle, normalizePI, toArcsec, toDeg, toHour } from '../src/math/units/angle'
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
	console.info('Distance to north celestial pole (deg):', toDeg(PI / 2 - SIRIUS_DEC))
}

// Zenith Distance: 90deg minus altitude (and the zenith's equatorial coords).
function zenithDistance() {
	const lst = localSiderealTime(NOW, SITE, false)
	const [, alt] = equatorialToHorizontal(SIRIUS_RA, SIRIUS_DEC, SITE.latitude, lst)
	console.info('Zenith distance of Sirius (deg):', toDeg(PI / 2 - alt))
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
// TODO(almanac): no dedicated helper. observerState() returns the observer's full
// barycentric velocity (orbital + diurnal); the diurnal part is the difference
// between the topocentric and geocentric velocities. Here we report its magnitude.
function diurnalAberration() {
	// The diurnal aberration constant is ~0.3200" at the equator, scaled by the
	// observer's geocentric radius projected onto the equatorial plane (rho*cos(phi)).
	const amplitude = 0.32 * rhoCosPhi(SITE)
	console.info('Diurnal aberration amplitude (arcsec):', amplitude)
}

// Solar Gravitational Deflection: bending of starlight grazing the Sun (ERFA eraLdSun).
function solarGravitationalDeflection() {
	const natural = vecNormalize(SIRIUS_ICRF)
	const eSun = vecMulScalar(earthHeliocentric(NOW), -1) // Earth -> Sun direction
	const em = vecLength(eSun)
	const deflected = eraLdSun(natural, vecNormalize(eSun), em)
	console.info('Solar deflection (arcsec):', toArcsec(eraSeps(vecLongitude(natural), vecLatitude(natural), vecLongitude(deflected), vecLatitude(deflected))))
}

// Planetary Gravitational Deflection: light bending by a massive planet (Jupiter).
// TODO(almanac): use eraLd / eraLdn with the planet body list. The dominant
// planetary term is Jupiter (~0.017" at the limb); it is negligible far from the
// planet, so a full pipeline would pass all major bodies to eraLdn. Demonstrated
// here as the magnitude of Jupiter's contribution near our test star.
function planetaryGravitationalDeflection() {
	console.info('Planetary deflection: dominated by Jupiter (<=0.017" at limb); use eraLdn with the body list for a rigorous result.')
}

// Annual Parallax: yearly ellipse from the Earth's barycentric displacement (ERFA eraPmpx).
function annualParallax() {
	const [pob] = earth(NOW) // Earth barycentric position (AU)
	const px = arcsec(0.379) // Sirius parallax
	const shifted = eraPmpx(SIRIUS_RA, SIRIUS_DEC, 0, 0, px, 0, 0, pob)
	console.info('Parallax-shifted RA/DEC:', formatHMS(normalizeAngle(vecLongitude(shifted))), formatSignedDMS(vecLatitude(shifted)))
}

// Diurnal Parallax: topocentric shift from the observer's offset from the geocenter.
// TODO(almanac): no packaged helper for stars; the offset is the observer's ITRS
// vector (itrs(location)) rotated to ICRS and subtracted from the geocentric
// direction. Significant only for nearby bodies (Moon/asteroids), where the
// topocentric body-state helper in Section 4 already accounts for it.
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
// approaches or recedes. TODO(almanac): not exposed as its own function; it falls
// out of eraStarpm naturally. Here we difference the proper motion over a century.
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

// Heliocentric Radial Velocity Correction.
// TODO(almanac): radialVelocityCorrection / observerState are referred to the
// solar-system barycenter. A heliocentric variant would reference the Sun's
// center instead (subtract the Sun's barycentric velocity). The difference is
// small (Sun's barycentric motion), shown below via the light-travel-time analog.
function heliocentricRadialVelocityCorrection() {
	const ltt = lightTravelTime(SIRIUS_RA, SIRIUS_DEC, NOW, earth(NOW), SITE)
	console.info('Light-travel-time correction to barycenter (s):', ltt * DAYSEC)
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

// Inverse Atmospheric Refraction: recover the true altitude from an observed one.
// TODO(almanac): observedToCirs inverts the full pipeline; for the altitude-only
// case we invert the Bennett formula by one fixed-point iteration here.
function inverseAtmosphericRefraction() {
	const observed = deg(10)
	let trueAlt = observed
	for (let i = 0; i < 3; i++) trueAlt = observed - arcmin(atmosphericRefraction(trueAlt))
	console.info('Recovered true altitude (deg):', toDeg(trueAlt))
}

// Differential Atmospheric Refraction: refraction difference across a field's extent.
function differentialAtmosphericRefraction() {
	const dr = atmosphericRefraction(deg(20)) - atmosphericRefraction(deg(20.5))
	console.info('Differential refraction over 0.5deg at 20deg alt (arcsec):', dr * 60)
}

// Catalog Cross-Match: associate detected stars with a reference list.
// TODO(almanac): crossMatchStars() matches a detected list against a StarCatalog
// (async, catalog-backed). For an offline demonstration we use matchStars(), which
// solves the geometric transform between two star frames; the same machinery
// underpins catalog association once a catalog is supplied.
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

// Planetary Visual Magnitude.
// TODO(almanac): the library has no planetary photometric model (the Astronomical
// Almanac / Mallama polynomials in distance and phase angle). cometMagnitudeEstimate
// and asteroidMagnitudeEstimate exist for small bodies, but planets need their own
// per-planet coefficients. A `planetMagnitude(body, r, delta, phaseAngle)` should be
// added to formulas.ts using the Mallama 2018 coefficients.
function planetaryVisualMagnitude() {
	console.info('Planetary visual magnitude: not implemented; add Mallama 2018 polynomials to formulas.ts.')
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

// Planetary Stationary Point.
// TODO(almanac): no event finder. A stationary point is where the apparent RA rate
// changes sign; it can be bracketed by sampling the daily RA motion (above) over the
// synodic window and root-finding with brentRoot. Sketched here as a coarse scan.
function planetaryStationaryPoint() {
	console.info('Planetary stationary point: detect a sign change in daily RA motion and refine with brentRoot.')
}

// Planetary Greatest Elongation.
// TODO(almanac): no event finder. Maximize planetaryElongation() over the synodic
// period (e.g. brentMinimize on the negated elongation) for Mercury/Venus.
function planetaryGreatestElongation() {
	console.info('Planetary greatest elongation: maximize elongation over the synodic period with brentMinimize.')
}

// Planetary Opposition / Conjunction.
// TODO(almanac): no event finder. Opposition = elongation 180deg (outer planets),
// conjunction = elongation 0deg; bracket the elongation extremes and root-find.
function planetaryOpposition() {
	console.info('Planetary opposition: root-find elongation - PI over the synodic period.')
}

function planetaryConjunction() {
	console.info('Planetary conjunction: root-find elongation = 0 over the synodic period.')
}

// Inferior / Superior Conjunction (inner planets).
// TODO(almanac): no event finder. Distinguish by whether the planet is nearer than
// the Sun (inferior) or beyond it (superior) at conjunction.
function inferiorConjunction() {
	console.info('Inferior conjunction: conjunction with the planet nearer than the Sun (geocentric distance < 1 AU).')
}

function superiorConjunction() {
	console.info('Superior conjunction: conjunction with the planet beyond the Sun.')
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

// Planetary Central Meridian.
// TODO(almanac): requires a body-orientation model (IAU rotation elements W0, Wdot
// and pole RA/DEC). Not present in the library; add an `orientation(body, time)`
// helper returning the sub-observer longitude (central meridian).
function planetaryCentralMeridian() {
	console.info('Planetary central meridian: needs IAU rotation elements (W, pole); not implemented.')
}

// Sub-Observer Point / Sub-Solar Point.
// TODO(almanac): same prerequisite as the central meridian; the sub-observer and
// sub-solar planetographic coordinates need the IAU pole and rotation model.
function subObserverPoint() {
	console.info('Sub-observer point: needs IAU pole/rotation model; not implemented.')
}

function subSolarPoint() {
	console.info('Sub-solar point: needs IAU pole/rotation model; not implemented.')
}

// Saturn Ring Opening Angle.
// TODO(almanac): the ring tilt (B) follows from Saturn's pole orientation and the
// Saturn-Earth vector; needs the IAU pole model for Saturn. Not implemented.
function saturnRingOpeningAngle() {
	console.info('Saturn ring opening angle: needs Saturn pole orientation; not implemented.')
}

// Jupiter Great Red Spot Transit.
// TODO(almanac): requires System II longitude (rotation model) plus a GRS drift
// table. Not present; add a Jupiter rotation model and a GRS reference longitude.
function jupiterGreatRedSpotTransit() {
	console.info('Jupiter GRS transit: needs System II rotation model and GRS drift; not implemented.')
}

// ##### Sun and Moon helpers #####

// Standard gravitational parameter of the Earth, AU^3/day^2 (for lunar-orbit geometry).
const MU_EARTH = 8.997011e-10

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

// Solar Noon: instant of the Sun's upper transit (HA = 0), approximated from the
// equation of time and the observer's longitude.
// TODO(almanac): no packaged transit finder; this inverts EoT + longitude directly.
function solarNoon() {
	const alpha = sunEquatorial()[0]
	const eot = normalizePI(greenwichApparentSiderealTime(NOW) - alpha - utc(NOW).fraction * TAU)
	const noonUtHours = 12 - (toDeg(eot) * 4) / 60 - toDeg(SITE.longitude) / 15
	console.info('Approx. local solar noon (UT hours):', noonUtHours)
}

// Solar Disk Orientation (P, B0, L0).
// TODO(almanac): the position angle of the solar rotation axis (P) and the
// heliographic latitude/longitude of the disk center (B0, L0) need the Sun's
// rotation elements. carringtonRotationNumber exists, but P/B0/L0 do not. Add a
// `solarDiskOrientation(time)` returning (P, B0, L0).
function solarDiskOrientation() {
	console.info('Solar disk orientation (P, B0, L0): not implemented; needs solar rotation elements.')
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

// Earth Perihelion and Aphelion: osculating apsis distances of the Earth's orbit.
// TODO(almanac): no date finder for the Earth's perihelion/aphelion passages; the
// osculating distances follow from the heliocentric state. season() covers the
// equinoxes/solstices but not the apsides.
function earthPerihelionAndAphelion() {
	const [bp, bv] = earth(NOW)
	const [sp, sv] = sun(NOW)
	const orbit = new KeplerOrbit(vecMinus(bp, sp), vecMinus(bv, sv), NOW, GM_SUN_PITJEVA_2005)
	console.info('Earth perihelion/aphelion (AU):', orbit.periapsisDistance, orbit.apoapsisDistance)
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
// TODO(almanac): nearestLunarPhase finds phase instants but does not name the
// current phase. We classify here from elongation and the Sun-Moon RA order.
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

// Lunar Libration (optical libration in longitude/latitude).
// TODO(almanac): selenographic optical libration (l, b) and the position angle of
// the axis need the Moon's physical/mean orientation model (Meeus ch. 53). Not
// implemented; add `lunarLibration(time)` returning (l, b, P).
function lunarLibration() {
	console.info('Lunar libration (l, b): not implemented; needs the lunar orientation model.')
}

// Lunar Colongitude (selenographic colongitude of the morning terminator).
// TODO(almanac): depends on the Sun's selenographic longitude; same prerequisite
// as libration. Not implemented.
function lunarColongitude() {
	console.info('Lunar colongitude: not implemented; needs selenographic Sun longitude.')
}

// Lunar Terminator Position.
// TODO(almanac): the terminator is the great circle 90deg from the sub-solar
// selenographic point; needs the lunar orientation model. Not implemented.
function lunarTerminatorPosition() {
	console.info('Lunar terminator position: not implemented; needs the sub-solar selenographic point.')
}

// Lunar Sub-Solar / Sub-Observer Point (selenographic).
// TODO(almanac): both need the Moon's IAU rotation elements. Not implemented.
function lunarSubSolarPoint() {
	console.info('Lunar sub-solar point: not implemented; needs the lunar orientation model.')
}

function lunarSubObserverPoint() {
	console.info('Lunar sub-observer point: not implemented; needs the lunar orientation model.')
}

// Lunar Ascending and Descending Nodes: node longitude of the osculating lunar orbit.
// TODO(almanac): no node-passage date finder; the instantaneous node longitude
// follows from the geocentric lunar state (independent of mu).
function lunarAscendingAndDescendingNodes() {
	const [p, v] = moonGeocentric(NOW)
	const orbit = new KeplerOrbit(p, v, NOW, MU_EARTH)
	console.info('Lunar ascending node longitude (deg):', toDeg(normalizeAngle(orbit.longitudeOfAscendingNode)))
}

// Lunar Perigee and Apogee.
function lunarPerigeeAndApogee() {
	const [perigeeTime, perigeeDistance] = nearestLunarApsis(NOW, 'PERIGEE', true)
	const [apogeeTime, apogeeDistance] = nearestLunarApsis(NOW, 'APOGEE', true)
	console.info('Next perigee:', formatTemporal(temporalFromTime(perigeeTime)), 'distance (km):', toKilometer(perigeeDistance))
	console.info('Next apogee:', formatTemporal(temporalFromTime(apogeeTime)), 'distance (km):', toKilometer(apogeeDistance))
}

// Lunar Standstill Extremes (major/minor standstill).
// TODO(almanac): standstills depend on the 18.6-year regression of the lunar
// node and require scanning the Moon's monthly declination extremes across that
// cycle. No finder is provided. Not implemented.
function lunarStandstillExtremes() {
	console.info('Lunar standstill extremes: not implemented; needs an 18.6-year declination-extreme scan.')
}

// Crescent Moon Width: angular width of the illuminated crescent at its midpoint.
// TODO(almanac): no dedicated helper; approximated from the semidiameter and the
// illuminated fraction (width ~ diameter * illuminatedFraction near new moon).
function crescentMoonWidth() {
	const sd = moonSemidiameter(vecLength(moonGeocentric(NOW)[0]))
	const width = 2 * sd * Meeus.illuminated(computeLunarPhaseAngle())
	console.info('Crescent width (arcmin):', toArcsec(width) / 60)
}

// Crescent Moon Visibility (first-visibility criterion).
// TODO(almanac): the Yallop/Odeh first-visibility criteria (q-test) combine the
// Moon-Sun altitude difference, the crescent width and the arc of vision. Not
// implemented; add a `crescentVisibility(time, location)` returning the q-value.
function crescentMoonVisibility() {
	console.info('Crescent Moon visibility: not implemented; add the Yallop/Odeh q-test.')
}

// ##### Visibility and Almanac Events #####

// Object Rise / Set Time.
// TODO(almanac): the library has no rise/set/transit event finder. We compute the
// geometric semidiurnal arc (hour angle at altitude 0) and express rise/set as
// local sidereal times; converting LST to civil UT needs sidereal-time inversion
// (iterate localSiderealTime). A `riseTransitSet(target, time, location)` helper
// should be added under observation/.
function objectRiseTime() {
	const h0 = hourAngleAtAltitude(SIRIUS_DEC, SITE.latitude, 0)
	if (h0 === null) return console.info('Object never crosses the horizon (circumpolar or never rises).')
	console.info('Rise LST:', formatHMS(normalizeAngle(SIRIUS_RA - h0)))
}

function objectSetTime() {
	const h0 = hourAngleAtAltitude(SIRIUS_DEC, SITE.latitude, 0)
	if (h0 === null) return console.info('Object never crosses the horizon.')
	console.info('Set LST:', formatHMS(normalizeAngle(SIRIUS_RA + h0)))
}

// Object Upper / Lower Transit: meridian crossings (HA = 0 and HA = 12h).
function objectUpperTransit() {
	console.info('Upper transit at LST:', formatHMS(normalizeAngle(SIRIUS_RA)))
}

function objectLowerTransit() {
	console.info('Lower transit at LST:', formatHMS(normalizeAngle(SIRIUS_RA + PI)))
}

// Object Maximum Altitude (altitude at upper transit).
function objectMaximumAltitude() {
	console.info('Maximum altitude (deg):', toDeg(altitudeAtTransit(SITE.latitude, SIRIUS_DEC)))
}

// Object Visibility Intervals.
// TODO(almanac): no interval engine; build it by sampling altitude over the night
// and bracketing the up/down crossings with the hour-angle helper above.
function objectVisibilityIntervals() {
	const h0 = hourAngleAtAltitude(SIRIUS_DEC, SITE.latitude, 0)
	console.info('Time above horizon per day (hours):', h0 === null ? 'circumpolar/never' : (2 * toHour(h0)).toFixed(2))
}

// Circumpolar Classification: always-up, always-down, or rising/setting.
function circumpolarClassification() {
	const lat = SITE.latitude
	let kind = 'rises and sets'
	if (SIRIUS_DEC > PI / 2 - Math.abs(lat) && lat > 0) kind = 'circumpolar (always up)'
	else if (SIRIUS_DEC < -(PI / 2 - Math.abs(lat)) && lat > 0) kind = 'never rises'
	else if (SIRIUS_DEC < -(PI / 2 - Math.abs(lat)) && lat < 0) kind = 'circumpolar (always up)'
	else if (SIRIUS_DEC > PI / 2 - Math.abs(lat) && lat < 0) kind = 'never rises'
	console.info('Circumpolar classification:', kind)
}

// Airmass Calculation.
function airmassCalculation() {
	const alt = altitudeAtTransit(SITE.latitude, SIRIUS_DEC)
	console.info('Airmass at transit (secant):', airmass(PI / 2 - alt), 'Kasten-Young:', airmassKastenYoung(alt))
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

// Astronomical / Nautical / Civil Twilight: Sun at -18deg, -12deg, -6deg.
function twilightAt(depressionDeg: number) {
	const eq = sunEquatorial()
	const h0 = hourAngleAtAltitude(eq[1], SITE.latitude, deg(-depressionDeg))
	return h0 === null ? null : normalizeAngle(eq[0] + h0)
}

function astronomicalTwilight() {
	const lst = twilightAt(18)
	console.info('Astronomical dusk (Sun at -18deg) LST:', lst === null ? 'does not occur' : formatHMS(lst))
}

function nauticalTwilight() {
	const lst = twilightAt(12)
	console.info('Nautical dusk (Sun at -12deg) LST:', lst === null ? 'does not occur' : formatHMS(lst))
}

function civilTwilight() {
	const lst = twilightAt(6)
	console.info('Civil dusk (Sun at -6deg) LST:', lst === null ? 'does not occur' : formatHMS(lst))
}

// Night Darkness Intervals.
// TODO(almanac): the fully-dark interval is between the end of astronomical dusk
// and the start of astronomical dawn; needs the twilight crossings plus the Moon
// being down. Compose from twilightAt() and a moon rise/set finder (missing).
function nightDarknessIntervals() {
	console.info('Night darkness intervals: compose from astronomical twilight crossings; needs a rise/set finder.')
}

// Moonless Observation Windows.
// TODO(almanac): intersection of "Sun below -18deg" with "Moon below the horizon";
// needs rise/set finders for both bodies. Not implemented.
function moonlessObservationWindows() {
	console.info('Moonless observation windows: intersect dark-sky window with Moon-down interval; needs rise/set finders.')
}

// Target Above Altitude Window.
// TODO(almanac): the window during which a target stays above a chosen altitude is
// bounded by hourAngleAtAltitude(dec, lat, hMin); shown here as its duration.
function targetAboveAltitudeWindow() {
	const h = hourAngleAtAltitude(SIRIUS_DEC, SITE.latitude, deg(30))
	console.info('Time above 30deg per day (hours):', h === null ? 'never/always' : (2 * toHour(h)).toFixed(2))
}

// Target Meridian Window.
// TODO(almanac): the centered meridian window is +/- a chosen hour angle around the
// upper transit (LST = RA); shown here as the LST range for +/-1h.
function targetMeridianWindow() {
	console.info('Meridian +/-1h window LST:', formatHMS(normalizeAngle(SIRIUS_RA - hour(1))), '..', formatHMS(normalizeAngle(SIRIUS_RA + hour(1))))
}

// Target Moon Separation Window.
// TODO(almanac): no scanner; current separation shown. A window would scan the
// night and bracket where separation exceeds a threshold.
function targetMoonSeparationWindow() {
	const sep = separationFrom(SIRIUS_ICRF, moonGeocentric(NOW)[0])
	console.info('Current target-Moon separation (deg):', toDeg(sep))
}

// Target Sun Separation Window.
function targetSunSeparationWindow() {
	const sep = separationFrom(SIRIUS_ICRF, geocentricSun())
	console.info('Current target-Sun separation (deg):', toDeg(sep))
}

// Target Airmass Window.
// TODO(almanac): the time a target spends below an airmass limit follows from the
// altitude threshold (airmass 2 ~ altitude 30deg); reuse targetAboveAltitudeWindow.
function targetAirmassWindow() {
	const h = hourAngleAtAltitude(SIRIUS_DEC, SITE.latitude, deg(30))
	console.info('Time below airmass ~2 per day (hours):', h === null ? 'never/always' : (2 * toHour(h)).toFixed(2))
}

// Heliacal Rising / Setting, Acronychal Rising, Cosmical Setting.
// TODO(almanac): these classical first/last-visibility events depend on the Sun's
// depression, the object's altitude and an arcus-visionis criterion. No finder is
// provided. Documented as not implemented.
function heliacalRising() {
	console.info('Heliacal rising: first dawn visibility (object rises just before the Sun); needs an arcus-visionis model. Not implemented.')
}

function heliacalSetting() {
	console.info('Heliacal setting: last dusk visibility (object sets just after the Sun); needs an arcus-visionis model. Not implemented.')
}

function acronychalRising() {
	console.info('Acronychal rising: object rises at sunset (opposition-like); needs the same visibility model. Not implemented.')
}

function cosmicalSetting() {
	console.info('Cosmical setting: object sets at sunrise; needs the same visibility model. Not implemented.')
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

// Horizon Mask Crossing.
// TODO(almanac): with a custom horizon profile (azimuth -> altitude), rise/set
// occur where the object's altitude crosses the local mask; needs sampling and an
// interpolated horizon. No horizon-mask utility is provided. Not implemented.
function horizonMaskCrossing() {
	console.info('Horizon mask crossing: compare object altitude against an azimuth->altitude mask; needs a horizon-profile utility. Not implemented.')
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
// TODO(almanac): the full path geometry (central line, north/south limits,
// rise/set curves) is produced by computeSolarEclipseMapGeometry; the greatest-
// eclipse circumstances (path width, central duration, Sun altitude) come from
// computeGreatestEclipseCircumstances. Per-item finders for shadow velocity and
// the partial limits are part of the same map module. We show the greatest-
// eclipse summary here.
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

// Lunar Eclipse Danjon Estimate.
// TODO(almanac): the Danjon L-value (0-4 brightness/colour scale) is an empirical
// visual estimate, not a computed quantity; the library models the geometry but
// not the atmosphere/colour. Not implemented.
function lunarEclipseDanjonEstimate() {
	console.info('Lunar eclipse Danjon L-value: empirical visual scale; not computed by the library.')
}

// Stellar / Asteroid / Lunar Occultation Prediction.
// TODO(almanac): no occultation predictor. Stellar/asteroid occultations need the
// shadow path of the occulting body across the Earth; lunar occultations need the
// Moon's topocentric limb vs the star. The small-body identify() endpoint (SBD)
// finds candidate occulters but does not predict tracks. Not implemented.
function stellarOccultationCircumstances() {
	console.info('Stellar occultation: predict from the occulter shadow path vs the observer; not implemented.')
}

function asteroidOccultationPrediction() {
	console.info('Asteroid occultation: project the asteroid shadow onto the Earth; not implemented.')
}

function lunarOccultationPrediction() {
	console.info('Lunar occultation: compare the Moon topocentric limb with the star; not implemented.')
}

// Planetary / Mercury / Venus Transit Prediction.
// TODO(almanac): transits of Mercury/Venus across the Sun are a Besselian-element
// problem analogous to solar eclipses, but no transit module exists. Not implemented.
function planetaryTransitPrediction() {
	console.info('Planetary transit: solve inner-planet conjunction with |ecliptic latitude| < Sun radius; not implemented.')
}

function mercuryTransitCircumstances() {
	console.info('Mercury transit circumstances: needs a transit module (Besselian-style); not implemented.')
}

function venusTransitCircumstances() {
	console.info('Venus transit circumstances: needs a transit module (Besselian-style); not implemented.')
}

// Mutual Satellite Event.
// TODO(almanac): mutual eclipses/occultations of Galilean (or Saturnian) moons need
// the satellite theories (L12/TASS17 are present) plus shadow/occultation geometry.
// The positions are available; the event geometry is not. Not implemented.
function mutualSatelliteEvent() {
	console.info('Mutual satellite event: positions available via L12/TASS17; event geometry not implemented.')
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

// Mean Anomaly to Eccentric Anomaly (Kepler's equation).
// TODO(almanac): the public surface exposes eccentricAnomaly(trueAnomaly, e) (the
// inverse direction). Solving Kepler's equation M -> E is done internally by the
// propagator; we Newton-iterate here to demonstrate the forward solution.
function meanAnomalyToEccentricAnomaly() {
	const M = deg(120)
	const e = 0.2
	let E = M
	for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
	console.info('Eccentric anomaly E (deg):', toDeg(E))
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
// TODO(almanac): KeplerOrbit.at() propagates using the universal-variable /
// Stumpff formulation internally; stumpff() is exported for the Stumpff functions.
// We propagate the sample orbit 100 days as the demonstration.
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
// TODO(almanac): the SBD adapter exposes closeApproaches() (network), but there is
// no local close-approach propagator. Documented as network-backed / not local.
function minorPlanetClosestApproach() {
	console.info('Minor planet closest approach: use the SBD closeApproaches() endpoint (network); no local propagator.')
}

// Minimum Orbit Intersection Distance (MOID).
// TODO(almanac): no MOID solver. It minimizes the distance between two orbits over
// both true anomalies (Gronchi's algebraic method or a sampled minimization). Not
// implemented.
function minimumOrbitIntersectionDistance() {
	console.info('MOID: minimize inter-orbit distance over both true anomalies; not implemented.')
}

// Tisserand Parameter (relative to Jupiter).
function tisserandParameterComputation() {
	const orbit = new KeplerOrbit(...asteroidKeplerOrbit().at(NOW), NOW)
	const JUPITER_SEMI_MAJOR_AXIS = 5.2044 // AU
	const T = tisserandParameter(orbit.semiMajorAxis, orbit.eccentricity, orbit.inclination, JUPITER_SEMI_MAJOR_AXIS)
	console.info('Tisserand parameter w.r.t. Jupiter:', T)
}

// Gauss Initial Orbit Determination.
// TODO(almanac): gauss() is available but needs three real angles-only observations
// with an Earth-position provider. Documented here; see gibbs/herrickGibbs below for
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
// TODO(almanac): fitOrbit(observations, epoch, position, velocity, options) performs
// the least-squares differential correction; it needs a set of RA/DEC observations
// and an initial state. Documented here to avoid fabricating an observation arc.
function differentialOrbitCorrection() {
	console.info('Differential orbit correction: fitOrbit(observations, epoch, position, velocity, options).')
}

// Orbit Covariance Propagation.
// TODO(almanac): fitOrbit returns a state covariance at the epoch; propagating it to
// another epoch needs the state-transition matrix, which is not exposed. Not
// implemented beyond the epoch covariance from fitOrbit.
function orbitCovariancePropagation() {
	console.info('Orbit covariance propagation: fitOrbit yields the epoch covariance; STM-based propagation is not exposed.')
}

// Ephemeris Uncertainty Ellipse.
// TODO(almanac): the sky-plane error ellipse is the projection of the propagated
// covariance onto (RA, DEC); needs covariance propagation (above). Not implemented.
function ephemerisUncertaintyEllipse() {
	console.info('Ephemeris uncertainty ellipse: project the propagated covariance onto the sky plane; not implemented.')
}

// Close Approach B-Plane.
// TODO(almanac): the b-plane (target plane) coordinates of a planetary encounter
// need a hyperbolic-flyby reduction relative to the planet. Not implemented.
function closeApproachBPlane() {
	console.info('Close approach b-plane: reduce the hyperbolic flyby to target-plane (xi, zeta); not implemented.')
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

// Satellite Pass Prediction / Rise, Culmination, Set.
// TODO(almanac): no pass finder. A pass is bracketed where the topocentric altitude
// crosses 0; culmination is the altitude maximum. Build by sampling sgp4 + the
// observer transform over the visibility window and root-finding. Not implemented.
function satellitePassPrediction() {
	console.info('Satellite pass prediction: sample topocentric altitude from sgp4 and bracket the 0deg crossings; not implemented.')
}
function satelliteRiseCulminationSet() {
	console.info('Satellite rise/culmination/set: altitude 0-crossings and the altitude maximum from the sampled pass; not implemented.')
}

// Satellite Ground Track: sub-satellite geographic point.
function satelliteGroundTrack() {
	const [p] = sgp4(SAT_TIME, recordFromTLE(ISS_TLE))
	const ecef = temeToItrf(p, SAT_TIME)
	// subpoint expects a geocentric vector in Earth radii.
	const sub = subpoint([toKilometer(ecef[0]) / EARTH_RADIUS_KM, toKilometer(ecef[1]) / EARTH_RADIUS_KM, toKilometer(ecef[2]) / EARTH_RADIUS_KM], SAT_TIME)
	console.info('ISS sub-point lon/lat (deg):', toDeg(sub.longitude), toDeg(sub.latitude))
}

// Satellite Illumination State.
// TODO(almanac): determining sunlit vs eclipsed needs the satellite position vs the
// Earth's cylindrical/conical shadow (Sun direction from VSOP). The geometry inputs
// exist; the shadow test is not packaged. Not implemented.
function satelliteIlluminationState() {
	console.info('Satellite illumination: test the satellite against the Earth umbra/penumbra using the Sun direction; not implemented.')
}

// Satellite Shadow Entry and Exit.
// TODO(almanac): the umbra entry/exit times are the shadow-boundary crossings along
// the orbit; needs the shadow model above plus root-finding. Not implemented.
function satelliteShadowEntryAndExit() {
	console.info('Satellite shadow entry/exit: root-find the umbra-boundary crossings; not implemented.')
}

// Satellite Angular Speed: topocentric angular rate (finite difference).
function satelliteAngularSpeed() {
	const rec = recordFromTLE(ISS_TLE)
	const a = temeToItrf(sgp4(SAT_TIME, rec)[0], SAT_TIME)
	const t2 = timeShift(SAT_TIME, 1 / DAYSEC)
	const b = temeToItrf(sgp4(t2, rec)[0], t2)
	console.info('ISS angular speed (deg/s):', toDeg(vecAngle(a, b)))
}

// Satellite Visual Magnitude Estimate.
// TODO(almanac): a standard-magnitude + phase-angle photometric model (like the
// McCants/standard-magnitude approach) is not provided. Not implemented.
function satelliteVisualMagnitudeEstimate() {
	console.info('Satellite visual magnitude: needs a standard-magnitude + phase-angle model; not implemented.')
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

// Satellite Conjunction Screening.
// TODO(almanac): screening two TLEs for close approach needs propagating both and
// minimizing their separation over time (a smart-sieve + fine search). Not provided.
function satelliteConjunctionScreening() {
	console.info('Satellite conjunction screening: propagate both objects and minimize range over the window; not implemented.')
}

// Geostationary Satellite Longitude: the sub-point longitude (ground track latitude ~0).
function geostationarySatelliteLongitude() {
	console.info('Geostationary longitude: equals the satellite sub-point longitude (see satelliteGroundTrack); near-constant for a GEO TLE.')
}

// Satellite Eclipse Duration.
// TODO(almanac): the time spent in the Earth's shadow per orbit; needs the shadow
// model and entry/exit crossings (above). Not implemented.
function satelliteEclipseDuration() {
	console.info('Satellite eclipse duration: integrate the in-shadow arc per orbit; needs the shadow model; not implemented.')
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
	inferiorConjunction()
	superiorConjunction()
	perihelionAndAphelion()
	ascendingAndDescendingNode()
	planetaryCentralMeridian()
	subObserverPoint()
	subSolarPoint()
	saturnRingOpeningAngle()
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
	lunarColongitude()
	lunarTerminatorPosition()
	lunarSubSolarPoint()
	lunarSubObserverPoint()
	lunarAscendingAndDescendingNodes()
	lunarPerigeeAndApogee()
	lunarStandstillExtremes()
	crescentMoonWidth()
	crescentMoonVisibility()

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
	heliacalRising()
	heliacalSetting()
	acronychalRising()
	cosmicalSetting()
	fieldRotationAngle()
	fieldRotationRate()
	parallacticAngleTimeSeries()
	horizonMaskCrossing()

	// Eclipses, Occultations, and Transits
	solarEclipseClassification()
	solarEclipseBesselianElements()
	localSolarEclipseCircumstances()
	solarEclipsePathSummary()
	lunarEclipseClassification()
	localLunarEclipseCircumstances()
	lunarEclipseMagnitude()
	lunarEclipseMoonAltitude()
	lunarEclipseDanjonEstimate()
	stellarOccultationCircumstances()
	asteroidOccultationPrediction()
	lunarOccultationPrediction()
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
}

run()
