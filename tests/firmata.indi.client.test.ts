import { describe, expect, test } from 'bun:test'
import { FirmataClient, type FirmataClientHandler, type Transport } from '../src/firmata'
import { ESP8266 } from '../src/firmata.board'
import { FirmataIndiClient } from '../src/firmata.indi.client'
import type { Accelerometer, Altimeter, Ammeter, Barometer, Gyroscope, Hygrometer, ListenablePeripheral, Luxmeter, Magnetometer, Peripheral, PeripheralListener, RealTimeClock, Thermometer } from '../src/firmata.peripheral'
import { LM35 } from '../src/firmata.thermometer'
import type { IndiClientHandler } from '../src/indi.client'
import type { DefNumberVector, DelProperty, SetNumberVector, SetSwitchVector } from '../src/indi.types'

// Deterministic Firmata stand-in. Only the methods the adapter actually uses are implemented:
// handler registration and the initialization gate. `ready` controls the connection outcome.
class FakeFirmata {
	readonly handlers = new Set<FirmataClientHandler>()
	ready = true
	// When set, ensureInitializationIsDone resolves with this controllable promise instead of `ready`,
	// to model a board that is still initializing.
	initPromise?: Promise<boolean>

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	ensureInitializationIsDone(timeout: number) {
		return this.initPromise ?? Promise.resolve(this.ready)
	}

	fireReady() {
		for (const handler of this.handlers) handler.ready?.(this as never)
	}

	fireSystemReset() {
		for (const handler of this.handlers) handler.systemReset?.(this as never)
	}

	fireClose() {
		for (const handler of this.handlers) handler.close?.(this as never)
	}
}

// Minimal listenable peripheral test double that pushes readings through listeners on demand.
abstract class FakeListenable<D extends ListenablePeripheral<D>> implements Peripheral {
	started = 0
	stopped = 0
	readonly #listeners = new Set<PeripheralListener<D>>()

	constructor(
		readonly name: string,
		readonly client: FirmataClient,
	) {}

	addListener(listener: PeripheralListener<D>) {
		this.#listeners.add(listener)
	}

	removeListener(listener: PeripheralListener<D>) {
		this.#listeners.delete(listener)
	}

	start() {
		this.started++
	}

	stop() {
		this.stopped++
	}

	get listenerCount() {
		return this.#listeners.size
	}

	emit() {
		for (const listener of this.#listeners) listener(this as never)
	}

	[Symbol.dispose]() {
		this.stop()
	}
}

class FakeThermometer extends FakeListenable<FakeThermometer> implements Thermometer {
	temperature = 0
}

// Thermometer whose start() arms itself (as real peripherals register their handler/reports) and then
// throws, to exercise cleanup of partially-started peripherals.
class FakeThrowingThermometer extends FakeListenable<FakeThrowingThermometer> implements Thermometer {
	temperature = 0
	armed = false

	start() {
		super.start()
		this.armed = true
		throw new Error('start failed')
	}

	stop() {
		super.stop()
		this.armed = false
	}
}

// Thermometer that delivers its first reading synchronously inside start(), as some drivers may.
class FakeSyncThermometer extends FakeListenable<FakeSyncThermometer> implements Thermometer {
	temperature = 0

	start() {
		super.start()
		this.temperature = 19.25
		this.emit()
	}
}

class FakeBarometer extends FakeListenable<FakeBarometer> implements Barometer, Altimeter, Thermometer {
	pressure = 0
	altitude = 0
	temperature = 0
}

class FakePureBarometer extends FakeListenable<FakePureBarometer> implements Barometer {
	pressure = 0
}

class FakeHygrometer extends FakeListenable<FakeHygrometer> implements Hygrometer, Thermometer {
	humidity = 0
	temperature = 0
}

class FakeAmmeter extends FakeListenable<FakeAmmeter> implements Ammeter {
	current = 0
}

class FakeLuxmeter extends FakeListenable<FakeLuxmeter> implements Luxmeter {
	lux = 0
}

class FakeImu extends FakeListenable<FakeImu> implements Accelerometer, Gyroscope {
	ax = 0
	ay = 0
	az = 0
	gx = 0
	gy = 0
	gz = 0
}

class FakeMagnetometer extends FakeListenable<FakeMagnetometer> implements Magnetometer {
	x = 0
	y = 0
	z = 0
}

class FakeRtc extends FakeListenable<FakeRtc> implements RealTimeClock {
	// Zero calendar fields mirror the real DS3231/DS1307 drivers, whose start() only queues an I2C read.
	year = 0
	month = 0
	day = 0
	dayOfWeek = 0
	hour = 0
	minute = 0
	second = 0
	millisecond = 0

	readonly updates: number[][] = []
	syncs = 0

	update(year = this.year, month = this.month, day = this.day, dayOfWeek = this.dayOfWeek, hour = this.hour, minute = this.minute, second = this.second, millisecond = this.millisecond) {
		this.updates.push([year, month, day, dayOfWeek, hour, minute, second, millisecond])
	}

	sync(date: Date = new Date()) {
		this.syncs++
	}
}

interface RecordedEvent {
	readonly tag: string
	readonly device: string
	readonly name?: string
	readonly value?: number
	readonly state?: string
	readonly server?: boolean
	readonly elements?: Record<string, number>
}

// Snapshots a number vector's element values for assertions.
function snapshot(m: DefNumberVector | SetNumberVector) {
	const out: Record<string, number> = {}
	for (const name in m.elements) out[name] = m.elements[name].value
	return out
}

// Records the INDI events emitted by the adapter for assertions.
function createRecorder() {
	const events: RecordedEvent[] = []

	const handler: IndiClientHandler = {
		defTextVector: (_, m) => events.push({ tag: 'defText', device: m.device, name: m.name }),
		defNumberVector: (_, m: DefNumberVector) => events.push({ tag: 'defNumber', device: m.device, name: m.name, state: m.state, value: Object.values(m.elements)[0]?.value, elements: snapshot(m) }),
		defSwitchVector: (_, m) => events.push({ tag: 'defSwitch', device: m.device, name: m.name, state: m.state }),
		setNumberVector: (_, m: SetNumberVector) => events.push({ tag: 'setNumber', device: m.device, name: m.name, state: m.state, value: Object.values(m.elements)[0]?.value, elements: snapshot(m) }),
		setSwitchVector: (_, m: SetSwitchVector) => events.push({ tag: 'setSwitch', device: m.device, name: m.name, state: m.state }),
		delProperty: (_, m: DelProperty) => events.push({ tag: 'del', device: m.device, name: m.name }),
		close: (_, server) => events.push({ tag: 'close', device: '', server }),
	}

	return { events, handler }
}

function tagsFor(events: readonly RecordedEvent[], device: string, name?: string) {
	return events.filter((e) => e.device === device && (name === undefined || e.name === name)).map((e) => e.tag)
}

describe('firmata indi client', () => {
	test('satisfies the client contract with stable identity metadata', () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Arduino Uno')

		expect(client.type).toBe('FIRMATA')
		expect(client.id).toMatch(/^[0-9a-f]{32}$/)
		expect(client.id).toBe(new FirmataIndiClient(new FakeFirmata() as never, 'Arduino Uno').id)
		expect(client.description).toContain('Arduino Uno')
		expect(typeof client.getProperties).toBe('function')
		expect(typeof client.enableBlob).toBe('function')
		expect(() => client.enableBlob({ device: 'Arduino Uno', value: 'Never' })).not.toThrow()
		expect(firmata.handlers.size).toBe(1)
	})

	test('creating a thermometer publishes general/control defs and starts disconnected', () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const device = client.createPeripheral(new FakeThermometer('LM35', firmata as never))

		expect(tagsFor(events, 'LM35', 'DRIVER_INFO')).toContain('defText')
		expect(tagsFor(events, 'LM35', 'CONNECTION')).toContain('defSwitch')
		expect(tagsFor(events, 'LM35', 'TEMPERATURE')).toHaveLength(0)
		expect(device.isConnected).toBeFalse()
	})

	test('a handler can auto-connect the device synchronously from its CONNECTION definition', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()

		// React to the CONNECTION definition by immediately requesting a connect, exercising the path
		// where the command must route back to the just-registered device.
		const autoConnect: IndiClientHandler = {
			...handler,
			defSwitchVector: (c, m) => {
				handler.defSwitchVector?.(c, m)
				if (m.name === 'CONNECTION') c.sendSwitch({ device: m.device, name: 'CONNECTION', elements: { CONNECT: true } })
			},
		}

		using client = new FirmataIndiClient(firmata as never, 'Board', { handler: autoConnect })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		peripheral.temperature = 12
		const device = client.createPeripheral(peripheral)

		await waitUntil(() => device.isConnected)
		expect(peripheral.started).toBe(1)
		expect(events.some((e) => e.tag === 'defNumber' && e.device === 'LM35' && e.name === 'TEMPERATURE')).toBeTrue()
	})

	test('connecting starts the peripheral once, defines TEMPERATURE and publishes its value', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		peripheral.temperature = 21.5
		const device = client.createPeripheral(peripheral)

		await device.connect()

		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(1)
		expect(peripheral.listenerCount).toBe(1)

		const def = events.find((e) => e.tag === 'defNumber' && e.name === 'TEMPERATURE')
		expect(def).toBeDefined()
		const connStates = events.filter((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION').map((e) => e.state)
		expect(connStates).toEqual(['Busy', 'Idle'])
	})

	test('a listener update publishes a changed setNumberVector but not a duplicate', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		peripheral.temperature = 25
		peripheral.emit()

		let sets = events.filter((e) => e.tag === 'setNumber' && e.name === 'TEMPERATURE')
		expect(sets).toHaveLength(1)
		expect(sets[0].value).toBe(25)

		// Same value: no duplicate event.
		peripheral.emit()
		sets = events.filter((e) => e.tag === 'setNumber' && e.name === 'TEMPERATURE')
		expect(sets).toHaveLength(1)

		// New value: another event.
		peripheral.temperature = 26
		peripheral.emit()
		sets = events.filter((e) => e.tag === 'setNumber' && e.name === 'TEMPERATURE')
		expect(sets).toHaveLength(2)
		expect(sets[1].value).toBe(26)
	})

	test('a synchronous first reading during start settles the vector to Idle, def before set', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeSyncThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		// The definition must precede the value set, and the synchronous reading must settle the vector
		// to Idle instead of leaving it stuck Busy.
		const temp = events.filter((e) => (e.tag === 'defNumber' || e.tag === 'setNumber') && e.name === 'TEMPERATURE')
		expect(temp.map((e) => e.tag)).toEqual(['defNumber', 'setNumber'])
		expect(temp[0].state).toBe('Busy')
		expect(temp.at(-1)?.state).toBe('Idle')
		expect(temp.at(-1)?.value).toBe(19.25)
	})

	test('a first reading equal to the default still settles the vector to Idle', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		// Default reading is 0; the peripheral fires its first completed read even though the value did
		// not change, so the vector must settle instead of staying Busy forever.
		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		peripheral.emit()

		const set = events.find((e) => e.tag === 'setNumber' && e.name === 'TEMPERATURE')
		expect(set?.state).toBe('Idle')
		expect(set?.value).toBe(0)
	})

	test('a sensor vector stays Busy until the first reading instead of announcing a default 0 as valid', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		// Default reading field is 0, mirroring a real sensor before its first asynchronous reply.
		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		// The initial definition is Busy, so the bogus 0 is not presented as a valid reading.
		const def = events.find((e) => e.tag === 'defNumber' && e.name === 'TEMPERATURE')
		expect(def?.state).toBe('Busy')

		// The first reading (arriving after start()) settles the vector to Idle with the real value.
		peripheral.temperature = 23.5
		peripheral.emit()
		const set = events.find((e) => e.tag === 'setNumber' && e.name === 'TEMPERATURE')
		expect(set?.state).toBe('Idle')
		expect(set?.value).toBe(23.5)
	})

	test('hygrometer and barometer factories define required and optional measurements', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const baro = new FakeBarometer('BMP280', firmata as never)
		baro.pressure = 1013.25
		baro.altitude = 0 // AU
		baro.temperature = 18
		const baroDevice = client.createPeripheral(baro)
		await baroDevice.connect()

		const pureBaro = new FakePureBarometer('PURE', firmata as never)
		const pureDevice = client.createPeripheral(pureBaro)
		await pureDevice.connect()

		const hygro = new FakeHygrometer('AM2320', firmata as never)
		hygro.humidity = 55
		hygro.temperature = 19
		const hygroDevice = client.createPeripheral(hygro)
		await hygroDevice.connect()

		const baroDefs = events.filter((e) => e.tag === 'defNumber' && e.device === 'BMP280').map((e) => e.name)
		expect(baroDefs).toContain('PRESSURE')
		expect(baroDefs).toContain('ALTITUDE')
		expect(baroDefs).toContain('TEMPERATURE')

		// Pure barometer exposes only PRESSURE.
		const pureDefs = events.filter((e) => e.tag === 'defNumber' && e.device === 'PURE').map((e) => e.name)
		expect(pureDefs).toEqual(['PRESSURE'])

		const hygroDefs = events.filter((e) => e.tag === 'defNumber' && e.device === 'AM2320').map((e) => e.name)
		expect(hygroDefs).toContain('RELATIVE_HUMIDITY')
		expect(hygroDefs).toContain('TEMPERATURE')
	})

	test('ammeter and luxmeter expose single-axis measurements', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const ammeter = new FakeAmmeter('ACS712', firmata as never)
		ammeter.current = 1.5
		await client.createPeripheral(ammeter).connect()

		const lux = new FakeLuxmeter('BH1750', firmata as never)
		lux.lux = 320
		await client.createPeripheral(lux).connect()

		expect(events.find((e) => e.tag === 'defNumber' && e.device === 'ACS712' && e.name === 'CURRENT')?.value).toBe(1.5)
		expect(events.find((e) => e.tag === 'defNumber' && e.device === 'BH1750' && e.name === 'ILLUMINANCE')?.value).toBe(320)
	})

	test('imu and magnetometer expose multi-axis measurements with single change events', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const imu = new FakeImu('MPU6050', firmata as never)
		const imuDevice = client.createPeripheral(imu)
		await imuDevice.connect()

		const imuDefs = events.filter((e) => e.tag === 'defNumber' && e.device === 'MPU6050').map((e) => e.name)
		expect(imuDefs).toContain('ACCELERATION')
		expect(imuDefs).toContain('ANGULAR_VELOCITY')

		// The first reading settles both vectors to Idle, one set each (confirming hardware values).
		imu.ax = 9.81
		imu.az = -1
		imu.emit()
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'ACCELERATION')).toHaveLength(1)
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'ANGULAR_VELOCITY')).toHaveLength(1)

		// A later reading that changes only acceleration produces one ACCELERATION set and no gyro set.
		events.length = 0
		imu.ax = 1
		imu.emit()
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'ACCELERATION')).toHaveLength(1)
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'ANGULAR_VELOCITY')).toHaveLength(0)

		const mag = new FakeMagnetometer('HMC5883L', firmata as never)
		mag.x = 0.2
		mag.y = -0.1
		mag.z = 0.4
		await client.createPeripheral(mag).connect()
		expect(events.find((e) => e.tag === 'defNumber' && e.device === 'HMC5883L' && e.name === 'MAGNETIC_FIELD')?.value).toBe(0.2)
	})

	test('real-time clock publishes a writable TIME vector and routes writes to update/sync', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const rtc = new FakeRtc('DS3231', firmata as never)
		rtc.year = 2024
		rtc.month = 6
		rtc.day = 18
		const device = client.createPeripheral(rtc)
		await device.connect()

		// TIME is defined with current values; TIME_SYNC switch becomes available once connected.
		expect(events.find((e) => e.tag === 'defNumber' && e.device === 'DS3231' && e.name === 'TIME')?.value).toBe(2024)
		expect(events.some((e) => e.tag === 'defSwitch' && e.device === 'DS3231' && e.name === 'TIME_SYNC')).toBeTrue()

		// sendNumber routes to update() with the supplied fields.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 2030, MONTH: 12, DAY: 25, HOUR: 10, MINUTE: 20, SECOND: 30 } })
		expect(rtc.updates).toHaveLength(1)
		expect(rtc.updates[0].slice(0, 3)).toEqual([2030, 12, 25])

		// sendSwitch on TIME_SYNC calls sync() and resets the momentary switch.
		client.sendSwitch({ device: 'DS3231', name: 'TIME_SYNC', elements: { SYNC: true } })
		expect(rtc.syncs).toBe(1)
		expect(events.some((e) => e.tag === 'setSwitch' && e.name === 'TIME_SYNC')).toBeTrue()

		// Writes are ignored while disconnected and TIME_SYNC is removed on disconnect.
		device.disconnect()
		expect(tagsFor(events, 'DS3231', 'TIME_SYNC')).toContain('del')
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 1999 } })
		client.sendSwitch({ device: 'DS3231', name: 'TIME_SYNC', elements: { SYNC: true } })
		expect(rtc.updates).toHaveLength(1)
		expect(rtc.syncs).toBe(1)
	})

	test('a partial TIME write without DAY_OF_WEEK recomputes the weekday from the new date', async () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		const rtc = new FakeRtc('DS3231', firmata as never)
		// Existing valid reading with a stale weekday that must not leak into the new date.
		rtc.year = 2020
		rtc.month = 1
		rtc.day = 1
		rtc.dayOfWeek = 3
		const device = client.createPeripheral(rtc)
		await device.connect()
		rtc.emit() // settle TIME to Idle so partial (date-only) writes are accepted

		// Change only the date; omit DAY_OF_WEEK.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 2024, MONTH: 6, DAY: 18 } })

		expect(rtc.updates).toHaveLength(1)
		const [year, month, day, dayOfWeek] = rtc.updates[0]
		expect([year, month, day]).toEqual([2024, 6, 18])
		// 2024-06-18 is a Tuesday (getDay() === 2), not the previous weekday (3).
		expect(dayOfWeek).toBe(2)

		// An explicit DAY_OF_WEEK is still honored as sent.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 2024, MONTH: 6, DAY: 19, DAY_OF_WEEK: 5 } })
		expect(rtc.updates[1][3]).toBe(5)
	})

	test('ignores a partial TIME write while the clock is still a Busy placeholder', async () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		// Zeroed calendar fields, as on a real DS3231/DS1307 before its first I2C reply.
		const rtc = new FakeRtc('DS3231', firmata as never)
		const device = client.createPeripheral(rtc)
		await device.connect() // TIME is published Busy with placeholder defaults, not hardware time

		// A time-only write must not write the placeholder date back, resetting the clock.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { HOUR: 12 } })
		expect(rtc.updates).toHaveLength(0)

		// A date-only write is also rejected while Busy: the omitted HOUR/MINUTE/SECOND would be filled
		// from placeholder zeros, resetting the current time.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 2024, MONTH: 6, DAY: 18 } })
		expect(rtc.updates).toHaveLength(0)

		// A complete date and time is accepted even while Busy.
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { YEAR: 2024, MONTH: 6, DAY: 18, HOUR: 12, MINUTE: 30, SECOND: 15 } })
		expect(rtc.updates).toHaveLength(1)
		expect(rtc.updates[0].slice(0, 3)).toEqual([2024, 6, 18])

		// After a valid reading settles TIME to Idle, partial writes preserve the hardware date.
		rtc.year = 2030
		rtc.month = 9
		rtc.day = 5
		rtc.emit()
		client.sendNumber({ device: 'DS3231', name: 'TIME', elements: { HOUR: 8 } })
		expect(rtc.updates).toHaveLength(2)
		expect(rtc.updates[1].slice(0, 3)).toEqual([2030, 9, 5])
	})

	test('an RTC with default (zero) calendar fields publishes TIME busy until a valid reading', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		// Calendar fields are still the constructor defaults (zero) at connect, as on the real drivers.
		const rtc = new FakeRtc('DS3231', firmata as never)
		const device = client.createPeripheral(rtc)
		await device.connect()

		// TIME is defined Busy with its in-range defaults, not the out-of-range zero month/day.
		const def = events.find((e) => e.tag === 'defNumber' && e.device === 'DS3231' && e.name === 'TIME')
		expect(def?.state).toBe('Busy')
		expect(def?.elements?.MONTH).toBe(1)
		expect(def?.elements?.DAY).toBe(1)

		// The first valid reading settles TIME to Idle with the real values.
		rtc.year = 2024
		rtc.month = 6
		rtc.day = 18
		rtc.emit()

		const set = events.find((e) => e.tag === 'setNumber' && e.name === 'TIME')
		expect(set?.state).toBe('Idle')
		expect(set?.elements?.YEAR).toBe(2024)
		expect(set?.elements?.MONTH).toBe(6)
		expect(set?.elements?.DAY).toBe(18)
	})

	test('an RTC ignores a later corrupt frame that decodes month/day as zero', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const rtc = new FakeRtc('DS3231', firmata as never)
		const device = client.createPeripheral(rtc)
		await device.connect()

		// A valid frame settles TIME to Idle with real values.
		rtc.year = 2024
		rtc.month = 6
		rtc.day = 18
		rtc.emit()
		const settled = events.find((e) => e.tag === 'setNumber' && e.name === 'TIME')
		expect(settled?.state).toBe('Idle')
		expect(settled?.elements?.MONTH).toBe(6)
		expect(settled?.elements?.DAY).toBe(18)

		// A later corrupt frame decodes month/day as 0 (outside the vector range). It must be ignored,
		// not published as an Idle TIME with out-of-range values.
		events.length = 0
		rtc.month = 0
		rtc.day = 0
		rtc.emit()
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'TIME')).toHaveLength(0)
	})

	test('an RTC ignores frames with an out-of-range weekday or month', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const rtc = new FakeRtc('DS3231', firmata as never)
		const device = client.createPeripheral(rtc)
		await device.connect()

		// Settle with a valid frame.
		rtc.year = 2024
		rtc.month = 6
		rtc.day = 18
		rtc.dayOfWeek = 2
		rtc.emit()
		expect(events.some((e) => e.tag === 'setNumber' && e.name === 'TIME')).toBeTrue()

		// A corrupt weekday register (0) decodes to dayOfWeek -1, below the declared min; ignore it.
		events.length = 0
		rtc.dayOfWeek = -1
		rtc.emit()
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'TIME')).toHaveLength(0)

		// A corrupt month (13) is above the declared max; ignore it too.
		rtc.dayOfWeek = 2
		rtc.month = 13
		rtc.emit()
		expect(events.filter((e) => e.tag === 'setNumber' && e.name === 'TIME')).toHaveLength(0)
	})

	test('getProperties filters by device and name and re-emits def plus value', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		peripheral.temperature = 10
		const device = client.createPeripheral(peripheral)
		await device.connect()

		// Unrelated device that must not respond to the filtered query.
		client.createPeripheral(new FakeThermometer('LM35b', firmata as never))

		events.length = 0
		client.getProperties({ device: 'LM35', name: 'TEMPERATURE' })

		expect(tagsFor(events, 'LM35', 'TEMPERATURE').sort()).toEqual(['defNumber', 'setNumber'])
		expect(events.every((e) => e.device === 'LM35')).toBeTrue()
		expect(events.find((e) => e.tag === 'setNumber')?.value).toBe(10)
	})

	test('sendSwitch routes CONNECTION only to the matching device and supports disconnect cleanup', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const a = new FakeThermometer('A', firmata as never)
		const b = new FakeThermometer('B', firmata as never)
		const deviceA = client.createPeripheral(a)
		client.createPeripheral(b)

		client.sendSwitch({ device: 'A', name: 'CONNECTION', elements: { CONNECT: true } })
		await waitUntil(() => deviceA.isConnected)

		expect(a.started).toBe(1)
		expect(b.started).toBe(0)

		events.length = 0
		client.sendSwitch({ device: 'A', name: 'CONNECTION', elements: { DISCONNECT: true } })

		expect(deviceA.isConnected).toBeFalse()
		expect(a.stopped).toBe(1)
		expect(a.listenerCount).toBe(0)
		expect(tagsFor(events, 'A', 'TEMPERATURE')).toContain('del')
	})

	test('a readiness seed resolving after dispose does not mark a disposed adapter ready', async () => {
		const firmata = new FakeFirmata()
		const init = Promise.withResolvers<boolean>()
		firmata.initPromise = init.promise // board still initializing when the adapter is constructed
		const client = new FirmataIndiClient(firmata as never, 'Board')

		expect(client.ready).toBeFalse()

		client.dispose()

		// The board finishes initializing only after disposal; the late seed must not revive readiness.
		init.resolve(true)
		await init.promise
		await Bun.sleep(0)

		expect(client.ready).toBeFalse()
		expect(await client.whenReady()).toBeFalse()
	})

	test('rejects registration after the client is disposed', async () => {
		const firmata = new FakeFirmata()
		const client = new FirmataIndiClient(firmata as never, 'Board')

		client.dispose()

		const peripheral = new FakeThermometer('LM35', firmata as never)
		expect(() => client.createPeripheral(peripheral)).toThrow(/disposed/)

		// No device exists to connect, and the peripheral was never started.
		client.sendSwitch({ device: 'LM35', name: 'CONNECTION', elements: { CONNECT: true } })
		await Bun.sleep(0)
		expect(peripheral.started).toBe(0)
	})

	test('rejects a peripheral bound to a different firmata client', () => {
		const boardA = new FakeFirmata()
		const boardB = new FakeFirmata()
		using client = new FirmataIndiClient(boardA as never, 'Board A')

		// Sensor lives on board B; gating connects on board A while writing to board B (and missing
		// board B's reset/close) must be rejected up front.
		const foreign = new FakeThermometer('LM35', boardB as never)
		expect(() => client.createPeripheral(foreign)).toThrow(/different Firmata client/)

		// A peripheral on this adapter's own client still registers.
		const own = new FakeThermometer('LM35b', boardA as never)
		expect(() => client.createPeripheral(own)).not.toThrow()
	})

	test('rejects duplicate device names and duplicate peripheral registration', () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		const peripheral = new FakeThermometer('LM35', firmata as never)
		client.createPeripheral(peripheral)

		expect(() => client.createPeripheral(peripheral)).toThrow(/already registered/)
	})

	test('disposing one virtual device unregisters it so it can be re-registered', () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		device.dispose()
		expect(tagsFor(events, 'LM35')).toContain('del')

		// getProperties must not re-announce the disposed device.
		events.length = 0
		client.getProperties({ device: 'LM35' })
		expect(events).toHaveLength(0)

		// The same peripheral and name can be registered again without a duplicate error.
		expect(() => client.createPeripheral(peripheral)).not.toThrow()
		expect(tagsFor(events, 'LM35', 'CONNECTION')).toContain('defSwitch')
	})

	test('connection failure leaves the device safely disconnected', async () => {
		const firmata = new FakeFirmata()
		firmata.ready = false
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler, connectionTimeout: 0 })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		await device.connect()

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)
		expect(peripheral.listenerCount).toBe(0)
		const connStates = events.filter((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION').map((e) => e.state)
		expect(connStates).toEqual(['Busy', 'Alert'])
	})

	test('reconnects after a systemReset without requiring a fresh ready event', async () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		// Initial connect succeeds once the board is ready.
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(1)

		// A board reset disconnects the device. A real FirmataClient stays initialized and never
		// re-emits ready, so the adapter must re-derive readiness rather than wait forever.
		firmata.fireSystemReset()
		expect(device.isConnected).toBeFalse()

		await waitUntil(() => client.ready)

		// The reconnect succeeds with no new ready event; the peripheral re-establishes its config.
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(2)
	})

	test('an auto-reconnect from the reset disconnect notification is gated by readiness', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()

		// Auto-reconnect: when CONNECTION settles to disconnected, immediately request CONNECT again.
		const autoReconnect: IndiClientHandler = {
			...handler,
			setSwitchVector: (c, m) => {
				handler.setSwitchVector?.(c, m)
				if (m.name === 'CONNECTION' && m.state === 'Idle' && m.elements.DISCONNECT?.value === true) {
					c.sendSwitch({ device: m.device, name: 'CONNECTION', elements: { CONNECT: true } })
				}
			},
		}

		using client = new FirmataIndiClient(firmata as never, 'Board', { handler: autoReconnect })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(1)

		// The board resets and is not ready again. Readiness is invalidated before the disconnect is
		// published, so the reactive reconnect is gated on the (still unready) board and must not start
		// the peripheral. If connect captured the stale ready state during the transport-lost pass it
		// would start a second time on the just-reset board.
		firmata.ready = false
		firmata.fireSystemReset()
		await Bun.sleep(0)

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(1)
	})

	test('a device reconnects after a transport close once the board is ready again', async () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(1)

		// The transport closes: the device disconnects and readiness is cleared.
		firmata.fireClose()
		expect(device.isConnected).toBeFalse()
		expect(client.ready).toBeFalse()

		// The transport reconnects and the board completes a fresh handshake, re-emitting ready (which
		// the FirmataClient now does because close re-arms its initialization gate).
		firmata.fireReady()
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(2)
	})

	test('a real FirmataClient stays usable after a system-reset byte', async () => {
		const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
		const firmata = new FirmataClient(transport, new ESP8266())
		using client = new FirmataIndiClient(firmata, 'Board')

		// Drive the client through its initialization handshake until it reports ready.
		firmata.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7])) // firmware
		firmata.process(Buffer.from([0xf0, 0x6c, 0x7f, 0x7f, 0xf7])) // pin capability (no modes)
		firmata.process(Buffer.from([0xf0, 0x6a, 0x7f, 0x7f, 1, 0xf7])) // analog mapping -> ready
		await waitUntil(() => client.ready)

		const lm35 = new LM35(firmata, ESP8266.A0)
		const device = client.createPeripheral(lm35)
		await device.connect()
		expect(device.isConnected).toBeTrue()

		// A board system-reset byte disconnects the device. The client stays initialized and will not
		// re-emit ready, so the adapter must remain usable rather than waiting for a ready that never comes.
		firmata.process(Buffer.from([0xff]))
		expect(device.isConnected).toBeFalse()

		await waitUntil(() => client.ready)
		await device.connect()
		expect(device.isConnected).toBeTrue()
	})

	test('a peripheral whose start() throws after arming is stopped and left in Alert', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThrowingThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		await device.connect()

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(1) // start was attempted
		expect(peripheral.stopped).toBe(1) // cleanup ran despite the throw
		expect(peripheral.armed).toBeFalse() // stop() undid the partial setup
		expect(peripheral.listenerCount).toBe(0)
		const connStates = events.filter((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION').map((e) => e.state)
		expect(connStates).toEqual(['Busy', 'Alert'])
	})

	test('a disconnect from the first measurement definition leaves the peripheral unstarted', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()

		// React to the first measurement definition by requesting DISCONNECT, which happens after the
		// definitions are published but before connect() starts the peripheral.
		const cancelOnFirstDef: IndiClientHandler = {
			...handler,
			defNumberVector: (c, m) => {
				handler.defNumberVector?.(c, m)
				if (m.name === 'TEMPERATURE') c.sendSwitch({ device: m.device, name: 'CONNECTION', elements: { DISCONNECT: true } })
			},
		}

		using client = new FirmataIndiClient(firmata as never, 'Board', { handler: cancelOnFirstDef })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		await device.connect()

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0) // never started: cancellation honored before start()
		expect(peripheral.stopped).toBe(0) // and therefore never stopped
		expect(peripheral.listenerCount).toBe(0)
		expect(tagsFor(events, 'LM35', 'TEMPERATURE')).toContain('del')

		// Never reported connected: the only connection sets are the initial Busy and the rollback Idle.
		const connStates = events.filter((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION').map((e) => e.state)
		expect(connStates).toEqual(['Busy', 'Idle'])
	})

	test('a disconnect from the connected notification tears the device back down', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()

		// React to CONNECTION settling to Idle with CONNECT selected by requesting DISCONNECT, the very
		// last step of connect() after its final cancellation check.
		const disconnectOnConnected: IndiClientHandler = {
			...handler,
			setSwitchVector: (c, m) => {
				handler.setSwitchVector?.(c, m)
				if (m.name === 'CONNECTION' && m.state === 'Idle' && m.elements.CONNECT?.value === true) {
					c.sendSwitch({ device: m.device, name: 'CONNECTION', elements: { DISCONNECT: true } })
				}
			},
		}

		using client = new FirmataIndiClient(firmata as never, 'Board', { handler: disconnectOnConnected })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		await device.connect()

		// The reactive disconnect must win: the device ends disconnected and fully cleaned up.
		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(1)
		expect(peripheral.stopped).toBe(1)
		expect(peripheral.listenerCount).toBe(0)
		expect(tagsFor(events, 'LM35', 'TEMPERATURE')).toContain('del')
	})

	test('disconnect during a pending connect cancels it before the peripheral starts', async () => {
		const firmata = new FakeFirmata()
		firmata.ready = false // board still initializing, so whenReady stays pending
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		// CONNECT requested while the board is still initializing.
		const pending = device.connect()
		await Bun.sleep(0)
		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)

		// DISCONNECT requested before initialization completes. The pending connect must settle promptly
		// off the cancel signal, without waiting for a later ready event or the connection timeout.
		client.sendSwitch({ device: 'LM35', name: 'CONNECTION', elements: { DISCONNECT: true } })

		const outcome = await Promise.race([pending.then(() => 'settled'), Bun.sleep(100).then(() => 'timeout')])
		expect(outcome).toBe('settled')

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)
		expect(peripheral.listenerCount).toBe(0)

		// The connection settled back to a published Idle/DISCONNECT, never reporting connected, and no
		// ready event was needed.
		const connStates = events.filter((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION').map((e) => e.state)
		expect(connStates).toEqual(['Busy', 'Idle'])
	})

	test('dispose during a pending connect aborts it before the peripheral starts', async () => {
		const firmata = new FakeFirmata()
		firmata.ready = false
		const client = new FirmataIndiClient(firmata as never, 'Board')

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		const pending = device.connect()
		await Bun.sleep(0)

		client.dispose()
		await pending

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)
		expect(peripheral.listenerCount).toBe(0)
	})

	test('whenReady() reflects readiness when the board signals while the call is pending', async () => {
		const firmata = new FakeFirmata()
		firmata.ready = false // board not ready, so whenReady() stays pending on the current generation
		using client = new FirmataIndiClient(firmata as never, 'Board')

		// A reset while pending must resolve false, not the gate's settlement-as-true.
		const pendingReset = client.whenReady()
		firmata.fireSystemReset()
		expect(await pendingReset).toBeFalse()
		expect(client.ready).toBeFalse()

		// A close while pending must also resolve false.
		const pendingClose = client.whenReady()
		firmata.fireClose()
		expect(await pendingClose).toBeFalse()

		// A genuine ready while pending resolves true.
		const pendingReady = client.whenReady()
		firmata.fireReady()
		expect(await pendingReady).toBeTrue()
		expect(client.ready).toBeTrue()
	})

	test('a connect waiting on readiness settles immediately when the board closes mid-wait', async () => {
		const firmata = new FakeFirmata()
		firmata.ready = false // board not ready, so whenReady stays pending on the current generation
		const client = new FirmataIndiClient(firmata as never, 'Board') // default (long) connection timeout

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		const pending = device.connect()
		await Bun.sleep(0)
		expect(device.isConnected).toBeFalse()

		// Board closes (replacing the readiness gate) and the caller disposes the client. The in-flight
		// connect must settle via the gate, not linger until connectionTimeout.
		firmata.fireClose()
		client.dispose()

		const outcome = await Promise.race([pending.then(() => 'settled'), Bun.sleep(100).then(() => 'timeout')])
		expect(outcome).toBe('settled')
		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)
	})

	test('firmata reset and close disconnect devices, and dispose is idempotent', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		const client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		firmata.fireSystemReset()
		expect(device.isConnected).toBeFalse()
		expect(peripheral.stopped).toBe(1)
		expect(peripheral.listenerCount).toBe(0)
		expect(tagsFor(events, 'LM35', 'TEMPERATURE')).toContain('del')

		// Reconnect after a fresh ready, then verify close also disconnects.
		firmata.fireReady()
		await device.connect()
		expect(device.isConnected).toBeTrue()
		firmata.fireClose()
		expect(device.isConnected).toBeFalse()

		const closeBefore = events.filter((e) => e.tag === 'close').length
		client.dispose()
		client.dispose()
		const closeAfter = events.filter((e) => e.tag === 'close').length

		// close fired once by fireClose (server=true); dispose must not fire it again.
		expect(closeBefore).toBe(1)
		expect(closeAfter).toBe(1)
		expect(firmata.handlers.size).toBe(0)
	})

	test('a reconnected transport closing again notifies consumers a second time', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)
		await device.connect()

		// First transport close notifies consumers.
		firmata.fireClose()
		expect(events.filter((e) => e.tag === 'close')).toHaveLength(1)

		// The transport reconnects (fresh ready) and the device connects again.
		firmata.fireReady()
		await device.connect()
		expect(device.isConnected).toBeTrue()

		// A second close must notify again so consumers tear down the new generation.
		firmata.fireClose()
		expect(events.filter((e) => e.tag === 'close')).toHaveLength(2)
	})
})

// Polls a predicate until it holds or the timeout elapses.
async function waitUntil(predicate: () => boolean, timeout: number = 1000) {
	const start = performance.now()

	while (!predicate()) {
		if (performance.now() - start > timeout) throw new Error('waitUntil timed out')
		await Bun.sleep(10)
	}
}
