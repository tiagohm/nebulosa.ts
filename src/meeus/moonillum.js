// moonillum.js, Chapter 48, Illuminated Fraction of the Moon's Disk
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module moonillum
 */
/**
 * Moonillum: Chapter 48, Illuminated Fraction of the Moon's Disk
 *
 * Also see functions `illuminated` and `limb` in package base.  The function
 * for computing illuminated fraction given a phase angle (48.1) is
 * base.illuminated.  Formula (48.3) is implemented as base.limb.
 */

import * as base from './base.js'
import { Coord } from './base.js'

const D2R = Math.PI / 180

/**
 * phaseAngleEquatorial computes the phase angle of the Moon given equatorial coordinates.
 *
 * @param {Coord} cMoon - geocentric right ascension,  declination and distance to the Moon
 * @param {Coord} cSun - coordinates and distance of the Sun
 * @returns {number} phase angle of the Moon in radians
 */
export function phaseAngleEquatorial (cMoon, cSun) {
  return pa(cMoon.range, cSun.range, cosEq(cMoon.ra, cMoon.dec, cSun.ra, cSun.dec))
}

/**
 * cos elongation from equatorial coordinates
 * @private
 */
function cosEq (alpha, delta, alpha0, delta0) {
  const [sDelta, cDelta] = base.sincos(delta)
  const [sDelta0, cDelta0] = base.sincos(delta0)
  return sDelta0 * sDelta + cDelta0 * cDelta * Math.cos(alpha0 - alpha)
}

/**
 * phase angle from cos elongation and distances
 * @private
 * @param {number} delta
 * @param {number} R
 * @param {number} cPsi
 * @returns {number}
 */
function pa (delta, R, cPsi) {
  const sPsi = Math.sin(Math.acos(cPsi))
  let i = Math.atan(R * sPsi / (delta - R * cPsi))
  if (i < 0) {
    i += Math.PI
  }
  return i
}

/**
 * phaseAngleEquatorial2 computes the phase angle of the Moon given equatorial coordinates.
 *
 * Less accurate than phaseAngleEquatorial.
 *
 * Arguments alpha, delta are geocentric right ascension and declination of the Moon;
 * alpha0, delta0  are coordinates of the Sun.  Angles must be in radians.
 *
 * @param {Coord} cMoon - eocentric right ascension and declination of the Moon
 * @param {Coord} cSun - coordinates of the Sun
 * @returns {number} phase angle of the Moon in radians
 */
export function phaseAngleEquatorial2 (cMoon, cSun) {
  return Math.acos(-cosEq(cMoon.ra, cMoon.dec, cSun.ra, cSun.dec))
}

/**
 * phaseAngleEcliptic computes the phase angle of the Moon given ecliptic coordinates.
 *
 * Distances must be in the same units as each other.
 *
 * @param {Coord} cMoon - geocentric longitude, latitude and distance to the Moon
 * @param {Coord} cSun -  longitude and distance to the Sun
 * @returns {number} phase angle of the Moon in radians
 */
export function phaseAngleEcliptic (cMoon, cSun) {
  return pa(cMoon.range, cSun.range, cosEcl(cMoon.lon, cMoon.lat, cSun.lon))
}

/**
 * cos elongation from ecliptic coordinates
 * @private
 */
function cosEcl (lambda, beta, lambda0) { // (lambda, beta, lambda0 float64)  float64
  return Math.cos(beta) * Math.cos(lambda - lambda0)
}

/**
 * phaseAngleEcliptic2 computes the phase angle of the Moon given ecliptic coordinates.
 *
 * Less accurate than phaseAngleEcliptic.
 *
 * Angles must be in radians.
 *
 * @param {Coord} cMoon - geocentric longitude, latitude of the Moon
 * @param {Coord} cSun -  longitude of the Sun
 * @returns {number} phase angle of the Moon in radians
 */
export function phaseAngleEcliptic2 (cMoon, cSun) {
  return Math.acos(-cosEcl(cMoon.lon, cMoon.lat, cSun.lon))
}

/**
 * phaseAngle3 computes the phase angle of the Moon given a julian day.
 *
 * Less accurate than phaseAngle functions taking coordinates.
 *
 * Result in radians.
 */
export function phaseAngle3 (jde) { // (jde float64)  float64
  const T = base.J2000Century(jde)
  const D = base.horner(T, 297.8501921 * D2R, 445267.1114034 * D2R,
    -0.0018819 * D2R, D2R / 545868, -D2R / 113065000)
  const m = base.horner(T, 357.5291092 * D2R, 35999.0502909 * D2R,
    -0.0001536 * D2R, D2R / 24490000)
  const m_ = base.horner(T, 134.9633964 * D2R, 477198.8675055 * D2R,
    0.0087414 * D2R, D2R / 69699, -D2R / 14712000)
  return Math.PI - base.pmod(D, 2 * Math.PI) +
    -6.289 * D2R * Math.sin(m_) +
    2.1 * D2R * Math.sin(m) +
    -1.274 * D2R * Math.sin(2 * D - m_) +
    -0.658 * D2R * Math.sin(2 * D) +
    -0.214 * D2R * Math.sin(2 * m_) +
    -0.11 * D2R * Math.sin(D)
}
