import { expect, test } from 'bun:test'
import { affineFromBase, affineToAffine, affineToBase, type AffineFrame, BARYCENTRIC_ECLIPTIC, heliocentricEclipticFrame } from '../../../src/astronomy/coordinates/affine'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { ECLIPTIC_J2000, frameToFrame, GALACTIC, ICRS } from '../../../src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { type MutVec3, vecMinus } from '../../../src/math/linear-algebra/vec3'

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
