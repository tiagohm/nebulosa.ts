// Static, implicit k-d tree for fixed-radius searches over small-dimensional points (quad codes, unit vectors).
// The tree is balanced by count: the node covering positions [lo, hi) splits at mid = lo + floor((hi - lo) / 2)
// along its widest axis, and the children of node k are 2k + 1 and 2k + 2, so no pointers or split values are
// stored, only the bounding box of every node. Points are permuted into leaf order on build, and indices maps a
// tree position back to the caller's point index. The storage type of the points (float or unsigned 16-bit
// quantized codes) is kept for the boxes, so a tree can be written to and read from a flat file unchanged.
// Building copies the points once; a search allocates only a traversal stack of 4·(levels + 1) integers.

// Typed arrays a tree can store its points and boxes in.
export type KdTreeArray = Float64Array | Float32Array | Uint16Array

// Default maximum number of points in a leaf.
export const DEFAULT_KD_TREE_LEAF_SIZE = 16

// A built tree. Every array is flat: point p occupies [p·dimension, (p + 1)·dimension), node k's box the same
// span of lower and upper.
export interface KdTree<T extends KdTreeArray = KdTreeArray> {
	// Coordinates per point, at least 1.
	readonly dimension: number
	// Number of points.
	readonly count: number
	// Number of node levels, at least 1; the leaves are the last level.
	readonly levels: number
	// Points in tree order.
	readonly points: T
	// Caller's point index of each tree position.
	readonly indices: Uint32Array
	// Lower corner of each node's bounding box.
	readonly lower: T
	// Upper corner of each node's bounding box.
	readonly upper: T
}

// Number of levels for count points with at most leafSize points per leaf.
export function kdTreeLevels(count: number, leafSize: number) {
	let levels = 1
	while (Math.ceil(count / 2 ** (levels - 1)) > leafSize) levels++
	return levels
}

// Builds a tree over count = points.length / dimension points. points is not mutated.
export function buildKdTree<T extends KdTreeArray>(points: T, dimension: number, leafSize: number = DEFAULT_KD_TREE_LEAF_SIZE): KdTree<T> {
	const count = Math.floor(points.length / dimension)
	const levels = kdTreeLevels(count, leafSize)
	const nodeCount = 2 ** levels - 1
	const data = points.slice(0, count * dimension) as T
	const indices = new Uint32Array(count)
	for (let i = 0; i < count; i++) indices[i] = i
	const lower = new (data.constructor as new (length: number) => T)(nodeCount * dimension)
	const upper = new (data.constructor as new (length: number) => T)(nodeCount * dimension)
	const tree: KdTree<T> = { dimension, count, levels, points: data, indices, lower, upper }
	if (count > 0) buildNode(tree, 0, 0, count, 0)
	return tree
}

// Computes the box of a node and recursively partitions its points.
function buildNode<T extends KdTreeArray>(tree: KdTree<T>, node: number, lo: number, hi: number, level: number) {
	const { dimension, points, lower, upper } = tree
	const box = node * dimension
	let axis = 0
	let widest = -1

	for (let d = 0; d < dimension; d++) {
		let min = Infinity
		let max = -Infinity

		for (let p = lo; p < hi; p++) {
			const value = points[p * dimension + d]
			if (value < min) min = value
			if (value > max) max = value
		}

		lower[box + d] = min
		upper[box + d] = max

		if (max - min > widest) {
			widest = max - min
			axis = d
		}
	}

	if (level === tree.levels - 1) return

	const mid = lo + ((hi - lo) >> 1)
	if (hi - lo > 1) selectNth(tree, lo, hi, mid, axis)
	buildNode(tree, 2 * node + 1, lo, mid, level + 1)
	buildNode(tree, 2 * node + 2, mid, hi, level + 1)
}

// Rearranges positions [lo, hi) so that position nth holds the value that would be there if sorted along axis,
// with no smaller value after it and no larger value before it (quickselect with median-of-three pivots).
function selectNth(tree: KdTree, lo: number, hi: number, nth: number, axis: number) {
	const { dimension, points } = tree
	let left = lo
	let right = hi - 1

	while (right > left) {
		const middle = left + ((right - left) >> 1)
		const a = points[left * dimension + axis]
		const b = points[middle * dimension + axis]
		const c = points[right * dimension + axis]
		const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b
		let i = left
		let j = right

		while (i <= j) {
			while (points[i * dimension + axis] < pivot) i++
			while (points[j * dimension + axis] > pivot) j--

			if (i <= j) {
				swapPoints(tree, i, j)
				i++
				j--
			}
		}

		if (nth <= j) right = j
		else if (nth >= i) left = i
		else return
	}
}

// Swaps two tree positions with their indices.
function swapPoints(tree: KdTree, i: number, j: number) {
	if (i === j) return
	const { dimension, points, indices } = tree
	const pi = i * dimension
	const pj = j * dimension

	for (let d = 0; d < dimension; d++) {
		const value = points[pi + d]
		points[pi + d] = points[pj + d]
		points[pj + d] = value
	}

	const index = indices[i]
	indices[i] = indices[j]
	indices[j] = index
}

// Visits every point whose Euclidean distance to query is at most radius, in the tree's coordinate units.
// visit receives the tree position (pass it to tree.indices for the caller's index) and the squared distance;
// it may search other trees.
export function searchKdTree(tree: KdTree, query: ArrayLike<number>, radius: number, visit: (position: number, distanceSq: number) => void) {
	if (tree.count === 0) return

	const { dimension, points, lower, upper, levels } = tree
	const radiusSq = radius * radius
	// Depth-first traversal keeps at most one pending sibling per level, as (node, lo, hi, level) quadruples.
	const stack = new Int32Array(4 * (levels + 1))
	let top = 0
	stack[top++] = 0
	stack[top++] = 0
	stack[top++] = tree.count
	stack[top++] = 0

	while (top > 0) {
		const level = stack[--top]
		const hi = stack[--top]
		const lo = stack[--top]
		const node = stack[--top]
		const box = node * dimension
		let boxDistanceSq = 0

		for (let d = 0; d < dimension && boxDistanceSq <= radiusSq; d++) {
			const value = query[d]
			const min = lower[box + d]
			const max = upper[box + d]
			const delta = value < min ? min - value : value > max ? value - max : 0
			boxDistanceSq += delta * delta
		}

		if (boxDistanceSq > radiusSq) continue

		if (level === levels - 1) {
			for (let p = lo; p < hi; p++) {
				const offset = p * dimension
				let distanceSq = 0

				for (let d = 0; d < dimension && distanceSq <= radiusSq; d++) {
					const delta = points[offset + d] - query[d]
					distanceSq += delta * delta
				}

				if (distanceSq <= radiusSq) visit(p, distanceSq)
			}

			continue
		}

		const mid = lo + ((hi - lo) >> 1)
		stack[top++] = 2 * node + 2
		stack[top++] = mid
		stack[top++] = hi
		stack[top++] = level + 1
		stack[top++] = 2 * node + 1
		stack[top++] = lo
		stack[top++] = mid
		stack[top++] = level + 1
	}
}
