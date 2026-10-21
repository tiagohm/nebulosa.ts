import { basename, dirname } from 'path'
import { failedOperationResult, successfulOperationResult } from '../../devices/orchestration/operation'
import { type ResourceArbiter, resourceKey } from '../../devices/orchestration/resource'
import type { CameraCapturer } from '../capture/capture'
import { DEFAULT_CAMERA_CAPTURE_START, type CameraCaptureStart } from '../capture/types'
import type { SequencerCaptureStep, SequencerTask, SequencerTaskView } from './runner'
import { DEFAULT_SEQUENCER_CAMERA_RECOVERY, type SequencerCameraRecoveryConfiguration, type SequencerDevices, type SequencerFrameSlot } from './sequencer'
import { shouldHoldSequencer } from './state'
import type { SequencerFrameDestination, SequencerStorage } from './storage'

// Primary capture of the Sequencer over the shared `CameraCapturer`: exactly one exposure per call, written durably
// to the temporary of the prepared destination, and the pre-capture wait for a camera quarantined by a late frame
// payload. The capturer keeps owning the camera lease, the exposure/BLOB rendezvous, the timeout, the cancellation,
// the quiescence and the quarantine; nothing of that is reimplemented here.
//
// Every primary capture is commanded as one FITS frame (`exposureMode: 'single'`, `count: 1`, `delay: 0`,
// `transferFormat: 'FITS'`), auto-saved under the hidden temporary name in the directory of its final and published
// under the final path, with the devices of the session snooped into its headers. Its hooks belong to that capture
// only: the session clock stamps the exposure instants (wall `...At` in Unix ms, monotonic `...Monotonic` in ms),
// the durable writer of the storage writes the frame (so the result arrives only after the fsync), and the
// synchronous `beforeExposure` of the session vetoes the dispatch. Configured durations are seconds and become
// milliseconds only at the clock; every wait is `clock.delay` in the monotonic domain.

// Services of the primary capture.
export interface SequencerCaptureServices {
	// Capturer shared with every other camera feature of the process; the session passes its hooks per capture.
	readonly cameraCapturer: CameraCapturer
	// Storage of the session, whose durable writer writes every primary frame.
	readonly storage: Pick<SequencerStorage, 'writeDurably'>
}

// Capture request of the attempt of `frame` into `destination`: the camera settings of the slot (inheritance already
// applied) with every operational field fixed by the Sequencer, the frame auto-saved as the hidden temporary in the
// directory of its final, published under the final path, and the mount, wheel, focuser and rotator of the session
// snooped by name. A fresh object; the capturer copies it again when it starts.
export function sequencerCaptureRequest(frame: SequencerFrameSlot, destination: SequencerFrameDestination, devices: SequencerDevices): CameraCaptureStart {
	const { exposureTime, exposureTimeUnit, frameType, x, y, width, height, subframe, binX, binY, frameFormat, gain, offset, compressed } = frame.capture
	const { mount, wheel, focuser, rotator } = devices

	return {
		...DEFAULT_CAMERA_CAPTURE_START,
		exposureTime,
		exposureTimeUnit,
		frameType,
		x,
		y,
		width,
		height,
		subframe,
		binX,
		binY,
		frameFormat,
		gain,
		offset,
		compressed,
		exposureMode: 'single',
		count: 1,
		delay: 0,
		transferFormat: 'FITS',
		autoSave: true,
		autoSubFolderMode: 'off',
		outputPath: dirname(destination.temporary),
		outputName: basename(destination.temporary),
		publishPath: destination.final,
		...(mount !== undefined && { mount: mount.name }),
		...(wheel !== undefined && { wheel: wheel.name }),
		...(focuser !== undefined && { focuser: focuser.name }),
		...(rotator !== undefined && { rotator: rotator.name }),
	}
}

// Capture step of the runner: one exposure of the slot of the context through the capturer, nested in the root of
// the step so cancelling the root cancels the capture and waits for its cleanup. The hooks of the capture are the
// session clock, the durable writer of the storage, `context.beforeExposure` as the synchronous veto right before the
// dispatch, and a listener that reports the dispatched exposure (`exposureStarted` of the capturer) to the session.
// Resolves the physical instants of the frame once it was written and fsynced, with the sensor temperature the camera
// reports then (absent without a thermometer or while it is not a finite number), or the failure of the capture (a
// refusal of `beforeExposure` included, which the runner tells apart). Never rejects.
export function captureFrameStep(services: SequencerCaptureServices): SequencerCaptureStep {
	const { cameraCapturer, storage } = services

	return async (context) => {
		const request = sequencerCaptureRequest(context.frame!, context.destination, context.devices)
		const handle = cameraCapturer.start(context.scope, context.devices.camera, request, {
			listener: (event) => {
				if (event.state === 'exposureStarted') context.exposureStarted()
			},
			beforeExposure: () => context.beforeExposure(),
			write: storage.writeDurably,
			clock: context.clock,
		})

		const result = await handle.result
		if (!result.ok) return result

		const { frames } = result.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `a single capture produced ${frames.length} frames`)

		const { exposureDispatchedAt, exposureDispatchedMonotonic, exposureStartedAt, exposureStartedMonotonic, exposureFinishedAt, exposureFinishedMonotonic } = frames[0]
		const sensorTemperature = sequencerSensorTemperature(context.devices.camera)

		return successfulOperationResult({
			...(exposureDispatchedAt !== undefined && { exposureDispatchedAt }),
			...(exposureDispatchedMonotonic !== undefined && { exposureDispatchedMonotonic }),
			exposureStartedAt,
			exposureStartedMonotonic,
			exposureFinishedAt,
			exposureFinishedMonotonic,
			...(sensorTemperature !== undefined && { sensorTemperature }),
		})
	}
}

// Sensor temperature of `camera`, in °C: undefined without a thermometer, while disconnected, or when it is not a finite
// number, so an unavailable reading never fires nor anchors a temperature trigger.
export function sequencerSensorTemperature(camera: Pick<SequencerDevices['camera'], 'connected' | 'hasThermometer' | 'temperature'>) {
	return camera.connected && camera.hasThermometer && Number.isFinite(camera.temperature) ? camera.temperature : undefined
}

// Whether the camera of a session is quarantined: a terminated exposure left a frame payload the capturer still
// waits to discard, so any capture would be refused as busy.
export function isSequencerCameraQuarantined(arbiter: ResourceArbiter, view: Pick<SequencerTaskView, 'devices'>) {
	return arbiter.snapshot(resourceKey(view.devices.camera)).causes.includes('quarantine')
}

// Pre-capture task `awaitCameraRecovery` (section 25.2), placed before any task that uses the camera and before the
// frame destination: while the camera is quarantined it polls the availability of its resource every
// `recovery.pollInterval` seconds with the session clock, and succeeds as soon as the quarantine ended. It never
// commands a device, never touches the journal or the checkpoint and never consumes an attempt or a capture failure:
// a wait is not a failure. Only the 'quarantine' cause is awaited; a lifecycle unavailability (disconnection) is left
// to the device lifecycle and to the capture policy. At `recovery.timeout` seconds (monotonic) it fails once with
// 'timeout', and `recovery.onTimeout` applies; after a 'pause' the resumed pre-capture waits again with a new
// deadline. A stop or a protection cancels the wait through its root; a pending pause ends it at the next poll so the
// pre-capture holds and waits again after the resume.
export function awaitCameraRecoveryTask(arbiter: ResourceArbiter, recovery: SequencerCameraRecoveryConfiguration): SequencerTask {
	const timeout = (recovery.timeout ?? DEFAULT_SEQUENCER_CAMERA_RECOVERY.timeout) * 1000
	const pollInterval = (recovery.pollInterval ?? DEFAULT_SEQUENCER_CAMERA_RECOVERY.pollInterval) * 1000

	return {
		id: 'awaitCameraRecovery',
		shouldRun: (view) => view.frame !== undefined && isSequencerCameraQuarantined(arbiter, view),
		run: async (context) => {
			const { clock, signal } = context
			const deadline = clock.monotonicNow() + timeout

			while (isSequencerCameraQuarantined(arbiter, context)) {
				if (shouldHoldSequencer(context.state)) return { ok: true }

				const remaining = deadline - clock.monotonicNow()
				if (!(remaining > 0)) return { ok: false, failure: { kind: 'operation', reason: 'timeout', detail: `${context.devices.camera.name} is still quarantined after ${timeout / 1000} s` } }

				const waited = await clock.delay(Math.min(pollInterval, remaining), signal)
				if (!waited.ok) return { ok: false, failure: { kind: 'operation', reason: waited.reason } }
			}

			return { ok: true }
		},
		policy: { onFailure: recovery.onTimeout },
	}
}
