// coord.js, Chapter 13, Transformation of Coordinates.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module coord
 */
/**
 * Coord: Chapter 13, Transformation of Coordinates.
 *
 * Transforms in this package are provided in two forms, function and method.
 * The results of the two forms should be identical.
 *
 * The function forms pass all arguments and results as single values.  These
 * forms are best used when you are transforming a single pair of coordinates
 * and wish to avoid memory allocation.
 *
 * The method forms take and return pointers to structs.  These forms are best
 * used when you are transforming multiple coordinates and can reuse one or
 * more of the structs.  In this case reuse of structs will minimize
 * allocations, and the struct pointers will pass more efficiently on the
 * stack.  These methods transform their arguments, placing the result in
 * the receiver.  The receiver is then returned for convenience.
 *
 * A number of the functions take sine and cosine of the obliquity of the
 * ecliptic.  This becomes an advantage when you doing multiple transformations
 * with the same obliquity.  The efficiency of computing sine and cosine once
 * and reuse these values far outweighs the overhead of passing one number as
 * opposed to two.
 */

import * as base from './base.js'
import { Coord as GlobeCoord } from './globe.js' // eslint-disable-line no-unused-vars
import { hms, timeSec, deg } from '../angle'

/**
 * @typedef {object} LonLat
 * @property {Number} lon - Longitude (lambda) in radians
 * @property {Number} lat - Latitude (beta) in radians
 */

/**
* Ecliptic coordinates are referenced to the plane of the ecliptic.
*/
export class Ecliptic {
  /**
   * IMPORTANT: Longitudes are measured *positively* westwards
   * e.g. Washington D.C. +77°04; Vienna -16°23'
   * @param {Number|LonLat} [lon] - Longitude (lambda) in radians
   * @param {Number} [lat] - Latitude (beta) in radians
   */
  constructor (lon, lat) {
    if (typeof lon === 'object') {
      lat = lon.lat
      lon = lon.lon
    }
    this.lon = lon || 0
    this.lat = lat || 0
  }

  /**
   * converts ecliptic coordinates to equatorial coordinates.
   * @param {Number} epsilon - Obliquity
   * @returns {Equatorial}
   */
  toEquatorial (epsilon) {
    const [epsilonsin, epsiloncos] = base.sincos(epsilon)
    const [sBeta, cBeta] = base.sincos(this.lat)
    const [sLambda, cLambda] = base.sincos(this.lon)
    let ra = Math.atan2(sLambda * epsiloncos - (sBeta / cBeta) * epsilonsin, cLambda) // (13.3) p. 93
    if (ra < 0) {
      ra += 2 * Math.PI
    }
    const dec = Math.asin(sBeta * epsiloncos + cBeta * epsilonsin * sLambda) // (13.4) p. 93
    return new Equatorial(ra, dec)
  }
}

/**
 * Equatorial coordinates are referenced to the Earth's rotational axis.
 */
export class Equatorial {
  /**
   * @param {Number} ra - (float) Right ascension (alpha) in radians
   * @param {Number} dec - (float) Declination (delta) in radians
   */
  constructor (ra = 0, dec = 0) {
    this.ra = ra
    this.dec = dec
  }

  /**
   * EqToEcl converts equatorial coordinates to ecliptic coordinates.
   * @param {Number} epsilon - Obliquity
   * @returns {Ecliptic}
   */
  toEcliptic (epsilon) {
    const [epsilonsin, epsiloncos] = base.sincos(epsilon)
    const [sAlpha, cAlpha] = base.sincos(this.ra)
    const [sDelta, cDelta] = base.sincos(this.dec)
    const lon = Math.atan2(sAlpha * epsiloncos + (sDelta / cDelta) * epsilonsin, cAlpha) // (13.1) p. 93
    const lat = Math.asin(sDelta * epsiloncos - cDelta * epsilonsin * sAlpha) // (13.2) p. 93
    return new Ecliptic(lon, lat)
  }

  /**
   * EqToHz computes Horizontal coordinates from equatorial coordinates.
   *
   * Argument g is the location of the observer on the Earth.  Argument st
   * is the sidereal time at Greenwich.
   *
   * Sidereal time must be consistent with the equatorial coordinates.
   * If coordinates are apparent, sidereal time must be apparent as well.
   *
   * @param {GlobeCoord} g - coordinates of observer on Earth
   * @param {Number} st - sidereal time at Greenwich at time of observation
   * @returns {Horizontal}
   */
  toHorizontal (g, st) {
    const H = timeSec(st) - g.lon - this.ra
    const [sH, cH] = base.sincos(H)
    const [sPhi, cPhi] = base.sincos(g.lat)
    const [sDelta, cDelta] = base.sincos(this.dec)
    const azimuth = Math.atan2(sH, cH * sPhi - (sDelta / cDelta) * cPhi) // (13.5) p. 93
    const altitude = Math.asin(sPhi * sDelta + cPhi * cDelta * cH) // (13.6) p. 93
    return new Horizontal(azimuth, altitude)
  }

  /**
   * EqToGal converts equatorial coordinates to galactic coordinates.
   *
   * Equatorial coordinates must be referred to the standard equinox of B1950.0.
   * For conversion to B1950, see package precess and utility functions in
   * package "common".
   *
   * @returns {Galactic}
   */
  toGalactic () {
    const [sdAlpha, cdAlpha] = base.sincos(galacticNorth1950.ra - this.ra)
    const [sgDelta, cgDelta] = base.sincos(galacticNorth1950.dec)
    const [sDelta, cDelta] = base.sincos(this.dec)
    const x = Math.atan2(sdAlpha, cdAlpha * sgDelta - (sDelta / cDelta) * cgDelta) // (13.7) p. 94
    // (galactic0Lon1950 + 1.5*math.Pi) = magic number of 303 deg
    const lon = (galactic0Lon1950 + 1.5 * Math.PI - x) % (2 * Math.PI) // (13.8) p. 94
    const lat = Math.asin(sDelta * sgDelta + cDelta * cgDelta * cdAlpha)
    return new Galactic(lon, lat)
  }
}

/**
 * Horizontal coordinates are referenced to the local horizon of an observer
 * on the surface of the Earth.
 * @param {Number} az - Azimuth (A) in radians
 * @param {Number} alt - Altitude (h) in radians
 */
export class Horizontal {
  constructor (az = 0, alt = 0) {
    this.az = az
    this.alt = alt
  }

  /**
   * transforms horizontal coordinates to equatorial coordinates.
   *
   * Sidereal time must be consistent with the equatorial coordinates.
   * If coordinates are apparent, sidereal time must be apparent as well.
   * @param {GlobeCoord} g - coordinates of observer on Earth (lat, lon)
   * @param {Number} st - sidereal time at Greenwich at time of observation.
   * @returns {Equatorial} (right ascension, declination)
   */
  toEquatorial (g, st) {
    const [sA, cA] = base.sincos(this.az)
    const [sh, ch] = base.sincos(this.alt)
    const [sPhi, cPhi] = base.sincos(g.lat)
    const H = Math.atan2(sA, cA * sPhi + sh / ch * cPhi)
    const ra = base.pmod(timeSec(st) - g.lon - H, 2 * Math.PI)
    const dec = Math.asin(sPhi * sh - cPhi * ch * cA)
    return new Equatorial(ra, dec)
  }
}

/**
 * Galactic coordinates are referenced to the plane of the Milky Way.
 * @param {Number} lon - Longitude (l) in radians
 * @param {Number} lat - Latitude (b) in radians
 */
export class Galactic {
  constructor (lon = 0, lat = 0) {
    this.lon = lon
    this.lat = lat
  }

  /**
   * GalToEq converts galactic coordinates to equatorial coordinates.
   *
   * Resulting equatorial coordinates will be referred to the standard equinox of
   * B1950.0.  For subsequent conversion to other epochs, see package precess and
   * utility functions in package meeus.
   *
   * @returns {Equatorial} (right ascension, declination)
   */
  toEquatorial () {
    // (-galactic0Lon1950 - math.Pi/2) = magic number of -123 deg
    const [sdLon, cdLon] = base.sincos(this.lon - galactic0Lon1950 - Math.PI / 2)
    const [sgDelta, cgDelta] = base.sincos(galacticNorth1950.dec)
    const [sb, cb] = base.sincos(this.lat)
    const y = Math.atan2(sdLon, cdLon * sgDelta - (sb / cb) * cgDelta)
    // (galacticNorth1950.RA.Rad() - math.Pi) = magic number of 12.25 deg
    const ra = base.pmod(y + galacticNorth1950.ra - Math.PI, 2 * Math.PI)
    const dec = Math.asin(sb * sgDelta + cb * cgDelta * cdLon)
    return new Equatorial(ra, dec)
  }
}

/**
* equatorial coords for galactic north
* IAU B1950.0 coordinates of galactic North Pole
*/
export const galacticNorth = new Equatorial(
  hms(12, 49, 0),
  27.4 * Math.PI / 180
)
export const galacticNorth1950 = galacticNorth

/**
* Galactic Longitude 0°
* Meeus gives 33 as the origin of galactic longitudes relative to the
* ascending node of of the galactic equator.  33 + 90 = 123, the IAU
* value for origin relative to the equatorial pole.
*/
export const galacticLon0 = 33 * Math.PI / 180
export const galactic0Lon1950 = galacticLon0
