import { clamp } from '../../math/numerical/math'
import type { Focuser } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { FocuserManager } from '../indi/manager/focuser'
import type { PropertyState } from '../indi/types'
import { isDeviceQuiescent } from '../orchestration/device.lifecycle'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of an INDI focuser.
// Positions and relative moves are in driver steps, resolved against the device range before being
// commanded, and every duration is in milliseconds. Moves acquire the focuser and resolve only after it
// stops at the target; a failed or canceled move is physically aborted first. The emergency stop does not
// acquire, so it can always reach a focuser moving under another owner.

// Timing overrides for one focuser command; every duration is in milliseconds.
export interface FocuserCommandOptions {
	// Maximum time the commanded position may take to be reached.
	readonly timeout?: number
	// Maximum time a physical stop has to bring the focuser back to a standstill.
	readonly settleTimeout?: number
}

// One observed focuser transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface FocuserUpdate {
	// Device the update came from.
	readonly focuser: Focuser
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Focuser & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// A move resolved against the device range, so the wait and the command agree on where it ends.
interface MovePlan {
	// Absolute position, in steps, the focuser must be standing at once the move is over.
	readonly target: number
	// Sends the driver command that starts the move.
	readonly command: VoidFunction
}

// Default milliseconds a commanded move has to reach its target.
const DEFAULT_MOVE_TIMEOUT = 30000

// Default milliseconds a physical stop has to bring the focuser to a standstill.
const DEFAULT_SETTLE_TIMEOUT = 15000

// Properties whose Alert state means the commanded move itself failed. An Alert on an unrelated vector,
// such as the temperature, must not fail a move that is otherwise progressing.
const MOTION_PROPERTIES = new Set<string>(['position', 'moving'])

// Signal for physical stops issued while the owning operation is already being canceled. Cleanup cannot
// inherit the operation signal, which is aborted by then, and would never send the command it exists for.
const UNCANCELABLE = new AbortController().signal

// Owns every mutation of a focuser and turns the ones with a physical effect into awaitable operations.
// Each command opens its own nested scope holding the focuser, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the focuser it already owns
// and gets cancellation and cleanup that do not disturb the feature around it.
export class FocuserCommander implements DeviceHandler<Focuser>, Disposable {
	// Waiters per device, fed by the manager callbacks. A focuser can be observed by several waits at once,
	// such as a move and the settle of the stop that is canceling it.
	readonly #listeners = new Map<Focuser, Set<(update: FocuserUpdate) => void>>()

	// Registers the commander as a focuser observer so waits settle on device events instead of polling.
	constructor(readonly focuserManager: FocuserManager) {
		focuserManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.focuserManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by FocuserHandler.
	added() {}

	// Feeds every waiter observing the device, which is how a move learns it arrived or hit an Alert.
	updated(focuser: Focuser, property: keyof Focuser & string, state?: PropertyState) {
		this.#emit({ focuser, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(focuser: Focuser) {
		this.#emit({ focuser })
	}

	// Moves to an absolute position and resolves only after the focuser has stopped there.
	async moveTo(scope: OperationScope, focuser: Focuser, position: number, options: FocuserCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#move(scope, 'focuserMoveTo', focuser, options, () => {
			if (!focuser.canAbsoluteMove) return unsupported(focuser, 'move to an absolute position')

			const target = focuserPosition(focuser, position)

			return successfulOperationResult({ target, command: () => this.focuserManager.moveTo(focuser, target) })
		})
	}

	// Moves inward by a number of steps and resolves once the focuser has stopped.
	async moveIn(scope: OperationScope, focuser: Focuser, steps: number, options: FocuserCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#relative(scope, 'focuserMoveIn', focuser, steps, true, options)
	}

	// Moves outward by a number of steps and resolves once the focuser has stopped.
	async moveOut(scope: OperationScope, focuser: Focuser, steps: number, options: FocuserCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#relative(scope, 'focuserMoveOut', focuser, steps, false, options)
	}

	// Redefines the position the focuser reports without moving it, so there is no transition to wait for.
	async syncTo(scope: OperationScope, focuser: Focuser, position: number): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'focuserSync',
			focuser,
			() => focuser.canSync,
			'sync',
			() => this.focuserManager.syncTo(focuser, focuserPosition(focuser, position)),
		)
	}

	// Inverts the motor direction at the driver, for a focuser mounted so that inward would otherwise drive it
	// outward; the reported position keeps decreasing inward. This acquires the focuser like any other
	// command: it silently changes the physical sense of every later move, which a move in flight would feel.
	async reverse(scope: OperationScope, focuser: Focuser, enabled: boolean): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'focuserReverse',
			focuser,
			() => focuser.canReverse,
			'reverse its motion',
			() => this.focuserManager.reverse(focuser, enabled),
		)
	}

	// Stops any motion and waits for the focuser to report a standstill.
	// This is the one command that does not acquire the focuser. It is the emergency stop, used both by the
	// stop endpoint and by the abort path of every wait here, and it exists precisely for the states in
	// which acquisition is impossible: a moving focuser is unavailable to the arbiter, and a focuser moving
	// under someone else's operation is leased away. Refusing to stop it in either case would leave the
	// only command that can make the device safe unreachable.
	async stopMotion(focuser: Focuser, options: FocuserCommandOptions = {}): Promise<OperationResult<void>> {
		if (!focuser.connected) return failedOperationResult('disconnected')
		if (!focuser.canAbort) return unsupported(focuser, 'abort motion')

		return await this.#settle(focuser, () => this.focuserManager.stop(focuser), options)
	}

	// Plans a relative move as the absolute position it ends at, so it is waited for exactly like an
	// absolute one and a target the driver would clamp never leaves the wait pending.
	async #relative(scope: OperationScope, kind: string, focuser: Focuser, steps: number, inward: boolean, options: FocuserCommandOptions) {
		return await this.#move(scope, kind, focuser, options, () => {
			if (!focuser.canRelativeMove) return unsupported(focuser, 'move by a relative amount')

			// The relative vector carries an unsigned step count, and the direction comes from the motion
			// switch, so a negative or zero amount has no command to express it.
			if (!(steps > 0)) return failedOperationResult('unexpectedState', `focuser ${focuser.name} cannot move ${steps} steps`)

			// Inward decreases the reported position whether or not reverse mode is on: reverse inverts the
			// motor at the controller, and the INDI focuser interface bounds relative moves on that basis.
			const target = focuserPosition(focuser, focuser.position.value + (inward ? -steps : steps))
			// A move that its own range clamps is commanded by the amount that actually remains, so the
			// driver stops where the wait expects it to.
			const commanded = Math.abs(target - focuser.position.value)

			return successfulOperationResult({ target, command: () => (inward ? this.focuserManager.moveIn(focuser, commanded) : this.focuserManager.moveOut(focuser, commanded)) })
		})
	}

	// Runs a planned move under a scope owning the focuser and waits for it to stop at the target.
	// Subscription happens before the command, so a focuser that arrives while the command is still being
	// dispatched cannot be missed, and one already standing at the target settles on the state read after
	// dispatch. Every unsuccessful outcome stops the focuser before settling, so no cancel, timeout, or
	// driver Alert leaves it moving after the operation that commanded it has released the device.
	async #move(scope: OperationScope, kind: string, focuser: Focuser, options: FocuserCommandOptions, plan: () => OperationResult<MovePlan>): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(focuser), device: focuser }], async (context) => {
			// Capabilities are only published while the device is connected, so a disconnected focuser would
			// otherwise be reported as one that cannot move at all.
			if (!focuser.connected) return failedOperationResult('disconnected')

			const planned = plan()

			if (!planned.ok) return planned

			const { target, command } = planned.value

			const observed = await waitForDeviceState<FocuserUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT,
				subscribe: (listener) => this.#subscribe(focuser, listener),
				current: () => ({ focuser }),
				evaluate: (update) => {
					if (!focuser.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property !== undefined && MOTION_PROPERTIES.has(update.property)) return 'alert'
					return !focuser.moving && focuser.position.value === target ? 'success' : 'pending'
				},
				command,
				abort: () => this.#abortMotion(focuser, options),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Runs a mutation that has no observable completion under a scope owning the focuser, so it cannot be
	// interleaved with a move or with any other operation already holding the device.
	async #mutate(scope: OperationScope, kind: string, focuser: Focuser, supported: () => boolean, description: string, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(focuser), device: focuser }], () => {
			if (!focuser.connected) return failedOperationResult('disconnected')
			if (!supported()) return unsupported(focuser, description)

			command()

			return successfulOperationResult(undefined)
		}).result
	}

	// Physical stop issued whenever a move concludes unsuccessfully, including a failure the driver itself
	// reported. A disconnected focuser is not moving under our command any more and cannot be sent
	// anything, so only a focuser that stays in motion is reported as a cleanup failure.
	async #abortMotion(focuser: Focuser, options: FocuserCommandOptions) {
		if (!focuser.connected) return

		const result = await this.stopMotion(focuser, options)

		if (!result.ok) throw new Error(`focuser ${focuser.name} did not stop: ${result.reason}`)
	}

	// Sends a stop command and waits for the focuser to report no motion, on a signal of its own so it
	// still runs while the operation that owns the focuser is being canceled.
	async #settle(focuser: Focuser, command: VoidFunction, options: FocuserCommandOptions): Promise<OperationResult<void>> {
		const settled = await waitForDeviceState<FocuserUpdate>({
			signal: UNCANCELABLE,
			timeout: options.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(focuser, listener),
			current: () => ({ focuser }),
			// Quiescence is the same condition the arbiter uses to decide the focuser is acquirable again. A
			// disconnected focuser is not moving under our command any more, and nothing further will ever be
			// reported by a device that stopped talking.
			evaluate: () => (!focuser.connected || isDeviceQuiescent(focuser) ? 'success' : 'pending'),
			command,
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(focuser: Focuser, listener: (update: FocuserUpdate) => void) {
		let listeners = this.#listeners.get(focuser)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(focuser, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(focuser)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(focuser)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: FocuserUpdate) {
		const listeners = this.#listeners.get(update.focuser)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Resolves a computed position to one the focuser can be commanded to and will report back, in steps.
// Positions are whole steps inside the device range, and a target the driver never echoes exactly would
// leave a wait pending until it timed out.
export function focuserPosition(focuser: Focuser, position: number) {
	return Math.round(clamp(position, focuser.position.min, focuser.position.max))
}

// Reports a capability the driver does not expose as an expected failure rather than an exception.
function unsupported(focuser: Focuser, action: string) {
	return failedOperationResult('unexpectedState', `focuser ${focuser.name} cannot ${action}`)
}
