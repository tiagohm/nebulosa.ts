// parallactic.js, Chapter 14, The Parallactic Angle, and three other Topics.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module parallactic
 */
/**
 * Parallactic: Chapter 14, The Parallactic Angle, and three other Topics.
 */

import * as base from './base.js'

/**
 * ParallacticAngle returns parallactic angle of a celestial object.
 *
 *  phi is geographic latitude of observer.
 *  delta is declination of observed object.
 *  H is hour angle of observed object.
 *
 * All angles including result are in radians.
 */
export function parallacticAngle (phi, delta, H) { // (phi, delta, H float64)  float64
  const [sDelta, cDelta] = base.sincos(delta)
  const [sH, cH] = base.sincos(H)
  return Math.atan2(sH, Math.tan(phi) * cDelta - sDelta * cH) // (14.1) p. 98
}

/**
 * ParallacticAngleOnHorizon is a special case of ParallacticAngle.
 *
 * The hour angle is not needed as an input and the math inside simplifies.
 */
export function parallacticAngleOnHorizon (phi, delta) { // (phi, delta float64)  float64
  return Math.acos(Math.sin(phi) / Math.cos(delta))
}

/**
 * EclipticAtHorizon computes how the plane of the ecliptic intersects
 * the horizon at a given local sidereal time as observed from a given
 * geographic latitude.
 *
 *  epsilon is obliquity of the ecliptic.
 *  phi is geographic latitude of observer.
 *  theta is local sidereal time expressed as an hour angle.
 *
 *  lambda1 and lambda2 are ecliptic longitudes where the ecliptic intersects the horizon.
 *  I is the angle at which the ecliptic intersects the horizon.
 *
 * All angles, arguments and results, are in radians.
 */
export function eclipticAtHorizon (epsilon, phi, theta) { // (epsilon, phi, theta float64)  (lambda1, lambda2, I float64)
  const [sEpsilon, cEpsilon] = base.sincos(epsilon)
  const [sPhi, cPhi] = base.sincos(phi)
  const [sTheta, cTheta] = base.sincos(theta)
  let lambda = Math.atan2(-cTheta, sEpsilon * (sPhi / cPhi) + cEpsilon * sTheta) // (14.2) p. 99
  if (lambda < 0) {
    lambda += Math.PI
  }
  return [lambda, lambda + Math.PI, Math.acos(cEpsilon * sPhi - sEpsilon * cPhi * sTheta)] // (14.3) p. 99
}

/**
 * EclipticAtEquator computes the angle between the ecliptic and the parallels
 * of ecliptic latitude at a given ecliptic longitude.
 *
 * (The function name EclipticAtEquator is for consistency with the Meeus text,
 * and works if you consider the equator a nominal parallel of latitude.)
 *
 *  lambda is ecliptic longitude.
 *  epsilon is obliquity of the ecliptic.
 *
 * All angles in radians.
 */
export function eclipticAtEquator (lambda, epsilon) { // (lambda, epsilon float64)  float64
  return Math.atan(-Math.cos(lambda) * Math.tan(epsilon))
}

/**
 * DiurnalPathAtHorizon computes the angle of the path a celestial object
 * relative to the horizon at the time of its rising or setting.
 *
 *  delta is declination of the object.
 *  phi is geographic latitude of observer.
 *
 * All angles in radians.
 */
export function diurnalPathAtHorizon (delta, phi) { // (delta, phi float64)  (J float64)
  const tPhi = Math.tan(phi)
  const b = Math.tan(delta) * tPhi
  const c = Math.sqrt(1 - b * b)
  return Math.atan(c * Math.cos(delta) / tPhi)
}
