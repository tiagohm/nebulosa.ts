import { expect, test } from 'bun:test'
import { PIOVERTWO } from '../../../src/core/constants'
import { starMomentShape, starShapeStatistics } from '../../../src/imaging/stars/shape'

test('moment shape recovers a round star and an elongated axis', () => {
	const round = starMomentShape(2, 0, 2)
	expect(round.eccentricity).toBeCloseTo(0, 12)
	expect(round.elongation).toBeCloseTo(1, 12)
	const elongated = starMomentShape(4, 0, 1)
	expect(elongated.eccentricity).toBeGreaterThan(0.5)
	expect(elongated.theta).toBeCloseTo(0, 12)
})

test('aligned elongated stars are separated from a round field and from mixed axes', () => {
	const aligned = starShapeStatistics(Array.from({ length: 8 }, () => ({ eccentricity: 0.5, elongation: 1.2, theta: 0 })))
	expect(aligned.assessment).toBe('aligned')
	expect(aligned.orientation).toBeCloseTo(0, 12)
	expect(aligned.coherence).toBeCloseTo(1, 12)
	expect(aligned.medianEccentricity).toBeCloseTo(0.5, 12)

	const vertical = starShapeStatistics(Array.from({ length: 8 }, () => ({ eccentricity: 0.5, elongation: 1.2, theta: PIOVERTWO })))
	expect(vertical.orientation).toBeCloseTo(PIOVERTWO, 12)

	const mixed = starShapeStatistics([...Array.from({ length: 4 }, () => ({ eccentricity: 0.5, elongation: 1.2, theta: 0 })), ...Array.from({ length: 4 }, () => ({ eccentricity: 0.5, elongation: 1.2, theta: PIOVERTWO }))])
	expect(mixed.assessment).toBe('mixed')
	expect(mixed.coherence ?? 1).toBeLessThan(0.1)

	expect(starShapeStatistics(Array.from({ length: 6 }, () => ({ eccentricity: 0.05, elongation: 1, theta: 0.4 }))).assessment).toBe('round')
	expect(starShapeStatistics([{ eccentricity: 0.8, theta: 0.2 }]).assessment).toBe('insufficient')
	expect(starShapeStatistics([]).assessment).toBe('insufficient')
})
