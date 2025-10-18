// https://github.com/Stellarium/stellarium/blob/v25.3/src/core/planetsephems/pluto.c

import { DEG2RAD, ECLIPTIC_J2000_MATRIX } from './constants'
import { eraS2p } from './erfa'
import { matMulTransposeVec } from './mat3'
import type { Time } from './time'

const COEFFS = 43

const ARGUMENT = [
	[0, 0, 1],
	[0, 0, 2],
	[0, 0, 3],
	[0, 0, 4],
	[0, 0, 5],
	[0, 0, 6],
	[0, 1, -1],
	[0, 1, 0],
	[0, 1, 1],
	[0, 1, 2],
	[0, 1, 3],
	[0, 2, -2],
	[0, 2, -1],
	[0, 2, 0],
	[1, -1, 0],
	[1, -1, 1],
	[1, 0, -3],
	[1, 0, -2],
	[1, 0, -1],
	[1, 0, 0],
	[1, 0, 1],
	[1, 0, 2],
	[1, 0, 3],
	[1, 0, 4],
	[1, 1, -3],
	[1, 1, -2],
	[1, 1, -1],
	[1, 1, 0],
	[1, 1, 1],
	[1, 1, 3],
	[2, 0, -6],
	[2, 0, -5],
	[2, 0, -4],
	[2, 0, -3],
	[2, 0, -2],
	[2, 0, -1],
	[2, 0, 0],
	[2, 0, 1],
	[2, 0, 2],
	[2, 0, 3],
	[3, 0, -2],
	[3, 0, -1],
	[3, 0, 0],
] as const

const LONGITUDE = [
	[-19799805, 19850055],
	[897144, -4954829],
	[611149, 1211027],
	[-341243, -189585],
	[129287, -34992],
	[-38164, 30893],
	[20442, -9987],
	[-4063, -5071],
	[-6016, -3336],
	[-3956, 3039],
	[-667, 3572],
	[1276, 501],
	[1152, -917],
	[630, -1277],
	[2571, -459],
	[899, -1449],
	[-1016, 1043],
	[-2343, -1012],
	[7042, 788],
	[1199, -338],
	[418, -67],
	[120, -274],
	[-60, -159],
	[-82, -29],
	[-36, -20],
	[-40, 7],
	[-14, 22],
	[4, 13],
	[5, 2],
	[-1, 0],
	[2, 0],
	[-4, 5],
	[4, -7],
	[14, 24],
	[-49, -34],
	[163, -48],
	[9, 24],
	[-4, 1],
	[-3, 1],
	[1, 3],
	[-3, -1],
	[5, -3],
	[0, 0],
] as const

const LATITUDE = [
	[-5452852, -14974862],
	[3527812, 1672790],
	[-1050748, 327647],
	[178690, -292153],
	[18650, 100340],
	[-30697, -25823],
	[4878, 11248],
	[226, -64],
	[2030, -836],
	[69, -604],
	[-247, -567],
	[-57, 1],
	[-122, 175],
	[-49, -164],
	[-197, 199],
	[-25, 217],
	[589, -248],
	[-269, 711],
	[185, 193],
	[315, 807],
	[-130, -43],
	[5, 3],
	[2, 17],
	[2, 5],
	[2, 3],
	[3, 1],
	[2, -1],
	[1, -1],
	[0, -1],
	[0, 0],
	[0, -2],
	[2, 2],
	[-7, 0],
	[10, -8],
	[-3, 20],
	[6, 5],
	[14, 17],
	[-2, 0],
	[0, 0],
	[0, 0],
	[0, 1],
	[0, 0],
	[1, 0],
] as const

const RADIUS = [
	[66865439, 68951812],
	[-11827535, -332538],
	[1593179, -1438890],
	[-18444, 483220],
	[-65977, -85431],
	[31174, -6032],
	[-5794, 22161],
	[4601, 4032],
	[-1729, 234],
	[-415, 702],
	[239, 723],
	[67, -67],
	[1034, -451],
	[-129, 504],
	[480, -231],
	[2, -441],
	[-3359, 265],
	[7856, -7832],
	[36, 45763],
	[8663, 8547],
	[-809, -769],
	[263, -144],
	[-126, 32],
	[-35, -16],
	[-19, -4],
	[-15, 8],
	[-4, 12],
	[5, 6],
	[3, 1],
	[6, -2],
	[2, 2],
	[-2, -2],
	[14, 13],
	[-63, 13],
	[136, -236],
	[273, 1065],
	[251, 149],
	[-25, -9],
	[9, -2],
	[-8, 7],
	[2, -10],
	[19, 35],
	[10, 2],
] as const

// Meeus, Astron. Algorithms 2nd ed (1998). Chap 37. Equ 37.1
// Calculate Pluto heliocentric ICRF coordinates for given julian day.
// This function is accurate to within 0.07" in longitude, 0.02" in latitude
// and 0.000006 AU in radius.
// Note: This function is not valid outside the period of 1885-2099.
export function pluto(time: Time) {
	// Julian centuries since J2000
	const t = (time.day - 2451545 + time.fraction) / 36525

	// Calculate mean longitudes for jupiter, saturn and pluto
	const J = 34.35 + 3034.9057 * t
	const S = 50.08 + 1222.1138 * t
	const P = 238.96 + 144.96 * t

	let sLon = 0
	let sLat = 0
	let sRad = 0

	// Calculate periodic terms in table 37.A
	for (let i = 0; i < COEFFS; i++) {
		const a = DEG2RAD * (ARGUMENT[i][0] * J + ARGUMENT[i][1] * S + ARGUMENT[i][2] * P)
		const sina = Math.sin(a)
		const cosa = Math.cos(a)

		sLon += LONGITUDE[i][0] * sina + LONGITUDE[i][1] * cosa
		sLat += LATITUDE[i][0] * sina + LATITUDE[i][1] * cosa
		sRad += RADIUS[i][0] * sina + RADIUS[i][1] * cosa
	}

	const L = DEG2RAD * (238.958116 + 144.96 * t + sLon * 0.000001)
	const B = DEG2RAD * (-3.908239 + sLat * 0.000001)
	const R = 40.7241346 + sRad * 0.0000001

	const p = eraS2p(L, B, R)

	// Transform from J2000 ecliptic to ICRF
	return matMulTransposeVec(ECLIPTIC_J2000_MATRIX, p, p)
}
