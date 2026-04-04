import { expect, test } from 'bun:test'
import { toDeg } from '../src/angle'
import { mpcorb, mpcorbComet, packDate, unpackDate } from '../src/mpcorb'

const CERES = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'
const HALLEY = '0001P         2061 08 31.8266  0.583972  0.967311  112.5470   59.6368  162.2146  20250501   4.0  6.0  1P/Halley                                                 98, 1083'

test('asteroid', () => {
	const ceres = mpcorb(CERES)

	expect(ceres).toBeDefined()

	expect(ceres!.designationPacked).toBe('00001')
	expect(ceres!.magnitudeH).toBeCloseTo(3.34, 14)
	expect(ceres!.magnitudeG).toBeCloseTo(0.15, 14)
	expect(ceres!.epochPacked).toBe('K2555')
	expect(toDeg(ceres!.meanAnomaly)).toBeCloseTo(188.70269, 12)
	expect(toDeg(ceres!.argumentOfPerihelion)).toBeCloseTo(73.27343, 12)
	expect(toDeg(ceres!.longitudeOfAscendingNode)).toBeCloseTo(80.25221, 12)
	expect(toDeg(ceres!.inclination)).toBeCloseTo(10.5878, 12)
	expect(ceres!.eccentricity).toBeCloseTo(0.0794013, 14)
	expect(ceres!.meanDailyMotion).toBeCloseTo(0.21424651, 14)
	expect(ceres!.semiMajorAxis).toBeCloseTo(2.7660512, 14)
	expect(ceres!.uncertainty).toBe('0')
	expect(ceres!.reference).toBe('E2024-V47')
	expect(ceres!.observations).toBe(7330)
	expect(ceres!.oppositions).toBe(125)
	expect(ceres!.observationPeriod).toBe('1801-2024')
	expect(ceres!.rmsResidual).toBeCloseTo(0.8, 14)
	expect(ceres!.coarsePerturbers).toBe('M-v')
	expect(ceres!.precisePerturbers).toBe('30k')
	expect(ceres!.computerName).toBe('MPCLINUX')
	expect(ceres!.hexFlags).toBe('4000')
	expect(ceres!.designation).toBe('(1) Ceres')
	expect(ceres!.lastObservationDate).toBe('20241101')
})

test('comet', () => {
	const halley = mpcorbComet(HALLEY)

	expect(halley).toBeDefined()

	expect(halley!.number).toBe(1)
	expect(halley!.designationPacked).toBe('')
	expect(halley!.magnitudeK).toBeCloseTo(6, 14)
	expect(halley!.magnitudeG).toBeCloseTo(4, 14)
	expect(halley!.perihelionDistance).toBeCloseTo(0.583972, 14)
	expect(toDeg(halley!.argumentOfPerihelion)).toBeCloseTo(112.547, 3)
	expect(toDeg(halley!.longitudeOfAscendingNode)).toBeCloseTo(59.6368, 12)
	expect(toDeg(halley!.inclination)).toBeCloseTo(162.2146, 12)
	expect(halley!.eccentricity).toBeCloseTo(0.967311, 14)
	expect(halley!.designation).toBe('1P/Halley')
	expect(halley!.orbitType).toBe('P')
	expect(halley!.perihelionYear).toBe(2061)
	expect(halley!.perihelionMonth).toBe(8)
	expect(halley!.perihelionDay).toBe(31)
	expect(halley!.perihelionDayFraction).toBeCloseTo(0.8266, 14)
})

test('unpack date', () => {
	expect(unpackDate('J9611')).toEqual([1996, 1, 1])
	expect(unpackDate('J961A')).toEqual([1996, 1, 10])
	expect(unpackDate('J969U')).toEqual([1996, 9, 30])
	expect(unpackDate('J96A1')).toEqual([1996, 10, 1])
	expect(unpackDate('K01AM')).toEqual([2001, 10, 22])
})

test('pack date', () => {
	expect(packDate(1998, 1, 18)).toBe('J981I')
	expect(packDate(2001, 10, 22)).toBe('K01AM')
	expect(packDate(1996, 1, 1)).toBe('J9611')
	expect(packDate(1996, 1, 10)).toBe('J961A')
	expect(packDate(1996, 9, 30)).toBe('J969U')
	expect(packDate(1996, 10, 1)).toBe('J96A1')
})

test('invalid packed date', () => {
	expect(() => unpackDate('K255')).toThrow(RangeError)
	expect(() => unpackDate('K25W1')).toThrow(RangeError)
	expect(() => unpackDate('K25A0')).toThrow(RangeError)
	expect(() => packDate(3200, 1, 1)).toThrow(RangeError)
	expect(() => packDate(2025, 13, 1)).toThrow(RangeError)
	expect(() => packDate(2025, 1, 0)).toThrow(RangeError)
})

test('invalid comet orbit type', () => {
	expect(() => mpcorbComet(`${HALLEY.slice(0, 4)}X${HALLEY.slice(5)}`)).toThrow(RangeError)
})
