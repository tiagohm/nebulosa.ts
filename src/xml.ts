// https://x.com/i/grok/share/3i6xCCEtUvQWeNnbiVMaermCl

import { GrowableBuffer } from './io'

export type XmlNodeAtrributes = Record<string, string>

export interface XmlNode {
	name: string
	attributes: XmlNodeAtrributes
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

export class SimpleXmlParser {
	private state = XmlState.START
	private readonly tag = new GrowableBuffer(32)
	private readonly name = new GrowableBuffer(32)
	private readonly value = new GrowableBuffer(128)
	private readonly text = new GrowableBuffer(1024 * 16)
	private attributes: XmlNodeAtrributes = {}
	private tree: XmlNode[] = []
	private prevCode?: number

	parse(input: string | Buffer) {
		const nodes: XmlNode[] = []

		if (typeof input === 'string') {
			for (let i = 0; i < input.length; i++) {
				const node = this.processByte(input.charCodeAt(i))
				if (node) nodes.push(node)
			}
		} else {
			for (let i = 0; i < input.byteLength; i++) {
				const code = input.readInt8(i)
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
	}

	private appendNode(attributes: XmlNodeAtrributes, push: boolean = true) {
		const node: XmlNode = { name: this.tag.toString(), attributes, children: [], text: '' }

		if (this.tree.length) {
			this.tree[this.tree.length - 1].children.push(node)
		}

		if (push) this.tree.push(node)

		this.tag.reset()

		return node
	}

	private processByte(code: number) {
		if (this.state === XmlState.START) {
			if (code === OPEN_ANGLE) {
				this.state = XmlState.TAG_OPEN
			}
		} else if (this.state === XmlState.TAG_OPEN) {
			if (isAlphaNumeric(code)) {
				this.tag.writeInt8(code)
				this.state = XmlState.TAG_NAME
			} else if (code === SLASH) {
				this.state = XmlState.TAG_CLOSE
			}
		} else if (this.state === XmlState.TAG_NAME) {
			if (isAlphaNumeric(code) || code === COLON) {
				this.tag.writeInt8(code)
			} else if (code === WHITESPACE) {
				this.attributes = {}
				this.state = XmlState.ATTR_NAME
			} else if (code === CLOSE_ANGLE) {
				this.appendNode({})
				this.state = XmlState.TEXT
			} else if (code === SLASH) {
				this.state = XmlState.SELF_CLOSE
			}
		} else if (this.state === XmlState.ATTR_NAME) {
			if (isAlphaNumeric(code)) {
				this.name.writeInt8(code)
			} else if (code === EQUAL) {
				this.state = XmlState.ATTR_VALUE
			} else if (code === CLOSE_ANGLE || code === WHITESPACE) {
				const name = this.name.toString()

				if (name) {
					this.attributes[name] = ''
					this.name.reset()
				}

				if (code === CLOSE_ANGLE) {
					const node = this.appendNode(this.attributes, this.prevCode !== SLASH)
					this.attributes = {}

					if (this.tree.length === 0) {
						this.state = XmlState.START
						this.prevCode = undefined
						return node
					}

					this.state = XmlState.TEXT
				}
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
				this.tree[this.tree.length - 1].text = this.text.toString(true)
				this.text.reset()
				this.state = XmlState.TAG_OPEN
			} else {
				this.text.writeInt8(code)
			}
		} else if (this.state === XmlState.SELF_CLOSE) {
			if (code === CLOSE_ANGLE) {
				const node = this.appendNode(this.attributes, false)
				this.state = XmlState.START

				if (this.tree.length === 0) {
					this.prevCode = undefined
					return node
				}
			}
		} else if (this.state === XmlState.TAG_CLOSE) {
			if (code === CLOSE_ANGLE) {
				const node = this.tree.pop()
				this.state = XmlState.START

				if (node && this.tree.length === 0) {
					this.prevCode = undefined
					return node
				}
			}
		}

		this.prevCode = code

		return undefined
	}
}

function isAlphaNumeric(code: number) {
	return (code >= ZERO && code <= NINE) || (code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER)
}
