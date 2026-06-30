import { DAYSPERJC } from '../../core/constants'
import { deg } from '../../math/units/angle'
import type { PeriodicTerm, RotationElements } from './orientation'

// IAU WGCCRE rotation elements for the Sun and the planets, as published in the 2009/2015 reports of
// the IAU Working Group on Cartographic Coordinates and Rotational Elements. Each body's north-pole
// direction (right ascension and declination, ICRF) is a polynomial in T (Julian centuries TDB from
// J2000) and the prime-meridian angle W is W0 plus a daily rate times d (days TDB from J2000), with
// optional periodic corrections whose arguments are linear in T. Angles are stored in radians.
//
// Provenance and precision: the linear pole/W models reproduce the bodies to ~0.1 deg over the modern
// era. The Jupiter pole periodic terms (Ja..Je) and the Neptune term (N) are included because they are
// part of the standard model; Mercury's small periodic W terms (arguments linear in d, ~0.01 deg) and
// the Mars 2015 periodic refinements are intentionally omitted and noted on those entries. The Moon is
// not included here (its ~13 periodic terms are deferred to a later phase).

// Jupiter pole auxiliary angles Ja..Je (rate in rad per Julian century), shared by the RA and Dec
// periodic corrections.
const JA_RATE = deg(4850.4046)
const JB_RATE = deg(1191.9605)
const JC_RATE = deg(262.5475)
const JD_RATE = deg(6070.2476)
const JE_RATE = deg(64.3)

// Neptune precession angle N and its rate (rad per Julian century).
const NEPTUNE_N = deg(357.85)
const NEPTUNE_N_RATE = deg(52.316)

// Sun. Pole and rotation are constant in T; W advances at the sidereal solar rate.
export const SUN_ROTATION: RotationElements = {
	poleRa: [deg(286.13)],
	poleDec: [deg(63.87)],
	primeMeridian: deg(84.176),
	rotationRate: deg(14.1844),
}

// Mercury. The small periodic W terms (arguments linear in d) are omitted (< 0.011 deg).
export const MERCURY_ROTATION: RotationElements = {
	poleRa: [deg(281.0103), deg(-0.0328)],
	poleDec: [deg(61.4155), deg(-0.0049)],
	primeMeridian: deg(329.5988),
	rotationRate: deg(6.1385108),
}

// Venus rotates retrograde, so the prime-meridian rate is negative.
export const VENUS_ROTATION: RotationElements = {
	poleRa: [deg(272.76)],
	poleDec: [deg(67.16)],
	primeMeridian: deg(160.2),
	rotationRate: deg(-1.4813688),
}

// Earth, for completeness; W advances at the mean sidereal rotation rate.
export const EARTH_ROTATION: RotationElements = {
	poleRa: [deg(0), deg(-0.641)],
	poleDec: [deg(90), deg(-0.557)],
	primeMeridian: deg(190.147),
	rotationRate: deg(360.9856235),
}

// Mars. The IAU 2015 periodic refinements (~0.1 deg) are omitted; the linear model is used.
export const MARS_ROTATION: RotationElements = {
	poleRa: [deg(317.68143), deg(-0.1061)],
	poleDec: [deg(52.8865), deg(-0.0609)],
	primeMeridian: deg(176.63),
	rotationRate: deg(350.89198226),
}

// Jupiter. W is System III (magnetic field) rotation; the pole carries the Ja..Je periodic terms.
export const JUPITER_ROTATION: RotationElements = {
	poleRa: [deg(268.056595), deg(-0.006499)],
	poleDec: [deg(64.495303), deg(0.002413)],
	primeMeridian: deg(284.95),
	rotationRate: deg(870.536),
	poleRaTerms: [
		{ amplitude: deg(0.000117), argConstant: deg(99.360714), argRate: JA_RATE, cosine: false },
		{ amplitude: deg(0.000938), argConstant: deg(175.895369), argRate: JB_RATE, cosine: false },
		{ amplitude: deg(0.001432), argConstant: deg(300.323162), argRate: JC_RATE, cosine: false },
		{ amplitude: deg(0.00003), argConstant: deg(114.012305), argRate: JD_RATE, cosine: false },
		{ amplitude: deg(0.00215), argConstant: deg(49.511251), argRate: JE_RATE, cosine: false },
	],
	poleDecTerms: [
		{ amplitude: deg(0.00005), argConstant: deg(99.360714), argRate: JA_RATE, cosine: true },
		{ amplitude: deg(0.000404), argConstant: deg(175.895369), argRate: JB_RATE, cosine: true },
		{ amplitude: deg(0.000617), argConstant: deg(300.323162), argRate: JC_RATE, cosine: true },
		{ amplitude: deg(-0.000013), argConstant: deg(114.012305), argRate: JD_RATE, cosine: true },
		{ amplitude: deg(0.000926), argConstant: deg(49.511251), argRate: JE_RATE, cosine: true },
	],
}

// Saturn. W is System III rotation.
export const SATURN_ROTATION: RotationElements = {
	poleRa: [deg(40.589), deg(-0.036)],
	poleDec: [deg(83.537), deg(-0.004)],
	primeMeridian: deg(38.9),
	rotationRate: deg(810.7939024),
}

// Uranus rotates retrograde.
export const URANUS_ROTATION: RotationElements = {
	poleRa: [deg(257.311)],
	poleDec: [deg(-15.175)],
	primeMeridian: deg(203.81),
	rotationRate: deg(-501.1600928),
}

// Moon auxiliary arguments E1..E13 as [constant (rad), rate (rad per Julian century)]. The IAU tables
// give the rates per day; multiplying by DAYSPERJC keeps them exact in the T-based evaluator, since
// argConstant + (rate*DAYSPERJC)*T = argConstant + rate*d.
const MOON_E: readonly (readonly [number, number])[] = [
	[deg(125.045), deg(-0.0529921) * DAYSPERJC],
	[deg(250.089), deg(-0.1059842) * DAYSPERJC],
	[deg(260.008), deg(13.0120009) * DAYSPERJC],
	[deg(176.625), deg(13.3407154) * DAYSPERJC],
	[deg(357.529), deg(0.9856003) * DAYSPERJC],
	[deg(311.589), deg(26.4057084) * DAYSPERJC],
	[deg(134.963), deg(13.064993) * DAYSPERJC],
	[deg(276.617), deg(0.3287146) * DAYSPERJC],
	[deg(34.226), deg(1.7484877) * DAYSPERJC],
	[deg(15.134), deg(-0.1589763) * DAYSPERJC],
	[deg(119.743), deg(0.0036096) * DAYSPERJC],
	[deg(239.961), deg(0.1643573) * DAYSPERJC],
	[deg(25.053), deg(12.9590088) * DAYSPERJC],
]

// Builds a Moon periodic term referencing the i-th (1-based) auxiliary argument.
function moonTerm(i: number, amplitudeDeg: number, cosine: boolean): PeriodicTerm {
	const [argConstant, argRate] = MOON_E[i - 1]
	return { amplitude: deg(amplitudeDeg), argConstant, argRate, cosine }
}

// Moon (IAU 2009/2015). The pole and prime meridian carry the E1..E13 physical-libration terms (their
// arguments are linear in d). The tiny -1.4e-12 d^2 term in W (< 2e-4 deg over the modern era) is
// omitted; the periodic arguments are evaluated through the T equivalence above.
export const MOON_ROTATION: RotationElements = {
	poleRa: [deg(269.9949), deg(0.0031)],
	poleDec: [deg(66.5392), deg(0.013)],
	primeMeridian: deg(38.3213),
	rotationRate: deg(13.17635815),
	poleRaTerms: [moonTerm(1, -3.8787, false), moonTerm(2, -0.1204, false), moonTerm(3, 0.07, false), moonTerm(4, -0.0172, false), moonTerm(6, 0.0072, false), moonTerm(10, -0.0052, false), moonTerm(13, 0.0043, false)],
	poleDecTerms: [moonTerm(1, 1.5419, true), moonTerm(2, 0.0239, true), moonTerm(3, -0.0278, true), moonTerm(4, 0.0068, true), moonTerm(6, -0.0029, true), moonTerm(7, 0.0009, true), moonTerm(10, 0.0008, true), moonTerm(13, -0.0009, true)],
	primeMeridianTerms: [moonTerm(1, 3.561, false), moonTerm(2, 0.1208, false), moonTerm(3, -0.0642, false), moonTerm(4, 0.0158, false), moonTerm(5, 0.0252, false), moonTerm(6, -0.0066, false), moonTerm(7, -0.0047, false), moonTerm(8, -0.0046, false), moonTerm(9, 0.0028, false), moonTerm(10, 0.0052, false), moonTerm(11, 0.004, false), moonTerm(12, 0.0019, false), moonTerm(13, -0.0044, false)],
}

// Neptune. The N precession angle modulates both the pole and the prime meridian.
export const NEPTUNE_ROTATION: RotationElements = {
	poleRa: [deg(299.36)],
	poleDec: [deg(43.46)],
	primeMeridian: deg(253.18),
	rotationRate: deg(536.3128492),
	poleRaTerms: [{ amplitude: deg(0.7), argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: false }],
	poleDecTerms: [{ amplitude: deg(-0.51), argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: true }],
	primeMeridianTerms: [{ amplitude: deg(-0.48), argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: false }],
}
