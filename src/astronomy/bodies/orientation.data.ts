import { DAYSPERJC, DEG2RAD, PIOVERTWO } from '../../core/constants'
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
const JA_RATE = 4850.4046 * DEG2RAD
const JB_RATE = 1191.9605 * DEG2RAD
const JC_RATE = 262.5475 * DEG2RAD
const JD_RATE = 6070.2476 * DEG2RAD
const JE_RATE = 64.3 * DEG2RAD

// Neptune precession angle N and its rate (rad per Julian century).
const NEPTUNE_N = 357.85 * DEG2RAD
const NEPTUNE_N_RATE = 52.316 * DEG2RAD

// Sun. Pole and rotation are constant in T; W advances at the sidereal solar rate.
export const SUN_ROTATION: RotationElements = {
	poleRa: [286.13 * DEG2RAD],
	poleDec: [63.87 * DEG2RAD],
	primeMeridian: 84.176 * DEG2RAD,
	rotationRate: 14.1844 * DEG2RAD,
}

// Mercury. The small periodic W terms (arguments linear in d) are omitted (< 0.011 deg).
export const MERCURY_ROTATION: RotationElements = {
	poleRa: [281.0103 * DEG2RAD, -0.0328 * DEG2RAD],
	poleDec: [61.4155 * DEG2RAD, -0.0049 * DEG2RAD],
	primeMeridian: 329.5988 * DEG2RAD,
	rotationRate: 6.1385108 * DEG2RAD,
}

// Venus rotates retrograde, so the prime-meridian rate is negative.
export const VENUS_ROTATION: RotationElements = {
	poleRa: [272.76 * DEG2RAD],
	poleDec: [67.16 * DEG2RAD],
	primeMeridian: 160.2 * DEG2RAD,
	rotationRate: -1.4813688 * DEG2RAD,
}

// Earth, for completeness; W advances at the mean sidereal rotation rate.
export const EARTH_ROTATION: RotationElements = {
	poleRa: [0, -0.641 * DEG2RAD],
	poleDec: [PIOVERTWO, -0.557 * DEG2RAD],
	primeMeridian: 190.147 * DEG2RAD,
	rotationRate: 360.9856235 * DEG2RAD,
}

// Mars. The IAU 2015 periodic refinements (~0.1 deg) are omitted; the linear model is used.
export const MARS_ROTATION: RotationElements = {
	poleRa: [317.68143 * DEG2RAD, -0.1061 * DEG2RAD],
	poleDec: [52.8865 * DEG2RAD, -0.0609 * DEG2RAD],
	primeMeridian: 176.63 * DEG2RAD,
	rotationRate: 350.89198226 * DEG2RAD,
}

// Jupiter. W is System III (magnetic field) rotation; the pole carries the Ja..Je periodic terms.
export const JUPITER_ROTATION: RotationElements = {
	poleRa: [268.056595 * DEG2RAD, -0.006499 * DEG2RAD],
	poleDec: [64.495303 * DEG2RAD, 0.002413 * DEG2RAD],
	primeMeridian: 284.95 * DEG2RAD,
	rotationRate: 870.536 * DEG2RAD,
	poleRaTerms: [
		{ amplitude: 0.000117 * DEG2RAD, argConstant: 99.360714 * DEG2RAD, argRate: JA_RATE, cosine: false },
		{ amplitude: 0.000938 * DEG2RAD, argConstant: 175.895369 * DEG2RAD, argRate: JB_RATE, cosine: false },
		{ amplitude: 0.001432 * DEG2RAD, argConstant: 300.323162 * DEG2RAD, argRate: JC_RATE, cosine: false },
		{ amplitude: 0.00003 * DEG2RAD, argConstant: 114.012305 * DEG2RAD, argRate: JD_RATE, cosine: false },
		{ amplitude: 0.00215 * DEG2RAD, argConstant: 49.511251 * DEG2RAD, argRate: JE_RATE, cosine: false },
	],
	poleDecTerms: [
		{ amplitude: 0.00005 * DEG2RAD, argConstant: 99.360714 * DEG2RAD, argRate: JA_RATE, cosine: true },
		{ amplitude: 0.000404 * DEG2RAD, argConstant: 175.895369 * DEG2RAD, argRate: JB_RATE, cosine: true },
		{ amplitude: 0.000617 * DEG2RAD, argConstant: 300.323162 * DEG2RAD, argRate: JC_RATE, cosine: true },
		{ amplitude: -0.000013 * DEG2RAD, argConstant: 114.012305 * DEG2RAD, argRate: JD_RATE, cosine: true },
		{ amplitude: 0.000926 * DEG2RAD, argConstant: 49.511251 * DEG2RAD, argRate: JE_RATE, cosine: true },
	],
}

// Jupiter atmospheric rotation Systems I and II, used for central-meridian longitude. They share
// Jupiter's IAU pole (the System III pole above, with its Ja..Je periodic terms) but turn at the
// conventional System I (equatorial) and System II (temperate) rates. The prime-meridian offsets W0 are
// calibrated so that the sub-observer west longitude reproduces the standard central-meridian longitude;
// they match PyEphem's Jupiter cmlI/cmlII to ~0.001 deg over the modern era. The System II frame is the
// one the Great Red Spot longitude is conventionally quoted in.

// Jupiter System I (equatorial jet), rotation rate 877.90003539 deg/day.
export const JUPITER_SYSTEM_I: RotationElements = {
	poleRa: JUPITER_ROTATION.poleRa,
	poleDec: JUPITER_ROTATION.poleDec,
	poleRaTerms: JUPITER_ROTATION.poleRaTerms,
	poleDecTerms: JUPITER_ROTATION.poleDecTerms,
	primeMeridian: 65.911 * DEG2RAD,
	rotationRate: 877.90003539 * DEG2RAD,
}

// Jupiter System II (temperate latitudes), rotation rate 870.27003539 deg/day.
export const JUPITER_SYSTEM_II: RotationElements = {
	poleRa: JUPITER_ROTATION.poleRa,
	poleDec: JUPITER_ROTATION.poleDec,
	poleRaTerms: JUPITER_ROTATION.poleRaTerms,
	poleDecTerms: JUPITER_ROTATION.poleDecTerms,
	primeMeridian: 42.167 * DEG2RAD,
	rotationRate: 870.27003539 * DEG2RAD,
}

// Saturn. W is System III rotation.
export const SATURN_ROTATION: RotationElements = {
	poleRa: [40.589 * DEG2RAD, -0.036 * DEG2RAD],
	poleDec: [83.537 * DEG2RAD, -0.004 * DEG2RAD],
	primeMeridian: 38.9 * DEG2RAD,
	rotationRate: 810.7939024 * DEG2RAD,
}

// Uranus rotates retrograde.
export const URANUS_ROTATION: RotationElements = {
	poleRa: [257.311 * DEG2RAD],
	poleDec: [-15.175 * DEG2RAD],
	primeMeridian: 203.81 * DEG2RAD,
	rotationRate: -501.1600928 * DEG2RAD,
}

// Moon auxiliary arguments E1..E13 as [constant (rad), rate (rad per Julian century)]. The IAU tables
// give the rates per day; multiplying by DAYSPERJC keeps them exact in the T-based evaluator, since
// argConstant + (rate*DAYSPERJC)*T = argConstant + rate*d.
const MOON_E = [
	[125.045 * DEG2RAD, -0.0529921 * DEG2RAD * DAYSPERJC],
	[250.089 * DEG2RAD, -0.1059842 * DEG2RAD * DAYSPERJC],
	[260.008 * DEG2RAD, 13.0120009 * DEG2RAD * DAYSPERJC],
	[176.625 * DEG2RAD, 13.3407154 * DEG2RAD * DAYSPERJC],
	[357.529 * DEG2RAD, 0.9856003 * DEG2RAD * DAYSPERJC],
	[311.589 * DEG2RAD, 26.4057084 * DEG2RAD * DAYSPERJC],
	[134.963 * DEG2RAD, 13.064993 * DEG2RAD * DAYSPERJC],
	[276.617 * DEG2RAD, 0.3287146 * DEG2RAD * DAYSPERJC],
	[34.226 * DEG2RAD, 1.7484877 * DEG2RAD * DAYSPERJC],
	[15.134 * DEG2RAD, -0.1589763 * DEG2RAD * DAYSPERJC],
	[119.743 * DEG2RAD, 0.0036096 * DEG2RAD * DAYSPERJC],
	[239.961 * DEG2RAD, 0.1643573 * DEG2RAD * DAYSPERJC],
	[25.053 * DEG2RAD, 12.9590088 * DEG2RAD * DAYSPERJC],
] as const

// Builds a Moon periodic term referencing the i-th (1-based) auxiliary argument.
function moonTerm(i: number, amplitudeDeg: number, cosine: boolean): PeriodicTerm {
	const [argConstant, argRate] = MOON_E[i - 1]
	return { amplitude: amplitudeDeg * DEG2RAD, argConstant, argRate, cosine }
}

// Moon (IAU 2009/2015). The pole and prime meridian carry the E1..E13 physical-libration terms (their
// arguments are linear in d). The tiny -1.4e-12 d^2 term in W (< 2e-4 deg over the modern era) is
// omitted; the periodic arguments are evaluated through the T equivalence above.
export const MOON_ROTATION: RotationElements = {
	poleRa: [269.9949 * DEG2RAD, 0.0031 * DEG2RAD],
	poleDec: [66.5392 * DEG2RAD, 0.013 * DEG2RAD],
	primeMeridian: 38.3213 * DEG2RAD,
	rotationRate: 13.17635815 * DEG2RAD,
	poleRaTerms: [moonTerm(1, -3.8787, false), moonTerm(2, -0.1204, false), moonTerm(3, 0.07, false), moonTerm(4, -0.0172, false), moonTerm(6, 0.0072, false), moonTerm(10, -0.0052, false), moonTerm(13, 0.0043, false)],
	poleDecTerms: [moonTerm(1, 1.5419, true), moonTerm(2, 0.0239, true), moonTerm(3, -0.0278, true), moonTerm(4, 0.0068, true), moonTerm(6, -0.0029, true), moonTerm(7, 0.0009, true), moonTerm(10, 0.0008, true), moonTerm(13, -0.0009, true)],
	primeMeridianTerms: [
		moonTerm(1, 3.561, false),
		moonTerm(2, 0.1208, false),
		moonTerm(3, -0.0642, false),
		moonTerm(4, 0.0158, false),
		moonTerm(5, 0.0252, false),
		moonTerm(6, -0.0066, false),
		moonTerm(7, -0.0047, false),
		moonTerm(8, -0.0046, false),
		moonTerm(9, 0.0028, false),
		moonTerm(10, 0.0052, false),
		moonTerm(11, 0.004, false),
		moonTerm(12, 0.0019, false),
		moonTerm(13, -0.0044, false),
	],
}

// Neptune. The N precession angle modulates both the pole and the prime meridian.
export const NEPTUNE_ROTATION: RotationElements = {
	poleRa: [299.36 * DEG2RAD],
	poleDec: [43.46 * DEG2RAD],
	primeMeridian: 253.18 * DEG2RAD,
	rotationRate: 536.3128492 * DEG2RAD,
	poleRaTerms: [{ amplitude: 0.7 * DEG2RAD, argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: false }],
	poleDecTerms: [{ amplitude: -0.51 * DEG2RAD, argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: true }],
	primeMeridianTerms: [{ amplitude: -0.48 * DEG2RAD, argConstant: NEPTUNE_N, argRate: NEPTUNE_N_RATE, cosine: false }],
}
