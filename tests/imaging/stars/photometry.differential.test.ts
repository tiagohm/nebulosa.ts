import { describe, expect, test } from 'bun:test'
import { type Time, Timescale, time } from '../../../src/astronomy/time/time'
import { type DifferentialPhotometryFrame, type DifferentialPhotometryStar, differentialLightCurve, type PhotometryStarId } from '../../../src/imaging/stars/photometry.differential'
import { mulberry32, normal } from '../../../src/math/numerical/random'

interface SyntheticStar {
	readonly id: PhotometryStarId
	// Flux above the atmosphere.
	readonly flux: number
	// Intrinsic relative brightness at frame j; 1 for a constant star.
	readonly signal?: (j: number) => number
	// Fixed fractional flux error replacing the noise model.
	readonly relativeError?: number
	// Centroid x at frame j, pixels.
	readonly x?: (j: number) => number
}

interface SyntheticSeries {
	readonly frameCount: number
	readonly stars: readonly SyntheticStar[]
	// Common transmission of frame j (clouds, extinction, exposure time).
	readonly transmission?: (j: number) => number
	// Seed of the photon and read noise; noiseless when omitted.
	readonly seed?: number
	// Read noise variance per measurement, flux units squared.
	readonly readVariance?: number
	readonly airmass?: (j: number) => number
	readonly fwhm?: number
}

const CLOUDS = (j: number) => 1 - 0.45 * Math.exp(-(((j - 30) / 6) ** 2)) - 0.25 * Math.exp(-(((j - 70) / 3) ** 2))

// Measurements with Poisson-like errors sqrt(flux + readVariance), drawn from a seeded generator.
function simulate({ frameCount, stars, transmission = () => 1, seed, readVariance = 400, airmass, fwhm }: SyntheticSeries): DifferentialPhotometryFrame[] {
	const noise = seed === undefined ? undefined : normal(mulberry32(seed))
	const frames: DifferentialPhotometryFrame[] = []

	for (let j = 0; j < frameCount; j++) {
		const measurements: DifferentialPhotometryStar[] = []

		for (const star of stars) {
			const mean = star.flux * (star.signal?.(j) ?? 1) * transmission(j)
			const fluxError = star.relativeError === undefined ? Math.sqrt(Math.max(mean, 0) + readVariance) : mean * star.relativeError
			measurements.push({ id: star.id, flux: mean + (noise === undefined ? 0 : noise() * fluxError), fluxError, x: star.x?.(j), y: star.x === undefined ? undefined : 100 })
		}

		frames.push({ time: time(2460600 + j / 1440, 0, Timescale.TDB), stars: measurements, airmass: airmass?.(j), fwhm })
	}

	return frames
}

function median(values: readonly number[]) {
	const sorted = values.toSorted((a, b) => a - b)
	const middle = sorted.length >> 1
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function standardDeviation(values: readonly number[]) {
	const mean = values.reduce((a, b) => a + b, 0) / values.length
	return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
}

const COMPARISONS: readonly SyntheticStar[] = [
	{ id: 'c1', flux: 80000 },
	{ id: 'c2', flux: 50000 },
	{ id: 'c3', flux: 120000 },
	{ id: 'c4', flux: 30000 },
	{ id: 'c5', flux: 65000 },
]

describe('error propagation', () => {
	test('single comparison by hand', () => {
		const frames: DifferentialPhotometryFrame[] = [
			{
				time: time(2460600, 0, Timescale.TT),
				stars: [
					{ id: 't', flux: 200, fluxError: 5 },
					{ id: 'c', flux: 1000, fluxError: 10 },
				],
			},
			{
				time: time(2460600, 0.01, Timescale.TT),
				stars: [
					{ id: 't', flux: 100, fluxError: 5 },
					{ id: 'c', flux: 500, fluxError: 10 },
				],
			},
			{
				time: time(2460600, 0.02, Timescale.TT),
				stars: [
					{ id: 't', flux: 200, fluxError: 5 },
					{ id: 'c', flux: 1000, fluxError: 10 },
				],
			},
		]

		const curve = differentialLightCurve(frames, 't')
		expect(curve.timescale).toBe(Timescale.TT)
		expect(curve.normalization).toBeCloseTo(200, 12)
		expect(curve.converged).toBeTrue()
		expect(curve.comparisons[0].referenceFlux).toBeCloseTo(1000, 10)

		const [a, b] = curve.points
		expect(a.time).toBe(frames[0].time)
		expect(b.transparency).toBeCloseTo(0.5, 12)
		// sigma(T) = 10 / 1000 in every frame.
		expect(b.transparencyError).toBeCloseTo(0.01, 12)
		expect(b.flux).toBeCloseTo(200, 10)
		// (5 / 0.5)^2 + (200 / 0.5)^2 * 0.01^2 = 116.
		expect(b.fluxError).toBeCloseTo(Math.sqrt(116), 10)
		// 5^2 + 200^2 * 0.01^2 = 29.
		expect(a.fluxError).toBeCloseTo(Math.sqrt(29), 10)
		expect(a.relativeFlux).toBeCloseTo(1, 12)
		expect(a.relativeFluxError).toBeCloseTo(Math.sqrt(29) / 200, 12)
		expect(a.magnitude).toBeCloseTo(0, 12)
		expect(a.magnitudeError).toBeCloseTo(((2.5 / Math.LN10) * Math.sqrt(29)) / 200, 12)
		expect(a.flags).toEqual([])
	})

	test('heteroscedastic comparisons are weighted by inverse variance', () => {
		// Noiseless fluxes with errors of 1%, 2% and 4%: fractional weights 16:4:1.
		const stars = [
			{ id: 't', flux: 10000 },
			{ ...COMPARISONS[0], relativeError: 0.01 },
			{ ...COMPARISONS[1], relativeError: 0.02 },
			{ ...COMPARISONS[2], relativeError: 0.04 },
		]
		const frames = simulate({ frameCount: 20, stars, transmission: CLOUDS })

		const curve = differentialLightCurve(frames, 't')
		const [c1, c2, c3] = curve.comparisons
		expect(c1.weight).toBeCloseTo(16 / 21, 10)
		expect(c2.weight).toBeCloseTo(4 / 21, 10)
		expect(c3.weight).toBeCloseTo(1 / 21, 10)
		// sigma(T) / T = 1 / sqrt(1/0.01^2 + 1/0.02^2 + 1/0.04^2).
		for (const point of curve.points) expect(point.transparencyError! / point.transparency!).toBeCloseTo(1 / Math.sqrt(10000 + 2500 + 625), 10)
	})

	test('heteroscedastic target errors are realistic', () => {
		// The cloud raises the relative errors of the target and comparisons by up to a factor of two.
		const frames = simulate({ frameCount: 400, stars: [{ id: 't', flux: 20000 }, ...COMPARISONS], transmission: (j) => CLOUDS(j % 100), seed: 7 })
		const curve = differentialLightCurve(frames, 't')
		const pulls = curve.points.map((point) => (point.relativeFlux! - 1) / point.relativeFluxError!)
		expect(standardDeviation(pulls)).toBeCloseTo(1, 1)
		expect(curve.rejectedComparisonIds).toEqual([])
	})
})

describe('light curves', () => {
	test('constant target', () => {
		const frames = simulate({ frameCount: 200, stars: [{ id: 't', flux: 40000 }, ...COMPARISONS], seed: 1 })
		const curve = differentialLightCurve(frames, 't')
		const relative = curve.points.map((point) => point.relativeFlux!)
		const expected = curve.points.map((point) => point.relativeFluxError!)
		expect(curve.converged).toBeTrue()
		expect(curve.rejectedComparisonIds).toEqual([])
		expect(curve.comparisons.every((c) => c.status === 'used' && c.variability! < 1.5)).toBeTrue()
		expect(relative.reduce((a, b) => a + b, 0) / relative.length).toBeCloseTo(1, 3)
		expect(standardDeviation(relative) / (expected.reduce((a, b) => a + b, 0) / expected.length)).toBeCloseTo(1, 1)
	})

	test('cloud common mode is removed exactly', () => {
		const frames = simulate({ frameCount: 100, stars: [{ id: 't', flux: 15000 }, ...COMPARISONS], transmission: CLOUDS })
		const curve = differentialLightCurve(frames, 't')
		// The transparency is the transmission relative to its median over the frames.
		const level = median(Array.from({ length: 100 }, (_, j) => CLOUDS(j)))

		for (let j = 0; j < 100; j++) {
			const point = curve.points[j]
			expect(point.transparency).toBeCloseTo(CLOUDS(j) / level, 12)
			expect(point.relativeFlux).toBeCloseTo(1, 12)
			expect(point.comparisonCount).toBe(5)
		}

		// Reference fluxes are the fluxes at the median transmission.
		for (const comparison of curve.comparisons) expect(comparison.referenceFlux).toBeCloseTo(COMPARISONS.find((c) => c.id === comparison.id)!.flux * level, 6)
	})

	test('cloud does not leak into a noisy constant target', () => {
		const frames = simulate({ frameCount: 100, stars: [{ id: 't', flux: 30000 }, ...COMPARISONS], transmission: CLOUDS, seed: 3 })
		const curve = differentialLightCurve(frames, 't')
		const inCloud = curve.points.slice(25, 36).map((point) => point.relativeFlux!)
		const clear = curve.points.slice(45, 60).map((point) => point.relativeFlux!)
		const error = curve.points[30].relativeFluxError!
		expect(Math.abs(inCloud.reduce((a, b) => a + b, 0) / inCloud.length - clear.reduce((a, b) => a + b, 0) / clear.length)).toBeLessThan(3 * error)
	})

	test('synthetic eclipse under clouds', () => {
		// 2% deep box eclipse over frames 40..59 while a cloud dims everything by up to 45%.
		const eclipse = (j: number) => (j >= 40 && j < 60 ? 0.98 : 1)
		const frames = simulate({ frameCount: 100, stars: [{ id: 't', flux: 60000, signal: eclipse }, ...COMPARISONS], transmission: (j) => CLOUDS(j - 15), seed: 11 })
		const curve = differentialLightCurve(frames, 't')
		const inside = curve.points.slice(40, 60).map((point) => point.relativeFlux!)
		const outside = [...curve.points.slice(0, 40), ...curve.points.slice(60)].map((point) => point.relativeFlux!)
		const depth = 1 - inside.reduce((a, b) => a + b, 0) / inside.length / (outside.reduce((a, b) => a + b, 0) / outside.length)
		const error = curve.points.reduce((a, point) => a + point.relativeFluxError!, 0) / 100
		// Three standard errors of the difference between the means of 20 and 80 points.
		expect(Math.abs(depth - 0.02)).toBeLessThan(3 * error * Math.sqrt(1 / 20 + 1 / 80))
		const magnitude = curve.points.slice(40, 60).reduce((a, point) => a + point.magnitude!, 0) / 20
		expect(Math.abs(magnitude - -2.5 * Math.log10(0.98))).toBeLessThan(3 * (2.5 / Math.LN10) * error * Math.sqrt(1 / 20 + 1 / 80))
		expect(curve.rejectedComparisonIds).toEqual([])
	})

	test('noiseless eclipse depth is exact', () => {
		const eclipse = (j: number) => (j >= 10 && j < 20 ? 0.9 : 1)
		const frames = simulate({ frameCount: 50, stars: [{ id: 't', flux: 60000, signal: eclipse }, ...COMPARISONS], transmission: CLOUDS })
		const curve = differentialLightCurve(frames, 't')
		// The normalization is the out-of-eclipse flux at the median transmission.
		expect(curve.normalization).toBeCloseTo(60000 * median(Array.from({ length: 50 }, (_, j) => CLOUDS(j))), 6)
		expect(curve.points[15].relativeFlux).toBeCloseTo(0.9, 12)
		expect(curve.points[15].magnitude).toBeCloseTo(-2.5 * Math.log10(0.9), 12)
		expect(curve.points[5].relativeFlux).toBeCloseTo(1, 12)
	})

	test('synthetic variable target', () => {
		const signal = (j: number) => 1 + 0.05 * Math.sin((2 * Math.PI * j) / 40)
		const frames = simulate({ frameCount: 160, stars: [{ id: 't', flux: 50000, signal }, ...COMPARISONS], transmission: (j) => 0.8 + 0.2 * Math.cos(j / 9), seed: 5 })
		const curve = differentialLightCurve(frames, 't')

		// Least-squares sine amplitude of the relative flux about the normalization.
		let sinSum = 0
		let cosSum = 0
		for (let j = 0; j < 160; j++) {
			sinSum += curve.points[j].relativeFlux! * Math.sin((2 * Math.PI * j) / 40)
			cosSum += curve.points[j].relativeFlux! * Math.cos((2 * Math.PI * j) / 40)
		}

		expect((2 * sinSum) / 160).toBeCloseTo(0.05, 2)
		expect((2 * cosSum) / 160).toBeCloseTo(0, 2)
		expect(curve.rejectedComparisonIds).toEqual([])
	})
})

describe('robust comparison selection', () => {
	test('one unstable comparison is rejected', () => {
		const stars = [{ id: 't', flux: 40000 }, ...COMPARISONS.map((c) => (c.id === 'c3' ? { ...c, signal: (j: number) => 1 + 0.04 * Math.sin(j / 7) } : c))]
		const frames = simulate({ frameCount: 150, stars, transmission: CLOUDS, seed: 13 })
		const curve = differentialLightCurve(frames, 't')
		expect(curve.rejectedComparisonIds).toEqual(['c3'])
		const c3 = curve.comparisons.find((c) => c.id === 'c3')!
		expect(c3.status).toBe('variable')
		expect(c3.weight).toBe(0)
		expect(c3.variability).toBeGreaterThan(3)
		// The excess scatter is the RMS of a sine of amplitude A, A / sqrt(2); its robust scatter is the
		// normalized MAD 1.4826 A sin(PI / 4), in quadrature with the noise.
		expect(c3.excessScatter).toBeCloseTo(0.04 * Math.SQRT1_2, 3)
		expect(c3.scatter).toBeCloseTo(1.482602218505602 * 0.04 * Math.SQRT1_2, 2)

		for (const comparison of curve.comparisons) if (comparison.id !== 'c3') expect(comparison.variability!).toBeLessThan(1.5)

		const relative = curve.points.map((point) => point.relativeFlux!)
		const expected = curve.points.reduce((a, point) => a + point.relativeFluxError!, 0) / 150
		expect(standardDeviation(relative)).toBeLessThan(1.3 * expected)
		expect(curve.points.every((point) => point.comparisonCount === 4)).toBeTrue()
	})

	test('a variable comparison is not rejected without a majority', () => {
		const stars = [
			{ id: 't', flux: 40000 },
			{ id: 'a', flux: 80000 },
			{ id: 'b', flux: 60000, signal: (j: number) => 1 + 0.05 * Math.sin(j / 5) },
		]
		const curve = differentialLightCurve(simulate({ frameCount: 60, stars, seed: 2 }), 't')
		expect(curve.rejectedComparisonIds).toEqual([])
		expect(curve.comparisons.every((c) => c.status === 'used')).toBeTrue()
	})

	test('an outlier is clipped from its frame only', () => {
		const frames = simulate({ frameCount: 40, stars: [{ id: 't', flux: 40000 }, ...COMPARISONS], transmission: CLOUDS })
		// A cosmic ray adds 30% to c2 in frame 12.
		const hit = frames[12].stars.map((star) => (star.id === 'c2' ? { ...star, flux: star.flux! * 1.3 } : star))
		frames[12] = { ...frames[12], stars: hit }
		const curve = differentialLightCurve(frames, 't')
		expect(curve.points[12].clippedComparisonIds).toEqual(['c2'])
		expect(curve.points[12].flags).toEqual(['comparisonClipped'])
		expect(curve.points[12].comparisonCount).toBe(4)
		expect(curve.points[12].relativeFlux).toBeCloseTo(1, 10)
		expect(curve.comparisons.find((c) => c.id === 'c2')!.clippedCount).toBe(1)
		expect(curve.comparisons.find((c) => c.id === 'c2')!.status).toBe('used')
		expect(curve.points[11].flags).toEqual([])
	})

	test('explicit comparison list excludes other stars and the target', () => {
		const stars = [{ id: 't', flux: 40000 }, ...COMPARISONS, { id: 'v', flux: 70000, signal: (j: number) => 1 + 0.3 * Math.sin(j) }]
		const curve = differentialLightCurve(simulate({ frameCount: 30, stars, transmission: CLOUDS }), 't', ['c1', 't', 'c2', 'c1', 'missing'])
		expect(curve.comparisons.map((c) => c.id)).toEqual(['c1', 'c2', 'missing'])
		expect(curve.comparisons[2].status).toBe('missing')
		expect(curve.comparisons[2].referenceFlux).toBeUndefined()
		for (const point of curve.points) expect(point.relativeFlux).toBeCloseTo(1, 12)
	})
})

describe('missing data', () => {
	test('dropped frames, missing target and missing comparisons', () => {
		const frames = simulate({ frameCount: 60, stars: [{ id: 't', flux: 25000 }, ...COMPARISONS], transmission: CLOUDS })
		// Frame 5 is dropped, the target is lost in frame 9 and c1 and c3 vanish during the first cloud.
		frames[5] = { ...frames[5], stars: [] }
		frames[9] = { ...frames[9], stars: frames[9].stars.filter((star) => star.id !== 't') }
		for (let j = 20; j < 40; j++) frames[j] = { ...frames[j], stars: frames[j].stars.filter((star) => star.id !== 'c1' && star.id !== 'c3') }

		const curve = differentialLightCurve(frames, 't')
		expect(curve.points).toHaveLength(60)
		expect(curve.points[5].flags).toEqual(['targetMissing', 'noComparisons'])
		expect(curve.points[5].time).toBe(frames[5].time)
		expect(curve.points[5].relativeFlux).toBeUndefined()
		expect(curve.points[5].comparisonCount).toBe(0)
		expect(curve.points[9].flags).toEqual(['targetMissing'])
		expect(curve.points[9].transparency! / curve.points[0].transparency!).toBeCloseTo(CLOUDS(9) / CLOUDS(0), 12)
		expect(curve.points[9].flux).toBeUndefined()
		expect(curve.points[30].comparisonCount).toBe(3)
		expect(curve.comparisons[0].frameCount).toBe(39)

		// Normalizing every comparison by its own reference keeps the ensemble unbiased when some are
		// missing; the iteration refining the references stops at 1e-6 of the transparency uncertainty.
		for (const j of [0, 10, 25, 30, 35, 59]) expect(curve.points[j].relativeFlux).toBeCloseTo(1, 8)
		// The remaining comparisons link the frames where c1 and c3 are missing to the others.
		expect(curve.points.some((point) => point.flags.includes('disconnected'))).toBeFalse()
	})

	test('comparison sets without a common frame are not linked', () => {
		// A constant target under a cloud halving every star in frames 3..5, while comparison A is seen
		// only in frames 0..2 and B only in frames 3..5: the cloud is indistinguishable from B being fainter.
		const frames = Array.from({ length: 6 }, (_, j) => ({
			time: time(2460600, j * 0.01, Timescale.TT),
			stars: [{ id: 't', flux: j < 3 ? 100 : 50, fluxError: 1 }, j < 3 ? { id: 'A', flux: 1000, fluxError: 1 } : { id: 'B', flux: 500, fluxError: 1 }],
		}))

		const curve = differentialLightCurve(frames, 't')
		// Both ensembles have three frames; the earliest one is the reference.
		for (const point of curve.points.slice(0, 3)) {
			expect(point.transparency).toBeCloseTo(1, 12)
			expect(point.relativeFlux).toBeCloseTo(1, 12)
			expect(point.flags).toEqual([])
		}

		for (const point of curve.points.slice(3)) {
			expect(point.flags).toEqual(['disconnected'])
			expect(point.targetFlux).toBe(50)
			expect(point.transparency).toBeUndefined()
			expect(point.flux).toBeUndefined()
			expect(point.relativeFlux).toBeUndefined()
			expect(point.magnitude).toBeUndefined()
			expect(point.comparisonCount).toBe(0)
		}

		expect(curve.normalization).toBeCloseTo(100, 12)
		expect(curve.comparisons.map((c) => [c.id, c.status, c.referenceFlux, c.weight])).toEqual([
			['A', 'used', 1000, 1],
			['B', 'disconnected', undefined, 0],
		])
	})

	test('comparison sets sharing a frame are linked', () => {
		// A is seen in frames 0..3 and B in frames 2..5, both at transmission 1 in frame 2 and 0.5 in frame 3.
		const transmission = [1, 1, 1, 0.5, 0.5, 0.5]
		const frames = transmission.map((t, j) => ({
			time: time(2460600, j * 0.01, Timescale.TT),
			stars: [{ id: 't', flux: 100 * t, fluxError: 1 }, ...(j <= 3 ? [{ id: 'A', flux: 1000 * t, fluxError: 1 }] : []), ...(j >= 2 ? [{ id: 'B', flux: 400 * t, fluxError: 1 }] : [])],
		}))

		const curve = differentialLightCurve(frames, 't')
		expect(curve.converged).toBeTrue()
		expect(curve.comparisons.map((c) => c.status)).toEqual(['used', 'used'])
		// The median transmission is 0.75.
		expect(curve.comparisons[0].referenceFlux).toBeCloseTo(750, 6)
		expect(curve.comparisons[1].referenceFlux).toBeCloseTo(300, 6)

		for (let j = 0; j < 6; j++) {
			const point = curve.points[j]
			expect(point.flags).toEqual([])
			expect(point.transparency).toBeCloseTo(transmission[j] / 0.75, 8)
			expect(point.relativeFlux).toBeCloseTo(1, 8)
		}

		// sigma(T) / T = 1 / sqrt(sum of the comparison fluxes squared) with unit errors, and the target adds 1 / flux.
		const relativeError = (target: number, ...comparisons: number[]) => Math.hypot(1 / target, 1 / Math.hypot(...comparisons))
		expect(curve.points[0].relativeFluxError).toBeCloseTo(relativeError(100, 1000), 8)
		expect(curve.points[2].relativeFluxError).toBeCloseTo(relativeError(100, 1000, 400), 8)
		expect(curve.points[3].relativeFluxError).toBeCloseTo(relativeError(50, 500, 200), 8)
		expect(curve.points[5].relativeFluxError).toBeCloseTo(relativeError(50, 200), 8)
	})

	test('a rejected measurement can break the only link between comparison sets', () => {
		// As above, but B is saturated in frame 3, the only frame where it was linked to A.
		const transmission = [1, 1, 1, 0.5, 0.5, 0.5]
		const frames = transmission.map((t, j) => ({
			time: time(2460600, j * 0.01, Timescale.TT),
			stars: [{ id: 't', flux: 100 * t, fluxError: 1 }, ...(j <= 3 ? [{ id: 'A', flux: 1000 * t, fluxError: 1 }] : []), ...(j >= 3 ? [{ id: 'B', flux: 400 * t, fluxError: 1, flags: j === 3 ? (['saturated'] as const) : [] }] : [])],
		}))

		const curve = differentialLightCurve(frames, 't')
		expect(curve.points.map((point) => point.flags)).toEqual([[], [], [], [], ['disconnected'], ['disconnected']])
		for (const point of curve.points.slice(0, 4)) expect(point.relativeFlux).toBeCloseTo(1, 12)
		expect(curve.comparisons.map((c) => c.status)).toEqual(['used', 'disconnected'])

		// Accepting the flag restores the link; a single shared frame is a weak link that needs more iterations.
		expect(differentialLightCurve(frames, 't', undefined, { rejectFlags: [] }).converged).toBeFalse()
		const linked = differentialLightCurve(frames, 't', undefined, { rejectFlags: [], maxIterations: 100 })
		expect(linked.converged).toBeTrue()
		expect(linked.points.every((point) => point.flags.length === 0 && Math.abs(point.relativeFlux! - 1) < 1e-7)).toBeTrue()
	})

	test('a rejected variable comparison can break the only link between comparison sets', () => {
		// A1 and A2 are seen in frames 0..39 and B1 and B2 in frames 40..79; the variable V, seen in every
		// frame, is the only link, and a cloud dims frames 40..79 by 30%.
		const signal = (j: number) => 1 + 0.08 * Math.sin(j / 3)
		const stars = [
			{ id: 't', flux: 40000 },
			{ id: 'A1', flux: 80000 },
			{ id: 'A2', flux: 60000 },
			{ id: 'B1', flux: 70000 },
			{ id: 'B2', flux: 50000 },
			{ id: 'V', flux: 90000, signal },
		]
		const frames = simulate({ frameCount: 80, stars, transmission: (j) => (j < 40 ? 1 : 0.7), seed: 31 })
		for (let j = 0; j < 80; j++) frames[j] = { ...frames[j], stars: frames[j].stars.filter((star) => !String(star.id).startsWith(j < 40 ? 'B' : 'A')) }

		const curve = differentialLightCurve(frames, 't')
		expect(curve.rejectedComparisonIds).toEqual(['V'])
		expect(curve.points.slice(0, 40).every((point) => point.flags.length === 0)).toBeTrue()
		expect(curve.points.slice(40).every((point) => point.flags.includes('disconnected') && point.relativeFlux === undefined)).toBeTrue()
		expect(curve.comparisons.map((c) => [c.id, c.status])).toEqual([
			['A1', 'used'],
			['A2', 'used'],
			['V', 'variable'],
			['B1', 'disconnected'],
			['B2', 'disconnected'],
		])
		// The variable comparison is refitted on the reference frames only, at transmission 1.
		expect(curve.comparisons[2].referenceFlux! / 90000).toBeCloseTo(1, 2)
	})

	test('minimum comparisons per frame', () => {
		const frames = simulate({ frameCount: 10, stars: [{ id: 't', flux: 25000 }, ...COMPARISONS.slice(0, 3)] })
		frames[4] = { ...frames[4], stars: frames[4].stars.filter((star) => star.id !== 'c1' && star.id !== 'c2') }
		const curve = differentialLightCurve(frames, 't', undefined, { minComparisons: 2 })
		expect(curve.points[4].flags).toEqual(['noComparisons'])
		expect(curve.points[4].transparency).toBeUndefined()
		expect(curve.points[3].relativeFlux).toBeCloseTo(1, 12)
	})

	test('zero and negative flux', () => {
		const frames = simulate({ frameCount: 12, stars: [{ id: 't', flux: 25000 }, ...COMPARISONS.slice(0, 3)], transmission: CLOUDS })
		frames[3] = { ...frames[3], stars: frames[3].stars.map((star) => (star.id === 't' ? { ...star, flux: -500 } : star)) }
		frames[4] = { ...frames[4], stars: frames[4].stars.map((star) => (star.id === 't' ? { ...star, flux: 0 } : star.id === 'c1' ? { ...star, flux: 0 } : star)) }
		frames[5] = { ...frames[5], stars: frames[5].stars.map((star) => (star.id === 'c2' ? { ...star, flux: -100 } : star.id === 't' ? { ...star, fluxError: 0 } : star)) }
		frames[6] = { ...frames[6], stars: frames[6].stars.map((star) => (star.id === 'c3' ? { ...star, flags: ['saturated'] } : star)) }

		const curve = differentialLightCurve(frames, 't')
		expect(curve.points[3].flags).toEqual(['targetNonPositive'])
		expect(curve.points[3].relativeFlux).toBeCloseTo(-500 / CLOUDS(3) / 25000, 10)
		expect(curve.points[3].relativeFluxError).toBeGreaterThan(0)
		expect(curve.points[3].magnitude).toBeUndefined()
		expect(curve.points[3].magnitudeError).toBeUndefined()
		expect(curve.points[4].flags).toEqual(['targetNonPositive'])
		expect(curve.points[4].relativeFlux).toBe(0)
		expect(curve.points[4].comparisonCount).toBe(2)
		// A zero target error makes the measurement unusable; a negative comparison flux drops it from the frame.
		expect(curve.points[5].flags).toEqual(['targetMissing'])
		expect(curve.points[5].comparisonCount).toBe(2)
		expect(curve.points[6].comparisonCount).toBe(2)
		expect(curve.points[6].relativeFlux).toBeCloseTo(1, 8)
		expect(curve.comparisons.map((c) => c.frameCount)).toEqual([11, 11, 11])
		for (const point of curve.points) expect(Object.values(point).every((value) => typeof value !== 'number' || Number.isFinite(value))).toBeTrue()
	})

	test('flags can be accepted', () => {
		const frames = simulate({ frameCount: 6, stars: [{ id: 't', flux: 25000 }, ...COMPARISONS.slice(0, 2)] })
		frames[2] = { ...frames[2], stars: frames[2].stars.map((star) => (star.id === 't' ? { ...star, flags: ['truncated'] } : star)) }
		expect(differentialLightCurve(frames, 't').points[2].flags).toEqual(['targetMissing'])
		expect(differentialLightCurve(frames, 't', undefined, { rejectFlags: ['saturated'] }).points[2].flags).toEqual([])
	})

	test('empty series and no comparisons', () => {
		const empty = differentialLightCurve([], 't')
		expect(empty.points).toEqual([])
		expect(empty.timescale).toBeUndefined()
		expect(empty.normalization).toBeUndefined()
		expect(empty.converged).toBeFalse()

		const lonely = differentialLightCurve(simulate({ frameCount: 3, stars: [{ id: 't', flux: 100 }] }), 't')
		expect(lonely.comparisons).toEqual([])
		expect(lonely.points.every((point) => point.flags.includes('noComparisons') && point.flux === undefined)).toBeTrue()
		// No transparency in any frame is no solution, not a converged one.
		expect(lonely.converged).toBeFalse()
		expect(lonely.iterations).toBe(1)
	})

	test('unusable comparisons do not converge', () => {
		const frames = simulate({ frameCount: 4, stars: [{ id: 't', flux: 100 }, ...COMPARISONS.slice(0, 2)] })
		for (let j = 0; j < 4; j++) frames[j] = { ...frames[j], stars: frames[j].stars.map((star) => (star.id === 't' ? star : { ...star, flags: ['saturated'] as const })) }

		const curve = differentialLightCurve(frames, 't')
		expect(curve.converged).toBeFalse()
		expect(curve.points.every((point) => point.flags.length === 1 && point.flags[0] === 'noComparisons')).toBeTrue()

		// One frame with a transparency is a solution.
		frames[2] = { ...frames[2], stars: frames[2].stars.map((star) => ({ ...star, flags: undefined })) }
		const single = differentialLightCurve(frames, 't')
		expect(single.converged).toBeTrue()
		expect(single.points.map((point) => point.flags)).toEqual([['noComparisons'], ['noComparisons'], [], ['noComparisons']])
		expect(single.points[2].relativeFlux).toBeCloseTo(1, 12)
	})
})

describe('identities', () => {
	test('shifted and reordered star identities', () => {
		const frames = simulate({ frameCount: 50, stars: [{ id: 0, flux: 40000 }, ...COMPARISONS.map((c, i) => ({ ...c, id: i + 1 }))], transmission: CLOUDS, seed: 17 })
		const random = mulberry32(99)
		// Every frame lists the stars in a different order, with a drifting centroid.
		const shuffled = frames.map((frame, j) => ({
			...frame,
			stars: frame.stars
				.map((star) => ({ ...star, x: 100 + 5 * Number(star.id) + 0.3 * j, y: 50 - 0.2 * j }))
				.map((star) => [random(), star] as const)
				.sort((a, b) => a[0] - b[0])
				.map(([, star]) => star),
		}))

		const reference = differentialLightCurve(frames, 0)
		const curve = differentialLightCurve(shuffled, 0)
		expect(curve.comparisons.map((c) => c.id).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5])

		for (let j = 0; j < 50; j++) {
			expect(curve.points[j].relativeFlux).toBeCloseTo(reference.points[j].relativeFlux!, 12)
			expect(curve.points[j].relativeFluxError).toBeCloseTo(reference.points[j].relativeFluxError!, 12)
		}
	})

	test('mixed timescales and repeated ids throw', () => {
		const stars = [{ id: 't', flux: 1, fluxError: 1 }]
		expect(() =>
			differentialLightCurve(
				[
					{ time: time(2460600, 0, Timescale.UTC), stars },
					{ time: time(2460600, 0, Timescale.TDB), stars },
				],
				't',
			),
		).toThrow(RangeError)
		expect(() => differentialLightCurve([{ time: time(2460600, 0, Timescale.UTC), stars: [...stars, ...stars] }], 't')).toThrow(RangeError)
		expect(() => differentialLightCurve([{ time: time(2460600, 0, Timescale.UTC), stars }], 't', undefined, { maxIterations: 0 })).toThrow()
	})

	test('epochs keep their own timescale', () => {
		const epochs: Time[] = [time(2460600.5, 0.1, Timescale.TCB), time(2460600.5, 0.2, Timescale.TCB)]
		const frames = epochs.map((epoch) => ({
			time: epoch,
			stars: [
				{ id: 't', flux: 10, fluxError: 1 },
				{ id: 'c', flux: 20, fluxError: 1 },
			],
		}))
		const curve = differentialLightCurve(frames, 't')
		expect(curve.timescale).toBe(Timescale.TCB)
		expect(curve.points.map((point) => point.time)).toEqual(epochs)
	})
})

describe('detrending', () => {
	// The target is redder than the comparisons: its differential flux falls 3% per airmass.
	const airmass = (j: number) => 1.1 + 0.9 * (j / 99) ** 2
	const colorTerm = (j: number) => 1 - 0.03 * (airmass(j) - 1.1)

	test('airmass trend is removed and the original series is preserved', () => {
		const frames = simulate({ frameCount: 100, stars: [{ id: 't', flux: 50000, signal: colorTerm }, ...COMPARISONS], seed: 23, airmass })
		frames[7] = { ...frames[7], airmass: undefined }
		const plain = differentialLightCurve(frames, 't')
		const curve = differentialLightCurve(frames, 't', undefined, { detrend: { covariates: ['airmass'] } })

		const fit = curve.detrending!.fit!
		expect(curve.detrending!.pointCount).toBe(99)
		// relativeFlux = k (1 - 0.03 (X - 1.1)), so slope / intercept = -0.03 / (1 - 0.03 (mean X - 1.1)).
		expect(fit.coefficients[0] / fit.intercept).toBeCloseTo(-0.03 / (1 - 0.03 * (fit.means[0] - 1.1)), 2)
		expect(fit.rankDeficient).toBeFalse()
		expect(fit.scatterAfter).toBeLessThan(0.7 * fit.scatterBefore)
		expect(curve.points[7].flags).toEqual(['notDetrended'])
		expect(curve.points[7].detrended).toBeUndefined()

		for (let j = 0; j < 100; j++) {
			expect(curve.points[j].relativeFlux).toBe(plain.points[j].relativeFlux)
			expect(curve.points[j].magnitude).toBe(plain.points[j].magnitude)
		}

		const detrended = curve.points.filter((point) => point.detrended !== undefined).map((point) => point.detrended!.relativeFlux)
		const error = curve.points[0].relativeFluxError!
		expect(standardDeviation(detrended)).toBeLessThan(1.3 * error)
		expect(plain.detrending).toBeUndefined()
	})

	test('robust fit is not pulled by an eclipse', () => {
		const eclipse = (j: number) => colorTerm(j) * (j >= 80 && j < 95 ? 0.95 : 1)
		const frames = simulate({ frameCount: 100, stars: [{ id: 't', flux: 50000, signal: eclipse }, ...COMPARISONS], airmass })
		const curve = differentialLightCurve(frames, 't', undefined, { detrend: { covariates: ['airmass'], method: 'tukey' } })
		const fit = curve.detrending!.fit!
		expect(fit.coefficients[0] / fit.intercept).toBeCloseTo(-0.03 / (1 - 0.03 * (fit.means[0] - 1.1)), 6)
		expect(curve.points[85].detrended!.relativeFlux / curve.points[10].detrended!.relativeFlux).toBeCloseTo(0.95, 6)
		expect(curve.points[85].detrended!.magnitude! - curve.points[10].detrended!.magnitude!).toBeCloseTo(-2.5 * Math.log10(0.95), 6)
	})

	test('centroid drift and fwhm covariates', () => {
		// Intrapixel response: the target loses 1% per pixel of x drift; the FWHM is constant.
		const frames = simulate({ frameCount: 40, stars: [{ id: 't', flux: 50000, signal: (j) => 1 - 0.01 * (0.05 * j), x: (j) => 200 + 0.05 * j }, ...COMPARISONS], fwhm: 3.2 })

		const curve = differentialLightCurve(frames, 't', undefined, { detrend: { covariates: ['x'], method: 'none' } })
		const fit = curve.detrending!.fit!
		expect(fit.means[0]).toBeCloseTo(200 + 0.05 * 19.5, 12)
		for (const point of curve.points) expect(point.detrended!.relativeFlux).toBeCloseTo(fit.intercept, 10)

		const degenerate = differentialLightCurve(frames, 't', undefined, { detrend: { covariates: ['x', 'fwhm'], method: 'none' } })
		expect(degenerate.detrending!.fit!.rankDeficient).toBeTrue()
	})

	test('too few points for the model', () => {
		const frames = simulate({ frameCount: 2, stars: [{ id: 't', flux: 50000 }, ...COMPARISONS], airmass })
		const curve = differentialLightCurve(frames, 't', undefined, { detrend: { covariates: ['airmass'] } })
		expect(curve.detrending).toEqual({ covariates: ['airmass'], pointCount: 2, fit: undefined })
		expect(curve.points.every((point) => point.flags.includes('notDetrended'))).toBeTrue()
	})
})
