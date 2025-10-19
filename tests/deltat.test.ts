import { expect, test } from 'bun:test'
import { s15 } from '../src/deltat'

test('s15', () => {
	const s = s15(2018)

	expect(s.lower).toBe(2016)
	expect(s.upper).toBe(2019)
	expect(s.compute(2020)).toBeCloseTo(69, 0)
})
