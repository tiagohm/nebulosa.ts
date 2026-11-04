import type { Camera } from '../indi/device'
import type { CameraManager } from '../indi/manager/camera'
import type { DeviceHandler, StatefulSetVector } from '../indi/manager/device'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated thermal mutations of a camera.
// Exposures are owned by CameraCapturer, so what is left here is the cooling control: switching the cooler
// and setting its target. Both resolve once the driver answers the command: the cooler switch when it reports
// the cooler in the commanded state, the target when CCD_TEMPERATURE reports it ramping (Busy) or already at
// the target (Ok within TEMPERATURE_TOLERANCE). Neither waits for the sensor to reach the setpoint, which
// takes minutes and is reported continuously as a device update. Both acquire the camera all the same,
// because changing the thermal state of a sensor that is integrating alters the dark current of the frame
// being exposed, and the resulting image would look plausible while being uncalibratable. Temperatures are
// degrees Celsius and every duration is in milliseconds.

// Timing overrides for one camera command; every duration is in milliseconds.
export interface CameraCommandOptions {
	// Maximum time the driver may take to answer the command.
	readonly timeout?: number
}

// One observed camera transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface CameraUpdate {
	// Device the update came from.
	readonly camera: Camera
	// Field that changed, absent when the update is a poll of the current state or a vector answer.
	readonly property?: keyof Camera & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
	// Command vector the driver answered, for the commands whose effect no device field reflects.
	readonly vector?: StatefulSetVector
}

// Default milliseconds the driver has to answer a cooling command.
const DEFAULT_COMMAND_TIMEOUT = 10000

// Degrees Celsius within which an Ok answer to a new target means the sensor already stands at it. Drivers
// report Ok only once the reading is within their own threshold, a few tenths of a degree, so an Ok poll
// published before the command, far from the new target, is not taken as its answer.
const TEMPERATURE_TOLERANCE = 0.5

// Owns every thermal mutation of a camera and resolves each one only after the driver answered it.
// Each command opens its own nested scope holding the camera, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the camera it already owns.
export class CameraCommander implements DeviceHandler<Camera>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Camera, Set<(update: CameraUpdate) => void>>()

	// Registers the commander as a camera observer so answers settle on device events instead of polling.
	constructor(readonly cameraManager: CameraManager) {
		cameraManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.cameraManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by the camera handler.
	added() {}

	// Feeds every waiter observing the device, which is how a command learns it took effect or hit an Alert.
	updated(camera: Camera, property: keyof Camera & string, state?: PropertyState) {
		this.#emit({ camera, property, state })
	}

	// Feeds every waiter with the answer to a command vector, such as the CCD_TEMPERATURE state.
	vectorState(camera: Camera, vector: StatefulSetVector) {
		this.#emit({ camera, vector, state: vector.state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(camera: Camera) {
		this.#emit({ camera })
	}

	// Switches the cooler on or off and resolves once the driver reports it in that state.
	async cooler(scope: OperationScope, camera: Camera, enabled: boolean, options: CameraCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('cameraCooler', [{ key: resourceKey(camera), device: camera }], async (context) => {
			if (!camera.connected) return failedOperationResult('disconnected')
			if (!camera.hasCoolerControl) return failedOperationResult('unexpectedState', `camera ${camera.name} cannot switch its cooler`)

			const observed = await waitForDeviceState<CameraUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(camera, listener),
				current: () => ({ camera }),
				evaluate: (update) => {
					if (!camera.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'cooler') return 'alert'
					return camera.cooler === enabled ? 'success' : 'pending'
				},
				command: () => this.cameraManager.cooler(camera, enabled),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Sets the cooling target, in degrees Celsius, and resolves once the driver answers it on CCD_TEMPERATURE:
	// Busy (ramping towards it) or Ok with the reading within TEMPERATURE_TOLERANCE of it. An Alert fails it as
	// `alert`. The driver publishes no range for the target, so a target the sensor cannot reach is simply one
	// the cooler keeps working towards.
	async temperature(scope: OperationScope, camera: Camera, value: number, options: CameraCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('cameraTemperature', [{ key: resourceKey(camera), device: camera }], async (context) => {
			if (!camera.connected) return failedOperationResult('disconnected')
			if (!camera.canSetTemperature) return failedOperationResult('unexpectedState', `camera ${camera.name} cannot set its temperature`)

			const observed = await waitForDeviceState<CameraUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(camera, listener),
				current: () => ({ camera }),
				evaluate: ({ vector }) => {
					if (!camera.connected) return 'disconnected'
					if (vector?.name !== 'CCD_TEMPERATURE') return 'pending'
					if (vector.state === 'Alert') return 'alert'
					if (vector.state === 'Busy') return 'success'
					if (vector.state !== 'Ok') return 'pending'
					const reading = vector.elements.CCD_TEMPERATURE_VALUE?.value
					return typeof reading === 'number' && Math.abs(reading - value) <= TEMPERATURE_TOLERANCE ? 'success' : 'pending'
				},
				command: () => this.cameraManager.temperature(camera, value),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(camera: Camera, listener: (update: CameraUpdate) => void) {
		let listeners = this.#listeners.get(camera)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(camera, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(camera)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(camera)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: CameraUpdate) {
		const listeners = this.#listeners.get(update.camera)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}
