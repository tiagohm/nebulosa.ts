import { expect, test } from 'bun:test'
import { meteorComparableOrbitFromKepler, meteorDDrummond, meteorDJopek, meteorDSouthworthHawkins, meteorHeliocentricState, meteorMoid, meteorOrbitFromRadiant, meteorStreamOrbitNodeEncounters } from '../../../src/astronomy/meteors/orbit'
import type { MeteorComparableOrbit, MeteorCompleteStreamOrbit } from '../../../src/astronomy/meteors/types'
import { asteroid, comet } from '../../../src/astronomy/orbits/asteroid'
import { deg, toDeg } from '../../../src/math/units/angle'
import { kilometerPerSecond } from '../../../src/math/units/velocity'
import { HORIZONS_EARTH_STATE, REFERENCE_TDB, TOLERANCE } from './util'

const RADIANT = { rightAscension: deg(100), declination: deg(-20) } as const
const FIRST_ORBIT = { perihelionDistance: 0.8, eccentricity: 0.5, inclination: deg(30), longitudeOfAscendingNode: deg(20), argumentOfPerihelion: deg(40) } satisfies MeteorComparableOrbit
const SECOND_ORBIT = { perihelionDistance: 0.91, eccentricity: 0.62, inclination: deg(47), longitudeOfAscendingNode: deg(73), argumentOfPerihelion: deg(123) } satisfies MeteorComparableOrbit
const STREAM = { perihelionDistance: 0.95, eccentricity: 0.6, inclination: deg(30), longitudeOfAscendingNode: deg(100), argumentOfPerihelion: deg(40) } satisfies MeteorCompleteStreamOrbit

test('heliocentric reconstruction agrees with frozen Horizons Earth DE441 geometry', () => {
	const state = meteorHeliocentricState(RADIANT, kilometerPerSecond(30), REFERENCE_TDB)
	const expectedPosition = HORIZONS_EARTH_STATE.position
	const expectedVelocity = [-0.014233085564376764, -0.016214437057944845, 0.011815936999904221]

	for (let i = 0; i < 3; i++) {
		expect(Math.abs(state.position[i] - expectedPosition[i])).toBeLessThan(TOLERANCE.externalState)
		expect(Math.abs(state.earthPosition[i] - expectedPosition[i])).toBeLessThan(TOLERANCE.externalState)
		expect(state.velocity[i]).toBeCloseTo(expectedVelocity[i], 12)
	}
	const orbit = meteorOrbitFromRadiant(RADIANT, kilometerPerSecond(30), REFERENCE_TDB)
	expect(orbit.semiMajorAxis).toBeCloseTo(-91.4682940394299, 10)
	expect(orbit.eccentricity).toBeCloseTo(1.0079100733482544, 10)
	expect(toDeg(orbit.inclination)).toBeCloseTo(34.07957372313302, 10)
	expect(meteorComparableOrbitFromKepler(orbit)).toEqual({
		perihelionDistance: orbit.periapsisDistance,
		eccentricity: orbit.eccentricity,
		inclination: orbit.inclination,
		longitudeOfAscendingNode: orbit.longitudeOfAscendingNode,
		argumentOfPerihelion: orbit.argumentOfPeriapsis,
	})
})

test('stream node encounters return both geometric nodes with independent candidates', () => {
	const encounters = meteorStreamOrbitNodeEncounters(STREAM, REFERENCE_TDB)
	expect(encounters).toHaveLength(2)
	expect(encounters.map((value) => value.node)).toEqual(['ascending', 'descending'])
	expect(encounters[0].geocentricSpeed).toBeCloseTo(0.011150240117687293, 12)
	expect(encounters[0].earthNodeDistance).toBeCloseTo(0.07588569391691781, 12)
	expect(toDeg(encounters[0].radiant.rightAscension)).toBeCloseTo(94.37211301795976, 10)
	expect(toDeg(encounters[0].radiant.declination)).toBeCloseTo(-42.62689539787008, 10)
	expect(encounters[1].geocentricSpeed).toBeCloseTo(0.02471637749202035, 12)
	expect(encounters[1].earthNodeDistance).toBeCloseTo(3.795329745722165, 12)
	expect(meteorStreamOrbitNodeEncounters({ ...STREAM, perihelionDistance: 0 }, REFERENCE_TDB)).toEqual([])
	expect(meteorStreamOrbitNodeEncounters({ ...STREAM, eccentricity: -1 }, REFERENCE_TDB)).toEqual([])
})

test('Southworth-Hawkins, Drummond and Jopek match the independent MNRAS formula table', () => {
	// Values are frozen from the Southworth-Hawkins/Drummond/Jopek definitions in MNRAS 455 (2016), Appendix formulas.
	expect(meteorDSouthworthHawkins(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(1.1477385127242428, 12)
	expect(meteorDDrummond(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(0.43336957172192836, 12)
	expect(meteorDJopek(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(1.144264706685383, 12)
	expect(meteorDSouthworthHawkins(FIRST_ORBIT, FIRST_ORBIT)).toBe(0)
	expect(meteorDDrummond(FIRST_ORBIT, FIRST_ORBIT)).toBe(0)
	expect(meteorDJopek(FIRST_ORBIT, FIRST_ORBIT)).toBe(0)
	expect(meteorDSouthworthHawkins(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(meteorDSouthworthHawkins(SECOND_ORBIT, FIRST_ORBIT)!, 14)
	expect(meteorDDrummond(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(meteorDDrummond(SECOND_ORBIT, FIRST_ORBIT)!, 14)
	expect(meteorDJopek(FIRST_ORBIT, SECOND_ORBIT)).toBeCloseTo(meteorDJopek(SECOND_ORBIT, FIRST_ORBIT)!, 14)
})

test('D criteria are periodic in angular elements and undefined at singular orbits', () => {
	const periodic = { ...SECOND_ORBIT, longitudeOfAscendingNode: SECOND_ORBIT.longitudeOfAscendingNode + 2 * Math.PI, argumentOfPerihelion: SECOND_ORBIT.argumentOfPerihelion - 2 * Math.PI } satisfies MeteorComparableOrbit
	expect(meteorDSouthworthHawkins(FIRST_ORBIT, periodic)).toBeCloseTo(meteorDSouthworthHawkins(FIRST_ORBIT, SECOND_ORBIT)!, 14)
	expect(meteorDDrummond(FIRST_ORBIT, periodic)).toBeCloseTo(meteorDDrummond(FIRST_ORBIT, SECOND_ORBIT)!, 14)
	expect(meteorDJopek(FIRST_ORBIT, periodic)).toBeCloseTo(meteorDJopek(FIRST_ORBIT, SECOND_ORBIT)!, 14)

	const zeroInclination = { ...FIRST_ORBIT, inclination: 0 } satisfies MeteorComparableOrbit
	const zeroEccentricity = { ...FIRST_ORBIT, eccentricity: 0 } satisfies MeteorComparableOrbit
	const zeroPerihelion = { ...FIRST_ORBIT, perihelionDistance: 0 } satisfies MeteorComparableOrbit
	for (const orbit of [zeroInclination, zeroEccentricity, zeroPerihelion]) {
		expect(meteorDSouthworthHawkins(orbit, FIRST_ORBIT)).toBeUndefined()
		expect(meteorDDrummond(orbit, FIRST_ORBIT)).toBeUndefined()
		expect(meteorDJopek(orbit, FIRST_ORBIT)).toBeUndefined()
	}

	const circularEquatorial = asteroid(1, 0, 0, 0, 0, 0, REFERENCE_TDB)
	expect(meteorComparableOrbitFromKepler(circularEquatorial)).toBeUndefined()
})

test('MOID finds the same-orbit zero and a bounded two-orbit minimum', () => {
	const first = asteroid(1, 0.1, deg(10), deg(20), deg(30), deg(40), REFERENCE_TDB)
	const second = asteroid(1.1, 0.2, deg(15), deg(25), deg(35), deg(50), REFERENCE_TDB)
	const same = meteorMoid(first, first, { samples: 24, tolerance: 1e-8 })
	const different = meteorMoid(first, second, { samples: 24, tolerance: 1e-8 })

	expect(same.distance).toBe(0)
	expect(different.distance).toBeCloseTo(0.007624231634577674, 12)
	expect(different.trueAnomaly1).toBeCloseTo(5.968767236826132, 10)
	expect(different.trueAnomaly2).toBeCloseTo(5.795823434000698, 10)

	const hyperbolic = comet(1, 1.1, deg(10), deg(20), deg(30), REFERENCE_TDB)
	expect(() => meteorMoid(hyperbolic, first, { samples: 24 })).toThrow('bound')
})
