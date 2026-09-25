import { expect, test } from 'bun:test'
import { buildFocusSurfaceMap, MAX_FOCUS_SURFACE_MAP_CELLS } from '../../../../src/imaging/analysis/aberration/surface'
import { evaluateFocusSurface, fitFocusSurface, type FocusSurfaceCoefficients, type FocusSurfaceFitSuccess, type FocusSurfaceModel, type FocusSurfaceSample } from '../../../../src/math/numerical/surface.fit'

const plane = { c: 100, ax: 10, ay: -20, qxx: 0, qxy: 0, qyy: 0 }

function fit(coefficients: FocusSurfaceCoefficients = plane, model: FocusSurfaceModel = 'plane', noisy: boolean = false): FocusSurfaceFitSuccess {
	const samples: FocusSurfaceSample[] = []
	for (let row = 0; row < 5; row++) {
		for (let column = 0; column < 5; column++) {
			const u = -0.45 + column * 0.2
			const v = -0.4 + row * 0.2
			samples.push({ u, v, focus: evaluateFocusSurface(coefficients, u, v) + (noisy ? 0.1 * Math.sin(row * 5 + column) : 0) })
		}
	}
	const result = fitFocusSurface(samples, { model })
	expect(result.success).toBeTrue()
	if (!result.success) throw new Error(result.reason)
	return result
}

test('samples a plane at row-major cell centers on a non-square even grid', () => {
	const surface = fit()
	const before = structuredClone(surface)
	const map = buildFocusSurfaceMap(surface, { columns: 4, rows: 2 })
	expect(map.cells).toHaveLength(8)
	expect(map.centerFocus).toBeCloseTo(100, 10)
	expect(map.centerFocus).toBe(evaluateFocusSurface(surface.coefficients, 0, 0))
	expect(map.confidence).toBe(surface.confidence)
	for (let i = 0; i < map.cells.length; i++) {
		const cell = map.cells[i]
		expect(cell.column).toBe(i % 4)
		expect(cell.row).toBe(Math.floor(i / 4))
		expect(cell.u).toBe(-0.5 + ((i % 4) + 0.5) / 4)
		expect(cell.v).toBe(-0.5 + (Math.floor(i / 4) + 0.5) / 2)
		expect(cell.focus).toBe(evaluateFocusSurface(surface.coefficients, cell.u, cell.v))
		expect(cell.focus).toBeCloseTo(100 + 10 * cell.u - 20 * cell.v, 10)
		expect(cell.offsetFromCenter).toBeCloseTo(cell.focus - map.centerFocus, 10)
		expect(cell.offsetFromCenter).toBeCloseTo(10 * cell.u - 20 * cell.v, 10)
	}
	expect(surface).toEqual(before)
})

test('preserves center-relative offsets when the absolute focuser zero is large', () => {
	const surface = fit()
	const coefficients = { c: 100, ax: 10, ay: -4, qxx: 3, qxy: 2, qyy: -1 }
	const smallZero = { ...surface, coefficients }
	const largeZero = { ...surface, coefficients: { ...coefficients, c: 1e16 } }
	const smallMap = buildFocusSurfaceMap(smallZero, { columns: 32, rows: 32 })
	const largeMap = buildFocusSurfaceMap(largeZero, { columns: 32, rows: 32 })

	for (let i = 0; i < smallMap.cells.length; i++) {
		const { u, v } = smallMap.cells[i]
		const expected = 10 * u - 4 * v + 3 * u * u + 2 * u * v - v * v
		expect(smallMap.cells[i].offsetFromCenter).toBeCloseTo(expected, 12)
		expect(largeMap.cells[i].offsetFromCenter).toBe(smallMap.cells[i].offsetFromCenter)
	}

	const centerAdjacentCell = largeMap.cells[16 * 32 + 16]
	expect(centerAdjacentCell.u).toBe(0.015625)
	expect(centerAdjacentCell.focus).toBe(largeMap.centerFocus)
	const largePlane = { ...surface, coefficients: { c: 1e16, ax: 10, ay: 0, qxx: 0, qxy: 0, qyy: 0 } }
	const planeMap = buildFocusSurfaceMap(largePlane, { columns: 32, rows: 1 })
	const adjacentColumn = planeMap.cells[16]
	expect(adjacentColumn.focus).toBe(planeMap.centerFocus)
	expect(adjacentColumn.offsetFromCenter).toBe(0.15625)
})

test('samples full quadratic curvature, mixed terms and sampled extrema', () => {
	const coefficients = { c: 100, ax: 10, ay: -20, qxx: 30, qxy: 12, qyy: 40 }
	const surface = fit(coefficients, 'quadratic')
	const map = buildFocusSurfaceMap(surface, { columns: 4, rows: 3 })
	const expected: number[] = []
	for (const cell of map.cells) {
		const u = -0.5 + (cell.column + 0.5) / 4
		const v = -0.5 + (cell.row + 0.5) / 3
		const value = 100 + 10 * u - 20 * v + 30 * u * u + 12 * u * v + 40 * v * v
		expect(cell.u).toBe(u)
		expect(cell.v).toBe(v)
		expect(cell.focus).toBeCloseTo(value, 10)
		expect(cell.offsetFromCenter).toBeCloseTo(value - 100, 10)
		expected.push(value)
	}
	expect(map.centerFocus).toBeCloseTo(100, 10)
	expect(map.minimumFocus).toBeCloseTo(Math.min(...expected), 10)
	expect(map.maximumFocus).toBeCloseTo(Math.max(...expected), 10)
	expect(map.range).toBe(map.maximumFocus - map.minimumFocus)
	expect(map.minimumFocus).toBe(Math.min(...map.cells.map((cell) => cell.focus)))
	expect(map.maximumFocus).toBe(Math.max(...map.cells.map((cell) => cell.focus)))
	const left = map.cells[0]
	const right = map.cells[3]
	expect(right.focus - left.focus).toBeCloseTo(2 * right.u * (10 + 12 * right.v), 10)
})

test('samples equal radial focus at different azimuths', () => {
	const surface = fit({ c: 100, ax: 0, ay: 0, qxx: 24, qxy: 0, qyy: 24 }, 'radialQuadratic')
	const map = buildFocusSurfaceMap(surface, { columns: 3, rows: 3 })
	for (const index of [1, 3, 5, 7]) expect(map.cells[index].focus).toBeCloseTo(100 + 24 / 9, 10)
	for (const index of [0, 2, 6, 8]) expect(map.cells[index].focus).toBeCloseTo(100 + 48 / 9, 10)
	expect(map.cells[4].offsetFromCenter).toBe(0)
})

test.each(['plane', 'radialQuadratic', 'quadratic'] as const)('propagates noisy %s covariance in the model basis', (model) => {
	const surface = fit(plane, model, true)
	const covariance = surface.covariance!
	expect(covariance).toBeDefined()
	const map = buildFocusSurfaceMap(surface, { columns: 5, rows: 3 })
	for (const cell of map.cells) {
		const { u, v } = cell
		const x = model === 'plane' ? [1, u, v] : model === 'radialQuadratic' ? [1, u, v, u * u + v * v] : [1, u, v, u * u, u * v, v * v]
		expect(covariance.length).toBe(x.length ** 2)
		const variance = x.reduce((sum, xi, i) => sum + xi * x.reduce((row, xj, j) => row + covariance[i * x.length + j] * xj, 0), 0)
		expect(Number.isFinite(cell.uncertainty)).toBeTrue()
		expect(cell.uncertainty).toBeGreaterThanOrEqual(0)
		expect(cell.uncertainty).toBeCloseTo(Math.sqrt(Math.max(0, variance)), 12)
	}
	expect(map.cells[7].u).toBe(0)
	expect(map.cells[7].v).toBe(0)
	expect(map.cells[7].uncertainty).toBe(Math.sqrt(covariance[0]))
})

test('leaves uncertainty undefined for a minimal fit and evaluates a 1x1 grid at exact center', () => {
	const surface = fitFocusSurface(
		[
			{ u: -0.5, v: -0.5, focus: 105 },
			{ u: 0.5, v: -0.5, focus: 115 },
			{ u: 0, v: 0.5, focus: 90 },
		],
		{ model: 'plane' },
	)
	expect(surface.success).toBeTrue()
	if (!surface.success) return
	expect(surface.covariance).toBeUndefined()
	const map = buildFocusSurfaceMap(surface, { columns: 1, rows: 1 })
	expect(map.cells).toEqual([{ column: 0, row: 0, u: 0, v: 0, focus: map.centerFocus, offsetFromCenter: 0, uncertainty: undefined }])
	expect(map.minimumFocus).toBe(map.centerFocus)
	expect(map.maximumFocus).toBe(map.centerFocus)
	expect(map.range).toBe(0)
})

test('defaults to 32x32 and permits the maximum cell count', () => {
	const surface = fit()
	const map = buildFocusSurfaceMap(surface)
	expect(map.columns).toBe(32)
	expect(map.rows).toBe(32)
	expect(map.cells).toHaveLength(1024)
	const maximum = buildFocusSurfaceMap(surface, { columns: 256, rows: 256 })
	expect(maximum.cells).toHaveLength(MAX_FOCUS_SURFACE_MAP_CELLS)
	expect(maximum.cells.at(-1)?.column).toBe(255)
	expect(maximum.cells.at(-1)?.row).toBe(255)
	expect(() => buildFocusSurfaceMap(surface, { columns: 257, rows: 256 })).toThrow(RangeError)
	expect(() => buildFocusSurfaceMap(surface, { columns: Number.MAX_VALUE, rows: Number.MAX_VALUE })).toThrow(RangeError)
})

test.each([0, -1, 1.5, Number.NaN, Infinity])('rejects unsafe allocation dimension %p before building cells', (dimension) => {
	const surface = fit()
	expect(() => buildFocusSurfaceMap(surface, { columns: dimension, rows: 1 })).toThrow()
	expect(() => buildFocusSurfaceMap(surface, { columns: 1, rows: dimension })).toThrow()
})

test('keeps large finite focus predictions, offsets and summaries finite', () => {
	const surface = fit()
	const coefficients = { c: 1e150, ax: 1e149, ay: -2e149, qxx: 3e149, qxy: 1e149, qyy: 4e149 }
	const map = buildFocusSurfaceMap({ ...surface, model: 'quadratic', coefficients, covariance: undefined }, { columns: 4, rows: 3 })
	for (const cell of map.cells) {
		expect(Number.isFinite(cell.focus)).toBeTrue()
		expect(Number.isFinite(cell.offsetFromCenter)).toBeTrue()
		expect(cell.focus).toBe(evaluateFocusSurface(coefficients, cell.u, cell.v))
	}
	for (const value of [map.centerFocus, map.minimumFocus, map.maximumFocus, map.range]) expect(Number.isFinite(value)).toBeTrue()
})
