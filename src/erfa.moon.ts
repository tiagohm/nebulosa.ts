import { normalizeAngle } from './angle'
import { AU_M, DAYSPERJC, DEG2RAD, J2000 } from './constants'
import { eraPfw06, eraS2pv } from './erfa'
import { matMulVec, matRotX, matRotZ } from './mat3'

// Moon's mean longitude (wrt mean equinox and ecliptic of date)
const ELP0 = 218.31665436 * DEG2RAD // Simon et al. (1994)
const ELP1 = 481267.88123421 * DEG2RAD
const ELP2 = -0.0015786 * DEG2RAD
const ELP3 = DEG2RAD / 538841
const ELP4 = -DEG2RAD / 65194000

// Moon's mean elongation
const D0 = 297.8501921 * DEG2RAD
const D1 = 445267.1114034 * DEG2RAD
const D2 = -0.0018819 * DEG2RAD
const D3 = DEG2RAD / 545868
const D4 = DEG2RAD / 113065000

// Sun's mean anomaly
const EM0 = 357.5291092 * DEG2RAD
const EM1 = 35999.0502909 * DEG2RAD
const EM2 = -0.0001536 * DEG2RAD
const EM3 = DEG2RAD / 24490000
const EM4 = 0

// Moon's mean anomaly
const EMP0 = 134.9633964 * DEG2RAD
const EMP1 = 477198.8675055 * DEG2RAD
const EMP2 = 0.0087414 * DEG2RAD
const EMP3 = DEG2RAD / 69699
const EMP4 = -DEG2RAD / 14712000

// Mean distance of the Moon from its ascending node
const F0 = 93.272095 * DEG2RAD
const F1 = 483202.0175233 * DEG2RAD
const F2 = -0.0036539 * DEG2RAD
const F3 = DEG2RAD / 3526000
const F4 = DEG2RAD / 863310000

// Meeus A_1, due to Venus (deg)
const A10 = 119.75 * DEG2RAD
const A11 = 131.849 * DEG2RAD

// Meeus A_2, due to Jupiter (deg)
const A20 = 53.09 * DEG2RAD
const A21 = 479264.29 * DEG2RAD

// Meeus A_3, due to sidereal motion of the Moon in longitude (deg)
const A30 = 313.45 * DEG2RAD
const A31 = 481266.484 * DEG2RAD

// Coefficients for Meeus "additive terms" (deg)
const AL1 = 0.003958
const AL2 = 0.001962
const AL3 = 0.000318
const AB1 = -0.002235
const AB2 = 0.000382
const AB3 = 0.000175
const AB4 = 0.000175
const AB5 = 0.000127
const AB6 = -0.000115

// Fixed term in distance (m)
const R0 = 385000560

// Coefficients for (dimensionless) E factor
const E1 = -0.002516
const E2 = -0.0000074

const TLR = [
	// number of D in argument
	// M
	// M'
	// F
	// coefficient of L sine argument (deg)
	// coefficient of R cosine argument (m)
	[0, 0, 1, 0, 6.288774, -20905355],
	[2, 0, -1, 0, 1.274027, -3699111],
	[2, 0, 0, 0, 0.658314, -2955968],
	[0, 0, 2, 0, 0.213618, -569925],
	[0, 1, 0, 0, -0.185116, 48888],
	[0, 0, 0, 2, -0.114332, -3149],
	[2, 0, -2, 0, 0.058793, 246158],
	[2, -1, -1, 0, 0.057066, -152138],
	[2, 0, 1, 0, 0.053322, -170733],
	[2, -1, 0, 0, 0.045758, -204586],
	[0, 1, -1, 0, -0.040923, -129620],
	[1, 0, 0, 0, -0.03472, 108743],
	[0, 1, 1, 0, -0.030383, 104755],
	[2, 0, 0, -2, 0.015327, 10321],
	[0, 0, 1, 2, -0.012528, 0],
	[0, 0, 1, -2, 0.01098, 79661],
	[4, 0, -1, 0, 0.010675, -34782],
	[0, 0, 3, 0, 0.010034, -23210],
	[4, 0, -2, 0, 0.008548, -21636],
	[2, 1, -1, 0, -0.007888, 24208],
	[2, 1, 0, 0, -0.006766, 30824],
	[1, 0, -1, 0, -0.005163, -8379],
	[1, 1, 0, 0, 0.004987, -16675],
	[2, -1, 1, 0, 0.004036, -12831],
	[2, 0, 2, 0, 0.003994, -10445],
	[4, 0, 0, 0, 0.003861, -11650],
	[2, 0, -3, 0, 0.003665, 14403],
	[0, 1, -2, 0, -0.002689, -7003],
	[2, 0, -1, 2, -0.002602, 0],
	[2, -1, -2, 0, 0.00239, 10056],
	[1, 0, 1, 0, -0.002348, 6322],
	[2, -2, 0, 0, 0.002236, -9884],
	[0, 1, 2, 0, -0.00212, 5751],
	[0, 2, 0, 0, -0.002069, 0],
	[2, -2, -1, 0, 0.002048, -4950],
	[2, 0, 1, -2, -0.001773, 4130],
	[2, 0, 0, 2, -0.001595, 0],
	[4, -1, -1, 0, 0.001215, -3958],
	[0, 0, 2, 2, -0.00111, 0],
	[3, 0, -1, 0, -0.000892, 3258],
	[2, 1, 1, 0, -0.00081, 2616],
	[4, -1, -2, 0, 0.000759, -1897],
	[0, 2, -1, 0, -0.000713, -2117],
	[2, 2, -1, 0, -0.0007, 2354],
	[2, 1, -2, 0, 0.000691, 0],
	[2, -1, 0, -2, 0.000596, 0],
	[4, 0, 1, 0, 0.000549, -1423],
	[0, 0, 4, 0, 0.000537, -1117],
	[4, -1, 0, 0, 0.00052, -1571],
	[1, 0, -2, 0, -0.000487, -1739],
	[2, 1, 0, -2, -0.000399, 0],
	[0, 0, 2, -2, -0.000381, -4421],
	[1, 1, 1, 0, 0.000351, 0],
	[3, 0, -2, 0, -0.00034, 0],
	[4, 0, -3, 0, 0.00033, 0],
	[2, -1, 2, 0, 0.000327, 0],
	[0, 2, 1, 0, -0.000323, 1165],
	[1, 1, -1, 0, 0.000299, 0],
	[2, 0, 3, 0, 0.000294, 0],
	[2, 0, -1, -2, 0, 8752],
] as const

const TB = [
	// number of D in argument
	// M
	// M'
	// F
	// coefficient of B sine argument (deg)
	[0, 0, 0, 1, 5.128122],
	[0, 0, 1, 1, 0.280602],
	[0, 0, 1, -1, 0.277693],
	[2, 0, 0, -1, 0.173237],
	[2, 0, -1, 1, 0.055413],
	[2, 0, -1, -1, 0.046271],
	[2, 0, 0, 1, 0.032573],
	[0, 0, 2, 1, 0.017198],
	[2, 0, 1, -1, 0.009266],
	[0, 0, 2, -1, 0.008822],
	[2, -1, 0, -1, 0.008216],
	[2, 0, -2, -1, 0.004324],
	[2, 0, 1, 1, 0.0042],
	[2, 1, 0, -1, -0.003359],
	[2, -1, -1, 1, 0.002463],
	[2, -1, 0, 1, 0.002211],
	[2, -1, -1, -1, 0.002065],
	[0, 1, -1, -1, -0.00187],
	[4, 0, -1, -1, 0.001828],
	[0, 1, 0, 1, -0.001794],
	[0, 0, 0, 3, -0.001749],
	[0, 1, -1, 1, -0.001565],
	[1, 0, 0, 1, -0.001491],
	[0, 1, 1, 1, -0.001475],
	[0, 1, 1, -1, -0.00141],
	[0, 1, 0, -1, -0.001344],
	[1, 0, 0, -1, -0.001335],
	[0, 0, 3, 1, 0.001107],
	[4, 0, 0, -1, 0.001021],
	[4, 0, -1, 1, 0.000833],
	[0, 0, 1, -3, 0.000777],
	[4, 0, -2, 1, 0.000671],
	[2, 0, 0, -3, 0.000607],
	[2, 0, 2, -1, 0.000596],
	[2, -1, 1, -1, 0.000491],
	[2, 0, -2, 1, -0.000451],
	[0, 0, 3, -1, 0.000439],
	[2, 0, 2, 1, 0.000422],
	[2, 0, -3, -1, 0.000421],
	[2, 1, -1, 1, -0.000366],
	[2, 1, 0, 1, -0.000351],
	[4, 0, 0, 1, 0.000331],
	[2, -1, 1, 1, 0.000315],
	[2, -2, 0, -1, 0.000302],
	[0, 0, 1, 3, -0.000283],
	[2, 1, 1, -1, -0.000229],
	[1, 1, 0, -1, 0.000223],
	[1, 1, 0, 1, 0.000223],
	[0, 1, -2, -1, -0.00022],
	[2, 1, -1, -1, -0.00022],
	[1, 0, 1, 1, -0.000185],
	[2, -1, -2, -1, 0.000181],
	[0, 1, 2, 1, -0.000177],
	[4, 0, -2, -1, 0.000176],
	[4, -1, -1, -1, 0.000166],
	[1, 0, 1, -1, -0.000164],
	[4, 0, 1, -1, 0.000132],
	[1, 0, -1, -1, -0.000119],
	[4, -1, 0, -1, 0.000115],
	[2, -2, 0, 1, 0.000107],
] as const

// Approximate geocentric position and velocity of the Moon.
export function eraMoon98(tt1: number, tt2: number) {
	// Centuries since J2000.0
	const T = (tt1 - J2000 + tt2) / DAYSPERJC

	// Moon's mean longitude.
	const ELP = normalizeAngle(ELP0 + (ELP1 + (ELP2 + (ELP3 + ELP4 * T) * T) * T) * T)
	const DELP = ELP1 + (ELP2 * 2 + (ELP3 * 3 + ELP4 * 4 * T) * T) * T

	// Moon's mean elongation.
	const D = normalizeAngle(D0 + (D1 + (D2 + (D3 + D4 * T) * T) * T) * T)
	const DD = D1 + (D2 * 2 + (D3 * 3 + D4 * 4 * T) * T) * T

	// Sun's mean anomaly.
	const EM = normalizeAngle(EM0 + (EM1 + (EM2 + (EM3 + EM4 * T) * T) * T) * T)
	const DEM = EM1 + (EM2 * 2 + (EM3 * 3 + EM4 * 4 * T) * T) * T

	// Moon's mean anomaly.
	const EMP = normalizeAngle(EMP0 + (EMP1 + (EMP2 + (EMP3 + EMP4 * T) * T) * T) * T)
	const DEMP = EMP1 + (EMP2 * 2 + (EMP3 * 3 + EMP4 * 4 * T) * T) * T

	// Mean distance of the Moon from its ascending node.
	const F = normalizeAngle(F0 + (F1 + (F2 + (F3 + F4 * T) * T) * T) * T)
	const DF = F1 + (F2 * 2 + (F3 * 3 + F4 * 4 * T) * T) * T

	// Meeus further arguments.
	const A1 = A10 + A11 * T
	const DA1 = AL1 * DEG2RAD
	const A2 = A20 + A21 * T
	const DA2 = A21
	const A3 = A30 + A31 * T
	const DA3 = A31

	// E-factor, and square.
	const E = 1 + (E1 + E2 * T) * T
	const DE = E1 + 2 * E2 * T
	const ESQ = E * E
	const DESQ = 2 * E * DE

	// Use the Meeus additive terms (deg) to start off the summations.
	const ELPMF = ELP - F
	const DELPMF = DELP - DF
	let VEL = AL1 * Math.sin(A1) + AL2 * Math.sin(ELPMF) + AL3 * Math.sin(A2)
	let VDEL = AL1 * Math.cos(A1) * DA1 + AL2 * Math.cos(ELPMF) * DELPMF + AL3 * Math.cos(A2) * DA2

	let VR = 0
	let VDR = 0

	const A1MF = A1 - F
	const DA1MF = DA1 - DF
	const A1PF = A1 + F
	const DA1PF = DA1 + DF
	const DLPMP = ELP - EMP
	const SLPMP = ELP + EMP

	let VB = AB1 * Math.sin(ELP) + AB2 * Math.sin(A3) + AB3 * Math.sin(A1MF) + AB4 * Math.sin(A1PF) + AB5 * Math.sin(DLPMP) + AB6 * Math.sin(SLPMP)
	let VDB = AB1 * Math.cos(ELP) * DELP + AB2 * Math.cos(A3) * DA3 + AB3 * Math.cos(A1MF) * DA1MF + AB4 * Math.cos(A1PF) * DA1PF + AB5 * Math.cos(DLPMP) * (DELP - DEMP) + AB6 * Math.cos(SLPMP) * (DELP + DEMP)

	let EN = 0
	let DEN = 0

	// Longitude and distance plus derivatives.
	for (let n = TLR.length - 1; n >= 0; n--) {
		const [nd, nem, nemp, nf, coefl, coefr] = TLR[n]
		const DN = nd
		const I = nem
		const EMN = I
		const EMPN = nemp
		const FN = nf

		switch (Math.abs(I)) {
			case 1:
				EN = E
				DEN = DE
				break
			case 2:
				EN = ESQ
				DEN = DESQ
				break
			default:
				EN = 1
				DEN = 0
		}

		const ARG = DN * D + EMN * EM + EMPN * EMP + FN * F
		const DARG = DN * DD + EMN * DEM + EMPN * DEMP + FN * DF
		let FARG = Math.sin(ARG)
		let V = FARG * EN
		let DV = Math.cos(ARG) * DARG * EN + FARG * DEN
		VEL += coefl * V
		VDEL += coefl * DV
		FARG = Math.cos(ARG)
		V = FARG * EN
		DV = -Math.sin(ARG) * DARG * EN + FARG * DEN
		VR += coefr * V
		VDR += coefr * DV
	}

	const EL = ELP + VEL * DEG2RAD
	const DEL = (DELP + VDEL * DEG2RAD) / DAYSPERJC
	const R = (VR + R0) / AU_M
	const DR = VDR / AU_M / DAYSPERJC

	let B = 0
	let DB = 0

	// Latitude plus derivative.
	for (let n = TB.length - 1; n >= 0; n--) {
		const [nd, nem, nemp, nf, coefb] = TB[n]
		const DN = nd
		const I = nem
		const EMN = I
		const EMPN = nemp
		const FN = nf

		switch (Math.abs(I)) {
			case 1:
				EN = E
				DEN = DE
				break
			case 2:
				EN = ESQ
				DEN = DESQ
				break
			default:
				EN = 1
				DEN = 0
		}

		const ARG = DN * D + EMN * EM + EMPN * EMP + FN * F
		const DARG = DN * DD + EMN * DEM + EMPN * DEMP + FN * DF
		const FARG = Math.sin(ARG)
		const V = FARG * EN
		const DV = Math.cos(ARG) * DARG * EN + FARG * DEN
		VB += coefb * V
		VDB += coefb * DV
	}

	B = VB * DEG2RAD
	DB = (VDB * DEG2RAD) / DAYSPERJC

	// Longitude, latitude to x, y, z (au)
	const PV = eraS2pv(EL, B, R, DEL, DB, DR)

	// IAU 2006 Fukushima-Williams bias+precession angles.
	const [gamb, phib, psib] = eraPfw06(tt1, tt2)

	// Mean ecliptic coordinates to GCRS rotation matrix.
	const RM = matRotZ(-gamb, matRotX(-phib, matRotZ(psib)))

	matMulVec(RM, PV[0], PV[0])
	matMulVec(RM, PV[1], PV[1])

	return PV
}
