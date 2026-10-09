import type { Camera } from '../indi/device'
import type { PropertyState } from '../indi/types'
import { type CameraCaptureEvent, type CameraCaptureState, DEFAULT_CAMERA_CAPTURE_EVENT } from './camera.capture.types'

// Presentation state of one camera driven by a feature: the mutable capture snapshot, its frame and aggregate
// progress arithmetic, and the translation of INDI exposure states into capture states. Every time is in
// microseconds. Each emission hands the listener a fresh structured clone, so listeners may keep it.

// Receives presentation snapshots and, with a processed frame, the path that frame is published under.
export type CameraCaptureListener = (event: CameraCaptureEvent, path?: string) => void

// How one exposure property update was classified. The reporter owns the presentation side of the update and
// hands the classification back, so the caller drives its own control flow from the same reading instead of
// interpreting the property state a second time.
// - ignored: the update belongs to no open generation, or carries no terminal or Busy state.
// - started: the first Busy of the open generation.
// - exposing: a later Busy of the open generation.
// - finished, alert, idle: the exposure ended Ok, Alert or Idle and the generation closed.
export type CameraExposureTransition = 'ignored' | 'started' | 'exposing' | 'finished' | 'alert' | 'idle'

// Identity and shape of the capture a reporter publishes.
export interface CameraCaptureReporterOptions {
	// Top-level operation owning the camera while it exposes.
	readonly operation: string
	// Camera whose exposure property, in seconds remaining, feeds the progress.
	readonly camera: Camera
	// Receives every emitted snapshot, and the path of a processed frame.
	readonly listener: CameraCaptureListener
	// Whether the capture runs indefinitely, which leaves aggregate progress undefined.
	readonly loop: boolean
	// Frames the capture intends to produce; Number.MAX_SAFE_INTEGER for a loop.
	readonly count: number
	// Requested exposure of one frame, in microseconds.
	readonly frameExposureTime: number
	// Aggregate exposure plus inter-frame delay of the whole capture, in microseconds. Ignored for a loop.
	readonly totalExposureTime?: number
	// Whether the exposure becoming Busy opens a frame generation on its own. A feature that does not dispatch
	// the exposure itself, such as a guider driving its camera through the guide loop, has no other moment at
	// which to open one.
	readonly autoFrame?: boolean
}

// Presentation state of one camera driven by a feature.
//
// It owns no device, no lease, and no rendezvous. Everything that decides what the camera does next stays with
// the feature, which is what lets a capture session and a guide loop publish the same events while remaining
// unrelated pieces of orchestration.
export class CameraCaptureReporter {
	// Mutable presentation snapshot; every emission clones it so listeners cannot retain a live reference.
	readonly #event = structuredClone(DEFAULT_CAMERA_CAPTURE_EVENT)
	// Camera read for the remaining exposure reported by the driver.
	readonly #camera: Camera
	// Receives every emitted snapshot.
	readonly #listener: CameraCaptureListener
	// Whether a Busy exposure with no open generation opens one instead of being ignored.
	readonly #autoFrame: boolean
	// Aggregate exposure progress in microseconds as [remaining, elapsed].
	readonly #totalExposureProgress = [0, 0]
	// Whether a frame generation is open and still accepts exposure updates.
	#frameOpen = false
	// Whether the open generation has been physically observed as Busy at least once.
	#exposing = false

	// Creates a reporter over one camera and the listener of whoever is driving it. Emits nothing until the
	// first frame or state change; the session id is a fresh UUIDv7.
	constructor(options: CameraCaptureReporterOptions) {
		this.#camera = options.camera
		this.#listener = options.listener
		this.#autoFrame = options.autoFrame === true
		this.#event.operation = options.operation
		this.#event.session = Bun.randomUUIDv7()
		this.#event.camera = options.camera.id
		this.#event.loop = options.loop
		this.#event.count = options.count
		this.#event.remainingCount = options.count
		this.#event.frameExposureTime = options.frameExposureTime
		this.#event.totalExposureTime = options.loop ? 0 : (options.totalExposureTime ?? 0)
		this.#event.totalProgress.remainingTime = this.#event.totalExposureTime
		this.#totalExposureProgress[0] = this.#event.totalExposureTime
	}

	// Immutable identifier of the publishing session.
	get session() {
		return this.#event.session
	}

	// Frame generation currently open, or the last one when none is.
	get generation() {
		return this.#event.generation
	}

	// Frames still to be produced.
	get remainingCount() {
		return this.#event.remainingCount
	}

	// Requested exposure of the current frame, in microseconds.
	get frameExposureTime() {
		return this.#event.frameExposureTime
	}

	// Opens the next frame generation, resets frame progress, and emits its exposureStarted snapshot. The
	// exposure time, in microseconds, overrides the requested one for this frame onwards, which is how a loop
	// whose exposure was changed meanwhile reports the frame actually being taken. Returns the new generation.
	beginFrame(frameExposureTime = this.#event.frameExposureTime) {
		this.#event.frameExposureTime = frameExposureTime
		this.#event.generation++
		this.#event.state = 'exposureStarted'
		this.#event.elapsedCount++
		this.#event.remainingCount--
		this.#event.frameProgress.remainingTime = frameExposureTime
		this.#event.frameProgress.elapsedTime = 0
		this.#event.frameProgress.progress = 0
		this.#frameOpen = true
		this.#exposing = false
		this.#emit()
		return this.#event.generation
	}

	// Applies one exposure property update to the open generation and classifies it.
	//
	// A terminal state closes the generation, so a late update belonging to it cannot advance progress
	// afterwards. Only Busy and Ok publish: the remaining states are failures whose presentation belongs to the
	// feature that has to decide what they mean.
	applyExposureUpdate(state?: PropertyState): CameraExposureTransition {
		if (state === 'Busy') {
			const remainingTime = this.#camera.exposure.value * 1000000

			if (!this.#frameOpen) {
				if (!this.#autoFrame) return 'ignored'
				// The driver reports what is left of the exposure it accepted, and on the first update that is still
				// the whole of it, which is the only measure of a frame nobody here dispatched.
				this.beginFrame(remainingTime > 0 ? remainingTime : this.#event.frameExposureTime)
			}

			const started = !this.#exposing
			this.#exposing = true
			this.#event.state = 'exposing'
			this.#updateProgress(remainingTime, Math.max(0, this.#event.frameExposureTime - remainingTime))
			this.#emit()
			return started ? 'started' : 'exposing'
		}

		if (!this.#frameOpen) return 'ignored'

		if (state === 'Ok') {
			this.#closeFrame()
			this.#event.state = 'exposureFinished'
			this.#updateProgress(0, this.#event.frameExposureTime)
			this.#emit()
			return 'finished'
		}

		if (state === 'Alert') {
			this.#closeFrame()
			return 'alert'
		}

		if (state === 'Idle') {
			this.#closeFrame()
			return 'idle'
		}

		return 'ignored'
	}

	// Applies and emits a presentation state that no exposure update produces, such as dithering or settling.
	setState(state: CameraCaptureState) {
		this.#event.state = state
		this.#emit()
	}

	// Publishes inter-frame delay progress. Every time is in microseconds; `waitingTime` is the whole delay.
	waiting(remainingTime: number, elapsedTime: number, waitingTime: number) {
		this.#event.state = 'waiting'
		this.#updateTotalProgress(elapsedTime)
		this.#event.frameProgress.remainingTime = remainingTime
		this.#event.frameProgress.elapsedTime = elapsedTime
		this.#event.frameProgress.progress = waitingTime <= 0 ? 0 : Math.max(0, (elapsedTime / waitingTime) * 100)
		this.#emit()
	}

	// Advances aggregate progress past one finished frame and hands its path to the listener.
	completeFrame(path: string) {
		this.#advanceTotal(this.#event.frameExposureTime)
		this.#listener(structuredClone(this.#event), path)
	}

	// Advances aggregate progress past one finished inter-frame delay, in microseconds, without emitting.
	completeDelay(waitingTime: number) {
		this.#advanceTotal(waitingTime)
	}

	// Emits the terminal presentation, preceded by an error snapshot when the capture did not run to its end.
	terminal(stopped: boolean) {
		this.#closeFrame()

		if (stopped) {
			this.#event.state = 'error'
			this.#emit()
		}

		this.#event.state = 'idle'
		this.#event.stopped = stopped
		this.#emit()
	}

	// Stops the open generation from accepting further exposure updates.
	#closeFrame() {
		this.#frameOpen = false
		this.#exposing = false
	}

	// Moves aggregate progress forward by one finished exposure or delay, in microseconds.
	#advanceTotal(elapsedTime: number) {
		this.#totalExposureProgress[0] -= elapsedTime
		this.#totalExposureProgress[1] += elapsedTime
	}

	// Updates frame and total progress using microseconds.
	#updateProgress(remainingTime: number, elapsedTime: number) {
		this.#updateTotalProgress(elapsedTime)
		this.#event.frameProgress.remainingTime = remainingTime
		this.#event.frameProgress.elapsedTime = elapsedTime
		this.#event.frameProgress.progress = this.#event.frameExposureTime <= 0 ? 0 : Math.max(0, (1 - remainingTime / this.#event.frameExposureTime) * 100)
	}

	// Advances aggregate capture progress within the current exposure or delay, in microseconds.
	#updateTotalProgress(elapsedTime: number) {
		if (!this.#event.loop) {
			this.#event.totalProgress.remainingTime = Math.max(0, this.#totalExposureProgress[0] - elapsedTime)
			this.#event.totalProgress.progress = this.#event.totalExposureTime <= 0 ? 0 : Math.max(0, (1 - this.#event.totalProgress.remainingTime / this.#event.totalExposureTime) * 100)
		}
		this.#event.totalProgress.elapsedTime = this.#totalExposureProgress[1] + elapsedTime
	}

	// Emits a cloned presentation snapshot so listeners cannot mutate the reporter state.
	#emit() {
		this.#listener(structuredClone(this.#event))
	}
}
