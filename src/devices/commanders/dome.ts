import { errorMessage } from '../../core/util'
import { clamp } from '../../math/numerical/math'
import { normalizeAngle, safeAngularDifference, type Angle } from '../../math/units/angle'
import type { DomeDirection, Dome, DomeShutterState } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { DomeManager } from '../indi/manager/dome'
import type { PropertyState } from '../indi/types'
import { type OperationScope, type OperationContext, successfulOperationResult, failedOperationResult, type OperationResult, type FailedOperationResult } from '../orchestration/operation'
import { abortReason, waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey, type ResourceKey } from '../orchestration/resource'

// Coordinated mutations of an INDI dome.
// Angles are radians in the shared device model, speeds are in the driver's RPM units, backlash values
// are raw driver steps, and every duration is in milliseconds. Motion commands acquire the dome; the
// emergency stop does not, so it still runs while the operation that owns the dome is being canceled.

// Timing overrides for one dome command; every duration is in milliseconds.
export interface DomeCommandOptions {
	// Maximum time the commanded state may take to be observed.
	readonly timeout?: number
	// Maximum time a canceled or finished motion has to bring the dome to a standstill.
	readonly settleTimeout?: number
}

// Live manual dome motion. The operation scope, and therefore the dome lease, stays open until the
// direction is stopped, so another operation cannot command the dome while it is still turning.
export interface DomeManualMoveHandle {
	// Identifier of the operation holding the dome for this motion.
	readonly id: string
	// Current direction, or `undefined` after the motion has been stopped.
	readonly direction: () => DomeDirection | undefined
	// Starts or stops the requested direction.
	readonly move: (direction: DomeDirection, enabled: boolean) => Promise<OperationResult<void>>
	// Stops the motion and resolves after the dome has been observed to stop.
	readonly stop: () => Promise<OperationResult<void>>
}

// One observed dome transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface DomeUpdate {
	// Device the update came from.
	readonly dome: Dome
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Dome & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Mutable bookkeeping for one open-ended manual motion, retained per dome so direct endpoints can reach
// a motion that a previous request started.
interface ManualMove {
	// Public control handle for the open operation.
	readonly handle: DomeManualMoveHandle
}

// Default milliseconds a commanded dome motion has to reach its target. A dome can take several minutes
// to rotate through a large angle at a low driver speed.
const DEFAULT_MOVE_TIMEOUT = 120000

// Default milliseconds a physical stop has to bring the dome and its shutter to a standstill.
const DEFAULT_SETTLE_TIMEOUT = 15000

// Largest angular difference, in radians, at which a dome is taken to be standing at the commanded
// azimuth or altitude. The device normally reports the nearest driver step, so an exact comparison would
// leave a valid move pending until it timed out.
const ANGLE_TOLERANCE = 1e-3

// Default milliseconds a switch or setting command has to be reflected by the device.
const DEFAULT_SWITCH_TIMEOUT = 10000

// Properties whose Alert state means the commanded dome operation itself failed. An Alert on an
// unrelated setting, such as speed, must not fail a motion that is otherwise progressing.
const MOTION_PROPERTIES = new Set<string>(['azimuth', 'altitude', 'direction', 'moving', 'homing', 'atHome', 'parking', 'parked', 'slewing', 'shutterState'])

// Signal for physical stops issued while the owning operation is already being canceled. Cleanup cannot
// inherit the operation signal, which is aborted by the time it runs, and would never send the command it
// exists for.
const UNCANCELABLE = new AbortController().signal

// Owns every mutation of a dome and turns physical operations into awaitable results. Each direct command
// opens its own scope holding the dome; a composite feature can pass its context and inherit that hold.
export class DomeCommander implements DeviceHandler<Dome>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Dome, Set<(update: DomeUpdate) => void>>()
	// Open-ended manual motions, keyed the same way the resource arbiter keys the physical device.
	readonly #manualMoves = new Map<ResourceKey, ManualMove>()

	// Registers the commander as a dome observer so waits settle on device events instead of polling.
	constructor(readonly domeManager: DomeManager) {
		domeManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.domeManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by DomeHandler.
	added() {}

	// Feeds every waiter observing the device, which is how a motion learns it arrived or hit an Alert.
	updated(dome: Dome, property: keyof Dome & string, state?: PropertyState) {
		this.#emit({ dome, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(dome: Dome) {
		this.#emit({ dome })
	}

	// Slews to an absolute azimuth in radians and resolves only after the dome reports standing there.
	async moveTo(scope: OperationScope, dome: Dome, azimuth: Angle, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('domeMoveTo', [{ key: resourceKey(dome), device: dome }], async (context) => {
			const supported = this.#supported(dome, dome.canSetAzimuth && !dome.slaved, 'move to an azimuth')
			if (supported !== undefined) return supported

			const target = domeAzimuth(dome, azimuth)

			return await this.#move(
				context,
				dome,
				options,
				() => this.domeManager.moveTo(dome, target),
				() => angularlyAt(dome.azimuth.value, target),
			)
		}).result
	}

	// Slews to an absolute altitude in radians and resolves only after the dome reports standing there.
	async moveToAltitude(scope: OperationScope, dome: Dome, altitude: Angle, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('domeMoveToAltitude', [{ key: resourceKey(dome), device: dome }], async (context) => {
			const supported = this.#supported(dome, dome.canSetAltitude && !dome.slaved, 'move to an altitude')
			if (supported !== undefined) return supported

			const target = domeAltitude(dome, altitude)

			return await this.#move(
				context,
				dome,
				options,
				() => this.domeManager.moveToAltitude(dome, target),
				() => Math.abs(dome.altitude.value - target) <= ANGLE_TOLERANCE,
			)
		}).result
	}

	// Moves the dome by a signed relative azimuth in radians and resolves after the wrapped target is reached.
	async moveBy(scope: OperationScope, dome: Dome, delta: Angle, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('domeMoveBy', [{ key: resourceKey(dome), device: dome }], async (context) => {
			const supported = this.#supported(dome, dome.canRelativeMove && !dome.slaved, 'move by a relative azimuth')
			if (supported !== undefined) return supported

			const target = domeAzimuth(dome, dome.azimuth.value + delta)

			return await this.#move(
				context,
				dome,
				options,
				() => this.domeManager.moveBy(dome, delta),
				() => angularlyAt(dome.azimuth.value, target),
			)
		}).result
	}

	// Starts or stops continuous clockwise/counter-clockwise motion while keeping the dome leased.
	async move(scope: OperationScope, dome: Dome, direction: DomeDirection, enabled: boolean, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.manualMove(scope, dome, direction, enabled, options)
	}

	// Starts an open-ended manual motion and returns its live control handle.
	async startManualMove(scope: OperationScope, dome: Dome, direction: DomeDirection, options: DomeCommandOptions = {}): Promise<OperationResult<DomeManualMoveHandle>> {
		const supported = this.#supported(dome, dome.canMove && !dome.slaved, 'move manually')
		if (supported !== undefined) return supported

		const key = resourceKey(dome)
		const active = this.#manualMoves.get(key)

		if (active !== undefined) {
			const moved = await active.handle.move(direction, true)
			return moved.ok ? successfulOperationResult(active.handle) : failedOperationResult(moved.reason, moved.error)
		}

		const stopped = Promise.withResolvers<OperationResult<void>>()
		const started = Promise.withResolvers<OperationResult<DomeManualMoveHandle>>()
		let currentDirection: DomeDirection | undefined

		const operation = scope.start<void>('domeManualMove', [{ key, device: dome }], (context) => {
			let closed = false

			const close = (result: OperationResult<void>) => {
				closed = true
				stopped.resolve(result)
			}

			const move = async (nextDirection: DomeDirection, enabled: boolean): Promise<OperationResult<void>> => {
				if (closed || context.signal.aborted) return failedOperationResult('aborted', 'manual move is no longer running')
				if (!dome.connected) return failedOperationResult('disconnected')
				if (enabled === (currentDirection === nextDirection)) return successfulOperationResult(undefined)

				try {
					this.domeManager.move(dome, nextDirection, enabled)
				} catch (error) {
					const failure = failedOperationResult('commandFailed', errorMessage(error))
					close(failure)
					await operation.result
					return failure
				}

				currentDirection = enabled ? nextDirection : undefined

				if (!enabled) {
					close(successfulOperationResult(undefined))
					return await operation.result
				}

				return successfulOperationResult(undefined)
			}

			const handle: DomeManualMoveHandle = Object.freeze({
				id: context.id,
				direction: () => currentDirection,
				move,
				stop: async () => {
					close(successfulOperationResult(undefined))
					return await operation.result
				},
			})

			context.onCleanup(async () => {
				if (this.#manualMoves.get(key)?.handle === handle) this.#manualMoves.delete(key)
				await this.#stopManualMotion(dome, currentDirection, options)
			})

			try {
				this.domeManager.move(dome, direction, true)
			} catch (error) {
				started.resolve(failedOperationResult('commandFailed', errorMessage(error)))
				return failedOperationResult('commandFailed', errorMessage(error))
			}

			currentDirection = direction
			this.#manualMoves.set(key, { handle })

			context.signal.addEventListener('abort', () => close(failedOperationResult(abortReason(context.signal))), { once: true })
			started.resolve(successfulOperationResult(handle))

			return stopped.promise
		})

		void operation.result.then((result) => {
			if (!result.ok) started.resolve(result)
		})

		return await started.promise
	}

	// Applies a direct manual-move endpoint to the open motion. Stopping a direction that is no longer
	// active is idempotent, which lets button-release events arrive after cancellation without becoming errors.
	async manualMove(scope: OperationScope, dome: Dome, direction: DomeDirection, enabled: boolean, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		if (enabled) {
			const started = await this.startManualMove(scope, dome, direction, options)
			return started.ok ? successfulOperationResult(undefined) : started
		}

		const active = this.#manualMoves.get(resourceKey(dome))
		return active === undefined ? successfulOperationResult(undefined) : await active.handle.move(direction, false)
	}

	// Returns the open manual motion of a dome, if any.
	manualMoveOf(dome: Dome) {
		return this.#manualMoves.get(resourceKey(dome))?.handle
	}

	// Synchronizes the dome's reported azimuth in radians without starting a move.
	async syncTo(scope: OperationScope, dome: Dome, azimuth: Angle): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'domeSync',
			dome,
			() => dome.canSync && !dome.slaved,
			'synchronize the azimuth',
			() => this.domeManager.syncTo(dome, azimuth),
		)
	}

	// Moves the dome to its configured home position and resolves after it reports at home.
	async home(scope: OperationScope, dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#moveToState(
			scope,
			'domeHome',
			dome,
			options,
			() => dome.canFindHome,
			'find home',
			() => dome.atHome,
			() => this.domeManager.home(dome),
		)
	}

	// Parks the dome and resolves after it reports both parked and stationary.
	async park(scope: OperationScope, dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#moveToState(
			scope,
			'domePark',
			dome,
			options,
			() => dome.canPark && !dome.slaved,
			'park',
			() => dome.parked,
			() => this.domeManager.park(dome),
		)
	}

	// Unparks the dome and resolves after it reports no longer parked or moving.
	async unpark(scope: OperationScope, dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#moveToState(
			scope,
			'domeUnpark',
			dome,
			options,
			() => dome.canUnpark,
			'unpark',
			() => !dome.parked,
			() => this.domeManager.unpark(dome),
		)
	}

	// Stores the current azimuth as the dome's park position.
	async setPark(scope: OperationScope, dome: Dome): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'domeSetPark',
			dome,
			() => dome.canSetPark,
			'set the park position',
			() => this.domeManager.setPark(dome),
		)
	}

	// Opens the dome shutter and resolves only after it reports fully open.
	async openShutter(scope: OperationScope, dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#shutter(scope, 'domeOpenShutter', dome, 'OPEN', options, () => this.domeManager.openShutter(dome))
	}

	// Closes the dome shutter and resolves only after it reports fully closed.
	async closeShutter(scope: OperationScope, dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#shutter(scope, 'domeCloseShutter', dome, 'CLOSED', options, () => this.domeManager.closeShutter(dome))
	}

	// Enables or disables driver-side slaving.
	async slave(scope: OperationScope, dome: Dome, enabled: boolean, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#switch(
			scope,
			'domeSlave',
			dome,
			enabled,
			options,
			() => dome.canSlave,
			'change slaving',
			() => dome.slaved,
			() => this.domeManager.slave(dome, enabled),
		)
	}

	// Sets dome rotation speed in RPM, resolved against the driver's published range.
	async setSpeed(scope: OperationScope, dome: Dome, value: number): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'domeSpeed',
			dome,
			() => dome.canSetSpeed,
			'set the speed',
			() => this.domeManager.speed(dome, clamp(value, dome.speed.min, dome.speed.max)),
		)
	}

	// Enables or disables controller backlash compensation.
	async setBacklash(scope: OperationScope, dome: Dome, enabled: boolean): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'domeBacklash',
			dome,
			() => dome.hasBacklash,
			'change backlash compensation',
			() => this.domeManager.backlash(dome, enabled),
		)
	}

	// Sets controller backlash in raw driver steps, resolved against the driver's published range.
	async setBacklashSteps(scope: OperationScope, dome: Dome, steps: number): Promise<OperationResult<void>> {
		return await this.#mutate(
			scope,
			'domeBacklashSteps',
			dome,
			() => dome.hasBacklash,
			'set backlash steps',
			() => this.domeManager.backlashSteps(dome, clamp(steps, dome.backlash.min, dome.backlash.max)),
		)
	}

	// Aborts every dome and shutter motion and waits for the device to become quiescent. This emergency
	// endpoint does not acquire the dome, so it remains available during cancellation and cleanup.
	async stopMotion(dome: Dome, options: DomeCommandOptions = {}): Promise<OperationResult<void>> {
		if (!dome.connected) return failedOperationResult('disconnected')
		if (!dome.canAbort) return domeQuiescent(dome) ? successfulOperationResult(undefined) : unsupported(dome, 'abort motion')

		return await this.#settle(dome, options, () => this.domeManager.stop(dome))
	}

	// Runs a state-changing command under a scope owning the dome. The command is expected to take effect
	// immediately; physical transitions use #move instead so their terminal state is observed.
	async #mutate(scope: OperationScope, kind: string, dome: Dome, supported: () => boolean, description: string, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(dome), device: dome }], () => {
			if (!dome.connected) return failedOperationResult('disconnected')
			if (!supported()) return unsupported(dome, description)

			command()
			return successfulOperationResult(undefined)
		}).result
	}

	// Sends a boolean switch and resolves only after the device reports the requested value.
	async #switch(scope: OperationScope, kind: string, dome: Dome, enabled: boolean, options: DomeCommandOptions, supported: () => boolean, description: string, state: () => boolean, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(dome), device: dome }], async (context) => {
			if (!dome.connected) return failedOperationResult('disconnected')
			if (!supported()) return unsupported(dome, description)

			const observed = await waitForDeviceState<DomeUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_SWITCH_TIMEOUT,
				subscribe: (listener) => this.#subscribe(dome, listener),
				current: () => ({ dome }),
				evaluate: (update) => {
					if (!dome.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'slaved') return 'alert'
					return state() === enabled ? 'success' : 'pending'
				},
				command,
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Runs a home, park, or unpark transition under a scope owning the dome.
	async #moveToState(scope: OperationScope, kind: string, dome: Dome, options: DomeCommandOptions, supported: () => boolean, description: string, arrived: () => boolean, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(dome), device: dome }], async (context) => {
			if (!dome.connected) return failedOperationResult('disconnected')
			if (!supported()) return unsupported(dome, description)

			return await this.#move(context, dome, options, command, arrived)
		}).result
	}

	// Opens or closes the shutter and waits for the terminal shutter state.
	async #shutter(scope: OperationScope, kind: string, dome: Dome, target: Extract<DomeShutterState, 'OPEN' | 'CLOSED'>, options: DomeCommandOptions, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(dome), device: dome }], async (context) => {
			if (!dome.connected) return failedOperationResult('disconnected')
			if (!dome.canSetShutter) return unsupported(dome, target === 'OPEN' ? 'open the shutter' : 'close the shutter')

			return await this.#move(context, dome, options, command, () => dome.shutterState === target, true)
		}).result
	}

	// Commands a physical transition and waits until the dome is quiescent at the requested state. Cleanup
	// always stops a failed or canceled command before its resource lease can be released.
	async #move(context: OperationContext, dome: Dome, options: DomeCommandOptions, command: VoidFunction, arrived: () => boolean, shutter = false): Promise<OperationResult<void>> {
		context.onCleanup(async () => {
			const stopped = await this.stopMotion(dome, options)

			if (!stopped.ok && stopped.reason !== 'disconnected') throw new Error(`dome ${dome.name} did not stop moving: ${stopped.reason}`)
		})

		const observed = await waitForDeviceState<DomeUpdate>({
			signal: context.signal,
			timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(dome, listener),
			current: () => ({ dome }),
			evaluate: (update) => {
				if (!dome.connected) return 'disconnected'
				if (update.state === 'Alert' && update.property !== undefined && MOTION_PROPERTIES.has(update.property)) return 'alert'
				if (shutter && dome.shutterState === 'ERROR') return 'alert'
				return domeQuiescent(dome) && arrived() ? 'success' : 'pending'
			},
			command,
		})

		return observed.ok ? successfulOperationResult(undefined) : observed
	}

	// Sends a stop command and waits for all dome and shutter motion to end, on a signal of its own so it
	// still runs while the operation that owns the dome is being canceled.
	async #settle(dome: Dome, options: DomeCommandOptions, command: VoidFunction): Promise<OperationResult<void>> {
		const settled = await waitForDeviceState<DomeUpdate>({
			signal: UNCANCELABLE,
			timeout: options.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(dome, listener),
			current: () => ({ dome }),
			evaluate: () => (domeQuiescent(dome) || !dome.connected ? 'success' : 'pending'),
			command,
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Stops an open-ended manual motion, escalating to the dome abort switch if clearing its direction did
	// not make the device quiescent.
	async #stopManualMotion(dome: Dome, direction: DomeDirection | undefined, options: DomeCommandOptions) {
		if (!dome.connected) return

		const released = await this.#settle(dome, options, () => {
			if (direction !== undefined) this.domeManager.move(dome, direction, false)
		})

		if (released.ok) return

		const aborted = await this.stopMotion(dome, options)
		if (!aborted.ok) throw new Error(`dome ${dome.name} did not stop: ${aborted.reason}`)
	}

	// Registers a waiter for one dome and returns its idempotent unsubscriber.
	#subscribe(dome: Dome, listener: (update: DomeUpdate) => void) {
		let listeners = this.#listeners.get(dome)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(dome, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(dome)
			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(dome)
		}
	}

	// Notifies all waiters of one dome, allowing a waiter to unsubscribe while settling.
	#emit(update: DomeUpdate) {
		const listeners = this.#listeners.get(update.dome)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}

	// Reports whether a dome capability can be used after connection state has been checked.
	#supported(dome: Dome, supported: boolean, action: string): FailedOperationResult | undefined {
		if (!dome.connected) return failedOperationResult('disconnected')
		if (!supported) return unsupported(dome, action)
		return undefined
	}
}

// Resolves an absolute azimuth to the driver's published range after normalizing its circular angle.
export function domeAzimuth(dome: Dome, azimuth: Angle): Angle {
	return clamp(normalizeAngle(azimuth), dome.azimuth.min, dome.azimuth.max)
}

// Resolves an absolute altitude to the driver's published range.
export function domeAltitude(dome: Dome, altitude: Angle): Angle {
	return clamp(altitude, dome.altitude.min, dome.altitude.max)
}

// Reports whether every part of the dome has stopped; the manager aggregates azimuth, altitude, home, park
// and shutter motion into slewing.
function domeQuiescent(dome: Dome) {
	return !dome.slewing
}

// Compares two azimuths using the shortest circular difference in radians.
function angularlyAt(current: Angle, target: Angle) {
	return Math.abs(safeAngularDifference(current, target)) <= ANGLE_TOLERANCE
}

// Builds the typed failure used when the dome cannot perform an operation.
function unsupported(dome: Dome, action: string) {
	return failedOperationResult('unexpectedState', `dome ${dome.name} cannot ${action}`)
}
