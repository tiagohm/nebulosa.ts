import { expect, test } from 'bun:test'
// oxfmt-ignore
import { apparentMeteorRadiantHorizontal, apparentZenithAngleFromGeocentric, associateMeteorTrack, geocentricMeteorRadiantFromHorizontal, geocentricZenithAngleFromApparent, meteorGeocentricRadius, meteorRadiantWithEarthRotation, meteorSpeedAtDistance, meteorSpeedAtGeodeticAltitude, meteorTrackDirectionCompatible, meteorTrackGreatCircle, meteorTrackLength, meteorTrackPoint, meteorTrackPositionAngle, meteorRadiantTrackResidual, meteorZenithAttraction } from '../../../src/astronomy/meteors/trajectory'
import { Ellipsoid } from '../../../src/astronomy/observer/location'
import { deg, toDeg } from '../../../src/math/units/angle'
import { meter, toKilometer } from '../../../src/math/units/distance'
import { kilometerPerSecond, toKilometerPerSecond } from '../../../src/math/units/velocity'
import { ENTRY_ALTITUDE, METEOR_SPEED, OBSERVER, SITE_EPOCH } from './util'

const RADIANT = { rightAscension: deg(100), declination: deg(-20) } as const
const TRACK = { start: { rightAscension: deg(10), declination: deg(5) }, end: { rightAscension: deg(40), declination: deg(20) } } as const

test('speed and entry radius use AU/day, AU and the selected ellipsoid', () => {
	expect(toKilometerPerSecond(meteorSpeedAtDistance(kilometerPerSecond(20), 1))).toBeCloseTo(20.00013322352317, 12)
	expect(toKilometer(meteorGeocentricRadius(0, meter(100), Ellipsoid.WGS84))).toBeCloseTo(6378.237, 9)
	expect(toKilometer(meteorGeocentricRadius(deg(45), meter(100), Ellipsoid.IERS2010))).toBeCloseTo(6367.58911540201, 9)
	expect(meteorSpeedAtGeodeticAltitude(METEOR_SPEED, deg(-23.55), ENTRY_ALTITUDE, Ellipsoid.WGS84)).toBeCloseTo(meteorSpeedAtDistance(METEOR_SPEED, meteorGeocentricRadius(deg(-23.55), ENTRY_ALTITUDE, Ellipsoid.WGS84)), 14)
})

test('Schiaparelli attraction is invertible and rejects invalid zenith angles', () => {
	const entrySpeed = meteorSpeedAtGeodeticAltitude(METEOR_SPEED, OBSERVER.latitude, ENTRY_ALTITUDE, Ellipsoid.WGS84)
	const apparent = deg(45)
	const attraction = meteorZenithAttraction(apparent, METEOR_SPEED, entrySpeed)
	const geocentric = geocentricZenithAngleFromApparent(apparent, METEOR_SPEED, entrySpeed)

	expect(toDeg(attraction)).toBeCloseTo(3.1788106730326215, 10)
	expect(toDeg(geocentric)).toBeCloseTo(48.17881067303262, 10)
	expect(apparentZenithAngleFromGeocentric(geocentric, METEOR_SPEED, entrySpeed)).toBeCloseTo(apparent, 11)
	expect(apparentZenithAngleFromGeocentric(deg(-1), METEOR_SPEED, entrySpeed)).toBeUndefined()
	expect(apparentZenithAngleFromGeocentric(deg(91), METEOR_SPEED, entrySpeed)).toBeUndefined()
})

test('gravity correction changes a visible horizontal radiant and round-trips without refraction', () => {
	const corrected = apparentMeteorRadiantHorizontal(RADIANT, OBSERVER, SITE_EPOCH, { geocentricSpeed: METEOR_SPEED, entryAltitude: ENTRY_ALTITUDE, ellipsoid: Ellipsoid.WGS84 })
	expect(corrected).toBeDefined()
	expect(corrected!.altitude).toBeGreaterThan(0)
	expect(corrected!.altitude).toBeGreaterThan(0.296)

	const recovered = geocentricMeteorRadiantFromHorizontal(corrected!, OBSERVER, SITE_EPOCH, { geocentricSpeed: METEOR_SPEED, entryAltitude: ENTRY_ALTITUDE, ellipsoid: Ellipsoid.WGS84 })
	expect(recovered!.rightAscension).toBeCloseTo(RADIANT.rightAscension, 11)
	expect(recovered!.declination).toBeCloseTo(RADIANT.declination, 11)
	expect(apparentMeteorRadiantHorizontal({ rightAscension: 0, declination: deg(-20) }, OBSERVER, SITE_EPOCH, { geocentricSpeed: METEOR_SPEED, entryAltitude: ENTRY_ALTITUDE })).toBeUndefined()
	expect(geocentricMeteorRadiantFromHorizontal({ azimuth: 0, altitude: 0 }, OBSERVER, SITE_EPOCH, { geocentricSpeed: METEOR_SPEED, entryAltitude: ENTRY_ALTITUDE })).toBeUndefined()
})

test('Earth rotation produces a unit topocentric incoming radiant', () => {
	const corrected = meteorRadiantWithEarthRotation(RADIANT, METEOR_SPEED, OBSERVER, SITE_EPOCH)!
	expect(corrected.rightAscension).not.toBe(RADIANT.rightAscension)
	expect(corrected.declination).not.toBe(RADIANT.declination)
	const cosDeclination = Math.cos(corrected.declination)
	expect(Math.hypot(cosDeclination * Math.cos(corrected.rightAscension), cosDeclination * Math.sin(corrected.rightAscension), Math.sin(corrected.declination))).toBeCloseTo(1, 14)
})

test('great-circle geometry interpolates, measures residuals and checks direction', () => {
	const pole = meteorTrackGreatCircle(TRACK)!
	expect(Math.hypot(...pole)).toBeCloseTo(1, 14)
	expect(meteorRadiantTrackResidual(TRACK.start, TRACK)).toBeCloseTo(0, 14)
	expect(meteorTrackLength(TRACK)).toBeCloseTo(0.5725725597937834, 10)
	expect(meteorTrackDirectionCompatible({ rightAscension: 0, declination: 0 }, TRACK)).toBe(true)
	expect(meteorTrackDirectionCompatible({ rightAscension: deg(50), declination: deg(20) }, TRACK)).toBe(false)

	const midpoint = meteorTrackPoint(TRACK, 0.5)!
	expect(toDeg(midpoint.rightAscension)).toBeCloseTo(24.5519, 3)
	expect(toDeg(midpoint.declination)).toBeCloseTo(12.926, 3)

	const quarterEquator = { start: { rightAscension: 0, declination: 0 }, end: { rightAscension: deg(90), declination: 0 } } as const
	expect(toDeg(meteorTrackLength(quarterEquator)!)).toBeCloseTo(90, 12)
	expect(toDeg(meteorTrackPoint(quarterEquator, 0.5)!.rightAscension)).toBeCloseTo(45, 12)
})

test('track position angle and aggregate association handle wrap and direction', () => {
	expect(toDeg(meteorTrackPositionAngle({ rightAscension: deg(359), declination: 0 }, { rightAscension: deg(1), declination: 0 }))).toBeCloseTo(90, 12)
	const equatorial = { start: { rightAscension: deg(10), declination: 0 }, end: { rightAscension: deg(40), declination: 0 } } as const
	const aligned = associateMeteorTrack({ rightAscension: 0, declination: 0 }, equatorial, {
		maximumCrossTrackError: deg(0.1),
		maximumRadiantDistance: deg(15),
		requireDirectionCompatibility: true,
	})
	expect(aligned.compatible).toBe(true)
	expect(aligned.crossTrackError).toBeCloseTo(0, 14)
	expect(toDeg(aligned.radiantDistance)).toBeCloseTo(10, 12)
	expect(aligned.directionCompatible).toBe(true)

	const reversedTrack = { start: equatorial.end, end: equatorial.start }
	const reversed = associateMeteorTrack({ rightAscension: 0, declination: 0 }, reversedTrack)
	expect(reversed.compatible).toBe(false)
	expect(reversed.directionCompatible).toBe(false)
	expect(associateMeteorTrack({ rightAscension: 0, declination: 0 }, reversedTrack, { requireDirectionCompatibility: false }).compatible).toBe(true)
	const offCircle = associateMeteorTrack({ rightAscension: 0, declination: deg(20) }, equatorial, { maximumCrossTrackError: deg(5) })
	expect(offCircle.compatible).toBe(false)
	expect(toDeg(offCircle.crossTrackError)).toBeCloseTo(20, 12)
})

test('coincident and antipodal trails are explicitly degenerate', () => {
	const coincident = { start: RADIANT, end: RADIANT } as const
	const antipodal = { start: { rightAscension: 0, declination: 0 }, end: { rightAscension: deg(180), declination: 0 } } as const
	for (const track of [coincident, antipodal]) {
		expect(meteorTrackGreatCircle(track)).toBeUndefined()
		expect(meteorTrackLength(track)).toBeUndefined()
		expect(meteorTrackPoint(track, 0.5)).toBeUndefined()
		expect(meteorTrackDirectionCompatible(RADIANT, track)).toBeUndefined()
	}
})
