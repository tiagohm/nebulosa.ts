import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { PIOVERTWO } from '../../core/constants'
import { type GuidePulse, type GuideOutputCommander, type GuidePulseQuiescenceWindow, guidePulseReleaseBound } from '../../devices/commanders/guideoutput'
import type { MountCommander } from '../../devices/commanders/mount'
import type { GuideOutput, Mount } from '../../devices/indi/device'
import { failedOperationResult, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortableDelay, abortReason } from '../../devices/orchestration/operation.wait'
import { type ResourceRequest, resourceKey } from '../../devices/orchestration/resource'
import { sphericalOffsetVector } from '../../math/numerical/geometry'
import type { Random } from '../../math/numerical/random'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { DitherGenerator, type DitherMode, type DitherOffset } from './dither'
import { ditherPulsePlanFromGuideRate } from './dither.pulse'
import type { GuideDirectionDEC, GuideDirectionRA } from './guider'

// Dither boundary of observation sessions, independent of guiding: one `Ditherer` contract implemented by the guiding
// sessions (PHD2 and the local GuiderClient, which shift the guide lock position and wait for their settle) and by
// `MountDitherer`, which moves an unguided mount itself, by timed guide pulses on its guide output or by a slew, and
// settles mechanically. A dither resolves only after its settle; it never rejects.
//
// Angles are radians on the sky plane (right ascension positive east, declination positive north), guide amounts are
// guide-camera pixels, settle times are seconds, and pulse durations, bounds and timeouts are milliseconds. The pattern
// state of a mount ditherer lives in memory only and restarts with a new instance.

// Size of one dither: guide-camera pixels, or an angle on the sky plane in radians. Finite > 0.
export type DitherAmount =
	// Guide-camera pixels.
	| { readonly unit: 'guidePixel'; readonly value: number }
	// Angle on the sky plane, in radians.
	| { readonly unit: 'angle'; readonly value: Angle }

// Condition a dither waits for before it resolves.
export type DitherSettle =
	// Guided settle, in the shape of a PHD2 settle: guide error within `pixels` (guide-camera pixels, > 0) for `time`
	// seconds (≥ 0), at most `timeout` seconds (> 0).
	| { readonly kind: 'guided'; readonly pixels: number; readonly time: number; readonly timeout: number }
	// Fixed mechanical wait of `time` seconds (≥ 0) after the motion.
	| { readonly kind: 'mechanical'; readonly time: number }

// One dither and its settle.
export interface DitherRequest {
	// Size of the dither.
	readonly amount: DitherAmount
	// Dithers along right ascension only.
	readonly raOnly: boolean
	// Settle the dither waits for.
	readonly settle: DitherSettle
}

// Progress of one dither, reported in this order: the request is being dispatched, the motion or lock shift was
// applied, the settle runs, the settle is satisfied.
export type DitherPhase = 'dithering' | 'dithered' | 'settling' | 'settled'

// What a successful dither applied.
export type DitherResult =
	// Increment applied by a mount ditherer along the mount axes, in radians on the sky plane (right ascension positive
	// east, declination positive north).
	| { readonly kind: 'mount'; readonly offset: DitherOffset }
	// Shift of the guide lock position reported by a guider, in guide-camera pixels along the image x and y axes; zero
	// when the guider did not report it.
	| { readonly kind: 'guider'; readonly lockShift: readonly [number, number] }

// Resources a dither adapter declares: `reserve` becomes unavailable to third parties for the whole observation
// session; `hold` is the subset leased for a long time by a root of the adapter itself, never a resource the session
// commands through its own tasks.
export interface DithererResources {
	// Resources reserved by the observation session.
	readonly reserve: readonly ResourceRequest[]
	// Subset leased by a long-lived root of the adapter.
	readonly hold: readonly ResourceRequest[]
}

// Dither boundary of an observation session. One instance is bound to one guider or one mount.
export interface Ditherer {
	// Resources reserved for the session and the subset the adapter leases on its own.
	readonly resources: () => DithererResources
	// Whether the adapter supports the unit and the settle of `request`; the preflight refuses one it does not.
	readonly accepts: (request: DitherRequest) => boolean
	// Whether a dither is possible right now (a guider guiding, a connected mount); cheap and synchronous.
	readonly ready: () => boolean
	// Dithers and resolves only after the settle, or with the failure. Runs as a child of `scope` without resources;
	// cancelling `scope` cancels the wait, never anything the adapter keeps running. Never rejects. `onPhase` reports
	// the progress synchronously.
	readonly dither: (scope: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void) => Promise<OperationResult<DitherResult>>
}

// Resource that can physically move a mount during a dither of a mount ditherer. It is potential motion: a lease of the
// same key by another operation (a capture on the camera that carries the ST4 port) is not motion.
export interface MountMovementResource {
	// Resource whose lease can move the mount.
	readonly request: ResourceRequest
	// Worst case, in ms, between the cancellation of the command holding it and the release of its lease.
	readonly releaseBound: number
}

// How a mount ditherer moves the mount.
export interface MountDithererOptions {
	// 'pulse' sends timed guide pulses through the guide output; 'slew' slews the mount by the offset.
	readonly method: 'pulse' | 'slew'
	// Dither pattern, restarted by a new instance (never persisted).
	readonly pattern: DitherMode
	// Uniform source of the random pattern; default `Math.random`. Injected for reproducible tests.
	readonly random?: Random
	// Physical direction of a positive (east) right ascension offset; required by 'pulse', which cannot infer it
	// without a calibration.
	readonly rightAscensionDirection?: GuideDirectionRA
	// Physical direction of a positive (north) declination offset; required by 'pulse'.
	readonly declinationDirection?: GuideDirectionDEC
	// Longest guide pulse of one axis, in ms; finite > 0. A dither needing a longer pulse fails before moving.
	readonly maxPulseDuration: number
	// Arrival tolerance of a dither slew, in radians; default the commander's. A dither slew is always commanded, however
	// small: the "already there" shortcut of the commander would skip a dither below its tolerance.
	readonly slewTolerance?: Angle
	// Settle timeout of a dither slew, in ms, passed explicitly to the commander (the hard-protection mount stop
	// timeout in the Sequencer); default the commander's.
	readonly settleTimeout?: number
}

// Commanders and wait of a mount ditherer.
export interface MountDithererServices {
	// Slews of the 'slew' method.
	readonly mountCommander?: MountCommander
	// Guide pulses of the 'pulse' method, and the evidence of their end.
	readonly guideOutputCommander?: GuideOutputCommander
	// Abortable wait of the mechanical settle; default `abortableDelay` (the session clock in the Sequencer).
	readonly delay?: AbortableDelay
}

// Directions of a guide output, every one zeroed by a stop.
const NO_DIRECTIONS: readonly [] = []

// Target of a dither slew from the pointing (`rightAscension`, `declination`, radians, in the frame the mount reports),
// displaced by `offset` radians on the sky plane (right ascension positive east, declination positive north). The
// displacement is an exact great-circle one: the position angle `atan2(east, north)` and the distance
// `hypot(east, north)` are applied in the tangent basis of the pointing (`sphericalOffsetVector`, which has no
// division at the pole). With `raOnly` the declination is kept exactly and the right ascension moves by
// `2·asin(sin(|east|/2) / cos(declination))` with the sign of `east`, so the great-circle separation is still `|east|`.
// Undefined when the dither disc contains the pole (`π/2 − |declination| ≤ distance`), a valid geometry no slew can
// realize as requested. The right ascension is normalized to [0, 2π). Pure.
export function ditherSlewTarget(rightAscension: Angle, declination: Angle, offset: DitherOffset, raOnly: boolean): EquatorialCoordinate | undefined {
	const east = offset.rightAscension
	const north = raOnly ? 0 : offset.declination
	const distance = Math.hypot(east, north)

	// The inverted comparison also refuses a NaN declination or offset.
	if (!(PIOVERTWO - Math.abs(declination) > distance)) return undefined
	if (distance === 0) return { rightAscension: normalizeAngle(rightAscension), declination }

	if (raOnly) {
		// Outside the polar disc cos(declination) > sin(|east|), so the argument stays at most ≈ 0.5.
		const delta = 2 * Math.asin(Math.sin(Math.abs(east) / 2) / Math.cos(declination))
		return { rightAscension: normalizeAngle(rightAscension + Math.sign(east) * delta), declination }
	}

	const [ra, dec] = eraC2s(...sphericalOffsetVector(eraS2c(rightAscension, declination), Math.atan2(east, north), distance))
	return { rightAscension: normalizeAngle(ra), declination: dec }
}

// Ditherer of an unguided mount. 'pulse' converts each pattern increment (radians) into one timed pulse per axis from the
// guide rate and the current declination (`ditherPulsePlanFromGuideRate`) and sends them through the guide output
// commander, which resolves only after the end of every pulse was observed; 'slew' slews to `ditherSlewTarget` of the
// reported pointing, as a JNOW target. A dither whose disc contains the pole, or whose pulse would exceed
// `maxPulseDuration`, fails with 'unexpectedState' without moving. The settle is the mechanical wait of the request.
// Accepts only angular amounts and mechanical settles; it must never run while a guider guides the same mount.
export class MountDitherer implements Ditherer {
	readonly #generator: DitherGenerator
	readonly #delay: AbortableDelay
	// Whether a dither of this instance is running.
	#inFlight = false

	// Binds the ditherer to `mount` and, for 'pulse', to the `guideOutput` that carries its ST4 port.
	constructor(
		readonly mount: Mount,
		readonly guideOutput: GuideOutput | undefined,
		readonly services: MountDithererServices,
		readonly options: MountDithererOptions,
	) {
		this.#generator = new DitherGenerator({ mode: options.pattern, random: options.random })
		this.#delay = services.delay ?? abortableDelay
	}

	// Resources that can move the mount during a dither: the guide output with the worst case between the cancellation of
	// a pulse and the release of its lease (`guidePulseReleaseBound(maxPulseDuration)`) for 'pulse', the mount with
	// `settleTimeout` (ms, the value passed to the dither slew) for 'slew'. The single source of what a dither may move.
	movement(settleTimeout: number): readonly MountMovementResource[] {
		const { method, maxPulseDuration } = this.options
		if (method === 'slew') return [{ request: { key: resourceKey(this.mount), device: this.mount }, releaseBound: settleTimeout }]
		if (this.guideOutput === undefined) return []
		return [{ request: { key: resourceKey(this.guideOutput), device: this.guideOutput }, releaseBound: guidePulseReleaseBound(maxPulseDuration) }]
	}

	// Reserves exactly the resources of `movement`; holds nothing.
	resources(): DithererResources {
		return { reserve: this.movement(this.options.settleTimeout ?? 0).map((movement) => movement.request), hold: [] }
	}

	// Only angular amounts with a mechanical settle.
	accepts(request: DitherRequest) {
		return request.amount.unit === 'angle' && request.settle.kind === 'mechanical'
	}

	// A connected mount and, for 'pulse', a connected guide output that can pulse.
	ready() {
		if (!this.mount.connected) return false
		if (this.options.method === 'slew') return this.mount.canGoTo
		return this.guideOutput !== undefined && this.guideOutput.connected && this.guideOutput.canPulseGuide
	}

	// Dithers once (see the class), as the child `mountDither` of `scope` without resources: the commanders acquire the
	// guide output or the mount for the motion only, and the settle runs on the injected wait. One dither at a time:
	// a concurrent one fails 'busy'.
	async dither(scope: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		if (this.#inFlight) return failedOperationResult('busy', 'a dither is already running')
		if (!this.accepts(request)) return failedOperationResult('unexpectedState', 'the mount ditherer accepts only angular amounts with a mechanical settle')

		this.#inFlight = true

		try {
			return await scope.start<DitherResult>('mountDither', [], async (context) => {
				onPhase?.('dithering')
				const offset = this.#generator.next(request.amount.value, request.raOnly)
				const moved = this.options.method === 'pulse' ? await this.#pulse(context, offset) : await this.#slew(context, offset, request.raOnly)
				if (!moved.ok) return moved

				onPhase?.('dithered')
				onPhase?.('settling')
				const settled = await this.#delay(request.settle.time * 1000, context.signal)
				if (!settled.ok) return settled

				onPhase?.('settled')
				return successfulOperationResult({ kind: 'mount', offset })
			}).result
		} finally {
			this.#inFlight = false
		}
	}

	// Records, for a 'pulse' ditherer, that a pulse of at most `maxPulseDuration` may have been dispatched on both axes
	// by a previous process, blocking the guide output until its end is observed (the inherited pulse barrier of the
	// Sequencer startup). Synchronous; commands nothing. Undefined for 'slew' or without the guide output commander.
	assumeDispatchedPulses(): GuidePulseQuiescenceWindow | undefined {
		const { guideOutputCommander } = this.services
		if (this.options.method !== 'pulse' || this.guideOutput === undefined || guideOutputCommander === undefined) return undefined
		return guideOutputCommander.assumeDispatchedPulse(this.guideOutput, this.options.maxPulseDuration)
	}

	// Waits, commanding nothing, until the end of every pulse recorded on the guide output was observed by a registered
	// and connected view and the guide output stopped, at most until the latest recorded window allows
	// (`guidePulseReleaseBound(maxPulseDuration)` after the barrier). An abort of `signal` resolves at once with its
	// reason while the wait finishes on its own within the same bound. Fails 'disconnected' when the end cannot be
	// observed and 'timeout' at the bound. Succeeds at once for 'slew'.
	async awaitPulseQuiescence(signal: AbortSignal): Promise<OperationResult<void>> {
		const { guideOutputCommander } = this.services
		if (this.options.method !== 'pulse') return successfulOperationResult(undefined)
		if (this.guideOutput === undefined || guideOutputCommander === undefined) return failedOperationResult('unexpectedState', 'the pulse ditherer has no guide output to observe')
		return await settleOnAbort(guideOutputCommander.stopPulses(this.guideOutput, NO_DIRECTIONS), signal)
	}

	// Pulses the increment on the guide output and waits for the end of every pulse.
	async #pulse(scope: OperationScope, offset: DitherOffset): Promise<OperationResult<void>> {
		const { guideOutput, mount, options } = this
		const { guideOutputCommander } = this.services
		const { rightAscensionDirection, declinationDirection, maxPulseDuration } = options
		if (guideOutput === undefined || guideOutputCommander === undefined) return failedOperationResult('unexpectedState', 'the pulse ditherer has no guide output')
		if (rightAscensionDirection === undefined || declinationDirection === undefined) return failedOperationResult('unexpectedState', 'the pulse ditherer has no positive pulse directions')

		const { declination } = mount.equatorialCoordinate
		if (!(PIOVERTWO - Math.abs(declination) > Math.hypot(offset.rightAscension, offset.declination))) return failedOperationResult('unexpectedState', 'the dither disc contains the celestial pole')

		const plan = ditherPulsePlanFromGuideRate(offset, { guideRate: guideOutput.guideRate, declination, rightAscensionDirection, declinationDirection }, maxPulseDuration)
		if (plan === undefined) return failedOperationResult('unexpectedState', `the dither needs a guide pulse the guide rate of ${guideOutput.name} cannot deliver within ${maxPulseDuration} ms`)

		const pulses: GuidePulse[] = []
		if (plan.rightAscension !== undefined) pulses.push(plan.rightAscension)
		if (plan.declination !== undefined) pulses.push(plan.declination)
		if (pulses.length === 0) return successfulOperationResult(undefined)

		return await guideOutputCommander.pulseAxes(scope, guideOutput, pulses)
	}

	// Slews by the increment from the reported pointing.
	async #slew(scope: OperationScope, offset: DitherOffset, raOnly: boolean): Promise<OperationResult<void>> {
		const { mount, options } = this
		const { mountCommander } = this.services
		if (mountCommander === undefined) return failedOperationResult('unexpectedState', 'the slew ditherer has no mount commander')

		const { rightAscension, declination } = mount.equatorialCoordinate
		const target = ditherSlewTarget(rightAscension, declination, offset, raOnly)
		if (target === undefined) return failedOperationResult('unexpectedState', 'the dither disc contains the celestial pole')

		const slewed = await mountCommander.goTo(scope, mount, { type: 'JNOW', JNOW: { x: target.rightAscension, y: target.declination } }, { tolerance: 0, arrivalTolerance: options.slewTolerance, settleTimeout: options.settleTimeout })
		return slewed.ok ? successfulOperationResult(undefined) : slewed
	}
}

// Settles like `promise`, or with the reason of `signal` as soon as it aborts; the promise keeps running and its late
// outcome is dropped.
export function settleOnAbort<T>(promise: Promise<OperationResult<T>>, signal: AbortSignal): Promise<OperationResult<T>> {
	if (signal.aborted) return Promise.resolve(failedOperationResult(abortReason(signal)))

	return new Promise((resolve) => {
		const onAbort = () => resolve(failedOperationResult(abortReason(signal)))
		signal.addEventListener('abort', onAbort, { once: true })

		void promise.then((result) => {
			signal.removeEventListener('abort', onAbort)
			resolve(result)
		})
	})
}
