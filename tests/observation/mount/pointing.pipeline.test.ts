import { expect, test } from 'bun:test'
import { equatorialToHorizontal } from '../../../src/astronomy/coordinates/coordinate'
import { horizontalToEnuVector } from '../../../src/astronomy/coordinates/frame.local'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { ASEC2RAD, PI } from '../../../src/core/constants'
import { matRodriguesRotation } from '../../../src/math/linear-algebra/mat3'
import { type Angle, arcmin, deg, hour } from '../../../src/math/units/angle'
import { fitDirectionAlignment } from '../../../src/observation/mount/alignment'
import { createIdealAltAzGeometry } from '../../../src/observation/mount/kinematics'
import { computePointingError, fitPointingModel, type SemiPhysicalTermName } from '../../../src/observation/mount/pointing'
import { celestialToEncoders, encodersToCelestial, type MountPointingChain } from '../../../src/observation/mount/pointing.pipeline'
import { generateMechanicalPointingSamples } from '../../pointing.util'

// Exercises the composition of alignment, kinematics and the residual pointing model. The individual
// layers are covered by their own suites; what matters here is that the two conversions are exact
// inverses and that the residual error is applied in the sky frame, not to encoder angles.

const TIME = timeYMDHMS(2026, 1, 5, 3, 0, 0)
const LATITUDE = deg(-23)
const LONGITUDE = deg(-46)
const CONTEXT = { time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'NEITHER' } as const

// Mechanical misalignments large enough that a first-order treatment would show up as a round-trip error.
const TERMS: Readonly<Record<SemiPhysicalTermName, Angle>> = {
	CH: 90 * ASEC2RAD,
	IH: -150 * ASEC2RAD,
	ID: 110 * ASEC2RAD,
	NP: -70 * ASEC2RAD,
	MA: 180 * ASEC2RAD,
	ME: -130 * ASEC2RAD,
	TF: 120 * ASEC2RAD,
}

// Builds a chain whose base is tilted away from ENU, so the alignment is doing real work.
function buildChain(withModel: boolean): MountPointingChain {
	const rotation = matRodriguesRotation([0.2, -0.5, 1], deg(3))
	const alignment = fitDirectionAlignment([
		{ mount: [1, 0, 0], world: matMulVecLocal(rotation, [1, 0, 0]) },
		{ mount: [0, 0.4, 1], world: matMulVecLocal(rotation, [0, 0.4, 1]) },
	])
	const samples = generateMechanicalPointingSamples(TERMS, { count: 120, seed: 131, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, ridge: 1e-12, validation: { minimumAltitude: -PI / 2 } })

	return { geometry: createIdealAltAzGeometry(), alignment, model: withModel ? model : undefined }
}

// Local 3x3 times vector, kept here so the test does not depend on the matrix module's output aliasing.
function matMulVecLocal(m: Readonly<number[]> | Readonly<Float64Array>, v: readonly [number, number, number]): [number, number, number] {
	return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

test('the celestial and encoder conversions are exact inverses through the whole chain', () => {
	const chain = buildChain(true)
	const desired = { rightAscension: hour(2.4), declination: deg(-15), ...CONTEXT }
	const target = celestialToEncoders(chain, desired)

	expect(target.converged).toBeTrue()
	expect(target.correction.converged).toBeTrue()
	expect(target.correction.clamped).toBeFalse()

	const reached = encodersToCelestial(chain, target, CONTEXT)
	const separation = computePointingError(desired.rightAscension, desired.declination, reached.rightAscension, reached.declination).angularSeparation

	// Both solvers work to about 1e-10 rad, so the composed round trip must stay well under a milliarcsecond.
	expect(separation / ASEC2RAD).toBeLessThan(1e-3)
})

test('the residual model shifts the encoders away from the purely kinematic solution', () => {
	const desired = { rightAscension: hour(2.4), declination: deg(-15), ...CONTEXT }
	const corrected = celestialToEncoders(buildChain(true), desired)
	const kinematic = celestialToEncoders(buildChain(false), desired)
	const shift = Math.hypot(corrected.primary - kinematic.primary, corrected.secondary - kinematic.secondary)

	// The correction is a real slew offset, of the order of the mechanical terms that produced it.
	expect(shift).toBeGreaterThan(arcmin(0.5))
	expect(shift).toBeLessThan(deg(1))

	// Without a model the chain is purely kinematic: the command is the target and nothing is predicted.
	expect(kinematic.correction.rightAscension).toBe(desired.rightAscension)
	expect(kinematic.correction.declination).toBe(desired.declination)
	expect(kinematic.correction.predictedError.dx).toBe(0)
	expect(encodersToCelestial(buildChain(false), kinematic, CONTEXT).predictedError.offsetMagnitude).toBe(0)
})

test('reading back the encoders reports where the mount really points, not what it was commanded', () => {
	const chain = buildChain(true)
	const desired = { rightAscension: hour(5.1), declination: deg(28), ...CONTEXT }
	const reached = encodersToCelestial(chain, celestialToEncoders(chain, desired), CONTEXT)
	const offset = computePointingError(reached.commanded.rightAscension, reached.commanded.declination, reached.rightAscension, reached.declination)

	// The commanded coordinate differs from the achieved one by exactly the predicted residual error.
	expect(offset.dx).toBeCloseTo(reached.predictedError.dx, 10)
	expect(offset.dy).toBeCloseTo(reached.predictedError.dy, 10)
	expect(offset.angularSeparation).toBeGreaterThan(arcmin(0.5))
})

test('the equatorial world frame skips the horizon and needs no observing context', () => {
	const chain: MountPointingChain = { ...buildChain(false), worldFrame: 'equatorial' }
	const desired = { rightAscension: hour(9), declination: deg(40) }
	const target = celestialToEncoders(chain, desired)
	const reached = encodersToCelestial(chain, target)

	expect(target.converged).toBeTrue()
	expect(computePointingError(desired.rightAscension, desired.declination, reached.rightAscension, reached.declination).angularSeparation / ASEC2RAD).toBeLessThan(1e-3)
})

test('the horizon frame refuses to guess a missing observing context', () => {
	const chain = buildChain(false)

	expect(() => celestialToEncoders(chain, { rightAscension: hour(9), declination: deg(40) })).toThrow('the horizontalEnu world frame requires time, latitude and longitude')
	expect(() => encodersToCelestial(chain, { primary: 0.3, secondary: 0.2 })).toThrow('the horizontalEnu world frame requires time, latitude and longitude')
})

test('the kinematic chain reproduces the horizontal direction the alignment was fitted against', () => {
	const chain: MountPointingChain = {
		geometry: createIdealAltAzGeometry(),
		alignment: fitDirectionAlignment([
			{ mount: [1, 0, 0], world: [1, 0, 0] },
			{ mount: [0, 0, 1], world: [0, 0, 1] },
		]),
	}
	const desired = { rightAscension: hour(1.5), declination: deg(-5), ...CONTEXT }
	const target = celestialToEncoders(chain, desired)
	const [azimuth, altitude] = equatorialToHorizontal(desired.rightAscension, desired.declination, LATITUDE, localSiderealTime(TIME, LONGITUDE, true))
	const expected = horizontalToEnuVector(azimuth, altitude)

	// With an identity alignment the encoders must land on the plain ENU direction of the target.
	expect(target.residual).toBeLessThan(1e-9)
	expect(Math.abs(altitude - (PI / 2 - Math.acos(Math.min(1, Math.max(-1, expected[2])))))).toBeLessThan(1e-12)
	expect(encodersToCelestial(chain, target, CONTEXT).rightAscension).toBeCloseTo(desired.rightAscension, 9)
	expect(encodersToCelestial(chain, target, CONTEXT).declination).toBeCloseTo(desired.declination, 9)
})
