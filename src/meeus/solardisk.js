// solardisk.js, Chapter 29, Ephemeris for Physical Observations of the Sun.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module solardisk
 */
/**
 * Solardisk: Chapter 29, Ephemeris for Physical Observations of the Sun.
 */

import * as base from './base.js'
import * as nutation from './nutation.js'
import * as solar from './solar.js'

/**
 * Ephemeris returns the apparent orientation of the sun at the given jd.
 *
 * Results:
 *  P:  Position angle of the solar north pole.
 *  B0: Heliographic latitude of the center of the solar disk.
 *  L0: Heliographic longitude of the center of the solar disk.
 *
 * All results in radians.
 */
export function ephemeris (jd, earth) { // (jd float64, e *pp.V87Planet)  (P, B0, L0 float64)
  const theta = (jd - 2398220) * 2 * Math.PI / 25.38
  const I = 7.25 * Math.PI / 180
  const K = 73.6667 * Math.PI / 180 +
    1.3958333 * Math.PI / 180 * (jd - 2396758) / base.JulianCentury

  const solarPos = solar.trueVSOP87(earth, jd)
  const L = solarPos.lon
  const R = solarPos.range
  const [deltaPsi, deltaEpsilon] = nutation.nutation(jd)
  const epsilon0 = nutation.meanObliquity(jd)
  const epsilon = epsilon0 + deltaEpsilon
  const lambda = L - 20.4898 / 3600 * Math.PI / 180 / R
  const lambdap = lambda + deltaPsi

  const [sLambdaK, cLambdaK] = base.sincos(lambda - K)
  const [sI, cI] = base.sincos(I)

  const tx = -Math.cos(lambdap) * Math.tan(epsilon)
  const ty = -cLambdaK * Math.tan(I)
  const P = Math.atan(tx) + Math.atan(ty)
  const B0 = Math.asin(sLambdaK * sI)
  const eta = Math.atan2(-sLambdaK * cI, -cLambdaK)
  const L0 = base.pmod(eta - theta, 2 * Math.PI)
  return [P, B0, L0]
}

/**
 * Cycle returns the jd of the start of the given synodic rotation.
 *
 * Argument c is the "Carrington" cycle number.
 *
 * Result is a dynamical time (not UT).
 */
export function cycle (c) { // (c int)  (jde float64)
  const jde = 2398140.227 + 27.2752316 * c
  const m = 281.96 * Math.PI / 180 + 26.882476 * Math.PI / 180 * c
  const [s2m, c2m] = base.sincos(2 * m)
  return jde + 0.1454 * Math.sin(m) - 0.0085 * s2m - 0.0141 * c2m
}
