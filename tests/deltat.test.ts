import { expect, test } from 'bun:test'
import { deltaT, deltaTByEspenakMeeus2006, parabolaOfStephensonMorrisonHohenkerk2016, s15 } from '../src/deltat'

test('s15', () => {
	const s = s15(2018)

	expect(s.lower).toBe(2016)
	expect(s.upper).toBe(2019)
	expect(s.compute(2020)).toBeCloseTo(69, 0)
})

test('s15 segment selection', () => {
	// A year on a segment lower bound selects that segment (t = 0), not the previous one.
	expect(s15(400).lower).toBe(400)
	// A year just below a bound stays in the previous segment.
	expect(s15(399).lower).toBe(-100)
	expect(s15(399).upper).toBe(400)
	// The upper endpoint of the whole table maps to the last segment at t = 1.
	expect(s15(2019).lower).toBe(2016)
	expect(s15(2019).upper).toBe(2019)
	// Out-of-range years clamp to the first/last segment (extrapolation).
	expect(s15(-5000).lower).toBe(-720)
	expect(s15(9999).lower).toBe(2016)
	// Years in the same segment return the shared precomputed spline instance (no per-call allocation).
	expect(s15(2017)).toBe(s15(2018))
})

test('deltaT picks the most reliable model per regime', () => {
	// Within the S15 range it matches the spline (the authoritative fit).
	expect(deltaT(2000)).toBeCloseTo(s15(2000).compute(2000), 9)
	expect(deltaT(-720)).toBeCloseTo(s15(-720).compute(-720), 9)
	expect(deltaT(1000)).toBeCloseTo(s15(1000).compute(1000), 9)

	// Before the spline it uses the long-term parabola, continuous with the spline lower edge.
	expect(deltaT(-1000)).toBeCloseTo(parabolaOfStephensonMorrisonHohenkerk2016.compute(-1000), 9)

	// After the spline it uses Espenak-Meeus forward expressions.
	expect(deltaT(2025)).toBeCloseTo(deltaTByEspenakMeeus2006(2025), 9)
	expect(deltaT(3000)).toBeCloseTo(deltaTByEspenakMeeus2006(3000), 9)

	// Reliable against observed ΔT in the modern era, and closer than Espenak-Meeus (which drifts high).
	const observed2016 = 68.6
	expect(deltaT(2016)).toBeCloseTo(observed2016, 0)
	expect(Math.abs(deltaT(2016) - observed2016)).toBeLessThan(Math.abs(deltaTByEspenakMeeus2006(2016) - observed2016))

	// Finite and well-ordered at the seams.
	expect(Number.isFinite(deltaT(-1e6))).toBe(true)
	expect(Number.isFinite(deltaT(1e6))).toBe(true)
})

test('espenak-meeus 2006', () => {
	// Polynomial origins evaluate to their leading constant term.
	expect(deltaTByEspenakMeeus2006(0)).toBeCloseTo(10583.6, 1)
	expect(deltaTByEspenakMeeus2006(1600)).toBeCloseTo(120, 6)
	expect(deltaTByEspenakMeeus2006(1700)).toBeCloseTo(8.83, 6)
	expect(deltaTByEspenakMeeus2006(1800)).toBeCloseTo(13.72, 6)
	expect(deltaTByEspenakMeeus2006(1900)).toBeCloseTo(-2.79, 6)
	expect(deltaTByEspenakMeeus2006(1950)).toBeCloseTo(29.07, 6)
	expect(deltaTByEspenakMeeus2006(2000)).toBeCloseTo(63.86, 6)

	// Reference values from the Espenak and Meeus tabulation.
	expect(deltaTByEspenakMeeus2006(1850)).toBeCloseTo(7.11, 1)
	expect(deltaTByEspenakMeeus2006(2024)).toBeCloseTo(73.87, 1)

	// Long-term parabola outside the fitted span stays finite and continuous.
	expect(deltaTByEspenakMeeus2006(2150)).toBeCloseTo(-20 + 32 * 3.3 * 3.3, 6)
	expect(deltaTByEspenakMeeus2006(-700)).toBeCloseTo(-20 + 32 * ((-700 - 1820) / 100) ** 2, 6)
})
