import { constants } from 'fs'
import { copyFile, link, mkdir, rm } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { formatTemporal, temporalAdd, temporalSubtract } from '../../astronomy/time/temporal'
import { errorMessage } from '../../core/util'
import { base64Source, bufferSource } from '../../io/io'
import { directoryExists, isPathSegment } from '../../io/path'
import { type Camera, CLIENT, type Focuser, type Mount, type Rotator, type Wheel } from '../indi/device'
import type { CameraManager } from '../indi/manager/camera'
import type { DeviceHandler, DeviceProvider } from '../indi/manager/device'
import type { BlobEncoding, PropertyState } from '../indi/types'
import { type FailedOperationResult, failedOperationResult, type OperationContext, type OperationFailureReason, type OperationResult, type OperationScope, successfulOperationResult } from '../orchestration/operation'
import { abortableDelay, abortReason } from '../orchestration/operation.wait'
import { type ResourceArbiter, resourceKey } from '../orchestration/resource'
import { type CameraCaptureListener, CameraCaptureReporter } from './camera.capture.reporter'
import { type CameraAutoSubFolderMode, type CameraCaptureClock, type CameraCaptureStart, type CameraFrameEvent, DEFAULT_CAMERA_CAPTURE_EVENT, exposureTimeInMicroseconds, exposureTimeInSeconds, SYSTEM_CAMERA_CAPTURE_CLOCK } from './camera.capture.types'

// Operation-backed camera capture over an INDI CameraManager. A capture acquires the camera through an
// operation scope, configures each exposure only after its frame path is known, lets the caller veto it
// synchronously right before dispatch, waits for both the exposure completion and the BLOB of the same
// generation, decodes, publishes and optionally writes the frame, and quiesces the camera before the lease is
// released. A BLOB left behind by a terminated exposure quarantines the camera until it is observed, because
// BLOBs carry no operation id and the next capture would read it. A capture ends at its last frame, when
// stopped (the exposure in flight finishes and no other one starts), or when cancelled (the exposure in flight
// is aborted). By default a saved frame is written to a temporary file and only then given its name, which is
// never an existing file. Exposure progress is in microseconds, timeouts in milliseconds, the inter-frame delay
// in seconds, frame instants in milliseconds of the capture clock, and frame paths are absolute or relative to
// the configured captures directory.

// Minimum inter-frame delay that publishes waiting progress, in microseconds. Shorter delays are waited silently.
const MINIMUM_WAITING_TIME = 1000000

// Interval between two waiting progress updates, in microseconds.
const WAITING_PROGRESS_STEP = 250000

// Default time allowed for an exposure and its BLOB to finish beyond the requested exposure, in milliseconds.
const DEFAULT_FRAME_GRACE_TIME = 30000

// Default time allowed for a canceled exposure to become physically idle, in milliseconds.
const DEFAULT_QUIESCE_TIMEOUT = 5000

// Default window retained after quiescence before a missing BLOB quarantines the camera, in milliseconds.
const DEFAULT_LATE_BLOB_DRAIN_TIME = 100

// Result of a camera capture after every requested frame has been processed.
export interface CameraCaptureResult {
	// Events of the processed frames, in capture order.
	readonly frames: readonly CameraFrameEvent[]
	// Number of fully processed frames.
	readonly frameCount: number
}

// Operation-backed camera capture with an exposure-start milestone.
export interface CameraCaptureHandle {
	// Stable operation and session identifier.
	readonly id: string
	// Resolves after the first exposure is physically observed as Busy, or with the start failure; never rejects.
	readonly started: Promise<OperationResult<void>>
	// Resolves after terminal cleanup and camera lease release; never rejects.
	readonly result: Promise<OperationResult<CameraCaptureResult>>
	// Cancels this exact capture and waits for quiescence and lease release. The exposure in flight is aborted
	// and its frame is lost; the result fails as aborted.
	readonly cancel: () => Promise<void>
	// Stops this capture after the exposure in flight: that frame is still processed and written, a running
	// inter-frame delay ends at once, and no further exposure starts. The result succeeds with the
	// frames processed so far. Idempotent, and a no-op once the capture ended; `result` reports the end.
	readonly stop: VoidFunction
}

// Device lookups used to resolve the devices a request names for the driver to stamp into frame headers.
// Each lookup runs on the INDI client of the camera; a name that resolves nothing is snooped as empty.
export interface CameraCaptureDevices {
	// Resolves `CameraCaptureStart.mount`.
	readonly mount?: DeviceProvider<Mount>
	// Resolves `CameraCaptureStart.focuser`.
	readonly focuser?: DeviceProvider<Focuser>
	// Resolves `CameraCaptureStart.wheel`.
	readonly wheel?: DeviceProvider<Wheel>
	// Resolves `CameraCaptureStart.rotator`.
	readonly rotator?: DeviceProvider<Rotator>
}

// Collaborators and physical timeouts of a capturer. Every duration is in milliseconds; a negative one is zero.
export interface CameraCapturerOptions {
	// Directory used for automatic frame paths: auto-saved frames without a usable `savePath`, and the path a
	// frame that is not saved is published under.
	readonly capturesDir: string
	// Receives every decoded frame under the path it is published at, before it is written. It must not keep
	// the buffer beyond what it owns: the buffer is the decoded payload, not a copy.
	readonly publish?: (frame: Buffer, path: string, camera: Camera) => void
	// Decodes a base64 transport payload into its binary frame; defaults to a streaming decoder.
	readonly decode?: (data: Buffer) => Promise<Buffer>
	// Persists an auto-saved frame and resolves only after the write completed; defaults to
	// `writeFrameExclusively`. The camera lease is retained until it settles, and a rejection fails the capture.
	// A capture can replace it with `CameraCaptureHooks.write`.
	readonly write?: CameraFrameWriter
	// Resolves the devices a request names for header snooping. Without a lookup, its device is not snooped.
	readonly devices?: CameraCaptureDevices
	// Time allowed after the requested exposure for the exposure completion and BLOB rendezvous. Default 30000.
	readonly frameGraceTime?: number
	// Maximum time to wait for a stopped exposure to become idle during cleanup. Default 5000.
	readonly quiesceTimeout?: number
	// Time retained after quiescence for an outstanding BLOB before the camera is quarantined. Default 100.
	readonly lateBlobDrainTime?: number
}

// Persists an auto-saved frame at `path` and resolves once its durability guarantee holds. `data` is the
// decoded payload, not a copy, and must not be retained beyond the call.
export type CameraFrameWriter = (path: string, data: Buffer) => Promise<unknown>

// Frame about to be dispatched, as shown to `CameraCaptureHooks.beforeExposure`.
export interface CameraExposureAttempt {
	// Path the frame will be written to, already resolved.
	readonly path: string
	// Generation the frame opens if it is dispatched; the first frame of a capture is 1.
	readonly generation: number
}

// Optional collaborators supplied per capture by whoever started it. They apply to that capture only: the next
// capture resolves its own.
export interface CameraCaptureHooks {
	// Receives the presentation events of the accepted session.
	readonly listener?: CameraCaptureListener
	// Receives the terminal events of a capture rejected before a session exists; defaults to listener.
	readonly rejectedListener?: CameraCaptureListener
	// Last decision before each exposure is dispatched, called synchronously after every camera configuration
	// command and immediately before the exposure command, with nothing awaited and no device commanded in
	// between. Returning a failure ends the capture with it without dispatching: no exposure is commanded, no
	// generation opens, no file is written and no BLOB is owed; the configuration already sent stays on the
	// camera, which is released. A hook that throws refuses the frame as `commandFailed`. It must not await,
	// command devices, or do I/O.
	readonly beforeExposure?: (attempt: CameraExposureAttempt) => FailedOperationResult | undefined
	// Writer of the auto-saved frames of this capture, replacing `CameraCapturerOptions.write`. The result of a
	// capture with `autoSave` is delivered only after it resolved, so the durability of the frame is whatever it
	// guarantees.
	readonly write?: CameraFrameWriter
	// Clock the frame instants are read from; `SYSTEM_CAMERA_CAPTURE_CLOCK` when absent.
	readonly clock?: CameraCaptureClock
	// Resolves the absolute path each auto-saved frame is written to, before its exposure is commanded, in
	// place of the automatic directory and timestamp name. It is not consulted when the request names its own
	// `outputPath` and `outputName`, nor for frames that are not saved. A path that already exists fails the
	// capture instead of being overwritten.
	readonly framePath?: (frame: CameraFramePathRequest) => string | Promise<string>
}

// Frame whose destination a `framePath` resolver is asked for.
export interface CameraFramePathRequest {
	// Generation the frame will have, starting at 1 for the first frame of the session.
	readonly generation: number
	// Unix time the exposure is about to be commanded at, in milliseconds.
	readonly time: number
	// Camera taking the frame.
	readonly camera: Camera
}

// Receives the device callbacks of a camera driven outside a capture session, such as the guide camera of a
// local guider, whose exposures are commanded by its own client rather than by a capture.
export interface CameraDeviceWatcher {
	// One camera property changed, carrying the INDI state that produced it.
	readonly updated: (camera: Camera, property: keyof Camera & string, state?: PropertyState) => void
}

// Availability transitions a session applies to the camera resource it owns.
interface CameraAvailability {
	// Blocks new acquisitions without releasing the current owner.
	readonly markUnavailable: VoidFunction
	// Blocks the camera until its outstanding BLOB is observed and discarded.
	readonly quarantine: VoidFunction
}

// Collaborators a session needs beyond its context, camera, and request.
interface CameraCaptureSessionContext {
	// Issues the physical camera commands.
	readonly cameraManager: CameraManager
	// Collaborators and physical timeouts of the capturer.
	readonly options: CameraCapturerOptions
	// Receives presentation events.
	readonly listener: CameraCaptureListener
	// Synchronous veto right before each exposure is dispatched.
	readonly beforeExposure?: (attempt: CameraExposureAttempt) => FailedOperationResult | undefined
	// Writer of auto-saved frames, resolved once for the whole capture.
	readonly write: CameraFrameWriter
	// Clock the frame instants are read from.
	readonly clock: CameraCaptureClock
	// Resolves the path of each auto-saved frame, when the caller supplied one.
	readonly framePath?: CameraCaptureHooks['framePath']
	// Settles the exposure-start milestone exactly once.
	readonly settleStarted: (result: OperationResult<void>) => void
	// Applies availability transitions to the owned camera.
	readonly availability: CameraAvailability
}

// Independent rendezvous for one exposure generation.
interface FrameAttempt {
	// Final path of the frame, resolved before the exposure was dispatched.
	readonly path: string
	// Terminal exposure state observed for this generation.
	readonly exposureCompleted: PromiseWithResolvers<PropertyState>
	// First BLOB observed for this generation.
	readonly blobReceived: PromiseWithResolvers<CameraBlob>
	// Raw BLOB retained until exposure completion allows processing.
	blob?: CameraBlob
	// Latest terminal exposure property state.
	exposureState?: PropertyState
	// Whether this attempt no longer accepts device callbacks.
	terminal: boolean
	// Whether the exposure exists: the command returned, even if Busy was never observed, or it threw after a
	// physical update of the exposure was observed.
	dispatched: boolean
	// Whether any exposure update of the prepared generation was observed, which is physical evidence that the
	// exposure exists even when the command throws.
	observed: boolean
	// Whether physical Busy was observed after command dispatch.
	started: boolean
	// Wall instant, in Unix milliseconds, read immediately before the exposure command.
	dispatchedAt?: number
	// Monotonic instant, in milliseconds of the capture clock, read immediately before the exposure command.
	dispatchedMonotonic?: number
	// Wall instant, in Unix milliseconds, of the first observed Busy; zero until then.
	startedAt: number
	// Monotonic instant, in milliseconds of the capture clock, of the first observed Busy; zero until then.
	startedMonotonic: number
	// Wall instant, in Unix milliseconds, of the observed Ok; zero until then.
	finishedAt: number
	// Monotonic instant, in milliseconds of the capture clock, of the observed Ok; zero until then.
	finishedMonotonic: number
}

// Raw camera payload and transport encoding captured by a FrameAttempt.
interface CameraBlob {
	// Driver-owned payload received for the current frame.
	readonly data: Buffer
	// Transport encoding applied to the payload.
	readonly encoding: BlobEncoding
}

// Starts camera captures and routes the camera device callbacks to the one session entitled to them.
//
// It registers itself as a handler of the camera manager on construction, so every camera update, removal
// and BLOB reaches it without forwarding. Dispose it only after the captures it started have settled.
export class CameraCapturer implements DeviceHandler<Camera>, Disposable {
	// Accepted session per physical camera key. Device callbacks carry no operation id, so this is what routes
	// an update or a BLOB to the one session entitled to it.
	readonly #sessions = new Map<string, CameraCaptureSession>()
	// Camera keys blocked until a stale BLOB is discarded or the transport resets.
	readonly #quarantined = new Set<string>()
	// Watchers of cameras driven outside a capture, per physical camera key.
	readonly #watchers = new Map<string, CameraDeviceWatcher>()

	// Creates a capturer over camera commands and resource availability, and registers it as a camera handler.
	constructor(
		readonly cameraManager: CameraManager,
		readonly arbiter: ResourceArbiter,
		readonly options: CameraCapturerOptions,
	) {
		cameraManager.addHandler(this)
	}

	// Stops observing the manager. A capture still running afterwards no longer sees device events and ends
	// only by its timeout or cancellation; running captures and cameras are left untouched. Quarantines are
	// released, since only this capturer could observe the stale BLOB or transport reset that ends them and the
	// camera would otherwise stay blocked until the process exits. Idempotent.
	dispose() {
		this.cameraManager.removeHandler(this)

		for (const key of this.#quarantined) this.arbiter.markAvailable(key, 'quarantine')
		this.#quarantined.clear()
	}

	// Same as dispose, so the capturer can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Starts one capture in the given scope, routing accepted-session events to its listener and reporting
	// pre-session rejection separately. The request is copied, so mutating it afterwards changes nothing. A
	// composite feature passes its own context so the capture nests inside the operation already owning the
	// camera; the coordinator starts a new operation tree. The hooks belong to this capture only: its writer is
	// `hooks.write`, else `options.write`, else `writeFrameExclusively`.
	start(scope: OperationScope, camera: Camera, request: CameraCaptureStart, { listener = () => {}, rejectedListener = listener, beforeExposure, write, clock = SYSTEM_CAMERA_CAPTURE_CLOCK, framePath }: CameraCaptureHooks = {}): CameraCaptureHandle {
		const key = resourceKey(camera)
		const started = Promise.withResolvers<OperationResult<void>>()
		let session: CameraCaptureSession | undefined
		// A stop can arrive before the coordinator built the session, which then starts already stopped.
		let stopRequested = false

		let startedSettled = false
		const settleStarted = (result: OperationResult<void>) => {
			if (startedSettled) return
			startedSettled = true
			started.resolve(result)
		}

		const frameWriter = write ?? this.options.write ?? writeFrameExclusively

		const operation = scope.start<CameraCaptureResult>('cameraCapture', [{ key, device: camera }], (context) => {
			const current = new CameraCaptureSession(context, camera, structuredClone(request), {
				cameraManager: this.cameraManager,
				options: this.options,
				listener,
				beforeExposure,
				write: frameWriter,
				clock,
				framePath,
				settleStarted,
				availability: {
					markUnavailable: () => this.arbiter.markUnavailable({ key, device: camera }),
					quarantine: () => this.#quarantine(camera, key),
				},
			})

			session = current
			this.#sessions.set(key, current)
			if (stopRequested) current.stop()

			context.onCleanup(async () => {
				await current.cleanup()
				if (this.#sessions.get(key) === current) this.#sessions.delete(key)
			})

			return current.run()
		})

		// The session records its own expected cleanup failures, which the coordinator cannot see.
		const result = operation.result.then((value): OperationResult<CameraCaptureResult> => session?.resultAfterCleanup(value) ?? value)

		void result.then((result) => {
			if (!startedSettled) settleStarted(result.ok ? failedOperationResult('unexpectedState', 'capture completed before exposure became busy') : result)

			if (session === undefined && !result.ok) {
				const event = structuredClone(DEFAULT_CAMERA_CAPTURE_EVENT)
				event.operation = operation.id
				event.session = Bun.randomUUIDv7()
				event.camera = camera.id
				event.state = 'error'
				rejectedListener(structuredClone(event))
				event.state = 'idle'
				event.stopped = true
				rejectedListener(event)
			}
		})

		return Object.freeze({
			id: operation.id,
			started: started.promise,
			result,
			cancel: () => operation.cancel('aborted'),
			stop: () => {
				stopRequested = true
				session?.stop()
			},
		})
	}

	// Registers a watcher for a camera nobody captures with, and returns its idempotent unregistration. One
	// watcher per camera: registering another replaces it.
	//
	// Device callbacks carry no operation id, so this stays the one place that routes them. A watcher is only fed
	// while no session owns the camera: an accepted capture is the entitled consumer of the camera it leased, and
	// the arbiter is what keeps a watching feature from holding the device at the same time.
	watch(camera: Camera, watcher: CameraDeviceWatcher) {
		const key = resourceKey(camera)
		this.#watchers.set(key, watcher)

		return () => {
			if (this.#watchers.get(key) === watcher) this.#watchers.delete(key)
		}
	}

	// Ignores discovery: a camera only matters once a capture or a watcher addresses it.
	added() {}

	// Routes a camera property update only to the session currently owning its physical key, or to its watcher.
	updated(camera: Camera, property: keyof Camera & string, state?: PropertyState) {
		const key = resourceKey(camera)
		const session = this.#sessions.get(key)
		if (session === undefined) this.#watchers.get(key)?.updated(camera, property, state)
		else session.updated(camera, property, state)

		// A disconnected camera cannot deliver the pending payload, and lifecycle owns its availability from here.
		if (property === 'connected' && !camera.connected) this.#endQuarantine(camera, key)
		// Alert and Idle are the driver reporting an exposure that produced no frame, which can arrive long after
		// the session gave up on it. Only Ok promises a payload, so any other terminal state ends the quarantine
		// instead of blocking the camera until it is reconnected.
		else if (property === 'exposure' && (state === 'Alert' || state === 'Idle')) this.#endQuarantine(camera, key)
	}

	// Discards a quarantined stale BLOB, or hands the BLOB to the session owning the camera.
	blobReceived(camera: Camera, data: Buffer, encoding: BlobEncoding) {
		const key = resourceKey(camera)
		if (this.#quarantined.has(key)) return this.#endQuarantine(camera, key)
		this.#sessions.get(key)?.blobReceived(data, encoding)
	}

	// Reports device removal to the current session and drops any quarantine of the removed camera.
	removed(camera: Camera) {
		const key = resourceKey(camera)
		this.#sessions.get(key)?.deviceUnavailable('removed')
		this.#endQuarantine(camera, key)
	}

	// Blocks the camera until the payload left behind by a terminated exposure has been observed.
	#quarantine(camera: Camera, key: string) {
		this.#quarantined.add(key)
		this.arbiter.markUnavailable({ key, device: camera }, 'quarantine')
	}

	// Releases the quarantine cause; any lifecycle cause keeps the camera blocked on its own.
	#endQuarantine(camera: Camera, key: string) {
		if (!this.#quarantined.delete(key)) return
		this.arbiter.markAvailable({ key, device: camera }, 'quarantine')
	}
}

// Owns frame generations, device rendezvous, processing, and terminal quiescence for one capture.
class CameraCaptureSession {
	// Presentation snapshot and progress arithmetic shared with every other camera-driving feature.
	readonly #reporter: CameraCaptureReporter
	// Caller request copied at construction, so a mutation by the caller cannot alter a running capture.
	readonly #request: CameraCaptureStart
	// Why the request cannot run, or undefined when it can.
	readonly #requestFailure?: string
	// Inter-frame delay in microseconds.
	readonly #waitingTime: number
	// Events of fully processed frames, in capture order.
	readonly #frames: CameraFrameEvent[] = []
	// Losing racer that releases a pending rendezvous when a device failure arrives outside it.
	readonly #terminalFailure = Promise.withResolvers<OperationResult<never>>()
	// Aborted with the first failure reason, so a running inter-frame delay stops when the camera goes away.
	readonly #failureController = new AbortController()
	// Aborted by stop(), ending a running delay without aborting the exposure in flight.
	readonly #stopController = new AbortController()
	// Rendezvous of the exposure currently in flight, absent before the first frame.
	#attempt?: FrameAttempt
	// Whether the session stopped accepting device callbacks and frame emissions.
	#terminal = false
	// First recorded failure, replayed by run() when it was detected outside a rendezvous.
	#failureResult?: OperationResult<never>
	// Exactly-once guard for cleanup, which the coordinator and a terminal path can both reach.
	#cleaned = false
	// Transport loss that makes the session's camera instance unsafe to command or quarantine.
	#deviceUnavailableReason?: Extract<OperationFailureReason, 'disconnected' | 'removed'>
	// Callbacks woken by any non-Busy exposure update, so cleanup can observe quiescence without polling.
	readonly #quiescenceWaiters = new Set<VoidFunction>()
	// Resolves when the canceled generation's outstanding BLOB is observed and discarded.
	readonly #lateBlob = Promise.withResolvers<void>()
	// Whether cleanup has observed the BLOB expected from a physically started exposure.
	#lateBlobObserved = false
	// Whether cancellation observed the driver's explicit abort-to-Idle boundary.
	#abortIdleObserved = false
	// Expected cleanup failure folded into the session result instead of thrown.
	#cleanupFailure?: FailedOperationResult

	// Creates a session bound to one operation context and physical camera over a request it now owns.
	constructor(
		readonly operationContext: OperationContext,
		readonly camera: Camera,
		request: CameraCaptureStart,
		readonly sessionContext: CameraCaptureSessionContext,
	) {
		this.#request = request
		this.#requestFailure = requestFailure(request)
		const valid = this.#requestFailure === undefined
		const loop = request.exposureMode === 'loop'
		// An invalid request never exposes, so its totals are zero rather than whatever a non-finite field gives.
		const count = !valid ? 0 : request.exposureMode === 'single' ? 1 : request.exposureMode === 'fixed' ? request.count : Number.MAX_SAFE_INTEGER
		const frameExposureTime = valid ? exposureTimeInMicroseconds(request.exposureTime, request.exposureTimeUnit) : 0
		this.#waitingTime = valid ? exposureTimeInMicroseconds(request.delay, 'second') : 0
		this.#reporter = new CameraCaptureReporter({
			operation: operationContext.id,
			camera,
			listener: sessionContext.listener,
			loop,
			count,
			frameExposureTime,
			totalExposureTime: loop || !valid ? 0 : frameExposureTime * count + this.#waitingTime * (count - 1),
		})
	}

	// Snoops the named devices, then executes frames through exposure+BLOB processing and delay.
	async run(): Promise<OperationResult<CameraCaptureResult>> {
		if (!this.camera.connected) return this.#finishFailure('disconnected')
		if (this.#requestFailure !== undefined) return this.#finishFailure('commandFailed', this.#requestFailure)

		try {
			this.#snoop()
		} catch (error) {
			return this.#finishFailure('commandFailed', errorMessage(error))
		}

		while (this.#reporter.remainingCount > 0 && !this.operationContext.signal.aborted && !this.#stopController.signal.aborted) {
			// A device failure recorded outside a rendezvous, such as while the frame path is resolved, only
			// surfaces here.
			if (this.#failureResult !== undefined) return this.#finish(this.#failureResult)

			const frame = await this.#captureFrame()
			if (!frame.ok) return this.#finish(frame)
			if (frame.value === undefined) break

			if (this.#reporter.remainingCount > 0) {
				const delayed = await this.#delay()
				if (!delayed.ok) return this.#finish(delayed)
			}
		}

		if (this.operationContext.signal.aborted) {
			return this.#finish(failedOperationResult(abortReason(this.operationContext.signal)))
		}

		// A capture stopped before its first exposure never became Busy, which is not the capture failing.
		if (this.#frames.length === 0) this.sessionContext.settleStarted(failedOperationResult('aborted', 'capture stopped before its first exposure'))

		return this.#finish(successfulOperationResult(undefined))
	}

	// Ends the session after the exposure in flight, interrupting a running delay. Idempotent.
	stop() {
		this.#stopController.abort()
	}

	// Applies camera progress and terminal property updates to the current generation.
	updated(camera: Camera, property: keyof Camera & string, state?: PropertyState) {
		if (camera !== this.camera) return

		if (property === 'exposure' && state !== 'Busy') {
			if (state === 'Idle' && this.operationContext.signal.aborted) this.#abortIdleObserved = true
			for (const waiter of this.#quiescenceWaiters) waiter()
		}

		if (this.#terminal) return

		if (property === 'connected' && !camera.connected) {
			this.deviceUnavailable('disconnected')
			return
		}

		if (property !== 'exposure' || this.#attempt === undefined || this.#attempt.terminal) return

		const attempt = this.#attempt
		const transition = this.#reporter.applyExposureUpdate(state)
		if (transition !== 'ignored') attempt.observed = true

		switch (transition) {
			case 'started':
				attempt.started = true
				attempt.startedAt = this.sessionContext.clock.wallNow()
				attempt.startedMonotonic = this.sessionContext.clock.monotonicNow()
				this.sessionContext.settleStarted(successfulOperationResult(undefined))
				break
			case 'finished':
				attempt.finishedAt = this.sessionContext.clock.wallNow()
				attempt.finishedMonotonic = this.sessionContext.clock.monotonicNow()
				attempt.exposureState = 'Ok'
				attempt.exposureCompleted.resolve('Ok')
				break
			case 'alert':
				attempt.exposureState = 'Alert'
				attempt.exposureCompleted.resolve('Alert')
				this.#fail('alert')
				break
			case 'idle':
				attempt.exposureState = 'Idle'
				attempt.exposureCompleted.resolve('Idle')
				this.#fail('unexpectedState', 'exposure became idle before completion')
				break
		}
	}

	// Accepts one active-generation BLOB and records terminal BLOBs as the cleanup safety boundary.
	blobReceived(data: Buffer, encoding: BlobEncoding) {
		const attempt = this.#attempt
		if (this.#terminal) {
			if (attempt?.dispatched && attempt.blob === undefined) {
				this.#lateBlobObserved = true
				this.#lateBlob.resolve()
			}
			return
		}
		if (attempt === undefined || attempt.terminal || attempt.blob !== undefined) return

		const blob = { data, encoding }
		attempt.blob = blob
		attempt.blobReceived.resolve(blob)
	}

	// Fails pending milestones when the physical device disconnects or is removed.
	deviceUnavailable(reason: Extract<OperationFailureReason, 'disconnected' | 'removed'>) {
		this.#deviceUnavailableReason = reason
		this.sessionContext.availability.markUnavailable()
		this.#fail(reason)
	}

	// Applies a cleanup-time failure without replacing an earlier terminal cause.
	resultAfterCleanup(result: OperationResult<CameraCaptureResult>): OperationResult<CameraCaptureResult> {
		const failure = this.#cleanupFailure
		if (failure === undefined) return result
		if (result.ok) return failure
		return { ...result, error: result.error ? `${result.error}; ${failure.error}` : failure.error }
	}

	// Stops the physical exposure and quarantines the camera when no boundary consumes its outstanding BLOB.
	async cleanup() {
		if (this.#cleaned) return
		this.#cleaned = true
		// A payload is owed only when the exposure was actually dispatched and nothing arrived for it. Alert and
		// Idle are the driver stating the exposure produced no frame, so those states settle the debt.
		const pendingBlob = this.#attempt?.dispatched === true && this.#attempt.blob === undefined
		const requiresBlobBoundary = pendingBlob && this.#attempt?.exposureState !== 'Alert' && this.#attempt?.exposureState !== 'Idle'
		this.#terminal = true
		if (this.#attempt !== undefined) this.#attempt.terminal = true

		const canCommand = this.#deviceUnavailableReason === undefined && this.camera.connected
		const exposureMayBeActive = this.#attempt?.dispatched === true && this.#attempt.exposureState === undefined
		let quiescent = true

		try {
			if (canCommand && (exposureMayBeActive || this.camera.exposuring || this.camera.exposure.state === 'Busy')) {
				this.sessionContext.cameraManager.stopExposure(this.camera)
				quiescent = await this.#waitForQuiescence()
			}

			// A driver that already queued the payload usually delivers it right after the stop, so a short race here
			// consumes it in the common case and avoids quarantining a camera that is in fact fine.
			const drainTime = Math.max(0, this.sessionContext.options.lateBlobDrainTime ?? DEFAULT_LATE_BLOB_DRAIN_TIME)
			if (requiresBlobBoundary && !this.#lateBlobObserved && drainTime > 0) await Promise.race([this.#lateBlob.promise, Bun.sleep(drainTime)])
			if (canCommand) this.sessionContext.cameraManager.disableBlob(this.camera)
		} finally {
			// The payload may still arrive after the lease is gone, and BLOBs carry no operation id, so the next
			// session would read this one's frame. Quarantine blocks the camera until it is discarded.
			if (canCommand && requiresBlobBoundary && !this.#lateBlobObserved && !this.#abortIdleObserved) this.sessionContext.availability.quarantine()
			if (!quiescent) {
				this.sessionContext.availability.markUnavailable()
				this.#cleanupFailure = failedOperationResult('timeout', 'cleanup failed: camera exposure did not quiesce before cleanup timeout')
			}
		}
	}

	// Tells the driver which devices to stamp into the frame headers. The devices are resolved, never acquired:
	// the driver only reads them, so requiring ownership would make a capture conflict with whoever is slewing
	// the mount or moving the focuser. A device the request does not name, or no lookup resolves, is cleared.
	#snoop() {
		const request = this.#request
		const devices = this.sessionContext.options.devices
		const client = this.camera[CLIENT]
		const mount = request.mount ? devices?.mount?.get(client, request.mount) : undefined
		const focuser = request.focuser ? devices?.focuser?.get(client, request.focuser) : undefined
		const wheel = request.wheel ? devices?.wheel?.get(client, request.wheel) : undefined
		const rotator = request.rotator ? devices?.rotator?.get(client, request.rotator) : undefined
		this.sessionContext.cameraManager.snoop(this.camera, mount, focuser, wheel, rotator)
	}

	// Configures the camera, lets the caller veto the frame, dispatches the exposure, and awaits the
	// exposure+BLOB rendezvous before processing.
	//
	// Configuration, veto, preparation, dispatch and commit run synchronously back to back, so nothing the caller
	// verified in `beforeExposure` can change before the exposure command leaves. The generation is committed only
	// once the exposure exists, so a refused or failed dispatch publishes no exposureStarted and consumes no
	// generation. Resolves an undefined frame when the capture was stopped before its exposure was dispatched.
	async #captureFrame(): Promise<OperationResult<CameraFrameEvent | undefined>> {
		if (this.operationContext.signal.aborted) return failedOperationResult(abortReason(this.operationContext.signal))

		// The destination is resolved before the exposure is commanded, so the identity of the frame exists before
		// its data does: a caller that has to recognize an interrupted frame afterwards can only do it against a
		// path it already knew, and a path invented when the BLOB arrives was never knowable.
		let path: string

		try {
			path = await this.#resolveFramePath()
		} catch (error) {
			return failedOperationResult('commandFailed', errorMessage(error))
		}

		if (this.operationContext.signal.aborted) return failedOperationResult(abortReason(this.operationContext.signal))
		// Resolving the path is the last wait before dispatch, so a stop that arrived meanwhile takes no frame.
		if (this.#stopController.signal.aborted) return successfulOperationResult(undefined)

		// The rendezvous exists before the frame is prepared, because the attempt has to be routable the moment the
		// exposure is dispatched, which may deliver its updates synchronously.
		const attempt: FrameAttempt = {
			path,
			exposureCompleted: Promise.withResolvers<PropertyState>(),
			blobReceived: Promise.withResolvers<CameraBlob>(),
			terminal: false,
			dispatched: false,
			observed: false,
			started: false,
			startedAt: 0,
			startedMonotonic: 0,
			finishedAt: 0,
			finishedMonotonic: 0,
		}

		this.#attempt = attempt

		try {
			this.#configureExposure()
		} catch (error) {
			attempt.terminal = true
			return failedOperationResult('commandFailed', errorMessage(error))
		}

		const refusal = this.#beforeExposure(attempt)

		if (refusal !== undefined) {
			attempt.terminal = true
			return refusal
		}

		const { cameraManager, clock } = this.sessionContext
		const request = this.#request
		const exposureTime = exposureTimeInSeconds(request.exposureTime, request.exposureTimeUnit)

		this.#reporter.prepareFrame()
		attempt.dispatchedAt = clock.wallNow()
		attempt.dispatchedMonotonic = clock.monotonicNow()

		try {
			cameraManager.startExposure(this.camera, exposureTime)
		} catch (error) {
			// An update of the prepared generation proves the exposure exists despite the error, so it is committed
			// and cleanup aborts it and settles its BLOB like any dispatched exposure. Without one nothing exists:
			// the generation is dropped unpublished and no BLOB is owed.
			if (attempt.observed) {
				attempt.dispatched = true
				this.#reporter.commitFrame()
			} else {
				attempt.terminal = true
				this.#reporter.discardFrame()
			}

			return failedOperationResult('commandFailed', errorMessage(error))
		}

		attempt.dispatched = true
		this.#reporter.commitFrame()

		const timeout = exposureTime * 1000 + Math.max(0, this.sessionContext.options.frameGraceTime ?? DEFAULT_FRAME_GRACE_TIME)
		const rendezvous = await this.#awaitRendezvous(attempt, timeout)

		if (!rendezvous.ok) {
			attempt.terminal = true
			return rendezvous
		}

		if (!attempt.started) {
			attempt.terminal = true
			return failedOperationResult('unexpectedState', 'exposure completed without a Busy state')
		}

		const processed = await this.#processBlob(rendezvous.value, attempt)
		attempt.terminal = true

		if (!processed.ok) return processed

		this.#frames.push(processed.value)
		this.#reporter.completeFrame(processed.value.path)
		return this.#failureResult ?? processed
	}

	// Sends every camera configuration command of the request, but not the exposure itself.
	#configureExposure() {
		const request = this.#request
		const cameraManager = this.sessionContext.cameraManager
		cameraManager.enableBlob(this.camera)
		if (request.width > 0 && request.height > 0 && request.subframe) cameraManager.frame(this.camera, request.x, request.y, request.width, request.height)
		else if (this.camera.frame.width.max > 0 && this.camera.frame.height.max > 0) cameraManager.frame(this.camera, 0, 0, this.camera.frame.width.max, this.camera.frame.height.max)
		cameraManager.frameType(this.camera, request.frameType)
		if (request.frameFormat) cameraManager.frameFormat(this.camera, request.frameFormat)
		cameraManager.bin(this.camera, request.binX, request.binY)
		cameraManager.gain(this.camera, request.gain)
		cameraManager.offset(this.camera, request.offset)
		cameraManager.transferFormat(this.camera, request.transferFormat)
		cameraManager.compression(this.camera, request.compressed)
	}

	// Asks the caller whether the configured frame may be dispatched, synchronously. Returns the refusal, or
	// undefined when the frame may go; a hook that throws refuses it as `commandFailed`.
	#beforeExposure(attempt: FrameAttempt): FailedOperationResult | undefined {
		const beforeExposure = this.sessionContext.beforeExposure
		if (beforeExposure === undefined) return undefined

		try {
			return beforeExposure({ path: attempt.path, generation: this.#reporter.generation + 1 })
		} catch (error) {
			return failedOperationResult('commandFailed', errorMessage(error))
		}
	}

	// Waits for both physical completion and one BLOB, or the first terminal failure, abort, or timeout in ms.
	async #awaitRendezvous(attempt: FrameAttempt, timeout: number): Promise<OperationResult<CameraBlob>> {
		const completed = Promise.all([attempt.exposureCompleted.promise, attempt.blobReceived.promise]).then(([state, blob]): OperationResult<CameraBlob> => (state === 'Ok' ? successfulOperationResult(blob) : failedOperationResult(state === 'Alert' ? 'alert' : 'unexpectedState')))
		const aborted = Promise.withResolvers<OperationResult<CameraBlob>>()
		const onAbort = () => aborted.resolve(failedOperationResult(abortReason(this.operationContext.signal)))
		const timer = setTimeout(() => aborted.resolve(failedOperationResult('timeout')), Math.max(0, timeout))
		this.operationContext.signal.addEventListener('abort', onAbort, { once: true })

		try {
			return await Promise.race([completed, this.#terminalFailure.promise, aborted.promise])
		} finally {
			clearTimeout(timer)
			this.operationContext.signal.removeEventListener('abort', onAbort)
		}
	}

	// Resolves the final path of the next frame, creating the dated subfolder it is written into.
	//
	// A caller that decided the destination provides both halves and nothing here is derived; a caller with a
	// `framePath` resolver decides the path of every saved frame. Otherwise the automatic directory and the
	// timestamp name are used, and the timestamp is the instant the exposure is commanded rather than the instant
	// its payload arrived: a name has to exist before the data. An automatic name that is already taken, such as
	// by a frame of the same millisecond, gets the first free `_<n>` suffix.
	async #resolveFramePath() {
		const request = this.#request
		const framePath = this.sessionContext.framePath
		let path: string
		let chosen = request.outputName !== undefined

		if (request.outputPath && request.outputName) {
			path = join(request.outputPath, request.outputName)
		} else if (request.autoSave && !chosen && framePath !== undefined) {
			path = await framePath({ generation: this.#reporter.generation + 1, time: Date.now(), camera: this.camera })
			chosen = true
		} else {
			const now = Date.now()
			const name = request.autoSave ? formatTemporal(now, 'YYYYMMDD.HHmmssSSS', localTimezoneOffset(now)) : this.camera.name
			const extension = request.transferFormat === 'XISF' ? 'xisf' : 'fit'
			const directory = request.outputPath ?? (await this.#automaticDirectory(now))
			path = join(directory, request.outputName ?? `${name}.${extension}`)

			// A frame that is not saved is only published under its name, so only a written one needs a free name.
			if (request.autoSave && !chosen) {
				for (let suffix = 2; await Bun.file(path).exists(); suffix++) path = join(directory, `${name}_${suffix}.${extension}`)
			}
		}

		// A caller-supplied name addresses one specific file, and the frame has to be what creates it. Silently
		// overwriting turns a capture request into a write over a file that was never a frame.
		if (chosen && (await Bun.file(path).exists())) throw new Error(`the output file "${path}" already exists`)

		return path
	}

	// Resolves the automatic output directory at the Unix time `now`, in milliseconds, creating its subfolder.
	async #automaticDirectory(now: number) {
		const request = this.#request
		const capturesDir = this.sessionContext.options.capturesDir

		if (!request.autoSave) return capturesDir

		const savePath = request.savePath && (await directoryExists(request.savePath)) ? request.savePath : capturesDir
		const subFolder = autoSubFolderName(now, request.autoSubFolderMode)
		if (subFolder === undefined) return savePath

		const path = join(savePath, subFolder)
		await mkdir(path, { recursive: true })
		return path
	}

	// Decodes, publishes, and optionally writes one BLOB while retaining the camera lease.
	//
	// The file is written to the attempt path by the writer of this capture. The frame is published under
	// `publishPath` when the caller asked for one, which is how a frame can land in a temporary without a
	// consumer ever seeing that name.
	async #processBlob(blob: CameraBlob, attempt: FrameAttempt): Promise<OperationResult<CameraFrameEvent>> {
		try {
			const buffer = blob.encoding === 'raw' ? blob.data : await (this.sessionContext.options.decode ?? decodeCameraBlobFromBase64)(blob.data)
			if (this.operationContext.signal.aborted) return failedOperationResult(abortReason(this.operationContext.signal))

			const path = attempt.path
			const published = this.#request.publishPath ?? path

			const frame: CameraFrameEvent = {
				operation: this.operationContext.id,
				session: this.#reporter.session,
				generation: this.#reporter.generation,
				camera: this.camera.id,
				path: published,
				exposureDispatchedAt: attempt.dispatchedAt,
				exposureDispatchedMonotonic: attempt.dispatchedMonotonic,
				exposureStartedAt: attempt.startedAt,
				exposureStartedMonotonic: attempt.startedMonotonic,
				exposureFinishedAt: attempt.finishedAt,
				exposureFinishedMonotonic: attempt.finishedMonotonic,
			}

			this.sessionContext.options.publish?.(buffer, published, this.camera)
			if (this.#request.autoSave) await this.sessionContext.write(path, buffer)
			if (this.operationContext.signal.aborted) return failedOperationResult(abortReason(this.operationContext.signal))
			return successfulOperationResult(frame)
		} catch (error) {
			return failedOperationResult('commandFailed', errorMessage(error))
		}
	}

	// Waits between frames, stopping on cancellation, on a device failure, or on stop(), which ends the wait
	// successfully so the capture finishes instead of starting the next frame. Delays of at least one second
	// publish waiting progress every 250 ms; shorter ones are waited silently. Both advance the aggregate progress.
	async #delay(): Promise<OperationResult<void>> {
		const waitingTime = this.#waitingTime
		if (waitingTime <= 0 || this.#stopController.signal.aborted) return successfulOperationResult(undefined)

		const progress = waitingTime >= MINIMUM_WAITING_TIME
		const signal = AbortSignal.any([this.operationContext.signal, this.#failureController.signal, this.#stopController.signal])
		let remaining = waitingTime

		while (remaining > 0) {
			if (progress) this.#reporter.waiting(remaining, waitingTime - remaining, waitingTime)

			const step = progress ? Math.min(WAITING_PROGRESS_STEP, remaining) : remaining
			const delayed = await abortableDelay(step / 1000, signal)
			if (!delayed.ok) return this.#failureResult ?? (this.operationContext.signal.aborted ? delayed : successfulOperationResult(undefined))
			remaining -= step
		}

		this.#reporter.completeDelay(waitingTime)
		return successfulOperationResult(undefined)
	}

	// Waits for an observed non-Busy exposure update and removes its waiter after the quiesce timeout.
	async #waitForQuiescence(): Promise<boolean> {
		if (!this.camera.exposuring && this.camera.exposure.state !== 'Busy') return true

		const observed = Promise.withResolvers<boolean>()
		const onUpdate = () => {
			if (!this.camera.exposuring && this.camera.exposure.state !== 'Busy') observed.resolve(true)
		}

		this.#quiescenceWaiters.add(onUpdate)

		let timer: Timer | undefined
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), Math.max(0, this.sessionContext.options.quiesceTimeout ?? DEFAULT_QUIESCE_TIMEOUT))
		})

		try {
			onUpdate()
			return await Promise.race([observed.promise, timeout])
		} finally {
			clearTimeout(timer)
			this.#quiescenceWaiters.delete(onUpdate)
		}
	}

	// Records the first session failure and releases every pending rendezvous race and delay.
	#fail(reason: OperationFailureReason, error?: string) {
		if (this.#failureResult !== undefined) return
		const result = failedOperationResult(reason, error)
		this.#failureResult = result
		this.#terminalFailure.resolve(result)
		this.#failureController.abort(reason)
		this.sessionContext.settleStarted(result)
	}

	// Converts an early validation failure into the shared terminal presentation and result.
	#finishFailure(reason: OperationFailureReason, error?: string): OperationResult<CameraCaptureResult> {
		const result = failedOperationResult(reason, error)
		this.sessionContext.settleStarted(result)
		return this.#finish(result)
	}

	// Finalizes the session exactly once and emits one terminal presentation event.
	#finish(result: OperationResult<unknown>): OperationResult<CameraCaptureResult> {
		// run() is the only caller and stops at the first terminal result, so this only guards cleanup racing a late frame.
		if (this.#terminal) return this.#failureResult ?? failedOperationResult('aborted')
		this.#terminal = true
		if (!result.ok) this.sessionContext.settleStarted(result)
		this.#reporter.terminal(!result.ok)
		return result.ok ? successfulOperationResult({ frames: this.#frames, frameCount: this.#frames.length }) : result
	}
}

// Why a capture request cannot run, or undefined when it can.
//
// The request usually crosses a transport boundary, so this is where it is checked once. Non-finite numbers
// would otherwise reach the timers and the progress arithmetic: a NaN delay turns every total into NaN, an
// infinite exposure overflows its timeout into an immediate one, and a fractional count takes more frames than
// the totals report. `outputPath` and `outputName` are the only fields naming where bytes land instead of
// deriving it: a relative directory resolves against the working directory of the process rather than
// anything the caller named, and a name that is not a single segment climbs out of the directory it was given.
function requestFailure(request: CameraCaptureStart) {
	if (!(request.exposureTime > 0 && Number.isFinite(request.exposureTime))) return 'exposure time must be positive and finite'
	if (!(request.delay >= 0 && Number.isFinite(request.delay))) return 'delay must be non-negative and finite'
	if (request.exposureMode === 'fixed' && !(request.count > 0 && Number.isSafeInteger(request.count))) return 'frame count must be a positive integer'
	// One name is one frame. Several frames under it would leave one file on disk while every frame reported the
	// path it was supposedly written to, which is a capture that looks complete and is not.
	if (request.outputName !== undefined && request.exposureMode !== 'single' && !(request.exposureMode === 'fixed' && request.count === 1)) return 'a fixed output name captures a single frame'
	if (request.outputPath !== undefined && !isAbsolute(request.outputPath)) return `the output path "${request.outputPath}" is not an absolute path`
	if (request.outputName !== undefined && !isPathSegment(request.outputName)) return `the output name "${request.outputName}" is not a valid file name`
	return undefined
}

// Offset of the local time zone at the Unix time `time`, in minutes east of UTC. It is read per instant
// rather than once per process, so names and folders follow a daylight-saving change during a long session.
function localTimezoneOffset(time: number) {
	return -new Date(time).getTimezoneOffset()
}

// Dated subfolder name `YYYY-MM-DD` of an auto-saved frame taken at the Unix time `time`, in milliseconds, or
// undefined when the mode is `off`. `midnight` uses the local calendar date. `noon` uses the local date twelve
// hours earlier, so frames from noon of one day until noon of the next, a whole night, share one folder named
// after the evening it began. `timezoneOffset` is in minutes east of UTC and defaults to the local offset at
// that instant.
export function autoSubFolderName(time: number, mode: CameraAutoSubFolderMode, timezoneOffset: number = localTimezoneOffset(time)) {
	if (mode === 'off') return undefined
	const local = temporalAdd(time, timezoneOffset, 'm')
	return formatTemporal(mode === 'midnight' ? local : temporalSubtract(local, 12, 'h'), 'YYYY-MM-DD')
}

// Writes a frame to `path` only if no file exists there, and only once it is complete. The bytes go to a
// temporary file next to it first, which is then hard-linked to the final name, an operation that fails
// instead of replacing an existing file; a filesystem without hard links, such as exFAT, gets an exclusive
// copy instead. The temporary file is always removed, so a failure leaves neither it nor a partial frame
// behind. Rejects when the file exists or cannot be written.
export async function writeFrameExclusively(path: string, data: Buffer) {
	const temporary = `${path}.${Bun.randomUUIDv7()}.tmp`

	try {
		await Bun.write(temporary, data)

		try {
			await link(temporary, path)
		} catch (error) {
			if (errorCode(error) === 'EEXIST') throw new Error(`the output file "${path}" already exists`, { cause: error })

			try {
				await copyFile(temporary, path, constants.COPYFILE_EXCL)
			} catch (copyError) {
				if (errorCode(copyError) === 'EEXIST') throw new Error(`the output file "${path}" already exists`, { cause: copyError })
				// A copy that failed after creating the file would leave a partial frame under the final name.
				await rm(path, { force: true })
				throw copyError
			}
		}
	} finally {
		await rm(temporary, { force: true })
	}
}

// System error code of a failed filesystem call, such as EEXIST, or undefined for any other error.
function errorCode(error: unknown) {
	return Error.isError(error) && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

// Computes the decoded byte length of a base64 payload without internal whitespace, padded or not.
function computeDecodedBase64Length(data: Uint8Array) {
	let paddingCount = 0

	// 61 is `=`.
	if (data[data.byteLength - 1] === 61) {
		paddingCount = data[data.byteLength - 2] === 61 ? 2 : 1
	}

	return Math.floor((data.byteLength * 3) / 4) - paddingCount
}

// Removes leading and trailing transport whitespace without copying; returns the input when already trimmed.
function trimBuffer(data: Buffer) {
	const length = data.byteLength
	let start = 0
	while (start < length && data[start] <= 32) start++
	let end = length - 1
	while (end > start && data[end] <= 32) end--
	return start !== 0 || end !== length - 1 ? data.subarray(start, end + 1) : data
}

// Decodes a base64 camera BLOB into a buffer of exactly the decoded length. Leading and trailing whitespace
// is ignored. One output buffer is allocated; the result may be a view of it when the estimate was larger.
export async function decodeCameraBlobFromBase64(buffer: Buffer) {
	const data = trimBuffer(buffer)
	const decodedLength = computeDecodedBase64Length(data)
	const output = Buffer.allocUnsafe(decodedLength)
	const source = base64Source(bufferSource(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))
	const read = await source.read(output)
	return read === decodedLength ? output : output.subarray(0, read)
}
