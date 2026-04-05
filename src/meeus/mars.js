// mars.js, Chapter 42, Ephemeris for Physical Observations of Mars.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module mars
 */
/**
 * Mars: Chapter 42, Ephemeris for Physical Observations of Mars.
 */

import * as base from './base.js'
import * as coord from './coord.js'
import * as illum from './illum.js'
import * as nutation from './nutation.js'
import * as planetposition from './planetposition.js'
import { Planet } from './planetposition.js'

/**
 * Physical computes quantities for physical observations of Mars.
 *
 * Results:
 *  DE  planetocentric declination of the Earth.
 *  DS  planetocentric declination of the Sun.
 *  omega   Areographic longitude of the central meridian, as seen from Earth.
 *  P   Geocentric position angle of Mars' northern rotation pole.
 *  Q   Position angle of greatest defect of illumination.
 *  d   Apparent diameter of Mars.
 *  k   Illuminated fraction of the disk.
 *  q   Greatest defect of illumination.
 *
 * All angular results (all results except k) are in radians.
 *
 * @param {number} jde - Julian ephemeris day
 * @param {Planet} earth
 * @param {Planet} mars
 */
export function physical (jde, earth, mars) { // (jde float64, earth, mars *pp.V87Planet)  (DE, DS, omega, P, Q, d, k, q float64)
  // Step 1.0
  const T = base.J2000Century(jde)
  const p = Math.PI / 180
  // (42.1) p. 288
  let lambda0 = 352.9065 * p + 1.1733 * p * T
  const beta0 = 63.2818 * p - 0.00394 * p * T
  // Step 2.0
  const earthPos = earth.position(jde)
  const R = earthPos.range
  const fk5 = planetposition.toFK5(earthPos.lon, earthPos.lat, jde)
  const [l0, b0] = [fk5.lon, fk5.lat]
  // Steps 3, 4.0
  const [sl0, cl0] = base.sincos(l0)
  const sb0 = Math.sin(b0)
  let distance = 0.5 // surely better than 0.0
  let tau = base.lightTime(distance)
  let l = 0
  let b = 0
  let r = 0
  let x = 0
  let y = 0
  let z = 0

  function f () {
    const marsPos = mars.position(jde - tau)
    r = marsPos.range
    const fk5 = planetposition.toFK5(marsPos.lon, marsPos.lat, jde)
    l = fk5.lon
    b = fk5.lat
    const [sb, cb] = base.sincos(b)
    const [sl, cl] = base.sincos(l)
    // (42.2) p. 289
    x = r * cb * cl - R * cl0
    y = r * cb * sl - R * sl0
    z = r * sb - R * sb0
    // (42.3) p. 289
    distance = Math.sqrt(x * x + y * y + z * z)
    tau = base.lightTime(distance)
  }

  f()
  f()
  // Step 5.0
  let lambda = Math.atan2(y, x)
  let beta = Math.atan(z / Math.hypot(x, y))
  // Step 6.0
  const [sBeta0, cBeta0] = base.sincos(beta0)
  const [sBeta, cBeta] = base.sincos(beta)
  const DE = Math.asin(-sBeta0 * sBeta - cBeta0 * cBeta * Math.cos(lambda0 - lambda))
  // Step 7.0
  const N = 49.5581 * p + 0.7721 * p * T
  const lʹ = l - 0.00697 * p / r
  const bʹ = b - 0.000225 * p * Math.cos(l - N) / r
  // Step 8.0
  const [sbʹ, cbʹ] = base.sincos(bʹ)
  const DS = Math.asin(-sBeta0 * sbʹ - cBeta0 * cbʹ * Math.cos(lambda0 - lʹ))
  // Step 9.0
  const W = 11.504 * p + 350.89200025 * p * (jde - tau - 2433282.5)
  // Step 10.0
  const epsilon0 = nutation.meanObliquity(jde)
  const [sEpsilon0, cEpsilon0] = base.sincos(epsilon0)
  let eq = new coord.Ecliptic(lambda0, beta0).toEquatorial(epsilon0)
  const [alpha0, delta0] = [eq.ra, eq.dec]
  // Step 11.0
  const u = y * cEpsilon0 - z * sEpsilon0
  const v = y * sEpsilon0 + z * cEpsilon0
  const alpha = Math.atan2(u, x)
  const delta = Math.atan(v / Math.hypot(x, u))
  const [sDelta, cDelta] = base.sincos(delta)
  const [sDelta0, cDelta0] = base.sincos(delta0)
  const [sAlpha0Alpha, cAlpha0Alpha] = base.sincos(alpha0 - alpha)
  const zeta = Math.atan2(sDelta0 * cDelta * cAlpha0Alpha - sDelta * cDelta0, cDelta * sAlpha0Alpha)
  // Step 12.0
  const omega = base.pmod(W - zeta, 2 * Math.PI)
  // Step 13.0
  const [deltaPsi, deltaEpsilon] = nutation.nutation(jde)
  // Step 14.0
  const [sl0Lambda, cl0Lambda] = base.sincos(l0 - lambda)
  lambda += 0.005693 * p * cl0Lambda / cBeta
  beta += 0.005693 * p * sl0Lambda * sBeta
  // Step 15.0
  lambda0 += deltaPsi
  lambda += deltaPsi
  const epsilon = epsilon0 + deltaEpsilon
  // Step 16.0
  const [sEpsilon, cEpsilon] = base.sincos(epsilon)
  eq = new coord.Ecliptic(lambda0, beta0).toEquatorial(epsilon)
  const [alpha0ʹ, delta0ʹ] = [eq.ra, eq.dec]
  eq = new coord.Ecliptic(lambda, beta).toEquatorial(epsilon)
  const [alphaʹ, deltaʹ] = [eq.ra, eq.dec]
  // Step 17.0
  const [sDelta0ʹ, cDelta0ʹ] = base.sincos(delta0ʹ)
  const [sDeltaʹ, cDeltaʹ] = base.sincos(deltaʹ)
  const [sAlpha0ʹalphaʹ, cAlpha0ʹalphaʹ] = base.sincos(alpha0ʹ - alphaʹ)
  // (42.4) p. 290
  let P = Math.atan2(cDelta0ʹ * sAlpha0ʹalphaʹ, sDelta0ʹ * cDeltaʹ - cDelta0ʹ * sDeltaʹ * cAlpha0ʹalphaʹ)
  if (P < 0) {
    P += 2 * Math.PI
  }
  // Step 18.0
  const s = l0 + Math.PI
  const [ss, cs] = base.sincos(s)
  const alphas = Math.atan2(cEpsilon * ss, cs)
  const deltas = Math.asin(sEpsilon * ss)
  const [sDeltas, cDeltas] = base.sincos(deltas)
  const [sAlphasAlpha, cAlphasAlpha] = base.sincos(alphas - alpha)
  const chi = Math.atan2(cDeltas * sAlphasAlpha, sDeltas * cDelta - cDeltas * sDelta * cAlphasAlpha)
  const Q = chi + Math.PI
  // Step 19.0
  const d = 9.36 / 60 / 60 * Math.PI / 180 / distance
  const k = illum.fraction(r, distance, R)
  const q = (1 - k) * d
  return [DE, DS, omega, P, Q, d, k, q]
}
