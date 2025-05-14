// For data blocks structured as contiguous sequences of 16-bit or larger integer
// or floating point numbers, a reversible byte shuffling routine can greatly improve
// compression ratios by increasing data locality, i.e. by redistributing the
// sequence such that similar byte values tend to be placed close together.

export function byteShuffle(input: Int8Array | Uint8Array, output: Int8Array | Uint8Array, itemSize: number) {
	const inputSize = input.byteLength
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[s++] = input[u]
			u += itemSize
		}

		if (copyLength > 0) {
			const begin = numberOfItems * itemSize
			output.set(input.subarray(begin, begin + copyLength), s)
		}
	}
}

export function byteUnshuffle(input: Int8Array | Uint8Array, output: Int8Array | Uint8Array, itemSize: number) {
	const inputSize = input.byteLength
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[u] = input[s++]
			u += itemSize
		}

		if (copyLength > 0) {
			const offset = numberOfItems * itemSize
			output.set(input.subarray(s, s + copyLength), offset)
		}
	}
}
