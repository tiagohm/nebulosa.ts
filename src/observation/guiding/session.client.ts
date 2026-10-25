import type { GuideOutputCommander } from '../../devices/commanders/guideoutput'
import type { Camera, GuideOutput } from '../../devices/indi/device'
import { failedOperationResult, type OperationResult, type OperationScope } from '../../devices/orchestration/operation'
import type { Ditherer, DitherPhase, DitherRequest, DitherResult } from './ditherer'
import type { GuidingSession, GuidingSessionResources, GuidingSessionState, GuidingSettle, GuidingStartOptions } from './session'
import { type InteractiveGuidingClient, InteractiveGuidingSession, type InteractiveGuidingSessionOptions } from './session.interactive'

// Guiding session and ditherer of an observation over the local `GuiderClient` (`LocalGuidingSession`): the
// `GuidingSession` and `Ditherer` contracts on top of one `InteractiveGuidingSession`, so an owner such as the
// Sequencer drives the same session, root operation, pulse admission and commander dispatch an interactive client
// does, never a second guider. The owner reserves the guide camera, the guide output and its lifecycle resource; the
// root `guiding` holds the guide camera from the first start, and its child `guidingRun` holds the guide output while
// guiding. A pause closes the pulse gate, pauses the client fully and ends the run once the pulses already sent were
// observed to end, so a slew of the same reservation can take the mount; `resume` opens a new run before guiding again.
// The pulse ceiling (`pulseCeiling`, ms) is frozen at construction and installed by `beginRun`; `endRun` disposes of it.

// Methods of `GuiderClient` the session uses; the client itself in production.
export type LocalGuidingClient = InteractiveGuidingClient

// Options of a local guiding session.
export type LocalGuidingSessionOptions = InteractiveGuidingSessionOptions

// Guiding session and ditherer over one `GuiderClient`, one guide camera and one guide output.
export class LocalGuidingSession implements GuidingSession, Ditherer {
	// Interactive session the contracts delegate to.
	readonly interactive: InteractiveGuidingSession

	// Binds the session to its client, the guide camera and the guide output the client guides with, and the commander
	// of that guide output, which dispatches the pulses and proves their end.
	constructor(
		readonly client: LocalGuidingClient,
		readonly camera: Camera,
		readonly guideOutput: GuideOutput,
		guideOutputCommander: Pick<GuideOutputCommander, 'dispatch' | 'stopPulses'>,
		options: LocalGuidingSessionOptions = {},
	) {
		this.interactive = new InteractiveGuidingSession(client, camera, guideOutput, guideOutputCommander, options)
	}

	// Pulse ceiling of every run, in ms (integer ≥ 1); frozen at construction.
	get pulseCeiling() {
		return this.interactive.pulseCeiling
	}

	// Reserves the guide camera, the guide output and its lifecycle resource; the root holds the guide camera, the run
	// leases the other two under the same reservation while guiding.
	resources(): GuidingSessionResources {
		const { camera, guideOutput, lifecycle } = this.interactive.resources()
		return { reserve: [camera, guideOutput, lifecycle], hold: [camera] }
	}

	// State from the client: calibrating, guiding (settling while a settle runs), paused, lost for a lost lock, and
	// stopped while looping or stopped; 'lost' after a device of the session was lost, until the next start.
	state(): GuidingSessionState {
		if (this.interactive.lost) return 'lost'

		switch (this.client.state) {
			case 'calibrating':
				return 'calibrating'
			case 'guiding':
				return this.client.getSettling() ? 'settling' : 'guiding'
			case 'paused':
				return 'paused'
			case 'lostLock':
				return 'lost'
			default:
				return 'stopped'
		}
	}

	// Installs the closed pulse admission with the frozen ceiling, commanding nothing. 'busy' when another admission (or
	// this run) is active; 'unexpectedState' when the client configuration already allows a longer pulse.
	beginRun(): OperationResult<void> {
		return this.interactive.beginRun()
	}

	// Disposes of the admission of the run, closing its gate for good. Idempotent.
	endRun() {
		this.interactive.endRun()
	}

	// Reports a local session needs a pulse ceiling the guider configuration does not exceed.
	preflight(report: (message: string) => void) {
		const longest = this.client.maxPulseDuration()
		if (longest > this.pulseCeiling) report(`the guider allows ${longest} ms pulses, above the pulse ceiling of ${this.pulseCeiling} ms`)
	}

	// Opens the root under the reservation when it does not live and starts guiding (see
	// `InteractiveGuidingSession.startGuiding`), waiting for the settle as a child of `task`. 'unexpectedState' without
	// a begun run.
	async start(task: OperationScope, reservation: OperationScope, options: GuidingStartOptions): Promise<OperationResult<void>> {
		if (!this.interactive.admitted) return failedOperationResult('unexpectedState', 'the guiding run was not begun')
		return await this.interactive.startGuiding(task, reservation, options)
	}

	// Ends the run and the root and stops observing the client; the admission stays until `endRun`.
	async stop(scope: OperationScope): Promise<OperationResult<void>> {
		return await this.interactive.stop(scope)
	}

	// Closes the gate, pauses a calibrating or guiding client fully and ends the run once the guide output was observed
	// at a standstill, at most `pulseQuiescenceBound()`. Runs as the child `guidingPause` of `scope`.
	async pause(scope: OperationScope): Promise<OperationResult<void>> {
		return await this.interactive.pause(scope, 'all', { releaseGuideOutput: true })
	}

	// `guidePulseReleaseBound(pulseCeiling)`.
	pulseQuiescenceBound() {
		return this.interactive.pulseQuiescenceBound()
	}

	// Opens a new run and resumes guiding (see `InteractiveGuidingSession.resume`).
	async resume(scope: OperationScope, settle: GuidingSettle): Promise<OperationResult<void>> {
		return await this.interactive.resume(scope, settle)
	}

	// Flips the calibration of the client for a meridian flip.
	flipCalibration(_scope: OperationScope): Promise<OperationResult<void>> {
		return Promise.resolve(this.interactive.flipCalibration())
	}

	// Interruptions of the monotonic window, from the bounded history.
	interruptions(fromMonotonic: number, toMonotonic: number) {
		return this.interactive.interruptions(fromMonotonic, toMonotonic)
	}

	// Id of the root `guiding` while it lives.
	operationId() {
		return this.interactive.operationId()
	}

	// Guided settles, in guide pixels or in angles when the pixel scale of the guide camera is known.
	accepts(request: DitherRequest) {
		return this.interactive.accepts(request)
	}

	// Whether the client guides (or settles).
	ready() {
		const state = this.state()
		return state === 'guiding' || state === 'settling'
	}

	// Dithers through the client and waits for its settle (see `InteractiveGuidingSession.dither`).
	async dither(scope: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		return await this.interactive.dither(scope, request, onPhase)
	}
}
