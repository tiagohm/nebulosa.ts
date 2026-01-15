import { describe, expect, test } from 'bun:test'
import { AutoFocus, type AutoFocusStep, BacklashCompensator } from '../src/autofocus'
import type { Point } from '../src/geometry'

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
})

// Generated using Camera Sky Simulator and NINA
const GOOD_FOCUS_POINTS: Point[] = [
	{ x: 24000, y: 5.01 },
	{ x: 24100, y: 4.32 },
	{ x: 24200, y: 3.79 },
	{ x: 24300, y: 3.31 },
	{ x: 24400, y: 2.91 },
	{ x: 24500, y: 2.49 },
	{ x: 24600, y: 2.09 },
	{ x: 24700, y: 1.76 },
	{ x: 24800, y: 1.52 },
	{ x: 24900, y: 1.37 },
	{ x: 25000, y: 1.36 },
	{ x: 25100, y: 1.53 },
	{ x: 25200, y: 1.75 },
	{ x: 25300, y: 2.11 },
	{ x: 25400, y: 2.48 },
	{ x: 25500, y: 2.88 },
	{ x: 25600, y: 3.36 },
	{ x: 25700, y: 3.72 },
	{ x: 25800, y: 4.33 },
	{ x: 25900, y: 4.27 },
	{ x: 26000, y: 5.43 },
]

describe('auto focus', () => {
	const trendlinesAutoFocus = new AutoFocus({ fittingMode: 'TRENDLINES', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
	const trendParabolicAutoFocus = new AutoFocus({ fittingMode: 'TREND_PARABOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
	const trendHyperbolicAutoFocus = new AutoFocus({ fittingMode: 'TREND_HYPERBOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
	const hyperbolicAutoFocus = new AutoFocus({ fittingMode: 'HYPERBOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
	const parabolicAutoFocus = new AutoFocus({ fittingMode: 'PARABOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })

	let position = 25000

	function move(step: AutoFocusStep) {
		if (step.relative) position += step.relative
		else if (step.absolute) position = step.absolute
	}

	test('trend-parabolic', () => {
		position = 25000

		let step = trendParabolicAutoFocus.add(position, 2)

		for (let i = 0; i < 100 && step.type === 'MOVE'; i++) {
			move(step)

			const point = GOOD_FOCUS_POINTS.find((e) => e.x === position)!
			step = trendParabolicAutoFocus.add(point.x, point.y)

			if (i >= 2) {
				expect(step.parabolic).toBeDefined()
			}
		}

		expect(step.type).toBe('COMPLETED')
		expect(step.finalFocusPoint!.x).toBeCloseTo(25000, -2)
	})

	test('trend-hyperbolic', () => {
		position = 25000

		let step = trendHyperbolicAutoFocus.add(position, 2)

		for (let i = 0; i < 100 && step.type === 'MOVE'; i++) {
			move(step)

			const point = GOOD_FOCUS_POINTS.find((e) => e.x === position)!
			step = trendHyperbolicAutoFocus.add(point.x, point.y)

			if (i >= 2) {
				expect(step.hyperbolic).toBeDefined()
			}
		}

		expect(step.type).toBe('COMPLETED')
		expect(step.finalFocusPoint!.x).toBeCloseTo(25000, -2)
	})

	test('trendlines', () => {
		position = 25000

		let step = trendlinesAutoFocus.add(position, 2)

		for (let i = 0; i < 100 && step.type === 'MOVE'; i++) {
			move(step)

			const point = GOOD_FOCUS_POINTS.find((e) => e.x === position)!
			step = trendlinesAutoFocus.add(point.x, point.y)
		}

		expect(step.type).toBe('COMPLETED')
		expect(step.finalFocusPoint!.x).toBeCloseTo(25000, -2)
	})

	test('parabolic', () => {
		position = 25000

		let step = parabolicAutoFocus.add(position, 2)

		for (let i = 0; i < 100 && step.type === 'MOVE'; i++) {
			move(step)

			const point = GOOD_FOCUS_POINTS.find((e) => e.x === position)!
			step = parabolicAutoFocus.add(point.x, point.y)

			if (i >= 2) {
				expect(step.parabolic).toBeDefined()
			}
		}

		expect(step.type).toBe('COMPLETED')
		expect(step.finalFocusPoint!.x).toBeCloseTo(25000, -2)
	})

	test('hyperbolic', () => {
		position = 25000

		let step = hyperbolicAutoFocus.add(position, 2)

		for (let i = 0; i < 100 && step.type === 'MOVE'; i++) {
			move(step)

			const point = GOOD_FOCUS_POINTS.find((e) => e.x === position)!
			step = hyperbolicAutoFocus.add(point.x, point.y)

			if (i >= 2) {
				expect(step.hyperbolic).toBeDefined()
			}
		}

		expect(step.type).toBe('COMPLETED')
		expect(step.finalFocusPoint!.x).toBeCloseTo(24950, -2)
	})
})
