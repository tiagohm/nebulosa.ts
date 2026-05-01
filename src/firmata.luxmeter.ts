import { type FirmataClient, PinMode } from './firmata'
import { ADCPeripheral, DEFAULT_POLLING_INTERVAL, type Luxmeter, PeripheralBase } from './firmata.peripheral'

export type BH1750Mode = 'continuousHighResolution' | 'continuousHighResolution2' | 'continuousLowResolution' | 'oneTimeHighResolution' | 'oneTimeHighResolution2' | 'oneTimeLowResolution'

export type TSL2561Gain = 1 | 16

export type TSL2561IntegrationTime = 13.7 | 101 | 402 // ms

export interface BH1750Options {
	readonly mode?: BH1750Mode
	readonly measurementTime?: number
}

export interface TSL2561Options {
	readonly gain?: TSL2561Gain
	readonly integrationTime?: TSL2561IntegrationTime // ms
}

export interface MAX44009Options {
	readonly continuousMode?: boolean
}

export interface TEMT6000Options {
	readonly aref?: number // volts
	readonly loadResistance?: number // ohms
	readonly adcResolution?: number
	readonly microampsPerLux?: number
}

export const DEFAULT_BH1750_OPTIONS: Required<BH1750Options> = {
	mode: 'continuousHighResolution',
	measurementTime: 69,
}

export const DEFAULT_TSL2561_OPTIONS: Required<TSL2561Options> = {
	gain: 1,
	integrationTime: 402,
}

export const DEFAULT_MAX44009_OPTIONS: Required<MAX44009Options> = {
	continuousMode: false,
}

export const DEFAULT_TEMT6000_OPTIONS: Required<TEMT6000Options> = {
	aref: 5,
	loadResistance: 10000,
	adcResolution: 1023,
	microampsPerLux: 0.5,
}

// https://www.rohm.com/products/sensor/ambient-light-sensor-ics/bh1750fvi-product

export class BH1750 extends PeripheralBase<BH1750> implements Luxmeter {
	lux = 0
	raw = 0

	static readonly ADDRESS = 0x23
	static readonly ALTERNATIVE_ADDRESS = 0x5c

	static readonly POWER_DOWN_CMD = 0x00
	static readonly POWER_ON_CMD = 0x01
	static readonly RESET_CMD = 0x07
	static readonly CONTINUOUS_HIGH_RESOLUTION_CMD = 0x10
	static readonly CONTINUOUS_HIGH_RESOLUTION2_CMD = 0x11
	static readonly CONTINUOUS_LOW_RESOLUTION_CMD = 0x13
	static readonly ONE_TIME_HIGH_RESOLUTION_CMD = 0x20
	static readonly ONE_TIME_HIGH_RESOLUTION2_CMD = 0x21
	static readonly ONE_TIME_LOW_RESOLUTION_CMD = 0x23
	static readonly CHANGE_MEASUREMENT_TIME_HIGH_BIT_CMD = 0x40
	static readonly CHANGE_MEASUREMENT_TIME_LOW_BIT_CMD = 0x60
	static readonly DEFAULT_MEASUREMENT_TIME = 69
	static readonly MIN_MEASUREMENT_TIME = 31
	static readonly MAX_MEASUREMENT_TIME = 254

	#timer?: NodeJS.Timeout
	#reading = false
	readonly #modeCommand: number
	readonly #measurementTime: number
	readonly #measurementDelayMs: number
	readonly #oneTimeMode: boolean
	readonly #halfLuxResolution: boolean

	readonly name = 'BH1750'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = BH1750.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: BH1750Options = DEFAULT_BH1750_OPTIONS,
	) {
		super()

		const mode = options.mode ?? DEFAULT_BH1750_OPTIONS.mode
		const measurementTime = Math.max(BH1750.MIN_MEASUREMENT_TIME, Math.min(BH1750.MAX_MEASUREMENT_TIME, Math.trunc(options.measurementTime ?? DEFAULT_BH1750_OPTIONS.measurementTime)))
		const lowResolutionMode = mode === 'continuousLowResolution' || mode === 'oneTimeLowResolution'

		this.#modeCommand =
			mode === 'continuousHighResolution'
				? BH1750.CONTINUOUS_HIGH_RESOLUTION_CMD
				: mode === 'continuousHighResolution2'
					? BH1750.CONTINUOUS_HIGH_RESOLUTION2_CMD
					: mode === 'continuousLowResolution'
						? BH1750.CONTINUOUS_LOW_RESOLUTION_CMD
						: mode === 'oneTimeHighResolution'
							? BH1750.ONE_TIME_HIGH_RESOLUTION_CMD
							: mode === 'oneTimeHighResolution2'
								? BH1750.ONE_TIME_HIGH_RESOLUTION2_CMD
								: BH1750.ONE_TIME_LOW_RESOLUTION_CMD
		this.#measurementTime = measurementTime
		this.#measurementDelayMs = Math.ceil((lowResolutionMode ? 24 : 180) * (measurementTime / BH1750.DEFAULT_MEASUREMENT_TIME))
		this.#oneTimeMode = mode === 'oneTimeHighResolution' || mode === 'oneTimeHighResolution2' || mode === 'oneTimeLowResolution'
		this.#halfLuxResolution = mode === 'continuousHighResolution2' || mode === 'oneTimeHighResolution2'
	}

	// Powers on the device, configures MTreg, and starts periodic measurements.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
			this.#configureMeasurementTime()
			void this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(this.#measurementDelayMs, this.pollingInterval))
		}
	}

	// Stops polling and powers the device down.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
		this.client.twoWireWrite(this.address, [BH1750.POWER_DOWN_CMD])
	}

	// Resets the data register while the device is powered on.
	reset() {
		this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
		this.client.twoWireWrite(this.address, [BH1750.RESET_CMD])
	}

	// Decodes the 16-bit sensor output into lux.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== -1 || data.byteLength !== 2) return

		const raw = data.readUInt16BE(0)
		const lux = this.calculateLux(raw)

		if (raw !== this.raw || lux !== this.lux) {
			this.raw = raw
			this.lux = lux
			this.fire()
		}
	}

	// Converts the raw measurement value into lux, compensating for MTreg and mode.
	calculateLux(raw: number) {
		if (raw <= 0) return 0
		const modeScale = this.#halfLuxResolution ? 2.4 : 1.2
		return (raw * (BH1750.DEFAULT_MEASUREMENT_TIME / this.#measurementTime)) / modeScale
	}

	// Writes the two MTreg adjustment commands.
	#configureMeasurementTime() {
		this.client.twoWireWrite(this.address, [BH1750.CHANGE_MEASUREMENT_TIME_HIGH_BIT_CMD | (this.#measurementTime >>> 5)])
		this.client.twoWireWrite(this.address, [BH1750.CHANGE_MEASUREMENT_TIME_LOW_BIT_CMD | (this.#measurementTime & 0x1f)])
	}

	// Starts one measurement cycle and reads back the 16-bit result after conversion.
	async #readMeasurement() {
		if (this.#reading) return

		try {
			this.#reading = true

			if (this.#oneTimeMode) {
				this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
				this.#configureMeasurementTime()
			}

			this.client.twoWireWrite(this.address, [this.#modeCommand])
			await Bun.sleep(this.#measurementDelayMs)
			this.client.twoWireRead(this.address, -1, 2)
		} finally {
			this.#reading = false
		}
	}
}

// https://www.mouser.com/datasheet/2/588/TSL2561_DS000110_3_00-2066792.pdf

export class TSL2561 extends PeripheralBase<TSL2561> implements Luxmeter {
	lux = 0
	broadband = 0
	infrared = 0

	static readonly ADDRESS = 0x39
	static readonly LOW_ADDRESS = 0x29
	static readonly HIGH_ADDRESS = 0x49

	static readonly COMMAND_BIT = 0x80
	static readonly BLOCK_BIT = 0x10

	static readonly CONTROL_REG = 0x00
	static readonly TIMING_REG = 0x01
	static readonly DATA0LOW_REG = 0x0c

	static readonly POWER_UP = 0x03
	static readonly SCALE_13_7_MS = 322 / 11
	static readonly SCALE_101_MS = 322 / 81
	static readonly CLIP_13_7_MS = 5047
	static readonly CLIP_101_MS = 37177
	static readonly CLIP_402_MS = 65535

	#timer?: NodeJS.Timeout
	readonly #timing: number
	readonly #gainScale: number
	readonly #integrationScale: number
	readonly #clipThreshold: number
	readonly #minimumPollingInterval: number

	readonly name = 'TSL2561'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = TSL2561.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: TSL2561Options = DEFAULT_TSL2561_OPTIONS,
	) {
		super()

		const gain = options.gain ?? DEFAULT_TSL2561_OPTIONS.gain
		const integrationTime = options.integrationTime ?? DEFAULT_TSL2561_OPTIONS.integrationTime
		const integrationBits = integrationTime === 13.7 ? 0 : integrationTime === 101 ? 1 : 2

		this.#timing = (gain === 16 ? 0x10 : 0) | integrationBits
		this.#gainScale = gain === 1 ? 16 : 1
		this.#integrationScale = integrationTime === 13.7 ? TSL2561.SCALE_13_7_MS : integrationTime === 101 ? TSL2561.SCALE_101_MS : 1
		this.#clipThreshold = integrationTime === 13.7 ? TSL2561.CLIP_13_7_MS : integrationTime === 101 ? TSL2561.CLIP_101_MS : TSL2561.CLIP_402_MS
		this.#minimumPollingInterval = Math.ceil(integrationTime)
	}

	// Powers up the device, configures timing, and starts reading both ADC channels.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [TSL2561.COMMAND_BIT | TSL2561.CONTROL_REG, TSL2561.POWER_UP])
			this.client.twoWireWrite(this.address, [TSL2561.COMMAND_BIT | TSL2561.TIMING_REG, this.#timing])
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(this.#minimumPollingInterval, this.pollingInterval))
		}
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Decodes both ADC channels and updates the computed lux value.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== (TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG) || data.byteLength !== 4) return

		const broadband = data.readUInt16LE(0)
		const infrared = data.readUInt16LE(2)
		const lux = this.calculateLux(broadband, infrared)

		if (broadband !== this.broadband || infrared !== this.infrared || lux !== this.lux) {
			this.broadband = broadband
			this.infrared = infrared
			this.lux = lux
			this.fire()
		}
	}

	// Converts raw channel counts into lux using the T package coefficients from the datasheet.
	calculateLux(broadband: number, infrared: number) {
		if (broadband <= 0 || infrared < 0) return 0
		if (broadband >= this.#clipThreshold || infrared >= this.#clipThreshold) return this.lux

		const scaledBroadband = broadband * this.#gainScale * this.#integrationScale
		const scaledInfrared = infrared * this.#gainScale * this.#integrationScale
		const ratio = scaledInfrared / scaledBroadband

		let lux = 0

		if (ratio <= 0.5) lux = 0.0304 * scaledBroadband - 0.062 * scaledBroadband * ratio ** 1.4
		else if (ratio <= 0.61) lux = 0.0224 * scaledBroadband - 0.031 * scaledInfrared
		else if (ratio <= 0.8) lux = 0.0128 * scaledBroadband - 0.0153 * scaledInfrared
		else if (ratio <= 1.3) lux = 0.00146 * scaledBroadband - 0.00112 * scaledInfrared

		return Math.max(0, lux)
	}

	// Reads both ADC channels in a single block transaction.
	#readMeasurement() {
		this.client.twoWireRead(this.address, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, 4)
	}
}

// https://www.analog.com/media/en/technical-documentation/data-sheets/max44009.pdf

export class MAX44009 extends PeripheralBase<MAX44009> implements Luxmeter {
	lux = 0

	static readonly ADDRESS = 0x4a
	static readonly ALTERNATIVE_ADDRESS = 0x4b

	static readonly CONFIGURATION_REG = 0x02
	static readonly LUX_HIGH_REG = 0x03
	static readonly LUX_LOW_REG = 0x04
	static readonly DEFAULT_CONFIGURATION = 0x03
	static readonly CONTINUOUS_MODE_BIT = 0x80
	static readonly MAX_LUX = 188006.4

	#timer?: NodeJS.Timeout
	readonly #configuration: number

	readonly name = 'MAX44009'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = MAX44009.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: MAX44009Options = DEFAULT_MAX44009_OPTIONS,
	) {
		super()

		const continuousMode = options.continuousMode ?? DEFAULT_MAX44009_OPTIONS.continuousMode
		this.#configuration = (continuousMode ? MAX44009.CONTINUOUS_MODE_BIT : 0) | MAX44009.DEFAULT_CONFIGURATION
	}

	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [MAX44009.CONFIGURATION_REG, this.#configuration])
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(100, this.pollingInterval))
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== MAX44009.LUX_HIGH_REG || data.byteLength !== 2) return

		const lux = this.calculateLux(data[0], data[1])

		if (lux !== this.lux) {
			this.lux = lux
			this.fire()
		}
	}

	// Decodes the exponent and mantissa registers into the ambient light level in lux.
	calculateLux(highByte: number, lowByte: number) {
		const exponent = (highByte >>> 4) & 0x0f

		if (exponent === 0x0f) return MAX44009.MAX_LUX

		const mantissa = ((highByte & 0x0f) << 4) | (lowByte & 0x0f)
		return 2 ** exponent * mantissa * 0.045
	}

	#readMeasurement() {
		this.client.twoWireRead(this.address, MAX44009.LUX_HIGH_REG, 2, false, 7, 'restart')
	}
}

// https://www.alldatasheet.com/html-pdf/117488/VISHAY/TEMT6000/440/2/TEMT6000.html

export class TEMT6000 extends ADCPeripheral<TEMT6000> implements Luxmeter {
	lux = 0

	readonly #luxPerStep: number

	readonly name = 'TEMPT6000'

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		options: TEMT6000Options = DEFAULT_TEMT6000_OPTIONS,
	) {
		super()

		const aref = options.aref ?? DEFAULT_TEMT6000_OPTIONS.aref
		const loadResistance = options.loadResistance ?? DEFAULT_TEMT6000_OPTIONS.loadResistance
		const adcResolution = options.adcResolution ?? DEFAULT_TEMT6000_OPTIONS.adcResolution
		const microampsPerLux = options.microampsPerLux ?? DEFAULT_TEMT6000_OPTIONS.microampsPerLux

		this.#luxPerStep = (aref * 1e6) / (loadResistance * adcResolution * microampsPerLux)
	}

	// Converts one ADC sample into lux for the configured analog front-end.
	calculate(value: number) {
		const lux = value * this.#luxPerStep

		if (lux !== this.lux) {
			this.lux = lux
			return true
		}

		return false
	}

	// Enables analog reporting for the configured pin.
	start() {
		this.client.addHandler(this)
		this.client.pinMode(this.pin, PinMode.ANALOG)
		this.client.requestAnalogPinReport(this.pin, true)
	}

	// Disables analog reporting and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		this.client.requestAnalogPinReport(this.pin, false)
	}
}
