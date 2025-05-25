import { ASEC2RAD, AU_KM, DAYSPERJC, DEG2RAD, J2000 } from './constants'
import { ELPMPP02_MAIN, ELPMPP02_PERT } from './elpmpp02.data'
import { Mat3 } from './matrix'
import { type Time, tdb } from './time'
import type { Vector3 } from './vector'

// Éphéméride Lunaire Parisienne is a lunar theory developed by Jean Chapront, Michelle Chapront-Touzé,
// and others at the Bureau des Longitudes in the 1970s to 1990s.

// Values of the corrections to the constants fitted to DE405 over the time interval (1950-2060).
const DW1_0 = -0.07008
// const DW2_0 = 0.20794
// const DW3_0 = -0.07215
// const DEART_0 = -0.00033
// const DPERI = -0.00749
const DW1_1 = -0.35106
// const DGAM = 0.00085
// const DE = -0.00006
// const DEART_1 = 0.00732
// const DEP = 0.00224
// const DW2_1 = 0.08017
// const DW3_1 = -0.04317
const DW1_2 = -0.03743
const DW1_3 = -0.00018865
const DW1_4 = -0.00001024
// const DW2_2 = 0.00470602
// const DW2_3 = -0.00025213
// const DW3_2 = -0.0026107
// const DW3_3 = -0.00010712

// Fundamental arguments (Moon and EMB).
// + Corrections to the secular terms of Moon angles.
const W10 = (218 + 18 / 60 + (59.95571 + DW1_0) / 3600) * DEG2RAD
const W11 = (1732559343.73604 + DW1_1) * ASEC2RAD
const W12 = (-6.8084 + DW1_2) * ASEC2RAD
const W13 = 0.6604e-2 * ASEC2RAD + DW1_3 * ASEC2RAD
const W14 = -0.3169e-4 * ASEC2RAD + DW1_4 * ASEC2RAD
// const W20 = (83 + 21 / 60 + (11.67475 + DW2_0) / 3600) * DEG2RAD
// const W21 = (14643420.3171 + DW2_1) * ASEC2RAD
// const W22 = -38.2631 * ASEC2RAD + DW2_2 * ASEC2RAD
// const W23 = -0.45047e-1 * ASEC2RAD + DW2_3 * ASEC2RAD
// const W24 = 0.21301e-3 * ASEC2RAD
// const W30 = (125 + 2 / 60 + (40.39816 + DW3_0) / 3600) * DEG2RAD
// const W31 = (-6967919.5383 + DW3_1) * ASEC2RAD
// const W32 = 6.359 * ASEC2RAD + DW3_2 * ASEC2RAD
// const W33 = 0.7625e-2 * ASEC2RAD + DW3_3 * ASEC2RAD
// const W34 = -0.3586e-4 * ASEC2RAD

// Precession coefficients for P and Q (Laskar, 1986) ---------------
const P1 = 0.10180391e-4
const P2 = 0.47020439e-6
const P3 = -0.5417367e-9
const P4 = -0.2507948e-11
const P5 = 0.463486e-14
const Q1 = -0.113469002e-3
const Q2 = 0.12372674e-6
const Q3 = 0.1265417e-8
const Q4 = -0.1371808e-11
const Q5 = -0.320334e-14

const RA0 = 384747.961370173 / 384747.980674318
const REFERENCE_FRAME = [1, 0.00000044036, -0.000000190919, -0.000000479966, 0.917482137087, -0.397776982902, 0, 0.397776982902, 0.917482137087] as const

// Geocentric cartesian position & velocity of Moon.
export function moon(time: Time) {
	const { day, fraction } = tdb(time)
	const t = [1, 0, 0, 0, 0]
	t[1] = (day - J2000 + fraction) / DAYSPERJC
	for (let i = 2; i <= 4; i++) t[i] = t[i - 1] * t[1]

	const p: Vector3.Vector = [0, 0, 0]
	const v: Vector3.Vector = [0, 0, 0]

	for (let iv = 0; iv <= 2; iv++) {
		const [cmpb, fmpb] = ELPMPP02_MAIN[iv]

		for (let n = 0; n < cmpb.length; n++) {
			const x = cmpb[n]
			let y = fmpb[n][0]
			let yp = 0

			for (let k = 1; k <= 4; k++) {
				y += fmpb[n][k] * t[k]
				yp += k * fmpb[n][k] * t[k - 1]
			}

			p[iv] += x * Math.sin(y)
			v[iv] += x * yp * Math.cos(y)
		}

		for (let it = 0; it < ELPMPP02_PERT[iv].length; it++) {
			const [cper, fper] = ELPMPP02_PERT[iv][it]

			for (let n = 0; n < cper.length; n++) {
				const x = cper[n]
				const xp = it !== 0 ? it * x * t[it - 1] : 0
				let y = fper[n][0]
				let yp = 0

				for (let k = 1; k <= 4; k++) {
					y += fper[n][k] * t[k]
					yp += k * fper[n][k] * t[k - 1]
				}

				p[iv] += x * t[it] * Math.sin(y)
				v[iv] += xp * Math.sin(y) + x * t[it] * yp * Math.cos(y)
			}
		}
	}

	p[0] = p[0] * ASEC2RAD + W10 + W11 * t[1] + W12 * t[2] + W13 * t[3] + W14 * t[4]
	p[1] = p[1] * ASEC2RAD
	p[2] = p[2] * RA0
	v[0] = v[0] * ASEC2RAD + W11 + 2 * W12 * t[1] + 3 * W13 * t[2] + 4 * W14 * t[3]
	v[1] = v[1] * ASEC2RAD

	const clamb = Math.cos(p[0])
	const slamb = Math.sin(p[0])
	const cbeta = Math.cos(p[1])
	const sbeta = Math.sin(p[1])
	const cw = p[2] * cbeta
	const sw = p[2] * sbeta

	const x1 = cw * clamb
	const x2 = cw * slamb
	const x3 = sw
	const xp1 = (v[2] * cbeta - v[1] * sw) * clamb - v[0] * x2
	const xp2 = (v[2] * cbeta - v[1] * sw) * slamb + v[0] * x1
	const xp3 = v[2] * sbeta + v[1] * cw

	const pw = (P1 + P2 * t[1] + P3 * t[2] + P4 * t[3] + P5 * t[4]) * t[1]
	const qw = (Q1 + Q2 * t[1] + Q3 * t[2] + Q4 * t[3] + Q5 * t[4]) * t[1]
	const ra = 2 * Math.sqrt(1 - pw * pw - qw * qw)
	const pwqw = 2 * pw * qw
	const pw2 = 1 - 2 * pw * pw
	const qw2 = 1 - 2 * qw * qw
	const pwra = pw * ra
	const qwra = qw * ra

	p[0] = (pw2 * x1 + pwqw * x2 + pwra * x3) / AU_KM
	p[1] = (pwqw * x1 + qw2 * x2 - qwra * x3) / AU_KM
	p[2] = (-pwra * x1 + qwra * x2 + (pw2 + qw2 - 1) * x3) / AU_KM

	const ppw = P1 + (2 * P2 + 3 * P3 * t[1] + 4 * P4 * t[2] + 5 * P5 * t[3]) * t[1]
	const qpw = Q1 + (2 * Q2 + 3 * Q3 * t[1] + 4 * Q4 * t[2] + 5 * Q5 * t[3]) * t[1]
	const ppw2 = -4 * pw * ppw
	const qpw2 = -4 * qw * qpw
	const ppwqpw = 2 * (ppw * qw + pw * qpw)
	const rap = (ppw2 + qpw2) / ra
	const ppwra = ppw * ra + pw * rap
	const qpwra = qpw * ra + qw * rap

	v[0] = (pw2 * xp1 + pwqw * xp2 + pwra * xp3 + ppw2 * x1 + ppwqpw * x2 + ppwra * x3) / DAYSPERJC / AU_KM
	v[1] = (pwqw * xp1 + qw2 * xp2 - qwra * xp3 + ppwqpw * x1 + qpw2 * x2 - qpwra * x3) / DAYSPERJC / AU_KM
	v[2] = (-pwra * xp1 + qwra * xp2 + (pw2 + qw2 - 1) * xp3 - ppwra * x1 + qpwra * x2 + (ppw2 + qpw2) * x3) / DAYSPERJC / AU_KM

	return [Mat3.mulVec3(REFERENCE_FRAME, p, p), Mat3.mulVec3(REFERENCE_FRAME, v, v)] as const
}
