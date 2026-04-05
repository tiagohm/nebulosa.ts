// parallax.js, Chapter 40, Correction for Parallax.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module parallax
 */
/**
 * Parallax: Chapter 40, Correction for Parallax.
 */

import * as base from './base.js'
import { Coord } from './base.js'
import * as globe from './globe.js'
import * as sidereal from './sidereal.js'
import { timeSec } from '../angle'

const horPar = (8.794 / 3600) * Math.PI / 180 // 8".794 arcseconds in radians

/**
 * Horizontal returns equatorial horizontal parallax of a body.
 *
 * @param {number} delta - distance in AU.
 * @return {number} parallax in radians.
 */
export function horizontal (delta) {
  // (40.1) p. 279
  return Math.asin(Math.sin(horPar) / delta)
  // return horPar / delta // with sufficient accuracy
}

/**
 * Topocentric returns topocentric positions including parallax.
 *
 * Arguments alpha, delta are geocentric right ascension and declination in radians.
 * delta is distance to the observed object in AU. rhosPhi, rhocPhi are parallax
 * constants (see package globe.) lon is geographic longitude of the observer,
 * jde is time of observation.
 *
 * @param {Coord} c - geocentric right ascension and declination in radians
 * @param {number} rhosPhi - parallax constants (see package globe.)
 * @param {number} rhocPhi - parallax constants (see package globe.)
 * @param {number} lon - geographic longitude of the observer (measured positively westwards!)
 * @param {number} jde - time of observation
 * @return {Coord} observed topocentric ra and dec in radians.
 */
export function topocentric (c, rhosPhi, rhocPhi, lon, jde) {
  const [alpha, declination, distance] = [c.ra, c.dec, c.range]
  const pi = horizontal(distance)
  const theta0 = timeSec(sidereal.apparent(jde))
  const H = base.pmod(theta0 - lon - alpha, 2 * Math.PI)
  const sPi = Math.sin(pi)
  const [sH, cH] = base.sincos(H)
  const [sDelta, cDelta] = base.sincos(declination)
  const deltaAlpha = Math.atan2(-rhocPhi * sPi * sH, cDelta - rhocPhi * sPi * cH) // (40.2) p. 279
  const alpha_ = alpha + deltaAlpha
  const delta_ = Math.atan2((sDelta - rhosPhi * sPi) * Math.cos(deltaAlpha), cDelta - rhocPhi * sPi * cH) // (40.3) p. 279
  return new Coord(alpha_, delta_)
}

/**
 * Topocentric2 returns topocentric corrections including parallax.
 *
 * This function implements the "non-rigorous" method descripted in the text.
 *
 * Note that results are corrections, not corrected coordinates.
 *
 * @param {Coord} c - geocentric right ascension and declination in radians
 * @param {number} rhosPhi - parallax constants (see package globe.)
 * @param {number} rhocPhi - parallax constants (see package globe.)
 * @param {number} lon - geographic longitude of the observer (measured positively westwards!)
 * @param {number} jde - time of observation
 * @return {Coord} observed topocentric ra and dec in radians.
 */
export function topocentric2 (c, rhosPhi, rhocPhi, lon, jde) {
  const [alpha, declination, distance] = [c.ra, c.dec, c.range]
  const pi = horizontal(distance)
  const theta0 = timeSec(sidereal.apparent(jde))
  const H = base.pmod(theta0 - lon - alpha, 2 * Math.PI)
  const [sH, cH] = base.sincos(H)
  const [sDelta, cDelta] = base.sincos(declination)
  const deltaAlpha = -pi * rhocPhi * sH / cDelta // (40.4) p. 280
  const deltaDelta = -pi * (rhosPhi * cDelta - rhocPhi * cH * sDelta) // (40.5) p. 280
  return new base.Coord(deltaAlpha, deltaDelta)
}

/**
 * Topocentric3 returns topocentric hour angle and declination including parallax.
 *
 * This function implements the "alternative" method described in the text.
 * The method should be similarly rigorous to that of Topocentric() and results
 * should be virtually consistent.
 *
 * @param {Coord} c - geocentric right ascension and declination in radians
 * @param {number} rhosPhi - parallax constants (see package globe.)
 * @param {number} rhocPhi - parallax constants (see package globe.)
 * @param {number} lon - geographic longitude of the observer (measured positively westwards!)
 * @param {number} jde - time of observation
 * @return {Array}
 *    {number} H_ - topocentric hour angle
 *    {number} delta_ - topocentric declination
 */
export function topocentric3 (c, rhosPhi, rhocPhi, lon, jde) {
  const [alpha, declination, distance] = [c.ra, c.dec, c.range]
  const pi = horizontal(distance)
  const theta0 = timeSec(sidereal.apparent(jde))
  const H = base.pmod(theta0 - lon - alpha, 2 * Math.PI)
  const sPi = Math.sin(pi)
  const [sH, cH] = base.sincos(H)
  const [sDelta, cDelta] = base.sincos(declination)
  const A = cDelta * sH
  const B = cDelta * cH - rhocPhi * sPi
  const C = sDelta - rhosPhi * sPi
  const q = Math.sqrt(A * A + B * B + C * C)
  const H_ = Math.atan2(A, B)
  const delta_ = Math.asin(C / q)
  return [H_, delta_]
}

/**
 * TopocentricEcliptical returns topocentric ecliptical coordinates including parallax.
 *
 * Arguments `c` are geocentric ecliptical longitude and latitude of a body,
 * s is its geocentric semidiameter. phi, h are the observer's latitude and
 * and height above the ellipsoid in meters.  epsilon is the obliquity of the
 * ecliptic, theta is local sidereal time, pi is equatorial horizontal parallax
 * of the body (see Horizonal()).
 *
 * All angular parameters and results are in radians.
 *
 * @param {Coord} c - geocentric right ascension and declination in radians
 * @param {number} s - geocentric semidiameter of `c`
 * @param {number} phi - observer's latitude
 * @param {number} h - observer's height above the ellipsoid in meters
 * @param {number} epsilon - is the obliquity of the ecliptic
 * @param {number} theta - local sidereal time
 * @param {number} pi - equatorial horizontal parallax of the body
 * @return {Array}
 *    {number} lambda_ - observed topocentric longitude
 *    {number} beta_ - observed topocentric latitude
 *    {number} s_ - observed topocentric semidiameter
 */
export function topocentricEcliptical (c, s, phi, h, epsilon, theta, pi) {
  const [lambda, beta] = [c.lon, c.lat]
  const [S, C] = globe.Earth76.parallaxConstants(phi, h)
  const [sLambda, cLambda] = base.sincos(lambda)
  const [sBeta, cBeta] = base.sincos(beta)
  const [sEpsilon, cEpsilon] = base.sincos(epsilon)
  const [sTheta, cTheta] = base.sincos(theta)
  const sPi = Math.sin(pi)
  const N = cLambda * cBeta - C * sPi * cTheta
  let lambda_ = Math.atan2(sLambda * cBeta - sPi * (S * sEpsilon + C * cEpsilon * sTheta), N)
  if (lambda_ < 0) {
    lambda_ += 2 * Math.PI
  }
  const cLambda_ = Math.cos(lambda_)
  const beta_ = Math.atan(cLambda_ * (sBeta - sPi * (S * cEpsilon - C * sEpsilon * sTheta)) / N)
  const s_ = Math.asin(cLambda_ * Math.cos(beta_) * Math.sin(s) / N)
  return [lambda_, beta_, s_]
}
