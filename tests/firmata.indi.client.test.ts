import { describe, expect, test } from 'bun:test'
import type { FirmataClient, FirmataClientHandler } from '../src/firmata'
import { FirmataIndiClient } from '../src/firmata.indi.client'
import type { Accelerometer, Altimeter, Ammeter, Barometer, Gyroscope, Hygrometer, ListenablePeripheral, Luxmeter, Magnetometer, Peripheral, PeripheralListener, RealTimeClock, Thermometer } from '../src/firmata.peripheral'
import type { IndiClientHandler } from '../src/indi.client'
import type { DefNumberVector, DelProperty, SetNumberVector, SetSwitchVector } from '../src/indi.types'

// Deterministic Firmata stand-in. Only the methods the adapter actually uses are implemented:
// handler registration and the initialization gate. `ready` controls the connection outcome.
class FakeFirmata {
	readonly handlers = new Set<FirmataClientHandler>()
	ready = true

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	ensureInitializationIsDone(timeout: number) {
		return Promise.resolve(this.ready)
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

		// Several axes of one vector changing produce exactly one set event for that vector.
		imu.ax = 9.81
		imu.az = -1
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

	test('rejects duplicate device names and duplicate peripheral registration', () => {
		const firmata = new FakeFirmata()
		using client = new FirmataIndiClient(firmata as never, 'Board')

		const peripheral = new FakeThermometer('LM35', firmata as never)
		client.createPeripheral(peripheral)

		expect(() => client.createPeripheral(peripheral)).toThrow(/already registered/)
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

	test('connect after systemReset waits for a fresh ready before connecting', async () => {
		const firmata = new FakeFirmata()
		const { events, handler } = createRecorder()
		using client = new FirmataIndiClient(firmata as never, 'Board', { handler })

		const peripheral = new FakeThermometer('LM35', firmata as never)
		const device = client.createPeripheral(peripheral)

		// Initial connect succeeds once the board is ready.
		await device.connect()
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(1)

		// A reset disconnects and invalidates readiness; the stale one-shot init must not satisfy it.
		firmata.fireSystemReset()
		expect(device.isConnected).toBeFalse()
		expect(client.ready).toBeFalse()

		// Connecting before a new ready must not start the peripheral nor publish a connected state.
		events.length = 0
		const pending = device.connect()
		await Bun.sleep(0)
		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(1)
		expect(events.some((e) => e.tag === 'setSwitch' && e.name === 'CONNECTION' && e.state === 'Idle')).toBeFalse()

		// A fresh ready completes the pending connect.
		firmata.fireReady()
		await pending
		expect(device.isConnected).toBeTrue()
		expect(peripheral.started).toBe(2)
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

		// DISCONNECT requested before initialization completes.
		client.sendSwitch({ device: 'LM35', name: 'CONNECTION', elements: { DISCONNECT: true } })

		// Initialization now completes; the cancelled connect must not start the peripheral.
		firmata.fireReady()
		await pending

		expect(device.isConnected).toBeFalse()
		expect(peripheral.started).toBe(0)
		expect(peripheral.listenerCount).toBe(0)

		// The connection settled back to a published Idle/DISCONNECT, never reporting connected.
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
})

// Polls a predicate until it holds or the timeout elapses.
async function waitUntil(predicate: () => boolean, timeout: number = 1000) {
	const start = performance.now()

	while (!predicate()) {
		if (performance.now() - start > timeout) throw new Error('waitUntil timed out')
		await Bun.sleep(10)
	}
}
