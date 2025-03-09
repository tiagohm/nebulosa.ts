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

export enum VectorType {
	TEXT = 'Text',
	NUMBER = 'Number',
	SWITCH = 'Switch',
	LIGHT = 'Light',
	BLOB = 'BLOB',
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
	elements: Record<string, DefText>
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
	elements: Record<string, DefNumber>
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
	elements: Record<string, DefSwitch>
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
	elements: Record<string, DefLight>
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
	elements: Record<string, DefBlob>
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
	elements: Record<string, OneText>
}

// Send a new set of values for a Number vector, with optional new timeout, state and message.
export interface SetNumberVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneNumber>
}

// Send a new set of values for a Switch vector, with optional new timeout, state and message.
export interface SetSwitchVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneSwitch>
}

// Send a new set of values for a Light vector, with optional new state and message.
export interface SetLightVector {
	device: string
	name: string
	state?: PropertyState
	timestamp?: string
	message?: string
	elements: Record<string, OneLight>
}

// Send a new set of values for a BLOB vector, with optional new timeout, state and message.
export interface SetBlobVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneBlob>
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
	elements: Record<string, OneText>
}

export interface NewNumberVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, OneNumber>
}

export interface NewSwitchVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, OneSwitch>
}

export interface NewBlobVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, OneBlob>
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

export type TextVector = DefTextVector | SetTextVector | NewTextVector
export type NumberVector = DefNumberVector | SetNumberVector | NewNumberVector
export type SwitchVector = DefSwitchVector | SetSwitchVector | NewSwitchVector
export type LightVector = DefLightVector | SetLightVector
export type BlobVector = DefBlobVector | SetBlobVector | NewBlobVector

export type TextElement = OneText | DefText
export type NumberElement = OneNumber | DefNumber
export type SwitchElement = OneSwitch | DefSwitch
export type LightElement = OneLight | DefLight
export type BlobElement = OneBlob | DefBlob

export interface IndiClientHandler {
	message?: (client: IndiClient, message: Message) => void
	delProperty?: (client: IndiClient, message: DelProperty) => void
	defTextVector?: (client: IndiClient, message: DefTextVector) => void
	defNumberVector?: (client: IndiClient, message: DefNumberVector) => void
	defSwitchVector?: (client: IndiClient, message: DefSwitchVector) => void
	defLightVector?: (client: IndiClient, message: DefLightVector) => void
	defBlobVector?: (client: IndiClient, message: DefBlobVector) => void
	defVector?: (client: IndiClient, message: DefVector, name: `def${VectorType}Vector`) => void
	setTextVector?: (client: IndiClient, message: SetTextVector) => void
	setNumberVector?: (client: IndiClient, message: SetNumberVector) => void
	setSwitchVector?: (client: IndiClient, message: SetSwitchVector) => void
	setLightVector?: (client: IndiClient, message: SetLightVector) => void
	setBlobVector?: (client: IndiClient, message: SetBlobVector) => void
	setVector?: (client: IndiClient, message: SetVector, name: `set${VectorType}Vector`) => void
	textVector?: (client: IndiClient, message: DefTextVector | SetTextVector, name: 'defTextVector' | 'setTextVector') => void
	numberVector?: (client: IndiClient, message: DefNumberVector | SetNumberVector, name: 'defNumberVector' | 'setNumberVector') => void
	switchVector?: (client: IndiClient, message: DefSwitchVector | SetSwitchVector, name: 'defSwitchVector' | 'setSwitchVector') => void
	lightVector?: (client: IndiClient, message: DefLightVector | SetLightVector, name: 'defLightVector' | 'setLightVector') => void
	blobVector?: (client: IndiClient, message: DefBlobVector | SetBlobVector, name: 'defBLOBVector' | 'setBLOBVector') => void
	close?: () => void
}

export interface IndiClientOptions {
	protocol?: IndiClientHandler
}

export class IndiClient {
	private readonly parser = new IndiXmlParser()
	private socket?: Socket

	constructor(private readonly options?: IndiClientOptions) {}

	get host() {
		return this.socket?.remoteAddress
	}

	get port() {
		return this.socket?.localPort
	}

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
				close: () => {
					console.warn('connection closed by client')
					this.socket = undefined
					this.options?.protocol?.close?.()
				},
				error: (_, error) => {
					console.error('connection failed', error)
				},
				connectError: (_, error) => {
					console.error('connection failed', error)
				},
				end: () => {
					console.warn('connection closed by server')
					this.socket = undefined
					this.options?.protocol?.close?.()
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
			this.handleTag(tag)
		}
	}

	private parseDefVector(tag: IndiXmlElement) {
		const message = {
			device: tag.attributes.device,
			name: tag.attributes.name,
			label: tag.attributes.label,
			group: tag.attributes.group,
			state: tag.attributes.state,
			permission: tag.attributes.perm,
			timeout: tag.attributes.timeout,
			timestamp: tag.attributes.timestamp,
			message: tag.attributes.message,
			elements: {},
		} as DefVector

		for (const child of tag.children) {
			switch (child.name) {
				case 'defText': {
					const element = { name: child.attributes.name, label: child.attributes.label, value: child.text } as DefText
					;(message as DefTextVector).elements[element.name] = element
					break
				}
				case 'defNumber': {
					const element = { name: child.attributes.name, label: child.attributes.label, format: child.attributes.format, min: parseFloat(child.attributes.min), max: parseFloat(child.attributes.max), step: parseFloat(child.attributes.step), value: parseFloat(child.text) } as DefNumber
					;(message as DefNumberVector).elements[element.name] = element
					break
				}
				case 'defSwitch': {
					const element = { name: child.attributes.name, label: child.attributes.label, value: child.text === 'On' } as DefSwitch
					;(message as DefSwitchVector).elements[element.name] = element
					break
				}
				case 'defLight': {
					const element = { name: child.attributes.name, label: child.attributes.label, value: child.text } as DefLight
					;(message as DefLightVector).elements[element.name] = element
					break
				}
				case 'defBLOB': {
					const element = { name: child.attributes.name, label: child.attributes.label } as DefBlob
					;(message as DefBlobVector).elements[element.name] = element
					break
				}
			}
		}

		return message
	}

	private parseSetVector(tag: IndiXmlElement) {
		const message = {
			device: tag.attributes.device,
			name: tag.attributes.name,
			state: tag.attributes.state,
			timeout: tag.attributes.timeout,
			timestamp: tag.attributes.timestamp,
			message: tag.attributes.message,
			elements: {},
		} as SetVector

		for (const child of tag.children) {
			switch (child.name) {
				case 'oneText': {
					const element = { name: child.attributes.name, value: child.text } as OneText
					;(message as SetTextVector).elements[element.name] = element
					break
				}
				case 'oneNumber': {
					const element = { name: child.attributes.name, value: parseFloat(child.text) } as OneNumber
					;(message as SetNumberVector).elements[element.name] = element
					break
				}
				case 'oneSwitch': {
					const element = { name: child.attributes.name, value: child.text === 'On' } as OneSwitch
					;(message as SetSwitchVector).elements[element.name] = element
					break
				}
				case 'oneLight': {
					const element = { name: child.attributes.name, value: child.text } as OneLight
					;(message as SetLightVector).elements[element.name] = element
					break
				}
				case 'oneBLOB': {
					const element = { name: child.attributes.name, size: child.attributes.size, format: child.attributes.format, value: child.text } as OneBlob
					;(message as SetBlobVector).elements[element.name] = element
					break
				}
			}
		}

		return message
	}

	protected handleTag(tag: IndiXmlElement) {
		const a = tag.attributes
		const protocol = this.options?.protocol

		switch (tag.name) {
			case 'message':
				if (protocol?.message) {
					protocol.message(this, { device: a.device, timestamp: a.timestamp, message: a.message })
				}
				break
			case 'delProperty':
				if (protocol?.delProperty) {
					protocol.delProperty(this, { device: a.device, name: a.name, timestamp: a.timestamp, message: a.message })
				}
				break
			case 'defTextVector':
				if (protocol?.defVector || protocol?.defTextVector || protocol?.textVector) {
					const message = this.parseDefVector(tag)
					protocol.defVector?.(this, message, tag.name)
					protocol.defTextVector?.(this, message as DefTextVector)
					protocol.textVector?.(this, message as TextVector, tag.name)
				}
				break
			case 'defNumberVector':
				if (protocol?.defVector || protocol?.defNumberVector || protocol?.numberVector) {
					const message = this.parseDefVector(tag)
					protocol.defVector?.(this, message, tag.name)
					protocol.defNumberVector?.(this, message as DefNumberVector)
					protocol.numberVector?.(this, message as NumberVector, tag.name)
				}
				break
			case 'defSwitchVector':
				if (protocol?.defVector || protocol?.defSwitchVector || protocol?.switchVector) {
					const message = this.parseDefVector(tag)
					protocol.defVector?.(this, message, tag.name)
					protocol.defSwitchVector?.(this, message as DefSwitchVector)
					protocol.switchVector?.(this, message as SwitchVector, tag.name)
				}
				break
			case 'defLightVector':
				if (protocol?.defVector || protocol?.defLightVector || protocol?.lightVector) {
					const message = this.parseDefVector(tag)
					protocol.defVector?.(this, message, tag.name)
					protocol.defLightVector?.(this, message as DefLightVector)
					protocol.lightVector?.(this, message as LightVector, tag.name)
				}
				break
			case 'defBLOBVector':
				if (protocol?.defVector || protocol?.defBlobVector || protocol?.blobVector) {
					const message = this.parseDefVector(tag)
					protocol.defVector?.(this, message, tag.name)
					protocol.defBlobVector?.(this, message as DefBlobVector)
					protocol.blobVector?.(this, message as BlobVector, tag.name)
				}
				break
			case 'setTextVector':
				if (protocol?.setVector || protocol?.setTextVector || protocol?.textVector) {
					const message = this.parseSetVector(tag)
					protocol.setVector?.(this, message, tag.name)
					protocol.setTextVector?.(this, message as SetTextVector)
					protocol.textVector?.(this, message as TextVector, tag.name)
				}
				break
			case 'setNumberVector':
				if (protocol?.setVector || protocol?.setNumberVector || protocol?.numberVector) {
					const message = this.parseSetVector(tag)
					protocol.setVector?.(this, message, tag.name)
					protocol.setNumberVector?.(this, message as SetNumberVector)
					protocol.numberVector?.(this, message as NumberVector, tag.name)
				}
				break
			case 'setSwitchVector':
				if (protocol?.setVector || protocol?.setSwitchVector || protocol?.switchVector) {
					const message = this.parseSetVector(tag)
					protocol.setVector?.(this, message, tag.name)
					protocol.setSwitchVector?.(this, message as SetSwitchVector)
					protocol.switchVector?.(this, message as SwitchVector, tag.name)
				}
				break
			case 'setLightVector':
				if (protocol?.setVector || protocol?.setLightVector || protocol?.lightVector) {
					const message = this.parseSetVector(tag)
					protocol.setVector?.(this, message, tag.name)
					protocol.setLightVector?.(this, message as SetLightVector)
					protocol.lightVector?.(this, message as LightVector, tag.name)
				}
				break
			case 'setBLOBVector':
				if (protocol?.setVector || protocol?.setBlobVector || protocol?.blobVector) {
					const message = this.parseSetVector(tag)
					protocol.setVector?.(this, message, tag.name)
					protocol.setBlobVector?.(this, message as SetBlobVector)
					protocol.blobVector?.(this, message as BlobVector, tag.name)
				}
				break
			default:
				console.warn(`unknown tag: ${tag.name}`)
		}
	}

	getProperties(command?: GetProperties) {
		if (this.socket) {
			this.socket.write(`<getProperties version="1.7"`)
			if (command?.device) this.socket.write(` device="${command.device}"`)
			if (command?.name) this.socket.write(` name="${command.name}"`)
			this.socket.write('></getProperties>')
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
			this.socket.write('<newTextVector')
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const name in command.elements) this.socket.write(`<oneText name="${name}">${command.elements[name].value}</oneText>`)
			this.socket.write('</newTextVector>')
			this.socket.flush()
		}
	}

	number(command: NewNumberVector) {
		if (this.socket) {
			this.socket.write('<newNumberVector')
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const name in command.elements) this.socket.write(`<oneNumber name="${name}">${command.elements[name].value}</oneNumber>`)
			this.socket.write('</newNumberVector>')
			this.socket.flush()
		}
	}

	switch(command: NewSwitchVector) {
		if (this.socket) {
			this.socket.write('<newSwitchVector')
			this.socket.write(` device="${command.device}"`)
			this.socket.write(` name="${command.name}"`)
			if (command.timestamp) this.socket.write(` timestamp="${command.timestamp}">`)
			for (const name in command.elements) this.socket.write(`<oneSwitch name="${name}">${command.elements[name].value ? 'On' : 'Off'}</oneSwitch>`)
			this.socket.write('</newSwitchVector>')
			this.socket.flush()
		}
	}
}

enum IndiXmlState {
	START,
	OPEN_TAG,
	ATTR,
	TAG_CONTENT,
	CLOSE_TAG,
}

export interface IndiXmlElement {
	name: string
	attributes: Record<string, string>
	text: string
	children: IndiXmlElement[]
}

const EMPTY_INDI_XML_ELEMENT: IndiXmlElement = {
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
	tags: IndiXmlElement[]
	state: IndiXmlState
	key: string
	value: string
	attrState: number
}

const EMPTY_PARSED_TAG_CONTEXT: ParsedTagContext = {
	tags: [],
	state: IndiXmlState.START,
	key: '',
	value: '',
	attrState: 0,
}

export class IndiXmlParser {
	private readonly context: ParsedTagContext[] = []
	private prevCode = 0

	private get currentLevel() {
		return this.context.length - 1
	}

	private get currentContext(): ParsedTagContext | undefined {
		return this.context[this.currentLevel]
	}

	private get currentTag(): IndiXmlElement | undefined {
		const context = this.currentContext
		return context?.tags[context.tags.length - 1]
	}

	private newContext(state: IndiXmlState = IndiXmlState.START) {
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
		const tags: IndiXmlElement[] = []

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
			case IndiXmlState.START:
				if (code === OPEN_ANGLE) {
					const context = this.newContext(IndiXmlState.OPEN_TAG)
					context.tags.push(structuredClone(EMPTY_INDI_XML_ELEMENT))
				}

				break
			case IndiXmlState.OPEN_TAG:
				if ((code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER)) {
					tag.name += char
				} else if (code === WHITESPACE) {
					context.state = IndiXmlState.ATTR
				} else if (code === CLOSE_ANGLE) {
					context.state = IndiXmlState.TAG_CONTENT
				}

				break
			case IndiXmlState.ATTR:
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
					context.state = IndiXmlState.TAG_CONTENT
				}

				break
			case IndiXmlState.TAG_CONTENT:
				if (code === OPEN_ANGLE) {
					// can be "/" or letter
				} else if (code === SLASH && this.prevCode === OPEN_ANGLE) {
					tag.text = tag.text.trim()
					context.state = IndiXmlState.CLOSE_TAG
				} else if (this.prevCode === OPEN_ANGLE) {
					const context = this.newContext(IndiXmlState.OPEN_TAG)
					const tag = structuredClone(EMPTY_INDI_XML_ELEMENT)
					tag.name = char
					context.tags.push(tag)
				} else if (code !== OPEN_ANGLE && code !== 13 && code !== 10) {
					tag.text += char
				}

				break
			case IndiXmlState.CLOSE_TAG:
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
				console.warn(`unknown state: ${context.state}`)
		}

		this.prevCode = code

		return undefined
	}
}
