import { expect, test } from 'bun:test'
import { affineFromBase, affineToAffine, affineToBase, type AffineFrame, BARYCENTRIC_ECLIPTIC, galactocentricFrame, GALACTOCENTRIC_DEFAULTS, heliocentricEclipticFrame, lsrFrame } from '../../../src/astronomy/coordinates/affine'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { eraS2p } from '../../../src/astronomy/coordinates/erfa/erfa'
import { ECLIPTIC_J2000, frameToFrame, GALACTIC, ICRS } from '../../../src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ONE_KILOPARSEC, ONE_PARSEC } from '../../../src/core/constants'
import { type MutVec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { kilometerPerSecond, toKilometerPerSecond } from '../../../src/math/units/velocity'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC)

// A synthetic Sun ephemeris keeps the heliocentric checks deterministic.
const SUN_POS: MutVec3 = [0.1, -0.9, 0.4]
const SUN_VEL: MutVec3 = [0.001, 0.017, 0.0005]
const HELIOCENTRIC = heliocentricEclipticFrame(() => [SUN_POS, SUN_VEL])

function state(): PositionAndVelocity {
	return [
		[1.2, 0.3, -0.5],
		[0.002, -0.001, 0.0008],
	]
}

test('affineToAffine reduces to frameToFrame when no origin is present', () => {
	// Both ICRS and GALACTIC are plain rotation frames (no origin), so the affine
	// path must match the rotation-only frameToFrame exactly.
	const position: MutVec3 = [0.31, -0.62, 0.72]
	const viaAffine = affineToAffine(position, ICRS, GALACTIC, TIME)
	const viaFrame = frameToFrame(position, ICRS, GALACTIC, TIME)
	for (let i = 0; i < 3; i++) expect(viaAffine[i]).toBeCloseTo(viaFrame[i], 15)
})

test('heliocentric ecliptic shifts the origin to the Sun', () => {
	const s = state()
	const [p, v] = affineFromBase(s, HELIOCENTRIC, TIME)

	// p_helio = R · (p − sun), v_helio = R · (v − sunVelocity), with R = ECLIPTIC_J2000.
	const expectedP = frameToFrame(vecMinus(s[0], SUN_POS), ICRS, ECLIPTIC_J2000, TIME)
	const expectedV = frameToFrame(vecMinus(s[1], SUN_VEL), ICRS, ECLIPTIC_J2000, TIME)
	for (let i = 0; i < 3; i++) {
		expect(p[i]).toBeCloseTo(expectedP[i], 15)
		expect(v[i]).toBeCloseTo(expectedV[i], 15)
	}
})

test('barycentric ecliptic equals ECLIPTIC_J2000 with no translation', () => {
	const s = state()
	const viaAffine = affineFromBase(s, BARYCENTRIC_ECLIPTIC, TIME)
	const viaFrame = frameToFrame(s, ICRS, ECLIPTIC_J2000, TIME)
	for (let i = 0; i < 3; i++) {
		expect(viaAffine[0][i]).toBeCloseTo(viaFrame[0][i], 15)
		expect(viaAffine[1][i]).toBeCloseTo(viaFrame[1][i], 15)
	}
})

test('affineToBase is the exact inverse of affineFromBase', () => {
	const s = state()
	const back = affineToBase(affineFromBase(s, HELIOCENTRIC, TIME), HELIOCENTRIC, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(s[0][i], 14)
		expect(back[1][i]).toBeCloseTo(s[1][i], 14)
	}
})

test('affineToAffine round trips through an affine frame with origin and velocity', () => {
	const s = state()
	const back = affineToAffine(affineToAffine(s, ICRS, HELIOCENTRIC, TIME), HELIOCENTRIC, ICRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(s[0][i], 14)
		expect(back[1][i]).toBeCloseTo(s[1][i], 14)
	}
})

test('a velocity offset alone is handled by an LSR-like frame', () => {
	// No rotation, no translation: only the origin velocity offset applies, so the
	// position is unchanged and the velocity gains the offset.
	const offset: MutVec3 = [0.0003, -0.0002, 0.0004]
	const lsr: AffineFrame = { rotationAt: () => [1, 0, 0, 0, 1, 0, 0, 0, 1], originVelocityAt: () => offset }
	const s = state()
	const [p, v] = affineFromBase(s, lsr, TIME)
	for (let i = 0; i < 3; i++) {
		expect(p[i]).toBeCloseTo(s[0][i], 15)
		expect(v[i]).toBeCloseTo(s[1][i] - offset[i], 15)
	}
})

test('affine transforms write into an output parameter and run in place', () => {
	const s = state()
	const out: PositionAndVelocity = [
		[0, 0, 0],
		[0, 0, 0],
	]
	const fresh = affineFromBase(s, HELIOCENTRIC, TIME)
	const written = affineFromBase(s, HELIOCENTRIC, TIME, out)
	expect(written).toBe(out)
	for (let i = 0; i < 3; i++) {
		expect(out[0][i]).toBeCloseTo(fresh[0][i], 15)
		expect(out[1][i]).toBeCloseTo(fresh[1][i], 15)
	}

	const inPlace: PositionAndVelocity = [[...s[0]], [...s[1]]]
	const result = affineToAffine(inPlace, ICRS, HELIOCENTRIC, TIME, inPlace)
	expect(result).toBe(inPlace)
	for (let i = 0; i < 3; i++) {
		expect(inPlace[0][i]).toBeCloseTo(fresh[0][i], 15)
		expect(inPlace[1][i]).toBeCloseTo(fresh[1][i], 15)
	}
})

// Reference values from Astropy 7.x (galactocentric_frame_defaults 'latest'):
// ICRS cartesian (kpc) -> Galactocentric cartesian (kpc). See scripts in commit
// message; parameters: galcen (266.4051, -28.936175) deg, distance 8.122 kpc,
// z_sun 20.8 pc, roll 0, roll0 58.5986320306 deg.
const GALACTOCENTRIC_CASES: ReadonlyArray<readonly [icrs: readonly [number, number, number], gc: readonly [number, number, number]]> = [
	[
		[0, 0, 0],
		[-8.1219733661223, 0, 0.020800000000000003],
	],
	[
		[1, 2, 3],
		[-11.374949439876023, 1.8453994199476227, 0.1332617465754201],
	],
	[
		[-5, 0.5, 8],
		[-12.134790609735038, 3.2828875918419254, 7.918264582300739],
	],
	[
		[8, -1, 0.2],
		[-7.801331481981943, 4.547111112291164, -6.63209180090982],
	],
	[
		[-2.5, -7, 4],
		[-3.7923054921705672, 4.866451274989415, 5.389377846080299],
	],
]

test('galactocentric frame matches Astropy reference values', () => {
	const gc = galactocentricFrame()
	for (const [icrsKpc, expectedKpc] of GALACTOCENTRIC_CASES) {
		const icrs: MutVec3 = [icrsKpc[0] * ONE_KILOPARSEC, icrsKpc[1] * ONE_KILOPARSEC, icrsKpc[2] * ONE_KILOPARSEC]
		const out = affineFromBase(icrs, gc, TIME)
		for (let i = 0; i < 3; i++) expect(out[i] / ONE_KILOPARSEC).toBeCloseTo(expectedKpc[i], 9)
	}
})

test('galactocentric maps the Galactic center to the origin and round trips', () => {
	const gc = galactocentricFrame()

	// A point at the Galactic center direction and distance lands at the origin.
	const atCenter = eraS2p(GALACTOCENTRIC_DEFAULTS.galcen[0], GALACTOCENTRIC_DEFAULTS.galcen[1], GALACTOCENTRIC_DEFAULTS.galcenDistance)
	const origin = affineFromBase(atCenter, gc, TIME)
	for (let i = 0; i < 3; i++) expect(origin[i] / ONE_KILOPARSEC).toBeCloseTo(0, 9)

	// Full state round trip (position only; velocity zero is fine for orientation).
	const s: PositionAndVelocity = [
		[3 * ONE_KILOPARSEC, -4 * ONE_KILOPARSEC, 2 * ONE_KILOPARSEC],
		[1e-6, -2e-6, 3e-6],
	]
	const back = affineToAffine(affineToAffine(s, ICRS, gc, TIME), gc, ICRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i] / ONE_KILOPARSEC).toBeCloseTo(s[0][i] / ONE_KILOPARSEC, 9)
		expect(back[1][i]).toBeCloseTo(s[1][i], 12)
	}
})

// Reference values from Astropy 7.x LSR (Schönrich, Binney & Dehnen 2010 solar
// motion v_bary = (11.1, 12.24, 7.25) km/s in Galactic UVW). ICRS cartesian
// (position pc, velocity km/s) -> LSR. Position is unchanged; velocity gains the
// barycentric motion. Generated via uv run --with astropy.
const LSR_CASES: ReadonlyArray<readonly [velKms: readonly [number, number, number], lsrVelKms: readonly [number, number, number]]> = [
	[
		[10, -20, 5],
		[9.14820021332169, -36.57592050970972, 12.078375264084205],
	],
	[
		[0, 0, 0],
		[-0.8517997866783104, -16.575920509709718, 7.0783752640842055],
	],
	[
		[-12, 30, -7],
		[-12.85179978667831, 13.424079490290282, 0.07837526408420548],
	],
]

test('LSR frame matches Astropy: position fixed, velocity gains the solar motion', () => {
	const lsr = lsrFrame()
	const pos: MutVec3 = [100 * ONE_PARSEC, 200 * ONE_PARSEC, 50 * ONE_PARSEC]
	for (const [velKms, expectedKms] of LSR_CASES) {
		const s: PositionAndVelocity = [[...pos], [kilometerPerSecond(velKms[0]), kilometerPerSecond(velKms[1]), kilometerPerSecond(velKms[2])]]
		const [p, v] = affineFromBase(s, lsr, TIME)
		// Position is unchanged by the LSR.
		for (let i = 0; i < 3; i++) expect(p[i] / ONE_PARSEC).toBeCloseTo(pos[i] / ONE_PARSEC, 9)
		// Velocity gains the barycentric solar motion.
		for (let i = 0; i < 3; i++) expect(toKilometerPerSecond(v[i])).toBeCloseTo(expectedKms[i], 8)
	}
})
