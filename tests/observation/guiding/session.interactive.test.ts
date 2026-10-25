import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { type Camera, DEFAULT_CAMERA } from '../../../src/devices/indi/device'
import type { CameraManager } from '../../../src/devices/indi/manager/camera'
import { failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { resourceKey } from '../../../src/devices/orchestration/resource'
import { DEFAULT_CAMERA_CAPTURE_START } from '../../../src/observation/capture/types'
import { GuiderClient, type GuiderClientHandler } from '../../../src/observation/guiding/client'
import type { GuidingSettle } from '../../../src/observation/guiding/session'
import { guideOutputLifecycleKey, InteractiveGuidingSession } from '../../../src/observation/guiding/session.interactive'
import { waitUntil } from '../../util'
import { fixtureImageDecoder, fixtureStarTracker } from '../../util/guiding'
import { connectSimulatorRig, createSimulatorRig, expectNoRigLeaks, ManualClock, resetSimulatorRig } from '../../util/rig'

// InteractiveGuidingSession over a real GuiderClient whose guide camera is a fake that records its commands (its
// exposures go nowhere) and whose guide output is the ST4 port of the mount simulator of the simulator rig, with the
// real GuideOutputCommander, arbiter, coordinator and device lifecycle. Settles are reported by injecting the
// settleDone event of the client.

const SETTLE: GuidingSettle = { pixels: 1.5, time: 1, timeout: 10 }

// Camera manager that records the commands it receives and exposes nothing.
class RecordingCameraManager {
	readonly commands: string[] = []

	addHandler() {}
	removeHandler() {}
	enableBlob() {
		this.commands.push('enableBlob')
	}
	disableBlob() {}
	startExposure() {
		this.commands.push('startExposure')
	}
	stopExposure() {}
	frame(_: Camera, x: number, y: number, width: number, height: number) {
		this.commands.push(`frame ${x} ${y} ${width} ${height}`)
	}
	frameType(_: Camera, type: string) {
		this.commands.push(`frameType ${type}`)
	}
	frameFormat() {}
	bin(_: Camera, x: number, y: number) {
		this.commands.push(`bin ${x} ${y}`)
	}
	gain(_: Camera, value: number) {
		this.commands.push(`gain ${value}`)
	}
	offset(_: Camera, value: number) {
		this.commands.push(`offset ${value}`)
	}
	transferFormat() {}
	compression() {}
}

const GUIDE_CAMERA: Camera = { ...DEFAULT_CAMERA, id: 'Guide Camera', name: 'Guide Camera', hardwareId: 'guide-camera', connected: true }

const rig = await createSimulatorRig()

beforeAll(async () => {
	await connectSimulatorRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSimulatorRig(rig, rig.devices().focuser.position.value)
})

const sessions: { readonly client: GuiderClient; readonly session: InteractiveGuidingSession }[] = []

afterEach(async () => {
	for (const { client, session } of sessions.splice(0)) {
		await session.stop(rig.coordinator)
		client.stopCapture()
		client.disconnect()
	}

	expect(rig.arbiter.ownersOf(resourceKey(GUIDE_CAMERA))).toEqual([])
	await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)
	await expectNoRigLeaks(rig)
})

function setup() {
	const cameraManager = new RecordingCameraManager()
	const client = new GuiderClient(cameraManager as unknown as CameraManager, rig.managers.guideOutput, fixtureStarTracker(), { decodeImage: fixtureImageDecoder })
	const clock = new ManualClock()
	const session = new InteractiveGuidingSession(client, GUIDE_CAMERA, rig.devices().guideOutput, rig.commanders.guideOutput, { delay: clock.delay })
	sessions.push({ client, session })
	return { client, session, cameraManager, clock }
}

// Starts guiding and reports the settle once the session asked the client to guide.
async function startGuiding({ client, session, clock }: ReturnType<typeof setup>, recalibrate = false) {
	let asked = false
	const handler: GuiderClientHandler = { event: (_, event) => void (asked ||= event.type === 'settleStarted') }
	client.addHandler(handler)
	const pending = session.startGuiding(rig.coordinator, rig.coordinator, { recalibrate, settle: SETTLE, clock })
	await waitUntil(() => asked, 2000, 1)
	client.removeHandler(handler)
	client.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })
	return await pending
}

describe('loop', () => {
	test('the root holds only the guide camera, configures it once and loops with a closed gate', async () => {
		const context = setup()
		const { client, session, cameraManager } = context
		const { mount } = rig.devices()

		const camera = { ...DEFAULT_CAMERA_CAPTURE_START, subframe: true, x: 8, y: 16, width: 320, height: 240, binX: 2, binY: 2, gain: 120, offset: 10 }
		expect(await session.startLoop(rig.coordinator, { exposure: 2000, camera })).toEqual(successfulOperationResult(undefined))

		const root = session.operationId()!
		expect(rig.arbiter.ownersOf(resourceKey(GUIDE_CAMERA)).map((owner) => owner.id)).toEqual([root])
		expect(rig.arbiter.ownersOf(resourceKey(mount))).toEqual([])
		expect(client.getAppState()).toBe('Looping')
		expect(client.getExposure()).toBe(2000)
		expect(cameraManager.commands.slice(cameraManager.commands.lastIndexOf('enableBlob'))).toEqual(['enableBlob', 'frame 8 16 320 240', 'frameType LIGHT', 'bin 2 2', 'gain 120', 'offset 10', 'startExposure'])
		expect(session.snapshot()).toMatchObject({ active: true, lost: false, state: 'looping', guideOutputHeld: false, pulsesAdmitted: false })

		// The gate is closed while looping, and the mount stays free for its own pulses.
		expect(client.guidePulse(100, 'North')).toBeFalse()
		expect(await rig.commanders.guideOutput.pulse(rig.coordinator, mount, 'NORTH', 50, { settleTimeout: 500 })).toEqual(successfulOperationResult(undefined))

		// A second start keeps the same root.
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).toBe(root)

		expect(await session.stop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot()).toMatchObject({ active: false, lost: false, state: 'stopped' })
		// The admission startLoop installed is gone with the session.
		expect(session.admitted).toBeFalse()
	})

	test('selects and clears the target from the looping frames', async () => {
		const { client, session } = setup()
		expect(session.selectTarget()).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))

		expect(session.selectTarget([40, 30])).toEqual(successfulOperationResult([40, 30]))
		expect(client.getLockPosition()).toEqual([40, 30])
		expect(client.getAppState()).toBe('Selected')
		expect(session.clearTarget()).toEqual(successfulOperationResult(undefined))
		expect(client.getLockPosition()).toBeUndefined()
	})
})

describe('guiding run', () => {
	test('guiding keeps the root and leases the guide output in a run; stopping guiding releases it and keeps looping', async () => {
		const context = setup()
		const { client, session } = context
		const { mount, guideOutput } = rig.devices()
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		const root = session.operationId()!

		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
		const run = session.snapshot().runId!
		expect(session.operationId()).toBe(root)
		expect(rig.coordinator.get(run)).toBeDefined()
		expect(rig.arbiter.ownersOf(resourceKey(mount)).map((owner) => owner.id)).toEqual([root])
		expect(rig.arbiter.ownersOf(guideOutputLifecycleKey(guideOutput)).map((owner) => owner.id)).toEqual([root])
		expect(session.snapshot()).toMatchObject({ guideOutputHeld: true, pulsesAdmitted: true })

		// Admitted pulses go through the commander under the run.
		expect(client.guidePulse(300, 'North')).toBeTrue()
		expect(rig.commanders.guideOutput.dispatchedPulseWindow(guideOutput)).toBeDefined()
		// A manual pulse of someone else is refused while guiding.
		expect(await rig.commanders.guideOutput.pulse(rig.coordinator, mount, 'NORTH', 50)).toMatchObject({ ok: false, reason: 'busy' })

		expect(await session.stopGuiding(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(rig.coordinator.get(run)).toBeUndefined()
		expect(rig.commanders.guideOutput.dispatchedPulseWindow(guideOutput)).toBeUndefined()
		expect(guideOutput.pulsing).toBeFalse()
		expect(rig.arbiter.ownersOf(resourceKey(mount))).toEqual([])
		expect(session.operationId()).toBe(root)
		// No frame selected a target, so the client loops without one.
		expect(client.getAppState()).toBe('Looping')
		expect(client.guidePulse(100, 'North')).toBeFalse()
		expect(session.snapshot()).toMatchObject({ active: true, guideOutputHeld: false, pulsesAdmitted: false })

		// The mount can be moved by others again, and guiding can start once more under the same root.
		expect(await rig.commanders.guideOutput.pulse(rig.coordinator, mount, 'NORTH', 50, { settleTimeout: 500 })).toEqual(successfulOperationResult(undefined))
		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).toBe(root)
		expect(session.snapshot().runId).not.toBe(run)
	}, 20000)

	test('starting guiding is refused while the guide output is taken, and looping goes on', async () => {
		const context = setup()
		const { client, session } = context
		const { mount } = rig.devices()
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))

		const { promise: held, resolve: release } = Promise.withResolvers<void>()
		const other = rig.coordinator.start('other', [{ key: resourceKey(mount), device: mount }], async () => {
			await held
			return successfulOperationResult(undefined)
		})

		expect(await session.startGuiding(rig.coordinator, rig.coordinator, { recalibrate: false, settle: SETTLE })).toMatchObject({ ok: false, reason: 'busy' })
		expect(session.snapshot()).toMatchObject({ active: true, guideOutputHeld: false, pulsesAdmitted: false })
		expect(client.getAppState()).toBe('Looping')

		release()
		await other.result
		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
	})
})

describe('pause and resume', () => {
	test('a corrections pause keeps the run and only pauses the corrections; a full one also stops exposing; resume settles again', async () => {
		const context = setup()
		const { client, session } = context
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
		const run = session.snapshot().runId

		// Without frames the client never solves a calibration, so a guiding state is stood in for during the pause.
		const paused = spyOn(client, 'setPaused')
		Object.defineProperty(client, 'state', { configurable: true, get: () => 'guiding' })
		const corrections = await session.pause(rig.coordinator, 'corrections')
		Reflect.deleteProperty(client, 'state')
		expect(corrections).toEqual(successfulOperationResult(undefined))
		expect(paused.mock.calls).toEqual([[true, false]])
		expect(session.snapshot()).toMatchObject({ state: 'paused', guideOutputHeld: true, pulsesAdmitted: false, runId: run })
		expect(client.guidePulse(100, 'North')).toBeFalse()

		const guide = spyOn(client, 'guide')
		const resumed = session.resume(rig.coordinator, SETTLE)
		await waitUntil(() => guide.mock.calls.length === 1, 2000, 1)
		client.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(guide.mock.calls[0][0]).toBeFalse()
		expect(session.snapshot()).toMatchObject({ pulsesAdmitted: true, runId: run })

		Object.defineProperty(client, 'state', { configurable: true, get: () => 'guiding' })
		const all = await session.pause(rig.coordinator, 'all')
		Reflect.deleteProperty(client, 'state')
		expect(all).toEqual(successfulOperationResult(undefined))
		expect(paused.mock.calls.at(-1)).toEqual([true, true])
		paused.mockRestore()
		guide.mockRestore()
	})
	test('a pause during calibration is full and resume restarts the calibration', async () => {
		const context = setup()
		const { client, session } = context
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(await startGuiding(context, true)).toEqual(successfulOperationResult(undefined))
		expect(client.getAppState()).toBe('Calibrating')

		const paused = spyOn(client, 'setPaused')
		expect(await session.pause(rig.coordinator, 'corrections')).toEqual(successfulOperationResult(undefined))
		expect(paused.mock.calls).toEqual([[true, true]])

		const guide = spyOn(client, 'guide')
		const resumed = session.resume(rig.coordinator, SETTLE)
		await waitUntil(() => guide.mock.calls.length === 1, 2000, 1)
		client.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(guide.mock.calls[0][0]).toBeTrue()
		paused.mockRestore()
		guide.mockRestore()
	})

	test('a releasing pause ends the run and resume opens a new one', async () => {
		const context = setup()
		const { client, session } = context
		const { mount } = rig.devices()
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
		const run = session.snapshot().runId

		expect(await session.pause(rig.coordinator, 'all', { releaseGuideOutput: true })).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot()).toMatchObject({ state: 'paused', guideOutputHeld: false })
		expect(rig.arbiter.ownersOf(resourceKey(mount))).toEqual([])

		const resumed = session.resume(rig.coordinator, SETTLE)
		await waitUntil(() => session.snapshot().pulsesAdmitted, 2000, 1)
		client.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot().runId).toBeDefined()
		expect(session.snapshot().runId).not.toBe(run)
	})
})

describe('loss', () => {
	test('losing the guide output while a pulse runs ends the session as lost and blocks the mount until the pulse end is seen', async () => {
		const context = setup()
		const { client, session } = context
		const { mount } = rig.devices()
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(await startGuiding(context)).toEqual(successfulOperationResult(undefined))
		const root = session.operationId()!

		// A driver that publishes nothing: the end of the pulse is never observed before the mount goes away.
		const silent = spyOn(rig.managers.guideOutput, 'pulse').mockImplementation(() => {})

		try {
			expect(client.guidePulse(2000, 'North')).toBeTrue()
			expect(rig.commanders.guideOutput.dispatchedPulseWindow(mount)).toBeDefined()
			rig.managers.mount.disconnect(mount)

			await waitUntil(() => session.operationId() === undefined, 5000, 10)
			expect(rig.coordinator.get(root)).toBeUndefined()
			expect(session.snapshot()).toMatchObject({ active: false, lost: true, failure: { reason: 'disconnected' }, guideOutputHeld: false })
			expect(session.interruptions(0, Number.MAX_SAFE_INTEGER).interruptions.map((each) => each.kind)).toEqual(['disconnected'])
			expect(client.getAppState()).toBe('Stopped')
			await waitUntil(() => rig.arbiter.snapshot(resourceKey(mount)).causes.includes('guidePulse'), 2000, 5)
		} finally {
			silent.mockRestore()
		}

		// Reconnecting republishes the axes stopped, which ends the evidence; a new start clears the loss.
		rig.managers.mount.connect(mount)
		await waitUntil(() => mount.connected && mount.canPulseGuide, 5000, 10)
		await waitUntil(() => rig.commanders.guideOutput.dispatchedPulseWindow(mount) === undefined, 8000, 10)
		expect(rig.arbiter.snapshot(resourceKey(mount)).causes).not.toContain('guidePulse')
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot()).toMatchObject({ active: true, lost: false, failure: undefined })
	}, 30000)

	test('a refused guide closes the gate and ends the run it opened', async () => {
		const { client, session } = setup()
		expect(await session.startLoop(rig.coordinator)).toEqual(successfulOperationResult(undefined))

		const guide = spyOn(client, 'guide').mockReturnValue(false)
		expect(await session.startGuiding(rig.coordinator, rig.coordinator, { recalibrate: false, settle: SETTLE })).toEqual(failedOperationResult('unexpectedState', 'the guider refused to guide'))
		expect(session.snapshot()).toMatchObject({ active: true, guideOutputHeld: false, pulsesAdmitted: false })
		expect(rig.arbiter.ownersOf(resourceKey(rig.devices().mount))).toEqual([])
		guide.mockRestore()
	})
})
