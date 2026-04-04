// https://x.com/i/grok/share/3i6xCCEtUvQWeNnbiVMaermCl

export type XmlNodeAttributes = Record<string, string>

export interface XmlNode {
	name: string
	attributes: XmlNodeAttributes
	children: XmlNode[]
	text: string
}

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

class InternalBuffer {
	readonly #decoder = new TextDecoder()
	readonly #maxByteLength: number
	#data: Uint8Array

	position = 0

	// Allocate only the initial capacity and defer growth until writes exceed it.
	constructor(size: number, maxByteLength: number = 0) {
		this.#maxByteLength = maxByteLength > 0 ? Math.max(size, maxByteLength) : 0
		this.#data = new Uint8Array(size)
	}

	// Reset the logical cursor while retaining the current allocation.
	reset() {
		this.position = 0
	}

	// Append one byte and grow the storage geometrically only when capacity is exhausted.
	write(byte: number) {
		if (this.position >= this.#data.length) this.#grow()

		this.#data[this.position++] = byte
	}

	// Decode the bytes written since the last reset.
	text() {
		return this.#decoder.decode(this.#data.subarray(0, this.position))
	}

	// Grow without eagerly reserving the full max byte length.
	#grow() {
		const currentLength = this.#data.length
		const nextLength = this.#maxByteLength > 0 ? Math.min(currentLength * 2, this.#maxByteLength) : currentLength * 2

		if (nextLength <= currentLength) {
			throw new RangeError(`internal buffer exceeded max byte length: ${this.#maxByteLength}`)
		}

		const data = new Uint8Array(nextLength)
		data.set(this.#data)
		this.#data = data
	}
}

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

	parse(input: string | Buffer | Uint8Array): XmlNode[] {
		if (typeof input === 'string') {
			return this.parse(this.#encoder.encode(input))
		} else {
			const nodes: XmlNode[] = []

			for (let i = 0; i < input.byteLength; i++) {
				const code = input[i] & 0xff
				const node = this.#processByte(code)
				if (node) nodes.push(node)
			}

			return nodes
		}
	}

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
		const node: XmlNode = { name: this.#tag.text(), attributes, children: [], text: '' }

		if (this.#tree.length) {
			this.#tree[this.#tree.length - 1].children.push(node)
		}

		if (push) this.#tree.push(node)

		this.#tag.reset()

		return node
	}

	// Append the current text segment to the active node without losing mixed content.
	#appendText() {
		if (!this.#tree.length) {
			this.#text.reset()
			return
		}

		const value = this.#text.text().trim()
		this.#text.reset()

		if (!value) return

		const node = this.#tree[this.#tree.length - 1]
		node.text += value
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
				this.#flushAttributeName()
				const node = this.#appendNode(this.#attributes)
				this.#attributes = {}

				if (this.#tree.length === 0) {
					this.#state = XmlState.START
					this.#prevCode = undefined
					return node
				}

				this.#state = XmlState.TEXT
			} else {
				this.#fail(`invalid attribute name character: ${code}`)
			}
		} else if (this.#state === XmlState.ATTR_VALUE) {
			if (code === QUOTE) {
				if (this.#value.position > 0 || this.#prevCode === QUOTE) {
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
				if (this.#tag.position > 0) this.#closeTagSealed = true
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

function isWhitespace(code: number) {
	return code === WHITESPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN
}

function isNameChar(code: number) {
	return (code >= ZERO && code <= NINE) || (code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER) || code === COLON || code === DASH || code === DOT || code === UNDERSCORE
}
