import type { NumberArray } from '../../math/numerical/math'
import { encodeDhtAttach } from './codecs/dht'
import { encodeFrequencyFilter, encodeFrequencyQuery } from './codecs/frequency'
import { encodeSigned32, encodeStepperFloat, encodeStepperPosition, encodeUnsigned7, writeValueAsTwo7bitBytes } from './codecs/numeric'
import { encodeOneWireCommand, encodeOneWireConfig, encodeOneWireSearch } from './codecs/onewire'
import { encodeSchedulerAdd, encodeSchedulerDelay, encodeSchedulerSchedule } from './codecs/scheduler'
import { encodeSerialConfig, encodeSerialWrite } from './codecs/serial'
import { validateSpiReadWords, validateSpiTransferSize, decodeSpiReply, encodeSpiConfig, encodeSpiWords, spiSelector, type SpiChannel, type SpiDeviceOptions, type SpiReply } from './codecs/spi'
import { encodeMultiStepperConfig, encodeMultiStepperMoveTo, encodeMultiStepperStop, encodeStepperConfig } from './codecs/stepper'
import { encodeTwoWireConfig, encodeTwoWireReadWrite } from './codecs/twowire'
import { FirmataFsm, FirmataParser, WAITING_FOR_MESSAGE_STATE } from './parser'
import * as Firmata from './protocol'
// oxfmt-ignore
import { type AnalogMapping, type Board, DEFAULT_ONE_WIRE_COMMAND_OPTIONS, type DhtModel, type FirmataClientHandler, type OneWireCommandOptions, type OneWirePowerMode, type OneWireSearchMode, type Pin, PinMode, type SerialPort, type StepperConfig, type Transport, type TwoWireAddressMode, type TwoWireAutoRestartMode, type TwoWireOperationMode } from './types'

// Firmata command client: owns board metadata, handshake, transport writes and bus/session
// state. Codec modules build outgoing messages; this class preserves the public method API.

// Reused firmware query frame that starts a metadata handshake.
const REQUEST_FIRMWARE_DATA = new Uint8Array([Firmata.START_SYSEX, Firmata.REPORT_FIRMWARE, Firmata.END_SYSEX])
// Reused pin-capability query frame sent after the firmware reply.
const REQUEST_PIN_CAPABILITY_DATA = new Uint8Array([Firmata.START_SYSEX, Firmata.CAPABILITY_QUERY, Firmata.END_SYSEX])
// Reused analog-mapping query frame that finishes the metadata handshake.
const REQUEST_ANALOG_MAPPING_DATA = new Uint8Array([Firmata.START_SYSEX, Firmata.ANALOG_MAPPING_QUERY, Firmata.END_SYSEX])

// Expected reply in the metadata handshake; idle also permits standalone metadata queries.
type InitializationPhase = 'idle' | 'firmware' | 'capabilities' | 'pinStates' | 'analogMapping' | 'ready'

// High-level Firmata client over a Transport. Drives the startup handshake (firmware → pin capabilities →
// per-pin state → analog mapping → ready), tracks pin state, and sends codec-built commands.
export class FirmataClient implements Disposable {
	readonly #fsm: FirmataFsm
	readonly #parser: FirmataParser
	readonly #transport: Transport
	readonly #board: Board

	#initializationPhase: InitializationPhase = 'idle'
	#maxTwoWireDelay = 0
	#oneWireCorrelationId = 0
	#spiRequestId = 0
	// SPI reply encoding survives a transport reconnect, but is invalidated by an explicit board reset.
	readonly #spiPackedBySelector = new Map<number, boolean>()
	readonly #pinStateRequestQueue: number[] = []
	readonly #pinMap = new Map<number, Pin>()
	// Reassigned on reset()/close() so a reconnect handshake does not inherit a stale analog mapping.
	#analogPins: AnalogMapping = {}
	// Re-armed on reset()/close() so a reconnect handshake can emit ready again. The handshake's
	// analog-mapping step resolves it once, so without re-arming it would stay resolved one-shot.
	#initialization = Promise.withResolvers<boolean>()

	// Internal handler implementing the startup handshake and pin-state bookkeeping: chains firmware →
	// capability → pin-state → analog-mapping requests, resolves initialization, and updates cached pins
	// on analog reports.
	readonly #handler: FirmataClientHandler = {
		firmwareMessage: (client: FirmataClient, major: number, minor: number, name: string) => {
			if (this.#initializationPhase === 'firmware' || this.#initializationPhase === 'idle') {
				this.#initializationPhase = 'capabilities'
				this.requestPinCapability()
			}
		},
		analogMessage: (client: FirmataClient, port: number, value: number) => {
			const pin = this.#pinMap.get(this.#analogPins[port])

			if (pin?.mode === PinMode.ANALOG) {
				pin.value = value
				this.#fsm.pinChange(pin)
			}
		},
		pinCapability: (client: FirmataClient, id: number, modes: Set<PinMode>, resolutions: ReadonlyMap<PinMode, number>) => {
			if (this.#initializationPhase !== 'capabilities' && this.#initializationPhase !== 'idle' && this.#initializationPhase !== 'ready') return
			this.#pinMap.set(id, { id, modes, resolutions, mode: PinMode.UNSUPPORTED, value: 0 })

			// if the pin supports some modes, we will ask for its current mode and value.
			if (modes.size > 0) this.#pinStateRequestQueue.push(id)
		},
		pinCapabilitiesFinished: (client: FirmataClient) => {
			if (this.#initializationPhase === 'capabilities') {
				if (this.#pinStateRequestQueue.length > 0) {
					this.#initializationPhase = 'pinStates'
					this.requestPinState(this.#pinStateRequestQueue.shift()!)
				} else {
					this.#initializationPhase = 'analogMapping'
					this.requestAnalogMapping()
				}
			} else if ((this.#initializationPhase === 'idle' || this.#initializationPhase === 'ready') && this.#pinStateRequestQueue.length > 0) {
				this.requestPinState(this.#pinStateRequestQueue.shift()!)
			}
		},
		analogMapping: (client: FirmataClient, mapping: AnalogMapping) => {
			if (this.#initializationPhase !== 'analogMapping' && this.#initializationPhase !== 'idle' && this.#initializationPhase !== 'ready') return
			Object.assign(this.#analogPins, mapping)

			if (this.#initializationPhase === 'analogMapping') {
				this.#initializationPhase = 'ready'
				this.#initialization.resolve(true)
				this.#fsm.ready()
			}
		},
		pinState: (client: FirmataClient, id: number, mode: PinMode, value: number) => {
			if (this.#initializationPhase !== 'pinStates' && this.#initializationPhase !== 'idle' && this.#initializationPhase !== 'ready') return
			const pin = this.#pinMap.get(id)

			if (pin) {
				pin.mode = mode
				pin.value = value

				if (this.#pinStateRequestQueue.length > 0) {
					this.requestPinState(this.#pinStateRequestQueue.shift()!)
				} else if (this.#initializationPhase === 'pinStates') {
					this.#initializationPhase = 'analogMapping'
					this.requestAnalogMapping()
				}
			}
		},
	}

	// Binds a byte-stream transport and board pin map; no I/O occurs until a request is sent.
	constructor(transport: Transport, board: Board) {
		this.#transport = transport
		this.#board = board
		this.#fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, this)
		this.#parser = new FirmataParser(this.#fsm)
		this.addHandler(this.#handler)
	}

	// Closes the transport and releases local parser/session state.
	[Symbol.dispose]() {
		this.disconnect()
	}

	// Number of pins discovered during the capability handshake.
	get pinCount() {
		return this.#pinMap.size
	}

	// Live iterator over cached pins; pin objects may mutate after reports arrive.
	get pins(): MapIterator<Readonly<Pin>> {
		return this.#pinMap.values()
	}

	// Returns cached state for physical pin `id`, or undefined before discovery.
	pinAt(id: number): Readonly<Pin> | undefined {
		return this.#pinMap.get(id)
	}

	// Registers an external event handler; duplicate registrations are ignored.
	addHandler(handler: FirmataClientHandler) {
		this.#fsm.addHandler(handler)
	}

	// Stops delivering future events to `handler`.
	removeHandler(handler: FirmataClientHandler) {
		this.#fsm.removeHandler(handler)
	}

	// Closes the transport and resets parser/handshake state.
	disconnect() {
		this.#transport.close()
		this.reset()
	}

	// Feeds a received byte chunk into the parser; complete messages emit handler callbacks.
	process(data: Buffer) {
		this.#parser.process(data)
	}

	// Feeds one incoming transport byte to the parser.
	processByte(b: number) {
		this.#parser.processByte(b)
	}

	// Resolves once the startup handshake completes (ready), or false after `timeout` ms (0 = no timeout).
	ensureInitializationIsDone(timeout: number) {
		const timer = timeout > 0 ? setTimeout(this.#initialization.resolve, timeout, false) : undefined
		void this.#initialization.promise.then(clearTimeout.bind(undefined, timer))
		return this.#initialization.promise
	}

	// Clears local board metadata and parser state, then waits for fresh firmware metadata; pending
	// initialization resolves false. No board reset is sent, so I2C and SPI configuration is retained.
	reset() {
		// Re-arm the one-shot initialization gate so a subsequent (re)connect handshake runs the full
		// firmware/capability/analog-mapping sequence and emits ready again, and ensureInitializationIsDone
		// resolves freshly. Without this a reconnect on the same client would never become ready.
		this.#initializationPhase = 'firmware'
		// Settle the outgoing promise before replacing it: a caller awaiting ensureInitializationIsDone(0)
		// has no rescue timer, so without this it would be orphaned forever instead of observing the reset.
		this.#initialization.resolve(false)
		this.#initialization = Promise.withResolvers<boolean>()
		// Drop cached board metadata so a fresh handshake does not inherit stale pins/analog mapping:
		// pinCapability only adds/updates entries and analogMapping only assigns supplied ports, so a
		// reconnect to firmware with fewer pins or a different map would otherwise keep the old ones.
		this.#pinStateRequestQueue.length = 0
		this.#pinMap.clear()
		this.#analogPins = {}
		this.#spiRequestId = 0
		this.#fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}

	// Writes a framed message or source-buffer slice to the transport and flushes it.
	send(message: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) {
		this.#transport.write(message, byteOffset, byteLength)
		this.#transport.flush()
	}

	// Requests firmware name and version; this starts the client's readiness handshake.
	requestFirmware() {
		if (this.#initializationPhase === 'idle') this.#initializationPhase = 'firmware'
		this.send(REQUEST_FIRMWARE_DATA)
	}

	// Requests the two-byte Firmata protocol version; the result arrives through `version`.
	requestProtocolVersion() {
		this.send(new Uint8Array([Firmata.REPORT_VERSION]))
	}

	// Resets the board, invalidates pin metadata and SPI reply configuration, and requests fresh
	// firmware metadata to restart the readiness handshake. The firmware retains I2C read delay.
	sendSystemReset() {
		this.send(new Uint8Array([Firmata.SYSTEM_RESET]))
		this.reset()
		this.#spiPackedBySelector.clear()
		this.requestFirmware()
	}

	// Frames a feature `command` and its already 7-bit-safe `payload`, allocating
	// one outbound buffer before writing and flushing it.
	#sendSysex(command: number, payload: readonly number[]) {
		const message = new Uint8Array(payload.length + 3)
		message[0] = Firmata.START_SYSEX
		message[1] = command
		message.set(payload, 2)
		message[message.length - 1] = Firmata.END_SYSEX
		this.send(message)
	}

	// Sends UTF-8 `message` text using Wire.STRING_DATA's two-seven-bit-byte-per-octet layout.
	sendString(message: string) {
		const bytes = Buffer.from(message, 'utf8')
		const payload: number[] = []
		for (const byte of bytes) payload.push(byte & 0x7f, byte >>> 7)
		this.#sendSysex(Firmata.STRING_DATA, payload)
	}

	// Requests supported modes and their resolution for every physical pin.
	requestPinCapability() {
		this.send(REQUEST_PIN_CAPABILITY_DATA)
	}

	// Requests current mode and raw value for physical pin `pinId`.
	requestPinState(pinId: number) {
		this.send(new Uint8Array([Firmata.START_SYSEX, Firmata.PIN_STATE_QUERY, pinId, Firmata.END_SYSEX]))
	}

	// Requests the board's analog-channel-to-physical-pin map.
	requestAnalogMapping() {
		this.send(REQUEST_ANALOG_MAPPING_DATA)
	}

	// Enables or disables all 16 standard eight-pin digital reporting ports.
	requestDigitalReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = Firmata.REPORT_DIGITAL | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	// Enables or disables reports for the eight-pin digital port containing `pin`.
	requestDigitalPinReport(pin: number, enable: boolean) {
		this.send(new Uint8Array([Firmata.REPORT_DIGITAL | ((this.#board.pinToDigital(pin) >> 3) & 0x0f), enable ? 1 : 0]))
	}

	// Enables or disables reporting for all 16 standard analog channels.
	requestAnalogReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = Firmata.REPORT_ANALOG | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	// Enables or disables reporting for physical `pin`'s analog channel; channels
	// above 15 use Wire.EXTENDED_REPORT_ANALOG and return samples through `analogMessage`.
	requestAnalogPinReport(pin: number, enable: boolean) {
		const channel = this.#board.pinToAnalog(pin)
		if (channel < 16) this.send(new Uint8Array([Firmata.REPORT_ANALOG | channel, enable ? 1 : 0]))
		else this.#sendSysex(Firmata.EXTENDED_REPORT_ANALOG, [channel, enable ? 1 : 0])
	}

	// Sets physical `pin` to `mode` and updates its cached mode immediately.
	pinMode(pin: number, mode: PinMode) {
		const state = this.#pinMap.get(pin)
		if (state) state.mode = mode

		this.send(new Uint8Array([Firmata.SET_PIN_MODE, pin, mode]))
	}

	// Drives a physical digital pin low for zero/false or high for any other value.
	digitalWrite(pin: number, value: boolean | number) {
		this.send(new Uint8Array([Firmata.SET_DIGITAL_PIN_VALUE, pin, value ? 1 : 0]))
	}

	// Writes `value` to physical PWM/servo `pin`, saturated to unsigned 32 bits,
	// using the shortest extended-analog encoding of up to five 7-bit bytes.
	analogWrite(pin: number, value: number) {
		const data = Math.max(0, Math.min(0xffffffff, Math.trunc(value)))
		const bytes = data === 0 ? 1 : Math.ceil((Math.floor(Math.log2(data)) + 1) / 7)
		this.#sendSysex(Firmata.EXTENDED_ANALOG, [this.#board.pinToPWM(pin), ...encodeUnsigned7(data, bytes)])
	}

	// Sets the shared analog/I2C sampling interval in milliseconds, clamped to 1-16383.
	samplingInterval(milliseconds: number) {
		const message = new Uint8Array([Firmata.START_SYSEX, Firmata.SAMPLING_INTERVAL, 0, 0, Firmata.END_SYSEX])
		// The interval is a 14-bit field (LSB+MSB, both 7-bit).
		writeValueAsTwo7bitBytes(message, 2, Math.max(Firmata.MIN_SAMPLING_INTERVAL, Math.min(milliseconds, Firmata.MAX_SAMPLING_INTERVAL)))
		this.send(message)
	}

	// Requests the board's sampling interval in milliseconds.
	querySamplingInterval() {
		this.#sendSysex(Firmata.SAMPLING_INTERVAL_QUERY, [])
	}

	// Queries signed int32 variable `id` (0-16383) for physical `pin`, or the whole
	// board when `pin` is omitted; the reply arrives through `systemVariableReply`.
	// The bundled firmware requires a five-byte zero value even for reads.
	querySystemVariable(id: number, pin?: number) {
		this.#sendSysex(Firmata.SYSTEM_VARIABLE, [0, 1, 0, ...encodeUnsigned7(id, 2), pin ?? 127, 0, 0, 0, 0, 0])
	}

	// Sets signed int32 variable `id` (0-16383) to `value` for physical `pin`, or
	// the whole board when omitted; firmware reports the resulting status.
	setSystemVariable(id: number, value: number, pin?: number) {
		this.#sendSysex(Firmata.SYSTEM_VARIABLE, [1, 1, 0, ...encodeUnsigned7(id, 2), pin ?? 127, ...encodeSigned32(value)])
	}

	// Configures physical servo `pin` with minimum and maximum pulse widths in
	// microseconds (0-16383); attach/detach uses `pinMode`.
	servoConfig(pin: number, minPulseMicroseconds: number, maxPulseMicroseconds: number) {
		this.#sendSysex(Firmata.SERVO_CONFIG, [pin, ...encodeUnsigned7(minPulseMicroseconds, 2), ...encodeUnsigned7(maxPulseMicroseconds, 2)])
	}

	// Starts SPI `channel` (0-7); the bundled ESP8266 firmware accepts channel zero.
	spiBegin(channel: SpiChannel = 0) {
		this.#sendSysex(Firmata.SPI_DATA, [0, channel])
	}

	// Configures an eight-bit SPI device from channel, device ID, clock and CS options;
	// remembers its reply packing until `sendSystemReset` or `spiEnd`.
	spiConfig(options: SpiDeviceOptions) {
		if (options.controlCs && options.csPin === undefined) throw new RangeError('SPI firmware-controlled chip select requires a CS pin')
		const selector = spiSelector(options.channel, options.deviceId)
		this.#sendSysex(Firmata.SPI_DATA, encodeSpiConfig(options))
		this.#spiPackedBySelector.set(selector, options.packed ?? false)
	}

	// Releases SPI `channel` and forgets device reply encoding for that channel.
	spiEnd(channel: SpiChannel = 0) {
		this.#sendSysex(Firmata.SPI_DATA, [6, channel])
		for (const selector of this.#spiPackedBySelector.keys()) if ((selector & 7) === channel) this.#spiPackedBySelector.delete(selector)
	}

	// Allocates one 7-bit SPI request ID, wrapping from 127 to zero.
	#nextSpiRequestId(): number {
		const id = this.#spiRequestId
		this.#spiRequestId = (id + 1) & 127
		return id
	}

	// Sends `data` words (or a numeric read count) to a channel/device with the
	// chosen command. `deselectCs=false` keeps CS active; returns a 7-bit request ID.
	#spiData(command: 2 | 3 | 4 | 7, channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer | number, deselectCs: boolean): number {
		const selector = spiSelector(channel, deviceId)
		const packed = this.#spiPackedBySelector.get(selector) ?? false
		if (typeof data !== 'number') validateSpiTransferSize(data, packed)
		const id = this.#nextSpiRequestId()
		const payload = typeof data === 'number' ? [command, selector, id, deselectCs ? 1 : 0, data] : encodeSpiWords(command, selector, id, data, packed, deselectCs)
		this.#sendSysex(Firmata.SPI_DATA, payload)
		return id
	}

	// Exchanges eight-bit `data` words with a channel/device. Deselects CS by
	// default and returns the request ID echoed by `spiReply`.
	spiTransfer(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(2, channel, deviceId, data, deselectCs)
	}

	// Writes eight-bit `data` to a channel/device without a reply; optionally
	// keeps CS active and returns the allocated request ID.
	spiWrite(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(3, channel, deviceId, data, deselectCs)
	}

	// Writes eight-bit `data` to a channel/device, optionally keeping CS active;
	// returns the request ID echoed by an empty acknowledgement reply.
	spiWriteAck(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(7, channel, deviceId, data, deselectCs)
	}

	// Reads `words` eight-bit values from a channel/device by clocking zeroes.
	// At most 64 words protect the bundled firmware's stack buffer; returns a
	// request ID, and deselects CS unless `deselectCs` is false.
	spiRead(channel: SpiChannel, deviceId: number, words: number, deselectCs: boolean = true): number {
		validateSpiReadWords(words)
		return this.#spiData(4, channel, deviceId, words, deselectCs)
	}

	// Decodes a complete SPI reply payload after 0x68 using its device's last
	// configured packing; returns undefined for malformed payloads.
	parseSpiReply(payload: Buffer): SpiReply | undefined {
		return decodeSpiReply(payload, this.#spiPackedBySelector.get(payload[1]) ?? false)
	}

	// Returns physical RX/TX pins for hardware `port` from serial capability
	// resolution (RX=2n, TX=2n+1); software ports return an empty object.
	serialPins(port: SerialPort): { rx?: number; tx?: number } {
		const pins: { rx?: number; tx?: number } = {}
		if (port >= 8) return pins
		for (const pin of this.#pinMap.values()) {
			const resolution = pin.resolutions.get(PinMode.SERIAL)
			if (resolution === port * 2) pins.rx = pin.id
			else if (resolution === port * 2 + 1) pins.tx = pin.id
		}
		return pins
	}

	// Configures a Serial 1.0 hardware/software `port` at `baud` bits/second.
	// Optional RX/TX pins are inferred from capabilities when available, and must
	// be supplied together if only one can be inferred.
	serialConfig(port: SerialPort, baud: number, rxPin?: number, txPin?: number) {
		const discovered = this.serialPins(port)
		const rx = rxPin ?? discovered.rx
		const tx = txPin ?? discovered.tx
		this.#sendSysex(Firmata.SERIAL_MESSAGE, encodeSerialConfig(port, baud, rx, tx))
	}

	// Writes raw `data` bytes to a Serial 1.0 `port` using 7-bit pairs.
	serialWrite(port: SerialPort, data: Readonly<NumberArray> | Buffer) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, encodeSerialWrite(port, data))
	}

	// Starts continuous reads from `port`, limiting each report to `maxBytes` raw
	// bytes; zero reads all currently available bytes.
	serialStartRead(port: SerialPort, maxBytes: number = 0) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, [0x30 | port, 0, ...encodeUnsigned7(maxBytes, 2)])
	}

	// Stops continuous reads from Serial 1.0 `port` without closing it.
	serialStopRead(port: SerialPort) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, [0x30 | port, 1])
	}

	// Closes Serial 1.0 `port`; reconfiguration is required before reuse.
	serialClose(port: SerialPort) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, [0x50 | port])
	}

	// Flushes Serial 1.0 `port` according to the board's serial implementation.
	serialFlush(port: SerialPort) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, [0x60 | port])
	}

	// Selects `port` as the active software serial listener.
	serialListen(port: SerialPort) {
		this.#sendSysex(Firmata.SERIAL_MESSAGE, [0x70 | port])
	}

	// Attaches encoder `id` to digital `pinA` and `pinB`; reports use step counts.
	encoderAttach(id: number, pinA: number, pinB: number) {
		this.#sendSysex(Firmata.ENCODER_DATA, [0, id, pinA, pinB])
	}

	// Detaches encoder `id` from its pins.
	encoderDetach(id: number) {
		this.#sendSysex(Firmata.ENCODER_DATA, [5, id])
	}

	// Requests encoder `id`'s signed position in steps.
	encoderReport(id: number) {
		this.#sendSysex(Firmata.ENCODER_DATA, [1, id])
	}

	// Requests all encoder positions in one reply.
	encoderReportAll() {
		this.#sendSysex(Firmata.ENCODER_DATA, [2])
	}

	// Sets encoder `id`'s current position to zero steps.
	encoderReset(id: number) {
		this.#sendSysex(Firmata.ENCODER_DATA, [3, id])
	}

	// Enables or disables automatic position reports for all attached encoders at
	// the board sampling interval.
	encoderAutoReport(enable: boolean) {
		this.#sendSysex(Firmata.ENCODER_DATA, [4, enable ? 1 : 0])
	}

	// Configures an AccelStepper motor from `options`; required motor pins follow
	// its driver/two-/three-/four-wire interface, followed by optional enable and inversion pins.
	stepperConfig(options: StepperConfig) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, encodeStepperConfig(options))
	}

	// Makes motor `device`'s current position zero steps without moving it.
	stepperZero(device: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [1, device])
	}

	// Moves motor `device` by signed `steps` from its current position; the
	// firmware's sign-magnitude format supports -2147483647 through 2147483647.
	stepperMove(device: number, steps: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [2, device, ...encodeStepperPosition(steps)])
	}

	// Moves motor `device` to signed `position` steps from its zero position;
	// the sign-magnitude format supports -2147483647 through 2147483647.
	stepperMoveTo(device: number, position: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [3, device, ...encodeStepperPosition(position)])
	}

	// Energizes or disables motor `device` through its configured enable pin.
	stepperEnable(device: number, enable: boolean) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [4, device, enable ? 1 : 0])
	}

	// Stops motor `device`; the firmware later reports its completed position.
	stepperStop(device: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [5, device])
	}

	// Requests motor `device`'s signed position in steps.
	stepperReportPosition(device: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [6, device])
	}

	// Sets motor `device`'s acceleration in steps/second² using the protocol's
	// 23-bit decimal float (roughly seven significant digits).
	stepperSetAcceleration(device: number, acceleration: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [8, device, ...encodeStepperFloat(acceleration)])
	}

	// Sets motor `device`'s `speed` in steps/second (maximum while acceleration
	// is enabled), using the protocol's 23-bit decimal float.
	stepperSetMaxSpeed(device: number, speed: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, [9, device, ...encodeStepperFloat(speed)])
	}

	// Appends `devices` (motor IDs 0-9) to MultiStepper `group` (0-4), preserving
	// their order for later absolute targets. At most ten motors fit a group.
	multiStepperConfig(group: number, devices: readonly number[]) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, encodeMultiStepperConfig(group, devices))
	}

	// Coordinates `group` to absolute signed `positions` in configured motor
	// order; one position in steps is required per motor.
	multiStepperMoveTo(group: number, positions: readonly number[]) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, encodeMultiStepperMoveTo(group, positions))
	}

	// Immediately stops every motor in MultiStepper `group` (0-4).
	multiStepperStop(group: number) {
		this.#sendSysex(Firmata.ACCELSTEPPER_DATA, encodeMultiStepperStop(group))
	}

	// Attaches `model` DHT11 or DHT22 to physical `pin`. `samplingMilliseconds`
	// controls reporting; blocking reads are opt-in because they stall the board
	// for roughly 18 ms.
	dhtAttach(pin: number, model: DhtModel, samplingMilliseconds: number = 500, blocking: boolean = false) {
		this.#sendSysex(Firmata.DHTSENSOR_DATA, encodeDhtAttach(pin, model, samplingMilliseconds, blocking))
	}

	// Detaches the DHT sensor on physical `pin`.
	dhtDetach(pin: number) {
		this.#sendSysex(Firmata.DHTSENSOR_DATA, [3, pin])
	}

	// Creates scheduler task `id` (0-127) with `length` bytes of message storage.
	schedulerCreate(id: number, length: number) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, [0, id, ...encodeUnsigned7(length, 2)])
	}

	// Deletes scheduler task `id` and its stored messages.
	schedulerDelete(id: number) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, [1, id])
	}

	// Appends raw Firmata `message` bytes to scheduler task `id` using dense
	// seven-bit packing; the task's declared capacity must accommodate them.
	schedulerAdd(id: number, message: Readonly<NumberArray> | Buffer) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, encodeSchedulerAdd(id, message))
	}

	// Delays the currently executing scheduler task by 0..2147483647 milliseconds;
	// larger wire values become negative signed `long` delays in the firmware.
	schedulerDelay(milliseconds: number) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, encodeSchedulerDelay(milliseconds))
	}

	// Schedules task `id` after 0..2147483647 milliseconds, the positive signed
	// `long` range decoded by the reference firmware.
	schedulerSchedule(id: number, milliseconds: number) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, encodeSchedulerSchedule(id, milliseconds))
	}

	// Requests all currently registered task identifiers.
	schedulerQueryAll() {
		this.#sendSysex(Firmata.SCHEDULER_DATA, [5])
	}

	// Requests task `id`'s delay, byte capacity, insertion position and messages.
	schedulerQuery(id: number) {
		this.#sendSysex(Firmata.SCHEDULER_DATA, [6, id])
	}

	// Clears all scheduler tasks and pending executions.
	schedulerReset() {
		this.#sendSysex(Firmata.SCHEDULER_DATA, [7])
	}

	// Enables raw edge-count reports for physical `pin` at `samplingMilliseconds`
	// intervals. Interrupt `mode` is LOW=1, HIGH=2, RISING=3, FALLING=4 or CHANGE=5.
	frequencyQuery(pin: number, mode: 1 | 2 | 3 | 4 | 5, samplingMilliseconds: number) {
		this.#sendSysex(Firmata.FREQUENCY_COMMAND, encodeFrequencyQuery(pin, mode, samplingMilliseconds))
	}

	// Disables frequency reporting on physical `pin`, or all pins when omitted.
	frequencyClear(pin: number = 127) {
		this.#sendSysex(Firmata.FREQUENCY_COMMAND, [0, pin])
	}

	// Sets physical `pin`'s edge debounce interval in `microseconds`.
	frequencyFilter(pin: number, microseconds: number) {
		this.#sendSysex(Firmata.FREQUENCY_COMMAND, encodeFrequencyFilter(pin, microseconds))
	}

	// Configures the I2C read delay in microseconds; retains the greatest requested
	// delay for this client so multiple peripherals do not shorten each other's timing.
	twoWireConfig(delayInMicroseconds: number) {
		this.#maxTwoWireDelay = Math.max(this.#maxTwoWireDelay, delayInMicroseconds)
		this.send(encodeTwoWireConfig(this.#maxTwoWireDelay))
	}

	// Sends one I2C transaction to `address` with 7- or 10-bit addressing. The
	// operation flag selects write, one-shot/continuous read or stop; `data` is raw
	// bytes, and `autoRestart` controls bus release after a read.
	twoWireReadWrite(address: number, operationMode: TwoWireOperationMode, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		this.send(encodeTwoWireReadWrite(address, operationMode, data, addressMode, autoRestart))
	}

	// Reads `bytesToRead` bytes from an I2C device, optionally selecting `register`
	// (-1 omits it). `continuous` repeats reads until stopped; address width and bus
	// release are controlled by `addressMode` and `autoRestart`.
	twoWireRead(address: number, register: number, bytesToRead: number, continuous: boolean = false, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		const data = new Uint8Array(register >= 0 ? [register, bytesToRead] : [bytesToRead])
		this.twoWireReadWrite(address, continuous ? 'readContinuously' : 'read', data, addressMode, autoRestart)
	}

	// Writes raw `data` bytes to a 7- or 10-bit I2C device address.
	twoWireWrite(address: number, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'write', data, addressMode)
	}

	// Stops a continuous read from the addressed 7- or 10-bit I2C device.
	twoWireStop(address: number, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'stop', undefined, addressMode)
	}

	// Configures a physical 1-Wire pin for external or parasitic device power.
	oneWireConfig(pin: number, powerMode: OneWirePowerMode = 'normal') {
		this.send(encodeOneWireConfig(pin, powerMode))
	}

	// Searches all or alarm-signalling ROM addresses on physical 1-Wire `pin`.
	oneWireSearch(pin: number, mode: OneWireSearchMode = 'all') {
		this.send(encodeOneWireSearch(pin, mode))
	}

	// Assembles and sends one 1-Wire command on a pin: sets the reset/skip/select/read/delay/write bits,
	// builds the (7-bit packed) payload, and returns the read correlation id when a read was requested.
	// Throws if both skip-ROM and a specific ROM address are requested, or the address is not 8 bytes.
	oneWireCommand(pin: number, options: OneWireCommandOptions = DEFAULT_ONE_WIRE_COMMAND_OPTIONS) {
		const { message, readCorrelationId, nextCorrelationId } = encodeOneWireCommand(pin, options, this.#oneWireCorrelationId)
		this.#oneWireCorrelationId = nextCorrelationId
		this.send(message)
		return readCorrelationId
	}

	// Issues a bus reset on physical 1-Wire `pin`.
	oneWireReset(pin: number) {
		this.oneWireCommand(pin, { reset: true })
	}

	// Resets the 1-Wire bus and writes `data`, selecting an optional eight-byte ROM
	// address or broadcasting with SKIP ROM when `address` is omitted.
	oneWireWrite(pin: number, data: Readonly<NumberArray> | Buffer, address?: Readonly<NumberArray> | Buffer) {
		this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, data })
	}

	// Resets the 1-Wire bus and reads `bytesToRead` bytes from an optional ROM;
	// returns the supplied or generated 16-bit correlation ID for the reply.
	oneWireRead(pin: number, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId })
	}

	// Writes `data` then reads `bytesToRead` bytes from an optional 1-Wire ROM;
	// returns the supplied or generated 16-bit correlation ID for the reply.
	oneWireWriteAndRead(pin: number, data: Readonly<NumberArray> | Buffer, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId, data })
	}

	// Emits the close event to handlers and re-arms initialization for a possible reconnect.
	close() {
		this.#fsm.close()
		// Re-arm initialization so a reconnect on the same client handshakes and becomes ready again.
		this.reset()
	}
}
