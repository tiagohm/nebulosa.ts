import { describe, expect, test } from 'bun:test'
import type { MountCommander, MountMoveDirection } from '../../../src/devices/commanders/mount'
import type { Camera, Mount } from '../../../src/devices/indi/device'
import { failedOperationResult, OperationCoordinator, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { darvExposureTime } from '../../../src/observation/alignment/polaralignment.darv'
import { type DarvRunEvent, type DarvRunOptions, type DarvRunServices, runDarv } from '../../../src/observation/alignment/polaralignment.darv.runner'
import type { CameraCapturer, CameraCaptureResult } from '../../../src/observation/capture/capture'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'

// DARV runner over a fake mount, a fake capturer and a clock whose waits complete at once, so the
// order of the commands and the measured timing are deterministic.

const OPTIONS: DarvRunOptions = { direction: 'WEST', slewRate: 'GUIDE', legDuration: 60, capture: { x: 0, y: 0, width: 64, height: 64, subframe: false, binX: 1, binY: 1, frameFormat: 'MONO', gain: 0, offset: 0, compressed: false } }

class InstantClock {
	now = 1000
	onDelay?: (ms: number) => void

	readonly wallNow = () => this.now
	readonly monotonicNow = () => this.now
	readonly delay = (ms: number, signal: AbortSignal): Promise<OperationResult<void>> => {
		this.onDelay?.(ms)
		if (signal.aborted) return Promise.resolve(failedOperationResult('aborted'))
		this.now += ms
		return Promise.resolve(successfulOperationResult(undefined))
	}
}

class FakeRig {
	readonly clock = new InstantClock()
	readonly motions: { direction: MountMoveDirection; seconds: number }[] = []
	readonly requests: CameraCaptureStart[] = []
	readonly events: DarvRunEvent[] = []
	readonly mount = { name: 'Fake Mount', connected: true, mountType: 'EQ_GEM', canMove: true, canMoveWE: true, canAbort: true, parked: false, parking: false, tracking: true, trackModes: ['SIDEREAL'], trackMode: 'SIDEREAL', slewRates: [{ name: 'GUIDE', label: 'Guide' }], slewRate: 'MAX' } as unknown as Mount
	readonly camera = { name: 'Fake Camera', connected: true } as Camera
	ignoresSlewRate = false
	// Milliseconds the mount takes to stop, by motion index.
	stopTime: number[] = []
	cancelled = 0
	open = false

	readonly commander = {
		setSlewRate: (_scope: OperationScope, mount: Mount, rate: string) => {
			if (this.ignoresSlewRate) return Promise.resolve(failedOperationResult('timeout'))
			Object.assign(mount, { slewRate: rate })
			return Promise.resolve(successfulOperationResult(undefined))
		},
		startManualMove: (_scope: OperationScope, _mount: Mount, direction: MountMoveDirection) => {
			const startedAt = this.clock.now
			const index = this.motions.length
			const stop = () => {
				this.motions.push({ direction, seconds: (this.clock.now - startedAt) / 1000 })
				this.clock.now += this.stopTime[index] ?? 0
				return Promise.resolve(successfulOperationResult(undefined))
			}
			return Promise.resolve(successfulOperationResult({ id: 'move', directions: () => [direction], move: () => Promise.resolve(successfulOperationResult(undefined)), stop }))
		},
	} as unknown as MountCommander

	readonly capturer = {
		start: (_scope: OperationScope, _camera: Camera, request: CameraCaptureStart) => captureHandle(this, request),
	} as unknown as CameraCapturer

	services(): DarvRunServices {
		return { mountCommander: this.commander, cameraCapturer: this.capturer, clock: this.clock, framePath: '/tmp/darv.fit', listener: (event) => this.events.push(event) }
	}

	run(options: DarvRunOptions = OPTIONS, scope: OperationScope = coordinator()) {
		return runDarv(scope, this.mount, this.camera, options, this.services())
	}
}

// Capture handle whose exposure ends, when awaited, at the requested time after it started.
function captureHandle(rig: FakeRig, request: CameraCaptureStart) {
	rig.requests.push(request)
	rig.open = true
	const startedAt = rig.clock.now
	let aborted = false

	return {
		id: 'capture',
		started: Promise.resolve(successfulOperationResult(undefined)),
		get result(): Promise<OperationResult<CameraCaptureResult>> {
			rig.open = false
			if (aborted) return Promise.resolve(failedOperationResult('aborted'))
			const finishedAt = startedAt + request.exposureTime * 1000
			rig.clock.now = Math.max(rig.clock.now, finishedAt)
			return Promise.resolve(
				successfulOperationResult({
					frames: [
						{
							operation: 'op',
							session: 's',
							generation: 1,
							camera: 'cam',
							path: request.outputName!,
							exposureDispatchedAt: startedAt,
							exposureDispatchedMonotonic: startedAt,
							exposureStartedAt: startedAt,
							exposureStartedMonotonic: startedAt,
							exposureFinishedAt: finishedAt,
							exposureFinishedMonotonic: finishedAt,
						},
					],
					frameCount: 1,
				}),
			)
		},
		cancel: () => {
			aborted = true
			rig.cancelled++
			return Promise.resolve()
		},
		stop: () => {},
	}
}

function coordinator() {
	return new OperationCoordinator(new ResourceArbiter())
}

describe('DARV measurement', () => {
	test.each(['WEST', 'EAST'] as const)('exposes across an outbound %s motion and the return', async (direction) => {
		const rig = new FakeRig()
		const result = await rig.run({ ...OPTIONS, direction })

		expect(result.ok).toBeTrue()
		if (!result.ok) return
		const reverse = direction === 'WEST' ? 'EAST' : 'WEST'
		expect(rig.motions).toEqual([
			{ direction, seconds: 60 },
			{ direction: reverse, seconds: 60 },
		])
		expect(rig.requests[0]).toMatchObject({ exposureTime: 129, exposureTimeUnit: 'second', frameType: 'LIGHT', count: 1, outputName: 'darv.fit', mount: 'Fake Mount' })
		expect(result.value.direction).toBe(direction)
		expect(result.value.timing).toEqual({ exposure: 129, leading: 3, outbound: 60, turnaround: 0, inbound: 60, trailing: 6 })
		expect(rig.events.map((e) => (e.type === 'phase' ? e.phase : e.type))).toEqual(['slewRate', 'exposing', 'outbound', 'reversing', 'inbound', 'finishing'])
		expect(rig.events[0]).toEqual({ type: 'slewRate', previous: 'MAX', applied: 'GUIDE' })
		expect(rig.cancelled).toBe(0)
	})

	test('measures the turnaround and the stop of the return motion', async () => {
		const rig = new FakeRig()
		rig.stopTime = [1500, 2000]
		const result = await rig.run()

		expect(result.ok).toBeTrue()
		if (!result.ok) return
		const { timing } = result.value
		expect(timing.turnaround).toBe(1.5)
		expect(timing.trailing).toBe(4.5)
		expect(timing.leading + timing.outbound + timing.turnaround + timing.inbound + timing.trailing).toBe(darvExposureTime(60))
	})

	test('fails when the mount may still move after the shutter closed', async () => {
		const rig = new FakeRig()
		rig.stopTime = [0, 7000]
		expect(await rig.run()).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('before the mount stopped') })
	})

	test('fails before exposing when the slew rate is not confirmed', async () => {
		const rig = new FakeRig()
		rig.ignoresSlewRate = true
		expect(await rig.run()).toMatchObject({ ok: false, reason: 'timeout' })
		expect(rig.requests).toHaveLength(0)
		expect(rig.motions).toHaveLength(0)
	})

	test('refuses a mount that is not tracking and a disconnected camera', async () => {
		const rig = new FakeRig()
		Object.assign(rig.mount, { tracking: false })
		expect(await rig.run()).toMatchObject({ ok: false, reason: 'unexpectedState' })
		Object.assign(rig.mount, { tracking: true })
		Object.assign(rig.camera, { connected: false })
		expect(await rig.run()).toMatchObject({ ok: false, reason: 'disconnected' })
		expect(rig.requests).toHaveLength(0)
	})

	test.each([3000, 60000])('cancelling during a wait of %d ms stops the mount and aborts the exposure', async (wait) => {
		const rig = new FakeRig()
		const operations = coordinator()
		const handle = operations.start('session', [], (context) => runDarv(context, rig.mount, rig.camera, OPTIONS, rig.services()))
		rig.clock.onDelay = (ms) => {
			if (ms === wait) void handle.cancel('aborted')
		}

		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(rig.motions).toHaveLength(wait === 60000 ? 1 : 0)
		expect(rig.cancelled).toBe(1)
		expect(rig.open).toBeFalse()
	})

	test('a mount that disconnects during the outbound motion aborts the exposure', async () => {
		const rig = new FakeRig()
		rig.clock.onDelay = (ms) => {
			if (ms === 60000) Object.assign(rig.mount, { connected: false })
		}

		expect(await rig.run()).toMatchObject({ ok: false, reason: 'disconnected' })
		expect(rig.motions).toHaveLength(1)
		expect(rig.cancelled).toBe(1)
	})
})
