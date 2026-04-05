// precess.js, Chapter 21, Precession.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module precess
 */
/**
 * Precession: Chapter 21, Precession.
 *
 * Functions in this package take Julian epoch argurments rather than Julian
 * days.  Use base.JDEToJulianYear() to convert.
 *
 * Also in package base are some definitions related to the Besselian and
 * Julian Year.
 *
 * Partial:  Precession from FK4 not implemented.  Meeus gives no test cases.
 * It's a fair amount of code and data, representing significant chances for
 * errors.  And precession from FK4 would seem to be of little interest today.
 *
 * Proper motion units
 *
 * Meeus gives some example annual proper motions in units of seconds of
 * right ascension and seconds of declination.  To make units clear,
 * functions in this package take proper motions with argument types of
 * sexa.HourAngle and sexa.Angle respectively.  Error-prone conversions
 * can be avoided by using the constructors for these base types.
 *
 * For example, given an annual proper motion in right ascension of -0ˢ.03847,
 * rather than
 *
 * mra = -0.03847 / 13751 // as Meeus suggests
 *
 * or
 *
 * mra = -0.03847 * (15/3600) * (pi/180) // less magic
 *
 * use
 *
 * mra = new sexa.HourAngle(false, 0, 0, -0.03847)
 *
 * Unless otherwise indicated, functions in this library expect proper motions
 * to be annual proper motions, so the unit denominator is years.
 * (The code, following Meeus's example, technically treats it as Julian years.)
 */

import * as base from './base.js'
import { Equatorial, Ecliptic } from './coord.js'
import { Elements } from './elementequinox.js'
import * as nutation from './nutation.js'
import { signedDms, signedHms } from '../angle'

/**
 * approxAnnualPrecession returns approximate annual precision in right
 * ascension and declination.
 *
 * The two epochs should be within a few hundred years.
 * The declinations should not be too close to the poles.
 *
 * @param {Equatorial} eqFrom
 * @param {Number} epochFrom - use `base.JDEToJulianYear(year)` to get epoch
 * @param {Number} epochTo - use `base.JDEToJulianYear(year)` to get epoch
 * @returns {Object}
 *  {sexa.HourAngle} seconds of right ascension
 *  {sexa.Angle} seconds of Declination
 */
export function approxAnnualPrecession (eqFrom, epochFrom, epochTo) {
  const [m, na, nd] = mn(epochFrom, epochTo)
  const [sa, ca] = base.sincos(eqFrom.ra)
  // (21.1) p. 132
  const deltaAlphas = m + na * sa * Math.tan(eqFrom.dec) // seconds of RA
  const deltaDeltas = nd * ca // seconds of Dec
  const ra = signedHms(false, 0, 0, deltaAlphas)
  const dec = signedDms(false, 0, 0, deltaDeltas)
  return { ra, dec }
}

/**
 * @param {Number} epochFrom - use `base.JDEToJulianYear(year)` to get epoch
 * @param {Number} epochTo - use `base.JDEToJulianYear(year)` to get epoch
 * @returns {Number[]}
 */
export function mn (epochFrom, epochTo) {
  const T = (epochTo - epochFrom) * 0.01
  const m = 3.07496 + 0.00186 * T
  const na = 1.33621 - 0.00057 * T
  const nd = 20.0431 - 0.0085 * T
  return [m, na, nd]
}

/**
 * ApproxPosition uses ApproxAnnualPrecession to compute a simple and quick
 * precession while still considering proper motion.
 *
 * @param {Equatorial} eqFrom
 * @param {Number} epochFrom
 * @param {Number} epochTo
 * @param {Number} mAlpha - in radians
 * @param {Number} mDelta - in radians
 * @returns {Equatorial} eqTo
 */
export function approxPosition (eqFrom, epochFrom, epochTo, mAlpha, mDelta) {
  const { ra, dec } = approxAnnualPrecession(eqFrom, epochFrom, epochTo)
  const dy = epochTo - epochFrom
  const eqTo = new Equatorial()
  eqTo.ra = eqFrom.ra + (ra + mAlpha) * dy
  eqTo.dec = eqFrom.dec + (dec + mDelta) * dy
  return eqTo
}

// constants
const d = Math.PI / 180
const s = d / 3600

// coefficients from (21.2) p. 134
const zetaT = [2306.2181 * s, 1.39656 * s, -0.000139 * s]
const zT = [2306.2181 * s, 1.39656 * s, -0.000139 * s]
const thetaT = [2004.3109 * s, -0.8533 * s, -0.000217 * s]
// coefficients from (21.3) p. 134
const zetat = [2306.2181 * s, 0.30188 * s, 0.017998 * s]
const zt = [2306.2181 * s, 1.09468 * s, 0.018203 * s]
const thetat = [2004.3109 * s, -0.42665 * s, -0.041833 * s]

/**
 * Precessor represents precession from one epoch to another.
 *
 * Construct with NewPrecessor, then call method Precess.
 * After construction, Precess may be called multiple times to precess
 * different coordinates with the same initial and final epochs.
 */
export class Precessor {
  /**
   * constructs a Precessor object and initializes it to precess
   * coordinates from epochFrom to epochTo.
   * @param {Number} epochFrom
   * @param {Number} epochTo
   */
  constructor (epochFrom, epochTo) {
    // (21.2) p. 134
    let zetaCoeff = zetat
    let zCoeff = zt
    let thetaCoeff = thetat
    if (epochFrom !== 2000) {
      const T = (epochFrom - 2000) * 0.01
      zetaCoeff = [
        base.horner(T, ...zetaT),
        0.30188 * s - 0.000344 * s * T,
        0.017998 * s
      ]
      zCoeff = [
        base.horner(T, ...zT),
        1.09468 * s + 0.000066 * s * T,
        0.018203 * s
      ]
      thetaCoeff = [
        base.horner(T, ...thetaT),
        -0.42665 * s - 0.000217 * s * T,
        -0.041833 * s
      ]
    }
    const t = (epochTo - epochFrom) * 0.01
    this.zeta = base.horner(t, ...zetaCoeff) * t
    this.z = base.horner(t, ...zCoeff) * t
    const theta = base.horner(t, ...thetaCoeff) * t
    this.sTheta = Math.sin(theta)
    this.cTheta = Math.cos(theta)
  }

  /**
   * Precess precesses coordinates eqFrom, leaving result in eqTo.
   *
   * @param {Equatorial} eqFrom
   * @returns {Equatorial} eqTo
   */
  precess (eqFrom) {
    // (21.4) p. 134
    const [sDelta, cDelta] = base.sincos(eqFrom.dec)
    const [sAlphaZeta, cAlphaZeta] = base.sincos(eqFrom.ra + this.zeta)
    const A = cDelta * sAlphaZeta
    const B = this.cTheta * cDelta * cAlphaZeta - this.sTheta * sDelta
    const C = this.sTheta * cDelta * cAlphaZeta + this.cTheta * sDelta
    const eqTo = new Equatorial()
    eqTo.ra = Math.atan2(A, B) + this.z
    if (C < base.CosSmallAngle) {
      eqTo.dec = Math.asin(C)
    } else {
      eqTo.dec = Math.acos(Math.hypot(A, B)) // near pole
    }
    return eqTo
  }
}

/**
 * Position precesses equatorial coordinates from one epoch to another,
 * including proper motions.
 *
 * If proper motions are not to be considered or are not applicable, pass 0, 0
 * for mAlpha, mDelta
 *
 * Both eqFrom and eqTo must be non-nil, although they may point to the same
 * struct.  EqTo is returned for convenience.
 * @param {Equatorial} eqFrom
 * @param {Number} epochFrom
 * @param {Number} epochTo
 * @param {Number} mAlpha - in radians
 * @param {Number} mDelta - in radians
 * @returns {Equatorial} [eqTo]
 */
export function position (eqFrom, epochFrom, epochTo, mAlpha, mDelta) {
  const p = new Precessor(epochFrom, epochTo)
  const t = epochTo - epochFrom
  const eqTo = new Equatorial()
  eqTo.ra = eqFrom.ra + mAlpha * t
  eqTo.dec = eqFrom.dec + mDelta * t
  return p.precess(eqTo)
}

// coefficients from (21.5) p. 136
const etaT = [47.0029 * s, -0.06603 * s, 0.000598 * s]
const piT = [174.876384 * d, 3289.4789 * s, 0.60622 * s]
const pT = [5029.0966 * s, 2.22226 * s, -0.000042 * s]
const etat = [47.0029 * s, -0.03302 * s, 0.000060 * s]
const pit = [174.876384 * d, -869.8089 * s, 0.03536 * s]
const pt = [5029.0966 * s, 1.11113 * s, -0.000006 * s]

/**
 * EclipticPrecessor represents precession from one epoch to another.
 *
 * Construct with NewEclipticPrecessor, then call method Precess.
 * After construction, Precess may be called multiple times to precess
 * different coordinates with the same initial and final epochs.
 */
export class EclipticPrecessor {
  /**
   * constructs an EclipticPrecessor object and initializes
   * it to precess coordinates from epochFrom to epochTo.
   * @param {Number} epochFrom
   * @param {Number} epochTo
   */
  constructor (epochFrom, epochTo) {
    // (21.5) p. 136
    let etaCoeff = etat
    let piCoeff = pit
    let pCoeff = pt
    if (epochFrom !== 2000) {
      const T = (epochFrom - 2000) * 0.01
      etaCoeff = [
        base.horner(T, ...etaT),
        -0.03302 * s + 0.000598 * s * T,
        0.000060 * s
      ]
      piCoeff = [
        base.horner(T, ...piT),
        -869.8089 * s - 0.50491 * s * T,
        0.03536 * s
      ]
      pCoeff = [
        base.horner(T, ...pT),
        1.11113 * s - 0.000042 * s * T,
        -0.000006 * s
      ]
    }
    const t = (epochTo - epochFrom) * 0.01
    this.pi = base.horner(t, ...piCoeff)
    this.p = base.horner(t, ...pCoeff) * t
    const eta = base.horner(t, ...etaCoeff) * t
    this.sEta = Math.sin(eta)
    this.cEta = Math.cos(eta)
  }

  /**
   * EclipticPrecess precesses coordinates eclFrom, leaving result in eclTo.
   *
   * The same struct may be used for eclFrom and eclTo.
   * EclTo is returned for convenience.
   * @param {Ecliptic} eclFrom
   * @returns {Ecliptic} [eclTo]
   */
  precess (eclFrom) {
    // (21.7) p. 137
    const [sBeta, cBeta] = base.sincos(eclFrom.lat)
    const [sd, cd] = base.sincos(this.pi - eclFrom.lon)
    const A = this.cEta * cBeta * sd - this.sEta * sBeta
    const B = cBeta * cd
    const C = this.cEta * sBeta + this.sEta * cBeta * sd
    const eclTo = new Ecliptic(this.p + this.pi - Math.atan2(A, B))
    if (C < base.CosSmallAngle) {
      eclTo.lat = Math.asin(C)
    } else {
      eclTo.lat = Math.acos(Math.hypot(A, B)) // near pole
    }
    return eclTo
  }

  /**
   * ReduceElements reduces orbital elements of a solar system body from one
   * equinox to another.
   *
   * This function is described in chapter 24, but is located in this
   * package so it can be a method of EclipticPrecessor.
   *
   * @param {Elements} eFrom
   * @returns {Elements} eTo
   */
  reduceElements (eFrom) {
    const psi = this.pi + this.p
    const [si, ci] = base.sincos(eFrom.inc)
    const [snp, cnp] = base.sincos(eFrom.node - this.pi)
    const eTo = new Elements()
    // (24.1) p. 159
    eTo.inc = Math.acos(ci * this.cEta + si * this.sEta * cnp)
    // (24.2) p. 159
    eTo.node = Math.atan2(si * snp, this.cEta * si * cnp - this.sEta * ci) + psi
    // (24.3) p. 159
    eTo.peri = Math.atan2(-this.sEta * snp, si * this.cEta - ci * this.sEta * cnp) + eFrom.peri
    return eTo
  }
}

/**
 * eclipticPosition precesses ecliptic coordinates from one epoch to another,
 * including proper motions.
 * While eclFrom is given as ecliptic coordinates, proper motions mAlpha, mDelta are
 * still expected to be equatorial.  If proper motions are not to be considered
 * or are not applicable, pass 0, 0.
 * Both eclFrom and eclTo must be non-nil, although they may point to the same
 * struct.  EclTo is returned for convenience.
 *
 * @param {Ecliptic} eclFrom,
 * @param {Number} epochFrom
 * @param {HourAngle} [mAlpha]
 * @param {Angle} [mDelta]
 * @returns {Ecliptic} eclTo
 */
export function eclipticPosition (eclFrom, epochFrom, epochTo, mAlpha, mDelta) {
  const p = new EclipticPrecessor(epochFrom, epochTo)

  if (mAlpha && mDelta && (mAlpha !== 0 || mDelta !== 0)) {
    const { lon, lat } = properMotion(mAlpha, mDelta, epochFrom, eclFrom)
    const t = epochTo - epochFrom
    eclFrom.lon += lon * t
    eclFrom.lat += lat * t
  }
  return p.precess(eclFrom)
}

/**
 * @param {Number} mAlpha - anual proper motion (ra)
 * @param {Number} mDelta - anual proper motion (dec)
 * @param {Number} epoch
 * @param {Ecliptic} ecl
 * @returns {Ecliptic} {lon, lat}
 */
export function properMotion (mAlpha, mDelta, epoch, ecl) {
  const epsilon = nutation.meanObliquity(base.JulianYearToJDE(epoch))
  const [epsilonsin, epsiloncos] = base.sincos(epsilon)
  const { ra, dec } = ecl.toEquatorial(epsilon)
  const [sAlpha, cAlpha] = base.sincos(ra)
  const [sDelta, cDelta] = base.sincos(dec)
  const cBeta = Math.cos(ecl.lat)
  const lon = (mDelta * epsilonsin * cAlpha + mAlpha * cDelta * (epsiloncos * cDelta + epsilonsin * sDelta * sAlpha)) / (cBeta * cBeta)
  const lat = (mDelta * (epsiloncos * cDelta + epsilonsin * sDelta * sAlpha) - mAlpha * epsilonsin * cAlpha * cDelta) / cBeta
  return new Ecliptic(lon, lat)
}

/**
 * ProperMotion3D takes the 3D equatorial coordinates of an object
 * at one epoch and computes its coordinates at a new epoch, considering
 * proper motion and radial velocity.
 *
 * Radial distance (r) must be in parsecs, radial velocitiy (mr) in
 * parsecs per year.
 *
 * Both eqFrom and eqTo must be non-nil, although they may point to the same
 * struct.  EqTo is returned for convenience.
 *
 * @param {Equatorial} eqFrom,
 * @param {Number} epochFrom
 * @param {Number} r
 * @param {Number} mr
 * @param {HourAngle} mAlpha
 * @param {Angle} mDelta
 * @returns {Equatorial} eqTo
 */
export function properMotion3D (eqFrom, epochFrom, epochTo, r, mr, mAlpha, mDelta) {
  const [sAlpha, cAlpha] = base.sincos(eqFrom.ra)
  const [sDelta, cDelta] = base.sincos(eqFrom.dec)
  const x = r * cDelta * cAlpha
  const y = r * cDelta * sAlpha
  const z = r * sDelta
  const mrr = mr / r
  const zmDelta = z * mDelta
  const mx = x * mrr - zmDelta * cAlpha - y * mAlpha
  const my = y * mrr - zmDelta * sAlpha + x * mAlpha
  const mz = z * mrr + r * mDelta * cDelta
  const t = epochTo - epochFrom
  const xp = x + t * mx
  const yp = y + t * my
  const zp = z + t * mz
  const eqTo = new Equatorial()
  eqTo.ra = Math.atan2(yp, xp)
  eqTo.dec = Math.atan2(zp, Math.hypot(xp, yp))
  return eqTo
}
