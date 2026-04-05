// jupitermoons.js, Chapter 44, Positions of the Satellites of Jupiter.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module jupitermoons
 */
/**
 * Jupitermoons: Chapter 44, Positions of the Satellites of Jupiter.
 */

import * as base from './base.js'
import * as planetelements from './planetelements.js'
import * as solar from './solar.js'
import { Planet } from './planetposition.js' // eslint-disable-line no-unused-vars

// Moon names in order of position in Array
export const io = 0
export const europa = 1
export const ganymede = 2
export const callisto = 3

const k = [17295, 21819, 27558, 36548]

/**
 * XYZ used for returning coordinates of moons.
 * @param {number} x - in units of Jupiter radii
 * @param {number} y - in units of Jupiter radii
 * @param {number} z - in units of Jupiter radii
 */
function XYZ (x, y, z) {
  this.x = x
  this.y = y
  this.z = z
}

/**
 * Positions computes positions of moons of Jupiter.
 *
 * Returned coordinates are in units of Jupiter radii.
 *
 * @param {Number} jde - Julian ephemeris day
 * @return {Array} x, y, z - coordinates of the 4 Satellites of jupiter
 */
export function positions (jde) {
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
  const lambda = 34.35 * p + 0.083091 * p * d + 0.329 * p * sV + B
  const DS = 3.12 * p * Math.sin(lambda + 42.8 * p)
  const DE = DS - 2.22 * p * Math.sin(psi) * Math.cos(lambda + 22 * p) -
    1.3 * p * (r - delta) / delta * Math.sin(lambda - 100.5 * p)
  const dd = d - delta / 173
  const u1 = 163.8069 * p + 203.4058646 * p * dd + psi - B
  const u2 = 358.414 * p + 101.2916335 * p * dd + psi - B
  const u3 = 5.7176 * p + 50.234518 * p * dd + psi - B
  const u4 = 224.8092 * p + 21.48798 * p * dd + psi - B
  const G = 331.18 * p + 50.310482 * p * dd
  const H = 87.45 * p + 21.569231 * p * dd
  const [s212, c212] = base.sincos(2 * (u1 - u2))
  const [s223, c223] = base.sincos(2 * (u2 - u3))
  const [sG, cG] = base.sincos(G)
  const [sH, cH] = base.sincos(H)
  const c1 = 0.473 * p * s212
  const c2 = 1.065 * p * s223
  const c3 = 0.165 * p * sG
  const c4 = 0.843 * p * sH
  const r1 = 5.9057 - 0.0244 * c212
  const r2 = 9.3966 - 0.0882 * c223
  const r3 = 14.9883 - 0.0216 * cG
  const r4 = 26.3627 - 0.1939 * cH
  const sDE = Math.sin(DE)
  const cDE = Math.cos(DE)
  const xy = function (u, r) {
    const [su, cu] = base.sincos(u)
    return new XYZ(r * su, -r * cu * sDE, -r * cu * cDE)
  }
  return [xy(u1 + c1, r1), xy(u2 + c2, r2), xy(u3 + c3, r3), xy(u4 + c4, r4)]
}

/**
 * Positions computes positions of moons of Jupiter.
 *
 * High accuracy method based on theory "E5"  Results returned in
 * argument pos, which must not be undefined.  Returned coordinates in units
 * of Jupiter radii.
 *
 * @param {Number} jde - Julian ephemeris day
 * @param {Planet} earth - VSOP87 Planet earth
 * @param {Planet} jupiter - VSOP87 Planet jupiter
 * @param {Array} [pos] - reference to array of positions (same as return value)
 * @return {Array} x, y, z - coordinates of the 4 Satellites of jupiter
 */
export function e5 (jde, earth, jupiter, pos) {
  pos = pos || new Array(4)

  // variables assigned in following block
  let lambda0, beta0, t
  let delta = 5.0

  ;(function () {
    const { lon, lat, range } = solar.trueVSOP87(earth, jde)
    const [s, beta, R] = [lon, lat, range]
    const [ss, cs] = base.sincos(s)
    const sBeta = Math.sin(beta)
    let tau = base.lightTime(delta)
    let x = 0
    let y = 0
    let z = 0

    function f () {
      const { lon, lat, range } = jupiter.position(jde - tau)
      const [sl, cl] = base.sincos(lon)
      const [sb, cb] = base.sincos(lat)
      x = range * cb * cl + R * cs
      y = range * cb * sl + R * ss
      z = range * sb + R * sBeta
      delta = Math.sqrt(x * x + y * y + z * z)
      tau = base.lightTime(delta)
    }

    f()
    f()

    lambda0 = Math.atan2(y, x)
    beta0 = Math.atan(z / Math.hypot(x, y))
    t = jde - 2443000.5 - tau
  })()

  const p = Math.PI / 180
  const l1 = 106.07719 * p + 203.48895579 * p * t
  const l2 = 175.73161 * p + 101.374724735 * p * t
  const l3 = 120.55883 * p + 50.317609207 * p * t
  const l4 = 84.44459 * p + 21.571071177 * p * t
  const pi1 = 97.0881 * p + 0.16138586 * p * t
  const pi2 = 154.8663 * p + 0.04726307 * p * t
  const pi3 = 188.184 * p + 0.00712734 * p * t
  const pi4 = 335.2868 * p + 0.00184 * p * t
  const omega1 = 312.3346 * p - 0.13279386 * p * t
  const omega2 = 100.4411 * p - 0.03263064 * p * t
  const omega3 = 119.1942 * p - 0.00717703 * p * t
  const omega4 = 322.6186 * p - 0.00175934 * p * t
  const gamma = 0.33033 * p * Math.sin(163.679 * p + 0.0010512 * p * t) +
    0.03439 * p * Math.sin(34.486 * p - 0.0161731 * p * t)
  const phiLambda = 199.6766 * p + 0.1737919 * p * t
  let psi = 316.5182 * p - 0.00000208 * p * t
  const G = 30.23756 * p + 0.0830925701 * p * t + gamma
  const Gʹ = 31.97853 * p + 0.0334597339 * p * t
  const pi = 13.469942 * p

  const sigma1 = 0.47259 * p * Math.sin(2 * (l1 - l2)) +
    -0.03478 * p * Math.sin(pi3 - pi4) +
    0.01081 * p * Math.sin(l2 - 2 * l3 + pi3) +
    0.00738 * p * Math.sin(phiLambda) +
    0.00713 * p * Math.sin(l2 - 2 * l3 + pi2) +
    -0.00674 * p * Math.sin(pi1 + pi3 - 2 * pi - 2 * G) +
    0.00666 * p * Math.sin(l2 - 2 * l3 + pi4) +
    0.00445 * p * Math.sin(l1 - pi3) +
    -0.00354 * p * Math.sin(l1 - l2) +
    -0.00317 * p * Math.sin(2 * psi - 2 * pi) +
    0.00265 * p * Math.sin(l1 - pi4) +
    -0.00186 * p * Math.sin(G) +
    0.00162 * p * Math.sin(pi2 - pi3) +
    0.00158 * p * Math.sin(4 * (l1 - l2)) +
    -0.00155 * p * Math.sin(l1 - l3) +
    -0.00138 * p * Math.sin(psi + omega3 - 2 * pi - 2 * G) +
    -0.00115 * p * Math.sin(2 * (l1 - 2 * l2 + omega2)) +
    0.00089 * p * Math.sin(pi2 - pi4) +
    0.00085 * p * Math.sin(l1 + pi3 - 2 * pi - 2 * G) +
    0.00083 * p * Math.sin(omega2 - omega3) +
    0.00053 * p * Math.sin(psi - omega2)
  const sigma2 = 1.06476 * p * Math.sin(2 * (l2 - l3)) +
    0.04256 * p * Math.sin(l1 - 2 * l2 + pi3) +
    0.03581 * p * Math.sin(l2 - pi3) +
    0.02395 * p * Math.sin(l1 - 2 * l2 + pi4) +
    0.01984 * p * Math.sin(l2 - pi4) +
    -0.01778 * p * Math.sin(phiLambda) +
    0.01654 * p * Math.sin(l2 - pi2) +
    0.01334 * p * Math.sin(l2 - 2 * l3 + pi2) +
    0.01294 * p * Math.sin(pi3 - pi4) +
    -0.01142 * p * Math.sin(l2 - l3) +
    -0.01057 * p * Math.sin(G) +
    -0.00775 * p * Math.sin(2 * (psi - pi)) +
    0.00524 * p * Math.sin(2 * (l1 - l2)) +
    -0.0046 * p * Math.sin(l1 - l3) +
    0.00316 * p * Math.sin(psi - 2 * G + omega3 - 2 * pi) +
    -0.00203 * p * Math.sin(pi1 + pi3 - 2 * pi - 2 * G) +
    0.00146 * p * Math.sin(psi - omega3) +
    -0.00145 * p * Math.sin(2 * G) +
    0.00125 * p * Math.sin(psi - omega4) +
    -0.00115 * p * Math.sin(l1 - 2 * l3 + pi3) +
    -0.00094 * p * Math.sin(2 * (l2 - omega2)) +
    0.00086 * p * Math.sin(2 * (l1 - 2 * l2 + omega2)) +
    -0.00086 * p * Math.sin(5 * Gʹ - 2 * G + 52.225 * p) +
    -0.00078 * p * Math.sin(l2 - l4) +
    -0.00064 * p * Math.sin(3 * l3 - 7 * l4 + 4 * pi4) +
    0.00064 * p * Math.sin(pi1 - pi4) +
    -0.00063 * p * Math.sin(l1 - 2 * l3 + pi4) +
    0.00058 * p * Math.sin(omega3 - omega4) +
    0.00056 * p * Math.sin(2 * (psi - pi - G)) +
    0.00056 * p * Math.sin(2 * (l2 - l4)) +
    0.00055 * p * Math.sin(2 * (l1 - l3)) +
    0.00052 * p * Math.sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
    -0.00043 * p * Math.sin(l1 - pi3) +
    0.00041 * p * Math.sin(5 * (l2 - l3)) +
    0.00041 * p * Math.sin(pi4 - pi) +
    0.00032 * p * Math.sin(omega2 - omega3) +
    0.00032 * p * Math.sin(2 * (l3 - G - pi))
  const sigma3 = 0.1649 * p * Math.sin(l3 - pi3) +
    0.09081 * p * Math.sin(l3 - pi4) +
    -0.06907 * p * Math.sin(l2 - l3) +
    0.03784 * p * Math.sin(pi3 - pi4) +
    0.01846 * p * Math.sin(2 * (l3 - l4)) +
    -0.0134 * p * Math.sin(G) +
    -0.01014 * p * Math.sin(2 * (psi - pi)) +
    0.00704 * p * Math.sin(l2 - 2 * l3 + pi3) +
    -0.0062 * p * Math.sin(l2 - 2 * l3 + pi2) +
    -0.00541 * p * Math.sin(l3 - l4) +
    0.00381 * p * Math.sin(l2 - 2 * l3 + pi4) +
    0.00235 * p * Math.sin(psi - omega3) +
    0.00198 * p * Math.sin(psi - omega4) +
    0.00176 * p * Math.sin(phiLambda) +
    0.0013 * p * Math.sin(3 * (l3 - l4)) +
    0.00125 * p * Math.sin(l1 - l3) +
    -0.00119 * p * Math.sin(5 * Gʹ - 2 * G + 52.225 * p) +
    0.00109 * p * Math.sin(l1 - l2) +
    -0.001 * p * Math.sin(3 * l3 - 7 * l4 + 4 * pi4) +
    0.00091 * p * Math.sin(omega3 - omega4) +
    0.0008 * p * Math.sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
    -0.00075 * p * Math.sin(2 * l2 - 3 * l3 + pi3) +
    0.00072 * p * Math.sin(pi1 + pi3 - 2 * pi - 2 * G) +
    0.00069 * p * Math.sin(pi4 - pi) +
    -0.00058 * p * Math.sin(2 * l3 - 3 * l4 + pi4) +
    -0.00057 * p * Math.sin(l3 - 2 * l4 + pi4) +
    0.00056 * p * Math.sin(l3 + pi3 - 2 * pi - 2 * G) +
    -0.00052 * p * Math.sin(l2 - 2 * l3 + pi1) +
    -0.00050 * p * Math.sin(pi2 - pi3) +
    0.00048 * p * Math.sin(l3 - 2 * l4 + pi3) +
    -0.00045 * p * Math.sin(2 * l2 - 3 * l3 + pi4) +
    -0.00041 * p * Math.sin(pi2 - pi4) +
    -0.00038 * p * Math.sin(2 * G) +
    -0.00037 * p * Math.sin(pi3 - pi4 + omega3 - omega4) +
    -0.00032 * p * Math.sin(3 * l3 - 7 * l4 + 2 * pi3 + 2 * pi4) +
    0.0003 * p * Math.sin(4 * (l3 - l4)) +
    0.00029 * p * Math.sin(l3 + pi4 - 2 * pi - 2 * G) +
    -0.00028 * p * Math.sin(omega3 + psi - 2 * pi - 2 * G) +
    0.00026 * p * Math.sin(l3 - pi - G) +
    0.00024 * p * Math.sin(l2 - 3 * l3 + 2 * l4) +
    0.00021 * p * Math.sin(2 * (l3 - pi - G)) +
    -0.00021 * p * Math.sin(l3 - pi2) +
    0.00017 * p * Math.sin(2 * (l3 - pi3))
  const sigma4 = 0.84287 * p * Math.sin(l4 - pi4) +
    0.03431 * p * Math.sin(pi4 - pi3) +
    -0.03305 * p * Math.sin(2 * (psi - pi)) +
    -0.03211 * p * Math.sin(G) +
    -0.01862 * p * Math.sin(l4 - pi3) +
    0.01186 * p * Math.sin(psi - omega4) +
    0.00623 * p * Math.sin(l4 + pi4 - 2 * G - 2 * pi) +
    0.00387 * p * Math.sin(2 * (l4 - pi4)) +
    -0.00284 * p * Math.sin(5 * Gʹ - 2 * G + 52.225 * p) +
    -0.00234 * p * Math.sin(2 * (psi - pi4)) +
    -0.00223 * p * Math.sin(l3 - l4) +
    -0.00208 * p * Math.sin(l4 - pi) +
    0.00178 * p * Math.sin(psi + omega4 - 2 * pi4) +
    0.00134 * p * Math.sin(pi4 - pi) +
    0.00125 * p * Math.sin(2 * (l4 - G - pi)) +
    -0.00117 * p * Math.sin(2 * G) +
    -0.00112 * p * Math.sin(2 * (l3 - l4)) +
    0.00107 * p * Math.sin(3 * l3 - 7 * l4 + 4 * pi4) +
    0.00102 * p * Math.sin(l4 - G - pi) +
    0.00096 * p * Math.sin(2 * l4 - psi - omega4) +
    0.00087 * p * Math.sin(2 * (psi - omega4)) +
    -0.00085 * p * Math.sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
    0.00085 * p * Math.sin(l3 - 2 * l4 + pi4) +
    -0.00081 * p * Math.sin(2 * (l4 - psi)) +
    0.00071 * p * Math.sin(l4 + pi4 - 2 * pi - 3 * G) +
    0.00061 * p * Math.sin(l1 - l4) +
    -0.00056 * p * Math.sin(psi - omega3) +
    -0.00054 * p * Math.sin(l3 - 2 * l4 + pi3) +
    0.00051 * p * Math.sin(l2 - l4) +
    0.00042 * p * Math.sin(2 * (psi - G - pi)) +
    0.00039 * p * Math.sin(2 * (pi4 - omega4)) +
    0.00036 * p * Math.sin(psi + pi - pi4 - omega4) +
    0.00035 * p * Math.sin(2 * Gʹ - G + 188.37 * p) +
    -0.00035 * p * Math.sin(l4 - pi4 + 2 * pi - 2 * psi) +
    -0.00032 * p * Math.sin(l4 + pi4 - 2 * pi - G) +
    0.0003 * p * Math.sin(2 * Gʹ - 2 * G + 149.15 * p) +
    0.00029 * p * Math.sin(3 * l3 - 7 * l4 + 2 * pi3 + 2 * pi4) +
    0.00028 * p * Math.sin(l4 - pi4 + 2 * psi - 2 * pi) +
    -0.00028 * p * Math.sin(2 * (l4 - omega4)) +
    -0.00027 * p * Math.sin(pi3 - pi4 + omega3 - omega4) +
    -0.00026 * p * Math.sin(5 * Gʹ - 3 * G + 188.37 * p) +
    0.00025 * p * Math.sin(omega4 - omega3) +
    -0.00025 * p * Math.sin(l2 - 3 * l3 + 2 * l4) +
    -0.00023 * p * Math.sin(3 * (l3 - l4)) +
    0.00021 * p * Math.sin(2 * l4 - 2 * pi - 3 * G) +
    -0.00021 * p * Math.sin(2 * l3 - 3 * l4 + pi4) +
    0.00019 * p * Math.sin(l4 - pi4 - G) +
    -0.00019 * p * Math.sin(2 * l4 - pi3 - pi4) +
    -0.00018 * p * Math.sin(l4 - pi4 + G) +
    -0.00016 * p * Math.sin(l4 + pi3 - 2 * pi - 2 * G)
  const L1 = l1 + sigma1
  const L2 = l2 + sigma2
  const L3 = l3 + sigma3
  const L4 = l4 + sigma4

  // variables assigned in following block
  let I
  const X = new Array(5).fill(0)
  const Y = new Array(5).fill(0)
  const Z = new Array(5).fill(0)
  let R

  ;(function () {
    const L = [L1, L2, L3, L4]
    const B = [
      Math.atan(0.0006393 * Math.sin(L1 - omega1) +
        0.0001825 * Math.sin(L1 - omega2) +
        0.0000329 * Math.sin(L1 - omega3) +
        -0.0000311 * Math.sin(L1 - psi) +
        0.0000093 * Math.sin(L1 - omega4) +
        0.0000075 * Math.sin(3 * L1 - 4 * l2 - 1.9927 * sigma1 + omega2) +
        0.0000046 * Math.sin(L1 + psi - 2 * pi - 2 * G)),
      Math.atan(0.0081004 * Math.sin(L2 - omega2) +
        0.0004512 * Math.sin(L2 - omega3) +
        -0.0003284 * Math.sin(L2 - psi) +
        0.0001160 * Math.sin(L2 - omega4) +
        0.0000272 * Math.sin(l1 - 2 * l3 + 1.0146 * sigma2 + omega2) +
        -0.0000144 * Math.sin(L2 - omega1) +
        0.0000143 * Math.sin(L2 + psi - 2 * pi - 2 * G) +
        0.0000035 * Math.sin(L2 - psi + G) +
        -0.0000028 * Math.sin(l1 - 2 * l3 + 1.0146 * sigma2 + omega3)),
      Math.atan(0.0032402 * Math.sin(L3 - omega3) +
        -0.0016911 * Math.sin(L3 - psi) +
        0.0006847 * Math.sin(L3 - omega4) +
        -0.0002797 * Math.sin(L3 - omega2) +
        0.0000321 * Math.sin(L3 + psi - 2 * pi - 2 * G) +
        0.0000051 * Math.sin(L3 - psi + G) +
        -0.0000045 * Math.sin(L3 - psi - G) +
        -0.0000045 * Math.sin(L3 + psi - 2 * pi) +
        0.0000037 * Math.sin(L3 + psi - 2 * pi - 3 * G) +
        0.000003 * Math.sin(2 * l2 - 3 * L3 + 4.03 * sigma3 + omega2) +
        -0.0000021 * Math.sin(2 * l2 - 3 * L3 + 4.03 * sigma3 + omega3)),
      Math.atan(-0.0076579 * Math.sin(L4 - psi) +
        0.0044134 * Math.sin(L4 - omega4) +
        -0.0005112 * Math.sin(L4 - omega3) +
        0.0000773 * Math.sin(L4 + psi - 2 * pi - 2 * G) +
        0.0000104 * Math.sin(L4 - psi + G) +
        -0.0000102 * Math.sin(L4 - psi - G) +
        0.0000088 * Math.sin(L4 + psi - 2 * pi - 3 * G) +
        -0.0000038 * Math.sin(L4 + psi - 2 * pi - G))
    ]
    R = [
      5.90569 * (1 +
        -0.0041339 * Math.cos(2 * (l1 - l2)) +
        -0.0000387 * Math.cos(l1 - pi3) +
        -0.0000214 * Math.cos(l1 - pi4) +
        0.000017 * Math.cos(l1 - l2) +
        -0.0000131 * Math.cos(4 * (l1 - l2)) +
        0.0000106 * Math.cos(l1 - l3) +
        -0.0000066 * Math.cos(l1 + pi3 - 2 * pi - 2 * G)),
      9.39657 * (1 +
        0.0093848 * Math.cos(l1 - l2) +
        -0.0003116 * Math.cos(l2 - pi3) +
        -0.0001744 * Math.cos(l2 - pi4) +
        -0.0001442 * Math.cos(l2 - pi2) +
        0.0000553 * Math.cos(l2 - l3) +
        0.0000523 * Math.cos(l1 - l3) +
        -0.0000290 * Math.cos(2 * (l1 - l2)) +
        0.0000164 * Math.cos(2 * (l2 - omega2)) +
        0.0000107 * Math.cos(l1 - 2 * l3 + pi3) +
        -0.0000102 * Math.cos(l2 - pi1) +
        -0.0000091 * Math.cos(2 * (l1 - l3))),
      14.98832 * (1 +
        -0.0014388 * Math.cos(l3 - pi3) +
        -0.0007917 * Math.cos(l3 - pi4) +
        0.0006342 * Math.cos(l2 - l3) +
        -0.0001761 * Math.cos(2 * (l3 - l4)) +
        0.0000294 * Math.cos(l3 - l4) +
        -0.0000156 * Math.cos(3 * (l3 - l4)) +
        0.0000156 * Math.cos(l1 - l3) +
        -0.0000153 * Math.cos(l1 - l2) +
        0.000007 * Math.cos(2 * l2 - 3 * l3 + pi3) +
        -0.0000051 * Math.cos(l3 + pi3 - 2 * pi - 2 * G)),
      26.36273 * (1 +
        -0.0073546 * Math.cos(l4 - pi4) +
        0.0001621 * Math.cos(l4 - pi3) +
        0.0000974 * Math.cos(l3 - l4) +
        -0.0000543 * Math.cos(l4 + pi4 - 2 * pi - 2 * G) +
        -0.0000271 * Math.cos(2 * (l4 - pi4)) +
        0.0000182 * Math.cos(l4 - pi) +
        0.0000177 * Math.cos(2 * (l3 - l4)) +
        -0.0000167 * Math.cos(2 * l4 - psi - omega4) +
        0.0000167 * Math.cos(psi - omega4) +
        -0.0000155 * Math.cos(2 * (l4 - pi - G)) +
        0.0000142 * Math.cos(2 * (l4 - psi)) +
        0.0000105 * Math.cos(l1 - l4) +
        0.0000092 * Math.cos(l2 - l4) +
        -0.0000089 * Math.cos(l4 - pi - G) +
        -0.0000062 * Math.cos(l4 + pi4 - 2 * pi - 3 * G) +
        0.0000048 * Math.cos(2 * (l4 - omega4)))
    ]
    // p. 311
    const T0 = (jde - 2433282.423) / base.JulianCentury
    const P = (1.3966626 * p + 0.0003088 * p * T0) * T0
    for (const i in L) {
      L[i] += P
    }
    psi += P
    const T = (jde - base.J1900) / base.JulianCentury
    I = 3.120262 * p + 0.0006 * p * T
    for (const i in L) {
      const [sLPsi, cLPsi] = base.sincos(L[i] - psi)
      const [sB, cB] = base.sincos(B[i])
      X[i] = R[i] * cLPsi * cB
      Y[i] = R[i] * sLPsi * cB
      Z[i] = R[i] * sB
    }
  })()

  Z[4] = 1
  // p. 312
  const A = new Array(5).fill(0)
  const B = new Array(5).fill(0)
  const C = new Array(5).fill(0)
  const [sI, cI] = base.sincos(I)
  const omega = planetelements.node(planetelements.jupiter, jde)
  const [sOmega, cOmega] = base.sincos(omega)
  const [sPhi, cPhi] = base.sincos(psi - omega)
  const [si, ci] = base.sincos(planetelements.inc(planetelements.jupiter, jde))
  const [sLambda0, cLambda0] = base.sincos(lambda0)
  const [sBeta0, cBeta0] = base.sincos(beta0)

  for (const i in A) {
    let a0
    // step 1
    let a = X[i]
    let b = Y[i] * cI - Z[i] * sI
    let c = Y[i] * sI + Z[i] * cI
    // step 2
    a0 = a * cPhi - b * sPhi
    b = a * sPhi + b * cPhi
    a = a0
    // step 3
    const b0 = b * ci - c * si
    c = b * si + c * ci
    b = b0
    // step 4
    a0 = a * cOmega - b * sOmega
    b = a * sOmega + b * cOmega
    a = a0
    // step 5
    a0 = a * sLambda0 - b * cLambda0
    b = a * cLambda0 + b * sLambda0
    a = a0
    // step 6
    A[i] = a
    B[i] = c * sBeta0 + b * cBeta0
    C[i] = c * cBeta0 - b * sBeta0
  }
  const [sD, cD] = base.sincos(Math.atan2(A[4], C[4]))
  // p. 313
  for (let i = 0; i < 4; i++) {
    let x = A[i] * cD - C[i] * sD
    const y = A[i] * sD + C[i] * cD
    const z = B[i]
    // differential light time
    const d = x / R[i]
    x += Math.abs(z) / k[i] * Math.sqrt(1 - d * d)
    // perspective effect
    const W = delta / (delta + z / 2095)
    pos[i] = new XYZ(x * W, y * W, z)
  }
  return pos
}
