// jupiter.js, Chapter 42, Ephemeris for Physical Observations of Jupiter.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module jupiter
 */
/**
 * Jupiter: Chapter 42, Ephemeris for Physical Observations of Jupiter.
 */

import * as base from './base.js'
import * as nutation from './nutation.js'
import * as planetposition from './planetposition.js'
import { Planet } from './planetposition.js'

/**
 * Physical computes quantities for physical observations of Jupiter.
 *
 * All angular results in radians.
 *
 * @param {number} jde - Julian ephemeris day
 * @param {Planet} earth
 * @param {Planet} jupiter
 * @return {Array}
 *    {number} DS - Planetocentric declination of the Sun.
 *    {number} DE - Planetocentric declination of the Earth.
 *    {number} omega1 - Longitude of the System I central meridian of the illuminated disk,
 *                  as seen from Earth.
 *    {number} omega2 - Longitude of the System II central meridian of the illuminated disk,
 *                  as seen from Earth.
 *    {number} P -  Geocentric position angle of Jupiter's northern rotation pole.
 */
export function physical (jde, earth, jupiter) { // (jde float64, earth, jupiter *pp.V87Planet)  (DS, DE, omega1, omega2, P float64)
  // Step 1.0
  const d = jde - 2433282.5
  const T1 = d / base.JulianCentury
  const p = Math.PI / 180
  const alpha0 = 268 * p + 0.1061 * p * T1
  const delta0 = 64.5 * p - 0.0164 * p * T1
  // Step 2.0
  const W1 = 17.71 * p + 877.90003539 * p * d
  const W2 = 16.838 * p + 870.27003539 * p * d
  // Step 3.0
  const pos = earth.position(jde)
  let [l0, b0, R] = [pos.lon, pos.lat, pos.range]
  const fk5 = planetposition.toFK5(l0, b0, jde)
  l0 = fk5.lon
  b0 = fk5.lat
  // Steps 4-7.
  const [sl0, cl0] = base.sincos(l0)
  const sb0 = Math.sin(b0)
  let distance = 4.0 // surely better than 0.0

  let l = 0
  let b = 0
  let r = 0
  let x = 0
  let y = 0
  let z = 0

  const f = function () {
    const tau = base.lightTime(distance)
    const pos = jupiter.position(jde - tau)
    l = pos.lon
    b = pos.lat
    r = pos.range
    const fk5 = planetposition.toFK5(l, b, jde)
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
  }
  f()
  f()

  // Step 8.0
  const epsilon0 = nutation.meanObliquity(jde)
  // Step 9.0
  const [sEpsilon0, cEpsilon0] = base.sincos(epsilon0)
  const [sl, cl] = base.sincos(l)
  const [sb, cb] = base.sincos(b)
  const alphas = Math.atan2(cEpsilon0 * sl - sEpsilon0 * sb / cb, cl)
  const deltas = Math.asin(cEpsilon0 * sb + sEpsilon0 * cb * sl)
  // Step 10.0
  const [sDeltas, cDeltas] = base.sincos(deltas)
  const [sDelta0, cDelta0] = base.sincos(delta0)
  const DS = Math.asin(-sDelta0 * sDeltas - cDelta0 * cDeltas * Math.cos(alpha0 - alphas))
  // Step 11.0
  const u = y * cEpsilon0 - z * sEpsilon0
  const v = y * sEpsilon0 + z * cEpsilon0
  let alpha = Math.atan2(u, x)
  let delta = Math.atan(v / Math.hypot(x, u))
  const [sDelta, cDelta] = base.sincos(delta)
  const [sAlpha0Alpha, cAlpha0Alpha] = base.sincos(alpha0 - alpha)
  const zeta = Math.atan2(sDelta0 * cDelta * cAlpha0Alpha - sDelta * cDelta0, cDelta * sAlpha0Alpha)
  // Step 12.0
  const DE = Math.asin(-sDelta0 * sDelta - cDelta0 * cDelta * Math.cos(alpha0 - alpha))
  // Step 13.0
  let omega1 = W1 - zeta - 5.07033 * p * distance
  let omega2 = W2 - zeta - 5.02626 * p * distance
  // Step 14.0
  let C = (2 * r * distance + R * R - r * r - distance * distance) / (4 * r * distance)
  if (Math.sin(l - l0) < 0) {
    C = -C
  }
  omega1 = base.pmod(omega1 + C, 2 * Math.PI)
  omega2 = base.pmod(omega2 + C, 2 * Math.PI)
  // Step 15.0
  const [deltaPsi, deltaEpsilon] = nutation.nutation(jde)
  const epsilon = epsilon0 + deltaEpsilon
  // Step 16.0
  const [sEpsilon, cEpsilon] = base.sincos(epsilon)
  const [sAlpha, cAlpha] = base.sincos(alpha)
  alpha += 0.005693 * p * (cAlpha * cl0 * cEpsilon + sAlpha * sl0) / cDelta
  delta += 0.005693 * p * (cl0 * cEpsilon * (sEpsilon / cEpsilon * cDelta - sAlpha * sDelta) + cAlpha * sDelta * sl0)
  // Step 17.0
  const tDelta = sDelta / cDelta
  const deltaAlpha = (cEpsilon + sEpsilon * sAlpha * tDelta) * deltaPsi - cAlpha * tDelta * deltaEpsilon
  const deltaDelta = sEpsilon * cAlpha * deltaPsi + sAlpha * deltaEpsilon
  const alphaʹ = alpha + deltaAlpha
  const deltaʹ = delta + deltaDelta
  const [sAlpha0, cAlpha0] = base.sincos(alpha0)
  const tDelta0 = sDelta0 / cDelta0
  const deltaAlpha0 = (cEpsilon + sEpsilon * sAlpha0 * tDelta0) * deltaPsi - cAlpha0 * tDelta0 * deltaEpsilon
  const deltaDelta0 = sEpsilon * cAlpha0 * deltaPsi + sAlpha0 * deltaEpsilon
  const alpha0ʹ = alpha0 + deltaAlpha0
  const delta0ʹ = delta0 + deltaDelta0
  // Step 18.0
  const [sDeltaʹ, cDeltaʹ] = base.sincos(deltaʹ)
  const [sDelta0ʹ, cDelta0ʹ] = base.sincos(delta0ʹ)
  const [sAlpha0ʹalphaʹ, cAlpha0ʹalphaʹ] = base.sincos(alpha0ʹ - alphaʹ)
  // (42.4) p. 290
  let P = Math.atan2(cDelta0ʹ * sAlpha0ʹalphaʹ, sDelta0ʹ * cDeltaʹ - cDelta0ʹ * sDeltaʹ * cAlpha0ʹalphaʹ)
  if (P < 0) {
    P += 2 * Math.PI
  }
  return [DS, DE, omega1, omega2, P]
}

/**
 * Physical2 computes quantities for physical observations of Jupiter.
 *
 * Results are less accurate than with Physical().
 * All angular results in radians.
 *
 * @param {number} jde - Julian ephemeris day
 * @return {Array}
 *    {number} DS - Planetocentric declination of the Sun.
 *    {number} DE - Planetocentric declination of the Earth.
 *    {number} omega1 - Longitude of the System I central meridian of the illuminated disk,
 *                  as seen from Earth.
 *    {number} omega2 - Longitude of the System II central meridian of the illuminated disk,
 *                  as seen from Earth.
 */
export function physical2 (jde) { // (jde float64)  (DS, DE, omega1, omega2 float64)
  const d = jde - base.J2000
  const p = Math.PI / 180
  const V = 172.74 * p + 0.00111588 * p * d
  const M = 357.529 * p + 0.9856003 * p * d
  const sV = Math.sin(V)
  const N = 20.02 * p + 0.0830853 * p * d + 0.329 * p * sV
  const J = 66.115 * p + 0.9025179 * p * d - 0.329 * p * sV
  const [sM, cM] = base.sincos(M)
  const [sN, cN] = base.sincos(N)
  const [s2M, c2M] = base.sincos(2 * M)
  const [s2N, c2N] = base.sincos(2 * N)
  const A = 1.915 * p * sM + 0.02 * p * s2M
  const B = 5.555 * p * sN + 0.168 * p * s2N
  const K = J + A - B
  const R = 1.00014 - 0.01671 * cM - 0.00014 * c2M
  const r = 5.20872 - 0.25208 * cN - 0.00611 * c2N
  const [sK, cK] = base.sincos(K)
  const delta = Math.sqrt(r * r + R * R - 2 * r * R * cK)
  const psi = Math.asin(R / delta * sK)
  const dd = d - delta / 173
  let omega1 = 210.98 * p + 877.8169088 * p * dd + psi - B
  let omega2 = 187.23 * p + 870.1869088 * p * dd + psi - B
  let C = Math.sin(psi / 2)
  C *= C
  if (sK > 0) {
    C = -C
  }
  omega1 = base.pmod(omega1 + C, 2 * Math.PI)
  omega2 = base.pmod(omega2 + C, 2 * Math.PI)
  const lambda = 34.35 * p + 0.083091 * p * d + 0.329 * p * sV + B
  const DS = 3.12 * p * Math.sin(lambda + 42.8 * p)
  const DE = DS - 2.22 * p * Math.sin(psi) * Math.cos(lambda + 22 * p) -
    1.3 * p * (r - delta) / delta * Math.sin(lambda - 100.5 * p)
  return [DS, DE, omega1, omega2]
}
