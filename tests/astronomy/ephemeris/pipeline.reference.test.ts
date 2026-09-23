import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { JUPITER_LIGHT_DEFLECTOR_LIMITER, JUPITER_LIGHT_DEFLECTOR_MASS, SATURN_LIGHT_DEFLECTOR_LIMITER, SATURN_LIGHT_DEFLECTOR_MASS, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from '../../../src/astronomy/coordinates/apparent'
import { lightTimeSolution, type PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { annualAberration } from '../../../src/astronomy/coordinates/correction'
import { eraLd, eraPnm06a } from '../../../src/astronomy/coordinates/erfa/erfa'
import { CIRS, ECLIPTIC_J2000, frameAt, frameToFrame, GALACTIC, ICRS, ITRS } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { bodyRadii, SpiceFrames } from '../../../src/astronomy/ephemeris/kernels/frame.kernel'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readPck } from '../../../src/astronomy/ephemeris/kernels/pck'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { readTextKernel, SpiceKernelPool } from '../../../src/astronomy/ephemeris/kernels/text.kernel'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth as vsopEarth, mars as vsopMars } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER, type EphemerisPath } from '../../../src/astronomy/ephemeris/path'
import { bodySurfaceEphemerisPath, earthObserverEphemerisPath, sgp4EphemerisPath, spkEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { apparentPosition, directionPositionInFrame, equatorialPosition, geometricPositionInFrame, observeEphemeris, type AstrometricPosition, type EphemerisApparentOptions, type EphemerisLightDeflector, type GeometricPosition } from '../../../src/astronomy/ephemeris/position'
import { bodyShape, bodySurfaceLocation } from '../../../src/astronomy/observer/body'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE } from '../../../src/astronomy/orbits/propagation/sgp4'
import { tdb, Timescale, timeSubtract, timeYMDHMS, tt, utc, type Time } from '../../../src/astronomy/time/time'
import { DAYSEC, LIGHT_TIME_AU } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/io'
import { type MutVec3, type Vec3, vecAngle, vecDistance, vecDivScalar, vecDot, vecLength, vecMinus, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { deg, toArcsec } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'
import { PIPELINE_REFERENCE } from './pipeline.reference'
import { expectAngularSeparationBelow, expectVecClose, expectWrappedAngle } from './pipeline.util'

await Promise.all([downloadPerTag('spk'), downloadPerTag('frame.kernel')])

// Same-kernel SPK states. Wider numbers below are model or frame envelopes, not SPK noise.
const SPK_POSITION = 1e-12
const SPK_VELOCITY = 1e-12
// The converged Skyfield emission sample and the 3-iteration snapshot differ by at most 3e-12 AU.
const EMISSION_POSITION = 3e-12
// Astropy 8.0.1 WGS84 plus this eopc04 table leaves a 1.3e-11 AU (~2 m) site residual.
const SITE_POSITION = 2e-11
// Skyfield's topocentric velocity matches the nominal ITRS spin to 8e-11 AU/day.
const SITE_VELOCITY = 1e-10
// Astropy differentiates the whole ITRS→GCRS rotation. That adds at most 6.9e-10 AU/day, about 1.2 mm/s, on top of the nominal spin.
const ASTROPY_SITE_VELOCITY = 1e-9
const SGP4_POSITION = 1e-9
// TEME→GCRS velocity versus Astropy differs by 1.3e-9 AU/day, about 0.2 m/s.
const SGP4_VELOCITY = 2e-9
const DIRECTION = 1e-9
const LIGHT_TIME = 1e-10
const DISTANCE = 1e-12
// Largest measured VSOP87E/ELP component versus DE421 at E0/E1/E5 is under 9e-6 AU or AU/day.
const ANALYTICAL_MODEL_ENVELOPE = 2e-5

const ISS_LINE1 = '1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996'
const ISS_LINE2 = '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611'

type State = { readonly position: readonly [number, number, number]; readonly velocity: readonly [number, number, number] }

type KernelPaths = {
	emb: EphemerisPath
	earthFromEmb: EphemerisPath
	moonFromEmb: EphemerisPath
	sun: EphemerisPath
	mars: EphemerisPath
	jupiter: EphemerisPath
	saturn: EphemerisPath
	neptune: EphemerisPath
	earth: EphemerisPath
	moon: EphemerisPath
}

function referenceEpoch(name: keyof typeof PIPELINE_REFERENCE.epochs): Time {
	const epoch = PIPELINE_REFERENCE.epochs[name]
	const [year, month, day, hour, minute, second] = epoch.ymdhms
	return timeYMDHMS(year, month, day, hour, minute, second, epoch.scale === 'TDB' ? Timescale.TDB : Timescale.UTC)
}

function referenceSite(name: keyof typeof PIPELINE_REFERENCE.observers) {
	const site = PIPELINE_REFERENCE.observers[name]
	return geodeticLocation(deg(site.longitudeDeg), deg(site.latitudeDeg), meter(site.heightM), Ellipsoid.WGS84)
}

function expectState(actual: readonly [readonly number[], readonly number[]], expected: State, positionTolerance: number, velocityTolerance: number) {
	expectVecClose(actual[0], expected.position, positionTolerance)
	expectVecClose(actual[1], expected.velocity, velocityTolerance)
}

function unit(vector: readonly [number, number, number]): Vec3 {
	const scale = 1 / Math.hypot(vector[0], vector[1], vector[2])
	return [vector[0] * scale, vector[1] * scale, vector[2] * scale]
}

function fixedTarget(position: readonly [number, number, number], id: string) {
	return ephemerisPath(SOLAR_SYSTEM_BARYCENTER, customEphemerisEndpoint(id), () => [
		[position[0], position[1], position[2]],
		[0, 0, 0],
	])
}

function sunDeflector(path: EphemerisPath): EphemerisLightDeflector {
	return { mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, path }
}

function jupiterDeflector(path: EphemerisPath): EphemerisLightDeflector {
	return { mass: JUPITER_LIGHT_DEFLECTOR_MASS, limiter: JUPITER_LIGHT_DEFLECTOR_LIMITER, path }
}

function saturnDeflector(path: EphemerisPath): EphemerisLightDeflector {
	return { mass: SATURN_LIGHT_DEFLECTOR_MASS, limiter: SATURN_LIGHT_DEFLECTOR_LIMITER, path }
}

// One finite-source eraLd pass per body, in caller order, then normalized. This is the amplitude
// oracle for a deflector state. It does not call apparentPosition.
function finiteSourceDeflection(observed: AstrometricPosition, bodies: readonly { readonly position: Vec3; readonly velocity: Vec3; readonly mass: number; readonly limiter: number }[]): Vec3 {
	const direction: MutVec3 = [observed.direction[0], observed.direction[1], observed.direction[2]]
	const lightDaysPerAu = LIGHT_TIME_AU / DAYSEC
	const [ox, oy, oz] = observed.observerPosition
	const [tx, ty, tz] = observed.targetEmissionPosition

	for (const body of bodies) {
		const [bx, by, bz] = body.position
		const [vx, vy, vz] = body.velocity
		let delay = (direction[0] * (bx - ox) + direction[1] * (by - oy) + direction[2] * (bz - oz)) * lightDaysPerAu
		if (!(delay > 0)) delay = 0
		else if (delay > observed.lightTime) delay = observed.lightTime
		const cx = bx - delay * vx
		const cy = by - delay * vy
		const cz = bz - delay * vz
		const ex = ox - cx
		const ey = oy - cy
		const ez = oz - cz
		const em = Math.hypot(ex, ey, ez)
		const qx = tx - cx
		const qy = ty - cy
		const qz = tz - cz
		const qm = Math.hypot(qx, qy, qz)
		eraLd(body.mass, direction, [qx / qm, qy / qm, qz / qm], [ex / em, ey / em, ez / em], em, body.limiter, direction)
	}

	return vecDivScalar(direction, vecLength(direction))
}

async function kernelPaths(file: string): Promise<{ paths: KernelPaths; close: () => Promise<void> }> {
	const source = fileHandleSource(await fs.open(file))
	const spk = readSpk(await readDaf(source))
	const segment = async (center: number, target: number) => {
		const path = await spkEphemerisPath(spk, center, target)
		if (!path) throw new Error(`${file} has no ${center} -> ${target} segment`)
		return path
	}
	const emb = await segment(Naif.SSB, Naif.EMB)
	const earthFromEmb = await segment(Naif.EMB, Naif.EARTH)
	const moonFromEmb = await segment(Naif.EMB, Naif.MOON)
	const paths: KernelPaths = {
		emb,
		earthFromEmb,
		moonFromEmb,
		sun: await segment(Naif.SSB, Naif.SUN),
		mars: await segment(Naif.SSB, Naif.MARS_BARYCENTER),
		jupiter: await segment(Naif.SSB, Naif.JUPITER_BARYCENTER),
		saturn: await segment(Naif.SSB, Naif.SATURN_BARYCENTER),
		neptune: await segment(Naif.SSB, Naif.NEPTUNE_BARYCENTER),
		earth: composeEphemerisPaths(emb, earthFromEmb),
		moon: composeEphemerisPaths(emb, moonFromEmb),
	}
	return { paths, close: () => source.close() }
}

const first = await kernelPaths('data/de421.bsp')
const second = await kernelPaths('data/de440s.bsp')

const de421 = first.paths
const de440 = second.paths

afterAll(async () => {
	await first.close()
	await second.close()
})

test('SPK geometric paths match Skyfield on DE421 and DE440s', () => {
	for (const epoch of ['E0', 'E1', 'E4', 'E5'] as const) {
		const time = referenceEpoch(epoch)
		const expected = PIPELINE_REFERENCE.geometric.de421[epoch]
		expectState(de421.emb.stateAt(time), expected.emb, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.earthFromEmb.stateAt(time), expected.earthFromEmb, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.moonFromEmb.stateAt(time), expected.moonFromEmb, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.sun.stateAt(time), expected.sun, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.mars.stateAt(time), expected.marsBarycenter, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.jupiter.stateAt(time), expected.jupiterBarycenter, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.saturn.stateAt(time), expected.saturnBarycenter, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.neptune.stateAt(time), expected.neptuneBarycenter, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.earth.stateAt(time), expected.earth, SPK_POSITION, SPK_VELOCITY)
		expectState(de421.moon.stateAt(time), expected.moon, SPK_POSITION, SPK_VELOCITY)
		expect(de421.earth.center).toEqual(naifEphemerisEndpoint(Naif.SSB))
		expect(de421.earth.target).toEqual(naifEphemerisEndpoint(Naif.EARTH))
		expect(de421.moon.target).toEqual(naifEphemerisEndpoint(Naif.MOON))
	}

	const modern = referenceEpoch('E1')
	const de440Expected = PIPELINE_REFERENCE.geometric.de440s.E1
	expectState(de440.earth.stateAt(modern), de440Expected.earth, SPK_POSITION, SPK_VELOCITY)
	expectState(de440.mars.stateAt(modern), de440Expected.marsBarycenter, SPK_POSITION, SPK_VELOCITY)
	expectState(de440.jupiter.stateAt(modern), de440Expected.jupiterBarycenter, SPK_POSITION, SPK_VELOCITY)
})

describe('Skyfield and Astropy agree on DE421 barycentric states', () => {
	for (const epoch of ['E0', 'E1', 'E4', 'E5'] as const) {
		test(epoch, () => {
			const skyfield = PIPELINE_REFERENCE.geometric.de421[epoch]
			const astropy = PIPELINE_REFERENCE.astropyBarycentric[epoch]
			expectState([skyfield.earth.position, skyfield.earth.velocity], astropy.earth, 1e-9, 1e-9)
			expectState([skyfield.marsBarycenter.position, skyfield.marsBarycenter.velocity], astropy.mars, 1e-9, 1e-9)
			expectState([skyfield.moon.position, skyfield.moon.velocity], astropy.moon, 1e-9, 1e-9)
			const separation = Math.hypot(skyfield.marsBarycenter.position[0] - skyfield.earth.position[0], skyfield.marsBarycenter.position[1] - skyfield.earth.position[1], skyfield.marsBarycenter.position[2] - skyfield.earth.position[2])
			const astropySeparation = Math.hypot(astropy.mars.position[0] - astropy.earth.position[0], astropy.mars.position[1] - astropy.earth.position[1], astropy.mars.position[2] - astropy.earth.position[2])
			expect(Math.abs(separation - astropySeparation)).toBeLessThanOrEqual(1e-9)
		})
	}
})

describe('VSOP87E and ELP stay inside their DE421 model envelope', () => {
	for (const epoch of ['E0', 'E1', 'E5'] as const) {
		test(epoch, () => {
			const time = referenceEpoch(epoch)
			const jpl = PIPELINE_REFERENCE.geometric.de421[epoch]
			const earthState = vsopEarth(time)
			const marsState = vsopMars(time)
			const moonState = moon(time)
			expectState(earthState, jpl.earth, ANALYTICAL_MODEL_ENVELOPE, ANALYTICAL_MODEL_ENVELOPE)
			expectState(marsState, jpl.marsBarycenter, ANALYTICAL_MODEL_ENVELOPE, ANALYTICAL_MODEL_ENVELOPE)
			expectState([vecPlus(earthState[0], moonState[0]), vecPlus(earthState[1], moonState[1])], jpl.moon, ANALYTICAL_MODEL_ENVELOPE, ANALYTICAL_MODEL_ENVELOPE)
		})
	}
})

describe('geocentric light time matches Skyfield and tightens with iteration', () => {
	const time = referenceEpoch('E1')

	for (const name of ['moon', 'sun', 'mars', 'jupiter', 'neptune'] as const) {
		test(name, () => {
			const expected = PIPELINE_REFERENCE.observe[name]
			const observed = observeEphemeris(de421.earth, de421[name], time)!
			expectVecClose(observed.position, expected.position, DISTANCE)
			expect(Math.abs(observed.distance - expected.distance)).toBeLessThanOrEqual(DISTANCE)
			expect(Math.abs(observed.lightTime - expected.lightTime)).toBeLessThanOrEqual(LIGHT_TIME)
			expect(Math.abs(tdb(observed.emissionTime).day + tdb(observed.emissionTime).fraction - expected.emissionJd)).toBeLessThanOrEqual(LIGHT_TIME)
			expectVecClose(observed.observerPosition, expected.observerPosition, SPK_POSITION)
			expectVecClose(observed.observerVelocity, expected.observerVelocity, SPK_VELOCITY)
			expectVecClose(observed.targetEmissionPosition, expected.targetEmissionPosition, EMISSION_POSITION)
			expectAngularSeparationBelow(observed.direction, unit(expected.position), DIRECTION)
			const [rightAscension, declination, distance] = equatorialPosition(observed)
			expectWrappedAngle(rightAscension, expected.ra, DIRECTION)
			expect(Math.abs(declination - expected.dec)).toBeLessThanOrEqual(DIRECTION)
			expect(Math.abs(distance - expected.distance)).toBeLessThanOrEqual(DISTANCE)

			if (name === 'sun') return

			let previous = Number.POSITIVE_INFINITY
			for (const iterations of [0, 1, 2, 3, 4]) {
				const partial = observeEphemeris(de421.earth, de421[name], time, { lightTimeIterations: iterations })!
				const error = vecAngle(partial.direction, unit(expected.position))
				expect(error).toBeLessThanOrEqual(previous + 1e-15)
				previous = error
			}

			expect(previous).toBeLessThanOrEqual(DIRECTION)
		})
	}
})

describe('a WGS84 site matches Skyfield astrometry and the geocenter parallax direction', () => {
	const time = referenceEpoch('E1')
	const site = composeEphemerisPaths(de421.earth, earthObserverEphemerisPath(referenceSite('O1'), customEphemerisEndpoint('O1')))

	for (const name of ['moon', 'mars', 'jupiter'] as const) {
		test(name, () => {
			const expected = PIPELINE_REFERENCE.topocentric[name]
			const observed = observeEphemeris(site, de421[name], time)!
			expectAngularSeparationBelow(observed.direction, unit(expected.position), DIRECTION)
			expect(Math.abs(observed.distance - expected.distance)).toBeLessThanOrEqual(1e-9)
			expect(Math.abs(observed.lightTime - expected.lightTime)).toBeLessThanOrEqual(LIGHT_TIME)
			const [rightAscension, declination] = equatorialPosition(observed)
			expectWrappedAngle(rightAscension, expected.ra, DIRECTION)
			expect(Math.abs(declination - expected.dec)).toBeLessThanOrEqual(DIRECTION)
			const geocentric = unit(PIPELINE_REFERENCE.observe[name].position)
			const skyfieldShift = vecMinus(unit(expected.position), geocentric)
			const nebulosaShift = vecMinus(observed.direction, unit(PIPELINE_REFERENCE.observe[name].position))
			expect(vecDot(skyfieldShift, nebulosaShift)).toBeGreaterThan(0)
		})
	}
})

describe('a surface observer apparent place includes diurnal aberration', () => {
	const time = referenceEpoch('E1')
	const site = composeEphemerisPaths(de421.earth, earthObserverEphemerisPath(referenceSite('O1'), customEphemerisEndpoint('O1')))

	for (const name of ['moon', 'mars'] as const) {
		test(name, () => {
			const geocentric = observeEphemeris(de421.earth, de421[name], time)!
			const topocentric = observeEphemeris(site, de421[name], time)!
			const sunDistance = vecDistance(topocentric.observerPosition, de421.sun.stateAt(time)[0])
			const diurnal = annualAberration(topocentric.direction, topocentric.observerVelocity, sunDistance)
			const annualOnly = annualAberration(topocentric.direction, geocentric.observerVelocity, sunDistance)
			const aberrationOnly = apparentPosition(topocentric, { sun: de421.sun, deflectors: [] })
			// Skyfield apparent(deflectors=()) still bends light by the Earth unless the target
			// falls inside the nadir cutoff. Mars at E1 is inside that cutoff, so the match is
			// aberration only. The Moon still carries 2.5e-10 rad of that deflection.
			const topocentricTolerance = name === 'moon' ? 1e-9 : 1e-11
			expect(vecDistance(diurnal, aberrationOnly.direction)).toBeLessThan(1e-12)
			expect(vecAngle(diurnal, annualOnly)).toBeGreaterThan(1e-7)
			expect(vecDistance(topocentric.observerVelocity, geocentric.observerVelocity)).toBeGreaterThan(2e-4)
			expectAngularSeparationBelow(apparentPosition(geocentric, { sun: de421.sun, deflectors: [] }).direction, PIPELINE_REFERENCE.diurnal[name].geocentric, 1e-11)
			expectAngularSeparationBelow(aberrationOnly.direction, PIPELINE_REFERENCE.diurnal[name].topocentric, topocentricTolerance)
		})
	}
})

describe('the Moon center observes Earth, the Sun, and Mars like Skyfield', () => {
	const time = referenceEpoch('E1')

	for (const name of ['earth', 'sun', 'mars'] as const) {
		test(name, () => {
			const expected = PIPELINE_REFERENCE.moonObserver[name]
			const observed = observeEphemeris(de421.moon, de421[name], time)!
			expectAngularSeparationBelow(observed.direction, unit(expected.position), DIRECTION)
			expect(Math.abs(observed.distance - expected.distance)).toBeLessThanOrEqual(DISTANCE)
			expect(Math.abs(observed.lightTime - expected.lightTime)).toBeLessThanOrEqual(LIGHT_TIME)
			expectVecClose(observed.observerPosition, expected.observerPosition, SPK_POSITION)
			expectVecClose(observed.targetEmissionPosition, expected.targetEmissionPosition, EMISSION_POSITION)
		})
	}
})

test('apparent directions match Skyfield deflector sets and preserve astrometric metadata', () => {
	const time = referenceEpoch('E1')
	const sets = {
		none: [],
		sun: [sunDeflector(de421.sun)],
		sunJupiter: [sunDeflector(de421.sun), jupiterDeflector(de421.jupiter)],
		full: [sunDeflector(de421.sun), jupiterDeflector(de421.jupiter), saturnDeflector(de421.saturn)],
		jupiterThenSun: [jupiterDeflector(de421.jupiter), sunDeflector(de421.sun)],
	} as const

	for (const name of ['mars', 'jupiter', 'sun'] as const) {
		const astrometric = observeEphemeris(de421.earth, de421[name], time)!
		const expected = PIPELINE_REFERENCE.apparent[name]

		for (const key of ['none', 'sun', 'sunJupiter', 'full', 'jupiterThenSun'] as const) {
			const apparent = apparentPosition(astrometric, { sun: de421.sun, deflectors: sets[key] })
			// Deflecting the Sun by the Sun is singular: Skyfield leaves the aberrated vector
			// unchanged, while finite-source deflection moves it by about 0.11 arcsec.
			const tolerance = name === 'sun' && key !== 'none' ? 1e-6 : DIRECTION
			expectAngularSeparationBelow(apparent.direction, expected.directions[key], tolerance)
			expect(apparent.distance).toBe(astrometric.distance)
			expect(apparent.lightTime).toBe(astrometric.lightTime)
			expect(apparent.emissionTime).toBe(astrometric.emissionTime)
			expect(apparent.center).toBe(astrometric.center)
			expect(apparent.target).toBe(astrometric.target)
		}

		const aberrated = apparentPosition(astrometric, { sun: de421.sun, deflectors: [] })
		expect(vecAngle(aberrated.direction, astrometric.direction)).toBeGreaterThan(1e-5)
		expect(vecAngle(aberrated.direction, astrometric.direction)).toBeLessThan(2e-4)
		const [rightAscension, declination] = equatorialPosition(aberrated)
		expectWrappedAngle(rightAscension, expected.ra, DIRECTION)
		expect(Math.abs(declination - expected.dec)).toBeLessThanOrEqual(DIRECTION)
		const [astrometricRa, astrometricDec] = equatorialPosition(astrometric)
		expectWrappedAngle(astrometricRa, expected.astrometricRa, DIRECTION)
		expect(Math.abs(astrometricDec - expected.astrometricDec)).toBeLessThanOrEqual(DIRECTION)
	}
})

test('gravitational deflection matches Skyfield and falls off away from the limb', () => {
	const time = referenceEpoch('E1')
	const shifts: Record<string, number> = {}
	const cases = {
		solarLimb: [sunDeflector(de421.sun)],
		solar1deg: [sunDeflector(de421.sun)],
		solar10deg: [sunDeflector(de421.sun)],
		jupiterLimb: [jupiterDeflector(de421.jupiter)],
		jupiterAway: [jupiterDeflector(de421.jupiter)],
		saturnNear: [saturnDeflector(de421.saturn)],
		saturnAway: [saturnDeflector(de421.saturn)],
	} as const

	for (const name of ['solarLimb', 'solar1deg', 'solar10deg', 'jupiterLimb', 'jupiterAway', 'saturnNear', 'saturnAway'] as const) {
		const expected = PIPELINE_REFERENCE.deflection[name]
		const observed = observeEphemeris(de421.earth, fixedTarget(expected.target, name), time)!
		const bare = apparentPosition(observed, { sun: de421.sun, deflectors: [] })
		expectAngularSeparationBelow(bare.direction, expected.noDeflection, DIRECTION)

		if (name.startsWith('solar')) {
			const bent = apparentPosition(observed, { sun: de421.sun, deflectors: cases[name] })
			expectAngularSeparationBelow(bent.direction, expected.apparent, DIRECTION)
			shifts[name] = vecAngle(bare.direction, bent.direction)
			expect(Math.abs(shifts[name] - expected.shiftRad)).toBeLessThanOrEqual(DIRECTION)
			continue
		}

		// Skyfield's 599/699 centers are not in DE421. The amplitude oracle is eraLd on the
		// barycenter state this path actually samples. Skyfield only checks the shift direction.
		const planetary = name.startsWith('jupiter')
		const body = planetary ? de421.jupiter : de421.saturn
		const [position, velocity] = body.stateAt(time)
		const bent = apparentPosition(observed, { aberration: false, deflectors: cases[name] })
		const manual = finiteSourceDeflection(observed, [
			{
				position,
				velocity,
				mass: planetary ? JUPITER_LIGHT_DEFLECTOR_MASS : SATURN_LIGHT_DEFLECTOR_MASS,
				limiter: planetary ? JUPITER_LIGHT_DEFLECTOR_LIMITER : SATURN_LIGHT_DEFLECTOR_LIMITER,
			},
		])
		expect(vecDistance(bent.direction, manual)).toBeLessThan(1e-12)
		const aberrated = apparentPosition(observed, { sun: de421.sun, deflectors: cases[name] })
		expect(vecDot(vecMinus(aberrated.direction, bare.direction), vecMinus(expected.apparent, expected.noDeflection))).toBeGreaterThan(0)
		shifts[name] = vecAngle(apparentPosition(observed, { aberration: false, deflectors: [] }).direction, bent.direction)
	}

	expect(shifts.solarLimb).toBeGreaterThan(shifts.solar1deg)
	expect(shifts.solar1deg).toBeGreaterThan(shifts.solar10deg)
	expect(shifts.jupiterLimb).toBeGreaterThan(shifts.jupiterAway)
	expect(shifts.saturnNear).toBeGreaterThan(shifts.saturnAway)
	expect(toArcsec(shifts.solarLimb)).toBeCloseTo(1.75, 2)
	const mars = observeEphemeris(de421.earth, de421.mars, time)!
	const finite = apparentPosition(mars, { sun: de421.sun, deflectors: [sunDeflector(de421.sun)] })
	const finiteBare = apparentPosition(mars, { sun: de421.sun, deflectors: [] })
	expectAngularSeparationBelow(finiteBare.direction, PIPELINE_REFERENCE.deflection.finiteMars.noDeflection, DIRECTION)
	expectAngularSeparationBelow(finite.direction, PIPELINE_REFERENCE.deflection.finiteMars.apparent, DIRECTION)
})

describe('Astropy apparent GCRS directions agree at the gross-error tolerance', () => {
	const time = referenceEpoch('E1')
	const options: EphemerisApparentOptions = { sun: de421.sun, deflectors: [sunDeflector(de421.sun), jupiterDeflector(de421.jupiter), saturnDeflector(de421.saturn)] }

	for (const name of ['mars', 'jupiter', 'moon'] as const) {
		test(name, () => {
			const apparent = apparentPosition(observeEphemeris(de421.earth, de421[name], time)!, options)
			expectAngularSeparationBelow(apparent.direction, PIPELINE_REFERENCE.astropyApparent[name].direction, 1e-6)
			expect(Math.abs(apparent.distance - PIPELINE_REFERENCE.astropyApparent[name].distance)).toBeLessThanOrEqual(1e-8)
		})
	}
})

test('Earth-centered sites match Astropy WGS84/GCRS and one Skyfield topocentric state', () => {
	for (const epoch of ['E2', 'E3'] as const) {
		const time = referenceEpoch(epoch)

		for (const name of ['O1', 'O2', 'O3'] as const) {
			const site = earthObserverEphemerisPath(referenceSite(name), customEphemerisEndpoint(name))
			const state = site.stateAt(time)
			expectState(state, PIPELINE_REFERENCE.earthSite.astropy[epoch][name], SITE_POSITION, ASTROPY_SITE_VELOCITY)
			expectState(state, PIPELINE_REFERENCE.earthSite.skyfield[epoch][name], SITE_POSITION, SITE_VELOCITY)
			expect(vecLength(state[0])).toBeGreaterThan(4e-5)
			expect(vecLength(state[0])).toBeLessThan(4.4e-5)
			expect(composeEphemerisPaths(de421.earth, site).stateAt(time)[0].every(Number.isFinite)).toBe(true)
		}
	}

	const e2 = referenceEpoch('E2')
	const o1 = earthObserverEphemerisPath(referenceSite('O1'), customEphemerisEndpoint('O1'))
	const barycentricSite = composeEphemerisPaths(de421.earth, o1).stateAt(e2)
	const earthBary = de421.earth.stateAt(e2)
	const site = PIPELINE_REFERENCE.earthSite.astropy.E2.O1

	for (let axis = 0; axis < 3; axis++) {
		expect(Math.abs(barycentricSite[0][axis] - (earthBary[0][axis] + site.position[axis]))).toBeLessThanOrEqual(SITE_POSITION)
		expect(Math.abs(barycentricSite[1][axis] - (earthBary[1][axis] + site.velocity[axis]))).toBeLessThanOrEqual(ASTROPY_SITE_VELOCITY)
	}
})

describe('SGP4 GCRS and ITRS states match Astropy and Skyfield', () => {
	const path = sgp4EphemerisPath(parseTLE(ISS_LINE1, ISS_LINE2))

	for (const name of ['epoch', 'minus1d', 'plus1d', 'plus3h'] as const) {
		test(name, () => {
			const sample = PIPELINE_REFERENCE.sgp4[name]
			const [year, month, day, hour, minute, second] = sample.ymdhms
			const time = timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
			const state = path.stateAt(time)
			expectState(state, sample.astropy, SGP4_POSITION, SGP4_VELOCITY)
			expectState(state, sample.skyfield, SGP4_POSITION, SGP4_VELOCITY)
			const full = frameToFrame(state, ICRS, ITRS, time)
			expectState(full, sample.astropyItrs, SGP4_POSITION, SGP4_VELOCITY)
			// Rotation alone leaves the velocity in AU/day. The gap is the W = dR/dt·Rᵀ term.
			const rotationOnly = frameAt(state, { rotationAt: ITRS.rotationAt }, time)
			expect(vecDistance(full[1], rotationOnly[1])).toBeGreaterThan(1e-6)
		})
	}
})

test('frame directions and the high-level spherical state match the external subset', () => {
	// E3 is inside the eopc04 window tests/setup.ts actually loads. E1 is earlier and clamps to the first row.
	const time = referenceEpoch('E3')
	// The suite caches the precession-nutation matrix by rounded Julian day. ITRS must see the matrix at this instant.
	time.providers = { pnm: (sample) => eraPnm06a(sample.day, sample.fraction) }
	const vector = PIPELINE_REFERENCE.frames.vector
	const observed = observeEphemeris(de421.earth, fixedTarget([vector[0], vector[1], vector[2]], 'frame-vector'), time)!
	expectAngularSeparationBelow(directionPositionInFrame({ ...observed, direction: vector }, GALACTIC), PIPELINE_REFERENCE.frames.galactic, 1e-10)
	// The fixed J2000 ecliptic matrix differs from Astropy's IAU 2006 mean obliquity by about 22 mas.
	expectAngularSeparationBelow(frameAt(vector, ECLIPTIC_J2000, time), PIPELINE_REFERENCE.frames.eclipticJ2000, 2e-7)
	// CIRS and ITRS goldens are ERFA rotations of the same vector, without SkyCoord aberration.
	expectAngularSeparationBelow(frameAt(vector, CIRS, time), PIPELINE_REFERENCE.frames.cirs, 1e-10)
	expectAngularSeparationBelow(frameAt(vector, ITRS, time), PIPELINE_REFERENCE.frames.itrs, 1e-10)
	const geometric: GeometricPosition = { kind: 'geometric', time, center: SOLAR_SYSTEM_BARYCENTER, target: naifEphemerisEndpoint(Naif.MARS_BARYCENTER), position: [0.8, -0.4, 0.3], velocity: [0.012, -0.007, 0.004] }
	const spherical = geometricPositionInFrame(geometric, ICRS)
	expectVecClose(spherical[0], geometric.position, 1e-15)
	expectVecClose(spherical[1], geometric.velocity, 1e-15)
})

describe('analytic light time matches an independent Newton solution', () => {
	const time = referenceEpoch('E1')

	for (const item of PIPELINE_REFERENCE.analytic) {
		test(item.name, () => {
			const observer = (): PositionAndVelocity => [
				[item.observer[0], item.observer[1], item.observer[2]],
				[item.observerVelocity[0], item.observerVelocity[1], item.observerVelocity[2]],
			]
			const target = (sample: Time): PositionAndVelocity => {
				const dt = sample.day - time.day + (sample.fraction - time.fraction)
				return [
					[item.targetPosition[0] + item.targetVelocity[0] * dt, item.targetPosition[1] + item.targetVelocity[1] * dt, item.targetPosition[2] + item.targetVelocity[2] * dt],
					[item.targetVelocity[0], item.targetVelocity[1], item.targetVelocity[2]],
				]
			}
			const solution = lightTimeSolution(target, observer, time, 8)!
			expect(Math.abs(solution.lightTime - item.lightTime)).toBeLessThanOrEqual(1e-12)
			expectVecClose(solution.position, item.position, 1e-12)
			expectVecClose(solution.targetEmissionPosition, item.emissionPosition, 1e-12)
			expect(solution.distance).toBeGreaterThan(0)
		})
	}
})

test('one physical instant is independent of the UTC, TT, or TDB label', () => {
	const dynamical = referenceEpoch('E1')
	const terrestrial = tt(dynamical)
	const civil = utc(dynamical)
	expect(Math.abs(timeSubtract(tdb(terrestrial), dynamical, Timescale.TDB))).toBeLessThan(1e-12)
	expect(Math.abs(timeSubtract(tdb(civil), dynamical, Timescale.TDB))).toBeLessThan(1e-12)
	for (const path of [de421.earth, de421.mars]) {
		const reference = path.stateAt(dynamical)
		expectState(path.stateAt(terrestrial), { position: reference[0], velocity: reference[1] }, 1e-12, 1e-12)
		expectState(path.stateAt(civil), { position: reference[0], velocity: reference[1] }, 1e-12, 1e-12)
	}
	const site = earthObserverEphemerisPath(referenceSite('O1'), customEphemerisEndpoint('O1'))
	const observed = observeEphemeris(de421.earth, de421.mars, dynamical)!
	const again = observeEphemeris(de421.earth, de421.mars, civil)!
	expectAngularSeparationBelow(observed.direction, again.direction, 1e-12)
	expectState(site.stateAt(civil), { position: site.stateAt(dynamical)[0], velocity: site.stateAt(dynamical)[1] }, SITE_POSITION, SITE_VELOCITY)
})

test('Aristarchus geometric, astrometric, and apparent place match Skyfield', async () => {
	const pool = new SpiceKernelPool()
	await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
	pool.load(await readTextKernel(fk))
	await using textPck = fileHandleSource(await fs.open('data/pck00008.tpc'))
	pool.load(await readTextKernel(textPck))
	await using binaryPck = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(binaryPck))
	await pck.initialize()
	const frames = new SpiceFrames(pool, pck)
	const frame = await frames.frame('MOON_ME_DE421')
	const time = referenceEpoch('E2')
	const location = bodySurfaceLocation(deg(-46.8), deg(26.3), 0, bodyShape(bodyRadii(pool, Naif.MOON)!), frame)
	const surface = bodySurfaceEphemerisPath(naifEphemerisEndpoint(Naif.MOON), customEphemerisEndpoint('aristarchus'), location)
	const aristarchus = composeEphemerisPaths(de421.moon, surface)
	const expected = PIPELINE_REFERENCE.aristarchus
	expectState(surface.stateAt(time), expected.surface, 1e-15, 1e-12)
	expectState(aristarchus.stateAt(time), expected.barycentric, 1e-12, 1e-12)
	const fromEarth = [
		[aristarchus.stateAt(time)[0][0] - de421.earth.stateAt(time)[0][0], aristarchus.stateAt(time)[0][1] - de421.earth.stateAt(time)[0][1], aristarchus.stateAt(time)[0][2] - de421.earth.stateAt(time)[0][2]],
		[aristarchus.stateAt(time)[1][0] - de421.earth.stateAt(time)[1][0], aristarchus.stateAt(time)[1][1] - de421.earth.stateAt(time)[1][1], aristarchus.stateAt(time)[1][2] - de421.earth.stateAt(time)[1][2]],
	] as PositionAndVelocity
	expectState(fromEarth, expected.fromEarth, 1e-12, 1e-12)
	const [rightAscension, declination, distance] = equatorialPosition({
		kind: 'geometric',
		time,
		center: naifEphemerisEndpoint(Naif.EARTH),
		target: customEphemerisEndpoint('aristarchus'),
		position: fromEarth[0],
		velocity: fromEarth[1],
	})
	expect(Math.abs(distance - expected.distance)).toBeLessThanOrEqual(1e-12)
	expectWrappedAngle(rightAscension, expected.ra, 1e-10)
	expect(Math.abs(declination - expected.dec)).toBeLessThanOrEqual(1e-10)
	const astrometric = observeEphemeris(aristarchus, de421.earth, time)!
	expectAngularSeparationBelow(astrometric.direction, unit(expected.observeEarth.position), DIRECTION)
	expect(Math.abs(astrometric.distance - expected.observeEarth.distance)).toBeLessThanOrEqual(1e-11)
	expect(Math.abs(astrometric.lightTime - expected.observeEarth.lightTime)).toBeLessThanOrEqual(LIGHT_TIME)
	const [observedRa, observedDec] = equatorialPosition(astrometric)
	expectWrappedAngle(observedRa, expected.observeEarth.ra, DIRECTION)
	expect(Math.abs(observedDec - expected.observeEarth.dec)).toBeLessThanOrEqual(DIRECTION)
	const apparent = apparentPosition(astrometric, { sun: de421.sun, deflectors: [sunDeflector(de421.sun), jupiterDeflector(de421.jupiter), saturnDeflector(de421.saturn)] })
	expectAngularSeparationBelow(apparent.direction, expected.apparentEarth, DIRECTION)
	const [apparentRa, apparentDec] = equatorialPosition(apparent)
	expectWrappedAngle(apparentRa, expected.apparentRa, DIRECTION)
	expect(Math.abs(apparentDec - expected.apparentDec)).toBeLessThanOrEqual(DIRECTION)
})
