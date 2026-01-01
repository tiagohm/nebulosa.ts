// biome-ignore format: too long!
import type { DefBlob, DefBlobVector, DefLight, DefLightVector, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, DefVector, DelProperty, EnableBlob, GetProperties, Message, NewNumberVector, NewSwitchVector, NewTextVector, OneBlob, OneLight, OneNumber, OneSwitch, OneText, SetBlobVector, SetLightVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, SwitchRule, VectorType } from './indi.types'
import { SimpleXmlParser, type XmlNode } from './xml'

// A simple XML-like communications protocol is described for
// interactive and automated remote control of diverse instrumentation.
// http://www.clearskyinstitute.com/INDI/INDI.pdf

export interface IndiClientHandler {
	message?: (client: IndiClient, message: Message) => void
	delProperty?: (client: IndiClient, message: DelProperty) => void
	vector?: (client: IndiClient, message: DefVector | SetVector, tag: `def${VectorType}Vector` | `set${VectorType}Vector`) => void
	defTextVector?: (client: IndiClient, message: DefTextVector) => void
	defNumberVector?: (client: IndiClient, message: DefNumberVector) => void
	defSwitchVector?: (client: IndiClient, message: DefSwitchVector) => void
	defLightVector?: (client: IndiClient, message: DefLightVector) => void
	defBlobVector?: (client: IndiClient, message: DefBlobVector) => void
	defVector?: (client: IndiClient, message: DefVector, tag: `def${VectorType}Vector`) => void
	setTextVector?: (client: IndiClient, message: SetTextVector) => void
	setNumberVector?: (client: IndiClient, message: SetNumberVector) => void
	setSwitchVector?: (client: IndiClient, message: SetSwitchVector) => void
	setLightVector?: (client: IndiClient, message: SetLightVector) => void
	setBlobVector?: (client: IndiClient, message: SetBlobVector) => void
	setVector?: (client: IndiClient, message: SetVector, tag: `set${VectorType}Vector`) => void
	textVector?: (client: IndiClient, message: DefTextVector | SetTextVector, tag: 'defTextVector' | 'setTextVector') => void
	numberVector?: (client: IndiClient, message: DefNumberVector | SetNumberVector, tag: 'defNumberVector' | 'setNumberVector') => void
	switchVector?: (client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: 'defSwitchVector' | 'setSwitchVector') => void
	lightVector?: (client: IndiClient, message: DefLightVector | SetLightVector, tag: 'defLightVector' | 'setLightVector') => void
	blobVector?: (client: IndiClient, message: DefBlobVector | SetBlobVector, tag: 'defBLOBVector' | 'setBLOBVector') => void
	close?: (client: IndiClient, server: boolean) => void
}

export interface IndiClientOptions {
	handler?: IndiClientHandler
}

export const DEFAULT_INDI_PORT = 7624

export class IndiClient {
	private readonly parser = new SimpleXmlParser()
	private socket?: Bun.Socket
	private readonly metadata: [string?, string?, number?] = []

	constructor(private readonly options?: IndiClientOptions) {}

	get id() {
		return this.metadata[0]
	}

	get remoteHost() {
		return this.metadata[1]
	}

	get remotePort() {
		return this.metadata[2]
	}

	get remoteIp() {
		return this.socket?.remoteAddress
	}

	get localPort() {
		return this.socket?.localPort
	}

	get connected() {
		return !!this.socket
	}

	async connect(hostname: string, port: number = DEFAULT_INDI_PORT, options?: Omit<Bun.TCPSocketConnectOptions, 'hostname' | 'port' | 'socket' | 'data'>) {
		if (this.socket) return false

		this.socket = await Bun.connect({
			...options,
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
					this.options?.handler?.close?.(this, false)
				},
				error: (_, error) => {
					console.error('error', error)
				},
				connectError: (_, error) => {
					console.error('connection error', error)
				},
				end: () => {
					console.warn('connection closed by server')
					this.socket = undefined
					this.options?.handler?.close?.(this, true)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})

		this.metadata[0] = Bun.MD5.hash(`${this.socket.remoteAddress}:${this.socket.remotePort}:INDI`, 'hex')
		this.metadata[1] = hostname
		this.metadata[2] = this.socket.remotePort

		return true
	}

	close() {
		this.socket?.terminate()
		this.socket = undefined
	}

	parse(data: Buffer) {
		for (const node of this.parser.parse(data)) {
			this.processNode(node)
		}
	}

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
			elements: {},
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

	parseSetVector(node: XmlNode) {
		const message = {
			device: node.attributes.device,
			name: node.attributes.name,
			state: node.attributes.state,
			timeout: +node.attributes.timeout,
			timestamp: node.attributes.timestamp,
			message: node.attributes.message,
			elements: {},
		} as SetVector

		for (const child of node.children) {
			switch (child.name) {
				case 'oneText': {
					const element = { name: child.attributes.name, value: child.text } as OneText
					;(message as SetTextVector).elements[element.name] = element
					break
				}
				case 'oneNumber': {
					const element = { name: child.attributes.name, value: +child.text } as OneNumber
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

	private processNode(node: XmlNode) {
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
					const message = this.parseDefVector(node)
					handler.defVector?.(this, message, node.name)
					handler.defTextVector?.(this, message as never)
					handler.textVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'defNumberVector':
				if (handler?.defVector || handler?.defNumberVector || handler?.numberVector || handler?.vector) {
					const message = this.parseDefVector(node)
					handler.defVector?.(this, message, node.name)
					handler.defNumberVector?.(this, message as never)
					handler.numberVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'defSwitchVector':
				if (handler?.defVector || handler?.defSwitchVector || handler?.switchVector || handler?.vector) {
					const message = this.parseDefVector(node)
					handler.defVector?.(this, message, node.name)
					handler.defSwitchVector?.(this, message as never)
					handler.switchVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'defLightVector':
				if (handler?.defVector || handler?.defLightVector || handler?.lightVector || handler?.vector) {
					const message = this.parseDefVector(node)
					handler.defVector?.(this, message, node.name)
					handler.defLightVector?.(this, message as never)
					handler.lightVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'defBLOBVector':
				if (handler?.defVector || handler?.defBlobVector || handler?.blobVector || handler?.vector) {
					const message = this.parseDefVector(node)
					handler.defVector?.(this, message, node.name)
					handler.defBlobVector?.(this, message as never)
					handler.blobVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'setTextVector':
				if (handler?.setVector || handler?.setTextVector || handler?.textVector || handler?.vector) {
					const message = this.parseSetVector(node)
					handler.setVector?.(this, message, node.name)
					handler.setTextVector?.(this, message as never)
					handler.textVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'setNumberVector':
				if (handler?.setVector || handler?.setNumberVector || handler?.numberVector || handler?.vector) {
					const message = this.parseSetVector(node)
					handler.setVector?.(this, message, node.name)
					handler.setNumberVector?.(this, message as never)
					handler.numberVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'setSwitchVector':
				if (handler?.setVector || handler?.setSwitchVector || handler?.switchVector || handler?.vector) {
					const message = this.parseSetVector(node)
					handler.setVector?.(this, message, node.name)
					handler.setSwitchVector?.(this, message as never)
					handler.switchVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'setLightVector':
				if (handler?.setVector || handler?.setLightVector || handler?.lightVector || handler?.vector) {
					const message = this.parseSetVector(node)
					handler.setVector?.(this, message, node.name)
					handler.setLightVector?.(this, message as never)
					handler.lightVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
				}
				break
			case 'setBLOBVector':
				if (handler?.setVector || handler?.setBlobVector || handler?.blobVector || handler?.vector) {
					const message = this.parseSetVector(node)
					handler.setVector?.(this, message, node.name)
					handler.setBlobVector?.(this, message as never)
					handler.blobVector?.(this, message as never, node.name)
					handler.vector?.(this, message, node.name)
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

	sendText(vector: NewTextVector) {
		if (this.socket) {
			this.socket.write('<newTextVector')
			this.socket.write(` device="${vector.device}"`)
			this.socket.write(` name="${vector.name}"`)
			this.socket.write(` timestamp="${vector.timestamp ?? ''}">`)
			for (const name in vector.elements) this.socket.write(`<oneText name="${name}">${vector.elements[name]}</oneText>`)
			this.socket.write('</newTextVector>')
			this.socket.flush()
		}
	}

	sendNumber(vector: NewNumberVector) {
		if (this.socket) {
			this.socket.write('<newNumberVector')
			this.socket.write(` device="${vector.device}"`)
			this.socket.write(` name="${vector.name}"`)
			this.socket.write(` timestamp="${vector.timestamp ?? ''}">`)
			for (const name in vector.elements) this.socket.write(`<oneNumber name="${name}">${vector.elements[name]}</oneNumber>`)
			this.socket.write('</newNumberVector>')
			this.socket.flush()
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		if (this.socket) {
			this.socket.write('<newSwitchVector')
			this.socket.write(` device="${vector.device}"`)
			this.socket.write(` name="${vector.name}"`)
			this.socket.write(` timestamp="${vector.timestamp ?? ''}">`)
			for (const name in vector.elements) this.socket.write(`<oneSwitch name="${name}">${vector.elements[name] ? 'On' : 'Off'}</oneSwitch>`)
			this.socket.write('</newSwitchVector>')
			this.socket.flush()
		}
	}
}
