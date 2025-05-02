import { expect, test } from 'bun:test'
import { toDeg } from '../src/angle'
import { mpcorb, mpcorbComet, packDate, unpackDate } from '../src/mpcorb'

const CERES = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'
const HALLEY = '0001P         2061 08 31.8266  0.583972  0.967311  112.5470   59.6368  162.2146  20250501   4.0  6.0  1P/Halley                                                 98, 1083'

test('asteroid', () => {
	const ceres = mpcorb(CERES)

	expect(ceres).not.toBeUndefined()

	expect(ceres!.designationPacked).toBe('00001')
	expect(ceres!.magnitudeH).toBe(3.34)
	expect(ceres!.magnitudeG).toBe(0.15)
	expect(ceres!.epochPacked).toBe('K2555')
	expect(toDeg(ceres!.meanAnomaly)).toBe(188.70269)
	expect(toDeg(ceres!.argumentOfPerihelion)).toBe(73.27343)
	expect(toDeg(ceres!.longitudeOfAscendingNode)).toBe(80.25221)
	expect(toDeg(ceres!.inclination)).toBe(10.5878)
	expect(ceres!.eccentricity).toBe(0.0794013)
	expect(ceres!.meanDailyMotion).toBe(0.21424651)
	expect(ceres!.semiMajorAxis).toBe(2.7660512)
	expect(ceres!.uncertainty).toBe('0')
	expect(ceres!.reference).toBe('E2024-V47')
	expect(ceres!.observations).toBe(7330)
	expect(ceres!.oppositions).toBe(125)
	expect(ceres!.observationPeriod).toBe('1801-2024')
	expect(ceres!.rmsResidual).toBe(0.8)
	expect(ceres!.coarsePerturbers).toBe('M-v')
	expect(ceres!.precisePerturbers).toBe('30k')
	expect(ceres!.computerName).toBe('MPCLINUX')
	expect(ceres!.hexFlags).toBe('4000')
	expect(ceres!.designation).toBe('(1) Ceres')
	expect(ceres!.lastObservationDate).toBe('20241101')
})

test('comet', () => {
	const halley = mpcorbComet(HALLEY)

	expect(halley).not.toBeUndefined()

	expect(halley!.designationPacked).toBe('')
	expect(halley!.magnitudeK).toBe(6)
	expect(halley!.magnitudeG).toBe(4)
	expect(halley!.perihelionDistance).toBe(0.583972)
	expect(toDeg(halley!.argumentOfPerihelion)).toBeCloseTo(112.547, 3)
	expect(toDeg(halley!.longitudeOfAscendingNode)).toBe(59.6368)
	expect(toDeg(halley!.inclination)).toBe(162.2146)
	expect(halley!.eccentricity).toBe(0.967311)
	expect(halley!.designation).toBe('1P/Halley')
	expect(halley!.orbitType).toBe('P')
	expect(halley!.perihelionYear).toBe(2061)
	expect(halley!.perihelionMonth).toBe(8)
	expect(halley!.perihelionDay).toBe(31)
	expect(halley!.perihelionDayFraction).toBe(0.8266)
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
