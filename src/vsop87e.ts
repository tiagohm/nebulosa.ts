import type { PositionAndVelocity } from './astrometry'
import { COS_OBL_J2000, DAYSPERJM, J2000, SIN_OBL_J2000 } from './constants'
import { matMulVec } from './mat3'
import { type Time, tdb } from './time'
import type { MutVec3 } from './vec3'
import { VSOP87E_EARTH_DATA, VSOP87E_JUPITER_DATA, VSOP87E_MARS_DATA, VSOP87E_MERCURY_DATA, VSOP87E_NEPTUNE_DATA, VSOP87E_SATURN_DATA, VSOP87E_SUN_DATA, VSOP87E_URANUS_DATA, VSOP87E_VENUS_DATA } from './vsop87e.data'

// https://vizier.cfa.harvard.edu/ftp/cats/6/81/vsop87.txt

// Computes the barycentric position and velocity of the Sun.
export function sun(time: Time) {
	return compute(time, VSOP87E_SUN_DATA)
}

// Computes the barycentric position and velocity of Mercury.
export function mercury(time: Time) {
	return compute(time, VSOP87E_MERCURY_DATA)
}

// Computes the barycentric position and velocity of Venus.
export function venus(time: Time) {
	return compute(time, VSOP87E_VENUS_DATA)
}

// Computes the barycentric position and velocity of Earth.
export function earth(time: Time) {
	return compute(time, VSOP87E_EARTH_DATA)
}

// Computes the barycentric position and velocity of Mars.
export function mars(time: Time) {
	return compute(time, VSOP87E_MARS_DATA)
}

// Computes the barycentric position and velocity of Jupiter.
export function jupiter(time: Time) {
	return compute(time, VSOP87E_JUPITER_DATA)
}

// Computes the barycentric position and velocity of Saturn.
export function saturn(time: Time) {
	return compute(time, VSOP87E_SATURN_DATA)
}

// Computes the barycentric position and velocity of Uranus.
export function uranus(time: Time) {
	return compute(time, VSOP87E_URANUS_DATA)
}

// Computes the barycentric position and velocity of Neptune.
export function neptune(time: Time) {
	return compute(time, VSOP87E_NEPTUNE_DATA)
}

// The coordinates of the main version VSOP87 and of the version A, B, and E are
// are given in the inertial frame defined by the dynamical equinox and ecliptic
// J2000 (JD2451545.0).

// The solution VSOP2013 is fitted to the numerical integration INPOP10a over
// the time interval [1890-2000].

// The VSOP2013 coordinates are referred to the inertial frame defined by the
// dynamical equinox and ecliptic J2000 (JD 2451545.0).

// The planetary coordinates of INPOP10a are referred in ICRF.
// If XE, YE, ZE are the rectangular coordinates of a planet computed from
// VSOP2013, the rectangular coordinates of the planet in equatorial frame of
// the ICRF, XQ, YQ, ZQ, may be obtained by the following rotation:

// with: e = 23° 26' 21.41136" et φ = -0.05188"

const COSQ = 0.999999999999968368508326
const SINQ = -0.000000251521337759624621
const REFERENCE_FRAME_MATRIX = [COSQ, -SINQ * COS_OBL_J2000, SINQ * SIN_OBL_J2000, SINQ, COSQ * COS_OBL_J2000, -COSQ * SIN_OBL_J2000, 0, SIN_OBL_J2000, COS_OBL_J2000] as const

function compute(time: Time, data: readonly number[][][]): PositionAndVelocity {
	const t = tdb(time)

	const m = new Float64Array(6)
	m[0] = 1
	m[1] = (t.day - J2000 + t.fraction) / DAYSPERJM
	for (let i = 2; i <= 5; i++) m[i] = m[i - 1] * m[1]

	const p: MutVec3 = [0, 0, 0]
	const v: MutVec3 = [0, 0, 0]

	for (let k = 0; k <= 2; k++) {
		for (let e = 0; e <= 5; e++) {
			let psum = 0

			const terms = data[e][k]

			for (let i = 0; i < terms.length; i += 3) {
				const a = terms[i]
				const b = terms[i + 1]
				const c = terms[i + 2]

				const u = b + c * m[1]
				const j = a * Math.cos(u)

				psum += j
				v[k] += (e > 0 ? m[e - 1] * e * j : 0) - m[e] * a * c * Math.sin(u)
			}

			p[k] += psum * m[e]
		}

		v[k] /= DAYSPERJM
	}

	return [matMulVec(REFERENCE_FRAME_MATRIX, p, p), matMulVec(REFERENCE_FRAME_MATRIX, v, v)]
}
