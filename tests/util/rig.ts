import * as fsp from 'node:fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { CameraCommander } from '../../src/devices/commanders/camera'
import { CoverCommander } from '../../src/devices/commanders/cover'
import { DomeCommander } from '../../src/devices/commanders/dome'
import { FlatPanelCommander } from '../../src/devices/commanders/flatpanel'
import { FocuserCommander } from '../../src/devices/commanders/focuser'
import { GuideOutputCommander } from '../../src/devices/commanders/guideoutput'
import { MountCommander } from '../../src/devices/commanders/mount'
import { RotatorCommander } from '../../src/devices/commanders/rotator'
import { WheelCommander } from '../../src/devices/commanders/wheel'
import { IndiClientHandlerSet } from '../../src/devices/indi/client'
import type { Camera, Cover, Device, Dome, FlatPanel, Focuser, GuideOutput, Mount, Rotator, SafetyMonitor, Wheel } from '../../src/devices/indi/device'
import { CameraManager } from '../../src/devices/indi/manager/camera'
import { CoverManager } from '../../src/devices/indi/manager/cover'
import type { DeviceManager } from '../../src/devices/indi/manager/device'
import { DomeManager } from '../../src/devices/indi/manager/dome'
import { FlatPanelManager } from '../../src/devices/indi/manager/flatpanel'
import { FocuserManager } from '../../src/devices/indi/manager/focuser'
import { GuideOutputManager } from '../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../src/devices/indi/manager/mount'
import { RotatorManager } from '../../src/devices/indi/manager/rotator'
import { SafetyMonitorManager } from '../../src/devices/indi/manager/safetymonitor'
import { ThermometerManager } from '../../src/devices/indi/manager/thermometer'
import { WheelManager } from '../../src/devices/indi/manager/wheel'
import { CameraSimulator } from '../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../src/devices/indi/simulator/client'
import { CoverSimulator } from '../../src/devices/indi/simulator/cover'
import { DomeSimulator } from '../../src/devices/indi/simulator/dome'
import { FlatPanelSimulator } from '../../src/devices/indi/simulator/flatpanel'
import { FocuserSimulator } from '../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../src/devices/indi/simulator/rotator'
import { SafetyMonitorSimulator } from '../../src/devices/indi/simulator/safetymonitor'
import { WheelSimulator } from '../../src/devices/indi/simulator/wheel'
import type { PropertyState } from '../../src/devices/indi/types'
import { DeviceLifecycle } from '../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, OperationCoordinator, type OperationResult, successfulOperationResult } from '../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../src/devices/orchestration/resource'
import { deg, hour } from '../../src/math/units/angle'
import { CameraCapturer } from '../../src/observation/capture/capture'
import { waitUntil } from '../util'

// Shared infrastructure of the observation tests that drive real commanders: a manual clock over the wall and
// monotonic domains, the INDI simulator rig with its commanders, arbiter and capturer, and a recorder of device
// commands and observed transitions.

// One pending manual delay.
interface ManualDelay {
	readonly deadline: number
	readonly order: number
	readonly resolve: (result: OperationResult<void>) => void
	readonly signal: AbortSignal
	readonly abort: () => void
}

// Clock of the unit tests, with the shape of the observation clocks (wallNow, monotonicNow, delay). Time only moves
// through `advance` and `jumpWall`, both in milliseconds: `advance(ms)` moves both domains together and resolves the
// delays that fall due in deadline order (equal deadlines in registration order), letting each continuation run
// before the next one; `jumpWall(ms)` moves only the wall, either way, and resolves nothing. The monotonic domain
// never decreases.
export class ManualClock {
	#wall: number
	#monotonic: number
	#order = 0
	readonly #delays: ManualDelay[] = []

	// Starts at the given wall instant (Unix ms) and monotonic origin (ms).
	constructor(wallStart: number = Date.UTC(2026, 0, 1), monotonicStart: number = 0) {
		this.#wall = wallStart
		this.#monotonic = monotonicStart
	}

	readonly wallNow = () => this.#wall

	readonly monotonicNow = () => this.#monotonic

	// Resolves ok once `advance` has moved the monotonic domain by at least `ms`; an aborted signal resolves it as
	// `aborted` at once, without moving time and without leaving the delay pending.
	readonly delay = (ms: number, signal: AbortSignal) => {
		if (signal.aborted) return Promise.resolve<OperationResult<void>>(failedOperationResult('aborted'))
		if (!(ms > 0)) return Promise.resolve<OperationResult<void>>(successfulOperationResult(undefined))

		const { promise, resolve } = Promise.withResolvers<OperationResult<void>>()
		const abort = () => {
			const index = this.#delays.indexOf(delay)
			if (index >= 0) this.#delays.splice(index, 1)
			resolve(failedOperationResult('aborted'))
		}
		const delay: ManualDelay = { deadline: this.#monotonic + ms, order: this.#order++, resolve, signal, abort }

		signal.addEventListener('abort', abort, { once: true })
		this.#delays.push(delay)
		this.#delays.sort((a, b) => a.deadline - b.deadline || a.order - b.order)

		return promise
	}

	// Number of delays still pending.
	get pending() {
		return this.#delays.length
	}

	// Moves both domains by `ms` ≥ 0, resolving every delay that falls due on the way at its own deadline.
	async advance(ms: number) {
		const target = this.#monotonic + Math.max(0, ms)

		while (this.#delays.length > 0 && this.#delays[0].deadline <= target) {
			const delay = this.#delays.shift()!
			this.#moveTo(delay.deadline)
			delay.signal.removeEventListener('abort', delay.abort)
			delay.resolve(successfulOperationResult(undefined))
			// Lets the continuation run, and register its next delay, before the following deadline is reached.
			await new Promise<void>((resolve) => {
				setImmediate(resolve)
			})
		}

		this.#moveTo(target)
	}

	// Moves only the wall domain by `ms` (positive or negative), like an NTP step or a manual clock change.
	jumpWall(ms: number) {
		this.#wall += ms
	}

	#moveTo(monotonic: number) {
		if (!(monotonic > this.#monotonic)) return
		this.#wall += monotonic - this.#monotonic
		this.#monotonic = monotonic
	}
}

// Shared order of everything the recorders of one test log, so device commands and transitions
// can be compared with each other.
export interface TestSequence {
	readonly next: () => number
}

// Creates a sequence starting at 1.
export function createTestSequence(): TestSequence {
	let value = 0
	return { next: () => ++value }
}

// Simulator names of the rig.
export const RIG_DEVICE_NAMES = {
	camera: 'Camera Simulator',
	mount: 'Mount Simulator',
	wheel: 'Wheel Simulator',
	focuser: 'Focuser Simulator',
	rotator: 'Rotator Simulator',
	cover: 'Cover Simulator',
	dome: 'Dome Simulator',
	flatPanel: 'Flat Panel Simulator',
	safetyMonitor: 'Safety Monitor Simulator',
} as const

// Pointing the rig syncs the mount to before each test: RA 5h, Dec -30°, in radians.
export const RIG_INITIAL_POINTING = { rightAscension: hour(5), declination: deg(-30) } as const

// Managers of the rig.
export interface SimulatorRigManagers {
	readonly camera: CameraManager
	readonly mount: MountManager
	readonly wheel: WheelManager
	readonly focuser: FocuserManager
	readonly rotator: RotatorManager
	readonly cover: CoverManager
	readonly dome: DomeManager
	readonly flatPanel: FlatPanelManager
	readonly safetyMonitor: SafetyMonitorManager
	readonly guideOutput: GuideOutputManager
	readonly thermometer: ThermometerManager
}

// Simulators of the rig.
export interface SimulatorRigSimulators {
	readonly camera: CameraSimulator
	readonly mount: MountSimulator
	readonly wheel: WheelSimulator
	readonly focuser: FocuserSimulator
	readonly rotator: RotatorSimulator
	readonly cover: CoverSimulator
	readonly dome: DomeSimulator
	readonly flatPanel: FlatPanelSimulator
	readonly safetyMonitor: SafetyMonitorSimulator
}

// Commanders of the rig.
export interface SimulatorRigCommanders {
	readonly camera: CameraCommander
	readonly mount: MountCommander
	readonly wheel: WheelCommander
	readonly focuser: FocuserCommander
	readonly rotator: RotatorCommander
	readonly cover: CoverCommander
	readonly dome: DomeCommander
	readonly flatPanel: FlatPanelCommander
	readonly guideOutput: GuideOutputCommander
}

// Connected devices of the rig, resolved from the managers.
export interface SimulatorRigDevices {
	readonly camera: Camera
	readonly mount: Mount
	readonly wheel: Wheel
	readonly focuser: Focuser
	readonly rotator: Rotator
	readonly cover: Cover
	readonly dome: Dome
	readonly flatPanel: FlatPanel
	readonly safetyMonitor: SafetyMonitor
	readonly guideOutput: GuideOutput
}

// The INDI simulator rig of the observation tests, the assembly of the camera capture tests extended with the cover,
// the dome, the thermometer views, the flat panel, the safety monitor and the mount guide output. Created once per
// file and disposed after it.
export interface SimulatorRig extends AsyncDisposable {
	readonly client: ClientSimulator
	readonly managers: SimulatorRigManagers
	readonly simulators: SimulatorRigSimulators
	readonly arbiter: ResourceArbiter
	readonly coordinator: OperationCoordinator
	readonly lifecycle: DeviceLifecycle
	readonly commanders: SimulatorRigCommanders
	readonly capturer: CameraCapturer
	// Temporary directory of the captures, removed on disposal.
	readonly capturesDir: string
	// Resolves the devices; throws while one has not been created by its manager yet.
	readonly devices: () => SimulatorRigDevices
}

// Creates the rig with every device disconnected; `connectSimulatorRig` connects and verifies them.
export async function createSimulatorRig(): Promise<SimulatorRig> {
	const camera = new CameraManager()
	const mount = new MountManager()
	const wheel = new WheelManager()
	const focuser = new FocuserManager()
	const rotator = new RotatorManager()
	const cover = new CoverManager()
	const dome = new DomeManager()
	const flatPanel = new FlatPanelManager()
	const primary: readonly DeviceManager<Device>[] = [camera, mount, wheel, focuser, rotator, cover, dome, flatPanel] as never
	const safetyMonitor = new SafetyMonitorManager({ get: (client, name) => primary.map((manager) => manager.get(client, name)).find((device) => device !== undefined) })
	const guideOutput = new GuideOutputManager({ get: (client, name) => mount.get(client, name) ?? camera.get(client, name) })
	const thermometer = new ThermometerManager({ get: (client, name) => camera.get(client, name) ?? focuser.get(client, name) })
	const managers: SimulatorRigManagers = { camera, mount, wheel, focuser, rotator, cover, dome, flatPanel, safetyMonitor, guideOutput, thermometer }

	const arbiter = new ResourceArbiter()
	const coordinator = new OperationCoordinator(arbiter)
	const lifecycle = new DeviceLifecycle(arbiter, coordinator)
	for (const manager of Object.values(managers)) lifecycle.observe(manager as never)

	const client = new ClientSimulator('Simulator Rig', new IndiClientHandlerSet(Object.values(managers)))
	const simulators: SimulatorRigSimulators = {
		mount: new MountSimulator(RIG_DEVICE_NAMES.mount, client),
		wheel: new WheelSimulator(RIG_DEVICE_NAMES.wheel, client),
		focuser: new FocuserSimulator(RIG_DEVICE_NAMES.focuser, client),
		rotator: new RotatorSimulator(RIG_DEVICE_NAMES.rotator, client),
		cover: new CoverSimulator(RIG_DEVICE_NAMES.cover, client),
		dome: new DomeSimulator(RIG_DEVICE_NAMES.dome, client),
		flatPanel: new FlatPanelSimulator(RIG_DEVICE_NAMES.flatPanel, client),
		safetyMonitor: new SafetyMonitorSimulator(RIG_DEVICE_NAMES.safetyMonitor, client),
		camera: new CameraSimulator(RIG_DEVICE_NAMES.camera, client, { mountManager: mount, focuserManager: focuser, rotatorManager: rotator, wheelManager: wheel, guideOutputManager: guideOutput }),
	}

	const commanders: SimulatorRigCommanders = {
		camera: new CameraCommander(camera),
		mount: new MountCommander(mount),
		wheel: new WheelCommander(wheel),
		focuser: new FocuserCommander(focuser),
		rotator: new RotatorCommander(rotator),
		cover: new CoverCommander(cover),
		dome: new DomeCommander(dome),
		flatPanel: new FlatPanelCommander(flatPanel),
		guideOutput: new GuideOutputCommander(guideOutput, arbiter),
	}

	const capturesDir = await fsp.mkdtemp(join(tmpdir(), 'nebulosa-rig-'))
	const capturer = new CameraCapturer(camera, arbiter, { capturesDir, devices: { mount, focuser, wheel, rotator }, frameGraceTime: 5000, quiesceTimeout: 2000, lateBlobDrainTime: 0 })

	const require = <D>(manager: DeviceManager<D & Device>, name: string) => {
		const device = manager.get(client, name)
		if (device === undefined) throw new Error(`rig device ${name} is not available`)
		return device
	}

	const devices = (): SimulatorRigDevices => ({
		camera: require(camera, RIG_DEVICE_NAMES.camera),
		mount: require(mount, RIG_DEVICE_NAMES.mount),
		wheel: require(wheel, RIG_DEVICE_NAMES.wheel),
		focuser: require(focuser, RIG_DEVICE_NAMES.focuser),
		rotator: require(rotator, RIG_DEVICE_NAMES.rotator),
		cover: require(cover, RIG_DEVICE_NAMES.cover),
		dome: require(dome, RIG_DEVICE_NAMES.dome),
		flatPanel: require(flatPanel, RIG_DEVICE_NAMES.flatPanel),
		safetyMonitor: require(safetyMonitor, RIG_DEVICE_NAMES.safetyMonitor),
		guideOutput: require(guideOutput, RIG_DEVICE_NAMES.mount),
	})

	return {
		client,
		managers,
		simulators,
		arbiter,
		coordinator,
		lifecycle,
		commanders,
		capturer,
		capturesDir,
		devices,
		[Symbol.asyncDispose]: async () => {
			await coordinator.cancelAll()
			capturer.dispose()
			// The flat panel commander observes nothing and has nothing to dispose.
			for (const commander of Object.values(commanders) as Partial<Disposable>[]) commander[Symbol.dispose]?.()
			lifecycle.dispose()
			for (const simulator of Object.values(simulators) as Disposable[]) simulator[Symbol.dispose]()
			await fsp.rm(capturesDir, { recursive: true, force: true })
		},
	}
}

// Connects every rig device and waits until each is connected and acquirable, the camera with its frame limits
// and the mount with its guide output and published position.
export async function connectSimulatorRig(rig: SimulatorRig) {
	const { managers, client, arbiter } = rig
	const connections: readonly [DeviceManager<Device>, string][] = [
		[managers.mount, RIG_DEVICE_NAMES.mount],
		[managers.wheel, RIG_DEVICE_NAMES.wheel],
		[managers.focuser, RIG_DEVICE_NAMES.focuser],
		[managers.rotator, RIG_DEVICE_NAMES.rotator],
		[managers.cover, RIG_DEVICE_NAMES.cover],
		[managers.dome, RIG_DEVICE_NAMES.dome],
		[managers.flatPanel, RIG_DEVICE_NAMES.flatPanel],
		[managers.safetyMonitor, RIG_DEVICE_NAMES.safetyMonitor],
		[managers.camera, RIG_DEVICE_NAMES.camera],
	] as never

	for (const [manager, name] of connections) {
		await waitUntil(() => manager.get(client, name) !== undefined, 5000, 10)
		const device = manager.get(client, name)!
		if (!device.connected) manager.connect(device)
		await waitUntil(() => device.connected && arbiter.availability(resourceKey(device)) === 'available', 5000, 10)
	}

	const { camera, mount } = rig.devices()
	await waitUntil(() => camera.frame.width.max > 0 && mount.hasEquatorialCoordinate && mount.canPulseGuide, 5000, 10)
}

// Brings the connected rig to the state every test starts from, through the commanders: mount unparked, tracking off
// and synced to RIG_INITIAL_POINTING, wheel on slot 0, focuser at `focuserPosition`, cover open, flat panel off,
// cooler off, safety monitor safe. Throws with the failing step.
export async function resetSimulatorRig(rig: SimulatorRig, focuserPosition: number) {
	const { commanders, coordinator, managers, simulators } = rig
	const { mount, wheel, focuser, cover, flatPanel, camera, safetyMonitor } = rig.devices()
	const step = (name: string, result: OperationResult<unknown>) => {
		if (!result.ok) throw new Error(`rig reset failed at ${name}: ${result.reason} ${result.error ?? ''}`)
	}

	simulators.safetyMonitor.setSafe(true)
	managers.camera.cooler(camera, false)
	step('unpark', await commanders.mount.unpark(coordinator, mount))
	step('tracking', await commanders.mount.setTracking(coordinator, mount, false))
	step('sync', await commanders.mount.sync(coordinator, mount, { type: 'JNOW', JNOW: { x: RIG_INITIAL_POINTING.rightAscension, y: RIG_INITIAL_POINTING.declination } }))
	step('wheel', await commanders.wheel.moveTo(coordinator, wheel, 0))
	step('focuser', await commanders.focuser.moveTo(coordinator, focuser, focuserPosition))
	step('cover', await commanders.cover.unpark(coordinator, cover))
	if (flatPanel.enabled) step('flat panel', await commanders.flatPanel.disable(coordinator, flatPanel))

	await waitUntil(() => safetyMonitor.safe && !camera.cooler && Math.abs(mount.equatorialCoordinate.declination - RIG_INITIAL_POINTING.declination) < deg(0.01), 5000, 10)
}

// Relative path of a capture moved aside as incomplete, where a partial file is expected.
const INCOMPLETE_PATH_PATTERN = /(?:^|\/)rejected\/incomplete\//

// Throws when anything outlived a test: a resource still owned or reserved, a partial capture outside
// `rejected/incomplete/`, or a pending manual delay.
export async function expectNoRigLeaks(rig: SimulatorRig, clock?: ManualClock) {
	const devices = rig.devices()

	for (const device of Object.values(devices)) {
		const key = resourceKey(device)
		if (rig.arbiter.ownersOf(key).length > 0) throw new Error(`leak: ${device.name} is still owned`)
		if (rig.arbiter.reservationOwnerOf(key) !== undefined) throw new Error(`leak: ${device.name} is still reserved`)
	}

	for (const path of await fsp.readdir(rig.capturesDir, { recursive: true })) {
		const normalized = path.replaceAll(sep, '/')
		if (normalized.endsWith('.partial.fit') && !INCOMPLETE_PATH_PATTERN.test(normalized)) throw new Error(`leak: partial capture ${path}`)
	}

	if (clock !== undefined && clock.pending > 0) throw new Error(`leak: ${clock.pending} manual delays pending`)
}

// Source of the instants a recorder stamps its entries with.
export interface RecorderClock {
	readonly wallNow: () => number
	readonly monotonicNow: () => number
}

// System instants: Date.now and performance.now.
const SYSTEM_RECORDER_CLOCK: RecorderClock = { wallNow: () => Date.now(), monotonicNow: () => performance.now() }

// Manager command recorded before it runs.
export interface DeviceCommandEntry {
	readonly kind: 'command'
	readonly sequence: number
	readonly wallNow: number
	readonly monotonicNow: number
	// Name of the commanded device.
	readonly device: string
	readonly manager: keyof SimulatorRigManagers
	readonly command: string
	// Arguments after the device, excluding the client.
	readonly args: readonly unknown[]
}

// Device field observed to change, as the manager notified it.
export interface DeviceTransitionEntry {
	readonly kind: 'transition'
	readonly sequence: number
	readonly wallNow: number
	readonly monotonicNow: number
	readonly device: string
	readonly manager: keyof SimulatorRigManagers
	readonly property: string
	readonly value: unknown
	readonly state?: PropertyState
}

// Device added to or removed from its manager.
export interface DeviceMembershipEntry {
	readonly kind: 'added' | 'removed'
	readonly sequence: number
	readonly wallNow: number
	readonly monotonicNow: number
	readonly device: string
	readonly manager: keyof SimulatorRigManagers
}

// Entry of the device log.
export type DeviceLogEntry = DeviceCommandEntry | DeviceTransitionEntry | DeviceMembershipEntry

// Commands recorded per manager.
const RECORDED_COMMANDS: { readonly [K in keyof SimulatorRigManagers]: readonly string[] } = {
	camera: ['startExposure', 'stopExposure', 'cooler', 'temperature', 'frameType'],
	mount: ['goTo', 'flipTo', 'syncTo', 'park', 'unpark', 'tracking', 'trackMode', 'stop', 'moveNorth', 'moveSouth', 'moveWest', 'moveEast', 'home', 'findHome'],
	wheel: ['moveTo'],
	focuser: ['moveTo', 'moveIn', 'moveOut', 'stop'],
	rotator: ['moveTo', 'stop'],
	cover: ['park', 'unpark', 'stop'],
	dome: ['openShutter', 'closeShutter', 'park', 'unpark', 'slave', 'stop'],
	flatPanel: ['enable', 'disable', 'toggle', 'intensity'],
	safetyMonitor: [],
	guideOutput: ['pulse', 'pulseNorth', 'pulseSouth', 'pulseWest', 'pulseEast'],
	thermometer: [],
}

// Device fields whose observed transitions are recorded, with their value at that moment.
const RECORDED_TRANSITIONS = new Set([
	'pulsing',
	'pulsingNS',
	'pulsingWE',
	'parked',
	'parking',
	'enabled',
	'position',
	'moving',
	'pierSide',
	'tracking',
	'trackMode',
	'slewing',
	'equatorialCoordinate',
	'geographicCoordinate',
	'hasEquatorialCoordinate',
	'hasGeographicCoordinate',
	'safe',
	'exposuring',
	'connected',
	'shutterState',
	'cooler',
])

// Recorder of one rig: the entries in order and the call that stops recording.
export interface DeviceRecorder extends Disposable {
	readonly entries: DeviceLogEntry[]
}

// Records, in one sequence, every manager command of RECORDED_COMMANDS before it runs and every observed transition
// of RECORDED_TRANSITIONS (guide pulses per axis with their state, cover, dome shutter, cooler, flat panel, wheel, focuser, pier side,
// tracking, track mode, slewing, published coordinates and their flags, safety, exposure, connection), plus device
// additions and removals. Commands still reach the managers.
export function recordDevices(rig: SimulatorRig, clock: RecorderClock = SYSTEM_RECORDER_CLOCK, sequence: TestSequence = createTestSequence()): DeviceRecorder {
	return recordManagers(rig.managers, clock, sequence)
}

// Records like `recordDevices` over the given managers only, such as the camera and guide output managers of a test
// without the rig.
export function recordManagers(managers: Partial<SimulatorRigManagers>, clock: RecorderClock = SYSTEM_RECORDER_CLOCK, sequence: TestSequence = createTestSequence()): DeviceRecorder {
	const entries: DeviceLogEntry[] = []
	const restores: VoidFunction[] = []
	const stamp = () => ({ sequence: sequence.next(), wallNow: clock.wallNow(), monotonicNow: clock.monotonicNow() })

	for (const key of Object.keys(RECORDED_COMMANDS) as (keyof SimulatorRigManagers)[]) {
		if (managers[key] === undefined) continue
		const manager = managers[key] as unknown as Record<string, (...args: never[]) => unknown>

		for (const command of RECORDED_COMMANDS[key]) {
			// A plain wrapper, not a spy: it layers over a fault-injecting spy of the test, and a later spy layers over it.
			const own = Object.hasOwn(manager, command)
			const original = manager[command]
			manager[command] = (...args: never[]) => {
				const [device, ...rest] = args as unknown as [Device, ...unknown[]]
				entries.push({ kind: 'command', ...stamp(), device: device.name, manager: key, command, args: rest.filter((arg) => !isClient(arg)) })
				return original.apply(manager, args)
			}
			restores.push(() => {
				if (own) manager[command] = original
				else delete manager[command]
			})
		}

		const handler = {
			added: (device: Device) => entries.push({ kind: 'added', ...stamp(), device: device.name, manager: key }),
			removed: (device: Device) => entries.push({ kind: 'removed', ...stamp(), device: device.name, manager: key }),
			updated: (device: Device, property: string, state?: PropertyState) => {
				if (RECORDED_TRANSITIONS.has(property)) entries.push({ kind: 'transition', ...stamp(), device: device.name, manager: key, property, value: structuredClone((device as unknown as Record<string, unknown>)[property]), state })
			},
		}

		const observed = managers[key] as unknown as DeviceManager<Device>
		observed.addHandler(handler)
		restores.push(() => observed.removeHandler(handler))
	}

	return {
		entries,
		[Symbol.dispose]: () => {
			for (const restore of restores.toReversed()) restore()
		},
	}
}

// Whether an argument is the INDI client a manager command takes last, which is never part of the record.
function isClient(value: unknown) {
	return typeof value === 'object' && value !== null && 'sendSwitch' in value && 'sendNumber' in value
}
