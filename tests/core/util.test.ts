import { expect, test } from 'bun:test'
import { binarySearch, binarySearchWithComparator, geometricMedian, isNumberArray, maxOf, meanOf, medianAbsoluteDeviationOf, medianBySelectionOf, medianOf, minOf, NumberComparator, NumberComparatorDescending, percentileOf, quickSelect, rmsOf, standardDeviationOf } from '../../src/core/util'

test('is number array', () => {
	expect(isNumberArray([1, 2, 3])).toBeTrue()
	// expect(isNumberArray([1, '2'])).toBeFalse()
	expect(isNumberArray(new Float64Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int8Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint8Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint8ClampedArray([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Float32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Float16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new BigInt64Array([1n, 2n, 3n]))).toBeFalse()
	expect(isNumberArray(new DataView(new ArrayBuffer(8)))).toBeFalse()
	expect(isNumberArray([])).toBeTrue()
	expect(isNumberArray(['1'])).toBeFalse()
	expect(isNumberArray(new ArrayBuffer(8))).toBeFalse()
	expect(isNumberArray('[1, 2, 3]')).toBeFalse()
	expect(isNumberArray({})).toBeFalse()
	expect(isNumberArray(null)).toBeFalse()
	expect(isNumberArray(undefined)).toBeFalse()
	expect(isNumberArray(123)).toBeFalse()
	expect(isNumberArray(true)).toBeFalse()
})

test('min of', () => {
	expect(minOf([1, 2, 3])).toEqual([1, 0])
	expect(minOf([3, 2, 1])).toEqual([1, 2])
	expect(minOf([2, 3, 1])).toEqual([1, 2])
	expect(minOf([1])).toEqual([1, 0])
	expect(minOf([])).toEqual([Number.NaN, -1])
	expect(minOf([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])).toEqual([Number.POSITIVE_INFINITY, 0])
	expect(minOf([Number.NaN, Number.NaN, Number.NaN])).toEqual([Number.NaN, -1])
	expect(minOf([1, 2, Number.NaN])).toEqual([1, 0])
	expect(minOf([Number.NaN, 2, 1])).toEqual([1, 2])
})

test('max of', () => {
	expect(maxOf([1, 2, 3])).toEqual([3, 2])
	expect(maxOf([3, 2, 1])).toEqual([3, 0])
	expect(maxOf([2, 3, 1])).toEqual([3, 1])
	expect(maxOf([-3, -2, -7])).toEqual([-2, 1])
	expect(maxOf([1])).toEqual([1, 0])
	expect(maxOf([])).toEqual([Number.NaN, -1])
	expect(maxOf([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([Number.NEGATIVE_INFINITY, 0])
	expect(maxOf([Number.NaN, Number.NaN, Number.NaN])).toEqual([Number.NaN, -1])
	expect(maxOf([1, 2, Number.NaN])).toEqual([2, 1])
	expect(maxOf([Number.NaN, 2, 1])).toEqual([2, 1])
})

test('mean of', () => {
	expect(meanOf([1, 2, 3])).toBe(2)
	expect(meanOf([3, 2, 1])).toBe(2)
	expect(meanOf([2, 3, 1])).toBe(2)
	expect(meanOf([1, 2, 3, 4])).toBe(2.5)
	expect(meanOf([1])).toBe(1)
	expect(meanOf([])).toBeNaN()
	// Compensated summation recovers the small terms that naive summation drops.
	expect(meanOf([1e16, 1, -1e16, 1])).toBe(0.5)
})

test('rms of', () => {
	expect(rmsOf([3, 4])).toBeCloseTo(Math.sqrt(12.5), 12)
	expect(rmsOf([5])).toBe(5)
	// Empty input is NaN, consistent with the other reducers.
	expect(rmsOf([])).toBeNaN()
})

test('descending comparator is the reverse of the ascending comparator', () => {
	for (const [a, b] of [
		[1, 2],
		[2, 1],
		[3, 3],
	] as const) {
		// Descending order is the ascending comparator with swapped arguments.
		expect(Math.sign(NumberComparatorDescending(a, b))).toBe(Math.sign(NumberComparator(b, a)))
	}
})

test('median of', () => {
	expect(medianOf([1])).toBe(1)
	expect(medianOf([1, 2])).toBe(1.5)
	expect(medianOf([1, 2, 3])).toBe(2)
	expect(medianOf([-3, -2, -1])).toBe(-2)
	expect(medianOf([-1, 0, 1])).toBe(0)
	expect(medianOf([-2, -1, 1, 2])).toBe(0)
	expect(medianOf([1, 2, 3, 4])).toBe(2.5)
	expect(medianOf([1, 2, 100, 200], 2)).toBe(1.5)
	expect(medianOf([])).toBeNaN()
})

test('median absolute deviation of', () => {
	expect(medianAbsoluteDeviationOf([1, 1, 2, 2, 4, 6, 9], 2, false)).toBe(1)
	expect(medianAbsoluteDeviationOf([9, 6, 4, 2, 2, 1, 1], 2, false)).toBe(1)
})

test('quick select', () => {
	const values = new Float64Array([7, 2, 5, 2, 9, 1, Number.NaN, 100])
	expect(quickSelect(values, 7, 3)).toBe(5)
	expect(values[7]).toBe(100)
	for (let index = 0; index < 3; index++) expect(values[index]).toBeLessThanOrEqual(5)
	for (let index = 4; index < 7; index++) expect(Number.isNaN(values[index]) || values[index] >= 5).toBeTrue()
	expect(quickSelect(values, 7, 6)).toBeNaN()
	expect(() => quickSelect(values, 0, 0)).toThrow(RangeError)
	expect(() => quickSelect(values, 7, 7)).toThrow(RangeError)
})

test('median by selection of', () => {
	expect(medianBySelectionOf(new Float64Array([9, 1, 5]))).toBe(5)
	expect(medianBySelectionOf(new Float64Array([9, 1, 5, 3]))).toBe(4)
	expect(medianBySelectionOf(new Float64Array([9, 1, 100]), 2)).toBe(5)
	expect(medianBySelectionOf(new Float64Array([1, Number.NaN]))).toBeNaN()
	expect(medianBySelectionOf([])).toBeNaN()
	expect(medianBySelectionOf([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE)
	expect(medianBySelectionOf([-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(0)
	expect(medianBySelectionOf([0, 0, 0, 0.2000000763614068, 0, 0, 0])).toBe(0)
})

test('geometric median handles empty, singleton and two-point populations', () => {
	expect(geometricMedian([], [])).toBeUndefined()
	expect(geometricMedian([2], [-3])).toEqual({ x: 2, y: -3 })
	expect(geometricMedian([2, 4], [8, 10])).toEqual({ x: 3, y: 9 })
	expect(geometricMedian([2, 2, 2], [-3, -3, -3])).toEqual({ x: 2, y: -3 })
	expect(geometricMedian([3, 1, 2], [9, 3, 6])).toEqual({ x: 2, y: 6 })
	expect(geometricMedian([-3, 3, -3, 3], [0, 0, 0, 0])).toEqual({ x: 0, y: 0 })
})

test('geometric median preserves readonly arrays, typed buffers, prefixes and earlier results', () => {
	const x = Object.freeze([2, 0, 2, 0, 0, Number.NaN])
	const y = new Float64Array([0, 2, 0, 2, 0, Number.NaN])
	const before = y.slice()
	const result = geometricMedian(x, y, 5)
	expect(result).toBeDefined()
	const saved = { ...result! }
	expect(geometricMedian(new Uint16Array([1, 2, 3]), new Float32Array([4, 5, 6]))).toEqual({ x: 2, y: 5 })
	expect(new Uint8Array(y.buffer)).toEqual(new Uint8Array(before.buffer))
	expect(result).toEqual(saved)
	expect(geometricMedian(x, y, 5)).not.toBe(result)
	expect(geometricMedian(x, y, 0)).toBeUndefined()
	expect(() => geometricMedian([1, 2], [3])).toThrow(RangeError)
	expect(() => geometricMedian([1], [2], 2 ** 32)).toThrow(RangeError)
})

for (const scale of [1e-300, 1, 1e300]) {
	for (const angle of [0, 0.3, 1.8, 4.2]) {
		test(`geometric median preserves an analytic solution at scale ${scale} and rotation ${angle}`, () => {
			// For [(0,0), (2,0) twice, (0,2) twice], symmetry and the distance derivative give
			// median (t,t), t=1-1/sqrt(15). The origin is a coincident but nonoptimal initializer.
			const c = Math.cos(angle)
			const s = Math.sin(angle)
			const points = [
				[0, 0],
				[2, 0],
				[2, 0],
				[0, 2],
				[0, 2],
			]
			const x = points.map(([x, y]) => scale * (x * c - y * s))
			const y = points.map(([x, y]) => scale * (x * s + y * c))
			const result = geometricMedian(x, y)
			const reversed = geometricMedian(x.toReversed(), y.toReversed())
			expect(result).toBeDefined()
			expect(reversed).toBeDefined()
			const t = 1 - 1 / Math.sqrt(15)
			expect(result!.x / scale).toBeCloseTo(t * (c - s), 7)
			expect(result!.y / scale).toBeCloseTo(t * (s + c), 7)
			expect(reversed!.x / scale).toBeCloseTo(result!.x / scale, 7)
			expect(reversed!.y / scale).toBeCloseTo(result!.y / scale, 7)
		})
	}
}

test('geometric median preserves small separations at a large coordinate origin', () => {
	const origin = 1e12
	const scale = 0.125
	const result = geometricMedian([origin, origin + 2 * scale, origin + 2 * scale, origin, origin], [-origin, -origin, -origin, -origin + 2 * scale, -origin + 2 * scale])
	expect(result).toBeDefined()
	const delta = scale * (1 - 1 / Math.sqrt(15))
	// Output coordinates round at the translated origin, regardless of the internal local precision.
	expect(Math.abs(result!.x - (origin + delta))).toBeLessThanOrEqual(origin * Number.EPSILON)
	expect(Math.abs(result!.y - (-origin + delta))).toBeLessThanOrEqual(origin * Number.EPSILON)
})

test('geometric median handles subnormal coordinate units without reciprocal overflow', () => {
	const unit = Number.MIN_VALUE
	expect(geometricMedian([0, unit, 2 * unit], [0, unit, 2 * unit])).toEqual({ x: unit, y: unit })
})

test('geometric median declines normalized separations below representable resolution', () => {
	expect(geometricMedian([-1e-300, -1e-300, 1e-300, 1e-300, 1e300], [-1e-300, 1e-300, -1e-300, 1e-300, 0])).toBeUndefined()
})

test('geometric median has no collimation frame-count limit', () => {
	const x = new Float64Array(4096)
	const y = new Float64Array(4096)
	for (let i = 0; i < x.length; i++) {
		const theta = (2 * Math.PI * i) / x.length
		x[i] = 3 + 100 * Math.cos(theta)
		y[i] = -2 + 100 * Math.sin(theta)
	}
	const result = geometricMedian(x, y)
	expect(result).toBeDefined()
	expect(result!.x).toBeCloseTo(3, 8)
	expect(result!.y).toBeCloseTo(-2, 8)
})

for (const outlier of [1e13, 1e20, 1e308]) {
	test(`geometric median preserves a resolved cluster beside an outlier at ${outlier}`, () => {
		const result = geometricMedian([-1, -1, 1, 1, outlier], [-1, 1, -1, 1, 0])
		expect(result).toBeDefined()
		// Symmetry fixes y=0. The distant point contributes derivative -1, so the unique x
		// minimizes 2*hypot(x-1,1) + 2*hypot(x+1,1) - x, independently of outlier distance.
		let left = 0
		let right = 1
		for (let i = 0; i < 60; i++) {
			const mid = (left + right) / 2
			const derivative = (2 * (mid - 1)) / Math.hypot(mid - 1, 1) + (2 * (mid + 1)) / Math.hypot(mid + 1, 1) - 1
			if (derivative > 0) right = mid
			else left = mid
		}
		expect(result!.x).toBeCloseTo((left + right) / 2, 7)
		expect(result!.y).toBeCloseTo(0, 12)
	})
}

test('geometric median handles finite coordinates whose centered differences overflow', () => {
	const m = Number.MAX_VALUE
	const result = geometricMedian([-m, m, m, m, m], [-m, -m, m, m, m])
	expect(result).toEqual({ x: m, y: m })
})

test('geometric median restores a smooth solution between opposite finite extremes', () => {
	const m = Number.MAX_VALUE
	const result = geometricMedian([-m, -m, m, m, m], [-m, m, -m, m, 0])
	expect(result).toBeDefined()
	const t = result!.x / m
	expect(t).toBeGreaterThan(0)
	expect(t).toBeLessThan(1)
	expect(result!.y / m).toBeCloseTo(0, 12)
	// The same symmetric square objective has a unique root in (0,1); check its derivative
	// directly in scaled coordinates so the assertion itself does not overflow.
	expect((2 * (t - 1)) / Math.hypot(t - 1, 1) + (2 * (t + 1)) / Math.hypot(t + 1, 1) - 1).toBeCloseTo(0, 8)
})

for (const points of [
	[
		[1.1082694437354803, -0.8598943082615733],
		[1.3708127960562706, 1.1136274551972747],
		[1.6841341350227594, 0.31537065003067255],
		[-0.7244858033955097, 0.21237498056143522],
		[0.40879091434180737, -0.3590333117172122],
		[1.021085798740387, -0.21657976601272821],
	],
	[
		[-0.9082497209310532, 0.0014438478252850474],
		[1.264824928715825, 0.00414685650030151],
		[-0.5292623601853848, -0.003714539215434343],
		[-0.41075644828379154, -0.003582019216846675],
		[0.7295032069087029, 0.0031743789999745787],
		[-1.7737550344318151, 0.0033639606856741013],
		[-0.3915994353592396, 0.004735326382797211],
		[0.6032021027058363, 0.004810695808846504],
	],
]) {
	test(`geometric median converges for ${points.length} nearly singular or nearly coincident offsets`, () => {
		const result = geometricMedian(
			points.map(([x]) => x),
			points.map(([, y]) => y),
		)
		if (!result) throw new Error('geometric median did not converge')
		let gx = 0
		let gy = 0
		let coincident = 0
		for (const [x, y] of points) {
			const dx = x - result.x
			const dy = y - result.y
			const distance = Math.hypot(dx, dy)
			if (distance < 1e-10) coincident++
			else {
				gx += dx / distance
				gy += dy / distance
			}
		}
		// The convex sum of distances is minimized exactly when the noncoincident gradient lies
		// inside the ball contributed by coincident points; this checks the objective independently.
		expect(Math.hypot(gx, gy)).toBeLessThanOrEqual(coincident + 1e-7)
	})
}

test('standard deviation of', () => {
	expect(standardDeviationOf(new Float64Array([2, 2, 2, 2]))).toBe(0)
	expect(standardDeviationOf(new Float64Array([2, 4, 4, 4, 5, 5, 7, 9]))).toBe(2)
	expect(standardDeviationOf(new Float64Array([1e12 + 1, 1e12 + 2, 1e12 + 3]))).toBeCloseTo(Math.sqrt(2 / 3), 12)
	expect(standardDeviationOf(new Float64Array())).toBeNaN()
	expect(standardDeviationOf([1e308, 1e308])).toBe(0)
	expect(standardDeviationOf(Array.from({ length: 1000 }, (e, i) => (i % 2 === 0 ? 1e15 : 1e15 + 1)))).toBe(0.5)
})

test('percentile of', () => {
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0)).toBe(10)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0.25)).toBe(17.5)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0.5)).toBe(25)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 1)).toBe(40)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), -1)).toBe(10)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 2)).toBe(40)
	expect(percentileOf(new Float64Array(), 0.5)).toBeNaN()
})

test('binary search', () => {
	expect(binarySearch([0, 1, 2, 3, 4], 3)).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 2, to: 5 })).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 0, to: 3 })).toBe(-4)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 0, to: 3, positive: true })).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], -1, { positive: true })).toBe(0)
	expect(binarySearch([0, 1, 2, 3, 4], 5, { positive: true })).toBe(5)
	expect(binarySearch([0, 1, 2, 3, 4], -1)).toBe(-1)
	expect(binarySearch([0, 1, 2, 3, 4], 5)).toBe(-6)
	expect(binarySearch([0, 1, 2, 3, 4], 0.5)).toBe(-2)
	expect(binarySearch([0, 1, 2, 3, 4], 0.5, { positive: true })).toBe(1)
	expect(binarySearch([Number.NaN, Number.NaN, Number.NaN], 3)).toBe(-1)
})

test('binary search with comparator', () => {
	// oxlint-disable-next-line unicorn/consistent-function-scoping
	function comparator(key: number) {
		return (a: number) => a - key
	}

	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3))).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 2, to: 5 })).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 0, to: 3 })).toBe(-4)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 0, to: 3, positive: true })).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(-1), { positive: true })).toBe(0)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(5), { positive: true })).toBe(5)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(-1))).toBe(-1)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(5))).toBe(-6)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(0.5))).toBe(-2)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(0.5), { positive: true })).toBe(1)
	expect(binarySearchWithComparator([Number.NaN, Number.NaN], () => Number.NaN)).toBe(-1)
})

test('number comparator', () => {
	expect([3, 1, 2].sort(NumberComparator)).toEqual([1, 2, 3])
	expect([3, 1, 2].sort(NumberComparatorDescending)).toEqual([3, 2, 1])
	expect([3n, 1n, 2n].sort(NumberComparator)).toEqual([1n, 2n, 3n])
	expect([3n, 1n, 2n].sort(NumberComparatorDescending)).toEqual([3n, 2n, 1n])
})
