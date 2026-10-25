import { describe, expect, test } from 'bun:test'
import { BacklashCompensator } from '../../../src/observation/focus/backlash'

describe('backlash compensation', () => {
	test('absolute in', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 0 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(100, 1000)).toEqual([0])
	})

	test('absolute out', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 0, backlashOut: 100 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
		expect(compensator.compute(1000, 0)).toEqual([1100])
		expect(compensator.compute(0, 1100)).toEqual([100])
	})

	test('absolute returns a compensated target beyond the travel without clamping it', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 0 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(50, 1000)).toEqual([-50])
		expect(compensator.state).toEqual({ offset: -100, lastDirection: 'IN' })
		expect(compensator.compute(1000, -50)).toEqual([900])
	})

	test('absolute state can be restored after a plan that was not executed', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 100 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		const state = compensator.state
		expect(compensator.compute(900, 1000)).toEqual([800])
		compensator.reset(state)
		expect(compensator.state).toEqual({ offset: 0, lastDirection: 'OUT' })
		expect(compensator.compute(1200, 1000)).toEqual([1200])
	})

	test('reset forgets the offset and the direction', () => {
		const compensator = new BacklashCompensator({ mode: 'ABSOLUTE', backlashIn: 100, backlashOut: 100 })

		compensator.compute(1000, 0)
		compensator.compute(900, 1000)
		compensator.reset()

		expect(compensator.state).toEqual({ offset: 0, lastDirection: 'NONE' })
		expect(compensator.compute(1000, 800)).toEqual([1000])
	})

	test('overshoot in', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 0 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(100, 1000)).toEqual([0, 100])
		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(0, 1000)).toEqual([-100, 0])
	})

	test('overshoot out', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 0, backlashOut: 100 })

		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(0, 1000)).toEqual([0])
	})

	test('overshoot returns an inward overshoot below zero without clamping it', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 0 })

		expect(compensator.compute(1000, 0)).toEqual([1000])
		expect(compensator.compute(50, 1000)).toEqual([-50, 50])
	})

	test('overshoot returns an outward overshoot beyond the travel without clamping it', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 0, backlashOut: 200 })

		expect(compensator.compute(9950, 9000)).toEqual([10150, 9950])
	})

	test('overshoot on one side ends every move in the same direction', () => {
		for (const [compensation, final] of [
			[{ mode: 'OVERSHOOT', backlashIn: 210, backlashOut: 0 }, 1],
			[{ mode: 'OVERSHOOT', backlashIn: 0, backlashOut: 210 }, -1],
		] as const) {
			const compensator = new BacklashCompensator(compensation)
			let position = 5000

			for (const target of [5400, 5100, 5150, 4900, 4950, 5300, 5000]) {
				const plan = compensator.compute(target, position)
				const previous = plan.length === 1 ? position : plan[0]
				expect(plan.at(-1)).toBe(target)
				expect(Math.sign(target - previous)).toBe(final)
				position = target
			}
		}
	})

	test('overshoot on both sides ends each move opposite to its direction', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 100 })

		expect(compensator.compute(1000, 500)).toEqual([1100, 1000])
		expect(compensator.compute(800, 1000)).toEqual([700, 800])
	})

	test('overshoot no-op', () => {
		const compensator = new BacklashCompensator({ mode: 'OVERSHOOT', backlashIn: 100, backlashOut: 100 })

		expect(compensator.compute(1000, 0)).toEqual([1100, 1000])
		expect(compensator.compute(1000, 1000)).toEqual([1000])
	})
})
