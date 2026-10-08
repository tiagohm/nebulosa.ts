import type { Rotator } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { RotatorManager } from '../indi/manager/rotator'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationContext, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a rotator.
// Angles are in degrees, the unit the INDI ABS_ROTATOR_ANGLE vector and the device model both publish, and
// are resolved against the driver's own limits before being commanded. Every duration is in milliseconds.
// Motion commands acquire the rotator; the emergency stop does not, so it still runs while the operation
// that owns the device is being canceled.

// Timing overrides for one rotator command; every duration is in milliseconds.
export interface RotatorCommandOptions {
	// Maximum time the commanded angle may take to be reached.
	readonly timeout?: number
	// Maximum time a canceled or finished motion has to bring the rotator to a standstill.
	readonly settleTimeout?: number
}

// One observed rotator transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface RotatorUpdate {
	// Device the update came from.
	readonly rotator: Rotator
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Rotator & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a commanded angle has to be reached. A rotator turns slowly and a homing sweep may
// cross the whole range, so this is deliberately longer than the focuser's move allowance.
const DEFAULT_MOVE_TIMEOUT = 120000

// Default milliseconds a motion that ended has to be reported as no longer moving.
const DEFAULT_SETTLE_TIMEOUT = 15000

// Largest angular difference, in degrees, at which the rotator is taken to be standing at the commanded
// angle. Drivers report the mechanical position, which settles a fraction of a step away from the target,
// so an exact comparison would leave every move pending until it times out.
const ANGLE_TOLERANCE = 1e-3

// Properties whose Alert state means the commanded motion itself failed. An Alert on an unrelated vector,
// such as the reverse switch, must not fail a move that is otherwise progressing.
const MOTION_PROPERTIES = new Set<string>(['angle', 'moving'])

// Signal for physical stops issued while the owning operation is already being canceled. Only the
// emergency stop uses it: cleanup cannot inherit the operation signal, which is aborted by then, and would
// never send the command it exists for. The motion itself waits on the operation signal, so a stop never
// has to outlast a device that keeps reporting motion.
const UNCANCELABLE = new AbortController().signal

// Owns every mutation of a rotator and turns the ones with a physical effect into awaitable operations.
// Each command opens its own nested scope holding the rotator, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the rotator it already owns.
export class RotatorCommander implements DeviceHandler<Rotator> {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Rotator, Set<(update: RotatorUpdate) => void>>()

	// Registers the commander as a rotator observer so waits settle on device events instead of polling.
	constructor(readonly rotatorManager: RotatorManager) {
		rotatorManager.addHandler(this)
	}

	// Required by the manager contract; discovery is published by RotatorHandler.
	added() {}

	// Feeds every waiter observing the device, which is how a motion learns it arrived or hit an Alert.
	updated(rotator: Rotator, property: keyof Rotator & string, state?: PropertyState) {
		this.#emit({ rotator, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(rotator: Rotator) {
		this.#emit({ rotator })
	}

	// Rotates to an absolute angle, in degrees, and resolves only after the rotator reports standing there.
	async moveTo(scope: OperationScope, rotator: Rotator, angle: number, options: RotatorCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('rotatorMoveTo', [{ key: resourceKey(rotator), device: rotator }], async (context) => {
			// Limits are only published while the device is connected, so a disconnected rotator would
			// otherwise resolve every angle against a range of zero.
			if (!rotator.connected) return failedOperationResult('disconnected')

			const target = rotatorAngle(rotator, angle)

			return await this.#move(
				context,
				rotator,
				options,
				() => this.rotatorManager.moveTo(rotator, target),
				() => Math.abs(rotator.angle.value - target) <= ANGLE_TOLERANCE,
			)
		}).result
	}

	// Homes the rotator and resolves only after the motion it starts has finished.
	// Homing ends wherever the driver defines its zero, which is not necessarily the angle it reports as
	// zero, so completion is the standstill alone and not a target angle. What separates that standstill from
	// the one the rotator is still standing in is the motion observed in between: the command is only
	// dispatched, and a driver that publishes Busy after acknowledging it would otherwise be read as a
	// rotator that already homed, ending the operation while it starts to turn and aborting it from cleanup.
	async home(scope: OperationScope, rotator: Rotator, options: RotatorCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('rotatorHome', [{ key: resourceKey(rotator), device: rotator }], async (context) => {
			if (!rotator.connected) return failedOperationResult('disconnected')
			if (!rotator.canHome) return failedOperationResult('unexpectedState', `rotator ${rotator.name} cannot home`)

			let homing = false

			return await this.#move(
				context,
				rotator,
				options,
				() => this.rotatorManager.home(rotator),
				() => {
					if (rotator.moving) homing = true
					return homing
				},
			)
		}).result
	}

	// Redefines the angle the rotator reports, in degrees, which the driver applies without any movement.
	async syncTo(scope: OperationScope, rotator: Rotator, angle: number): Promise<OperationResult<void>> {
		return await scope.start<void>('rotatorSync', [{ key: resourceKey(rotator), device: rotator }], () => {
			if (!rotator.connected) return failedOperationResult('disconnected')
			if (!rotator.canSync) return failedOperationResult('unexpectedState', `rotator ${rotator.name} cannot sync`)

			this.rotatorManager.syncTo(rotator, rotatorAngle(rotator, angle))

			return successfulOperationResult(undefined)
		}).result
	}

	// Inverts the direction the rotator turns for a given angle at the driver.
	// This acquires the rotator even though nothing moves: the setting reinterprets every angle commanded
	// after it, and flipping it under a running operation would send the next move the wrong way.
	async reverse(scope: OperationScope, rotator: Rotator, enabled: boolean): Promise<OperationResult<void>> {
		return await scope.start<void>('rotatorReverse', [{ key: resourceKey(rotator), device: rotator }], () => {
			if (!rotator.connected) return failedOperationResult('disconnected')
			if (!rotator.canReverse) return failedOperationResult('unexpectedState', `rotator ${rotator.name} cannot reverse`)

			this.rotatorManager.reverse(rotator, enabled)

			return successfulOperationResult(undefined)
		}).result
	}

	// Aborts any motion and waits for the rotator to report a standstill.
	// This is the emergency stop of the commander: it does not acquire the device, precisely because it is
	// used while the owning operation is being canceled and by cleanup running after the executor returned.
	async stopMotion(rotator: Rotator, options: RotatorCommandOptions = {}): Promise<OperationResult<void>> {
		if (!rotator.connected) return failedOperationResult('disconnected')
		if (!rotator.canAbort) return rotator.moving ? failedOperationResult('unexpectedState', `rotator ${rotator.name} cannot abort motion`) : successfulOperationResult(undefined)

		return await this.#settle(rotator, options, () => this.rotatorManager.stop(rotator))
	}

	// Commands a motion and waits for the rotator to stand still at a state the caller accepts, aborting it
	// from the scope's own cleanup so a canceled operation never releases a rotator that is still turning.
	// The acceptance predicate is consulted on every update and not only once the rotator stands still,
	// because it may be the one latching the motion that has to be observed before a standstill counts.
	async #move(context: OperationContext, rotator: Rotator, options: RotatorCommandOptions, command: VoidFunction, arrived: () => boolean): Promise<OperationResult<void>> {
		// Registered before the command so a cancel arriving during dispatch still finds the stop it needs.
		context.onCleanup(async () => {
			const stopped = await this.stopMotion(rotator, options)

			// A device that went away is not turning under our command any more, so only one that stays in
			// motion is reported as a cleanup failure.
			if (!stopped.ok && stopped.reason !== 'disconnected') throw new Error(`rotator ${rotator.name} did not stop moving: ${stopped.reason}`)
		})

		const observed = await waitForDeviceState<RotatorUpdate>({
			signal: context.signal,
			timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(rotator, listener),
			current: () => ({ rotator }),
			evaluate: (update) => {
				if (!rotator.connected) return 'disconnected'
				if (update.state === 'Alert' && update.property !== undefined && MOTION_PROPERTIES.has(update.property)) return 'alert'
				const reached = arrived()

				return !rotator.moving && reached ? 'success' : 'pending'
			},
			command,
		})

		return observed.ok ? successfulOperationResult(undefined) : observed
	}

	// Waits for the rotator to report no motion, on a signal of its own so it still runs while the
	// operation that owns the device is being canceled.
	async #settle(rotator: Rotator, options: RotatorCommandOptions, command: VoidFunction): Promise<OperationResult<void>> {
		const settled = await waitForDeviceState<RotatorUpdate>({
			signal: UNCANCELABLE,
			timeout: options.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(rotator, listener),
			current: () => ({ rotator }),
			// A disconnected device is not turning under our command any more, and nothing further will ever
			// be reported by a device that stopped talking.
			evaluate: () => (!rotator.connected || !rotator.moving ? 'success' : 'pending'),
			command,
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(rotator: Rotator, listener: (update: RotatorUpdate) => void) {
		let listeners = this.#listeners.get(rotator)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(rotator, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(rotator)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(rotator)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: RotatorUpdate) {
		const listeners = this.#listeners.get(update.rotator)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Resolves a requested angle, in degrees, to one the rotator can be commanded to and will report back. An
// angle outside the driver's limits is silently clipped by it, and waiting for the requested one would only
// end in a timeout.
//
// The angle of a rotator is a direction and not a position on a rail: it repeats every 360°, and which
// representative of a direction the driver publishes is a convention of that driver. So an angle outside the
// published interval is first offered its equivalent inside it — 350° to a rotator reporting -180..180 is the
// same orientation as -10°, and clipping it to 180° would leave the field about 170° from what was asked for
// while every check reported success. A driver publishing less than a full turn leaves an arc no orientation
// of it can reach, and a request inside that arc is answered with the limit closest to the direction asked
// for, measured the way the mechanism turns rather than on the number line: the excluded arc is bounded by
// the two limits, so the nearest of the two is the one the requested direction is fewer degrees away from.
// Ties go to the maximum, which is the endpoint a driver publishing 0..180 answers a 270° request with.
export function rotatorAngle(rotator: Rotator, angle: number) {
	const { min, max } = rotator.angle

	if (angle >= min && angle <= max) return angle

	// Representative of the requested direction inside one turn starting at the lower limit, which is either
	// inside the published interval or inside the arc the driver excludes.
	const wrapped = angle - 360 * Math.floor((angle - min) / 360)

	if (wrapped <= max) return wrapped

	return wrapped - max <= min + 360 - wrapped ? max : min
}
