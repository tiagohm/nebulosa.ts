// binary.js, Chapter 57, Binary Stars
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module binary
 */
/**
 * Binary: Chapter 57, Binary Stars
 */
import * as base from './base.js'
const atan = Math.atan
const atan2 = Math.atan2
const cos = Math.cos
const sqrt = Math.sqrt
const tan = Math.tan

/**
 * computes mean anomaly for the given date.
 *
 * @param {Number} year - is a decimal year specifying the date
 * @param {Number} T - is time of periastron, as a decimal year
 * @param {Number} P - is period of revolution in mean solar years
 * @returns {Number} mean anomaly in radians.
 */
export function meanAnomaly (year, T, P) { // (year, T, P float64)  float64
  const n = 2 * Math.PI / P
  return base.pmod(n * (year - T), 2 * Math.PI)
}

/**
 * Position computes apparent position angle and angular distance of
 * components of a binary star.
 *
 * @param {Number} a - is apparent semimajor axis in arc seconds
 * @param {Number} e - is eccentricity of the true orbit
 * @param {Number} i - is inclination relative to the line of sight
 * @param {Number} ascendingNode - is position angle of the ascending node
 * @param {Number} periastron - is longitude of periastron
 * @param {Number} E - is eccentric anomaly, computed for example with package kepler
 *  and the mean anomaly as returned by function M in this package.
 * @returns {Number[]} [theta, rho]
 *  {Number} theta -is the apparent position angle in radians,
 *  {Number} rho is the angular distance in arc seconds.
 */
export function position (a, e, i, ascendingNode, periastron, E) { // (a, e, i, ascendingNode, periastron, E float64)  (theta, rho float64)
  const r = a * (1 - e * cos(E))
  const nu = 2 * atan(sqrt((1 + e) / (1 - e)) * tan(E / 2))
  const [sinNuOmega, cosNuOmega] = base.sincos(nu + periastron)
  const cosi = cos(i)
  const num = sinNuOmega * cosi
  let theta = atan2(num, cosNuOmega) + ascendingNode
  if (theta < 0) {
    theta += 2 * Math.PI
  }
  const rho = r * sqrt(num * num + cosNuOmega * cosNuOmega)
  return [theta, rho]
}

/**
 * ApparentEccentricity returns apparent eccenticity of a binary star
 * given true orbital elements.
 *
 * @param {Number} e - is eccentricity of the true orbit
 * @param {Number} i - is inclination relative to the line of sight
 * @param {Number} omega - is longitude of periastron
 * @returns {Number} apparent eccenticity of a binary star
 */
export function apparentEccentricity (e, i, omega) { // (e, i, omega float64)  float64
  const cosi = cos(i)
  const [sinOmega, cosOmega] = base.sincos(omega)
  const A = (1 - e * e * cosOmega * cosOmega) * cosi * cosi
  const B = e * e * sinOmega * cosOmega * cosi
  const C = 1 - e * e * sinOmega * sinOmega
  const d = A - C
  const sqrtD = sqrt(d * d + 4 * B * B)
  return sqrt(2 * sqrtD / (A + C + sqrtD))
}
