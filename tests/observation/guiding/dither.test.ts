import { describe, expect, test } from 'bun:test'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
import { DitherGenerator } from '../../../src/observation/guiding/dither'

function scriptedRandom(values: readonly number[]) {
	let index = 0
	const random: Random = () => values[index++ % values.length]
	return { random, count: () => index }
}

function step(generator: DitherGenerator, amount: number, raOnly = false) {
	const offset = generator.next(amount, raOnly)
	return [offset.rightAscension + 0, offset.declination + 0] as const
}

function collect(generator: DitherGenerator, count: number, amount: number, raOnly = false) {
	return Array.from({ length: count }, () => step(generator, amount, raOnly))
}

describe('random', () => {
	test('maps each draw into [-amount, +amount]', () => {
		const { random } = scriptedRandom([0, 0.5, 1, 0.25])
		const generator = new DitherGenerator({ random })

		expect(generator.next(4)).toEqual({ rightAscension: -4, declination: 0 })
		expect(generator.next(4)).toEqual({ rightAscension: 4, declination: -2 })
	})

	test('holds declination at zero for RA-only dithers', () => {
		const generator = new DitherGenerator({ random: mulberry32(7) })

		for (let i = 0; i < 32; i++) expect(generator.next(3, true).declination).toBe(0)
	})

	test('consumes one draw for RA-only and two otherwise', () => {
		const { random, count } = scriptedRandom([0.5])
		const generator = new DitherGenerator({ random })

		generator.next(1, true)
		expect(count()).toBe(1)

		generator.next(1, false)
		expect(count()).toBe(3)
	})

	test('stays within the requested amount', () => {
		const generator = new DitherGenerator({ random: mulberry32(99) })

		for (let i = 0; i < 512; i++) {
			const { rightAscension, declination } = generator.next(2.5)
			expect(Math.abs(rightAscension)).toBeLessThanOrEqual(2.5)
			expect(Math.abs(declination)).toBeLessThanOrEqual(2.5)
		}
	})

	test('repeats the sequence for a repeated seed', () => {
		const first = collect(new DitherGenerator({ random: mulberry32(2024) }), 8, 5)
		const second = collect(new DitherGenerator({ random: mulberry32(2024) }), 8, 5)

		expect(first).toEqual(second)
	})

	test('is unaffected by reset', () => {
		const { random } = scriptedRandom([0, 0.5])
		const generator = new DitherGenerator({ random })

		const before = generator.next(1)
		generator.reset()

		expect(generator.next(1)).toEqual(before)
	})
})

describe('spiral', () => {
	test('walks the PHD2 lattice', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		expect(collect(generator, 12, 1)).toEqual([
			[0, 1],
			[1, 0],
			[0, -1],
			[0, -1],
			[-1, 0],
			[-1, 0],
			[0, 1],
			[0, 1],
			[0, 1],
			[1, 0],
			[1, 0],
			[1, 0],
		])
	})

	test('walks the PHD2 RA-only sequence, whose steps can exceed the amount', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		expect(collect(generator, 8, 2, true)).toEqual([
			[2, 0],
			[-4, 0],
			[-2, 0],
			[8, 0],
			[2, 0],
			[-12, 0],
			[-2, 0],
			[16, 0],
		])
	})

	test('restarts when toggling the RA-only axis mode', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		expect(collect(generator, 3, 1)).toEqual([
			[0, 1],
			[1, 0],
			[0, -1],
		])
		expect(collect(generator, 3, 1, true)).toEqual([
			[1, 0],
			[-2, 0],
			[-1, 0],
		])
		expect(collect(generator, 3, 1)).toEqual([
			[0, 1],
			[1, 0],
			[0, -1],
		])
	})

	test('restarts on reset', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })
		const first = collect(generator, 4, 1)

		generator.reset()

		expect(collect(generator, 4, 1)).toEqual(first)
	})

	test('scales every step by the amount', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		expect(collect(generator, 3, 0.5)).toEqual([
			[0, 0.5],
			[0.5, 0],
			[0, -0.5],
		])
	})
})

describe('mode', () => {
	test('defaults to random and honors the constructor option', () => {
		expect(new DitherGenerator().mode).toBe('random')
		expect(new DitherGenerator({ mode: 'spiral' }).mode).toBe('spiral')
	})

	test('restarts the spiral even when the mode is unchanged', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		expect(step(generator, 1)).toEqual([0, 1])
		expect(step(generator, 1)).toEqual([1, 0])

		generator.setMode('spiral')

		expect(step(generator, 1)).toEqual([0, 1])
	})

	test('restarts the spiral when switching away and back', () => {
		const generator = new DitherGenerator({ mode: 'spiral' })

		collect(generator, 3, 1)
		generator.setMode('random')
		expect(generator.mode).toBe('random')

		generator.setMode('spiral')

		expect(step(generator, 1)).toEqual([0, 1])
	})
})
