// saturnring.js, Chapter 45, The Ring of Saturn
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module saturnring
 */
/**
 * Saturnrings: Chapter 45, The Ring of Saturn
 */

import * as base from './base.js'
import * as coord from './coord.js'
import * as nutation from './nutation.js'
import * as planetposition from './planetposition.js'

/**
 * Ring computes quantities of the ring of Saturn.
 *
 *  B  Saturnicentric latitude of the Earth referred to the plane of the ring.
 *  Bʹ  Saturnicentric latitude of the Sun referred to the plane of the ring.
 *  deltaU  Difference between Saturnicentric longitudes of the Sun and the Earth.
 *  P  Geometric position angle of the northern semiminor axis of the ring.
 *  aEdge  Major axis of the out edge of the outer ring.
 *  bEdge  Minor axis of the out edge of the outer ring.
 *
 * All results in radians.
 */
export function ring (jde, earth, saturn) { // (jde float64, earth, saturn *pp.V87Planet)  (B, Bʹ, deltaU, P, aEdge, bEdge float64)
  const [f1, f2] = cl(jde, earth, saturn)
  const [deltaU, B] = f1()
  const [Bʹ, P, aEdge, bEdge] = f2()
  return [B, Bʹ, deltaU, P, aEdge, bEdge]
}

/**
 * UB computes quantities required by illum.Saturn().
 *
 * Same as deltaU and B returned by Ring().  Results in radians.
 */
export function ub (jde, earth, saturn) { // (jde float64, earth, saturn *pp.V87Planet)  (deltaU, B float64)
  const [f1, f2] = cl(jde, earth, saturn) // eslint-disable-line no-unused-vars
  return f1()
}

/**
 * cl splits the work into two closures.
 */
function cl (jde, earth, saturn) { // (jde float64, earth, saturn *pp.V87Planet)  (f1 func() (deltaU, B float64),
  // f2 func() (Bʹ, P, aEdge, bEdge float64))
  const p = Math.PI / 180
  let i, omega
  let l0, b0, R
  let delta = 9.0
  let lambda, beta
  let si, ci, sBeta, cBeta, sB
  let sbʹ, cbʹ, slʹomega, clʹomega
  const f1 = function () { // (deltaU, B float64)
    // (45.1), p. 318
    const T = base.J2000Century(jde)
    i = base.horner(T, 28.075216 * p, -0.012998 * p, 0.000004 * p)
    omega = base.horner(T, 169.50847 * p, 1.394681 * p, 0.000412 * p)
    // Step 2.0
    const earthPos = earth.position(jde)
    R = earthPos.range
    const fk5 = planetposition.toFK5(earthPos.lon, earthPos.lat, jde)
    l0 = fk5.lon
    b0 = fk5.lat
    const [sl0, cl0] = base.sincos(l0)
    const sb0 = Math.sin(b0)
    // Steps 3, 4.0
    let l = 0
    let b = 0
    let r = 0
    let x = 0
    let y = 0
    let z = 0

    const f = function () {
      const tau = base.lightTime(delta)
      const saturnPos = saturn.position(jde - tau)
      r = saturnPos.range
      const fk5 = planetposition.toFK5(saturnPos.lon, saturnPos.lat, jde)
      l = fk5.lon
      b = fk5.lat
      const [sl, cl] = base.sincos(l)
      const [sb, cb] = base.sincos(b)
      x = r * cb * cl - R * cl0
      y = r * cb * sl - R * sl0
      z = r * sb - R * sb0
      delta = Math.sqrt(x * x + y * y + z * z)
    }
    f()
    f()
    // Step 5.0
    lambda = Math.atan2(y, x)
    beta = Math.atan(z / Math.hypot(x, y))
    // First part of step 6.0
    si = Math.sin(i)
    ci = Math.cos(i)
    sBeta = Math.sin(beta)
    cBeta = Math.cos(beta)
    sB = si * cBeta * Math.sin(lambda - omega) - ci * sBeta
    const B = Math.asin(sB) // return value
    // Step 7.0
    const N = 113.6655 * p + 0.8771 * p * T
    const lʹ = l - 0.01759 * p / r
    const bʹ = b - 0.000764 * p * Math.cos(l - N) / r
    // Setup for steps 8, 9.0
    sbʹ = Math.sin(bʹ)
    cbʹ = Math.cos(bʹ)
    slʹomega = Math.sin(lʹ - omega)
    clʹomega = Math.cos(lʹ - omega)
    // Step 9.0
    const [sLambdaOmega, cLambdaOmega] = base.sincos(lambda - omega)
    const U1 = Math.atan2(si * sbʹ + ci * cbʹ * slʹomega, cbʹ * clʹomega)
    const U2 = Math.atan2(si * sBeta + ci * cBeta * sLambdaOmega, cBeta * cLambdaOmega)
    const deltaU = Math.abs(U1 - U2) // return value
    return [deltaU, B]
  }
  const f2 = function () { // (Bʹ, P, aEdge, bEdge) {
    // Remainder of step 6.0
    const aEdge = 375.35 / 3600 * p / delta // return value
    const bEdge = aEdge * Math.abs(sB) // return value
    // Step 8.0
    const sBʹ = si * cbʹ * slʹomega - ci * sbʹ
    const Bʹ = Math.asin(sBʹ) // return value
    // Step 10.0
    const [deltaPsi, deltaEpsilon] = nutation.nutation(jde)
    const epsilon = nutation.meanObliquity(jde) + deltaEpsilon
    // Step 11.0
    let lambda0 = omega - Math.PI / 2
    const beta0 = Math.PI / 2 - i
    // Step 12.0
    const [sl0Lambda, cl0Lambda] = base.sincos(l0 - lambda)
    lambda += 0.005693 * p * cl0Lambda / cBeta
    beta += 0.005693 * p * sl0Lambda * sBeta
    // Step 13.0
    lambda0 += deltaPsi
    lambda += deltaPsi
    // Step 14.0
    let eq = new coord.Ecliptic(lambda0, beta0).toEquatorial(epsilon)
    const [alpha0, delta0] = [eq.ra, eq.dec]
    eq = new coord.Ecliptic(lambda, beta).toEquatorial(epsilon)
    const [alpha, delta] = [eq.ra, eq.dec]
    // Step 15.0
    const [sDelta0, cDelta0] = base.sincos(delta0)
    const [sDelta, cDelta] = base.sincos(delta)
    const [sAlpha0Alpha, cAlpha0Alpha] = base.sincos(alpha0 - alpha)
    const P = Math.atan2(cDelta0 * sAlpha0Alpha, sDelta0 * cDelta - cDelta0 * sDelta * cAlpha0Alpha) // return value
    return [Bʹ, P, aEdge, bEdge]
  }
  return [f1, f2]
}
