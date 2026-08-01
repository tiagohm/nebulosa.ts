import { expect, test } from 'bun:test'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { ASEC2RAD } from '../../../src/core/constants'
import { rmsOf } from '../../../src/core/util'
import type { PierSide } from '../../../src/devices/indi/device'
import { type Vec3, vecAngle } from '../../../src/math/linear-algebra/vec3'
import { sphericalUnprojectTangentPlane } from '../../../src/math/numerical/geometry'
import { lerp } from '../../../src/math/numerical/math'
import { mulberry32 } from '../../../src/math/numerical/random'
import { type Angle, arcmin, deg, hour, normalizeAngle } from '../../../src/math/units/angle'
import { computePointingError, fitPointingModel, MountPointing, type PointingSample, predictPointingModelError } from '../../../src/observation/mount/pointing'
import { extractPointingContext, predictSemiPhysicalOffset, SEMI_PHYSICAL_TERM_NAMES } from '../../../src/observation/mount/pointing.basis'
import { buildLocalPointingResidual, predictLocalPointingResidual, resolveLocalResidualOptions } from '../../../src/observation/mount/pointing.local'
import { sampleInput } from './pointing.util'

// Covers the local kNN residual layer both in isolation, where the residuals are handed to it directly,
// and through a full fit, where it must recover a localized error the global basis cannot express.

const TIME = timeYMDHMS(2026, 1, 5, 3, 0, 0)
const LATITUDE = deg(-23)
const LONGITUDE = deg(-46)
const LST = localSiderealTime(TIME, LONGITUDE, true)

// Centre of the synthetic patch used by the isolated tests, and of the bump used by the fitted ones.
const CENTER = eraS2c(hour(3), deg(20))

// TPOINT terms of the simulated mount, large enough to dominate the fit but perfectly describable by
// the semi-physical basis, so anything left over is the localized bump.
const TERMS = { CH: 40 * ASEC2RAD, IH: -60 * ASEC2RAD, ID: 50 * ASEC2RAD, NP: -30 * ASEC2RAD, MA: 70 * ASEC2RAD, ME: -55 * ASEC2RAD, TF: 45 * ASEC2RAD }

// Builds a square patch of directions around `CENTER`, `steps` per side, spanning ±`half` radians.
// Offset by half a cell so no grid point coincides with the patch centre a query will use.
function patch(steps: number, half: Angle): Vec3[] {
	const directions: Vec3[] = []
	const cell = (2 * half) / steps

	for (let i = 0; i < steps; i++) {
		for (let j = 0; j < steps; j++) {
			directions.push(sphericalUnprojectTangentPlane(-half + cell * (i + 0.5), -half + cell * (j + 0.5), CENTER))
		}
	}

	return directions
}

// Flattens unit vectors into the `[x0, y0, z0, ...]` layout the layer stores.
function flatten(directions: readonly Vec3[]) {
	const values = new Array<number>(directions.length * 3)

	for (let i = 0; i < directions.length; i++) {
		values[i * 3] = directions[i][0]
		values[i * 3 + 1] = directions[i][1]
		values[i * 3 + 2] = directions[i][2]
	}

	return values
}

// Localized east/north offset (radians) added on top of the mechanical error: a Gaussian bump centred
// on `CENTER`. No combination of TPOINT terms or low-order features can reproduce it, so the global fit
// is bound to smear it and the local layer is the only component that can pick it up.
function bump(direction: Vec3, amplitude: Angle, width: Angle) {
	const separation = vecAngle(CENTER, direction)
	const factor = Math.exp((-separation * separation) / (2 * width * width))
	return { dx: amplitude * factor, dy: -0.6 * amplitude * factor }
}

// Generates samples whose error is the semi-physical model of `TERMS` plus an optional localized bump.
// `spread` limits how far the random targets stray from `CENTER`, so the run is dense enough for a
// neighbourhood average to mean anything.
function generateBumpedSamples(count: number, seed: number, spread: Angle, amplitude: Angle, width: Angle): PointingSample[] {
	const random = mulberry32(seed >>> 0)
	const samples = new Array<PointingSample>(count)

	for (let i = 0; i < count; i++) {
		const direction = sphericalUnprojectTangentPlane(lerp(-spread, spread, random()), lerp(-spread, spread, random()), CENTER)
		const [targetRightAscension, targetDeclination] = eraC2s(...direction)
		const context = extractPointingContext({ rightAscension: targetRightAscension, declination: targetDeclination, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'NEITHER' })
		const physical = predictSemiPhysicalOffset(
			SEMI_PHYSICAL_TERM_NAMES.map((term) => TERMS[term]),
			SEMI_PHYSICAL_TERM_NAMES,
			context,
		)
		const local = bump(direction, amplitude, width)
		const [solvedRightAscension, solvedDeclination] = eraC2s(...sphericalUnprojectTangentPlane(physical.dx + local.dx, physical.dy + local.dy, direction))

		samples[i] = { targetRightAscension: normalizeAngle(targetRightAscension), targetDeclination, solvedRightAscension, solvedDeclination, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'NEITHER' }
	}

	return samples
}

// RMS distance between the error a sample really shows and the error the model predicts for it.
function predictionRms(model: Parameters<typeof predictPointingModelError>[0], samples: readonly PointingSample[]) {
	const residuals = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		const error = computePointingError(sample.targetRightAscension, sample.targetDeclination, sample.solvedRightAscension, sample.solvedDeclination)
		const prediction = predictPointingModelError(model, sampleInput(sample))
		residuals[i] = Math.hypot(error.dx - prediction.dx, error.dy - prediction.dy)
	}

	return rmsOf(residuals)
}

test('the local layer averages same-pier-side residuals and cancels when the side is unknown', () => {
	const directions = patch(6, deg(9))
	const pierSides: PierSide[] = []
	const doubled: Vec3[] = []
	const dx: number[] = []
	const dy: number[] = []

	// The same sky, sampled on both sides of the pier with opposite residuals: a real meridian-flip
	// discontinuity that a side-blind average would erase.
	for (const side of ['EAST', 'WEST'] as const) {
		for (const direction of directions) {
			doubled.push(direction)
			pierSides.push(side)
			dx.push(side === 'EAST' ? arcmin(1) : arcmin(-1))
			dy.push(side === 'EAST' ? arcmin(-0.5) : arcmin(0.5))
		}
	}

	const model = buildLocalPointingResidual(flatten(doubled), pierSides, dx, dy, resolveLocalResidualOptions({ enabled: true, minimumSamples: 8 }))!
	const [rightAscension, declination] = eraC2s(...CENTER)

	expect(model.neighbors).toBe(6)
	expect(model.scale).toBeGreaterThan(0)

	const east = predictLocalPointingResidual(model, rightAscension, declination, 'EAST')
	const west = predictLocalPointingResidual(model, rightAscension, declination, 'WEST')
	const neither = predictLocalPointingResidual(model, rightAscension, declination, 'NEITHER')

	// Every neighbour on a side carries the same residual, so the average returns it, tapered at most by
	// the ratio between the local neighbourhood and the training spacing.
	expect(east.dx).toBeGreaterThan(arcmin(0.7))
	expect(east.dx).toBeLessThanOrEqual(arcmin(1))
	expect(east.dy).toBeCloseTo(-0.5 * east.dx, 12)
	expect(west.dx).toBeCloseTo(-east.dx, 12)
	expect(west.dy).toBeCloseTo(-east.dy, 12)

	// Without a declared side both sets contribute and the discontinuity averages itself away.
	expect(Math.abs(neither.dx)).toBeLessThan(arcmin(0.05))
})

test('the local contribution decays to zero outside the sampled region', () => {
	const directions = patch(6, deg(9))
	const dx = new Array<number>(directions.length).fill(arcmin(1))
	const dy = new Array<number>(directions.length).fill(0)
	const model = buildLocalPointingResidual(flatten(directions), new Array<PierSide>(directions.length).fill('NEITHER'), dx, dy, resolveLocalResidualOptions({ enabled: true, minimumSamples: 8 }))!

	const inside = predictLocalPointingResidual(model, ...eraC2s(...CENTER))
	const [nearRa, nearDec] = eraC2s(...sphericalUnprojectTangentPlane(deg(14), 0, CENTER))
	const [farRa, farDec] = eraC2s(...sphericalUnprojectTangentPlane(deg(60), 0, CENTER))
	const near = predictLocalPointingResidual(model, nearRa, nearDec)
	const far = predictLocalPointingResidual(model, farRa, farDec)

	// Monotonic fade: full strength inside, weakened just outside, effectively gone far away.
	expect(inside.dx).toBeGreaterThan(near.dx)
	expect(near.dx).toBeGreaterThan(far.dx)
	expect(near.dx).toBeLessThan(arcmin(0.6))
	expect(far.dx).toBeLessThan(ASEC2RAD)
	expect(far.dy).toBe(0)
})

test('the local layer is disabled by default and gated by the accepted sample count', () => {
	const samples = generateBumpedSamples(60, 71, deg(16), arcmin(2), deg(6))

	const off = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' } })
	const gated = fitPointingModel(samples.slice(0, 20), { strategy: 'semiPhysical', robust: { method: 'none' }, local: { enabled: true } })
	const on = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, local: { enabled: true } })

	expect(off.local).toBeUndefined()
	expect(gated.local).toBeUndefined()
	expect(on.local).toBeDefined()
	expect(on.local!.pierSides).toHaveLength(on.trainingSampleCount)
	expect(on.local!.residualsDx).toHaveLength(on.trainingSampleCount)

	// The layer never rewrites the diagnostics: those still describe the global fit, which is the only
	// part whose accuracy carries over to an unseen target.
	expect(on.diagnostics.angularRms).toBeCloseTo(off.diagnostics.angularRms, 12)
})

test('the local layer recovers a localized error the semi-physical basis cannot describe', () => {
	const training = generateBumpedSamples(160, 91, deg(16), arcmin(2), deg(6))
	const validation = generateBumpedSamples(40, 92, deg(8), arcmin(2), deg(6))
	const options = { strategy: 'semiPhysical', robust: { method: 'none' }, ridge: 1e-12 } as const

	const global = fitPointingModel(training, options)
	const local = fitPointingModel(training, { ...options, local: { enabled: true } })

	expect(global.usable).toBeTrue()
	expect(local.usable).toBeTrue()

	const globalRms = predictionRms(global, validation)
	const localRms = predictionRms(local, validation)

	// The bump is the only thing the global fit cannot explain, so it survives in its residuals at close
	// to full amplitude; interpolating it locally must remove most of what is left.
	expect(globalRms).toBeGreaterThan(arcmin(0.5))
	expect(localRms).toBeLessThan(globalRms / 2)
})

test('an unusable model never carries a local layer', () => {
	// Four samples cannot constrain seven TPOINT terms, so the fit is unusable and predicts zero. Its
	// "residuals" are then the raw pointing errors, which the local layer must not interpolate.
	const samples = generateBumpedSamples(4, 93, deg(16), arcmin(2), deg(6))
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', local: { enabled: true, minimumSamples: 1 } })

	expect(model.usable).toBeFalse()
	expect(model.local).toBeUndefined()
})

test('the local layer survives an export/import round trip', () => {
	const samples = generateBumpedSamples(80, 94, deg(16), arcmin(2), deg(6))
	const pointing = new MountPointing({ strategy: 'semiPhysical', robust: { method: 'none' }, local: { enabled: true } })

	for (const sample of samples) {
		pointing.add(sample)
	}

	const fitted = pointing.fit()
	const exported = pointing.export()!
	const input = sampleInput(samples[7])
	const before = predictPointingModelError(fitted, input)
	const after = predictPointingModelError(new MountPointing().import(exported), input)

	expect(exported.local).toBeDefined()
	expect(before.components.local).toBeDefined()
	expect(Math.hypot(before.components.local!.dx, before.components.local!.dy)).toBeGreaterThan(0)
	expect(after.dx).toBeCloseTo(before.dx, 12)
	expect(after.dy).toBeCloseTo(before.dy, 12)
})

test('unused site context does not leak into the local layer', () => {
	// The layer is purely geometric: it keys on sky direction and pier side only, so a prediction needs
	// no time or site at all, unlike every context-dependent term of the global basis.
	const samples = generateBumpedSamples(80, 95, deg(16), arcmin(2), deg(6))
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, local: { enabled: true } })
	const [rightAscension, declination] = eraC2s(...CENTER)

	expect(LST).toBeGreaterThan(0)
	expect(model.local).toBeDefined()

	const offset = predictLocalPointingResidual(model.local!, rightAscension, declination)
	expect(Math.hypot(offset.dx, offset.dy)).toBeGreaterThan(arcmin(0.5))
})
