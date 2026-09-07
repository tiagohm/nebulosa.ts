import { COS_OBL_J2000, DAYSPERJM, J2000, SIN_OBL_J2000 } from '../../../../core/constants'
import { matMulVec } from '../../../../math/linear-algebra/mat3'
import type { MutVec3 } from '../../../../math/linear-algebra/vec3'
import type { PositionAndVelocity } from '../../../coordinates/astrometry'
import { type Time, tt } from '../../../time/time'
import { VSOP87E_EARTH_DATA, VSOP87E_JUPITER_DATA, VSOP87E_MARS_DATA, VSOP87E_MERCURY_DATA, VSOP87E_NEPTUNE_DATA, VSOP87E_SATURN_DATA, VSOP87E_SUN_DATA, VSOP87E_URANUS_DATA, VSOP87E_VENUS_DATA } from './vsop87e.data'

// VSOP87 version E analytical theory: barycentric rectangular position (AU) and velocity (AU/day)
// of the Sun and the eight planets. Per body, a per-power, per-coordinate table of (amplitude,
// phase, frequency) terms is summed and its time derivative formed. Fresh vectors are returned in
// the ICRF equatorial frame by default, or in the native dynamical ecliptic/equinox J2000 frame.
// Time argument is millennia from J2000 (TT); selecting a frame does not change the barycentric origin.

// https://vizier.cfa.harvard.edu/ftp/cats/6/81/vsop87.txt

// Output axes: ICRF equatorial, or dynamical ecliptic and equinox J2000; both have a barycentric origin.
export type ReferenceFrame = 'icrf' | 'eclipticJ2000'

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of the Sun at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function sun(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_SUN_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Mercury at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function mercury(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_MERCURY_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Venus at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function venus(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_VENUS_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Earth at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function earth(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_EARTH_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Mars at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function mars(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_MARS_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Jupiter at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function jupiter(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_JUPITER_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Saturn at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function saturn(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_SATURN_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Uranus at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function uranus(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_URANUS_DATA, frame)
}

// Computes fresh barycentric position (AU) and velocity (AU/day) vectors of Neptune at `time`,
// evaluated in TT and expressed in `frame` (ICRF equatorial by default).
export function neptune(time: Time, frame: ReferenceFrame = 'icrf'): PositionAndVelocity {
	return compute(time, VSOP87E_NEPTUNE_DATA, frame)
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

// Cosine of the small frame-tie angle phi = -0.05188" between the VSOP2013 dynamical equinox and ICRF.
const COSQ = 0.999999999999968368508326
// Sine of the same frame-tie angle phi.
const SINQ = -0.000000251521337759624621
// Row-major 3x3 rotation from the J2000 dynamical ecliptic frame to the ICRF equatorial frame,
// combining the obliquity rotation with the phi frame-tie.
const REFERENCE_FRAME_MATRIX = [COSQ, -SINQ * COS_OBL_J2000, SINQ * SIN_OBL_J2000, SINQ, COSQ * COS_OBL_J2000, -COSQ * SIN_OBL_J2000, 0, SIN_OBL_J2000, COS_OBL_J2000] as const

// Sums the VSOP87E series in `data` (indexed [power][coordinate] -> flat amplitude/phase/frequency
// triples) at `time` in TT and forms the analytic velocity. Returns fresh barycentric position (AU)
// and velocity (AU/day) vectors in `frame`, rotating the native ecliptic vectors only for ICRF output.
function compute(time: Time, data: readonly number[][][], frame: ReferenceFrame): PositionAndVelocity {
	const t = tt(time)

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

	if (frame === 'eclipticJ2000') return [p, v]

	return [matMulVec(REFERENCE_FRAME_MATRIX, p, p), matMulVec(REFERENCE_FRAME_MATRIX, v, v)]
}
