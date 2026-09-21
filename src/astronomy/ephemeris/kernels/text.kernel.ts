import { type Source, readLines } from '../../../io/io'

// Parser and in-memory pool for NAIF text kernels (`KPL/PCK` and `KPL/FK`).
// Reads `\begindata` assignments as an ordered list of `=` replace and `+=` append
// operations so the pool can apply them against values already loaded from earlier
// files. Values are numbers (Fortran `D` exponents included) or quoted strings;
// `@` calendar dates are rejected. The pool is an explicit instance so load order
// stays testable and is never process-global.

// A scalar stored by a text-kernel assignment: a number, or an unquoted string.
export type SpiceKernelValue = number | string

// Values of one kernel variable. Scalars are stored as a one-element array.
export type SpiceKernelValues = readonly SpiceKernelValue[]

// One `=` or `+=` assignment from a text kernel, in file order.
export interface SpiceKernelAssignment {
	// Kernel variable name, stored uppercased.
	readonly name: string
	// True when the operator was `+=` (append to the pool); false for `=`.
	readonly append: boolean
	// Values of this assignment, in listed order.
	readonly values: SpiceKernelValues
}

// Byte size of each readLines block when scanning a text kernel.
const TEXT_KERNEL_CHUNK = 4096

// Loads assignments from a `KPL/PCK` or `KPL/FK` text kernel.
// The first line must identify the file type. Names are stored uppercased.
// `=` and `+=` are preserved as ordered operations; the pool applies them.
export async function readTextKernel(source: Source): Promise<SpiceKernelAssignment[]> {
	const assignments: SpiceKernelAssignment[] = []
	const tokens = tokenizeTextKernel(source)

	while (true) {
		const nameToken = await tokens.next()
		if (nameToken.done) break

		const name = nameToken.value
		if (!isKernelName(name)) {
			throw new Error(`a kernel variable name is expected, got ${formatToken(name)}`)
		}

		const equalsToken = await tokens.next()
		if (equalsToken.done || (equalsToken.value !== '=' && equalsToken.value !== '+=')) {
			throw new Error(`an equals sign is expected after ${name}`)
		}

		const first = await tokens.next()
		if (first.done) {
			throw new Error(`a value is expected after ${name}`)
		}

		let items: SpiceKernelValue[]

		if (first.value === '(') {
			items = []

			while (true) {
				const item = await tokens.next()
				if (item.done) throw new Error('unterminated list in text kernel')
				if (item.value === ')') break
				items.push(evaluateKernelToken(item.value))
			}
		} else {
			items = [evaluateKernelToken(first.value)]
		}

		assignments.push({
			name: name.toUpperCase(),
			append: equalsToken.value === '+=',
			values: items,
		})
	}

	return assignments
}

// Stateful set of loaded text-kernel assignments. `=` replaces a name in the pool;
// `+=` appends to whatever that name already holds, including values from earlier files.
export class SpiceKernelPool {
	readonly #values = new Map<string, SpiceKernelValue[]>()

	// Applies `values` to the pool. An assignment list preserves `=` / `+=`.
	// A Map is treated as direct assignments (`=`) that replace existing names.
	load(values: readonly SpiceKernelAssignment[] | ReadonlyMap<string, SpiceKernelValues>): void {
		if (isAssignmentList(values)) {
			for (const assignment of values) this.#assign(assignment.name, assignment.values, assignment.append)
			return
		}

		for (const [name, items] of values) {
			this.#assign(name, items, false)
		}
	}

	// Replaces or appends `items` for `name`. The stored array is a copy of the input.
	#assign(name: string, items: SpiceKernelValues, append: boolean) {
		const key = name.toUpperCase()

		if (append) {
			const previous = this.#values.get(key)
			if (previous) previous.push(...items)
			else this.#values.set(key, items.slice())
		} else {
			this.#values.set(key, items.slice())
		}
	}

	// Returns the values for `name`, or undefined when the name has not been loaded.
	get(name: string): SpiceKernelValues | undefined {
		return this.#values.get(name.toUpperCase())
	}

	// Numeric values of `name` in assignment order, or undefined when the name is absent.
	numbers(name: string): readonly number[] | undefined {
		const values = this.get(name)
		if (values === undefined) return undefined

		const numbers: number[] = []
		for (const value of values) {
			if (typeof value === 'number') numbers.push(value)
		}

		return numbers
	}

	// String values of `name` in assignment order, or undefined when the name is absent.
	strings(name: string): readonly string[] | undefined {
		const values = this.get(name)
		if (values === undefined) return undefined

		const strings: string[] = []
		for (const value of values) {
			if (typeof value === 'string') strings.push(value)
		}

		return strings
	}
}

// Returns true when `values` is an ordered assignment list rather than a name-to-values Map.
function isAssignmentList(values: unknown): values is readonly SpiceKernelAssignment[] {
	return Array.isArray(values)
}

// Yields assignment tokens from every `\begindata` section of a text kernel.
async function* tokenizeTextKernel(source: Source): AsyncGenerator<string> {
	let first = true
	let inData = false

	for await (const raw of readLines(source, TEXT_KERNEL_CHUNK, { encoding: 'ascii', emptyLines: false })) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
		const trimmed = trimKernelLine(line)

		if (first) {
			first = false
			if (!trimmed.startsWith('KPL/PCK') && !trimmed.startsWith('KPL/FK')) throw new Error('text kernel must start with KPL/PCK or KPL/FK')
			continue
		}

		if (!inData) {
			if (trimmed === '\\begindata') inData = true
			continue
		}

		if (trimmed === '\\begintext') {
			inData = false
			continue
		}

		yield* tokenizeKernelLine(line)
	}
}

// Splits one data-section line into names, `=`/`+=`, parentheses, quoted strings, and value tokens.
function* tokenizeKernelLine(line: string): Generator<string> {
	const length = line.length
	let i = 0

	while (i < length) {
		while (i < length && isKernelSeparator(line.charCodeAt(i))) i++

		if (i >= length) break

		const c = line.charCodeAt(i)

		if (c === 43 && line.charCodeAt(i + 1) === 61) {
			yield '+='
			i += 2
			continue
		}

		if (c === 61) {
			yield '='
			i++
			continue
		}

		if (c === 40) {
			yield '('
			i++
			continue
		}

		if (c === 41) {
			yield ')'
			i++
			continue
		}

		if (c === 39) {
			const start = i
			i++
			while (i < length && line.charCodeAt(i) !== 39) i++
			if (i >= length) throw new Error('unterminated string in text kernel')
			i++
			yield line.slice(start, i)
			continue
		}

		const start = i++
		while (i < length && !isKernelPunctuation(line.charCodeAt(i))) i++
		yield line.slice(start, i)
	}
}

// Converts a value token into a number or an unquoted string.
function evaluateKernelToken(token: string): SpiceKernelValue {
	if (token.charCodeAt(0) === 39) return token.slice(1, -1)
	if (token.charCodeAt(0) === 64) throw new Error('@ dates are not supported')

	const value = Number(token.replaceAll(/[Dd]/g, 'E'))
	if (Number.isNaN(value)) throw new Error(`invalid text kernel value: ${token}`)
	return value
}

// True when `token` is a SPICE kernel variable name (letter, then letters/digits/_/$/-).
function isKernelName(token: string) {
	if (token.length === 0) return false

	const first = token.charCodeAt(0)
	if (!isKernelNameStart(first)) return false

	for (let i = 1; i < token.length; i++) {
		if (!isKernelNameChar(token.charCodeAt(i))) return false
	}

	return true
}

// True for ASCII letters that may start a kernel name.
function isKernelNameStart(c: number) {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

// True for characters allowed after the first letter of a kernel name.
function isKernelNameChar(c: number) {
	return isKernelNameStart(c) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c === 45
}

// True for whitespace or comma between tokens.
function isKernelSeparator(c: number) {
	return c === 32 || c === 9 || c === 13 || c === 44
}

// True for characters that end a name or number token.
function isKernelPunctuation(c: number) {
	return isKernelSeparator(c) || c === 61 || c === 40 || c === 41
}

// Trims ASCII space and tab from both ends of a kernel line.
function trimKernelLine(line: string) {
	let start = 0
	let end = line.length
	while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++
	while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--
	return start === 0 && end === line.length ? line : line.slice(start, end)
}

// Formats a token for error messages, quoting empty values.
function formatToken(token: string) {
	return token.length > 0 ? token : '<empty>'
}
