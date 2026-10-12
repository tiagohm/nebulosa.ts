import { spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { CameraCommander } from '../../../src/devices/commanders/camera'
import { CoverCommander } from '../../../src/devices/commanders/cover'
import { DomeCommander } from '../../../src/devices/commanders/dome'
import { FlatPanelCommander } from '../../../src/devices/commanders/flatpanel'
import { FocuserCommander } from '../../../src/devices/commanders/focuser'
import { GuideOutputCommander } from '../../../src/devices/commanders/guideoutput'
import { MountCommander } from '../../../src/devices/commanders/mount'
import { RotatorCommander } from '../../../src/devices/commanders/rotator'
import { WheelCommander } from '../../../src/devices/commanders/wheel'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera, Cover, Device, Dome, FlatPanel, Focuser, GuideOutput, Mount, Rotator, SafetyMonitor, Wheel } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { CoverManager } from '../../../src/devices/indi/manager/cover'
import type { DeviceManager } from '../../../src/devices/indi/manager/device'
import { DomeManager } from '../../../src/devices/indi/manager/dome'
import { FlatPanelManager } from '../../../src/devices/indi/manager/flatpanel'
import { FocuserManager } from '../../../src/devices/indi/manager/focuser'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../../src/devices/indi/manager/mount'
import { RotatorManager } from '../../../src/devices/indi/manager/rotator'
import { SafetyMonitorManager } from '../../../src/devices/indi/manager/safetymonitor'
import { ThermometerManager } from '../../../src/devices/indi/manager/thermometer'
import { WheelManager } from '../../../src/devices/indi/manager/wheel'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { CoverSimulator } from '../../../src/devices/indi/simulator/cover'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import { FlatPanelSimulator } from '../../../src/devices/indi/simulator/flatpanel'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../../src/devices/indi/simulator/rotator'
import { SafetyMonitorSimulator } from '../../../src/devices/indi/simulator/safetymonitor'
import { WheelSimulator } from '../../../src/devices/indi/simulator/wheel'
import type { PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, OperationCoordinator, type OperationFailureReason, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, type ResourceReservation, type ResourceReservationOwner, resourceKey } from '../../../src/devices/orchestration/resource'
import { CameraCapturer } from '../../../src/devices/runners/camera.capture'
import { deg, hour } from '../../../src/math/units/angle'
import type { SequencerEvent, SequencerListener, SequencerTaskId } from '../../../src/observation/sequencer/sequencer'
import type { SequencerJournalEntry } from '../../../src/observation/sequencer/storage'
import { waitUntil } from '../../util'

// Shared infrastructure of the Sequencer tests: a manual clock over the wall and monotonic domains, the INDI
// simulator rig, a recorder of device commands and observed transitions, file-system fault injection, and the
// invariant oracle over recorded logs. The oracle checks the invariants a device log can prove; the ones about
// Sequencer events join it with the runner that emits them.

// One pending manual delay.
interface ManualDelay {
	readonly deadline: number
	readonly order: number
	readonly resolve: (result: OperationResult<void>) => void
	readonly signal: AbortSignal
	readonly abort: () => void
}

// Clock of the unit tests, with the shape of the Sequencer clock (wallNow, monotonicNow, delay). Time only moves
// through `advance` and `jumpWall`, both in milliseconds: `advance(ms)` moves both domains together and resolves the
// delays that fall due in deadline order (equal deadlines in registration order), letting each continuation run
// before the next one; `jumpWall(ms)` moves only the wall, either way, and resolves nothing. The monotonic domain
// never decreases.
export class ManualSequencerClock {
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

// Shared order of everything the recorders of one test log, so device commands, transitions and file operations
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
export interface SequencerRigManagers {
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
export interface SequencerRigSimulators {
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
export interface SequencerRigCommanders {
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
export interface SequencerRigDevices {
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

// The INDI simulator rig of the Sequencer tests, the assembly of the camera capture tests extended with the cover,
// the dome, the thermometer views, the flat panel, the safety monitor and the mount guide output. Created once per
// file and disposed after it.
export interface SequencerRig extends AsyncDisposable {
	readonly client: ClientSimulator
	readonly managers: SequencerRigManagers
	readonly simulators: SequencerRigSimulators
	readonly arbiter: ResourceArbiter
	readonly coordinator: OperationCoordinator
	readonly lifecycle: DeviceLifecycle
	readonly commanders: SequencerRigCommanders
	readonly capturer: CameraCapturer
	// Temporary directory of the captures, removed on disposal.
	readonly capturesDir: string
	// Resolves the devices; throws while one has not been created by its manager yet.
	readonly devices: () => SequencerRigDevices
}

// Creates the rig with every device disconnected; `connectSequencerRig` connects and verifies them.
export async function createSequencerRig(): Promise<SequencerRig> {
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
	const managers: SequencerRigManagers = { camera, mount, wheel, focuser, rotator, cover, dome, flatPanel, safetyMonitor, guideOutput, thermometer }

	const arbiter = new ResourceArbiter()
	const coordinator = new OperationCoordinator(arbiter)
	const lifecycle = new DeviceLifecycle(arbiter, coordinator)
	for (const manager of Object.values(managers)) lifecycle.observe(manager as never)

	const client = new ClientSimulator('Sequencer Rig', new IndiClientHandlerSet(Object.values(managers)))
	const simulators: SequencerRigSimulators = {
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

	const commanders: SequencerRigCommanders = {
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

	const capturesDir = await fsp.mkdtemp(join(tmpdir(), 'nebulosa-sequencer-'))
	const capturer = new CameraCapturer(camera, arbiter, { capturesDir, devices: { mount, focuser, wheel, rotator }, frameGraceTime: 5000, quiesceTimeout: 2000, lateBlobDrainTime: 0 })

	const require = <D>(manager: DeviceManager<D & Device>, name: string) => {
		const device = manager.get(client, name)
		if (device === undefined) throw new Error(`rig device ${name} is not available`)
		return device
	}

	const devices = (): SequencerRigDevices => ({
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
export async function connectSequencerRig(rig: SequencerRig) {
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
export async function resetSequencerRig(rig: SequencerRig, focuserPosition: number) {
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
export async function expectNoSequencerLeaks(rig: SequencerRig, clock?: ManualSequencerClock) {
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
	readonly manager: keyof SequencerRigManagers
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
	readonly manager: keyof SequencerRigManagers
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
	readonly manager: keyof SequencerRigManagers
}

// Entry of the device log.
export type DeviceLogEntry = DeviceCommandEntry | DeviceTransitionEntry | DeviceMembershipEntry

// Commands recorded per manager.
const RECORDED_COMMANDS: { readonly [K in keyof SequencerRigManagers]: readonly string[] } = {
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
export function recordDevices(rig: SequencerRig, clock: RecorderClock = SYSTEM_RECORDER_CLOCK, sequence: TestSequence = createTestSequence()): DeviceRecorder {
	const entries: DeviceLogEntry[] = []
	const restores: VoidFunction[] = []
	const stamp = () => ({ sequence: sequence.next(), wallNow: clock.wallNow(), monotonicNow: clock.monotonicNow() })

	for (const key of Object.keys(RECORDED_COMMANDS) as (keyof SequencerRigManagers)[]) {
		const manager = rig.managers[key] as unknown as Record<string, (...args: never[]) => unknown>

		for (const command of RECORDED_COMMANDS[key]) {
			const original = manager[command].bind(manager)
			const spy = spyOn(manager, command).mockImplementation((...args: never[]) => {
				const [device, ...rest] = args as unknown as [Device, ...unknown[]]
				entries.push({ kind: 'command', ...stamp(), device: device.name, manager: key, command, args: rest.filter((arg) => !isClient(arg)) })
				return original(...args)
			})
			restores.push(() => spy.mockRestore())
		}

		const handler = {
			added: (device: Device) => entries.push({ kind: 'added', ...stamp(), device: device.name, manager: key }),
			removed: (device: Device) => entries.push({ kind: 'removed', ...stamp(), device: device.name, manager: key }),
			updated: (device: Device, property: string, state?: PropertyState) => {
				if (RECORDED_TRANSITIONS.has(property)) entries.push({ kind: 'transition', ...stamp(), device: device.name, manager: key, property, value: structuredClone((device as unknown as Record<string, unknown>)[property]), state })
			},
		}

		const observed = rig.managers[key] as unknown as DeviceManager<Device>
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

// File-system operations the fault injector can count and fail. `sync` and `write` are the methods of the handles
// `open` returns.
export type FileSystemOperation = 'open' | 'writeFile' | 'appendFile' | 'rename' | 'link' | 'copyFile' | 'unlink' | 'stat' | 'sync' | 'write'

// Durable steps a storage crash matrix enumerates by default.
export const DURABLE_FILE_SYSTEM_OPERATIONS: readonly FileSystemOperation[] = ['writeFile', 'appendFile', 'rename', 'link', 'copyFile', 'unlink', 'sync', 'write']

// File-system operation as the injector saw it.
export interface FileSystemEntry {
	readonly kind: 'fs'
	readonly sequence: number
	readonly operation: FileSystemOperation
	readonly paths: readonly string[]
	// Ordinal of the operation among the counted ones, 1-based; absent when it is not counted.
	readonly step?: number
	readonly failed: boolean
}

// Fault plan of one injector.
export interface FileSystemFaultOptions {
	// Counted operation that fails, 1-based; undefined only records.
	readonly failAt?: number
	// Operations counted towards `failAt`. Default DURABLE_FILE_SYSTEM_OPERATIONS.
	readonly operations?: readonly FileSystemOperation[]
	// 'crash' fails every counted operation from `failAt` on, as a dead process would; 'once' only that one.
	readonly mode?: 'once' | 'crash'
	// Error code of the injected failure. Default EIO.
	readonly code?: string
	// For a failing copyFile, bytes of the source written to the destination before the failure (a partial copy).
	readonly partialCopyBytes?: number
	// Error code every `link` throws, uncounted, as on a volume without hard links (EPERM).
	readonly linkError?: string
	// Paths whose operations (when every path an operation touches is spared) are neither counted nor failed, such as
	// the session lock a simulated crash must still release so the same process can play the next one.
	readonly spare?: (path: string) => boolean
	readonly sequence?: TestSequence
}

// Injector over node:fs/promises: the operations it saw and the call that removes it.
export interface FileSystemFaults extends Disposable {
	readonly entries: FileSystemEntry[]
	// Counted operations so far.
	readonly steps: () => number
}

// Wraps the functions of node:fs/promises (named imports included) so the counted operations are logged and the
// `failAt`-th one throws an Error carrying `code`; handles from `open` get their `write` and `sync` wrapped too.
// Only named imports of `fs/promises` are intercepted: a module reaching them through the default export (`fs.link`)
// escapes the injector. Injectors never nest: a second one replaces the first until it is disposed, which also
// removes the first.
export function injectFileSystemFaults(options: FileSystemFaultOptions = {}): FileSystemFaults {
	const { failAt, mode = 'once', code = 'EIO', partialCopyBytes, linkError, spare } = options
	const counted = new Set(options.operations ?? DURABLE_FILE_SYSTEM_OPERATIONS)
	const sequence = options.sequence ?? createTestSequence()
	const entries: FileSystemEntry[] = []
	const restores: VoidFunction[] = []
	let steps = 0

	// Logs one operation and returns whether it must fail.
	const enter = (operation: FileSystemOperation, paths: readonly string[]) => {
		const spared = spare !== undefined && paths.every(spare)
		const step = counted.has(operation) && !spared ? ++steps : undefined
		const failed = step !== undefined && failAt !== undefined && (mode === 'crash' ? step >= failAt : step === failAt)
		entries.push({ kind: 'fs', sequence: sequence.next(), operation, paths, step, failed })
		return failed
	}

	const injected = (operation: FileSystemOperation, paths: readonly string[], error = code) => Object.assign(new Error(`injected ${error} on ${operation} ${paths.join(' ')}`), { code: error })

	const wrap = (operation: Exclude<FileSystemOperation, 'sync' | 'write'>, paths: (args: readonly unknown[]) => readonly string[]) => {
		const target = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		const original = target[operation]
		const spy = spyOn(target, operation).mockImplementation(async (...args: unknown[]) => {
			const touched = paths(args)

			if (operation === 'link' && linkError !== undefined) {
				entries.push({ kind: 'fs', sequence: sequence.next(), operation, paths: touched, failed: true })
				throw injected(operation, touched, linkError)
			}

			if (enter(operation, touched)) {
				if (operation === 'copyFile' && partialCopyBytes !== undefined) {
					const source = await Bun.file(String(args[0])).bytes()
					await Bun.write(String(args[1]), source.subarray(0, partialCopyBytes))
				}

				throw injected(operation, touched)
			}

			const result = await original(...args)
			return operation === 'open' ? wrapHandle(result as fsp.FileHandle, touched[0]) : result
		})
		restores.push(() => spy.mockRestore())
	}

	const wrapHandle = (handle: fsp.FileHandle, path: string) => {
		for (const method of ['write', 'sync'] as const) {
			const original = handle[method].bind(handle) as (...args: unknown[]) => Promise<unknown>
			;(handle as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
				if (enter(method, [path])) throw injected(method, [path])
				return await original(...args)
			}
		}

		return handle
	}

	const first = (args: readonly unknown[]) => [String(args[0])]
	const both = (args: readonly unknown[]) => [String(args[0]), String(args[1])]

	wrap('open', first)
	wrap('writeFile', first)
	wrap('appendFile', first)
	wrap('rename', both)
	wrap('link', both)
	wrap('copyFile', both)
	wrap('unlink', first)
	wrap('stat', first)

	return {
		entries,
		steps: () => steps,
		[Symbol.dispose]: () => {
			for (const restore of restores.toReversed()) restore()
		},
	}
}

// Entry of a Sequencer test log: device commands, transitions and memberships, and file-system operations.
export type SequencerLogEntry = DeviceLogEntry | FileSystemEntry

// What the oracle needs to know about the configuration of the run.
export interface SequencerOracleOptions {
	// Whether a safety snapshot that is not known counts as unsafe, as the Sequencer safety option of that name.
	readonly unknownIsUnsafe?: boolean
}

// Mount commands that move it.
const MOUNT_MOTION_COMMANDS = new Set(['goTo', 'flipTo', 'park', 'unpark', 'home', 'findHome'])
// Manual mount motion commands; only an enabled one moves.
const MOUNT_MANUAL_COMMANDS = new Set(['moveNorth', 'moveSouth', 'moveWest', 'moveEast'])

// Whether a command moves something in the optical train: mount, focuser, wheel, rotator, cover or a guide pulse.
function isMotionCommand(entry: DeviceCommandEntry) {
	switch (entry.manager) {
		case 'mount':
			return MOUNT_MOTION_COMMANDS.has(entry.command) || (MOUNT_MANUAL_COMMANDS.has(entry.command) && entry.args[0] === true)
		case 'focuser':
		case 'wheel':
		case 'rotator':
			return entry.command.startsWith('move')
		case 'cover':
			return entry.command === 'park' || entry.command === 'unpark'
		case 'guideOutput':
			return true
		default:
			return false
	}
}

// Whether a mount command moves the mount, the subject of I14.
function isMountMotion(entry: DeviceCommandEntry) {
	return entry.manager === 'mount' && isMotionCommand(entry)
}

// Whether a command opens the optical path or the observatory to the sky, the subject of I15.
function isOpening(entry: DeviceCommandEntry) {
	return (entry.manager === 'cover' && entry.command === 'unpark') || (entry.manager === 'mount' && entry.command === 'unpark') || (entry.manager === 'dome' && (entry.command === 'unpark' || entry.command === 'openShutter'))
}

// Checks the invariants a log of device commands, transitions and file operations can prove, and throws an Error
// starting with the invariant id on the first violation:
// - I2: no motion command (mount, focuser, wheel, rotator, cover, guide pulse) between a startExposure and the end of
//   that exposure, observed as its camera `exposuring` turning false;
// - I14: no mount motion while any guide output reports `pulsing` (the Sequencer half, pause() resolved before the
//   motion, joins the oracle with the guiding events);
// - I15: no opening (dome unpark or shutter opening, cover or mount unpark) while the last safety snapshot is unsafe, or unknown with
//   `unknownIsUnsafe`.
export function assertSequencerInvariants(log: readonly SequencerLogEntry[], options: SequencerOracleOptions = {}) {
	const entries = [...log].sort((a, b) => a.sequence - b.sequence)
	const exposing = new Set<string>()
	const pulsing = new Set<string>()
	let safe: boolean | undefined

	for (const entry of entries) {
		if (entry.kind === 'transition') {
			if (entry.property === 'exposuring' && entry.value === false) exposing.delete(entry.device)
			else if (entry.property === 'pulsing') {
				if (entry.value === true) pulsing.add(entry.device)
				else pulsing.delete(entry.device)
			} else if (entry.property === 'safe') safe = entry.value === true
			continue
		}

		if (entry.kind !== 'command') continue

		if (isMotionCommand(entry) && exposing.size > 0) {
			throw new Error(`I2: ${entry.manager} ${entry.command} on ${entry.device} (#${entry.sequence}) while ${[...exposing].join(', ')} is exposing`)
		}

		if (isMountMotion(entry) && pulsing.size > 0) {
			throw new Error(`I14: mount ${entry.command} on ${entry.device} (#${entry.sequence}) while ${[...pulsing].join(', ')} is pulsing`)
		}

		if (isOpening(entry) && (safe === false || (safe === undefined && options.unknownIsUnsafe === true))) {
			throw new Error(`I15: ${entry.manager} ${entry.command} on ${entry.device} (#${entry.sequence}) with the safety ${safe === undefined ? 'unknown' : 'unsafe'}`)
		}

		if (entry.manager === 'camera' && entry.command === 'startExposure') exposing.add(entry.device)
	}
}

// Root operation of the reservation as the runner recorder saw it.
export interface RunnerRootEntry {
	readonly kind: 'root'
	readonly sequence: number
	readonly event: 'start' | 'cancel' | 'end'
	// Operation id.
	readonly id: string
	// Operation kind, such as `sequencer.autofocus` or `sequencer.compensate.focuserPosition`.
	readonly operation: string
	// Reason of a cancel, or of a failed end.
	readonly reason?: OperationFailureReason
	// Detail of a failed end.
	readonly error?: string
	// Whether an ended root succeeded.
	readonly ok?: boolean
}

// Drain of the reservation: `terminal` is cancelByReservationOwner, otherwise drainByReservationOwner.
export interface RunnerDrainEntry {
	readonly kind: 'drain'
	readonly sequence: number
	readonly event: 'begin' | 'end'
	readonly terminal: boolean
}

// Release of the session reservation.
export interface RunnerReleaseEntry {
	readonly kind: 'release'
	readonly sequence: number
}

// Event of the session.
export interface RunnerEventEntry {
	readonly kind: 'event'
	readonly sequence: number
	readonly event: SequencerEvent
}

// Entry of the runner log.
export type RunnerLogEntry = RunnerRootEntry | RunnerDrainEntry | RunnerReleaseEntry | RunnerEventEntry

// Recorder of one runner: the entries in order, the listener to give the session, and the call that stops recording.
export interface RunnerRecorder extends Disposable {
	readonly entries: RunnerLogEntry[]
	readonly listener: SequencerListener
	// Owner of the first reservation the session took; absent before it.
	readonly reservationOwner?: ResourceReservationOwner
}

// Records, in one sequence, the roots the session opens in its reserved scopes (start, cancel through the handle,
// end with its result), the drains of the reservation, the release of the reservation and the session events, by
// wrapping the coordinator and its arbiter. The wrappers only observe.
export function recordRunner(coordinator: OperationCoordinator, sequence: TestSequence = createTestSequence()): RunnerRecorder {
	const entries: RunnerLogEntry[] = []
	let owner: ResourceReservationOwner | undefined
	const restores: VoidFunction[] = []
	const push = (entry: Omit<RunnerRootEntry, 'sequence'> | Omit<RunnerDrainEntry, 'sequence'> | Omit<RunnerReleaseEntry, 'sequence'>) => entries.push({ ...entry, sequence: sequence.next() })

	const wrapHandle = <T>(handle: OperationHandle<T>): OperationHandle<T> => {
		const operation = handle.kind
		push({ kind: 'root', event: 'start', id: handle.id, operation })
		void handle.result.then((result) => push({ kind: 'root', event: 'end', id: handle.id, operation, ok: result.ok, ...(!result.ok && { reason: result.reason, error: result.error }) }))

		return Object.freeze({
			...handle,
			cancel: (reason: OperationFailureReason = 'aborted') => {
				push({ kind: 'root', event: 'cancel', id: handle.id, operation, reason })
				return handle.cancel(reason)
			},
		})
	}

	const reservedScope = coordinator.reservedScope.bind(coordinator)
	const scopeSpy = spyOn(coordinator, 'reservedScope').mockImplementation((reservation: ResourceReservation): OperationScope => {
		const scope = reservedScope(reservation)
		return { start: (kind, resources, executor) => wrapHandle(scope.start(kind, resources, executor)) }
	})
	restores.push(() => scopeSpy.mockRestore())

	const drain = coordinator.drainByReservationOwner.bind(coordinator)
	const drainSpy = spyOn(coordinator, 'drainByReservationOwner').mockImplementation(async (...args: Parameters<typeof drain>) => {
		push({ kind: 'drain', event: 'begin', terminal: false })
		await drain(...args)
		push({ kind: 'drain', event: 'end', terminal: false })
	})
	restores.push(() => drainSpy.mockRestore())

	const cancel = coordinator.cancelByReservationOwner.bind(coordinator)
	const cancelSpy = spyOn(coordinator, 'cancelByReservationOwner').mockImplementation(async (...args: Parameters<typeof cancel>) => {
		push({ kind: 'drain', event: 'begin', terminal: true })
		await cancel(...args)
		push({ kind: 'drain', event: 'end', terminal: true })
	})
	restores.push(() => cancelSpy.mockRestore())

	const reserve = coordinator.arbiter.reserve.bind(coordinator.arbiter)
	const reserveSpy = spyOn(coordinator.arbiter, 'reserve').mockImplementation((...args: Parameters<typeof reserve>) => {
		const reserved = reserve(...args)
		if (!reserved.ok) return reserved
		owner ??= args[0]
		const { reservation } = reserved
		let released = false

		return {
			ok: true,
			reservation: {
				ownerId: reservation.ownerId,
				token: reservation.token,
				get resources() {
					return reservation.resources
				},
				release: () => {
					if (!released) push({ kind: 'release' })
					released = true
					reservation.release()
				},
			},
		}
	})
	restores.push(() => reserveSpy.mockRestore())

	return {
		entries,
		get reservationOwner() {
			return owner
		},
		listener: (event) => entries.push({ kind: 'event', sequence: sequence.next(), event }),
		[Symbol.dispose]: () => {
			for (const restore of restores.toReversed()) restore()
		},
	}
}

// Shutdown tasks, whose roots are never cancelled by a stop.
const SHUTDOWN_TASKS = new Set<string>(['pauseGuiding', 'stopTracking', 'stopGuiding', 'closeCover', 'parkMount', 'closeOrParkDome', 'turnOffFlatPanel', 'warmCamera'] satisfies SequencerTaskId[])

// Whether a root kind is a shutdown step.
function isShutdownRoot(operation: string) {
	return operation.startsWith('sequencer.') && SHUTDOWN_TASKS.has(operation.slice('sequencer.'.length))
}

// Whether a root kind is a run task: neither a compensation, a protection nor a shutdown step.
function isRunRoot(operation: string) {
	return operation.startsWith('sequencer.') && !operation.startsWith('sequencer.compensate.') && !operation.startsWith('sequencer.protect.') && !isShutdownRoot(operation)
}

// What the runner oracle needs to know about the run.
export interface RunnerOracleOptions {
	// Whether the session was disposed, which may cancel the shutdown.
	readonly disposed?: boolean
}

// Checks the invariants a runner log can prove, and throws an Error starting with the invariant id on the first
// violation:
// - I12: one terminal event at most, after the single release; the release comes after the terminal drain and
//   after every root ended; no root starts after it;
// - I13: no shutdown root is cancelled for anything but its timeout, unless the session was disposed;
// - I17: every compensation root starts with no run task root alive, before any shutdown root and before the release;
// - I42 (drain half): no drainByReservationOwner begins while a cancelled run task root has not ended yet.
export function assertRunnerInvariants(log: readonly RunnerLogEntry[], options: RunnerOracleOptions = {}) {
	const entries = [...log].sort((a, b) => a.sequence - b.sequence)
	const started = entries.some((entry) => entry.kind === 'event' && entry.event.type === 'sessionStarted')
	const alive = new Map<string, string>()
	const cancelled = new Set<string>()
	let released = false
	let terminalDrained = false
	let shutdownStarted = false
	let terminals = 0

	for (const entry of entries) {
		switch (entry.kind) {
			case 'root':
				if (entry.event === 'start') {
					if (released) throw new Error(`I12: root ${entry.operation} (#${entry.sequence}) started after the release`)

					if (entry.operation.startsWith('sequencer.compensate.')) {
						const run = [...alive.values()].find(isRunRoot)
						if (run !== undefined) throw new Error(`I17: compensation ${entry.operation} (#${entry.sequence}) started while ${run} is alive`)
						if (shutdownStarted) throw new Error(`I17: compensation ${entry.operation} (#${entry.sequence}) started after the shutdown`)
					}

					if (isShutdownRoot(entry.operation)) shutdownStarted = true
					alive.set(entry.id, entry.operation)
				} else if (entry.event === 'cancel') {
					if (isShutdownRoot(entry.operation) && entry.reason !== 'timeout' && options.disposed !== true) throw new Error(`I13: shutdown root ${entry.operation} (#${entry.sequence}) cancelled with ${entry.reason}`)
					if (alive.has(entry.id)) cancelled.add(entry.id)
				} else {
					alive.delete(entry.id)
					cancelled.delete(entry.id)
				}
				break
			case 'drain':
				if (entry.event === 'begin' && !entry.terminal) {
					const pending = [...cancelled].map((id) => alive.get(id) ?? '').find(isRunRoot)
					if (pending !== undefined) throw new Error(`I42: drain (#${entry.sequence}) began before the cancelled root ${pending} ended`)
				}
				if (entry.event === 'end' && entry.terminal) terminalDrained = true
				break
			case 'release':
				if (released) throw new Error(`I12: reservation released twice (#${entry.sequence})`)
				if (!terminalDrained) throw new Error(`I12: reservation released (#${entry.sequence}) before the terminal drain`)
				if (alive.size > 0) throw new Error(`I12: reservation released (#${entry.sequence}) while ${[...alive.values()].join(', ')} is alive`)
				released = true
				break
			case 'event': {
				const { type } = entry.event

				if (type === 'sessionCompleted' || type === 'sessionStopped' || type === 'sessionFailed') {
					if (++terminals > 1) throw new Error(`I12: second terminal event ${type} (#${entry.sequence})`)
					if (started && !released) throw new Error(`I12: terminal event ${type} (#${entry.sequence}) before the release`)
				}
			}
		}
	}
}

// Checks the invariants a session journal, with the events of the same session when given, can prove, and throws an
// Error starting with the invariant id on the first violation:
// - I11: at most one committed final per slot and per final path, always the final its prepared line reserved;
// - I36: no attempt is prepared while another one is still open (its last line `prepared`), and no attempt is deferred
//   once it produced a transaction;
// - I49: every final and discarded destination ends in `.fit` but not `.partial.fit`, every temporary in
//   `.partial.fit`, and the final of an attempt never changes between prepared, promoting and committed;
// - I4 (journal half): every frameAccepted event has the committed line of its attempt, with its final.
export function assertJournalInvariants(journal: readonly SequencerJournalEntry[], events: readonly SequencerEvent[] = []) {
	const finals = new Map<string, string>()
	const committedSlots = new Set<string>()
	const committedFinals = new Set<string>()
	const committed = new Map<string, string>()
	const transactions = new Set<string>()
	let open: string | undefined

	const isFinal = (path: string) => path.endsWith('.fit') && !path.endsWith('.partial.fit')

	for (const [i, entry] of journal.entries()) {
		if (entry.kind === 'lockReclaimed') continue
		const key = `${entry.slot}#${entry.attempt}`

		switch (entry.kind) {
			case 'prepared':
				if (open !== undefined && open !== key) throw new Error(`I36: ${key} prepared (line ${i + 1}) while ${open} is open`)
				if (!entry.temporary.endsWith('.partial.fit') || !isFinal(entry.final)) throw new Error(`I49: ${key} prepared with ${entry.temporary} and ${entry.final} (line ${i + 1})`)
				if (finals.has(key) && finals.get(key) !== entry.final) throw new Error(`I49: final of ${key} changed to ${entry.final} (line ${i + 1})`)
				finals.set(key, entry.final)
				open = key
				break
			case 'deferred':
				if (transactions.has(key)) throw new Error(`I36: ${key} deferred after its transaction (line ${i + 1})`)
				if (open === key) open = undefined
				break
			case 'promoting':
			case 'committed':
				if (entry.final !== finals.get(key)) throw new Error(`I49: ${entry.kind} of ${key} with final ${entry.final} instead of ${finals.get(key)} (line ${i + 1})`)
				transactions.add(key)
				if (open === key) open = undefined

				if (entry.kind === 'committed') {
					if (committedSlots.has(entry.slot) && committed.get(entry.slot) !== key) throw new Error(`I11: second committed final of ${entry.slot} (line ${i + 1})`)
					if (committedFinals.has(entry.final) && committed.get(entry.slot) !== key) throw new Error(`I11: ${entry.final} committed twice (line ${i + 1})`)
					committedSlots.add(entry.slot)
					committedFinals.add(entry.final)
					committed.set(entry.slot, key)
				}

				break
			case 'disposing':
				if (entry.destination !== undefined && !isFinal(entry.destination)) throw new Error(`I49: ${key} disposed of to ${entry.destination} (line ${i + 1})`)
				transactions.add(key)
				if (open === key) open = undefined
				break
			case 'disposed':
			case 'abandoned':
				if (open === key) open = undefined
		}
	}

	for (const event of events) {
		if (event.type !== 'frameAccepted') continue
		const key = `${event.slot}#${event.attempt}`
		const final = finals.get(key)
		if (committed.get(event.slot) !== key || final === undefined || !event.path.split(sep).join('/').endsWith(`/${final}`)) throw new Error(`I4: frameAccepted ${key} at ${event.path} without its committed line`)
	}
}
