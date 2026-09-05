import { describe, expect, test } from 'bun:test'
import { BacklashCompensator } from '../../../src/observation/focus/backlash'

describe('backlash compensation', () => {
	test('absolute in', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 0 }, 10000)

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(100, 1000)).toEqual([0])
	})

	test('absolute out', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 0, backlashOut: 100 }, 10000)

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
		expect(compensator.compute(1000, 0)).toEqual([1100])
		expect(compensator.compute(0, 1100)).toEqual([100])
	})

	test('absolute clamps compensated target to maximum position', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 100 }, 1050)

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(900, 1000)).toEqual([800])
		expect(compensator.compute(1050, 800)).toEqual([1050])
	})

	test('overshoot in', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 0 }, 10000)

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(100, 1000)).toEqual([0, 100])
		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
	})

	test('overshoot out', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 0, backlashOut: 100 }, 10000)

		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
	})

	test('overshoot no-op', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 100 }, 10000)

		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(1000, 1000)).toEqual([1000])
	})
})
