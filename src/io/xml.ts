// https://x.com/i/grok/share/3i6xCCEtUvQWeNnbiVMaermCl

// Minimal streaming XML parser, sufficient for the simple element/attribute/text documents the library
// consumes (e.g. INDI/Alpaca payloads). `SimpleXmlParser` is a chunk-fed state machine that copies token
// runs (text, quoted attribute values, and names) in bulk and emits each top-level node once it closes.
// It does not handle DTDs, namespaces beyond `:` in names, entity references, CDATA, or processing
// instructions.

// XML element attributes as a name -> value map.
export type XmlNodeAttributes = Record<string, string>

// A parsed XML element node.
export interface XmlNode {
	// Tag name.
	name: string
	// Attribute name/value pairs (valueless attributes map to '').
	attributes: XmlNodeAttributes
	// Child element nodes in document order.
	children: XmlNode[]
	// Concatenated raw (bytes) text content directly inside this element.
	// May be a view into a larger ArrayBuffer; consumers must honor `byteOffset` and `byteLength`
	// instead of wrapping `.buffer` alone.
	text: Uint8Array
}

// Internal tokenizer states of the byte-level XML state machine.
enum XmlState {
	START,
	TAG_OPEN,
	TAG_NAME,
	ATTR_NAME,
	ATTR_VALUE,
	TEXT,
	TAG_CLOSE,
	SELF_CLOSE,
}

// ASCII byte codes recognized by the tokenizer (whitespace, structural punctuation, and name-character ranges).
const WHITESPACE = 32
const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const QUOTE = 34
const SLASH = 47
const OPEN_ANGLE = 60
const EQUAL = 61
const CLOSE_ANGLE = 62
const ZERO = 48
const NINE = 57
const A_UPPER = 65
const Z_UPPER = 90
const A_LOWER = 97
const Z_LOWER = 122
const COLON = 58
const DASH = 45
const DOT = 46
const UNDERSCORE = 95

// Text payloads at or above this size transfer the parser buffer instead of copying into the node.
const LARGE_TEXT_THRESHOLD = 64 * 1024

// Shared empty text payload for elements with no character data.
const EMPTY_TEXT = new Uint8Array(0)

// Reusable geometric-growth byte buffer that accumulates token bytes and decodes them to text on demand,
// avoiding per-token allocations. An optional max byte length caps growth for the text buffer.
class InternalBuffer {
	readonly #decoder = new TextDecoder()
	readonly #maxByteLength: number
	readonly #initialSize: number
	#data: Uint8Array

	#position = 0

	// Allocate only the initial capacity and defer growth until writes exceed it.
	constructor(size: number, maxByteLength: number = 0) {
		this.#initialSize = size
		this.#maxByteLength = maxByteLength > 0 ? Math.max(size, maxByteLength) : 0
		this.#data = new Uint8Array(size)
	}

	get length() {
		return this.#position
	}

	// Reset the logical cursor while retaining the current allocation.
	reset() {
		this.#position = 0
	}

	// Append one byte and grow the storage geometrically only when capacity is exhausted.
	write(byte: number) {
		this.#ensure(1)
		this.#data[this.#position++] = byte
	}

	// Append `src[start, end)` in one copy, growing to at least the needed size when the run is larger
	// than the remaining capacity.
	writeBytes(src: Uint8Array, start: number, end: number) {
		const n = end - start
		if (n <= 0) return
		this.#ensure(n)
		this.#data.set(src.subarray(start, end), this.#position)
		this.#position += n
	}

	// Decode the bytes written since the last reset.
	text() {
		return this.#decoder.decode(this.array())
	}

	array() {
		return this.#data.subarray(0, this.#position)
	}

	// Detach the written bytes. Payloads at or above `LARGE_TEXT_THRESHOLD` transfer the backing
	// store without copying (the result may be a view over spare capacity); smaller payloads are
	// copied so this buffer stays reusable. Resets the logical cursor in both cases.
	take(): Uint8Array {
		const length = this.#position
		if (length === 0) {
			this.#position = 0
			return EMPTY_TEXT
		}

		if (length >= LARGE_TEXT_THRESHOLD) {
			const view = this.#data.subarray(0, length)
			this.#data = new Uint8Array(this.#initialSize)
			this.#position = 0
			return view
		}

		const copy = this.#data.slice(0, length)
		this.#position = 0
		return copy
	}

	// Grow geometrically until `this.#position + n` fits, without exceeding the optional max byte length.
	#ensure(n: number) {
		const needed = this.#position + n
		if (needed <= this.#data.length) return

		const max = this.#maxByteLength
		if (max > 0 && !(needed <= max)) {
			throw new RangeError(`internal buffer exceeded max byte length: ${max}`)
		}

		let nextLength = this.#data.length
		while (nextLength < needed) nextLength *= 2
		if (max > 0 && nextLength > max) nextLength = max

		const data = new Uint8Array(nextLength)
		data.set(this.#data)
		this.#data = data
	}
}

function mergeArray(a: Uint8Array, b: Uint8Array) {
	const merged = new Uint8Array(a.length + b.length)
	merged.set(a, 0)
	merged.set(b, a.length)
	return merged
}

// Incremental XML parser. Feed bytes/strings via parse(); it returns any top-level nodes that completed
// during that call and retains partial state between calls. Throws on malformed input (and resets).
// The array returned by parse() is reused on the next call; retain the XmlNode objects, not the array.
export class SimpleXmlParser {
	#state = XmlState.START
	readonly #tag = new InternalBuffer(256)
	readonly #name = new InternalBuffer(256)
	readonly #value = new InternalBuffer(1024)
	readonly #text = new InternalBuffer(256, 1024 * 1024 * 256)
	#attributes: XmlNodeAttributes = {}
	#tree: XmlNode[] = []
	#prevCode?: number
	#closeTagSealed = false
	readonly #encoder = new TextEncoder()
	readonly #nodes: XmlNode[] = []

	// Feeds a chunk of XML (string or bytes) and returns the top-level nodes that completed in this chunk.
	// The returned array is cleared and reused on the next parse(); node objects remain valid.
	parse(input: string | Buffer | Uint8Array): XmlNode[] {
		if (typeof input === 'string') {
			return this.parse(this.#encoder.encode(input))
		}

		this.#nodes.length = 0
		this.#processChunk(input, this.#nodes)
		return this.#nodes
	}

	// Clears all parser state, discarding any partially parsed node and the open-element stack.
	reset() {
		this.#state = XmlState.START
		this.#tag.reset()
		this.#name.reset()
		this.#value.reset()
		this.#text.reset()
		this.#attributes = {}
		this.#tree = []
		this.#prevCode = undefined
		this.#closeTagSealed = false
	}

	// Append a new node to the current tree and optionally keep it open.
	#appendNode(attributes: XmlNodeAttributes, push: boolean = true): XmlNode {
		const node: XmlNode = { name: this.#tag.text(), attributes, children: [], text: EMPTY_TEXT }

		if (this.#tree.length > 0) {
			this.#tree.at(-1)!.children.push(node)
		}

		if (push) this.#tree.push(node)

		this.#tag.reset()

		return node
	}

	// Append the current text segment to the active node without losing mixed content.
	#appendText() {
		if (this.#tree.length === 0) {
			this.#text.reset()
			return
		}

		if (this.#text.length === 0) return

		const node = this.#tree.at(-1)!
		const chunk = this.#text.take()
		node.text = node.text.length === 0 ? chunk : mergeArray(node.text, chunk)
	}

	// Flush a valueless attribute that ended at whitespace, `/`, or `>`.
	#flushAttributeName() {
		const name = this.#name.text()
		if (!name) return
		this.#attributes[name] = ''
		this.#name.reset()
	}

	// Reset the parser before surfacing malformed input.
	#fail(message: string) {
		this.reset()
		throw new Error(message)
	}

	// Close the current node and validate the closing tag name.
	#closeNode(): XmlNode | undefined {
		const name = this.#tag.text()
		this.#tag.reset()
		this.#closeTagSealed = false
		if (!name) this.#fail('missing closing tag name')
		const node = this.#tree.pop()
		if (!node || node.name !== name) this.#fail(`mismatched closing tag: expected ${node?.name ?? 'none'}, received ${name}`)
		return node
	}

	// Copy token runs from `input` and push each top-level node that closes in this chunk.
	#processChunk(input: Uint8Array, nodes: XmlNode[]) {
		const length = input.byteLength
		let i = 0

		while (i < length) {
			if (this.#state === XmlState.TEXT) {
				const lt = input.indexOf(OPEN_ANGLE, i)
				const end = lt < 0 ? length : lt
				if (end > i) {
					this.#text.writeBytes(input, i, end)
					this.#prevCode = input[end - 1]
				}
				if (lt < 0) return
				this.#appendText()
				this.#state = XmlState.TAG_OPEN
				this.#prevCode = OPEN_ANGLE
				i = lt + 1
				continue
			}

			if (this.#state === XmlState.ATTR_VALUE && input[i] !== QUOTE) {
				const q = input.indexOf(QUOTE, i)
				const end = q < 0 ? length : q
				if (end > i) {
					this.#value.writeBytes(input, i, end)
					this.#prevCode = input[end - 1]
				}
				if (q < 0) return
				i = q
				continue
			}

			if (this.#state === XmlState.TAG_NAME || this.#state === XmlState.ATTR_NAME || (this.#state === XmlState.TAG_CLOSE && !this.#closeTagSealed)) {
				const dest = this.#state === XmlState.ATTR_NAME ? this.#name : this.#tag
				const start = i
				while (i < length && isNameChar(input[i])) i++
				if (i > start) {
					dest.writeBytes(input, start, i)
					this.#prevCode = input[i - 1]
					continue
				}
			}

			if (this.#state === XmlState.START) {
				const lt = input.indexOf(OPEN_ANGLE, i)
				if (lt < 0) {
					this.#prevCode = input[length - 1]
					return
				}
				i = lt
			}

			const node = this.#processByte(input[i])
			if (node) nodes.push(node)
			i++
		}
	}

	// Advance the tokenizer by one structural byte (delimiters and single-byte state transitions).
	#processByte(code: number): XmlNode | undefined {
		if (this.#state === XmlState.START) {
			if (code === OPEN_ANGLE) {
				this.#state = XmlState.TAG_OPEN
			}
		} else if (this.#state === XmlState.TAG_OPEN) {
			if (isWhitespace(code)) {
				// Ignore insignificant whitespace between top-level nodes.
			} else if (isNameChar(code)) {
				this.#tag.write(code)
				this.#state = XmlState.TAG_NAME
			} else if (code === SLASH) {
				this.#tag.reset()
				this.#closeTagSealed = false
				this.#state = XmlState.TAG_CLOSE
			} else {
				this.#fail(`invalid tag start character: ${code}`)
			}
		} else if (this.#state === XmlState.TAG_NAME) {
			if (isNameChar(code)) {
				this.#tag.write(code)
			} else if (isWhitespace(code)) {
				this.#attributes = {}
				this.#name.reset()
				this.#state = XmlState.ATTR_NAME
			} else if (code === CLOSE_ANGLE) {
				this.#appendNode({})
				this.#state = XmlState.TEXT
			} else if (code === SLASH) {
				this.#attributes = {}
				this.#state = XmlState.SELF_CLOSE
			} else {
				this.#fail(`invalid tag name character: ${code}`)
			}
		} else if (this.#state === XmlState.ATTR_NAME) {
			if (isWhitespace(code)) {
				this.#flushAttributeName()
			} else if (isNameChar(code)) {
				this.#name.write(code)
			} else if (code === EQUAL) {
				this.#state = XmlState.ATTR_VALUE
			} else if (code === SLASH) {
				this.#flushAttributeName()
				this.#state = XmlState.SELF_CLOSE
			} else if (code === CLOSE_ANGLE) {
				// An opening tag with attributes is always pushed onto the tree and only emitted when
				// it closes, so unlike the self-closing path it never completes a top-level node here.
				this.#flushAttributeName()
				this.#appendNode(this.#attributes)
				this.#attributes = {}
				this.#state = XmlState.TEXT
			} else {
				this.#fail(`invalid attribute name character: ${code}`)
			}
		} else if (this.#state === XmlState.ATTR_VALUE) {
			if (code === QUOTE) {
				if (this.#value.length > 0 || this.#prevCode === QUOTE) {
					const name = this.#name.text()
					this.#attributes[name] = this.#value.text()
					this.#name.reset()
					this.#value.reset()
					this.#state = XmlState.ATTR_NAME
				} else {
					this.#value.reset()
				}
			} else {
				this.#value.write(code)
			}
		} else if (this.#state === XmlState.TEXT) {
			if (code === OPEN_ANGLE) {
				this.#appendText()
				this.#state = XmlState.TAG_OPEN
			} else {
				this.#text.write(code)
			}
		} else if (this.#state === XmlState.SELF_CLOSE) {
			if (code === CLOSE_ANGLE) {
				const node = this.#appendNode(this.#attributes, false)
				this.#attributes = {}
				this.#state = this.#tree.length === 0 ? XmlState.START : XmlState.TEXT

				if (this.#tree.length === 0) {
					this.#prevCode = undefined
					return node
				}
			} else if (!isWhitespace(code)) {
				this.#fail(`invalid self-closing tag character: ${code}`)
			}
		} else if (this.#state === XmlState.TAG_CLOSE) {
			if (isNameChar(code)) {
				if (this.#closeTagSealed) this.#fail('invalid closing tag syntax')
				this.#tag.write(code)
			} else if (isWhitespace(code)) {
				if (this.#tag.length > 0) this.#closeTagSealed = true
			} else if (code === CLOSE_ANGLE) {
				const node = this.#closeNode()
				this.#state = this.#tree.length === 0 ? XmlState.START : XmlState.TEXT

				if (node && this.#tree.length === 0) {
					this.#prevCode = undefined
					return node
				}
			} else {
				this.#fail(`invalid closing tag character: ${code}`)
			}
		}

		this.#prevCode = code

		return undefined
	}
}

// True for the four XML whitespace byte codes (space, tab, LF, CR).
function isWhitespace(code: number) {
	return code === WHITESPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN
}

// True for byte codes allowed in tag/attribute names (alphanumerics plus ':', '-', '.', '_').
function isNameChar(code: number) {
	return (code >= ZERO && code <= NINE) || (code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER) || code === COLON || code === DASH || code === DOT || code === UNDERSCORE
}
