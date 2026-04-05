// eqtime.js, Chapter 28, Equation of time.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module eqtime
 */
/**
 * Eqtime: Chapter 28, Equation of time.
 */

import * as base from './base.js'
import * as coord from './coord.js'
import * as nutation from './nutation.js'
import * as solar from './solar.js'
const cos = Math.cos
const sin = Math.sin
const tan = Math.tan

/**
 * e computes the "equation of time" for the given JDE.
 *
 * Parameter planet must be a planetposition.Planet object for Earth obtained
 * with `new planetposition.Planet('earth')`.
 *
 * @param {Number} jde - Julian ephemeris day
 * @param {planetposition.Planet} earth - VSOP87 planet
 * @returns {Number} equation of time as an hour angle in radians.
 */
export function e (jde, earth) {
  const tau = base.J2000Century(jde) * 0.1
  const L0 = l0(tau)
  // code duplicated from solar.ApparentEquatorialVSOP87 so that
  // we can keep deltaPsi and cEpsilon
  const { lon, lat, range } = solar.trueVSOP87(earth, jde)
  const [deltaPsi, deltaEpsilon] = nutation.nutation(jde)
  const a = -20.4898 / 3600 * Math.PI / 180 / range
  const lambda = lon + deltaPsi + a
  const epsilon = nutation.meanObliquity(jde) + deltaEpsilon
  const eq = new coord.Ecliptic(lambda, lat).toEquatorial(epsilon)
  // (28.1) p. 183
  const E = L0 - 0.0057183 * Math.PI / 180 - eq.ra + deltaPsi * cos(epsilon)
  return base.pmod(E + Math.PI, 2 * Math.PI) - Math.PI
}

/**
 * (28.2) p. 183
 */
const l0 = function (tau) {
  return base.horner(tau, 280.4664567, 360007.6982779, 0.03032028,
    1.0 / 49931, -1.0 / 15300, -1.0 / 2000000) * Math.PI / 180
}

/**
 * eSmart computes the "equation of time" for the given JDE.
 *
 * Result is less accurate that e() but the function has the advantage
 * of not requiring the V87Planet object.
 *
 * @param {Number} jde - Julian ephemeris day
 * @returns {Number} equation of time as an hour angle in radians.
 */
export function eSmart (jde) {
  const epsilon = nutation.meanObliquity(jde)
  const t = tan(epsilon * 0.5)
  const y = t * t
  const T = base.J2000Century(jde)
  const L0 = l0(T * 0.1)
  const e = solar.eccentricity(T)
  const M = solar.meanAnomaly(T)
  const [sin2L0, cos2L0] = base.sincos(2 * L0)
  const sinM = sin(M)
  // (28.3) p. 185
  return y * sin2L0 - 2 * e * sinM + 4 * e * y * sinM * cos2L0 -
    y * y * sin2L0 * cos2L0 - 1.25 * e * e * sin(2 * M)
}
