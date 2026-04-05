// solarxyz.js, Chapter 26, Rectangular Coordinates of the Sun.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module solarxyz
 */
/**
 * Solarxyz: Chapter 26, Rectangular Coordinates of the Sun.
 */
import * as base from './base.js'
import * as nutation from './nutation.js'
import * as solar from './solar.js'

/**
 * Position returns rectangular coordinates referenced to the mean equinox of date.
 * @param {planetposition.Planet} earth - VSOP87Planet Earth
 * @param {Number} jde - Julian ephemeris day
 * @return {object} rectangular coordinates
 *   {Number} x
 *   {Number} y
 *   {Number} z
 */
export function position (earth, jde) { // (e *pp.V87Planet, jde float64)  (x, y, z float64)
  // (26.1) p. 171
  const { lon, lat, range } = solar.trueVSOP87(earth, jde)
  const [sEpsilon, cEpsilon] = base.sincos(nutation.meanObliquity(jde))
  const [ss, cs] = base.sincos(lon)
  const sBeta = Math.sin(lat)
  const x = range * cs
  const y = range * (ss * cEpsilon - sBeta * sEpsilon)
  const z = range * (ss * sEpsilon + sBeta * cEpsilon)
  return { x, y, z }
}

/**
 * LongitudeJ2000 returns geometric longitude referenced to equinox J2000.
 * @param {planetposition.Planet} earth - VSOP87Planet Earth
 * @param {Number} jde - Julian ephemeris day
 * @return {Number} geometric longitude referenced to equinox J2000.
 */
export function longitudeJ2000 (earth, jde) {
  const lon = earth.position2000(jde).lon
  return base.pmod(lon + Math.PI - 0.09033 / 3600 * Math.PI / 180, 2 * Math.PI)
}

/**
 * PositionJ2000 returns rectangular coordinates referenced to equinox J2000.
 * @param {planetposition.Planet} earth - VSOP87Planet Earth
 * @param {Number} jde - Julian ephemeris day
 * @return {object} rectangular coordinates
 *   {Number} x
 *   {Number} y
 *   {Number} z
 */
export function positionJ2000 (earth, jde) {
  const { x, y, z } = xyz(earth, jde)
  // (26.3) p. 174
  return {
    x: x + 0.00000044036 * y - 0.000000190919 * z,
    y: -0.000000479966 * x + 0.917482137087 * y - 0.397776982902 * z,
    z: 0.397776982902 * y + 0.917482137087 * z
  }
}

export function xyz (earth, jde) {
  const { lon, lat, range } = earth.position2000(jde)
  const s = lon + Math.PI
  const beta = -lat
  const [ss, cs] = base.sincos(s)
  const [sBeta, cBeta] = base.sincos(beta)
  // (26.2) p. 172
  const x = range * cBeta * cs
  const y = range * cBeta * ss
  const z = range * sBeta
  return { x, y, z }
}

/**
 * PositionB1950 returns rectangular coordinates referenced to B1950.
 *
 * Results are referenced to the mean equator and equinox of the epoch B1950
 * in the FK5 system, not FK4.
 *
 * @param {planetposition.Planet} earth - VSOP87Planet Earth
 * @param {Number} jde - Julian ephemeris day
 * @return {object} rectangular coordinates
 *   {Number} x
 *   {Number} y
 *   {Number} z
 */
export function positionB1950 (earth, jde) { // (e *pp.V87Planet, jde float64)  (x, y, z float64)
  const { x, y, z } = xyz(earth, jde)
  return {
    x: 0.999925702634 * x + 0.012189716217 * y + 0.000011134016 * z,
    y: -0.011179418036 * x + 0.917413998946 * y - 0.397777041885 * z,
    z: -0.004859003787 * x + 0.397747363646 * y + 0.917482111428 * z
  }
}

const zetat = [2306.2181, 0.30188, 0.017998]
const zt = [2306.2181, 1.09468, 0.018203]
const thetat = [2004.3109, -0.42665, -0.041833]

/**
 * PositionEquinox returns rectangular coordinates referenced to an arbitrary epoch.
 *
 * Position will be computed for given Julian day "jde" but referenced to mean
 * equinox "epoch" (year).
 *
 * @param {planetposition.Planet} earth - VSOP87Planet Earth
 * @param {Number} jde - Julian ephemeris day
 * @param {Number} epoch
 * @return {object} rectangular coordinates
 *   {Number} x
 *   {Number} y
 *   {Number} z
 */
export function positionEquinox (earth, jde, epoch) {
  const xyz = positionJ2000(earth, jde)
  const x0 = xyz.x
  const y0 = xyz.y
  const z0 = xyz.z
  const t = (epoch - 2000) * 0.01
  const zeta = base.horner(t, zetat) * t * Math.PI / 180 / 3600
  const z = base.horner(t, zt) * t * Math.PI / 180 / 3600
  const theta = base.horner(t, thetat) * t * Math.PI / 180 / 3600
  const [sZeta, cZeta] = base.sincos(zeta)
  const [sz, cz] = base.sincos(z)
  const [sTheta, cTheta] = base.sincos(theta)
  const xx = cZeta * cz * cTheta - sZeta * sz
  const xy = sZeta * cz + cZeta * sz * cTheta
  const xz = cZeta * sTheta
  const yx = -cZeta * sz - sZeta * cz * cTheta
  const yy = cZeta * cz - sZeta * sz * cTheta
  const yz = -sZeta * sTheta
  const zx = -cz * sTheta
  const zy = -sz * sTheta
  const zz = cTheta
  return {
    x: xx * x0 + yx * y0 + zx * z0,
    y: xy * x0 + yy * y0 + zy * z0,
    z: xz * x0 + yz * y0 + zz * z0
  }
}
