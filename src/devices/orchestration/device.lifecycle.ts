import type { Camera, Cover, Device, DeviceType, Dome, Focuser, GuideOutput, Mount, Rotator, Wheel } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import { OperationCoordinator, type OperationFailureReason } from './operation'
import { deviceKey, resourceDevice, resourceKey, ResourceArbiter, type ResourceKey } from './resource'

// Device lifecycle bridge for orchestration. DeviceLifecycle observes INDI device managers and turns their
// added/updated/removed events into resource availability: a capability is acquirable only while its device
// is connected and every view of that capability is physically quiescent, and a disconnect or removal of
// any view cancels every operation holding any capability of the device. Manager views are grouped by
// physical device (`deviceKey`) for connectivity and cancellation, and by capability (`resourceKey`) for
// quiescence, so the ST4 port of a camera can be granted while its sensor exposes, and the other way around.

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

// One manager-specific view contributing readiness to one capability of a physical device.
interface DeviceView {
	// Exact device or subdevice instance emitted by its manager.
	readonly device: Device
	// Capability whose availability this view's quiescence decides (`resourceKey(device)`).
	readonly key: ResourceKey
	// Evaluates type-specific quiescence for this view.
	readonly verify: () => boolean | Promise<boolean>
}

// Bridges manager add/update/remove events into availability and operation cancellation.
export class DeviceLifecycle {
	// Live views per physical device (`deviceKey`). One device can carry several instances, since a camera and
	// the guide output it exposes are separate manager objects over a single physical device, whether they
	// share one capability or not.
	readonly #devices = new Map<ResourceKey, Map<Device, DeviceView>>()
	// Per-capability token discarding readiness results from a verification a newer transition superseded.
	readonly #validationGeneration = new Map<ResourceKey, number>()
	// Manager observers to detach on disposal.
	readonly #registrations = new Set<Registration>()

	// Creates the lifecycle bridge over the process-wide arbiter and coordinator.
	constructor(
		readonly arbiter: ResourceArbiter,
		readonly coordinator: OperationCoordinator,
	) {}

	// Observes existing and future devices from one manager and returns an idempotent disposer. Disposing
	// forgets the views this manager contributed: a capability left without any view becomes unavailable, since
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

		// A manager may also report devices it does not own, as the guide output manager does for the mount or
		// camera behind each of its proxies. Those views belong to another observer, whose verify and affects
		// rules apply to them, so only the views this observer contributed are acted on.
		const handler: DeviceHandler<D> = {
			added,
			updated: (device, property) => {
				if (contributed.has(device)) this.#updated(device, property, affects)
			},
			removed: (device) => {
				if (contributed.delete(device)) this.#removed(device)
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

	// Drops one view of a disposed observer without cancelling its owners. A capability left without any view
	// becomes unavailable, since nothing would revalidate it; one that keeps views is revalidated without the
	// dropped one. Generations keep advancing rather than being reset, so a verification still in flight can
	// never match a later registration of the key.
	#forget(device: Device) {
		const hardware = deviceKey(device)
		const views = this.#devices.get(hardware)
		const view = views?.get(device)

		if (views === undefined || view === undefined) return

		views.delete(device)
		if (views.size === 0) this.#devices.delete(hardware)

		if (this.#views(hardware, view.key).length > 0) {
			this.#validate(hardware, view.key)
		} else {
			this.#nextValidation(view.key)
			this.arbiter.markUnavailable({ key: view.key, device })
			this.arbiter.markCapabilityUnavailable(view.key)
		}
	}

	// Registers a new instance as unavailable until the quiescence check of its capability succeeds.
	#added<D extends Device>(device: D, verify: DeviceAvailabilityVerifier<D>) {
		const hardware = deviceKey(device)
		const key = resourceKey(device)
		let views = this.#devices.get(hardware)

		if (views === undefined) {
			views = new Map()
			this.#devices.set(hardware, views)
		}

		views.set(device, { device, key, verify: () => verify(device) })
		this.arbiter.markUnavailable({ key, device })
		this.#validate(hardware, key)
	}

	// Cancels on disconnect and revalidates only the updates that can change quiescence. The view keeps the
	// verifier it was added with. A reconnection revalidates every capability of the device: connectivity is
	// physical, and only one of its views is guaranteed to report the change, since the managers share the
	// underlying fields and the second one to see a value finds it unchanged.
	#updated<D extends Device>(device: D, property: keyof D & string, affects: DeviceQuiescenceFilter<D>) {
		const hardware = deviceKey(device)
		const view = this.#devices.get(hardware)?.get(device)

		if (view === undefined) return

		if (property === 'connected' && !device.connected) {
			this.#invalidate(hardware, 'disconnected')
		} else if (property === 'connected' && device.connected) {
			for (const key of this.#capabilities(hardware)) this.#validate(hardware, key)
		} else if (device.connected && affects(device, property)) {
			// Revalidating on unrelated traffic such as temperature, or another capability of the device, would
			// also advance the generation and discard any verification still in flight, which an asynchronous
			// verifier could never survive.
			this.#validate(hardware, view.key)
		}
	}

	// Cancels every owner of the device on any removed view, and releases the association of a capability only
	// after its last view disappears; the remaining capabilities are revalidated without the removed view.
	#removed(device: Device) {
		const hardware = deviceKey(device)
		const views = this.#devices.get(hardware)
		const view = views?.get(device)

		if (views === undefined || view === undefined) return

		this.#invalidate(hardware, 'removed')
		views.delete(device)
		if (views.size === 0) this.#devices.delete(hardware)

		if (this.#views(hardware, view.key).length === 0) this.arbiter.disassociate(view.key, resourceDevice(device))

		for (const key of this.#capabilities(hardware)) this.#validate(hardware, key)
	}

	// Invalidates pending verification of every capability of the device and starts cancellation without
	// waiting inside manager callbacks.
	#invalidate(hardware: ResourceKey, reason: OperationFailureReason) {
		for (const view of this.#devices.get(hardware)?.values() ?? []) {
			this.#nextValidation(view.key)
			this.arbiter.markUnavailable({ key: view.key, device: view.device })
		}

		this.arbiter.markDeviceUnavailable(hardware)
		// Cancellation aborts owners synchronously; only its cleanup is awaited, and a manager callback is
		// the wrong place to block. The resource stays unavailable either way, so a failure is reported.
		// Owners are looked up by device rather than by key, because a device can be held under several
		// capabilities and under a logical resource that reserves it without leasing it, and such an owner
		// would otherwise survive the disappearance of the very device it stands for.
		void this.coordinator.cancelByDevice(hardware, reason).catch((error: unknown) => console.error('failed to cancel owners of:', hardware, error))
	}

	// Blocks acquisition of one capability while aggregating every live view of it under one generation guard.
	#validate(hardware: ResourceKey, key: ResourceKey) {
		const views = this.#views(hardware, key)

		if (views.length === 0) return

		const generation = this.#nextValidation(key)
		const pending: Promise<boolean>[] = []

		this.arbiter.markUnavailable({ key, device: views[0].device })
		this.arbiter.markCapabilityUnavailable(key)

		for (const view of views) {
			if (!view.device.connected) {
				this.#validated(hardware, key, generation, false)
				return
			}

			try {
				const available = view.verify()

				if (typeof available === 'boolean') {
					if (!available) {
						this.#validated(hardware, key, generation, false)
						return
					}
				} else {
					pending.push(available)
				}
			} catch (error) {
				// A verifier that cannot decide leaves the capability blocked, never acquirable by mistake.
				console.error('device availability check failed:', key, error)
				this.#validated(hardware, key, generation, false)
				return
			}
		}

		if (pending.length === 0) {
			this.#validated(hardware, key, generation, true)
		} else {
			void Promise.all(pending).then(
				(results) => this.#validated(hardware, key, generation, results.every(Boolean)),
				(error) => {
					console.error('device availability check failed:', key, error)
					this.#validated(hardware, key, generation, false)
				},
			)
		}
	}

	// Applies the latest aggregate result only while the same capability generation remains registered.
	#validated(hardware: ResourceKey, key: ResourceKey, generation: number, available: boolean) {
		const views = this.#views(hardware, key)

		if (views.length === 0 || this.#validationGeneration.get(key) !== generation) return

		const request = { key, device: views[0].device }

		if (available) {
			this.arbiter.markAvailable(request)
			this.arbiter.markCapabilityAvailable(key)
		} else {
			this.arbiter.markUnavailable(request)
			this.arbiter.markCapabilityUnavailable(key)
		}
	}

	// Lists the live views of one capability of a physical device, in registration order.
	#views(hardware: ResourceKey, key: ResourceKey) {
		const views: DeviceView[] = []

		for (const view of this.#devices.get(hardware)?.values() ?? []) {
			if (view.key === key) views.push(view)
		}

		return views
	}

	// Lists the distinct capabilities the live views of a physical device decide.
	#capabilities(hardware: ResourceKey) {
		const keys = new Set<ResourceKey>()
		for (const view of this.#devices.get(hardware)?.values() ?? []) keys.add(view.key)
		return keys
	}

	// Advances the per-capability token used to discard stale asynchronous readiness results.
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
	dome: new Set(['slewing']),
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
		case 'dome':
			// The manager aggregates azimuth, altitude, home, park and shutter motion into slewing.
			return !(device as Dome).slewing
		default:
			return true
	}
}
