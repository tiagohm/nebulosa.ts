import type { Camera } from '../indi/device'
import type { PropertyState } from '../indi/types'
import { type CameraCaptureEvent, type CameraCaptureState, DEFAULT_CAMERA_CAPTURE_EVENT } from './camera.capture.types'

// Presentation state of one camera driven by a feature: the mutable capture snapshot, its frame and aggregate
// progress arithmetic, and the translation of INDI exposure states into capture states. Every time is in
// microseconds. Each emission hands the listener a fresh structured clone, so listeners may keep it. A frame a
// feature dispatches itself is prepared before the exposure command and committed only after the command was
// accepted, so a refused or failed dispatch never publishes a generation.

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
	// Whether the open generation is prepared but not committed: updates are classified, not published.
	#prepared = false
	// Exposure of the prepared generation, in microseconds, applied when it is committed.
	#preparedExposureTime = 0
	// Last presentation a prepared generation would have published, replayed when it is committed.
	#retained?: 'exposing' | 'exposureFinished'
	// Remaining exposure of the last retained Busy, in microseconds.
	#retainedRemainingTime = 0

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

	// Last committed frame generation, which is the open one once committed. A prepared generation is not
	// counted until it is committed.
	get generation() {
		return this.#event.generation
	}

	// Frames still to be produced, counting only committed generations.
	get remainingCount() {
		return this.#event.remainingCount
	}

	// Requested exposure of the current frame, in microseconds.
	get frameExposureTime() {
		return this.#event.frameExposureTime
	}

	// Opens and commits the next frame generation at once, emitting its exposureStarted snapshot. Used for a
	// frame whose exposure is already known to exist, such as the first Busy of an exposure nobody here
	// dispatched. The exposure time, in microseconds, overrides the requested one for this frame onwards, which is
	// how a loop whose exposure was changed meanwhile reports the frame actually being taken. Returns the new
	// generation.
	beginFrame(frameExposureTime = this.#event.frameExposureTime) {
		this.prepareFrame(frameExposureTime)
		return this.commitFrame()
	}

	// Opens the next generation for routing only, before its exposure is dispatched. Exposure updates are
	// classified against it from now on, so a Busy delivered synchronously by the dispatch is seen, but nothing
	// is emitted and the snapshot, generation and counters stay those of the last committed generation until
	// `commitFrame`. The exposure time, in microseconds, is applied on commit. Replaces a prepared generation that
	// was never committed.
	prepareFrame(frameExposureTime = this.#event.frameExposureTime) {
		this.#preparedExposureTime = frameExposureTime
		this.#prepared = true
		this.#retained = undefined
		this.#frameOpen = true
		this.#exposing = false
	}

	// Confirms the prepared generation once its exposure exists: advances the generation and counters, resets
	// frame progress, and emits exposureStarted followed by the last presentation an update retained meanwhile
	// (exposing, or exposureFinished when Ok already arrived). exposureStarted therefore precedes every other
	// snapshot of the generation. Returns the committed generation, or the current one when nothing was prepared.
	commitFrame() {
		if (!this.#prepared) return this.#event.generation

		this.#prepared = false
		const frameExposureTime = this.#preparedExposureTime
		const retained = this.#retained
		this.#retained = undefined

		this.#event.frameExposureTime = frameExposureTime
		this.#event.generation++
		this.#event.state = 'exposureStarted'
		this.#event.elapsedCount++
		this.#event.remainingCount--
		this.#event.frameProgress.remainingTime = frameExposureTime
		this.#event.frameProgress.elapsedTime = 0
		this.#event.frameProgress.progress = 0
		this.#emit()

		if (retained === 'exposing') {
			this.#publishExposing(this.#retainedRemainingTime)
		} else if (retained === 'exposureFinished') {
			this.#publishFinished()
		}

		return this.#event.generation
	}

	// Closes a prepared generation without emitting anything, leaving the snapshot, generation and counters as
	// they were, so the next prepared generation reuses the number. Only valid while no physical update of the
	// prepared generation was observed; a later update is ignored. Does nothing without a prepared generation.
	discardFrame() {
		if (!this.#prepared) return
		this.#prepared = false
		this.#retained = undefined
		this.#closeFrame()
	}

	// Applies one exposure property update to the open generation and classifies it.
	//
	// A terminal state closes the generation, so a late update belonging to it cannot advance progress
	// afterwards. Only Busy and Ok publish: the remaining states are failures whose presentation belongs to the
	// feature that has to decide what they mean. A prepared generation is classified the same way, but its
	// presentation is retained until it is committed.
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

			if (this.#prepared) {
				this.#retained = 'exposing'
				this.#retainedRemainingTime = remainingTime
			} else {
				this.#publishExposing(remainingTime)
			}

			return started ? 'started' : 'exposing'
		}

		if (!this.#frameOpen) return 'ignored'

		if (state === 'Ok') {
			this.#closeFrame()
			if (this.#prepared) this.#retained = 'exposureFinished'
			else this.#publishFinished()
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

	// Applies and emits a presentation state that no exposure update produces, such as pausing or paused.
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

	// Emits the terminal presentation, preceded by an error snapshot when the capture did not run to its end. A
	// prepared generation that was never committed is dropped without being published.
	terminal(stopped: boolean) {
		this.#prepared = false
		this.#retained = undefined
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

	// Publishes the exposing state of the open generation with `remainingTime` microseconds left.
	#publishExposing(remainingTime: number) {
		this.#event.state = 'exposing'
		this.#updateProgress(remainingTime, Math.max(0, this.#event.frameExposureTime - remainingTime))
		this.#emit()
	}

	// Publishes the completed exposure of the generation that just closed.
	#publishFinished() {
		this.#event.state = 'exposureFinished'
		this.#updateProgress(0, this.#event.frameExposureTime)
		this.#emit()
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
