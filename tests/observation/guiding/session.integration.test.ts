import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { resourceKey } from '../../../src/devices/orchestration/resource'
import { arcmin } from '../../../src/math/units/angle'
import { DEFAULT_CAMERA_CAPTURE_START } from '../../../src/observation/capture/types'
import type { GuidingEvent } from '../../../src/observation/guiding/events'
import type { GuidingSettle } from '../../../src/observation/guiding/session'
import { InteractiveGuidingSession } from '../../../src/observation/guiding/session.interactive'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { createGuidingRig, GUIDING_RIG_GUIDE_FRAME, type GuidingRig } from '../../util/guiding.rig'

// The whole interactive guiding workflow on the two-camera guiding rig, in real time: the guide camera loops, a star is
// selected, the mount is calibrated through its ST4 port and guided, a dither settles, a corrections pause keeps the
// exposures going, stopping guiding frees the mount for a slew while looping goes on, guiding starts again with the
// solved calibration, and the session ends without leaving anything owned; the main camera captures meanwhile.

const SETTLE: GuidingSettle = { pixels: 1.5, time: 1, timeout: 60 }

let rig: GuidingRig
let capturesDir: string

beforeAll(async () => {
	if (isTimeConsumingTestSkipped()) return
	capturesDir = await mkdtemp(join(tmpdir(), 'nebulosa-guiding-'))
	rig = await createGuidingRig(capturesDir)
})

afterAll(async () => {
	if (isTimeConsumingTestSkipped()) return
	await rig[Symbol.asyncDispose]()
	await rm(capturesDir, { recursive: true, force: true })
})

describe.skipIf(isTimeConsumingTestSkipped())('two-camera guiding', () => {
	test('loops, calibrates, guides, dithers, pauses, frees the mount for a slew and guides again under one session', async () => {
		const { coordinator, arbiter, guider, guideOutputCommander, mountCommander } = rig
		const mount = rig.mount()
		const guideCamera = rig.guide()
		const events: GuidingEvent[] = []
		let frames = 0
		guider.addHandler({ event: (_, event) => void events.push(event), frame: () => void frames++ })
		const ofType = <T extends GuidingEvent['type']>(type: T) => events.filter((event) => event.type === type) as Extract<GuidingEvent, { type: T }>[]
		const session = new InteractiveGuidingSession(guider, guideCamera, rig.guideOutput(), guideOutputCommander)

		// The main camera captures under its own key while the guide camera loops.
		const capture = rig.capturer.start(coordinator, rig.main(), { ...DEFAULT_CAMERA_CAPTURE_START, exposureTime: 1, exposureTimeUnit: 'second', exposureMode: 'fixed', count: 3 })

		const camera = { ...DEFAULT_CAMERA_CAPTURE_START, subframe: true, ...GUIDING_RIG_GUIDE_FRAME }
		expect(await session.startLoop(coordinator, { exposure: 500, camera })).toEqual(successfulOperationResult(undefined))
		const root = session.operationId()!
		await waitUntil(() => frames > 0, 10000, 10)
		expect(guideCamera.frame.width.value).toBe(GUIDING_RIG_GUIDE_FRAME.width)
		expect(arbiter.ownersOf(resourceKey(guideCamera)).map((owner) => owner.id)).toEqual([root])
		expect(arbiter.ownersOf(resourceKey(mount))).toEqual([])

		const target = session.selectTarget()
		expect(target).toMatchObject({ ok: true })

		// Calibration and guiding run under the same root and leave the guide camera with it.
		expect(await session.startGuiding(coordinator, coordinator, { recalibrate: true, settle: SETTLE })).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).toBe(root)
		const [completed] = ofType('calibrationCompleted')
		expect(completed.calibration.ra.ratePxPerMs).toBeGreaterThan(0)
		expect(completed.calibration.dec.ratePxPerMs).toBeGreaterThan(0)
		expect(session.snapshot()).toMatchObject({ state: 'guiding', guideOutputHeld: true, pulsesAdmitted: true, calibrated: true })
		expect(arbiter.ownersOf(resourceKey(mount)).map((owner) => owner.id)).toEqual([root])

		// Nobody else may move the mount while guiding.
		const north = { type: 'JNOW', JNOW: { x: mount.equatorialCoordinate.rightAscension, y: mount.equatorialCoordinate.declination + arcmin(1) } } as const
		expect(await mountCommander.goTo(coordinator, mount, north)).toMatchObject({ ok: false, reason: 'busy' })
		expect(await guideOutputCommander.pulse(coordinator, mount, 'NORTH', 100)).toMatchObject({ ok: false, reason: 'busy' })

		// Once the controller averaged its lock reference (8 frames by default), a dither moves the lock and the
		// corrections bring the star back before the settle succeeds.
		const guided = ofType('guideStep').length
		await waitUntil(() => ofType('guideStep').length >= guided + 8, 20000, 10)
		const before = ofType('guideStep').length
		const dithered = await session.dither(coordinator, { amount: { unit: 'guidePixel', value: 4 }, raOnly: false, settle: { kind: 'guided', ...SETTLE } })
		expect(dithered).toMatchObject({ ok: true })
		if (dithered.ok && dithered.value.kind === 'guider') expect(Math.hypot(...dithered.value.lockShift)).toBeGreaterThan(1)
		const corrections = ofType('guideStep').slice(before)
		expect(corrections.some((step) => step.ra.duration > 0 || step.dec.duration > 0)).toBeTrue()

		// A corrections pause keeps exposing and issues no pulse.
		expect(await session.pause(coordinator, 'corrections')).toEqual(successfulOperationResult(undefined))
		const pausedAt = frames
		const pulses = ofType('guideStep').length
		await waitUntil(() => frames >= pausedAt + 2, 10000, 10)
		expect(
			ofType('guideStep')
				.slice(pulses)
				.every((step) => step.ra.duration === 0 && step.dec.duration === 0),
		).toBeTrue()
		expect(session.snapshot()).toMatchObject({ state: 'paused', guideOutputHeld: true, pulsesAdmitted: false })
		expect(await session.resume(coordinator, SETTLE)).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot()).toMatchObject({ state: 'guiding', pulsesAdmitted: true })

		// Stopping guiding frees the mount and keeps looping, so the mount can slew under the same session.
		expect(await session.stopGuiding(coordinator)).toEqual(successfulOperationResult(undefined))
		expect(guideOutputCommander.dispatchedPulseWindow(mount)).toBeUndefined()
		expect(arbiter.ownersOf(resourceKey(mount))).toEqual([])
		expect(session.operationId()).toBe(root)
		const slewed = await mountCommander.goTo(coordinator, mount, { type: 'JNOW', JNOW: { x: mount.equatorialCoordinate.rightAscension, y: mount.equatorialCoordinate.declination + arcmin(1) } })
		expect(slewed).toMatchObject({ ok: true })
		// Guiding starts again on a star of the new field with the solved calibration. The old target is cleared, since the
		// slew moved the field out of its search window, and an exposure that overlapped the slew is trailed and may offer
		// no star, so the selection is retried on the next frames, as a user would.
		expect(session.clearTarget()).toEqual(successfulOperationResult(undefined))
		let selected = false

		for (let attempt = 0; attempt < 8 && !selected; attempt++) {
			const looping = frames
			await waitUntil(() => frames > looping, 20000, 10)
			selected = session.selectTarget().ok
		}

		expect(selected).toBeTrue()
		expect(await session.startGuiding(coordinator, coordinator, { recalibrate: false, settle: SETTLE })).toEqual(successfulOperationResult(undefined))
		expect(ofType('calibrationCompleted')).toHaveLength(1)
		expect(session.operationId()).toBe(root)

		expect(await session.stop(coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.snapshot()).toMatchObject({ active: false, lost: false, guideOutputHeld: false })
		expect(guideOutputCommander.dispatchedPulseWindow(mount)).toBeUndefined()
		expect(session.interruptions(0, Number.MAX_SAFE_INTEGER).interruptions).toEqual([])

		expect(await capture.result).toMatchObject({ ok: true })
		expect(arbiter.ownersOf(resourceKey(guideCamera))).toEqual([])
		expect(arbiter.ownersOf(resourceKey(rig.main()))).toEqual([])
		expect(arbiter.ownersOf(resourceKey(mount))).toEqual([])
	}, 180000)
})
