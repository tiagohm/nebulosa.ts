import type { Client } from './device'
// oxfmt-ignore
import type { DefBlob, DefBlobVector, DefLight, DefLightVector, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, DefVector, DelProperty, EnableBlob, GetProperties, Message, NewNumberVector, NewSwitchVector, NewTextVector, OneBlob, OneLight, OneNumber, OneSwitch, OneText, PropertyState, SetBlobVector, SetLightVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, SwitchRule, VectorType } from './types'
import { SimpleXmlParser, type XmlNode } from '../../io/xml'

// INDI protocol client over a TCP socket: parses the streamed XML messages into typed property vectors,
// dispatches them to a handler, and serializes outgoing getProperties/enableBLOB/newXXX commands.
// A simple XML-like communications protocol is described for
// interactive and automated remote control of diverse instrumentation.
// http://www.clearskyinstitute.com/INDI/INDI.pdf

// Optional callbacks for received INDI messages. Each property kind can be observed at several
// granularities (per-tag def*/set*, per-type *Vector, generic def/set/vector); a handler subscribes to
// whichever level it needs and the dispatch helpers invoke every matching callback.
export interface IndiClientHandler {
	readonly message?: (client: Client, message: Message) => void
	readonly delProperty?: (client: Client, message: DelProperty) => void
	readonly vector?: (client: Client, message: DefVector | SetVector, tag: `def${VectorType}Vector` | `set${VectorType}Vector`) => void
	readonly defTextVector?: (client: Client, message: DefTextVector) => void
	readonly defNumberVector?: (client: Client, message: DefNumberVector) => void
	readonly defSwitchVector?: (client: Client, message: DefSwitchVector) => void
	readonly defLightVector?: (client: Client, message: DefLightVector) => void
	readonly defBlobVector?: (client: Client, message: DefBlobVector) => void
	readonly defVector?: (client: Client, message: DefVector, tag: `def${VectorType}Vector`) => void
	readonly setTextVector?: (client: Client, message: SetTextVector) => void
	readonly setNumberVector?: (client: Client, message: SetNumberVector) => void
	readonly setSwitchVector?: (client: Client, message: SetSwitchVector) => void
	readonly setLightVector?: (client: Client, message: SetLightVector) => void
	readonly setBlobVector?: (client: Client, message: SetBlobVector) => void
	readonly setVector?: (client: Client, message: SetVector, tag: `set${VectorType}Vector`) => void
	readonly textVector?: (client: Client, message: DefTextVector | SetTextVector, tag: 'defTextVector' | 'setTextVector') => void
	readonly numberVector?: (client: Client, message: DefNumberVector | SetNumberVector, tag: 'defNumberVector' | 'setNumberVector') => void
	readonly switchVector?: (client: Client, message: DefSwitchVector | SetSwitchVector, tag: 'defSwitchVector' | 'setSwitchVector') => void
	readonly lightVector?: (client: Client, message: DefLightVector | SetLightVector, tag: 'defLightVector' | 'setLightVector') => void
	readonly blobVector?: (client: Client, message: DefBlobVector | SetBlobVector, tag: 'defBLOBVector' | 'setBLOBVector') => void
	readonly close?: (client: Client, server: boolean) => void
}

// Options for an IndiClient.
export interface IndiClientOptions {
	handler?: IndiClientHandler
}

// Default INDI server TCP port.
export const DEFAULT_INDI_PORT = 7624

// INDI client connected to an `indiserver` over TCP. Streams and parses INDI XML, exposes the standard
// Client send* commands, and reports an MD5 identity derived from the remote endpoint.
export class IndiClient implements Client {
	readonly type = 'INDI'

	description: string = 'INDI Client'

	readonly #parser = new SimpleXmlParser()
	#socket?: Bun.Socket
	// Cached [id, remoteHost, remotePort] populated on connect.
	readonly #metadata: [string?, string?, number?] = []

	constructor(readonly options?: IndiClientOptions) {}

	// Stable MD5 identity derived from the remote endpoint (set on connect).
	get id() {
		return this.#metadata[0]!
	}

	// Hostname passed to connect().
	get remoteHost() {
		return this.#metadata[1]
	}

	// Remote TCP port.
	get remotePort() {
		return this.#metadata[2]
	}

	// Resolved remote IP address of the socket.
	get remoteIp() {
		return this.#socket?.remoteAddress
	}

	// Local TCP port of the socket.
	get localPort() {
		return this.#socket?.localPort
	}

	// Whether the socket is currently connected.
	get connected() {
		return !!this.#socket
	}

	// Connects to the INDI server, wiring socket events into the parser and requesting all properties on
	// open. Returns false if already connected.
	async connect(hostname: string, port: number = DEFAULT_INDI_PORT, options?: Omit<Bun.TCPSocketConnectOptions, 'hostname' | 'port' | 'socket' | 'data'>) {
		if (this.#socket) return false

		this.#socket = await Bun.connect({
			...options,
			hostname,
			port,
			socket: {
				data: (_, data) => {
					this.parse(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.#socket = socket
					this.getProperties()
				},
				close: () => {
					console.warn('connection closed by client')
					this.#socket = undefined
					this.options?.handler?.close?.(this, false)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
				},
				end: () => {
					console.warn('connection closed by server')
					this.#socket = undefined
					this.options?.handler?.close?.(this, true)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})

		const { remoteAddress, remotePort } = this.#socket
		this.#metadata[0] = Bun.MD5.hash(`${remoteAddress}:${remotePort}:INDI`, 'hex')
		this.#metadata[1] = hostname
		this.#metadata[2] = remotePort

		this.description = `INDI Client at ${remoteAddress}:${remotePort}`

		return true
	}

	// Terminates the connection.
	close() {
		this.#socket?.terminate()
		this.#socket = undefined
	}

	[Symbol.dispose]() {
		this.close()
	}

	// Feeds received bytes through the XML parser and dispatches each completed node.
	parse(data: Buffer) {
		for (const node of this.#parser.parse(data)) {
			this.#processNode(node)
		}
	}

	// Parses a defXXXVector XML node into a typed DefVector (with element definitions and, for switches,
	// the selection rule).
	parseDefVector(node: XmlNode) {
		const message = {
			device: node.attributes.device,
			name: node.attributes.name,
			label: node.attributes.label,
			group: node.attributes.group,
			state: node.attributes.state,
			permission: node.attributes.perm,
			timeout: +node.attributes.timeout,
			timestamp: node.attributes.timestamp,
			message: node.attributes.message,
			elements: createElementRecord(),
		} as DefVector

		if (node.name === 'defSwitchVector') {
			;(message as DefSwitchVector).rule = node.attributes.rule as SwitchRule
		}

		for (const child of node.children) {
			switch (child.name) {
				case 'defText': {
					const element = { name: child.attributes.name, label: child.attributes.label, value: child.text } as DefText
					;(message as DefTextVector).elements[element.name] = element
					break
				}
				case 'defNumber': {
					const element = { name: child.attributes.name, label: child.attributes.label, format: child.attributes.format, min: +child.attributes.min, max: +child.attributes.max, step: +child.attributes.step, value: +child.text } as DefNumber
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

	// Parses a setXXXVector XML node into a typed SetVector. Number elements may carry an updated
	// min/max/step range (INDI's IUUpdateMinMax), which is preserved.
	parseSetVector(node: XmlNode) {
		const message = {
			device: node.attributes.device,
			name: node.attributes.name,
			state: node.attributes.state,
			timeout: +node.attributes.timeout,
			timestamp: node.attributes.timestamp,
			message: node.attributes.message,
			elements: createElementRecord(),
		} as SetVector

		for (const child of node.children) {
			switch (child.name) {
				case 'oneText': {
					const element: OneText = { name: child.attributes.name, value: child.text }
					;(message as SetTextVector).elements[element.name] = element
					break
				}
				case 'oneNumber': {
					const a = child.attributes
					const element: OneNumber = { name: a.name, value: +child.text }
					// INDI's IUUpdateMinMax updates a number's range through a set vector; keep it.
					if (a.min !== undefined) element.min = +a.min
					if (a.max !== undefined) element.max = +a.max
					if (a.step !== undefined) element.step = +a.step
					;(message as SetNumberVector).elements[element.name] = element
					break
				}
				case 'oneSwitch': {
					const element: OneSwitch = { name: child.attributes.name, value: child.text === 'On' }
					;(message as SetSwitchVector).elements[element.name] = element
					break
				}
				case 'oneLight': {
					const element: OneLight = { name: child.attributes.name, value: child.text as PropertyState }
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

	// Dispatches one parsed XML node to the appropriate handler callbacks, parsing vectors lazily only
	// when a relevant handler is registered. newXXX tags (client→device) are ignored on the client side.
	#processNode(node: XmlNode) {
		const a = node.attributes
		const handler = this.options?.handler

		switch (node.name) {
			case 'message':
				if (handler?.message) {
					handler.message(this, { id: Bun.randomUUIDv7(), device: a.device, timestamp: a.timestamp, message: a.message })
				}
				break
			case 'delProperty':
				if (handler?.delProperty) {
					handler.delProperty(this, { device: a.device, name: a.name, timestamp: a.timestamp, message: a.message })
				}
				break
			case 'defTextVector':
				if (handler?.defVector || handler?.defTextVector || handler?.textVector || handler?.vector) {
					handleDefTextVector(this, handler, this.parseDefVector(node) as never)
				}
				break
			case 'defNumberVector':
				if (handler?.defVector || handler?.defNumberVector || handler?.numberVector || handler?.vector) {
					handleDefNumberVector(this, handler, this.parseDefVector(node) as never)
				}
				break
			case 'defSwitchVector':
				if (handler?.defVector || handler?.defSwitchVector || handler?.switchVector || handler?.vector) {
					handleDefSwitchVector(this, handler, this.parseDefVector(node) as never)
				}
				break
			case 'defLightVector':
				if (handler?.defVector || handler?.defLightVector || handler?.lightVector || handler?.vector) {
					handleDefLightVector(this, handler, this.parseDefVector(node) as never)
				}
				break
			case 'defBLOBVector':
				if (handler?.defVector || handler?.defBlobVector || handler?.blobVector || handler?.vector) {
					handleDefBlobVector(this, handler, this.parseDefVector(node) as never)
				}
				break
			case 'setTextVector':
				if (handler?.setVector || handler?.setTextVector || handler?.textVector || handler?.vector) {
					handleSetTextVector(this, handler, this.parseSetVector(node) as never)
				}
				break
			case 'setNumberVector':
				if (handler?.setVector || handler?.setNumberVector || handler?.numberVector || handler?.vector) {
					handleSetNumberVector(this, handler, this.parseSetVector(node) as never)
				}
				break
			case 'setSwitchVector':
				if (handler?.setVector || handler?.setSwitchVector || handler?.switchVector || handler?.vector) {
					handleSetSwitchVector(this, handler, this.parseSetVector(node) as never)
				}
				break
			case 'setLightVector':
				if (handler?.setVector || handler?.setLightVector || handler?.lightVector || handler?.vector) {
					handleSetLightVector(this, handler, this.parseSetVector(node) as never)
				}
				break
			case 'setBLOBVector':
				if (handler?.setVector || handler?.setBlobVector || handler?.blobVector || handler?.vector) {
					handleSetBlobVector(this, handler, this.parseSetVector(node) as never)
				}
				break
			case 'newSwitchVector':
			case 'newNumberVector':
			case 'newTextVector':
			case 'newBLOBVector':
				// Ignore it
				break
			default:
				console.warn(`unknown tag: ${node.name}`)
		}
	}

	// Sends a getProperties request (optionally scoped to a device/property) to ask the server to define
	// its properties.
	getProperties(command?: GetProperties) {
		let message = '<getProperties version="1.7"'
		if (command?.device) message += ` device="${escapeXmlAttribute(command.device)}"`
		if (command?.name) message += ` name="${escapeXmlAttribute(command.name)}"`
		this.#writeXml(`${message}></getProperties>`)
	}

	// Sets the BLOB delivery policy for a device/property channel (Never/Also/Only).
	enableBlob(command: EnableBlob) {
		let message = `<enableBLOB device="${escapeXmlAttribute(command.device)}"`
		if (command.name) message += ` name="${escapeXmlAttribute(command.name)}"`
		this.#writeXml(`${message}>${escapeXmlText(command.value)}</enableBLOB>`)
	}

	// Sends new target values for a text/number/switch property (newXXXVector). Switch values are encoded
	// as On/Off.
	sendText(vector: NewTextVector) {
		let message = `<newTextVector device="${escapeXmlAttribute(vector.device)}" name="${escapeXmlAttribute(vector.name)}"`
		if (vector.timestamp !== undefined) message += ` timestamp="${escapeXmlAttribute(vector.timestamp)}"`
		message += '>'

		for (const [name, value] of Object.entries(vector.elements)) {
			message += `<oneText name="${escapeXmlAttribute(name)}">${escapeXmlText(value)}</oneText>`
		}

		this.#writeXml(`${message}</newTextVector>`)
	}

	sendNumber(vector: NewNumberVector) {
		let message = `<newNumberVector device="${escapeXmlAttribute(vector.device)}" name="${escapeXmlAttribute(vector.name)}"`
		if (vector.timestamp !== undefined) message += ` timestamp="${escapeXmlAttribute(vector.timestamp)}"`
		message += '>'

		for (const [name, value] of Object.entries(vector.elements)) {
			message += `<oneNumber name="${escapeXmlAttribute(name)}">${escapeXmlText(value)}</oneNumber>`
		}

		this.#writeXml(`${message}</newNumberVector>`)
	}

	sendSwitch(vector: NewSwitchVector) {
		let message = `<newSwitchVector device="${escapeXmlAttribute(vector.device)}" name="${escapeXmlAttribute(vector.name)}"`
		if (vector.timestamp !== undefined) message += ` timestamp="${escapeXmlAttribute(vector.timestamp)}"`
		message += '>'

		for (const [name, value] of Object.entries(vector.elements)) {
			message += `<oneSwitch name="${escapeXmlAttribute(name)}">${value ? 'On' : 'Off'}</oneSwitch>`
		}

		this.#writeXml(`${message}</newSwitchVector>`)
	}

	// Writes a serialized XML message to the socket and flushes, no-op when disconnected.
	#writeXml(message: string) {
		if (!this.#socket) return
		this.#socket.write(message)
		this.#socket.flush()
	}
}

// A set of handlers that is itself a handler: each callback fans out to every member. Lets multiple
// consumers observe the same client.
export class IndiClientHandlerSet extends Set<IndiClientHandler> implements IndiClientHandler {
	message(client: Client, message: Message) {
		for (const handler of this) handler.message?.(client, message)
	}

	delProperty(client: Client, message: DelProperty) {
		for (const handler of this) handler.delProperty?.(client, message)
	}

	vector(client: Client, message: DefVector | SetVector, tag: `def${VectorType}Vector` | `set${VectorType}Vector`) {
		for (const handler of this) handler.vector?.(client, message, tag)
	}

	defTextVector(client: Client, message: DefTextVector) {
		for (const handler of this) handler.defTextVector?.(client, message)
	}

	defNumberVector(client: Client, message: DefNumberVector) {
		for (const handler of this) handler.defNumberVector?.(client, message)
	}

	defSwitchVector(client: Client, message: DefSwitchVector) {
		for (const handler of this) handler.defSwitchVector?.(client, message)
	}

	defLightVector(client: Client, message: DefLightVector) {
		for (const handler of this) handler.defLightVector?.(client, message)
	}

	defBlobVector(client: Client, message: DefBlobVector) {
		for (const handler of this) handler.defBlobVector?.(client, message)
	}

	defVector(client: Client, message: DefVector, tag: `def${VectorType}Vector`) {
		for (const handler of this) handler.defVector?.(client, message, tag)
	}

	setTextVector(client: Client, message: SetTextVector) {
		for (const handler of this) handler.setTextVector?.(client, message)
	}

	setNumberVector(client: Client, message: SetNumberVector) {
		for (const handler of this) handler.setNumberVector?.(client, message)
	}

	setSwitchVector(client: Client, message: SetSwitchVector) {
		for (const handler of this) handler.setSwitchVector?.(client, message)
	}

	setLightVector(client: Client, message: SetLightVector) {
		for (const handler of this) handler.setLightVector?.(client, message)
	}

	setBlobVector(client: Client, message: SetBlobVector) {
		for (const handler of this) handler.setBlobVector?.(client, message)
	}

	setVector(client: Client, message: SetVector, tag: `set${VectorType}Vector`) {
		for (const handler of this) handler.setVector?.(client, message, tag)
	}

	textVector(client: Client, message: DefTextVector | SetTextVector, tag: 'defTextVector' | 'setTextVector') {
		for (const handler of this) handler.textVector?.(client, message, tag)
	}

	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: 'defNumberVector' | 'setNumberVector') {
		for (const handler of this) handler.numberVector?.(client, message, tag)
	}

	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: 'defSwitchVector' | 'setSwitchVector') {
		for (const handler of this) handler.switchVector?.(client, message, tag)
	}

	lightVector(client: Client, message: DefLightVector | SetLightVector, tag: 'defLightVector' | 'setLightVector') {
		for (const handler of this) handler.lightVector?.(client, message, tag)
	}

	blobVector(client: Client, message: DefBlobVector | SetBlobVector, tag: 'defBLOBVector' | 'setBLOBVector') {
		for (const handler of this) handler.blobVector?.(client, message, tag)
	}

	close(client: Client, server: boolean) {
		for (const handler of this) handler.close?.(client, server)
	}
}

// Dispatch helpers: each invokes every handler callback that applies to a given def*/set* vector, from
// the most specific (per-tag) down to the generic (defVector/setVector and vector). Reused by both the
// client's parser and the other backends so handlers see a uniform event stream regardless of source.
export function handleDefVector(client: Client, handler: IndiClientHandler, message: DefVector, tag: `def${VectorType}Vector`) {
	handler.defVector?.(client, message, tag)
	handler.vector?.(client, message, tag)
}

export function handleDefTextVector(client: Client, handler: IndiClientHandler, message: DefTextVector) {
	handler.defTextVector?.(client, message)
	handler.textVector?.(client, message, 'defTextVector')
	handleDefVector(client, handler, message, 'defTextVector')
}

export function handleDefNumberVector(client: Client, handler: IndiClientHandler, message: DefNumberVector) {
	handler.defNumberVector?.(client, message)
	handler.numberVector?.(client, message, 'defNumberVector')
	handleDefVector(client, handler, message, 'defNumberVector')
}

export function handleDefSwitchVector(client: Client, handler: IndiClientHandler, message: DefSwitchVector) {
	handler.defSwitchVector?.(client, message)
	handler.switchVector?.(client, message, 'defSwitchVector')
	handleDefVector(client, handler, message, 'defSwitchVector')
}

export function handleDefLightVector(client: Client, handler: IndiClientHandler, message: DefLightVector) {
	handler.defLightVector?.(client, message)
	handler.lightVector?.(client, message, 'defLightVector')
	handleDefVector(client, handler, message, 'defLightVector')
}

export function handleDefBlobVector(client: Client, handler: IndiClientHandler, message: DefBlobVector) {
	handler.defBlobVector?.(client, message)
	handler.blobVector?.(client, message, 'defBLOBVector')
	handleDefVector(client, handler, message, 'defBLOBVector')
}

export function handleSetVector(client: Client, handler: IndiClientHandler, message: SetVector, tag: `set${VectorType}Vector`) {
	handler.setVector?.(client, message, tag)
	handler.vector?.(client, message, tag)
}

export function handleSetTextVector(client: Client, handler: IndiClientHandler, message: SetTextVector) {
	handler.setTextVector?.(client, message)
	handler.textVector?.(client, message, 'setTextVector')
	handleSetVector(client, handler, message, 'setTextVector')
}

export function handleSetNumberVector(client: Client, handler: IndiClientHandler, message: SetNumberVector) {
	handler.setNumberVector?.(client, message)
	handler.numberVector?.(client, message, 'setNumberVector')
	handleSetVector(client, handler, message, 'setNumberVector')
}

export function handleSetSwitchVector(client: Client, handler: IndiClientHandler, message: SetSwitchVector) {
	handler.setSwitchVector?.(client, message)
	handler.switchVector?.(client, message, 'setSwitchVector')
	handleSetVector(client, handler, message, 'setSwitchVector')
}

export function handleSetLightVector(client: Client, handler: IndiClientHandler, message: SetLightVector) {
	handler.setLightVector?.(client, message)
	handler.lightVector?.(client, message, 'setLightVector')
	handleSetVector(client, handler, message, 'setLightVector')
}

export function handleSetBlobVector(client: Client, handler: IndiClientHandler, message: SetBlobVector) {
	handler.setBlobVector?.(client, message)
	handler.blobVector?.(client, message, 'setBLOBVector')
	handleSetVector(client, handler, message, 'setBLOBVector')
}

// Notifies the handler of a property (or device) deletion for each supplied vector.
export function handleDelProperty(client: Client, handler: IndiClientHandler, ...messages: DefVector[]) {
	if (handler.delProperty) {
		for (const message of messages) {
			handler.delProperty(client, message)
		}
	}
}

// Creates a prototype-less record for element maps so element names never collide with Object members.
function createElementRecord<T>() {
	return Object.create(null) as Record<string, T>
}

// XML-escapes a value for use in an attribute (escapes quotes) or text content (does not).
function escapeXmlAttribute(value: string | number | boolean) {
	return escapeXml(value, true)
}

function escapeXmlText(value: string | number | boolean) {
	return escapeXml(value, false)
}

// Escapes &, <, > (and " in attribute mode) in a single pass, returning the original string unchanged
// when nothing needed escaping.
function escapeXml(value: string | number | boolean, attribute: boolean) {
	const text = String(value)
	let escaped = ''
	let start = 0

	for (let i = 0; i < text.length; i++) {
		let replacement = ''

		switch (text.charCodeAt(i)) {
			case 34:
				if (attribute) replacement = '&quot;'
				break
			case 38:
				replacement = '&amp;'
				break
			case 60:
				replacement = '&lt;'
				break
			case 62:
				replacement = '&gt;'
				break
		}

		if (replacement) {
			escaped += text.slice(start, i) + replacement
			start = i + 1
		}
	}

	return start === 0 ? text : escaped + text.slice(start)
}
