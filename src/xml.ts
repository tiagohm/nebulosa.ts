// https://x.com/i/grok/share/3i6xCCEtUvQWeNnbiVMaermCl

import { GrowableBuffer } from './io'

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

export class SimpleXmlParser {
	private state = XmlState.START
	private readonly tag = new GrowableBuffer(32)
	private readonly name = new GrowableBuffer(32)
	private readonly value = new GrowableBuffer(128)
	private readonly text = new GrowableBuffer(1024 * 16)
	private attributes: XmlNodeAttributes = {}
	private tree: XmlNode[] = []
	private prevCode?: number
	private closeTagSealed = false

	parse(input: string | Buffer): XmlNode[] {
		const nodes: XmlNode[] = []

		if (typeof input === 'string') {
			for (let i = 0; i < input.length; i++) {
				const node = this.processByte(input.charCodeAt(i))
				if (node) nodes.push(node)
			}
		} else {
			for (let i = 0; i < input.byteLength; i++) {
				const code = input[i] & 0xff
				const node = this.processByte(code)
				if (node) nodes.push(node)
			}
		}

		return nodes
	}

	reset() {
		this.state = XmlState.START
		this.tag.reset()
		this.name.reset()
		this.value.reset()
		this.text.reset()
		this.attributes = {}
		this.tree = []
		this.prevCode = undefined
		this.closeTagSealed = false
	}

	// Append a new node to the current tree and optionally keep it open.
	private appendNode(attributes: XmlNodeAttributes, push: boolean = true): XmlNode {
		const node: XmlNode = { name: this.tag.toString(), attributes, children: [], text: '' }

		if (this.tree.length) {
			this.tree[this.tree.length - 1].children.push(node)
		}

		if (push) this.tree.push(node)

		this.tag.reset()

		return node
	}

	// Append the current text segment to the active node without losing mixed content.
	private appendText() {
		if (!this.tree.length) {
			this.text.reset()
			return
		}

		const value = this.text.toString(true)
		this.text.reset()

		if (!value) return

		const node = this.tree[this.tree.length - 1]
		node.text += value
	}

	// Flush a valueless attribute that ended at whitespace, `/`, or `>`.
	private flushAttributeName() {
		const name = this.name.toString()
		if (!name) return
		this.attributes[name] = ''
		this.name.reset()
	}

	// Reset the parser before surfacing malformed input.
	private fail(message: string) {
		this.reset()
		throw new Error(message)
	}

	// Close the current node and validate the closing tag name.
	private closeNode(): XmlNode | undefined {
		const name = this.tag.toString()
		this.tag.reset()
		this.closeTagSealed = false
		if (!name) this.fail('missing closing tag name')
		const node = this.tree.pop()
		if (!node || node.name !== name) this.fail(`mismatched closing tag: expected ${node?.name ?? 'none'}, received ${name}`)
		return node
	}

	private processByte(code: number): XmlNode | undefined {
		if (this.state === XmlState.START) {
			if (code === OPEN_ANGLE) {
				this.state = XmlState.TAG_OPEN
			}
		} else if (this.state === XmlState.TAG_OPEN) {
			if (isWhitespace(code)) {
				// Ignore insignificant whitespace between top-level nodes.
			} else if (isNameChar(code)) {
				this.tag.writeInt8(code)
				this.state = XmlState.TAG_NAME
			} else if (code === SLASH) {
				this.tag.reset()
				this.closeTagSealed = false
				this.state = XmlState.TAG_CLOSE
			} else {
				this.fail(`invalid tag start character: ${code}`)
			}
		} else if (this.state === XmlState.TAG_NAME) {
			if (isNameChar(code)) {
				this.tag.writeInt8(code)
			} else if (isWhitespace(code)) {
				this.attributes = {}
				this.name.reset()
				this.state = XmlState.ATTR_NAME
			} else if (code === CLOSE_ANGLE) {
				this.appendNode({})
				this.state = XmlState.TEXT
			} else if (code === SLASH) {
				this.attributes = {}
				this.state = XmlState.SELF_CLOSE
			} else {
				this.fail(`invalid tag name character: ${code}`)
			}
		} else if (this.state === XmlState.ATTR_NAME) {
			if (isWhitespace(code)) {
				this.flushAttributeName()
			} else if (isNameChar(code)) {
				this.name.writeInt8(code)
			} else if (code === EQUAL) {
				this.state = XmlState.ATTR_VALUE
			} else if (code === SLASH) {
				this.flushAttributeName()
				this.state = XmlState.SELF_CLOSE
			} else if (code === CLOSE_ANGLE) {
				this.flushAttributeName()
				const node = this.appendNode(this.attributes)
				this.attributes = {}

				if (this.tree.length === 0) {
					this.state = XmlState.START
					this.prevCode = undefined
					return node
				}

				this.state = XmlState.TEXT
			} else {
				this.fail(`invalid attribute name character: ${code}`)
			}
		} else if (this.state === XmlState.ATTR_VALUE) {
			if (code === QUOTE) {
				if (this.value.length > 0 || this.prevCode === QUOTE) {
					const name = this.name.toString()
					this.attributes[name] = this.value.toString()
					this.name.reset()
					this.value.reset()
					this.state = XmlState.ATTR_NAME
				} else {
					this.value.reset()
				}
			} else {
				this.value.writeInt8(code)
			}
		} else if (this.state === XmlState.TEXT) {
			if (code === OPEN_ANGLE) {
				this.appendText()
				this.state = XmlState.TAG_OPEN
			} else {
				this.text.writeInt8(code)
			}
		} else if (this.state === XmlState.SELF_CLOSE) {
			if (code === CLOSE_ANGLE) {
				const node = this.appendNode(this.attributes, false)
				this.attributes = {}
				this.state = this.tree.length === 0 ? XmlState.START : XmlState.TEXT

				if (this.tree.length === 0) {
					this.prevCode = undefined
					return node
				}
			} else if (!isWhitespace(code)) {
				this.fail(`invalid self-closing tag character: ${code}`)
			}
		} else if (this.state === XmlState.TAG_CLOSE) {
			if (isNameChar(code)) {
				if (this.closeTagSealed) this.fail('invalid closing tag syntax')
				this.tag.writeInt8(code)
			} else if (isWhitespace(code)) {
				if (this.tag.length > 0) this.closeTagSealed = true
			} else if (code === CLOSE_ANGLE) {
				const node = this.closeNode()
				this.state = this.tree.length === 0 ? XmlState.START : XmlState.TEXT

				if (node && this.tree.length === 0) {
					this.prevCode = undefined
					return node
				}
			} else {
				this.fail(`invalid closing tag character: ${code}`)
			}
		}

		this.prevCode = code

		return undefined
	}
}

function isWhitespace(code: number) {
	return code === WHITESPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN
}

function isNameChar(code: number) {
	return (code >= ZERO && code <= NINE) || (code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER) || code === COLON || code === DASH || code === DOT || code === UNDERSCORE
}
