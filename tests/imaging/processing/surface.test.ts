import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { basisTermCount, createScalarSurfaceEvaluator, createScalarSurfacePointEvaluator, createSurfaceColumnTable, evaluateScalarSurfaceInto, fillBasisExponents, fillChebyshev, fitScalarSurface, fullSurfaceDomain, SURFACE_MAX_CONTROL_POINTS, type SurfaceFitOptions, type SurfaceSample } from '../../../src/imaging/processing/surface'

function sampleGrid(width: number, height: number, columns: number, rows: number, value: (x: number, y: number) => number, weight?: (x: number, y: number) => number) {
	const samples: SurfaceSample[] = []

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < columns; c++) {
			const x = ((c + 0.5) / columns) * (width - 1)
			const y = ((r + 0.5) / rows) * (height - 1)
			samples.push({ x, y, value: value(x, y), weight: weight?.(x, y) ?? 1 })
		}
	}

	return samples
}

function rng(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 4294967296
	}
}

function fitOrThrow(samples: readonly SurfaceSample[], width: number, height: number, options?: SurfaceFitOptions) {
	const result = fitScalarSurface(samples, width, height, options)
	if (!result.ok) throw new Error(`unexpected failure: ${result.reason}`)
	return result.model
}

function materialize(samples: readonly SurfaceSample[], width: number, height: number, options?: SurfaceFitOptions) {
	const model = fitOrThrow(samples, width, height, options)
	const out = new Float64Array(width * height)
	evaluateScalarSurfaceInto(model, out)
	return { model, out }
}

describe('basis', () => {
	test('term count follows (d+1)(d+2)/2', () => {
		expect([1, 2, 3, 4, 5, 6].map(basisTermCount)).toEqual([3, 6, 10, 15, 21, 28])
	})

	test('exponents are ordered by ascending total degree', () => {
		const terms = basisTermCount(3)
		const ti = new Uint8Array(terms)
		const tj = new Uint8Array(terms)

		expect(fillBasisExponents(3, ti, tj)).toBe(terms)

		for (let k = 1; k < terms; k++) expect(ti[k] + tj[k]).toBeGreaterThanOrEqual(ti[k - 1] + tj[k - 1])
		for (let k = 0; k < terms; k++) expect(ti[k] + tj[k]).toBeLessThanOrEqual(3)
	})

	test('chebyshev recurrence matches closed forms', () => {
		const out = new Float64Array(5)
		fillChebyshev(out, 0, 0.5, 4)

		expect(out[0]).toBeCloseTo(1, 12)
		expect(out[1]).toBeCloseTo(0.5, 12)
		expect(out[2]).toBeCloseTo(2 * 0.25 - 1, 12)
		expect(out[3]).toBeCloseTo(4 * 0.125 - 3 * 0.5, 12)
		expect(out[4]).toBeCloseTo(8 * 0.0625 - 8 * 0.25 + 1, 12)
	})
})

describe('polynomial fit', () => {
	test('recovers a known plane at every pixel', () => {
		const field = (x: number, y: number) => 0.25 + 0.001 * x - 0.002 * y
		const { out } = materialize(sampleGrid(64, 48, 8, 6, field), 64, 48, { degree: 1 })

		for (const [x, y] of [
			[0, 0],
			[63, 0],
			[0, 47],
			[63, 47],
			[31, 24],
		]) {
			expect(out[y * 64 + x]).toBeCloseTo(field(x, y), 9)
		}
	})

	test('recovers a known cubic', () => {
		const field = (x: number, y: number) => {
			const u = x / 63
			const v = y / 47
			return 0.1 + 0.4 * u - 0.2 * v + 0.3 * u * u * v - 0.15 * v * v * v
		}
		const { out } = materialize(sampleGrid(64, 48, 10, 10, field), 64, 48, { degree: 3 })

		for (let y = 0; y < 48; y += 7) {
			for (let x = 0; x < 64; x += 9) expect(out[y * 64 + x]).toBeCloseTo(field(x, y), 8)
		}
	})

	test('fits every supported degree', () => {
		for (let degree = 1; degree <= 6; degree++) {
			const model = fitOrThrow(
				sampleGrid(80, 80, 12, 12, (x, y) => 0.2 + 0.003 * x + 0.002 * y),
				80,
				80,
				{ degree },
			)
			expect(model.coefficients).toHaveLength(basisTermCount(degree))
			expect(model.degree).toBe(degree)
		}
	})

	test('weights pull the surface toward the reliable samples', () => {
		const samples: SurfaceSample[] = [
			...sampleGrid(
				32,
				32,
				4,
				4,
				() => 1,
				() => 1,
			),
			{ x: 16, y: 16, value: 100, weight: 1e-6 },
		]
		const { out } = materialize(samples, 32, 32, { degree: 1 })
		expect(out[16 * 32 + 16]).toBeCloseTo(1, 3)
	})

	test('rejection drops an outlier and keeps the underlying plane', () => {
		const field = (x: number, y: number) => 0.2 + 0.002 * x
		const samples = sampleGrid(64, 64, 8, 8, field)
		const contaminated = sampleGrid(64, 64, 8, 8, field)
		contaminated[27] = { ...contaminated[27], value: contaminated[27].value + 5 }

		const without = fitOrThrow(samples, 64, 64, { degree: 1 })
		const withOutlier = fitOrThrow(contaminated, 64, 64, { degree: 1, rejection: { mode: 'symmetric', high: 3, low: 3, iterations: 3 } })

		expect(withOutlier.rejectedSamples).toBeGreaterThanOrEqual(1)
		expect(withOutlier.samples[27].accepted).toBe(false)
		for (let k = 0; k < without.coefficients.length; k++) expect(withOutlier.coefficients[k]).toBeCloseTo(without.coefficients[k], 6)
	})

	test('asymmetric rejection is tight above and loose below', () => {
		// A realistic scatter so the robust MAD is meaningful; the outlier then sits at a known sigma.
		const jitter = (x: number, y: number) => 0.2 + 0.001 * ((((Math.round(x) + Math.round(y)) % 5) - 2) / 2)
		const bright = sampleGrid(64, 64, 8, 8, jitter)
		const dark = sampleGrid(64, 64, 8, 8, jitter)
		bright[10] = { ...bright[10], value: 0.205 }
		dark[10] = { ...dark[10], value: 0.195 }
		const rejection = { mode: 'asymmetric', high: 2.5, low: 8, iterations: 2 } as const

		expect(fitOrThrow(bright, 64, 64, { degree: 1, rejection }).samples[10].accepted).toBe(false)
		expect(fitOrThrow(dark, 64, 64, { degree: 1, rejection }).samples[10].accepted).toBe(true)
	})

	test('rejection none keeps every sample', () => {
		const contaminated = sampleGrid(64, 64, 8, 8, () => 0.2)
		contaminated[3] = { ...contaminated[3], value: 9 }
		const model = fitOrThrow(contaminated, 64, 64, { degree: 1 })

		expect(model.rejectedSamples).toBe(0)
		expect(model.acceptedSamples).toBe(contaminated.length)
	})
})

describe('degenerate layouts', () => {
	test('too few samples for the degree', () => {
		const result = fitScalarSurface(
			sampleGrid(64, 64, 2, 2, () => 1),
			64,
			64,
			{ degree: 3 },
		)
		expect(result).toEqual({ ok: false, reason: 'too-few-samples' })
	})

	test('a thin strip is rejected as degenerate', () => {
		const samples: SurfaceSample[] = []
		for (let i = 0; i < 40; i++) samples.push({ x: i * 1.5, y: 32, value: 0.2 })

		expect(fitScalarSurface(samples, 64, 64, { degree: 1 })).toEqual({ ok: false, reason: 'degenerate-layout' })
	})

	test('a bounded domain rescues a layout the full frame rejects', () => {
		const samples: SurfaceSample[] = []
		for (let r = 0; r < 6; r++) {
			for (let c = 0; c < 20; c++) samples.push({ x: c * 30, y: 300 + r * 0.4, value: 0.2 + 0.0001 * c })
		}

		expect(fitScalarSurface(samples, 600, 600, { degree: 1 })).toEqual({ ok: false, reason: 'degenerate-layout' })

		const bounded = fitScalarSurface(samples, 600, 600, { degree: 1, domain: { x0: 0, y0: 300, x1: 570, y1: 302 } })
		expect(bounded.ok).toBe(true)
	})

	test('a spline needs three non-collinear points', () => {
		const collinear: SurfaceSample[] = [
			{ x: 0, y: 0, value: 1 },
			{ x: 10, y: 10, value: 2 },
			{ x: 20, y: 20, value: 3 },
		]
		expect(fitScalarSurface(collinear, 32, 32, { model: 'thinPlateSpline' })).toEqual({ ok: false, reason: 'degenerate-layout' })
	})

	test('a sparse spline set reports too few samples, not a degenerate layout', () => {
		for (const count of [0, 1, 2]) {
			const samples: SurfaceSample[] = []
			for (let i = 0; i < count; i++) samples.push({ x: i * 20, y: i * 13, value: 0.2 })
			expect(fitScalarSurface(samples, 64, 64, { model: 'thinPlateSpline' })).toEqual({ ok: false, reason: 'too-few-samples' })
		}
	})
})

describe('thin-plate spline', () => {
	test('a zero-smoothing spline interpolates its samples', () => {
		const field = (x: number, y: number) => 0.3 + 0.2 * Math.sin(x / 20) * Math.cos(y / 17)
		const samples = sampleGrid(64, 64, 6, 6, field)
		const { model, out } = materialize(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0 })

		expect(model.type).toBe('thinPlateSpline')
		expect(model.controlPoints).toBeDefined()

		for (const sample of samples) {
			const x = Math.round(sample.x)
			const y = Math.round(sample.y)
			expect(out[y * 64 + x]).toBeCloseTo(field(x, y), 2)
		}
	})

	test('smoothing relaxes the surface away from the samples', () => {
		const samples = sampleGrid(64, 64, 6, 6, (x, y) => (((Math.round(x) + Math.round(y)) & 1) === 0 ? 1 : 0))
		const exact = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0 })
		const smoothed = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 1 })

		expect(smoothed.residual).toBeGreaterThan(exact.residual)
	})

	test('an interpolating spline deduplicates coordinates instead of going singular', () => {
		const samples = [...sampleGrid(64, 64, 5, 5, (x, y) => 0.2 + 0.001 * (x + y))]
		samples.push({ ...samples[7] })
		samples.push({ ...samples[12] })

		const model = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0 })
		expect(model.rejectedSamples).toBe(2)
	})

	test('a smoothing spline keeps coincident observations and averages them', () => {
		// The regularized diagonal makes coincident points solvable, so they are real repeated
		// measurements rather than a degeneracy to remove.
		const samples = [...sampleGrid(64, 64, 5, 5, (x, y) => 0.2 + 0.001 * (x + y))]
		samples.push({ ...samples[7] })

		expect(fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1 }).rejectedSamples).toBe(0)

		// Dropping all but the first would make the fit depend on which duplicate came first.
		function centerOf(first: number, second: number) {
			const corners: SurfaceSample[] = [
				{ x: 0, y: 0, value: 0 },
				{ x: 63, y: 0, value: 0 },
				{ x: 0, y: 63, value: 0 },
				{ x: 63, y: 63, value: 0 },
				{ x: 32, y: 32, value: first },
				{ x: 32, y: 32, value: second },
			]
			return createScalarSurfacePointEvaluator(fitOrThrow(corners, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1 })).at(32, 32)
		}

		const forward = centerOf(0, 10)
		expect(centerOf(10, 0)).toBeCloseTo(forward, 9)
		// The two observations are averaged, so the fit sits between them rather than on either.
		expect(forward).toBeGreaterThan(1)
		expect(forward).toBeLessThan(9)
	})

	test('control points are capped and the dropped samples are reported', () => {
		const samples = sampleGrid(256, 256, 12, 12, (x, y) => 0.2 + 0.0005 * (x - y))
		const model = fitOrThrow(samples, 256, 256, { model: 'thinPlateSpline', smoothing: 0, maxControlPoints: 16 })

		expect(model.controlPoints!.length / 2).toBeLessThanOrEqual(16)
		expect(model.acceptedSamples).toBe(model.controlPoints!.length / 2)
		expect(model.rejectedSamples).toBe(samples.length - model.acceptedSamples)
	})

	test('the control cap is clamped to the tractability ceiling', () => {
		// Enough samples that an unclamped cap would size the dense system by the caller's value.
		const side = Math.ceil(Math.sqrt(SURFACE_MAX_CONTROL_POINTS)) + 20
		const samples = sampleGrid(2048, 2048, side, side, (x, y) => 0.2 + 0.00001 * (x - y))
		expect(samples.length).toBeGreaterThan(SURFACE_MAX_CONTROL_POINTS)

		const model = fitOrThrow(samples, 2048, 2048, { model: 'thinPlateSpline', smoothing: 0.5, maxControlPoints: 1_000_000 })
		expect(model.controlPoints!.length / 2).toBeLessThanOrEqual(SURFACE_MAX_CONTROL_POINTS)
	})

	test('a cap below the spline minimum is raised to it', () => {
		const samples = sampleGrid(64, 64, 6, 6, (x, y) => 0.2 + 0.001 * (x + y))
		const model = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1, maxControlPoints: 1 })
		expect(model.controlPoints!.length / 2).toBe(3)
	})

	test('a cap at the spline minimum still yields a fittable set', () => {
		const samples = sampleGrid(64, 64, 6, 6, (x, y) => 0.2 + 0.001 * (x + y))

		// floor(sqrt(3)) collapses the coverage grid to a single bucket, which would leave one control
		// point and fail a layout a three-point spline fits perfectly well.
		const model = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1, maxControlPoints: 3 })
		expect(model.controlPoints!.length / 2).toBe(3)
	})

	test('a cap at the minimum picks non-collinear controls from a mostly linear layout', () => {
		// A long collinear run whose off-line samples cluster near one endpoint. The midpoint of the run is
		// farther from both endpoints than any off-line sample, so choosing the third control by distance
		// would take it and leave the saddle-point system singular.
		const samples: SurfaceSample[] = []
		for (let i = 0; i <= 20; i++) samples.push({ x: i * 5, y: 0, value: 0.2 + 0.001 * i })
		for (let i = 0; i < 4; i++) samples.push({ x: 2 + i, y: 18 + i, value: 0.25 })

		expect(fitScalarSurface(samples, 128, 128, { model: 'thinPlateSpline', smoothing: 0.1 }).ok).toBe(true)

		const model = fitOrThrow(samples, 128, 128, { model: 'thinPlateSpline', smoothing: 0.1, maxControlPoints: 3 })
		const points = model.controlPoints!
		expect(points.length / 2).toBe(3)

		// The three controls must span a real triangle.
		const area = Math.abs((points[2] - points[0]) * (points[5] - points[1]) - (points[3] - points[1]) * (points[4] - points[0]))
		expect(area).toBeGreaterThan(0)
	})

	test('a capped selection whose bucket representatives are collinear is repaired', () => {
		// Only the three diagonal buckets of the 3x3 grid a cap of 9 builds are occupied, and the FIRST
		// sample in each sits on the main diagonal. Later samples in the same buckets give the whole set
		// genuine 2D spread, so the set passes the coverage check while the selection alone would not.
		const samples: SurfaceSample[] = []
		const centers = [
			[8, 8],
			[32, 32],
			[56, 56],
		]
		for (const [cx, cy] of centers) samples.push({ x: cx, y: cy, value: 0.2 + 0.001 * cx })
		for (const [cx, cy] of centers) {
			for (let k = 1; k <= 4; k++) samples.push({ x: cx + k, y: cy - k, value: 0.2 + 0.001 * (cx + k) })
		}

		expect(fitScalarSurface(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1 }).ok).toBe(true)

		const model = fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1, maxControlPoints: 9 })
		const points = model.controlPoints!
		const k = points.length / 2
		expect(k).toBeGreaterThanOrEqual(3)

		// Some triple of the selected controls must span a real triangle.
		let maxArea = 0
		for (let a = 0; a < k; a++) {
			for (let b = a + 1; b < k; b++) {
				for (let c = b + 1; c < k; c++) {
					const area = Math.abs((points[2 * b] - points[2 * a]) * (points[2 * c + 1] - points[2 * a + 1]) - (points[2 * b + 1] - points[2 * a + 1]) * (points[2 * c] - points[2 * a]))
					maxArea = Math.max(maxArea, area)
				}
			}
		}
		expect(maxArea).toBeGreaterThan(0)
	})

	test('capping keeps the most reliable sample in each bucket', () => {
		// Two observations at one location, one nearly worthless and one fully reliable. The fit weights
		// its samples, so which of the two survives the cap must not depend on the order they were listed.
		function centerOf(reliableFirst: boolean) {
			const samples: SurfaceSample[] = []
			for (let r = 0; r < 4; r++) {
				for (let c = 0; c < 4; c++) {
					const x = 4 + c * 18
					const y = 4 + r * 18
					if (r === 1 && c === 1) {
						const reliable = { x, y, value: 0, weight: 1 }
						const noisy = { x, y, value: 1, weight: 1e-6 }
						samples.push(reliableFirst ? reliable : noisy, reliableFirst ? noisy : reliable)
					} else {
						samples.push({ x, y, value: 0, weight: 1 })
					}
				}
			}

			return createScalarSurfacePointEvaluator(fitOrThrow(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.01, maxControlPoints: 9 })).at(22, 22)
		}

		const forward = centerOf(true)
		expect(centerOf(false)).toBeCloseTo(forward, 12)
		// The reliable observation is the one that survives, so the surface follows its value.
		expect(Math.abs(forward)).toBeLessThan(1e-5)
	})

	test('a capped selection always spans a triangle, over many layouts and caps', () => {
		// The class of bugs this closes came from repairing the selection only when it looked degenerate.
		// The spanning triple is now merged in unconditionally, so the property is checked broadly rather
		// than through one more hand-built arrangement.
		const random = (() => {
			let state = 20240517
			return () => {
				state = (state * 1664525 + 1013904223) >>> 0
				return state / 4294967296
			}
		})()

		for (let trial = 0; trial < 120; trial++) {
			const samples: SurfaceSample[] = []
			// A dominant collinear run plus a few off-line samples: the layout family that kept slipping
			// through, with the run's direction, length and the off-line cluster all varying.
			const angle = random() * Math.PI
			const dx = Math.cos(angle)
			const dy = Math.sin(angle)
			const runLength = 6 + Math.floor(random() * 20)
			for (let i = 0; i < runLength; i++) {
				const t = (i / (runLength - 1)) * 50
				samples.push({ x: 32 + dx * (t - 25), y: 32 + dy * (t - 25), value: 0.2 + 0.001 * t })
			}
			const offCount = 1 + Math.floor(random() * 4)
			for (let i = 0; i < offCount; i++) {
				const t = random() * 50 - 25
				const push = (0.5 + random() * 6) * (random() < 0.5 ? 1 : -1)
				samples.push({ x: 32 + dx * t - dy * push, y: 32 + dy * t + dx * push, value: 0.25 })
			}

			const uncapped = fitScalarSurface(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1 })
			if (!uncapped.ok) continue

			for (const maxControlPoints of [3, 4, 9, 16]) {
				const capped = fitScalarSurface(samples, 64, 64, { model: 'thinPlateSpline', smoothing: 0.1, maxControlPoints })
				expect(capped.ok).toBe(true)
				if (!capped.ok) continue

				const points = capped.model.controlPoints!
				const k = points.length / 2
				let maxArea = 0
				for (let a = 0; a < k; a++) {
					for (let b = a + 1; b < k; b++) {
						for (let c = b + 1; c < k; c++) {
							maxArea = Math.max(maxArea, Math.abs((points[2 * b] - points[2 * a]) * (points[2 * c + 1] - points[2 * a + 1]) - (points[2 * b + 1] - points[2 * a + 1]) * (points[2 * c] - points[2 * a])))
						}
					}
				}
				expect(maxArea).toBeGreaterThan(0)
			}
		}
	})

	test('a smoothing spline rejects the samples the cap dropped', () => {
		const samples = sampleGrid(256, 256, 12, 12, (x, y) => 0.2 + 0.0005 * (x - y))
		const model = fitOrThrow(samples, 256, 256, { model: 'thinPlateSpline', smoothing: 0.5, maxControlPoints: 16 })
		const controls = model.controlPoints!.length / 2

		// Acceptance means the sample fed the final fit, and a capped-out sample did not, smoothing or not.
		expect(controls).toBeLessThanOrEqual(16)
		expect(model.acceptedSamples).toBe(controls)
		expect(model.rejectedSamples).toBe(samples.length - controls)
		expect(model.samples.filter((sample) => sample.accepted)).toHaveLength(controls)
	})

	test('the residual still covers the samples the cap dropped', () => {
		// A plane fits every sample exactly, so a residual measured only over the controls would be zero.
		const exact = sampleGrid(256, 256, 12, 12, (x, y) => 0.2 + 0.0005 * (x - y))
		expect(fitOrThrow(exact, 256, 256, { model: 'thinPlateSpline', smoothing: 0.5, maxControlPoints: 16 }).residual).toBeCloseTo(0, 6)

		// Displacing the samples the cap will drop must show up in the residual.
		const scattered = sampleGrid(256, 256, 12, 12, (x, y) => 0.2 + 0.0005 * (x - y) + (((Math.round(x) + Math.round(y)) % 7) - 3) * 0.01)
		expect(fitOrThrow(scattered, 256, 256, { model: 'thinPlateSpline', smoothing: 0.5, maxControlPoints: 16 }).residual).toBeGreaterThan(1e-3)
	})
})

describe('evaluation', () => {
	test('a spline over a restricted domain materializes to its fitted values', () => {
		// The control points are packed into a small corner of a large plane. Spacing the coarse nodes by
		// the plane area instead of the domain area puts them far wider than the control points, and the
		// bilinear upsample stops tracking the fitted surface inside the covered region.
		const field = (x: number, y: number) => 0.2 + 0.02 * Math.sin(x / 3) * Math.cos(y / 3)
		const samples: SurfaceSample[] = []
		for (let r = 0; r < 7; r++) {
			for (let c = 0; c < 7; c++) {
				const x = 10 + c * 4
				const y = 10 + r * 4
				samples.push({ x, y, value: field(x, y) })
			}
		}

		const domain = { x0: 10, y0: 10, x1: 34, y1: 34 }
		const model = fitOrThrow(samples, 512, 512, { model: 'thinPlateSpline', smoothing: 0.05, domain })

		const plane = new Float64Array(512 * 512)
		evaluateScalarSurfaceInto(model, plane)

		const point = createScalarSurfacePointEvaluator(model)
		let maxDelta = 0
		for (let y = 10; y <= 34; y++) {
			for (let x = 10; x <= 34; x++) maxDelta = Math.max(maxDelta, Math.abs(plane[y * 512 + x] - point.at(x, y)))
		}

		// Well below the fit's own amplitude, which spans about 0.04.
		expect(maxDelta).toBeLessThan(1e-3)
	})

	test('clustered controls are materialized at their own scale', () => {
		// Four corner controls plus a dense cluster at the center. The mean control spacing suggests nodes
		// tens of pixels apart, but the surface varies on the cluster's 1-pixel scale, so a mean-derived
		// coarse step walks straight over the structure it is supposed to reproduce.
		const size = 1000
		const samples: SurfaceSample[] = [
			{ x: 0, y: 0, value: 0 },
			{ x: size - 1, y: 0, value: 0 },
			{ x: 0, y: size - 1, value: 0 },
			{ x: size - 1, y: size - 1, value: 0 },
		]
		for (let r = 0; r < 10; r++) {
			for (let c = 0; c < 10; c++) samples.push({ x: 495 + c, y: 495 + r, value: (r + c) % 2 === 0 ? 1 : -1 })
		}

		const model = fitOrThrow(samples, size, size, { model: 'thinPlateSpline', smoothing: 1e-5 })
		const plane = new Float64Array(size * size)
		evaluateScalarSurfaceInto(model, plane)
		const point = createScalarSurfacePointEvaluator(model)

		let worst = 0
		for (const sample of samples) {
			const x = Math.round(sample.x)
			const y = Math.round(sample.y)
			worst = Math.max(worst, Math.abs(plane[y * size + x] - point.at(x, y)))
		}

		// Far below the documented coarse-grid tolerance, which is a fraction of the local amplitude.
		expect(worst).toBeLessThan(1e-3)
	}, 20000)

	test('the coarse grid holds its tolerance between control points, not just at them', () => {
		// Bilinear interpolation is furthest from the function it interpolates at the centre of a cell, so
		// a grid verified only at the control points bounds nothing in between. Sweeping random irregular
		// layouts found one deviating by 1.46% of its amplitude while every control agreed.
		const size = 301
		const random = rng(20260101)
		let worst = 0

		for (let trial = 0; trial < 40; trial++) {
			const samples: SurfaceSample[] = []
			for (let i = 0; i < 8; i++) samples.push({ x: Math.round(random() * (size - 1)), y: Math.round(random() * (size - 1)), value: random() })

			const fit = fitScalarSurface(samples, size, size, { model: 'thinPlateSpline', smoothing: 0.01 })
			if (!fit.ok) continue

			const plane = new Float64Array(size * size)
			evaluateScalarSurfaceInto(fit.model, plane)
			const point = createScalarSurfacePointEvaluator(fit.model)
			const controlPoints = fit.model.controlPoints!
			const k = controlPoints.length / 2

			// The tolerance is relative to the surface's range over its controls.
			let low = Infinity
			let high = -Infinity
			for (const sample of samples) {
				const value = point.at(sample.x, sample.y)
				low = Math.min(low, value)
				high = Math.max(high, value)
			}
			const amplitude = high - low
			if (!(amplitude > 0) || k < 3) continue

			for (let y = 0; y < size; y += 3) {
				for (let x = 0; x < size; x += 3) worst = Math.max(worst, Math.abs(plane[y * size + x] - point.at(x, y)) / amplitude)
			}
		}

		// The documented coarse-grid tolerance, now a verified property of the materialization.
		expect(worst).toBeLessThanOrEqual(0.005)
	}, 20000)

	test('an exact spline over a large plane stays bounded instead of stalling', () => {
		// Direct evaluation of an interpolating spline is O(pixels * controls) and neither factor bounds
		// the other: the control cap keeps the solve tractable but says nothing about the plane it is
		// evaluated over. At 2048x2048 against 1024 controls that is 4.3 billion kernel evaluations, each
		// with a logarithm, so the materialization must fall back to the verified coarse path.
		const size = 2048
		const cells = 48
		const field = (x: number, y: number) => 0.3 + 0.15 * Math.sin(3 * (x / size)) * Math.cos(3 * (y / size))
		const samples = sampleGrid(size, size, cells, cells, field)

		const model = fitOrThrow(samples, size, size, { model: 'thinPlateSpline', smoothing: 0, maxControlPoints: 1024 })
		expect(model.controlPoints!.length / 2).toBe(1024)

		const plane = new Float64Array(size * size)
		const started = performance.now()
		evaluateScalarSurfaceInto(model, plane)
		const elapsed = performance.now() - started

		// The exact loop would run for minutes here; the coarse path is seconds at worst.
		expect(elapsed).toBeLessThan(20000)

		// And it still tracks the fitted surface within the materialization's tolerance.
		const point = createScalarSurfacePointEvaluator(model)
		let low = Infinity
		let high = -Infinity
		for (const sample of samples) {
			const value = point.at(sample.x, sample.y)
			low = Math.min(low, value)
			high = Math.max(high, value)
		}

		let worst = 0
		for (let y = 0; y < size; y += 37) {
			for (let x = 0; x < size; x += 37) worst = Math.max(worst, Math.abs(plane[y * size + x] - point.at(x, y)))
		}
		expect(worst).toBeLessThanOrEqual(0.005 * (high - low))
	}, 60000)

	test('a small fitted domain on a large plane stays bounded', () => {
		// The mean-spacing step comes from the fitted domain, so controls packed into a tiny corner give a
		// step of 1 and the refinement loop never runs. Without a floor on the step that drops straight
		// into the per-pixel sweep, which is O(plane * controls) however small the domain is.
		const size = 2048
		const samples: SurfaceSample[] = []
		for (let r = 0; r < 11; r++) {
			for (let c = 0; c < 11; c++) samples.push({ x: 10 + c, y: 10 + r, value: 0.2 + 0.01 * ((r + c) % 3) })
		}

		const model = fitOrThrow(samples, size, size, { model: 'thinPlateSpline', smoothing: 0.05, domain: { x0: 10, y0: 10, x1: 20, y1: 20 } })
		const plane = new Float64Array(size * size)
		evaluateScalarSurfaceInto(model, plane)

		const point = createScalarSurfacePointEvaluator(model)
		let low = Infinity
		let high = -Infinity
		for (const sample of samples) {
			const value = point.at(sample.x, sample.y)
			low = Math.min(low, value)
			high = Math.max(high, value)
		}

		let worst = 0
		for (let y = 0; y < size; y += 13) {
			for (let x = 0; x < size; x += 13) worst = Math.max(worst, Math.abs(plane[y * size + x] - point.at(x, y)))
			for (let x = 0; x < size; x += 13) expect(Number.isFinite(plane[y * size + x])).toBe(true)
		}

		// A per-pixel sweep reproduces direct evaluation exactly, so a nonzero deviation is what shows the
		// bounded grid was used instead. The deviation is not held to the materialization tolerance here:
		// this layout prices a verifying grid out of the work budget, and the bound outranks the tolerance
		// rather than falling back to an unbounded sweep. It still tracks the surface's own scale.
		expect(worst).toBeGreaterThan(0)
		expect(worst).toBeLessThan(high - low)
	}, 60000)

	test('an exact spline under the work budget still interpolates its controls', () => {
		const size = 200
		const field = (x: number, y: number) => 0.3 + 0.15 * Math.sin(3 * (x / size)) * Math.cos(3 * (y / size))
		const samples = sampleGrid(size, size, 10, 10, field)
		const model = fitOrThrow(samples, size, size, { model: 'thinPlateSpline', smoothing: 0 })

		const plane = new Float64Array(size * size)
		evaluateScalarSurfaceInto(model, plane)

		for (const sample of samples) {
			const x = Math.round(sample.x)
			const y = Math.round(sample.y)
			expect(plane[y * size + x]).toBeCloseTo(field(x, y), 3)
		}
	})
	test('strided writes match contiguous writes', () => {
		const model = fitOrThrow(
			sampleGrid(40, 30, 8, 6, (x, y) => 0.2 + 0.003 * x - 0.001 * y),
			40,
			30,
			{ degree: 2 },
		)

		const plane = new Float64Array(40 * 30)
		evaluateScalarSurfaceInto(model, plane)

		const interleaved = new Float64Array(40 * 30 * 3)
		evaluateScalarSurfaceInto(model, interleaved, 1, 3)

		for (let p = 0; p < plane.length; p++) expect(interleaved[p * 3 + 1]).toBe(plane[p])
		for (let p = 0; p < plane.length; p++) expect(interleaved[p * 3]).toBe(0)
	})

	test('a strided spline write matches the contiguous one', () => {
		const model = fitOrThrow(
			sampleGrid(40, 30, 6, 6, (x, y) => 0.2 + 0.002 * x * Math.cos(y / 9)),
			40,
			30,
			{ model: 'thinPlateSpline', smoothing: 0.2 },
		)

		const plane = new Float64Array(40 * 30)
		evaluateScalarSurfaceInto(model, plane)

		const interleaved = new Float64Array(40 * 30 * 2)
		evaluateScalarSurfaceInto(model, interleaved, 1, 2)

		for (let p = 0; p < plane.length; p++) expect(interleaved[p * 2 + 1]).toBe(plane[p])
	})

	test('a shared column table produces identical values', () => {
		const model = fitOrThrow(
			sampleGrid(40, 30, 8, 6, (x, y) => 0.2 + 0.003 * x - 0.001 * y),
			40,
			30,
			{ degree: 2 },
		)

		const without = new Float64Array(40 * 30)
		evaluateScalarSurfaceInto(model, without)

		const table = createSurfaceColumnTable(model.degree, model.domain, 40)
		const shared = new Float64Array(40 * 30)
		evaluateScalarSurfaceInto(model, shared, 0, 1, table)

		expect(Array.from(shared)).toEqual(Array.from(without))
	})

	test('the row evaluator samples arbitrary column positions', () => {
		const field = (x: number, y: number) => 0.1 + 0.002 * x - 0.004 * y
		const model = fitOrThrow(sampleGrid(64, 64, 8, 8, field), 64, 64, { degree: 1 })

		const table = createSurfaceColumnTable(model.degree, model.domain, 5, 3, 12)
		const evaluator = createScalarSurfaceEvaluator(model, table)
		const row = new Float64Array(5)
		evaluator.fillRow(7.5, row, 0, 1)

		for (let i = 0; i < 5; i++) expect(row[i]).toBeCloseTo(field(3 + i * 12, 7.5), 9)
	})

	test('the full-frame domain maps pixel centers onto [-1, 1]', () => {
		const domain = fullSurfaceDomain(64, 48)
		expect(domain).toEqual({ x0: 0, y0: 0, x1: 63, y1: 47 })

		const table = createSurfaceColumnTable(1, domain, 64)
		expect(table.u[0]).toBeCloseTo(-1, 12)
		expect(table.u[63]).toBeCloseTo(1, 12)
		expect(table.u[32]).toBeCloseTo((32 * 2) / 63 - 1, 12)
	})

	test('the point evaluator matches the row evaluator', () => {
		const field = (x: number, y: number) => 0.1 + 0.002 * x - 0.004 * y + 0.00003 * x * y
		const model = fitOrThrow(sampleGrid(64, 64, 8, 8, field), 64, 64, { degree: 2 })

		const table = createSurfaceColumnTable(model.degree, model.domain, 64)
		const evaluator = createScalarSurfaceEvaluator(model, table)
		const point = createScalarSurfacePointEvaluator(model)
		const row = new Float64Array(64)

		for (const y of [0, 13.5, 31, 63]) {
			evaluator.fillRow(y, row, 0, 1)
			for (let x = 0; x < 64; x += 7) expect(point.at(x, y)).toBeCloseTo(row[x], 12)
		}

		// Off-grid positions the row evaluator cannot reach.
		expect(point.at(12.25, 7.75)).toBeCloseTo(field(12.25, 7.75), 8)
	})

	test('the point evaluator honors a restricted domain and the spline model', () => {
		const samples = sampleGrid(64, 64, 6, 6, (x, y) => 0.2 + 0.002 * x * Math.cos(y / 9))
		const domain = { x0: 4, y0: 4, x1: 60, y1: 60 }

		for (const options of [
			{ degree: 2, domain },
			{ model: 'thinPlateSpline', smoothing: 0.2, domain },
		] as const) {
			const model = fitOrThrow(samples, 64, 64, options)
			const table = createSurfaceColumnTable(model.degree, model.domain, 64)
			const evaluator = createScalarSurfaceEvaluator(model, table)
			const point = createScalarSurfacePointEvaluator(model)
			const row = new Float64Array(64)

			evaluator.fillRow(21.5, row, 0, 1)
			for (let x = 0; x < 64; x += 9) expect(point.at(x, 21.5)).toBeCloseTo(row[x], 10)
		}
	})
})
