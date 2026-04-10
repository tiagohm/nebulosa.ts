import type { Angle } from './angle'
import type { Distance } from './distance'
import type { FirmataClient, FirmataClientHandler, Pin, PinMode } from './firmata'
import type { Pressure } from './pressure'
import type { Temperature } from './temperature'

export type PeripheralListener<D extends Peripheral<D>> = (device: D) => void

export type RadioTunerSeekDirection = 'up' | 'down'

export interface Peripheral<D extends Peripheral<D> = never> extends Disposable {
	readonly name: string
	readonly client: FirmataClient
	readonly addListener: (listener: PeripheralListener<D>) => void
	readonly removeListener: (listener: PeripheralListener<D>) => void
	readonly start: () => void
	readonly stop: () => void
}

export interface Thermometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly temperature: Temperature
}

export interface Hygrometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly humidity: number
}

export interface Barometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly pressure: Pressure
}

export interface Altimeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly altitude: Distance
}

export interface Luxmeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly lux: number
}

export interface Ammeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly current: number // A
}

export interface Accelerometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly ax: number // m/s^2
	readonly ay: number // m/s^2
	readonly az: number // m/s^2
}

export interface Gyroscope extends Pick<Peripheral, 'name' | 'client'> {
	readonly gx: Angle // rad/s
	readonly gy: Angle // rad/s
	readonly gz: Angle // rad/s
}

export interface Magnetometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly x: number // gauss
	readonly y: number // gauss
	readonly z: number // gauss
}

export interface RadioTuner extends Pick<Peripheral, 'name' | 'client'> {
	frequency: number // MHz
	volume: number // 0..100
	muted: boolean
	stereo: boolean
	readonly seekFailed?: boolean
	readonly rssi?: number // 0..127 logarithmic RSSI scale
	readonly station?: boolean
	readonly frequencyUp: () => void
	readonly frequencyDown: () => void
	readonly volumeUp: () => void
	readonly volumeDown: () => void
	readonly mute: () => void
	readonly unmute: () => void
	readonly seek: (direction: RadioTunerSeekDirection, wrap: boolean) => void
}

export interface RadioTransmitter extends Pick<Peripheral, 'name' | 'client'> {
	frequency: number // MHz
	muted: boolean
	stereo: boolean
	readonly frequencyUp: () => void
	readonly frequencyDown: () => void
	readonly mute: () => void
	readonly unmute: () => void
}

export interface RealTimeClock extends Pick<Peripheral, 'name' | 'client'> {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly hour: number
	readonly minute: number
	readonly second: number
	readonly millisecond: number
	readonly update: (year?: number, month?: number, day?: number, dayOfWeek?: number, hour?: number, minute?: number, second?: number, millisecond?: number) => void
	readonly sync: (date?: Date) => void
}

export interface IOExpander extends Pick<Peripheral, 'name' | 'client'> {
	readonly pinMode: (pin: number, mode: PinMode) => void
	readonly pinRead: (pin: number) => number | boolean
	readonly pinWrite: (pin: number, value: number | boolean) => void
}

interface PendingTwoWireRead {
	readonly reject: (error: Error) => void
	readonly resolve: (data: Buffer) => void
	readonly timer: NodeJS.Timeout
}

export const DEFAULT_POLLING_INTERVAL = 5000

export abstract class PeripheralBase<D extends Peripheral<D> = never> implements FirmataClientHandler {
	readonly #listeners = new Set<PeripheralListener<D>>()
	readonly #pendingTwoWireReads = new Map<string, PendingTwoWireRead[]>()

	abstract readonly client: FirmataClient

	abstract start(): void
	abstract stop(): void

	[Symbol.dispose]() {
		this.stop()
	}

	addListener(listener: PeripheralListener<D>) {
		this.#listeners.add(listener)
	}

	removeListener(listener: PeripheralListener<D>) {
		this.#listeners.delete(listener)
	}

	protected fire() {
		for (const listener of this.#listeners) listener(this as never)
	}

	// Resolves one queued I2C register read for the current device instance.
	protected resolvePendingTwoWireRead(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client) return false

		const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))
		if (requests === undefined || requests.length === 0) return false

		const request = requests.shift()
		if (requests.length === 0) this.#pendingTwoWireReads.delete(this.#pendingTwoWireReadKey(address, register))
		if (request === undefined) return false

		clearTimeout(request.timer)
		request.resolve(Buffer.from(data))
		return true
	}

	// Queues one I2C register read and resolves when Firmata returns the matching reply.
	protected readTwoWireRegister(address: number, register: number, bytesToRead: number, timeoutMs: number = 1000): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))

				if (requests !== undefined) {
					const index = requests.findIndex((request) => request.timer === timer)
					if (index >= 0) requests.splice(index, 1)
					if (requests.length === 0) this.#pendingTwoWireReads.delete(this.#pendingTwoWireReadKey(address, register))
				}

				reject(new Error(`${this.constructor.name} register 0x${register.toString(16).padStart(2, '0')} read timed out.`))
			}, timeoutMs)

			const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))
			const request = { resolve, reject, timer }

			if (requests === undefined) this.#pendingTwoWireReads.set(this.#pendingTwoWireReadKey(address, register), [request])
			else requests.push(request)

			this.client.twoWireRead(address, register, bytesToRead)
		})
	}

	// Rejects any queued I2C register reads when the device shuts down.
	protected clearPendingTwoWireReads(error: Error | string) {
		const reason = typeof error === 'string' ? new Error(error) : error

		for (const [key, requests] of this.#pendingTwoWireReads) {
			for (const request of requests) {
				clearTimeout(request.timer)
				request.reject(new Error(`${reason.message} (${key})`))
			}
		}

		this.#pendingTwoWireReads.clear()
	}

	// Builds a stable map key for one I2C address/register pair.
	#pendingTwoWireReadKey(address: number, register: number) {
		return `ADDR:0x${address.toString(16).padStart(2, '0')}:REG:0x${register.toString(16).padStart(2, '0')}`
	}

	close(client: FirmataClient) {
		if (this.client === client) this.stop()
	}
}

export abstract class ADCPeripheral<D extends Peripheral<D>> extends PeripheralBase<D> {
	abstract readonly pin: number

	abstract calculate(value: number): boolean

	pinChange(client: FirmataClient, pin: Pin) {
		if (this.client === client && pin.id === this.pin) {
			if (this.calculate(pin.value)) this.fire()
		}
	}
}
