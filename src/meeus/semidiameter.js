// semidiameter.js, Chapter 55, Semidiameters of the Sun, Moon, and Planets.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module semidiameter
 */
/**
 * Semidiameter: Chapter 55, Semidiameters of the Sun, Moon, and Planets.
 */
import * as base from './base.js'
import * as parallax from './parallax.js'

/* eslint-disable no-multi-spaces */
/**
 * Standard semidiameters at unit distance of 1 AU.
 * Values are scaled here to radians.
 */
export const Sun               = 959.63 / 3600 * Math.PI / 180
export const Mercury           = 3.36 / 3600 * Math.PI / 180
export const VenusSurface      = 8.34 / 3600 * Math.PI / 180
export const VenusCloud        = 8.41 / 3600 * Math.PI / 180
export const Mars              = 4.68 / 3600 * Math.PI / 180
export const JupiterEquatorial = 98.44 / 3600 * Math.PI / 180
export const JupiterPolar      = 92.06 / 3600 * Math.PI / 180
export const SaturnEquatorial  = 82.73 / 3600 * Math.PI / 180
export const SaturnPolar       = 73.82 / 3600 * Math.PI / 180
export const Uranus            = 35.02 / 3600 * Math.PI / 180
export const Neptune           = 33.50 / 3600 * Math.PI / 180
export const Pluto             = 2.07 / 3600 * Math.PI / 180
export const Moon              = 358473400 / base.AU / 3600 * Math.PI / 180
/* eslint-enable */

/**
 * Semidiameter returns semidiameter at specified distance.
 *
 * When used with S0 values provided, delta must be observer-body distance in AU.
 * Result will then be in radians.
 */
export function semidiameter (s0, delta) { // (s0, delta float64)  float64
  return s0 / delta
}

/**
 * SaturnApparentPolar returns apparent polar semidiameter of Saturn
 * at specified distance.
 *
 * Argument delta must be observer-Saturn distance in AU.  Argument B is
 * Saturnicentric latitude of the observer as given by function saturnring.UB()
 * for example.
 *
 * Result is semidiameter in units of package variables SaturnPolar and
 * SaturnEquatorial, nominally radians.
 */
export function saturnApparentPolar (delta, B) { // (delta, B float64)  float64
  let k = SaturnPolar / SaturnEquatorial
  k = 1 - k * k
  const cB = Math.cos(B)
  return SaturnEquatorial / delta * Math.sqrt(1 - k * cB * cB)
}

/**
 * MoonTopocentric returns observed topocentric semidiameter of the Moon.
 *
 *  distance is distance to Moon in AU.
 *  declination is declination of Moon in radians.
 *  H is hour angle of Moon in radians.
 *  rhosPhiʹ, rhocPhiʹ are parallax constants as returned by
 *      globe.Ellipsoid.ParallaxConstants, for example.
 *
 * Result is semidiameter in radians.
 */
export function moonTopocentric (distance, declination, H, rhosPhiʹ, rhocPhiʹ) { // (distance, declination, H, rhosPhiʹ, rhocPhiʹ float64)  float64
  const k = 0.272481
  const sPi = Math.sin(parallax.horizontal(distance))
  // q computed by (40.6, 40.7) p. 280, ch 40.0
  const [sDelta, cDelta] = base.sincos(declination)
  const [sH, cH] = base.sincos(H)
  const A = cDelta * sH
  const B = cDelta * cH - rhocPhiʹ * sPi
  const C = sDelta - rhosPhiʹ * sPi
  const q = Math.sqrt(A * A + B * B + C * C)
  return k / q * sPi
}

/**
 * MoonTopocentric2 returns observed topocentric semidiameter of the Moon
 * by a less rigorous method.
 *
 * delta is distance to Moon in AU, h is altitude of the Moon above the observer's
 * horizon in radians.
 *
 * Result is semidiameter in radians.
 */
export function moonTopocentric2 (delta, h) { // (delta, h float64)  float64
  return Moon / delta * (1 + Math.sin(h) * Math.sin(parallax.horizontal(delta)))
}

/**
 * AsteroidDiameter returns approximate diameter given absolute magnitude H
 * and albedo A.
 *
 * Result is in km.
 */
export function asteroidDiameter (H, A) { // (H, A float64)  float64
  return Math.pow(10, 3.12 - 0.2 * H - 0.5 * Math.log10(A))
}

/**
 * Asteroid returns semidiameter of an asteroid with a given diameter
 * at given distance.
 *
 * Argument d is diameter in km, delta is distance in AU.
 *
 * Result is semidiameter in radians.
 */
export function asteroid (d, delta) { // (d, delta float64)  float64
  return 0.0013788 * d / delta / 3600 * Math.PI / 180
}
