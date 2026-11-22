import { expect, test } from 'bun:test'
import { buildKdTree, kdTreeLevels, searchKdTree } from '../../../src/astrometry/solvers/quad.kdtree'
import { mulberry32 } from '../../../src/math/numerical/random'

function bruteForce(points: ArrayLike<number>, dimension: number, query: ArrayLike<number>, radius: number) {
	const found: number[] = []

	for (let p = 0; p * dimension < points.length; p++) {
		let distanceSq = 0
		for (let d = 0; d < dimension; d++) distanceSq += (points[p * dimension + d] - query[d]) ** 2
		if (distanceSq <= radius * radius) found.push(p)
	}

	return found
}

function search(tree: ReturnType<typeof buildKdTree>, query: ArrayLike<number>, radius: number) {
	const found: number[] = []
	searchKdTree(tree, query, radius, (position) => found.push(tree.indices[position]))
	return found.sort((a, b) => a - b)
}

test('levels keep every leaf within the leaf size', () => {
	expect(kdTreeLevels(0, 16)).toBe(1)
	expect(kdTreeLevels(16, 16)).toBe(1)
	expect(kdTreeLevels(17, 16)).toBe(2)
	expect(kdTreeLevels(1000, 16)).toBe(7)
})

test('ball search equals brute force in 4D', () => {
	const random = mulberry32(42)
	const dimension = 4
	const points = new Float64Array(20000 * dimension)
	for (let i = 0; i < points.length; i++) points[i] = random()
	const tree = buildKdTree(points, dimension, 8)

	for (let k = 0; k < 200; k++) {
		const query = [random(), random(), random(), random()]
		const radius = k === 0 ? 0 : random() * 0.1
		expect(search(tree, query, radius)).toEqual(bruteForce(points, dimension, query, radius))
	}

	// A point is found at radius zero.
	expect(search(tree, points.subarray(40, 44), 0)).toContain(10)
})

test('quantized 16-bit points and duplicates are searched exactly', () => {
	const random = mulberry32(3)
	const points = new Uint16Array(3000 * 4)
	for (let i = 0; i < points.length; i++) points[i] = Math.floor(random() * 64) * 1024
	const tree = buildKdTree(points, 4, 16)

	for (let k = 0; k < 100; k++) {
		const query = [random() * 65535, random() * 65535, random() * 65535, random() * 65535]
		expect(search(tree, query, 20000)).toEqual(bruteForce(points, 4, query, 20000))
	}
})

test('an empty tree finds nothing', () => {
	const tree = buildKdTree(new Float64Array(0), 3)
	expect(search(tree, [0, 0, 0], 1)).toEqual([])
})
