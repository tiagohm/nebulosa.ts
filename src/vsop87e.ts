import type { PositionAndVelocity } from './astrometry'
import { DAYSPERJM, J2000 } from './constants'
import { mulVec, type Mat3 } from './matrix'
import { tdb, type Time } from './time'
import { zero } from './vector'
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

// The rectangular coordinates of VSOP87A and VSOP87E defined in dynamical ecliptic
// frame J2000 can be connected to the equatorial frame FK5 J2000 with the
// following rotation:
const REFERENCE_FRAME_MATRIX: Mat3 = [1, 0.00000044036, -0.000000190919, -0.000000479966, 0.917482137087, -0.397776982902, 0, 0.397776982902, 0.917482137087] as const

function compute(time: Time, data: readonly number[][][]): PositionAndVelocity {
	const t = tdb(time)

	const m = new Float64Array(6)
	m[0] = 1
	m[1] = (t.day - J2000 + t.fraction) / DAYSPERJM
	for (let i = 2; i <= 5; i++) m[i] = m[i - 1] * m[1]

	const p = zero()
	const v = zero()

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

	return [mulVec(REFERENCE_FRAME_MATRIX, p, p), mulVec(REFERENCE_FRAME_MATRIX, v, v)]
}
