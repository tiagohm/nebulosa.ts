// http://www.clearskyinstitute.com/INDI/INDI.pdf

import type { Socket } from 'bun'

// A simple XML-like communications protocol is described for
// interactive and automated remote control of diverse instrumentation.

export enum PropertyState {
	IDLE = 'Idle',
	OK = 'Ok',
	BUSY = 'Busy',
	ALERT = 'Alert',
}

export enum SwitchRule {
	ONE_OF_MANY = 'OneOfMany',
	AT_MOST_ONE = 'AtMostOne',
	ANY_OF_MANY = 'AnyOfMany',
}

export enum PropertyPermission {
	READ_ONLY = 'ro',
	WRITE_ONLY = 'wo',
	READ_WRITE = 'rw',
}

export enum BlobEnable {
	NEVER = 'Never',
	ALSO = 'Also',
	ONLY = 'Only',
}

export type ValueType = string | number | boolean

// Commands from Device to Client:

// Command to enable snooping messages from other devices. Once enabled, defXXX and setXXX messages
// for the Property with the given name and other messages from the device will be sent to this
// driver channel. Enables messages from all devices if device is not specified, and all Properties
// for the given device if name is not specified. Specifying name without device is not defined.
export interface GetProperties {
	device?: string
	name?: string
}

// Define a property that holds one or more text elements.
export interface DefTextVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: DefText[]
}

// Define one member of a text vector.
export interface DefText {
	name: string
	label?: string
	value: string
}

// Define a property that holds one or more numeric values.
export interface DefNumberVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: DefNumber[]
}

// Define one member of a number vector.
export interface DefNumber {
	name: string
	label?: string
	format: string
	min: number
	max: number
	step: number
	value: number
}

// Define a collection of switches. Rule is only a hint for use by a GUI to decide a suitable
// presentation style. Rules are actually implemented wholly within the Device.
export interface DefSwitchVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	rule: SwitchRule
	timeout?: number
	timestamp?: string
	message?: string
	elements: DefSwitch[]
}

// Define one member of a switch vector.
export interface DefSwitch {
	name: string
	label?: string
	value: boolean
}

// Define a collection of passive indicator lights.
export interface DefLightVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	timestamp?: string
	message?: string
	elements: DefLight[]
}

// Define one member of a light vector.
export interface DefLight {
	name: string
	label?: string
	value: PropertyState
}

// Define a property that holds one or more Binary Large Objects, BLOBs.
export interface DefBlobVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: DefBlob[]
}

// Define one member of a BLOB vector. Unlike other defXXX elements, this does not contain an
// initial value for the BLOB.
export interface DefBlob {
	name: string
	label?: string
}

export type DefVector = DefTextVector | DefNumberVector | DefSwitchVector | DefLightVector | DefBlobVector
export type DefElement = DefText | DefNumber | DefSwitch | DefLight | DefBlob

// Send a new set of values for a Text vector, with optional new timeout, state and message.
export interface SetTextVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: OneText[]
}

// Send a new set of values for a Number vector, with optional new timeout, state and message.
export interface SetNumberVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: OneNumber[]
}

// Send a new set of values for a Switch vector, with optional new timeout, state and message.
export interface SetSwitchVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: OneSwitch[]
}

// Send a new set of values for a Light vector, with optional new state and message.
export interface SetLightVector {
	device: string
	name: string
	state?: PropertyState
	timestamp?: string
	message?: string
	elements: OneLight[]
}

// Send a new set of values for a BLOB vector, with optional new timeout, state and message.
export interface SetBlobVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: OneBlob[]
}

export type SetVector = SetTextVector | SetNumberVector | SetSwitchVector | SetLightVector | SetBlobVector

// Send a message associated with a device or entire system.
export interface Message {
	device?: string
	timestamp?: string
	message: string
}

// Delete the given property, or entire device if no property is specified.
export interface DelProperty {
	device: string
	name?: string
	timestamp?: string
	message?: string
}

// Send a message to specify state of one member of a Light vector.
export interface OneLight {
	name: string
	value: PropertyState
}

// Commands from Client to Device:

// Command to control whether setBLOBs should be sent to this channel from a given Device. They can
// be turned off completely by setting Never (the default), allowed to be intermixed with other INDI
// commands by setting Also or made the only command by setting Only.
export interface EnableBlob {
	device: string
	name?: string
	value: BlobEnable
}

// Commands to inform Device of new target values for a Property. After sending, the Client must set
// its local state for the Property to Busy, leaving it up to the Device to change it when it sees
// fit.

export interface NewTextVector {
	device: string
	name: string
	timestamp?: string
	elements: OneText[]
}

export interface NewNumberVector {
	device: string
	name: string
	timestamp?: string
	elements: OneNumber[]
}

export interface NewSwitchVector {
	device: string
	name: string
	timestamp?: string
	elements: OneSwitch[]
}

export interface NewBlobVector {
	device: string
	name: string
	timestamp?: string
	elements: OneBlob[]
}

export type NewVector = NewTextVector | NewNumberVector | NewSwitchVector | NewBlobVector

// Elements describing a vector member value, used in both directions:

// One member of a Text vector.
export interface OneText {
	name: string
	value: string
}

// One member of a Number vector.
export interface OneNumber {
	name: string
	value: number
}

// One member of a Switch vector.
export interface OneSwitch {
	name: string
	value: boolean
}

// One member of a BLOB vector. The contents of this element must always be encoded using base647.
// The format attribute consists of one or more file name suffixes, each preceded with a period,
// which indicate how the decoded data is to be interpreted. For example .fits indicates the decoded
// BLOB is a FITS8 file, and .fits.z indicates the decoded BLOB is a FITS file compressed with
// zlib9. The INDI protocol places no restrictions on the contents or formats of BLOBs but at
// minimum astronomical INDI clients are encouraged to support the FITS image file format and the
// zlib compression mechanism. The size attribute indicates the number of bytes in the final BLOB
// after decoding and after any decompression. For example, if the format is .fits.z the size
// attribute is the number of bytes in the FITS file. A Client unfamiliar with the specified format
// may use the attribute as a simple string, perhaps in combination with the timestamp attribute, to
// create a file name in which to store the data without processing other than decoding the base64.
export interface OneBlob {
	name: string
	size: string
	format: string
	value: string
}

export type OneElement = OneText | OneNumber | OneSwitch | OneLight | OneBlob
// export type ReceiveCommand = GetProperties | DefVector | SetVector | Message | DelProperty

export class IndiClient {
	private readonly parser = new SimpleXmlParser()
	private socket?: Socket

	async connect(hostname: string, port: number = 7624) {
		if (this.socket) return

		this.socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data: (_, data) => {
					this.parse(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.socket = socket
					this.getProperties()
				},
				// close(socket) {},
				// drain(socket) {},
				// error(socket, error) {},

				connectError: (_, error) => {
					console.error('connection failed', error)
				},
				end: () => {
					console.warn('connection closed by server')
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})
	}

	close() {
		this.socket?.terminate()
		this.socket = undefined
	}

	private parse(data: Buffer) {
		for (const tag of this.parser.parse(data)) {
			console.log(tag)
		}
	}

	getProperties(command?: GetProperties) {
		if (this.socket) {
			this.socket.write(`<getProperties version="1.7"`)
			if (command?.device) this.socket.write(` device="${command.device}"`)
			if (command?.name) this.socket.write(` name="${command.name}"`)
			this.socket.write(`></getProperties>`)
			this.socket.flush()
		}
	}

	enableBlob(command: EnableBlob) {
		if (this.socket) {
			this.socket.write(`<enableBLOB device="${command.device}"`)
			if (command.name) this.socket.write(` name="${command.name}"`)
			this.socket.write(`>${command.value}</enableBLOB>`)
			this.socket.flush()
		}
	}

	text(command: NewTextVector) {
		if (this.socket) {
			this.socket.write(`<newTextVector`)
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const element of command.elements) this.socket.write(`<oneText name="${element.name}">${element.value}</oneText>`)
			this.socket.write(`</newTextVector>`)
			this.socket.flush()
		}
	}

	number(command: NewNumberVector) {
		if (this.socket) {
			this.socket.write(`<newNumberVector`)
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const element of command.elements) this.socket.write(`<oneNumber name="${element.name}">${element.value}</oneNumber>`)
			this.socket.write(`</newNumberVector>`)
			this.socket.flush()
		}
	}

	switch(command: NewSwitchVector) {
		if (this.socket) {
			this.socket.write(`<newSwitchVector`)
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const element of command.elements) this.socket.write(`<oneSwitch name="${element.name}">${element.value ? 'On' : 'Off'}</oneSwitch>`)
			this.socket.write(`</newSwitchVector>`)
			this.socket.flush()
		}
	}
}

export enum SimpleXmlState {
	START,
	OPEN_TAG,
	ATTR,
	TAG_CONTENT,
	CLOSE_TAG,
}

export interface SimpleXmlElement {
	name: string
	attributes: Record<string, string>
	text: string
	children: SimpleXmlElement[]
}

export const EMPTY_SIMPLE_XML_ELEMENT: SimpleXmlElement = {
	name: '',
	attributes: {},
	text: '',
	children: [],
}

const WHITESPACE = 32
const QUOTE = 34
const SLASH = 47
const OPEN_ANGLE = 60
const EQUAL = 61
const CLOSE_ANGLE = 62
const A_UPPER = 65
const Z_UPPER = 90
const A_LOWER = 97
const Z_LOWER = 122

interface ParsedTagContext {
	tags: SimpleXmlElement[]
	state: SimpleXmlState
	key: string
	value: string
	attrState: number
}

const EMPTY_PARSED_TAG_CONTEXT: ParsedTagContext = {
	tags: [],
	state: SimpleXmlState.START,
	key: '',
	value: '',
	attrState: 0,
}

export class SimpleXmlParser {
	private readonly context: ParsedTagContext[] = []
	private prevCode = 0

	private get currentLevel() {
		return this.context.length - 1
	}

	private get currentContext(): ParsedTagContext | undefined {
		return this.context[this.currentLevel]
	}

	private get currentTag(): SimpleXmlElement | undefined {
		const context = this.currentContext
		return context?.tags[context.tags.length - 1]
	}

	private newContext(state: SimpleXmlState = SimpleXmlState.START) {
		const context: ParsedTagContext = {
			state,
			tags: [],
			key: '',
			value: '',
			attrState: 0,
		}

		this.context.push(context)

		return context
	}

	private removeContext() {
		return this.context.splice(this.currentLevel, 1)[0]
	}

	parse(data: Buffer) {
		const tags: SimpleXmlElement[] = []

		for (let i = 0; i < data.length; i++) {
			const tag = this.parseByte(data.readUInt8(i))

			if (tag) {
				tags.push(tag)
			}
		}

		return tags
	}

	parseByte(code: number) {
		const char = String.fromCharCode(code)
		const context = this.currentContext ?? EMPTY_PARSED_TAG_CONTEXT
		const tag = context.tags[context.tags.length - 1]

		switch (context.state) {
			case SimpleXmlState.START:
				if (code === OPEN_ANGLE) {
					const context = this.newContext(SimpleXmlState.OPEN_TAG)
					context.tags.push(structuredClone(EMPTY_SIMPLE_XML_ELEMENT))
				}

				break
			case SimpleXmlState.OPEN_TAG:
				if ((code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER)) {
					tag.name += char
				} else if (code === WHITESPACE) {
					context.state = SimpleXmlState.ATTR
				} else if (code === CLOSE_ANGLE) {
					context.state = SimpleXmlState.TAG_CONTENT
				}

				break
			case SimpleXmlState.ATTR:
				if (code === QUOTE) {
					if (context.attrState === 1) {
						context.attrState = 2
					} else {
						tag.attributes[context.key] = context.value
						context.key = ''
						context.value = ''
						context.attrState = 0
					}
				} else if (context.attrState === 2) {
					context.value += char
				} else if ((code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER)) {
					context.key += char
				} else if (code === EQUAL) {
					context.attrState = 1
				} else if (code === CLOSE_ANGLE) {
					context.state = SimpleXmlState.TAG_CONTENT
				}

				break
			case SimpleXmlState.TAG_CONTENT:
				if (code === OPEN_ANGLE) {
					// can be "/" or letter
				} else if (code === SLASH && this.prevCode === OPEN_ANGLE) {
					tag.text = tag.text.trim()
					context.state = SimpleXmlState.CLOSE_TAG
				} else if (this.prevCode === OPEN_ANGLE) {
					const context = this.newContext(SimpleXmlState.OPEN_TAG)
					const tag = structuredClone(EMPTY_SIMPLE_XML_ELEMENT)
					tag.name = char
					context.tags.push(tag)
				} else if (code !== OPEN_ANGLE && code !== 13 && code !== 10) {
					tag.text += char
				}

				break
			case SimpleXmlState.CLOSE_TAG:
				if (code === CLOSE_ANGLE) {
					const child = this.removeContext()

					if (!this.context.length) {
						return child.tags[0]
					} else {
						const tag = this.currentTag!
						tag.children.push(...child.tags)
					}
				}

				break
			default:
				throw new Error('unknown state')
		}

		this.prevCode = code

		return undefined
	}
}
