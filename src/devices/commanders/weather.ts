import { clamp } from '../../math/numerical/math'
import type { Weather } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { WeatherManager } from '../indi/manager/weather'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated configuration of a weather station.
// Nothing here moves: the commands set how often the driver re-reads its sensors (seconds), the window it
// averages them over (hours), and ask for an immediate re-read. The two periods resolve only once the driver
// reports them, so a safety decision taken right after never relies on readings sampled the old way; the
// refresh is only dispatched, since a re-read may legitimately publish the very same values. Every command
// acquires the station all the same, because a feature watching the conditions owns how they are sampled.
// Every duration of the options is in milliseconds.

// Timing overrides for one weather command; every duration is in milliseconds.
export interface WeatherCommandOptions {
	// Maximum time the driver may take to report the commanded period.
	readonly timeout?: number
}

// One observed weather transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface WeatherUpdate {
	// Device the update came from.
	readonly weather: Weather
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Weather & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a period change has to be reported. Drivers apply it at once, so this only leaves room
// for a slow serial link or a driver that polls its hardware.
const DEFAULT_COMMAND_TIMEOUT = 10000

// Relative tolerance absorbing the float rounding of a period echoed through the INDI text protocol.
const PERIOD_EPSILON = 1e-9

// Absolute tolerance, in hours, for an echoed averaging window. The vector carries no step the device model
// keeps, and drivers print the window with two decimals, so 0.01 h (36 s) accepts that quantization while
// still telling apart any window a station is meant to average over.
const AVERAGE_PERIOD_TOLERANCE = 0.01

// Owns every mutation of a weather station and resolves the period changes only after the driver confirmed
// them. Each command opens its own nested scope holding the station, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the station it already owns.
export class WeatherCommander implements DeviceHandler<Weather>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Weather, Set<(update: WeatherUpdate) => void>>()

	// Registers the commander as a weather observer so confirmations settle on device events instead of polling.
	constructor(readonly weatherManager: WeatherManager) {
		weatherManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.weatherManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by the weather handler.
	added() {}

	// Feeds every waiter observing the device, which is how a command learns it took effect or hit an Alert.
	updated(weather: Weather, property: keyof Weather & string, state?: PropertyState) {
		this.#emit({ weather, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(weather: Weather) {
		this.#emit({ weather })
	}

	// Sets how often the driver re-reads its hardware, in seconds, resolved against the range it published,
	// and resolves once the driver reports it. A driver quantizing to its published step is accepted within
	// half a step of the requested value. A station without a writable update period is refused as
	// `unexpectedState`.
	async setUpdatePeriod(scope: OperationScope, weather: Weather, seconds: number, options: WeatherCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('weatherUpdatePeriod', [{ key: resourceKey(weather), device: weather }], async (context) => {
			if (!weather.connected) return failedOperationResult('disconnected')
			if (!this.weatherManager.canSetUpdatePeriod(weather)) return unsupported(weather, 'set its update period')

			const range = weather.updatePeriod
			const target = range !== undefined && range.max > range.min ? clamp(seconds, range.min, range.max) : seconds
			const tolerance = (range !== undefined && range.step > 0 ? range.step / 2 : 0) + PERIOD_EPSILON * Math.max(1, Math.abs(target))

			const observed = await waitForDeviceState<WeatherUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(weather, listener),
				current: () => ({ weather }),
				evaluate: (update) => {
					if (!weather.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'updatePeriod') return 'alert'
					return weather.updatePeriod !== undefined && Math.abs(weather.updatePeriod.value - target) <= tolerance ? 'success' : 'pending'
				},
				command: () => {
					this.weatherManager.setUpdatePeriod(weather, target)
				},
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Sets the window the backend averages its readings over, in hours (0 for instantaneous readings), and
	// resolves once it reports the window within AVERAGE_PERIOD_TOLERANCE. The window is sent as given: the
	// device model keeps no range for it, and the backend enforces its own. A station without a writable
	// averaging window, as plain INDI drivers are, is refused as `unexpectedState`.
	async setAveragePeriod(scope: OperationScope, weather: Weather, hours: number, options: WeatherCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('weatherAveragePeriod', [{ key: resourceKey(weather), device: weather }], async (context) => {
			if (!weather.connected) return failedOperationResult('disconnected')
			if (!this.weatherManager.canSetAveragePeriod(weather)) return unsupported(weather, 'set its average period')

			const observed = await waitForDeviceState<WeatherUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(weather, listener),
				current: () => ({ weather }),
				evaluate: (update) => {
					if (!weather.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'averagePeriod') return 'alert'
					return weather.averagePeriod !== undefined && Math.abs(weather.averagePeriod - hours) <= AVERAGE_PERIOD_TOLERANCE ? 'success' : 'pending'
				},
				command: () => {
					this.weatherManager.setAveragePeriod(weather, hours)
				},
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Asks the driver for an immediate re-read of every sensor. Only dispatched: the readings it publishes
	// afterwards are reported as device updates and may equal the previous ones. A station without a
	// writable refresh switch is refused as `unexpectedState`.
	async refresh(scope: OperationScope, weather: Weather): Promise<OperationResult<void>> {
		return await scope.start<void>('weatherRefresh', [{ key: resourceKey(weather), device: weather }], () => {
			if (!weather.connected) return failedOperationResult('disconnected')
			if (!this.weatherManager.canRefresh(weather)) return unsupported(weather, 'refresh its readings')

			this.weatherManager.refresh(weather)

			return successfulOperationResult(undefined)
		}).result
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(weather: Weather, listener: (update: WeatherUpdate) => void) {
		let listeners = this.#listeners.get(weather)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(weather, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(weather)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(weather)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: WeatherUpdate) {
		const listeners = this.#listeners.get(update.weather)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Failure for a command the station does not offer.
function unsupported(weather: Weather, action: string) {
	return failedOperationResult('unexpectedState', `weather ${weather.name} cannot ${action}`)
}
