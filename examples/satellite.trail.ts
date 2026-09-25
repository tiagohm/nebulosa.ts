import { predictSatelliteTrails } from '../src/astronomy/events/satellite.trail'
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4'
import { timeShift, timeToDate, tt, utc } from '../src/astronomy/time/time'
import { DAYSEC } from '../src/core/constants'
import { arcsec, deg, toArcsec } from '../src/math/units/angle'

// Run with: bun run examples/satellite.trail.ts
// Historical ISS exposure from Sao Paulo; fixed elements valid near 2020-11-25, not a live forecast.
const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const satellite = recordFromTLE(tle)
const observer = geodeticLocation(deg(-46.6361), deg(-23.5475), 0, Ellipsoid.WGS84)
const epoch = tt(tle.epoch)

// Geometric topocentric center in ICRS-oriented axes, radians. No apparent-place corrections.
const trails = predictSatelliteTrails(satellite, observer, 2.821619372202283, -0.8419514025782707, { width: deg(0.1), height: deg(0.1), positionAngle: deg(40) }, timeShift(epoch, 3330 / DAYSEC), timeShift(epoch, 3334 / DAYSEC), {
	maxStep: 1, // SI seconds
	maxInterpolationError: arcsec(0.1),
	maxSamples: 65537,
	arcsecPerPixel: 2,
})

for (const trail of trails) {
	console.log({ entryUTC: timeToDate(utc(trail.entry.time)), exitUTC: timeToDate(utc(trail.exit.time)), lengthArcsec: toArcsec(trail.length), lengthPixels: trail.lengthPixels })
}
