import { describe, expect, test } from 'bun:test'
import { equatorialToHorizontal } from '../../../../src/astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../../src/astronomy/observer/location'
import { timeUnix } from '../../../../src/astronomy/time/time'
import { DEFAULT_MOUNT, type Mount, type PierSide } from '../../../../src/devices/indi/device'
import { CoverCap } from '../../../../src/devices/indi/simulator/cover.cap'
import { DEFAULT_COVER_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/cover.config'
import { DEFAULT_DOME_SIMULATOR_CONFIG, type DomeGeometryConfig } from '../../../../src/devices/indi/simulator/dome.config'
import { DomeDrive, type DomeMove } from '../../../../src/devices/indi/simulator/dome.drive'
import { DomeGeometry } from '../../../../src/devices/indi/simulator/dome.geometry'
import { DomeParking } from '../../../../src/devices/indi/simulator/dome.parking'
import { DomeShutter } from '../../../../src/devices/indi/simulator/dome.shutter'
import { DomeSlaving } from '../../../../src/devices/indi/simulator/dome.slaving'
import { DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/flatpanel.config'
import { FlatPanelLight } from '../../../../src/devices/indi/simulator/flatpanel.light'
import { FocuserCompensation } from '../../../../src/devices/indi/simulator/focuser.compensation'
import { DEFAULT_FOCUSER_SIMULATOR_CONFIG, focuserSimulatorConfig, type FocuserSimulatorConfigOverride } from '../../../../src/devices/indi/simulator/focuser.config'
import { FocuserDrive } from '../../../../src/devices/indi/simulator/focuser.drive'
import { FocuserGear } from '../../../../src/devices/indi/simulator/focuser.gear'
import { FocuserThermometer } from '../../../../src/devices/indi/simulator/focuser.thermometer'
import { DEFAULT_ROTATOR_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/rotator.config'
import { RotatorDrive } from '../../../../src/devices/indi/simulator/rotator.drive'
import { advanceRotation } from '../../../../src/devices/indi/simulator/util'
import { WheelCarousel } from '../../../../src/devices/indi/simulator/wheel.carousel'
import { DEFAULT_WHEEL_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/wheel.config'
import { WheelNames } from '../../../../src/devices/indi/simulator/wheel.names'
import { deg, hour, normalizeAngle, toDeg } from '../../../../src/math/units/angle'
import { TestBus } from '../../../util/bus'

const connected = () => true

test('a rotation splits into steps without changing its arrival', () => {
	expect(advanceRotation(350, 20, 5)).toEqual([355, 15])
	expect(advanceRotation(355, 15, 100)).toEqual([10, 0])
	expect(advanceRotation(10, -30, 30)).toEqual([340, 0])
})

describe('cover', () => {
	test('closes exactly after its move time', () => {
		const bus = new TestBus(1000)
		const cap = new CoverCap(bus, DEFAULT_COVER_SIMULATOR_CONFIG, connected)

		cap.park()
		expect(cap.isMoving).toBeTrue()
		cap.tick(1499)
		expect(cap.isParked).toBeFalse()
		cap.tick(1500)
		expect(cap.isParked).toBeTrue()
		expect(cap.isMoving).toBeFalse()
	})

	test('ignores a command while moving or already there, and aborts with Alert', () => {
		const bus = new TestBus()
		const cap = new CoverCap(bus, DEFAULT_COVER_SIMULATOR_CONFIG, connected)

		cap.unpark()
		expect(cap.isMoving).toBeFalse()
		cap.park()
		cap.unpark()
		bus.take()
		cap.abort()
		expect(bus.take()).toEqual(['CAP_PARK', 'CAP_ABORT'])
		expect(cap.properties[0].state).toBe('Alert')
		expect(cap.isParked).toBeFalse()
	})

	test('powers up closed when configured so', () => {
		expect(new CoverCap(new TestBus(), { ...DEFAULT_COVER_SIMULATOR_CONFIG, parked: true }, connected).isParked).toBeTrue()
	})
})

describe('flat panel', () => {
	test('keeps the brightness within its range and forgets the lamp across sessions', () => {
		const light = new FlatPanelLight(new TestBus(), { ...DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG, maxIntensity: 100 })

		light.handleNumber({ device: '', name: 'FLAT_LIGHT_INTENSITY', elements: { FLAT_LIGHT_INTENSITY_VALUE: 500 } })
		light.handleSwitch({ device: '', name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_ON: true } })
		expect(light.intensity).toBe(100)
		expect(light.isOn).toBeTrue()
		expect(light.transient.map((e) => e.name)).toEqual(['FLAT_LIGHT_CONTROL'])

		light.reset()
		expect(light.isOn).toBeFalse()
		expect(light.intensity).toBe(100)
	})
})

describe('filter wheel', () => {
	test('turns the short way round the carousel', () => {
		const bus = new TestBus()
		const carousel = new WheelCarousel(bus, DEFAULT_WHEEL_SIMULATOR_CONFIG, connected)

		expect(carousel.distance(8, 1)).toBe(1)
		expect(carousel.distance(1, 5)).toBe(4)
		expect(carousel.distance(2, 7)).toBe(3)

		carousel.handleNumber({ device: '', name: 'FILTER_SLOT', elements: { FILTER_SLOT_VALUE: 8 } })
		bus.time += 249
		carousel.tick(bus.time)
		expect(carousel.slot).toBe(1)
		bus.time += 1
		carousel.tick(bus.time)
		expect(carousel.slot).toBe(8)
	})

	test('replaces a running move and stops when sent to its own slot', () => {
		const bus = new TestBus()
		const carousel = new WheelCarousel(bus, DEFAULT_WHEEL_SIMULATOR_CONFIG, connected)

		carousel.moveTo(4)
		carousel.moveTo(2)
		carousel.tick(150)
		expect(carousel.slot).toBe(1)
		carousel.tick(250)
		expect(carousel.slot).toBe(2)

		carousel.moveTo(5)
		carousel.moveTo(2)
		expect(carousel.isMoving).toBeFalse()
	})

	test('has a name per configured slot', () => {
		const names = new WheelNames(new TestBus(), { ...DEFAULT_WHEEL_SIMULATOR_CONFIG, slots: ['L', 'Ha'] })
		names.handleText({ device: '', name: 'FILTER_NAME', elements: { FILTER_SLOT_NAME_2: 'OIII' } })
		expect(names.names).toEqual(['L', 'OIII'])
	})
})

describe('rotator', () => {
	test('turns the short way through zero at its rate', () => {
		const bus = new TestBus()
		const drive = new RotatorDrive(bus, { ...DEFAULT_ROTATOR_SIMULATOR_CONFIG, angle: 350 }, connected)

		drive.moveTo(20)
		drive.tick(100)
		expect(drive.angle).toBeCloseTo(359, 9)
		drive.tick(400)
		expect(drive.angle).toBe(20)
		expect(drive.isMoving).toBeFalse()
	})

	test('syncs without moving, homes and aborts with Alert', () => {
		const bus = new TestBus()
		const drive = new RotatorDrive(bus, { ...DEFAULT_ROTATOR_SIMULATOR_CONFIG, homeAngle: 90 }, connected)

		drive.syncTo(45)
		expect(drive.angle).toBe(45)
		drive.home()
		expect(drive.properties[2].state).toBe('Busy')
		drive.tick(1000)
		expect(drive.angle).toBe(90)
		expect(drive.properties[2].state).toBe('Idle')

		drive.moveTo(180)
		drive.abort()
		expect(drive.properties[0].state).toBe('Alert')
	})
})

// Focuser circuits wired as on the device, from `override`.
function makeFocuser(override: FocuserSimulatorConfigOverride = {}) {
	const bus = new TestBus()
	const config = focuserSimulatorConfig(override)
	const gear = new FocuserGear(bus, config.gear, config.drive)
	const drive = new FocuserDrive(bus, config.drive, gear, connected)
	const thermometer = new FocuserThermometer(bus, config.thermometer)
	const compensation = new FocuserCompensation(bus, config.compensation, thermometer, drive)

	// Runs the motor to the end of its move.
	function settle() {
		for (let i = 0; i < 1000 && drive.isMoving; i++) {
			bus.time += 100
			drive.tick(bus.time)
		}
	}

	return { bus, gear, drive, thermometer, compensation, settle }
}

describe('focuser', () => {
	test('loses the play on every reversal without compensation', () => {
		const { gear, drive, settle } = makeFocuser({ gear: { backlash: 100 } })

		drive.moveTo(51000)
		settle()
		expect(gear.effectivePosition).toBe(51000)
		drive.moveTo(50000)
		settle()
		expect(gear.effectivePosition).toBe(50100)
		drive.moveTo(51000)
		settle()
		expect(gear.effectivePosition).toBe(51000)
	})

	test('lands the optics on the position when the compensation equals the play', () => {
		const { gear, drive, settle } = makeFocuser({ gear: { backlash: 100, compensation: true, compensationSteps: 100 } })

		for (const target of [51000, 50000, 50500, 49000, 52000]) {
			drive.moveTo(target)
			settle()
			expect(drive.position).toBe(target)
			expect(gear.effectivePosition).toBe(target)
		}
	})

	test('compensates only reversals, without counting the extra steps', () => {
		const { gear } = makeFocuser({ gear: { backlash: 0, compensation: true, compensationSteps: 40 } })

		expect(gear.compensationFor(1)).toBe(0)
		gear.drive(10)
		expect(gear.compensationFor(1)).toBe(0)
		expect(gear.compensationFor(-1)).toBe(40)
		gear.handleSwitch({ device: '', name: 'FOCUS_BACKLASH_TOGGLE', elements: { INDI_DISABLED: true } })
		expect(gear.compensationFor(-1)).toBe(0)
	})

	test('swings the temperature sinusoidally about the ambient', () => {
		const { thermometer } = makeFocuser()
		const { ambient, amplitude, period } = DEFAULT_FOCUSER_SIMULATOR_CONFIG.thermometer

		thermometer.tick(0)
		thermometer.tick((period / 4) * 1000)
		expect(thermometer.temperature).toBeCloseTo(ambient + amplitude, 9)
	})

	test('compensates the drift past the hysteresis while still', () => {
		const { bus, drive, thermometer, compensation, settle } = makeFocuser({ thermometer: { amplitude: 1, period: 40 }, compensation: { stepsPerDegree: -100, hysteresis: 0.5 } })

		compensation.handleSwitch({ device: '', name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_ENABLED: true } })
		thermometer.tick(0)
		thermometer.tick(10000)
		compensation.tick(bus.time)
		expect(drive.isMoving).toBeTrue()
		settle()
		expect(drive.position).toBe(DEFAULT_FOCUSER_SIMULATOR_CONFIG.drive.position - 100)
	})
})

// Dome circuits wired as on the device, with `geometry` measurements and slaving to `mount`.
function makeDome(geometry: Partial<DomeGeometryConfig> = {}, mount?: Mount) {
	const bus = new TestBus()
	const moves: string[] = []
	const config = DEFAULT_DOME_SIMULATOR_CONFIG
	const drive = new DomeDrive(bus, config.drive, {
		connected,
		started: (kind: DomeMove) => parking.started(kind),
		arrived: (kind: DomeMove) => {
			moves.push(kind)
			parking.arrived(kind)
		},
		stopped: (kind: DomeMove, alert: boolean) => parking.stopped(kind, alert),
		abort: () => drive.stop(true),
	})
	const parking = new DomeParking(bus, config.parking, drive, connected)
	const shutter = new DomeShutter(bus, config.shutter, connected)
	const domeGeometry = new DomeGeometry(bus, { ...config.geometry, ...geometry })
	const slaving = new DomeSlaving(bus, () => mount, domeGeometry, parking, drive)

	// Turns the dome to the end of its move.
	function settle() {
		for (let i = 0; i < 1000 && drive.move !== undefined; i++) {
			bus.time += 100
			drive.tick(bus.time)
		}
	}

	return { bus, moves, drive, parking, shutter, geometry: domeGeometry, slaving, settle }
}

// A mount at latitude 30° pointing at `hourAngle` and `declination` with its tube on `pierSide`.
function makeMount(hourAngle: number, declination: number, pierSide: PierSide = 'WEST'): Mount {
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.connected = true
	mount.geographicCoordinate.latitude = deg(30)
	mount.time.utc = Date.UTC(2026, 0, 1)
	const lst = localSiderealTime(timeUnix(mount.time.utc / 1000), mount.geographicCoordinate)
	mount.equatorialCoordinate.rightAscension = normalizeAngle(lst - hourAngle)
	mount.equatorialCoordinate.declination = declination
	mount.pierSide = pierSide
	return mount
}

describe('dome', () => {
	test('keeps the direction of a relative move across north', () => {
		const { drive, settle } = makeDome()

		drive.turnBy(-30)
		settle()
		expect(drive.azimuth).toBe(330)
		drive.turnBy(400 - 360)
		settle()
		expect(drive.azimuth).toBe(10)
	})

	test('parks, unparks and mirrors the park azimuth', () => {
		const { drive, parking, settle } = makeDome()

		parking.park()
		settle()
		expect(drive.azimuth).toBe(180)
		expect(parking.isParked).toBeTrue()
		parking.unpark()
		expect(parking.isParked).toBeFalse()

		drive.turnTo(90)
		settle()
		parking.setPark()
		expect(parking.parkAzimuth).toBe(90)
		expect(parking.properties.find((e) => e.name === 'DOME_PARAMS')?.elements.PARK_POSITION?.value).toBe(90)
	})

	test('opens the shutter over its move time', () => {
		const { bus, shutter } = makeDome()

		shutter.open()
		expect(shutter.target).toBe('OPEN')
		shutter.tick(bus.time + 1499)
		expect(shutter.isOpen).toBeFalse()
		shutter.tick(bus.time + 1500)
		expect(shutter.isOpen).toBeTrue()
	})

	test('points the slit at the target itself when the mount stands at the centre', () => {
		const mount = makeMount(hour(-2), deg(10))
		const { geometry } = makeDome({}, mount)
		const lst = localSiderealTime(timeUnix(mount.time.utc / 1000), mount.geographicCoordinate)
		const [azimuth] = equatorialToHorizontal(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination, mount.geographicCoordinate.latitude, lst)
		expect(geometry.slitAzimuth(mount)).toBeCloseTo(toDeg(azimuth), 9)
	})

	test('offsets the slit by the side of the pier and the displacement of the mount', () => {
		// At the zenith the optical ray goes straight up from wherever the optics are.
		const zenith = deg(30)
		expect(makeDome({ otaOffset: 0.5 }).geometry.slitAzimuth(makeMount(0, zenith, 'WEST'))).toBeCloseTo(270, 6)
		expect(makeDome({ otaOffset: 0.5 }).geometry.slitAzimuth(makeMount(0, zenith, 'EAST'))).toBeCloseTo(90, 6)
		expect(makeDome({ eastDisplacement: 1 }).geometry.slitAzimuth(makeMount(0, zenith))).toBeCloseTo(90, 6)
		expect(makeDome({ northDisplacement: 1 }).geometry.slitAzimuth(makeMount(0, zenith))).toBeCloseTo(0, 6)
	})

	test('follows the mount past the threshold and stops following when disabled', () => {
		const mount = makeMount(hour(-2), deg(10))
		const { bus, drive, slaving, settle } = makeDome({}, mount)

		slaving.handleSwitch({ device: '', name: 'DOME_AUTOSYNC', elements: { INDI_ENABLED: true } })
		expect(drive.move).toBe('slew')
		settle()
		const target = drive.azimuth

		// Within the threshold the slit stays where it is.
		mount.equatorialCoordinate.rightAscension -= deg(0.1)
		slaving.tick(bus.time)
		expect(drive.move).toBeUndefined()
		expect(drive.azimuth).toBe(target)

		mount.equatorialCoordinate.rightAscension -= deg(20)
		slaving.tick(bus.time)
		expect(drive.move).toBe('slew')
		slaving.handleSwitch({ device: '', name: 'DOME_AUTOSYNC', elements: { INDI_DISABLED: true } })
		expect(drive.move).toBeUndefined()
	})
})
