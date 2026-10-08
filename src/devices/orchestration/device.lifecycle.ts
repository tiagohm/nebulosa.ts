import type { Camera, Cover, Device, DeviceType, Dome, Focuser, GuideOutput, Mount, Rotator, Wheel } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import { OperationCoordinator, type OperationFailureReason } from './operation'
import { resourceDevice, resourceKey, ResourceArbiter, type ResourceKey } from './resource'

// Device lifecycle bridge for orchestration. DeviceLifecycle observes INDI device managers and turns their
// added/updated/removed events into resource availability: a device is acquirable only while connected and
// physically quiescent, and a disconnect or removal cancels every operation holding it. Several manager
// views of one physical device are aggregated under its hardware key.

// Minimal manager surface required to observe device lifecycle without depending on transport handlers.
export interface DeviceLifecycleManager<D extends Device> {
	// Registers a device lifecycle observer.
	readonly addHandler: (handler: DeviceHandler<D>) => void
	// Removes a previously registered observer.
	readonly removeHandler: (handler: DeviceHandler<D>) => void
	// Enumerates devices already known when observation begins.
	readonly list: () => Iterable<D>
}

// Verifies whether a connected device is physically quiescent and safe to acquire.
export type DeviceAvailabilityVerifier<D extends Device> = (device: D) => boolean | Promise<boolean>

// Reports whether a property change can alter the verdict, so unrelated updates skip verification.
export type DeviceQuiescenceFilter<D extends Device> = (device: D, property: keyof D & string) => boolean

// Per-manager observation behaviour; both entries default to the built-in quiescence rules.
export interface DeviceObserveOptions<D extends Device> {
	// Decides whether a connected device is safe to acquire.
	readonly verify?: DeviceAvailabilityVerifier<D>
	// Narrows which property updates trigger verification; must cover every field verify reads.
	readonly affects?: DeviceQuiescenceFilter<D>
}

// Idempotent manager-observer registration retained for lifecycle disposal.
interface Registration {
	// Detaches the observer from its manager.
	readonly dispose: VoidFunction
}

// One manager-specific view contributing readiness to a shared physical resource.
interface DeviceView {
	// Exact device or subdevice instance emitted by its manager.
	readonly device: Device
	// Evaluates type-specific quiescence for this view.
	readonly verify: () => boolean | Promise<boolean>
}

// Bridges manager add/update/remove events into availability and operation cancellation.
export class DeviceLifecycle {
	// Live views per physical resource. One key can carry several instances, since a camera and the guide
	// output it exposes are separate manager objects that share a single physical device.
	readonly #devices = new Map<ResourceKey, Map<Device, DeviceView>>()
	// Per-resource token discarding readiness results from a verification a newer transition superseded.
	readonly #validationGeneration = new Map<ResourceKey, number>()
	// Manager observers to detach on disposal.
	readonly #registrations = new Set<Registration>()

	// Creates the lifecycle bridge over the process-wide arbiter and coordinator.
	constructor(
		readonly arbiter: ResourceArbiter,
		readonly coordinator: OperationCoordinator,
	) {}

	// Observes existing and future devices from one manager and returns an idempotent disposer. Disposing
	// forgets the views this manager contributed: a device left without any view becomes unavailable, since
	// nothing would cancel its owners on a later disconnect, but operations already running are not cancelled.
	observe<D extends Device>(manager: DeviceLifecycleManager<D>, options: DeviceObserveOptions<D> = {}): VoidFunction {
		const verify = options.verify ?? isDeviceQuiescent
		const affects = options.affects ?? affectsDeviceQuiescence
		// Views this observer contributed, forgotten when it is disposed.
		const contributed = new Set<D>()

		const added = (device: D) => {
			contributed.add(device)
			this.#added(device, verify)
		}

		const handler: DeviceHandler<D> = {
			added,
			updated: (device, property) => this.#updated(device, property, verify, affects),
			removed: (device) => {
				contributed.delete(device)
				this.#removed(device)
			},
		}

		manager.addHandler(handler)

		for (const device of manager.list()) added(device)

		let disposed = false

		const dispose = () => {
			if (disposed) return
			disposed = true
			manager.removeHandler(handler)
			this.#registrations.delete(registration)
			// Views outlive their observer otherwise: a later observe() would aggregate stale devices that no
			// manager can ever update or remove again, and they would stay acquirable with no disconnect watch.
			for (const device of contributed) this.#forget(device)
			contributed.clear()
		}

		const registration: Registration = { dispose }
		this.#registrations.add(registration)
		return dispose
	}

	// Detaches every manager observer and forgets the devices they contributed.
	dispose() {
		for (const registration of this.#registrations) registration.dispose()
		this.#devices.clear()
	}

	// Drops one view of a disposed observer without cancelling its owners. Generations keep advancing rather
	// than being reset, so a verification still in flight can never match a later registration of the key.
	#forget(device: Device) {
		const key = resourceKey(device)
		const devices = this.#devices.get(key)

		if (!devices?.delete(device)) return

		if (devices.size === 0) {
			this.#devices.delete(key)
			this.#nextValidation(key)
			this.arbiter.markUnavailable({ key, device: resourceDevice(device) })
			this.arbiter.markDeviceUnavailable(key)
		} else {
			this.#validate(key)
		}
	}

	// Registers a new instance as unavailable until its quiescence check succeeds.
	#added<D extends Device>(device: D, verify: DeviceAvailabilityVerifier<D>) {
		const key = resourceKey(device)
		let devices = this.#devices.get(key)

		if (devices === undefined) {
			devices = new Map()
			this.#devices.set(key, devices)
		}

		devices.set(device, { device, verify: () => verify(device) })
		this.arbiter.markUnavailable({ key, device: resourceDevice(device) })
		this.#validate(key)
	}

	// Cancels on disconnect and revalidates only the updates that can change quiescence.
	#updated<D extends Device>(device: D, property: keyof D & string, verify: DeviceAvailabilityVerifier<D>, affects: DeviceQuiescenceFilter<D>) {
		const key = resourceKey(device)
		const devices = this.#devices.get(key)

		if (!devices?.has(device)) return

		devices.set(device, { device, verify: () => verify(device) })

		if (property === 'connected' && !device.connected) {
			this.#invalidate(key, resourceDevice(device), 'disconnected')
		} else if (device.connected && affects(device, property)) {
			// Revalidating on unrelated traffic such as temperature would also advance the generation and
			// discard any verification still in flight, which an asynchronous verifier could never survive.
			this.#validate(key)
		}
	}

	// Cancels on any removed view and releases the physical association only after the last view disappears.
	#removed(device: Device) {
		const key = resourceKey(device)
		const devices = this.#devices.get(key)

		if (!devices?.delete(device)) return

		const physicalDevice = resourceDevice(device)
		this.#invalidate(key, physicalDevice, 'removed')

		if (devices.size === 0) {
			this.#devices.delete(key)
			this.arbiter.disassociate(key, physicalDevice)
		} else {
			this.#validate(key)
		}
	}

	// Invalidates pending verification and starts cancellation without waiting inside manager callbacks.
	#invalidate(key: ResourceKey, device: Device, reason: OperationFailureReason) {
		this.#nextValidation(key)
		this.arbiter.markUnavailable({ key, device })
		this.arbiter.markDeviceUnavailable(key)
		// Cancellation aborts owners synchronously; only its cleanup is awaited, and a manager callback is
		// the wrong place to block. The resource stays unavailable either way, so a failure is reported.
		// Owners are looked up by device rather than by key, because a device can be held under a logical
		// resource that reserves it without leasing it, and such an owner would otherwise survive the
		// disappearance of the very device it stands for.
		void this.coordinator.cancelByDevice(key, reason).catch((error: unknown) => console.error('failed to cancel owners of:', key, error))
	}

	// Blocks acquisition while aggregating every live view under one generation guard.
	#validate(key: ResourceKey) {
		const devices = this.#devices.get(key)

		if (devices === undefined || devices.size === 0) return

		const generation = this.#nextValidation(key)
		const first = devices.values().next().value

		if (first === undefined) return

		const physicalDevice = resourceDevice(first.device)
		const pending: Promise<boolean>[] = []

		this.arbiter.markUnavailable({ key, device: physicalDevice })
		this.arbiter.markDeviceUnavailable(key)

		for (const view of devices.values()) {
			if (!view.device.connected) {
				this.#validated(key, generation, false)
				return
			}

			try {
				const available = view.verify()

				if (typeof available === 'boolean') {
					if (!available) {
						this.#validated(key, generation, false)
						return
					}
				} else {
					pending.push(available)
				}
			} catch (error) {
				// A verifier that cannot decide leaves the device blocked, never acquirable by mistake.
				console.error('device availability check failed:', key, error)
				this.#validated(key, generation, false)
				return
			}
		}

		if (pending.length === 0) {
			this.#validated(key, generation, true)
		} else {
			void Promise.all(pending).then(
				(results) => this.#validated(key, generation, results.every(Boolean)),
				(error) => {
					console.error('device availability check failed:', key, error)
					this.#validated(key, generation, false)
				},
			)
		}
	}

	// Applies the latest aggregate result only while the same resource generation remains registered.
	#validated(key: ResourceKey, generation: number, available: boolean) {
		const devices = this.#devices.get(key)

		if (devices === undefined || devices.size === 0 || this.#validationGeneration.get(key) !== generation) return

		const first = devices.values().next().value

		if (first === undefined) return

		const physicalDevice = resourceDevice(first.device)

		if (available) {
			this.arbiter.markAvailable({ key, device: physicalDevice })
			this.arbiter.markDeviceAvailable(key)
		} else {
			this.arbiter.markUnavailable({ key, device: physicalDevice })
			this.arbiter.markDeviceUnavailable(key)
		}
	}

	// Advances the per-resource token used to discard stale asynchronous readiness results.
	#nextValidation(key: ResourceKey) {
		const generation = (this.#validationGeneration.get(key) ?? 0) + 1
		this.#validationGeneration.set(key, generation)
		return generation
	}
}

// Properties read by isDeviceQuiescent for each device type; every other update leaves its verdict intact.
const QUIESCENCE_PROPERTIES: Readonly<Partial<Record<DeviceType, ReadonlySet<string>>>> = {
	camera: new Set(['exposuring', 'exposure']),
	mount: new Set(['slewing', 'moving', 'homing', 'parking', 'pulsing']),
	focuser: new Set(['moving']),
	wheel: new Set(['moving']),
	rotator: new Set(['moving']),
	guideOutput: new Set(['pulsing']),
	cover: new Set(['parking']),
	dome: new Set(['slewing', 'moving', 'homing', 'parking']),
}

// Reports whether a property change can alter the default quiescence verdict for the device.
export function affectsDeviceQuiescence(device: Device, property: string) {
	return property === 'connected' || QUIESCENCE_PROPERTIES[device.type]?.has(property) === true
}

// Checks type-specific motion/exposure flags before a connected device can be acquired.
export function isDeviceQuiescent(device: Device) {
	if (!device.connected) return false

	switch (device.type) {
		case 'camera': {
			const camera = device as Camera
			return !camera.exposuring && camera.exposure.state !== 'Busy'
		}
		case 'mount': {
			const mount = device as Mount
			// Manual axis motion is reported apart from slewing: a driver drives an axis through its motion
			// vectors without necessarily marking the coordinate busy, so a mount someone is moving by hand
			// would otherwise look acquirable to any operation that asked for it.
			return !mount.slewing && !mount.moving && !mount.homing && !mount.parking && !mount.pulsing
		}
		case 'focuser':
			return !(device as Focuser).moving
		case 'wheel':
			return !(device as Wheel).moving
		case 'rotator':
			return !(device as Rotator).moving
		case 'guideOutput':
			return !(device as GuideOutput).pulsing
		case 'cover':
			return !(device as Cover).parking
		case 'dome': {
			const dome = device as Dome
			return !dome.slewing && !dome.moving && !dome.homing && !dome.parking && dome.shutterState !== 'OPENING' && dome.shutterState !== 'CLOSING'
		}
		default:
			return true
	}
}
