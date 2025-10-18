import type { PositionAndVelocity } from './astrometry'
import { DAYSPERJY, DEG2RAD } from './constants'
import { ellipticToRectangularN } from './ephemeris'
import { matMulVec } from './mat3'
import type { NumberArray } from './math'
import { type Time, tt } from './time'

// COMPUTATION OF THE COORDINATES OF THE URANIAN SATELLITES (GUST86),
// version 0.1 (1988,1995) by LASKAR J. and JACOBSON, R. can be found at
// https://ftp.imcce.fr/pub/ephem/satel/gust86

// Based on https://github.com/Stellarium/stellarium/blob/master/src/core/planetsephems/gust86.c

export interface Gust87Body {
	readonly rmu: number
	readonly compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => void
}

const D2RPERJY = DEG2RAD / DAYSPERJY

const FQN = [4.44519055, 2.492952519, 1.516148111, 0.721718509, 0.46669212] as const
const FQE = [20.082 * D2RPERJY, 6.217 * D2RPERJY, 2.865 * D2RPERJY, 2.078 * D2RPERJY, 0.386 * D2RPERJY] as const
const FQI = [-20.309 * D2RPERJY, -6.288 * D2RPERJY, -2.836 * D2RPERJY, -1.843 * D2RPERJY, -0.259 * D2RPERJY] as const
const PHN = [-0.238051, 3.098046, 2.285402, 0.856359, -0.915592] as const
const PHE = [0.611392, 2.408974, 2.067774, 0.735131, 0.426767] as const
const PHI = [5.702313, 0.395757, 0.589326, 1.746237, 4.206896] as const

// const VSOP87 = [9.753206632086812015e-1, 6.194425668001473004e-2, 2.119257251551559653e-1, -2.006444610981783542e-1, -1.519328516640849367e-1, 9.678110398294910731e-1, 9.214881523275189928e-2, -9.864478281437795399e-1, -1.357544776485127136e-1] as const
const J2000 = [9.753205572598290957e-1, 6.194437810676107434e-2, 2.11926177258362903e-1, -2.207428547845518695e-1, 2.52990533699299528e-1, 9.41949245936377315e-1, 4.733143558215848563e-3, -9.654836528287313313e-1, 2.604206471702025216e-1] as const

const ARIEL: Gust87Body = {
	rmu: 1.291910570526396e-8,
	compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => {
		elem[0] = 2.49254257 + Math.cos(an[0] - an[1] * 3 + an[2] * 2) * 2.55e-6 - Math.cos(an[1] - an[2]) * 4.216e-5 - Math.cos(an[1] * 2 - an[2] * 2) * 1.0256e-4
		elem[1] =
			-Math.sin(an[0] - an[1] * 3 + an[2] * 2) * 0.0018605 +
			Math.sin(an[0] * 2 - an[1] * 6 + an[2] * 4) * 2.1999e-4 +
			Math.sin(an[0] * 3 - an[1] * 9 + an[2] * 6) * 2.31e-5 +
			Math.sin(an[0] * 4 - an[1] * 12 + an[2] * 8) * 4.3e-6 -
			Math.sin(an[1] - an[2]) * 9.011e-5 -
			Math.sin(an[1] * 2 - an[2] * 2) * 9.107e-5 -
			Math.sin(an[1] * 3 - an[2] * 3) * 4.275e-5 -
			Math.sin(an[1] * 2 - an[3] * 2) * 1.649e-5 +
			t * 2.49295252 +
			3.09804641
		elem[2] = Math.cos(ae[0]) * -3.35e-6 + Math.cos(ae[1]) * 0.00118763 + Math.cos(ae[2]) * 8.6159e-4 + Math.cos(ae[3]) * 7.15e-5 + Math.cos(ae[4]) * 5.559e-5 - Math.cos(-an[1] + an[2] * 2) * 8.46e-5 + Math.cos(an[1] * -2 + an[2] * 3) * 9.181e-5 + Math.cos(-an[1] + an[3] * 2) * 2.003e-5 + Math.cos(an[1]) * 8.977e-5
		elem[3] = Math.sin(ae[0]) * -3.35e-6 + Math.sin(ae[1]) * 0.00118763 + Math.sin(ae[2]) * 8.6159e-4 + Math.sin(ae[3]) * 7.15e-5 + Math.sin(ae[4]) * 5.559e-5 - Math.sin(-an[1] + an[2] * 2) * 8.46e-5 + Math.sin(an[1] * -2 + an[2] * 3) * 9.181e-5 + Math.sin(-an[1] + an[3] * 2) * 2.003e-5 + Math.sin(an[1]) * 8.977e-5
		elem[4] = Math.cos(ai[0]) * -1.2175e-4 + Math.cos(ai[1]) * 3.5825e-4 + Math.cos(ai[2]) * 2.9008e-4 + Math.cos(ai[3]) * 9.778e-5 + Math.cos(ai[4]) * 3.397e-5
		elem[5] = Math.sin(ai[0]) * -1.2175e-4 + Math.sin(ai[1]) * 3.5825e-4 + Math.sin(ai[2]) * 2.9008e-4 + Math.sin(ai[3]) * 9.778e-5 + Math.sin(ai[4]) * 3.397e-5
	},
}

const UMBRIEL: Gust87Body = {
	rmu: 1.291910102284198e-8,
	compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => {
		elem[0] = 1.5159549 + Math.cos(an[2] - an[3] * 2 + ae[2]) * 9.74e-6 - Math.cos(an[1] - an[2]) * 1.06e-4 + Math.cos(an[1] * 2 - an[2] * 2) * 5.416e-5 - Math.cos(an[2] - an[3]) * 2.359e-5 - Math.cos(an[2] * 2 - an[3] * 2) * 7.07e-5 - Math.cos(an[2] * 3 - an[3] * 3) * 3.628e-5
		elem[1] =
			Math.sin(an[0] - an[1] * 3 + an[2] * 2) * 6.6057e-4 -
			Math.sin(an[0] * 2 - an[1] * 6 + an[2] * 4) * 7.651e-5 -
			Math.sin(an[0] * 3 - an[1] * 9 + an[2] * 6) * 8.96e-6 -
			Math.sin(an[0] * 4 - an[1] * 12 + an[2] * 8) * 2.53e-6 -
			Math.sin(an[2] - an[3] * 4 + an[4] * 3) * 5.291e-5 -
			Math.sin(an[2] - an[3] * 2 + ae[4]) * 7.34e-6 -
			Math.sin(an[2] - an[3] * 2 + ae[3]) * 1.83e-6 +
			Math.sin(an[2] - an[3] * 2 + ae[2]) * 1.4791e-4 +
			Math.sin(an[2] - an[3] * 2 + ae[1]) * -7.77e-6 +
			Math.sin(an[1] - an[2]) * 9.776e-5 +
			Math.sin(an[1] * 2 - an[2] * 2) * 7.313e-5 +
			Math.sin(an[1] * 3 - an[2] * 3) * 3.471e-5 +
			Math.sin(an[1] * 4 - an[2] * 4) * 1.889e-5 -
			Math.sin(an[2] - an[3]) * 6.789e-5 -
			Math.sin(an[2] * 2 - an[3] * 2) * 8.286e-5 +
			Math.sin(an[2] * 3 - an[3] * 3) * -3.381e-5 -
			Math.sin(an[2] * 4 - an[3] * 4) * 1.579e-5 -
			Math.sin(an[2] - an[4]) * 1.021e-5 -
			Math.sin(an[2] * 2 - an[4] * 2) * 1.708e-5 +
			t * 1.51614811 +
			2.28540169
		elem[2] =
			Math.cos(ae[0]) * -2.1e-7 -
			Math.cos(ae[1]) * 2.2795e-4 +
			Math.cos(ae[2]) * 0.00390469 +
			Math.cos(ae[3]) * 3.0917e-4 +
			Math.cos(ae[4]) * 2.2192e-4 +
			Math.cos(an[1]) * 2.934e-5 +
			Math.cos(an[2]) * 2.62e-5 +
			Math.cos(-an[1] + an[2] * 2) * 5.119e-5 -
			Math.cos(an[1] * -2 + an[2] * 3) * 1.0386e-4 -
			Math.cos(an[1] * -3 + an[2] * 4) * 2.716e-5 +
			Math.cos(an[3]) * -1.622e-5 +
			Math.cos(-an[2] + an[3] * 2) * 5.4923e-4 +
			Math.cos(an[2] * -2 + an[3] * 3) * 3.47e-5 +
			Math.cos(an[2] * -3 + an[3] * 4) * 1.281e-5 +
			Math.cos(-an[2] + an[4] * 2) * 2.181e-5 +
			Math.cos(an[2]) * 4.625e-5
		elem[3] =
			Math.sin(ae[0]) * -2.1e-7 -
			Math.sin(ae[1]) * 2.2795e-4 +
			Math.sin(ae[2]) * 0.00390469 +
			Math.sin(ae[3]) * 3.0917e-4 +
			Math.sin(ae[4]) * 2.2192e-4 +
			Math.sin(an[1]) * 2.934e-5 +
			Math.sin(an[2]) * 2.62e-5 +
			Math.sin(-an[1] + an[2] * 2) * 5.119e-5 -
			Math.sin(an[1] * -2 + an[2] * 3) * 1.0386e-4 -
			Math.sin(an[1] * -3 + an[2] * 4) * 2.716e-5 +
			Math.sin(an[3]) * -1.622e-5 +
			Math.sin(-an[2] + an[3] * 2) * 5.4923e-4 +
			Math.sin(an[2] * -2 + an[3] * 3) * 3.47e-5 +
			Math.sin(an[2] * -3 + an[3] * 4) * 1.281e-5 +
			Math.sin(-an[2] + an[4] * 2) * 2.181e-5 +
			Math.sin(an[2]) * 4.625e-5
		elem[4] = Math.cos(ai[0]) * -1.086e-5 - Math.cos(ai[1]) * 8.151e-5 + Math.cos(ai[2]) * 0.00111336 + Math.cos(ai[3]) * 3.5014e-4 + Math.cos(ai[4]) * 1.065e-4
		elem[5] = Math.sin(ai[0]) * -1.086e-5 - Math.sin(ai[1]) * 8.151e-5 + Math.sin(ai[2]) * 0.00111336 + Math.sin(ai[3]) * 3.5014e-4 + Math.sin(ai[4]) * 1.065e-4
	},
}

const TITANIA: Gust87Body = {
	rmu: 1.291942656265575e-8,
	compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => {
		elem[0] =
			0.72166316 -
			Math.cos(an[2] - an[3] * 2 + ae[2]) * 2.64e-6 -
			Math.cos(an[3] * 2 - an[4] * 3 + ae[4]) * 2.16e-6 +
			Math.cos(an[3] * 2 - an[4] * 3 + ae[3]) * 6.45e-6 -
			Math.cos(an[3] * 2 - an[4] * 3 + ae[2]) * 1.11e-6 +
			Math.cos(an[1] - an[3]) * -6.223e-5 -
			Math.cos(an[2] - an[3]) * 5.613e-5 -
			Math.cos(an[3] - an[4]) * 3.994e-5 -
			Math.cos(an[3] * 2 - an[4] * 2) * 9.185e-5 -
			Math.cos(an[3] * 3 - an[4] * 3) * 5.831e-5 -
			Math.cos(an[3] * 4 - an[4] * 4) * 3.86e-5 -
			Math.cos(an[3] * 5 - an[4] * 5) * 2.618e-5 -
			Math.cos(an[3] * 6 - an[4] * 6) * 1.806e-5
		elem[1] =
			Math.sin(an[2] - an[3] * 4 + an[4] * 3) * 2.061e-5 -
			Math.sin(an[2] - an[3] * 2 + ae[4]) * 2.07e-6 -
			Math.sin(an[2] - an[3] * 2 + ae[3]) * 2.88e-6 -
			Math.sin(an[2] - an[3] * 2 + ae[2]) * 4.079e-5 +
			Math.sin(an[2] - an[3] * 2 + ae[1]) * 2.11e-6 -
			Math.sin(an[3] * 2 - an[4] * 3 + ae[4]) * 5.183e-5 +
			Math.sin(an[3] * 2 - an[4] * 3 + ae[3]) * 1.5987e-4 +
			Math.sin(an[3] * 2 - an[4] * 3 + ae[2]) * -3.505e-5 -
			Math.sin(an[3] * 3 - an[4] * 4 + ae[4]) * 1.56e-6 +
			Math.sin(an[1] - an[3]) * 4.054e-5 +
			Math.sin(an[2] - an[3]) * 4.617e-5 -
			Math.sin(an[3] - an[4]) * 3.1776e-4 -
			Math.sin(an[3] * 2 - an[4] * 2) * 3.0559e-4 -
			Math.sin(an[3] * 3 - an[4] * 3) * 1.4836e-4 -
			Math.sin(an[3] * 4 - an[4] * 4) * 8.292e-5 +
			Math.sin(an[3] * 5 - an[4] * 5) * -4.998e-5 -
			Math.sin(an[3] * 6 - an[4] * 6) * 3.156e-5 -
			Math.sin(an[3] * 7 - an[4] * 7) * 2.056e-5 -
			Math.sin(an[3] * 8 - an[4] * 8) * 1.369e-5 +
			t * 0.72171851 +
			0.85635879
		elem[2] =
			Math.cos(ae[0]) * -2e-8 -
			Math.cos(ae[1]) * 1.29e-6 -
			Math.cos(ae[2]) * 3.2451e-4 +
			Math.cos(ae[3]) * 9.3281e-4 +
			Math.cos(ae[4]) * 0.00112089 +
			Math.cos(an[1]) * 3.386e-5 +
			Math.cos(an[3]) * 1.746e-5 +
			Math.cos(-an[1] + an[3] * 2) * 1.658e-5 +
			Math.cos(an[2]) * 2.889e-5 -
			Math.cos(-an[2] + an[3] * 2) * 3.586e-5 +
			Math.cos(an[3]) * -1.786e-5 -
			Math.cos(an[4]) * 3.21e-5 -
			Math.cos(-an[3] + an[4] * 2) * 1.7783e-4 +
			Math.cos(an[3] * -2 + an[4] * 3) * 7.9343e-4 +
			Math.cos(an[3] * -3 + an[4] * 4) * 9.948e-5 +
			Math.cos(an[3] * -4 + an[4] * 5) * 4.483e-5 +
			Math.cos(an[3] * -5 + an[4] * 6) * 2.513e-5 +
			Math.cos(an[3] * -6 + an[4] * 7) * 1.543e-5
		elem[3] =
			Math.sin(ae[0]) * -2e-8 -
			Math.sin(ae[1]) * 1.29e-6 -
			Math.sin(ae[2]) * 3.2451e-4 +
			Math.sin(ae[3]) * 9.3281e-4 +
			Math.sin(ae[4]) * 0.00112089 +
			Math.sin(an[1]) * 3.386e-5 +
			Math.sin(an[3]) * 1.746e-5 +
			Math.sin(-an[1] + an[3] * 2) * 1.658e-5 +
			Math.sin(an[2]) * 2.889e-5 -
			Math.sin(-an[2] + an[3] * 2) * 3.586e-5 +
			Math.sin(an[3]) * -1.786e-5 -
			Math.sin(an[4]) * 3.21e-5 -
			Math.sin(-an[3] + an[4] * 2) * 1.7783e-4 +
			Math.sin(an[3] * -2 + an[4] * 3) * 7.9343e-4 +
			Math.sin(an[3] * -3 + an[4] * 4) * 9.948e-5 +
			Math.sin(an[3] * -4 + an[4] * 5) * 4.483e-5 +
			Math.sin(an[3] * -5 + an[4] * 6) * 2.513e-5 +
			Math.sin(an[3] * -6 + an[4] * 7) * 1.543e-5
		elem[4] = Math.cos(ai[0]) * -1.43e-6 - Math.cos(ai[1]) * 1.06e-6 - Math.cos(ai[2]) * 1.4013e-4 + Math.cos(ai[3]) * 6.8572e-4 + Math.cos(ai[4]) * 3.7832e-4
		elem[5] = Math.sin(ai[0]) * -1.43e-6 - Math.sin(ai[1]) * 1.06e-6 - Math.sin(ai[2]) * 1.4013e-4 + Math.sin(ai[3]) * 6.8572e-4 + Math.sin(ai[4]) * 3.7832e-4
	},
}

const OBERON: Gust87Body = {
	rmu: 1.29193596709132e-8,
	compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => {
		elem[0] =
			0.46658054 +
			Math.cos(an[3] * 2 - an[4] * 3 + ae[4]) * 2.08e-6 -
			Math.cos(an[3] * 2 - an[4] * 3 + ae[3]) * 6.22e-6 +
			Math.cos(an[3] * 2 - an[4] * 3 + ae[2]) * 1.07e-6 -
			Math.cos(an[1] - an[4]) * 4.31e-5 +
			Math.cos(an[2] - an[4]) * -3.894e-5 -
			Math.cos(an[3] - an[4]) * 8.011e-5 +
			Math.cos(an[3] * 2 - an[4] * 2) * 5.906e-5 +
			Math.cos(an[3] * 3 - an[4] * 3) * 3.749e-5 +
			Math.cos(an[3] * 4 - an[4] * 4) * 2.482e-5 +
			Math.cos(an[3] * 5 - an[4] * 5) * 1.684e-5
		elem[1] =
			-Math.sin(an[2] - an[3] * 4 + an[4] * 3) * 7.82e-6 +
			Math.sin(an[3] * 2 - an[4] * 3 + ae[4]) * 5.129e-5 -
			Math.sin(an[3] * 2 - an[4] * 3 + ae[3]) * 1.5824e-4 +
			Math.sin(an[3] * 2 - an[4] * 3 + ae[2]) * 3.451e-5 +
			Math.sin(an[1] - an[4]) * 4.751e-5 +
			Math.sin(an[2] - an[4]) * 3.896e-5 +
			Math.sin(an[3] - an[4]) * 3.5973e-4 +
			Math.sin(an[3] * 2 - an[4] * 2) * 2.8278e-4 +
			Math.sin(an[3] * 3 - an[4] * 3) * 1.386e-4 +
			Math.sin(an[3] * 4 - an[4] * 4) * 7.803e-5 +
			Math.sin(an[3] * 5 - an[4] * 5) * 4.729e-5 +
			Math.sin(an[3] * 6 - an[4] * 6) * 3e-5 +
			Math.sin(an[3] * 7 - an[4] * 7) * 1.962e-5 +
			Math.sin(an[3] * 8 - an[4] * 8) * 1.311e-5 +
			t * 0.46669212 -
			0.9155918
		elem[2] =
			Math.cos(ae[1]) * -3.5e-7 +
			Math.cos(ae[2]) * 7.453e-5 -
			Math.cos(ae[3]) * 7.5868e-4 +
			Math.cos(ae[4]) * 0.00139734 +
			Math.cos(an[1]) * 3.9e-5 +
			Math.cos(-an[1] + an[4] * 2) * 1.766e-5 +
			Math.cos(an[2]) * 3.242e-5 +
			Math.cos(an[3]) * 7.975e-5 +
			Math.cos(an[4]) * 7.566e-5 +
			Math.cos(-an[3] + an[4] * 2) * 1.3404e-4 -
			Math.cos(an[3] * -2 + an[4] * 3) * 9.8726e-4 -
			Math.cos(an[3] * -3 + an[4] * 4) * 1.2609e-4 -
			Math.cos(an[3] * -4 + an[4] * 5) * 5.742e-5 -
			Math.cos(an[3] * -5 + an[4] * 6) * 3.241e-5 -
			Math.cos(an[3] * -6 + an[4] * 7) * 1.999e-5 -
			Math.cos(an[3] * -7 + an[4] * 8) * 1.294e-5
		elem[3] =
			Math.sin(ae[1]) * -3.5e-7 +
			Math.sin(ae[2]) * 7.453e-5 -
			Math.sin(ae[3]) * 7.5868e-4 +
			Math.sin(ae[4]) * 0.00139734 +
			Math.sin(an[1]) * 3.9e-5 +
			Math.sin(-an[1] + an[4] * 2) * 1.766e-5 +
			Math.sin(an[2]) * 3.242e-5 +
			Math.sin(an[3]) * 7.975e-5 +
			Math.sin(an[4]) * 7.566e-5 +
			Math.sin(-an[3] + an[4] * 2) * 1.3404e-4 -
			Math.sin(an[3] * -2 + an[4] * 3) * 9.8726e-4 -
			Math.sin(an[3] * -3 + an[4] * 4) * 1.2609e-4 -
			Math.sin(an[3] * -4 + an[4] * 5) * 5.742e-5 -
			Math.sin(an[3] * -5 + an[4] * 6) * 3.241e-5 -
			Math.sin(an[3] * -6 + an[4] * 7) * 1.999e-5 -
			Math.sin(an[3] * -7 + an[4] * 8) * 1.294e-5
		elem[4] = Math.cos(ai[0]) * -4.4e-7 - Math.cos(ai[1]) * 3.1e-7 + Math.cos(ai[2]) * 3.689e-5 - Math.cos(ai[3]) * 5.9633e-4 + Math.cos(ai[4]) * 4.5169e-4
		elem[5] = Math.sin(ai[0]) * -4.4e-7 - Math.sin(ai[1]) * 3.1e-7 + Math.sin(ai[2]) * 3.689e-5 - Math.sin(ai[3]) * 5.9633e-4 + Math.sin(ai[4]) * 4.5169e-4
	},
}

const MIRANDA: Gust87Body = {
	rmu: 1.291892353675174e-8,
	compute: (t: number, elem: NumberArray, an: Readonly<NumberArray>, ae: Readonly<NumberArray>, ai: Readonly<NumberArray>) => {
		elem[0] = 4.44352267 - Math.cos(an[0] - an[1] * 3 + an[2] * 2) * 3.492e-5 + Math.cos(an[0] * 2 - an[1] * 6 + an[2] * 4) * 8.47e-6 + Math.cos(an[0] * 3 - an[1] * 9 + an[2] * 6) * 1.31e-6 - Math.cos(an[0] - an[1]) * 5.228e-5 - Math.cos(an[0] * 2 - an[1] * 2) * 1.3665e-4
		elem[1] =
			Math.sin(an[0] - an[1] * 3 + an[2] * 2) * 0.02547217 -
			Math.sin(an[0] * 2 - an[1] * 6 + an[2] * 4) * 0.00308831 -
			Math.sin(an[0] * 3 - an[1] * 9 + an[2] * 6) * 3.181e-4 -
			Math.sin(an[0] * 4 - an[1] * 12 + an[2] * 8) * 3.749e-5 -
			Math.sin(an[0] - an[1]) * 5.785e-5 -
			Math.sin(an[0] * 2 - an[1] * 2) * 6.232e-5 -
			Math.sin(an[0] * 3 - an[1] * 3) * 2.795e-5 +
			t * 4.44519055 -
			0.23805158
		elem[2] = Math.cos(ae[0]) * 0.00131238 + Math.cos(ae[1]) * 7.181e-5 + Math.cos(ae[2]) * 6.977e-5 + Math.cos(ae[3]) * 6.75e-6 + Math.cos(ae[4]) * 6.27e-6 + Math.cos(an[0]) * 1.941e-4 - Math.cos(-an[0] + an[1] * 2) * 1.2331e-4 + Math.cos(an[0] * -2 + an[1] * 3) * 3.952e-5
		elem[3] = Math.sin(ae[0]) * 0.00131238 + Math.sin(ae[1]) * 7.181e-5 + Math.sin(ae[2]) * 6.977e-5 + Math.sin(ae[3]) * 6.75e-6 + Math.sin(ae[4]) * 6.27e-6 + Math.sin(an[0]) * 1.941e-4 - Math.sin(-an[0] + an[1] * 2) * 1.2331e-4 + Math.sin(an[0] * -2 + an[1] * 3) * 3.952e-5
		elem[4] = Math.cos(ai[0]) * 0.03787171 + Math.cos(ai[1]) * 2.701e-5 + Math.cos(ai[2]) * 3.076e-5 + Math.cos(ai[3]) * 1.218e-5 + Math.cos(ai[4]) * 5.37e-6
		elem[5] = Math.sin(ai[0]) * 0.03787171 + Math.sin(ai[1]) * 2.701e-5 + Math.sin(ai[2]) * 3.076e-5 + Math.sin(ai[3]) * 1.218e-5 + Math.sin(ai[4]) * 5.37e-6
	},
}

// Computes the position and velocity of Ariel at given time
export function ariel(time: Time) {
	return gust86(time, ARIEL)
}

// Computes the position and velocity of Umbriel at given time
export function umbriel(time: Time) {
	return gust86(time, UMBRIEL)
}

// Computes the position and velocity of Titania at given time
export function titania(time: Time) {
	return gust86(time, TITANIA)
}

// Computes the position and velocity of Oberon at given time
export function oberon(time: Time) {
	return gust86(time, OBERON)
}

// Computes the position and velocity of Miranda at given time
export function miranda(time: Time) {
	return gust86(time, MIRANDA)
}

// Computes the position and velocity of a given Uranus' moon at given time using the GUST86 model
export function gust86(time: Time, body: Gust87Body): PositionAndVelocity {
	time = tt(time)
	const td = time.day - 2444239.5 + time.fraction

	const an = new Float64Array(5)
	const ae = new Float64Array(5)
	const ai = new Float64Array(5)

	for (let i = 0; i < 5; i++) {
		an[i] = FQN[i] * td + PHN[i]
		ae[i] = FQE[i] * td + PHE[i]
		ai[i] = FQI[i] * td + PHI[i]
	}

	const elem = new Float64Array(6)

	body.compute(td, elem, an, ae, ai)

	const pv = ellipticToRectangularN(body.rmu, elem, 0)
	matMulVec(J2000, pv[0], pv[0])
	matMulVec(J2000, pv[1], pv[1])
	return pv
}
