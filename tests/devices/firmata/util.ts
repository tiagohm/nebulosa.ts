import type { PinMode, TwoWireAddressMode, TwoWireAutoRestartMode, OneWirePowerMode, OneWireSearchMode, FirmataClientHandler, Pin } from '../../../src/devices/firmata/types'

export type MockFirmataMessage =
	| readonly ['mode', number, PinMode]
	| readonly ['analogReport', number, boolean]
	| readonly ['config', number]
	| readonly ['write', number, Buffer]
	| readonly ['read', number, number, number, boolean, TwoWireAddressMode, TwoWireAutoRestartMode]
	| readonly ['oneWireConfig', number, OneWirePowerMode]
	| readonly ['oneWireSearch', number, OneWireSearchMode]
	| readonly ['oneWireWrite', number, Buffer, Buffer | undefined]
	| readonly ['oneWireWriteAndRead', number, Buffer, number, Buffer | undefined, number]

export class MockFirmataClient {
	readonly messages: MockFirmataMessage[] = []
	readonly handlers = new Set<FirmataClientHandler>()
	// Cached pin values keyed by id; empty by default so pinAt returns undefined (no initial sample).
	readonly pins = new Map<number, Pin>()

	#oneWireCorrelationId = 0x4000

	pinAt(id: number) {
		return this.pins.get(id)
	}

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	pinMode(pin: number, mode: PinMode) {
		this.messages.push(['mode', pin, mode])
	}

	requestAnalogPinReport(pin: number, enable: boolean) {
		this.messages.push(['analogReport', pin, enable])
	}

	twoWireConfig(delayInMicroseconds: number) {
		this.messages.push(['config', delayInMicroseconds])
	}

	twoWireWrite(address: number, data?: Buffer | readonly number[]) {
		this.messages.push(['write', address, Buffer.from(data ?? [])])
	}

	twoWireRead(address: number, register: number, bytesToRead: number, continuous: boolean = false, addressMode: 7 | 10 = 7, autoRestart: 'stop' | 'restart' = 'stop') {
		this.messages.push(['read', address, register, bytesToRead, continuous, addressMode, autoRestart])
	}

	oneWireConfig(pin: number, powerMode: OneWirePowerMode = 'normal') {
		this.messages.push(['oneWireConfig', pin, powerMode])
	}

	oneWireSearch(pin: number, mode: OneWireSearchMode = 'all') {
		this.messages.push(['oneWireSearch', pin, mode])
	}

	oneWireWrite(pin: number, data: Buffer | readonly number[], address?: Buffer | readonly number[]) {
		this.messages.push(['oneWireWrite', pin, Buffer.from(data), address ? Buffer.from(address) : undefined])
	}

	oneWireWriteAndRead(pin: number, data: Buffer | readonly number[], bytesToRead: number, address?: Buffer | readonly number[]) {
		const correlationId = this.#oneWireCorrelationId
		this.#oneWireCorrelationId = (this.#oneWireCorrelationId + 1) & 0xffff
		this.messages.push(['oneWireWriteAndRead', pin, Buffer.from(data), bytesToRead, address ? Buffer.from(address) : undefined, correlationId])
		return correlationId
	}
}
