import type { GuideDirection, GuideOutput } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { GuideOutputManager } from '../indi/manager/guideoutput'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationContext, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey, type ResourceArbiter, type ResourceKey } from '../orchestration/resource'

// Coordinated timed pulses of an INDI guide output, and the single temporal model of a dispatched pulse.
// A pulse acquires the physical device that provides the guide port and resolves only after the device
// reported the axis busy and then stopped, or, when no Busy arrives, after the last instant a late Busy could
// still begin. A canceled pulse is asked to stop with a zero duration, but the standard INDI guider interface
// and the Alpaca bridge ignore it, so the device is held until the pulse already running has ended.
// Perpendicular pulses of one nudge run together in one operation.
//
// Every pulse this commander dispatches is recorded per physical key as evidence until the end of the pulse
// is physically observed, per axis, on a registered and connected guide output view: a whole Busy → stopped
// cycle, or a stopped state observed continuously until the Busy deadline. Disconnect, removal and the frozen
// fields of a removed view are never taken as the end of a pulse. While the evidence stays open after the
// operation that dispatched it ended, the key is blocked with the `guidePulse` cause. Instants are
// milliseconds of `performance.now()`; durations are milliseconds.

// Latency allowed for a driver to report a pulse Busy, and its Idle after the pulse ends, in milliseconds.
export const GUIDE_PULSE_ACK_MARGIN = 250

// Time a driver is given to clear its pulsing flag once a pulse can no longer be active, in milliseconds. The
// cleanup of a pulse operation always waits this long, whatever settle timeout its caller passed.
export const GUIDE_PULSE_STOP_SETTLE_TIMEOUT = 15000

// Quiescence window of a dispatched pulse, in milliseconds of `performance.now()`.
export interface GuidePulseQuiescenceWindow {
	// Last instant a late Busy of the pulse may still begin: dispatch + duration + GUIDE_PULSE_ACK_MARGIN.
	readonly busyAckDeadline: number
	// Last instant the transport may still report the pulse active, for a Busy at the last accepted instant and a
	// driver that ignores the zero: dispatch + 2·duration + 2·GUIDE_PULSE_ACK_MARGIN.
	readonly endsBy: number
}

// One timed guide pulse of a multi-axis nudge.
export interface GuidePulse {
	// Direction the guide output moves the mount.
	readonly direction: GuideDirection
	// Pulse duration in milliseconds.
	readonly duration: number
}

// Timing overrides for one guide pulse; every duration is in milliseconds.
export interface GuidePulseOptions {
	// Maximum time a canceled or finished pulse has to bring the device back to a standstill, counted from the
	// moment the longest pulse recorded on the device can no longer be reported active (its `endsBy`).
	// Defaults to GUIDE_PULSE_STOP_SETTLE_TIMEOUT.
	readonly settleTimeout?: number
	// Minimum observation window, in milliseconds of `performance.now()`: no standstill is declared before it,
	// and a Busy arriving until then is waited out to its Idle. Used for pulses this commander did not dispatch.
	readonly busyAckDeadline?: number
}

// Axis of a timed-guide vector.
type GuideAxis = 'NS' | 'WE'

// One observed guide output transition. The device is passed live rather than snapshotted because
// evaluation always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface GuideOutputUpdate {
	// Device the update came from.
	readonly device: GuideOutput
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof GuideOutput & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// What the registered views of one physical key last published for one axis.
interface AxisObservation {
	// Start, in `performance.now()` milliseconds, of the continuous period in which a registered and connected
	// view published the axis stopped; undefined when no such period is running.
	idleSince?: number
	// Whether the last state published for the axis was Busy.
	busy: boolean
}

// Progress of one recorded leg: dispatched without an observed Busy, observed Busy, or observed stopped after
// Busy (or refused with Alert).
type DispatchedLeg = 'awaiting' | 'busy' | 'stopped'

// Evidence of the pulses dispatched on one physical key whose end was not observed yet.
interface DispatchedPulseEntry {
	// Device the pulses were dispatched on, used to block the key and wake its waiters.
	readonly device: GuideOutput
	// Latest busyAckDeadline of the recorded pulses, in `performance.now()` milliseconds.
	busyAckDeadline: number
	// Latest endsBy of the recorded pulses, in `performance.now()` milliseconds.
	endsBy: number
	// Progress of every axis a recorded pulse was dispatched on.
	readonly legs: Map<GuideAxis, DispatchedLeg>
	// Cancels the reevaluation of the entry at its busyAckDeadline.
	cancelTimer?: VoidFunction
}

// Signal for physical stops issued while the owning operation is already being canceled. Only the
// emergency stop uses it: cleanup cannot inherit the operation signal, which is aborted by then, and would
// never send the command it exists for. The pulse itself waits on the operation signal, so a stop never has
// to outlast a device that keeps reporting motion.
const UNCANCELABLE = new AbortController().signal

// Direction sharing an axis with each one. TELESCOPE_TIMED_GUIDE_NS and TELESCOPE_TIMED_GUIDE_WE are
// single vectors, so a pulse in one direction is stopped by sending zero to the same or the paired one.
const OPPOSITE_DIRECTION: Record<GuideDirection, GuideDirection> = {
	NORTH: 'SOUTH',
	SOUTH: 'NORTH',
	WEST: 'EAST',
	EAST: 'WEST',
}

// Per-axis guiding flag of each direction. A leg concludes on the flag of its own axis, and an Alert on it
// fails the leg even while the perpendicular leg keeps the aggregate flag raised.
const AXIS_PROPERTY: Record<GuideDirection, 'pulsingNS' | 'pulsingWE'> = {
	NORTH: 'pulsingNS',
	SOUTH: 'pulsingNS',
	WEST: 'pulsingWE',
	EAST: 'pulsingWE',
}

// Axis of each direction.
const DIRECTION_AXIS: Record<GuideDirection, GuideAxis> = {
	NORTH: 'NS',
	SOUTH: 'NS',
	WEST: 'WE',
	EAST: 'WE',
}

// Axis of each per-axis guiding flag.
const PROPERTY_AXIS: Readonly<Record<string, GuideAxis | undefined>> = {
	pulsingNS: 'NS',
	pulsingWE: 'WE',
}

// Quiescence window of a pulse of `duration` milliseconds dispatched at `dispatchedAt`, in the same clock. A
// Busy may begin until the driver acknowledged the pulse (duration + margin); a driver that reports Busy at that
// last instant and ignores the zero keeps the pulse for its whole duration and reports Idle up to one margin
// later. This is the only window arithmetic of the project: every consumer calls it.
export function guidePulseWindow(dispatchedAt: number, duration: number): GuidePulseQuiescenceWindow {
	const d = Math.max(0, duration)
	return { busyAckDeadline: dispatchedAt + d + GUIDE_PULSE_ACK_MARGIN, endsBy: dispatchedAt + 2 * d + 2 * GUIDE_PULSE_ACK_MARGIN }
}

// Runs `callback` once `performance.now()` reached `deadline`, never synchronously, and returns its canceler.
// A timer may fire a fraction of a millisecond before `performance.now()` reaches the instant it was armed
// for, and an evaluation woken that early would find the deadline still ahead with nothing left to wake it,
// so the timer re-arms until the deadline really passed.
function atDeadline(deadline: number, callback: VoidFunction): VoidFunction {
	let timer: Timer | undefined

	const arm = () => {
		const remaining = deadline - performance.now()
		if (remaining <= 0) callback()
		else timer = setTimeout(arm, Math.ceil(remaining))
	}

	timer = setTimeout(arm, Math.max(0, Math.ceil(deadline - performance.now())))

	return () => clearTimeout(timer)
}

// Upper bound, in milliseconds, between asking a guide output to stop and its lease being releasable, for any
// pulse no longer than `maximumDuration` milliseconds: the whole window of such a pulse plus the time a driver
// is given to clear its flag.
export function guidePulseReleaseBound(maximumDuration: number) {
	return guidePulseWindow(0, maximumDuration).endsBy + GUIDE_PULSE_STOP_SETTLE_TIMEOUT
}

// Owns every timed pulse of a guide output and turns it into an awaitable operation.
// The pulse opens its own nested scope holding the physical device behind the guide output, so a
// composite feature passing its own context inherits the device it already owns, and the scope's cleanup
// holds the device until the pulse has ended whenever it is canceled, instead of releasing it while the
// axis is still being driven. A guide output is arbitrated under the key of the device providing it, which
// is why a camera's guide port and the camera itself, or a mount's and the mount itself, are one resource.
export class GuideOutputCommander implements DeviceHandler<GuideOutput>, Disposable {
	// Waiters per physical resource, fed by the manager callbacks. The key is used instead of the device
	// object because a pulse may be commanded through the parent device while the manager reports updates
	// through its guide output proxy, and both resolve to the same key.
	readonly #listeners = new Map<ResourceKey, Set<(update: GuideOutputUpdate) => void>>()
	// Guide output views the manager currently has registered. Only their notifications are physical evidence:
	// a removed view keeps its last fields frozen, and a parent device is notified alongside its proxy.
	readonly #views = new Set<GuideOutput>()
	// Per physical key and axis, what the registered views last published.
	readonly #observations = new Map<ResourceKey, Record<GuideAxis, AxisObservation>>()
	// Dispatched pulses whose end was not observed yet, per physical key.
	readonly #entries = new Map<ResourceKey, DispatchedPulseEntry>()
	// Keys this commander blocked with the `guidePulse` cause.
	readonly #blocked = new Set<ResourceKey>()

	// Registers the commander as a guide output observer so waits settle on device events instead of
	// polling, seeding the registered views from the manager.
	constructor(
		readonly guideOutputManager: GuideOutputManager,
		readonly arbiter: ResourceArbiter,
	) {
		for (const view of guideOutputManager.list()) this.#views.add(view)
		guideOutputManager.addHandler(this)
	}

	// Stops observing the manager and lifts the `guidePulse` cause from the keys this commander blocked. Call it
	// once the operations that use this commander have settled: a wait still pending, or started later, no
	// longer sees device events and settles only by its timeout or its signal. Idempotent.
	dispose() {
		this.guideOutputManager.removeHandler(this)

		for (const entry of this.#entries.values()) entry.cancelTimer?.()
		this.#entries.clear()

		for (const key of this.#blocked) this.arbiter.markAvailable(key, 'guidePulse')
		this.#blocked.clear()
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Tracks a newly registered view.
	added(device: GuideOutput) {
		this.#views.add(device)
	}

	// Records per-axis evidence from the timed-guide notifications of registered and connected views, breaks
	// continuity on disconnect, and feeds every waiter observing the device.
	updated(device: GuideOutput, property: keyof GuideOutput & string, state?: PropertyState) {
		const key = resourceKey(device)
		const axis = PROPERTY_AXIS[property]

		if (axis !== undefined && state !== undefined && this.#views.has(device) && device.connected) {
			this.#observe(key, axis, state)
		} else if (property === 'connected' && !device.connected) {
			this.#forgetObservations(key)
		}

		this.#emit({ device, property, state })
	}

	// Forgets the view and the continuity it provided, keeping the recorded evidence, and wakes every waiter so
	// it reevaluates. The operation itself is canceled independently by DeviceLifecycle.
	removed(device: GuideOutput) {
		this.#views.delete(device)
		this.#forgetObservations(resourceKey(device))
		this.#emit({ device })
	}

	// Issues a timed pulse in one direction and resolves only after it ended. Duration is in milliseconds.
	// The leg concludes on its own axis: after a Busy, once the axis stops; without one, once the Busy deadline
	// passed with the axis stopped. A driver that reports Alert fails the pulse at once. A canceled pulse is held
	// until it has ended before the scope releases the device, so no axis keeps drifting into the next operation.
	async pulse(scope: OperationScope, device: GuideOutput, direction: GuideDirection, duration: number, options: GuidePulseOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('guidePulse', [{ key: resourceKey(device), device }], async (context) => {
			// Capabilities are only published while the device is connected, so a disconnected guide output
			// would otherwise be reported as one that cannot pulse at all.
			if (!device.connected) return failedOperationResult('disconnected')
			if (!device.canPulseGuide) return failedOperationResult('unexpectedState', `guide output ${device.name} cannot pulse guide`)

			this.#stopOnCleanup(context, device, [direction])

			return await this.#pulse(context, device, direction, duration, duration, options)
		}).result
	}

	// Issues one timed pulse per axis inside a single operation and resolves after all of them finished.
	// A diagonal nudge is two pulses on perpendicular axes at the same time, and two operations cannot both
	// hold the device, so they share one scope instead. The legs run concurrently and the whole operation
	// fails with the first failure reported, because a partially drawn correction is not a successful one.
	// Durations are in milliseconds and may differ per axis: each leg concludes on the flag of its own axis,
	// but every leg is given the window of the longest one, since a bridge that mirrors one flag on both
	// vectors only reports the short leg stopped once the long one stopped too. The operation succeeds only
	// with the aggregate flag down.
	async pulseAxes(scope: OperationScope, device: GuideOutput, pulses: readonly GuidePulse[], options: GuidePulseOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('guidePulse', [{ key: resourceKey(device), device }], async (context) => {
			if (!device.connected) return failedOperationResult('disconnected')
			if (!device.canPulseGuide) return failedOperationResult('unexpectedState', `guide output ${device.name} cannot pulse guide`)

			const directions = pulses.map((pulse) => pulse.direction)
			this.#stopOnCleanup(context, device, directions)

			let longest = 0
			for (const pulse of pulses) longest = Math.max(longest, pulse.duration)

			const siblingController = new AbortController()
			const signal = AbortSignal.any([context.signal, siblingController.signal])
			const results = await Promise.all(
				pulses.map((pulse) =>
					this.#pulse(context, device, pulse.direction, pulse.duration, longest, options, signal).then((result) => {
						if (!result.ok && !siblingController.signal.aborted) siblingController.abort(result.reason)
						return result
					}),
				),
			)

			const failure = results.find((result) => !result.ok)
			if (failure !== undefined) return failure
			if (device.pulsing) return failedOperationResult('unexpectedState', `guide output ${device.name} is still pulsing`)
			return successfulOperationResult(undefined)
		}).result
	}

	// Sets the guide rate of both axes, as a fraction of the sidereal rate.
	// Nothing moves, so there is nothing to wait for, but the device is acquired all the same: the rate
	// scales every pulse issued after it, and changing it under a running guider or a DARV leg would
	// silently rescale a correction already in flight.
	async setGuideRate(scope: OperationScope, device: GuideOutput, rightAscension: number, declination: number): Promise<OperationResult<void>> {
		return await scope.start<void>('guideRate', [{ key: resourceKey(device), device }], () => {
			if (!device.connected) return failedOperationResult('disconnected')
			if (!device.canSetGuideRate) return failedOperationResult('unexpectedState', `guide output ${device.name} cannot set guide rate`)

			this.guideOutputManager.guideRate(device, rightAscension, declination)

			return successfulOperationResult(undefined)
		}).result
	}

	// Asks any pulse in one direction to stop and waits for the device to report a standstill.
	// This is the emergency stop of the commander: it does not acquire the device, precisely because it is
	// used while the owning operation is being canceled and by cleanup running after the executor returned.
	async stopPulse(device: GuideOutput, direction: GuideDirection, options: GuidePulseOptions = {}): Promise<OperationResult<void>> {
		return await this.stopPulses(device, [direction], options)
	}

	// Asks the pulses of every given direction to stop and waits once for the device to report a standstill.
	// A zero duration is sent to both directions of each axis, since both share one INDI vector, and every
	// axis is zeroed before anything is awaited. The zero is a request, not a guarantee: the standard INDI guider
	// interface and the Alpaca bridge ignore it. The standstill is never declared before the end of every pulse
	// this commander recorded on the device was observed, nor before `options.busyAckDeadline`; the wait lasts
	// at most until the latest recorded `endsBy` plus the settle timeout. A device without a recorded pulse that
	// disconnects is taken as stopped; one with a recorded pulse fails as `disconnected`, since a disconnect
	// is not the end of a pulse.
	async stopPulses(device: GuideOutput, directions: readonly GuideDirection[], options: GuidePulseOptions = {}): Promise<OperationResult<void>> {
		if (!device.connected) return failedOperationResult('disconnected')
		if (!device.canPulseGuide && this.#entry(resourceKey(device)) === undefined) return successfulOperationResult(undefined)

		const zeroed = new Set<GuideDirection>()

		for (const direction of directions) {
			zeroed.add(direction)
			zeroed.add(OPPOSITE_DIRECTION[direction])
		}

		return await this.#settle(device, options, () => {
			for (const direction of zeroed) this.guideOutputManager.pulse(device, direction, 0)
		})
	}

	// Returns the open quiescence window of the pulses dispatched on the physical key of the device, or
	// undefined once their end was observed. Reading it evaluates the evidence at the current instant.
	dispatchedPulseWindow(device: GuideOutput): GuidePulseQuiescenceWindow | undefined {
		const entry = this.#entry(resourceKey(device))
		return entry === undefined ? undefined : { busyAckDeadline: entry.busyAckDeadline, endsBy: entry.endsBy }
	}

	// Records a pulse of at most `maximumDuration` milliseconds that may have been dispatched on both axes right
	// now by someone this commander never saw, such as a previous process, blocks the key with the `guidePulse`
	// cause until its end is observed, and asks the driver to republish both timed-guide vectors. Sends no
	// physical command. Returns the window that has to be observed.
	assumeDispatchedPulse(device: GuideOutput, maximumDuration: number): GuidePulseQuiescenceWindow {
		const key = resourceKey(device)
		const window = guidePulseWindow(performance.now(), maximumDuration)

		this.#record(device, window, ['NS', 'WE'])
		this.#block(key, device)

		this.guideOutputManager.ask(device, 'TELESCOPE_TIMED_GUIDE_NS')
		this.guideOutputManager.ask(device, 'TELESCOPE_TIMED_GUIDE_WE')

		return this.dispatchedPulseWindow(device) ?? window
	}

	// Registers the stop that runs when the operation owning the pulses ends.
	// It is registered before any leg is commanded so a cancel arriving during dispatch still finds the stop
	// it needs, and it covers every direction of the operation at once because a per-leg cleanup would settle
	// on a flag the sibling leg still holds. When the end of a dispatched pulse is still unobserved as the
	// cleanup ends, the key is blocked with the `guidePulse` cause before the lease is released.
	// The caller's timing is deliberately not forwarded: a settle allowance shortened to fit a deadline
	// bounds how long a leg may be waited for, not how long the axis is given to come to rest, and an
	// emergency stop cut short would release the device while it is still moving.
	#stopOnCleanup(context: OperationContext, device: GuideOutput, directions: readonly GuideDirection[]) {
		context.onCleanup(async () => {
			const stopped = await this.stopPulses(device, directions)
			const key = resourceKey(device)
			const open = this.#entry(key) !== undefined

			if (open) this.#block(key, device)

			if (stopped.ok) return
			// A device that went away with nothing recorded is not pulsing under our command any more.
			if (stopped.reason === 'disconnected' && !open) return
			if (stopped.reason === 'disconnected') throw new Error(`guide output ${device.name} did not observe the end of a dispatched pulse`)
			throw new Error(`guide output ${device.name} did not stop pulsing: ${stopped.reason}`)
		})
	}

	// Commands one leg and waits for its end. `windowDuration` is the duration whose window bounds the wait, the
	// longest leg of the operation. The pulse vector carries a zero for the opposite direction of the axis, and
	// the device can only be acquired once it stopped pulsing, so no previous leg of this axis can still run.
	async #pulse(context: OperationContext, device: GuideOutput, direction: GuideDirection, duration: number, windowDuration: number, options: GuidePulseOptions, signal: AbortSignal = context.signal): Promise<OperationResult<void>> {
		const axis = AXIS_PROPERTY[direction]
		let dispatched = false
		let busySeen = false
		let busyAckDeadline = Number.POSITIVE_INFINITY
		let wake: VoidFunction | undefined
		let cancelTimer: VoidFunction | undefined

		const pulsed = await waitForDeviceState<GuideOutputUpdate>({
			signal,
			timeout: guidePulseWindow(0, windowDuration).endsBy + (options.settleTimeout ?? GUIDE_PULSE_STOP_SETTLE_TIMEOUT),
			subscribe: (listener) => {
				wake = () => listener({ device })
				const unsubscribe = this.#subscribe(device, listener)

				return () => {
					cancelTimer?.()
					unsubscribe()
				}
			},
			current: () => ({ device }),
			evaluate: (update) => {
				// A pulse the driver refuses is reported Alert, which also clears the flag: read as a stop it
				// would be a success.
				if (update.state === 'Alert' && (update.property === axis || update.property === 'pulsing')) return 'alert'

				// A device that went away cannot finish the leg, and nothing further will ever be reported by
				// one that stopped talking.
				if (!device.connected) return 'disconnected'

				if (!dispatched) return 'pending'

				if (device[axis]) {
					busySeen = true
					return 'pending'
				}

				// Without a Busy, a stopped axis only proves the pulse ended once a Busy could no longer begin.
				return busySeen || performance.now() >= busyAckDeadline ? 'success' : 'pending'
			},
			command: () => {
				const window = guidePulseWindow(performance.now(), duration)
				busyAckDeadline = window.busyAckDeadline
				dispatched = true
				this.#record(device, window, [DIRECTION_AXIS[direction]])
				this.guideOutputManager.pulse(device, direction, duration)
				cancelTimer = atDeadline(busyAckDeadline, () => wake?.())
			},
		})

		return pulsed.ok ? successfulOperationResult(undefined) : pulsed
	}

	// Waits for the device to report no guiding motion, on a signal of its own so it still runs while the
	// operation that owns the device is being canceled. The standstill requires the end of every recorded pulse
	// to be observed and, for pulses nobody recorded, nothing before `options.busyAckDeadline`. The allowance
	// starts at the latest recorded `endsBy`, because a driver that ignores the stop keeps pulsing until then.
	async #settle(device: GuideOutput, options: GuidePulseOptions, command: VoidFunction): Promise<OperationResult<void>> {
		const key = resourceKey(device)
		const endsBy = this.#entries.get(key)?.endsBy ?? 0
		const minimum = options.busyAckDeadline ?? Number.NEGATIVE_INFINITY
		let cancelTimer: VoidFunction | undefined

		const settled = await waitForDeviceState<GuideOutputUpdate>({
			signal: UNCANCELABLE,
			timeout: Math.max(0, endsBy - performance.now()) + (options.settleTimeout ?? GUIDE_PULSE_STOP_SETTLE_TIMEOUT),
			subscribe: (listener) => {
				const unsubscribe = this.#subscribe(device, listener)
				if (Number.isFinite(minimum)) cancelTimer = atDeadline(minimum, () => listener({ device }))

				return () => {
					cancelTimer?.()
					unsubscribe()
				}
			},
			current: () => ({ device }),
			evaluate: () => {
				if (this.#entry(key) !== undefined) return this.#observable(key) ? 'pending' : 'disconnected'
				// A disconnected device with nothing recorded is not pulsing under our command any more, and
				// nothing further will ever be reported by a device that stopped talking.
				if (!device.connected) return 'success'
				if (performance.now() < minimum) return 'pending'
				return device.pulsing ? 'pending' : 'success'
			},
			command,
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Records the window of a pulse dispatched on the given axes, extending the open entry of its key.
	#record(device: GuideOutput, window: GuidePulseQuiescenceWindow, axes: readonly GuideAxis[]) {
		const key = resourceKey(device)
		let entry = this.#entries.get(key)

		if (entry === undefined) {
			entry = { device, busyAckDeadline: window.busyAckDeadline, endsBy: window.endsBy, legs: new Map() }
			this.#entries.set(key, entry)
		} else {
			entry.busyAckDeadline = Math.max(entry.busyAckDeadline, window.busyAckDeadline)
			entry.endsBy = Math.max(entry.endsBy, window.endsBy)
		}

		for (const axis of axes) entry.legs.set(axis, 'awaiting')

		entry.cancelTimer?.()
		entry.cancelTimer = atDeadline(entry.busyAckDeadline, () => this.#evaluate(key, true))
	}

	// Applies one timed-guide state published by a registered and connected view.
	#observe(key: ResourceKey, axis: GuideAxis, state: PropertyState) {
		const observation = this.#observation(key)[axis]
		const legs = this.#entries.get(key)?.legs

		if (state === 'Busy') {
			observation.busy = true
			observation.idleSince = undefined
			if (legs?.has(axis)) legs.set(axis, 'busy')
		} else {
			observation.busy = false
			observation.idleSince ??= performance.now()
			// The driver stopping after a Busy, or refusing the pulse with Alert, ends the leg of that axis.
			if (legs?.get(axis) === 'busy' || (state === 'Alert' && legs?.has(axis))) legs?.set(axis, 'stopped')
		}

		this.#evaluate(key, true)
	}

	// Returns the open entry of a key after evaluating it at the current instant, waking the waiters later when
	// the evaluation closed it.
	#entry(key: ResourceKey) {
		return this.#evaluate(key, false)
	}

	// Closes the entry of a key once the end of its pulses was observed, and returns it while still open. The
	// end is observed when no axis of the key was last published Busy and either every recorded axis completed a
	// Busy → stopped cycle, or the Busy deadline passed while a registered and connected view kept publishing
	// every recorded axis stopped.
	#evaluate(key: ResourceKey, notify: boolean) {
		const entry = this.#entries.get(key)
		if (entry === undefined) return undefined

		const observation = this.#observations.get(key)
		if (observation?.NS.busy || observation?.WE.busy) return entry

		let ended = true

		for (const leg of entry.legs.values()) {
			if (leg !== 'stopped') {
				ended = false
				break
			}
		}

		if (!ended && observation !== undefined && performance.now() >= entry.busyAckDeadline && this.#observable(key)) {
			ended = true

			for (const axis of entry.legs.keys()) {
				if (observation[axis].idleSince === undefined) {
					ended = false
					break
				}
			}
		}

		if (!ended) return entry

		entry.cancelTimer?.()
		this.#entries.delete(key)
		if (this.#blocked.delete(key)) this.arbiter.markAvailable(key, 'guidePulse')

		const update: GuideOutputUpdate = { device: entry.device }
		if (notify) this.#emit(update)
		else queueMicrotask(() => this.#emit(update))

		return undefined
	}

	// Blocks a key whose dispatched pulse end is still unobserved.
	#block(key: ResourceKey, device: GuideOutput) {
		if (this.#blocked.has(key)) return
		this.#blocked.add(key)
		this.arbiter.markUnavailable({ key, device }, 'guidePulse')
	}

	// Whether a registered view of the key is connected, which is what makes its notifications evidence.
	#observable(key: ResourceKey) {
		for (const view of this.#views) {
			if (view.connected && resourceKey(view) === key) return true
		}

		return false
	}

	// Returns the per-axis observation of a key, creating it.
	#observation(key: ResourceKey) {
		let observation = this.#observations.get(key)

		if (observation === undefined) {
			observation = { NS: { busy: false }, WE: { busy: false } }
			this.#observations.set(key, observation)
		}

		return observation
	}

	// Breaks the continuity of every axis of a key; what was published before a disconnect or a removal says
	// nothing about what happened during it.
	#forgetObservations(key: ResourceKey) {
		this.#observations.delete(key)
	}

	// Registers a waiter for one physical resource and returns its idempotent unsubscriber.
	#subscribe(device: GuideOutput, listener: (update: GuideOutputUpdate) => void) {
		const key = resourceKey(device)
		let listeners = this.#listeners.get(key)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(key, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(key)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(key)
		}
	}

	// Notifies the waiters of one physical resource.
	#emit(update: GuideOutputUpdate) {
		const listeners = this.#listeners.get(resourceKey(update.device))
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}
