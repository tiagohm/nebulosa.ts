import { CLIENT, type Device, type SubDevice } from '../indi/device'

// Resource arbitration for device orchestration. A ResourceArbiter grants atomic, non-blocking, reentrant
// leases over physical devices (keyed by hardware id) and logical resources, tracks durable reservations
// held by long-lived sessions, and records independent unavailability causes such as lifecycle state.
// Records are retained across disconnects and discarded once they carry no state, so device churn does
// not grow memory. Acquisition never waits and never preempts: a conflict is reported immediately.

// Opaque stable identity of one physical or logical resource. A physical key is the device hardware id, an
// MD5 digest of client and name, so it is unique across clients and shared by every interface the same
// driver exposes for one piece of hardware. A resource with no device behind it, such as a remote guider
// session, must use a `logical:` prefix to stay outside that key space.
export type ResourceKey = string

// Observable arbitration state; unavailable takes precedence over an existing lease, which in turn takes
// precedence over a reservation, because a reserved resource is still acquirable by its own reservation.
export type ResourceAvailability = 'available' | 'reserved' | 'leased' | 'unavailable'

// Independent cause blocking acquisition. Each writer clears only its own cause, so a resource
// becomes acquirable again only after every cause has been resolved.
// - lifecycle: device connectivity and physical quiescence, owned by DeviceLifecycle.
// - quarantine: an outstanding driver payload that must be discarded before the device is safe.
export type ResourceUnavailableCause = 'lifecycle' | 'quarantine'

// One resource requested atomically by an operation.
export interface ResourceRequest {
	// Canonical identity used for ordering, conflict checks, and ownership.
	readonly key: ResourceKey
	// Physical device used to index the resource by client and seed its availability.
	readonly device?: Device
}

// Context identity that owns leases; object identity, not just id equality, defines reentrancy.
export interface ResourceOwner {
	// Stable operation identifier exposed to transports and diagnostics.
	readonly id: string
	// Human-readable operation category used in conflict details.
	readonly kind: string
}

// Context identity that owns reservations. Distinct from ResourceOwner because a reservation outlives every
// operation of the session that holds it, and is never itself an operation.
export interface ResourceReservationOwner {
	// Stable reservation identifier exposed to transports and diagnostics.
	readonly id: string
	// Human-readable reservation category used in conflict details.
	readonly kind: string
}

// Proof that the holder may acquire inside a reservation. Identity is by object and the token is never
// serialized into a DTO, an HTTP response, or an event: a value that could be read from outside the process
// could be replayed from outside it, which is exactly the exclusivity the reservation exists to provide.
export interface ReservationToken {
	// Owner of the reservation this token belongs to, carried for diagnostics and owner-scoped cancellation.
	// Possession of the token object, not this value, is what authorizes an acquisition.
	readonly owner: ResourceReservationOwner
}

// Durable logical ownership of a set of resources, independent of any active operation.
export interface ResourceReservation {
	// Identifier of the reservation owner.
	readonly ownerId: string
	// Canonically sorted resource identities currently held by the reservation.
	readonly resources: readonly ResourceKey[]
	// Opaque authorization handed to operations that run inside the reservation.
	readonly token: ReservationToken
	// Releases every resource of the reservation; repeated calls have no effect.
	readonly release: VoidFunction
}

// Why one requested resource was refused, so a caller can tell a transient lease from durable ownership
// and both from a device that is simply not usable right now.
// - lease: another operation tree currently holds it.
// - reservation: another session reserved it for its whole lifetime.
// - unavailable: at least one cause blocks acquisition regardless of ownership.
export type ResourceConflictKind = 'lease' | 'reservation' | 'unavailable'

// Existing owner that prevented one requested resource from being acquired.
export interface ResourceConflict {
	// Conflicting resource identity.
	readonly key: ResourceKey
	// Nature of the refusal.
	readonly by: ResourceConflictKind
	// Identifier of the current owner, or the arbiter sentinel for unavailable resources.
	readonly ownerId: string
	// Category of the current owner, or unavailable for resources blocked by lifecycle.
	readonly ownerKind: string
	// Active causes when the resource is unavailable; empty when another owner holds it.
	readonly causes: readonly ResourceUnavailableCause[]
}

// Atomic acquisition outcome containing either the complete lease or every detected conflict.
export type AcquireResult = { readonly ok: true; readonly lease: ResourceLease } | { readonly ok: false; readonly conflicts: readonly ResourceConflict[] }

// Atomic reservation outcome containing either the whole reservation or every detected conflict.
export type ReserveResult = { readonly ok: true; readonly reservation: ResourceReservation } | { readonly ok: false; readonly conflicts: readonly ResourceConflict[] }

// Read-only projection of one arbitration record, for diagnostics and for the UI.
export interface ResourceSnapshot {
	// Resource identity this snapshot describes.
	readonly key: ResourceKey
	// Effective arbitration state.
	readonly availability: ResourceAvailability
	// Context currently holding a lease, when leased.
	readonly owner?: ResourceOwner
	// Context holding the durable reservation, when reserved.
	readonly reservationOwner?: ResourceReservationOwner
	// Canonically sorted causes blocking acquisition, including a disconnected client.
	readonly causes: readonly ResourceUnavailableCause[]
	// Hardware id of the physical device currently associated with the key, when one is.
	readonly hardwareId?: string
	// Client the associated device belongs to, when one is associated.
	readonly clientId?: string
}

// Idempotently releasable ownership acquired by one context.
export interface ResourceLease {
	// Identifier of the context that acquired the lease.
	readonly ownerId: string
	// Canonically sorted and deduplicated resource identities held by this lease.
	readonly resources: readonly ResourceKey[]
	// Releases only this acquisition depth; repeated calls have no effect.
	readonly release: VoidFunction
}

// Mutable reservation state shared by every record the reservation covers.
interface ReservationRecord {
	// Owner the reservation was created for.
	readonly owner: ResourceReservationOwner
	// Token authorizing acquisitions inside the reservation.
	readonly token: ReservationToken
	// Resource identities currently reserved.
	readonly resources: Set<ResourceKey>
	// Public view returned by reserve, stable across idempotent extensions of the same reservation.
	readonly reservation: ResourceReservation
	// Set on release so a retained token can no longer authorize an acquisition.
	released: boolean
}

// Mutable arbitration record retained across disconnect and reconnect transitions.
interface ResourceRecord {
	// Active causes blocking new acquisitions; empty means no writer is blocking the resource.
	readonly causes: Set<ResourceUnavailableCause>
	// Client index used to cancel every affected owner on client shutdown.
	clientId?: string
	// Latest physical device instance associated with the key.
	device?: Device
	// Context currently holding the resource, when leased.
	owner?: ResourceOwner
	// Durable reservation covering the resource, when reserved.
	reservation?: ReservationRecord
	// Number of active reentrant lease levels held by the same context.
	depth: number
}

// Synthetic conflict owner used because ResourceConflict always carries owner details.
const UNAVAILABLE_OWNER: ResourceOwner = {
	id: 'resource-arbiter',
	kind: 'unavailable',
}

// Builds the canonical resource key from the hardware behind the device view. Every interface of one
// physical device, whether a subdevice proxy or a second top-level device published by the same driver,
// carries the same hardware id, so they are all arbitrated as the single resource they really are.
//
// The rule has no exception, and each co-resident pair the drivers actually produce earns it:
// - camera and wheel, on an integrated filter camera, because a filter that turns during an exposure ruins
//   the frame that is being read out;
// - camera and focuser, because a focus move during an exposure trails every star in it;
// - focuser and rotator, on a combined focus/rotation unit, because rotating the field during a focus scan
//   moves the very stars the curve is measured from, and one controller usually drives one motor at a time;
// - cover and flat panel, on a flip-flat, because the lamp level is only meaningful for a settled cap;
// - camera or focuser and the guide output, thermometer, or dew heater they publish, which are channels of
//   that same body rather than devices of their own.
// A read-only interface such as a thermometer is never acquired, so sharing costs it nothing.
//
// The price is that two interfaces of one device cannot be commanded from two independent operation trees:
// the second attempt is refused as busy rather than queued. That is the intent, and it is not a limit on
// composite features, which pass their own context down and reacquire the same key reentrantly. It does
// mean a feature cannot drive two interfaces of one device in parallel scopes, since sibling scopes of a
// tree still conflict with each other: an integrated camera and wheel have to be commanded in sequence.
export function resourceKey(device: Device): ResourceKey {
	return device.hardwareId
}

// Returns the live physical parent behind a subdevice proxy, or the original device otherwise.
export function resourceDevice(device: Device): Device {
	return device.parentId === undefined ? device : ((device as Partial<SubDevice<Device, Device>>).parent ?? device)
}

// Arbitrates physical and logical resources atomically without waiting or preemption.
export class ResourceArbiter {
	// Arbitration record per resource. Records outlive both leases and device instances, because a
	// disconnect must keep its unavailability while nothing owns the resource.
	readonly #resources = new Map<ResourceKey, ResourceRecord>()
	// Reentrancy depth per owner and resource, mirroring the per-record depth so each lease releases
	// exactly the acquisitions it made and a nested one cannot release its ancestor's hold.
	readonly #ownerResources = new Map<ResourceOwner, Map<ResourceKey, number>>()
	// Clients whose devices refuse acquisition wholesale, set before a disconnect starts cancelling.
	readonly #unavailableClients = new Set<string>()
	// Live reservation per owner, so reserving twice for the same session extends one reservation instead
	// of creating a second one that the first would then conflict with.
	readonly #reservations = new Map<ResourceReservationOwner, ReservationRecord>()

	// Returns the effective state for a key; unknown logical resources start available.
	availability(key: ResourceKey): ResourceAvailability {
		const resource = this.#resources.get(key)

		if (resource === undefined) return 'available'
		if (!this.#available(resource)) return 'unavailable'
		if (resource.owner !== undefined) return 'leased'
		return resource.reservation === undefined ? 'available' : 'reserved'
	}

	// Projects one record into its read-only view; unknown keys report the state of a fresh resource.
	snapshot(key: ResourceKey): ResourceSnapshot {
		const resource = this.#resources.get(key)

		if (resource === undefined) return { key, availability: 'available', causes: [] }

		return {
			key,
			availability: this.availability(key),
			owner: resource.owner,
			reservationOwner: resource.reservation?.owner,
			causes: this.#causesOf(resource),
			hardwareId: resource.device === undefined ? undefined : resourceKey(resource.device),
			clientId: resource.clientId,
		}
	}

	// Clears one cause while retaining any other cause and any existing owner.
	markAvailable(request: ResourceRequest | ResourceKey, cause: ResourceUnavailableCause = 'lifecycle') {
		this.#resource(request).causes.delete(cause)
	}

	// Records one cause blocking acquisition without releasing or replacing an existing owner.
	markUnavailable(request: ResourceRequest | ResourceKey, cause: ResourceUnavailableCause = 'lifecycle') {
		this.#resource(request).causes.add(cause)
	}

	// Blocks existing and future physical resources for a client without disturbing retained owners.
	markClientUnavailable(clientId: string) {
		this.#unavailableClients.add(clientId)
	}

	// Allows lifecycle validation to make resources from a newly connected client available.
	markClientAvailable(clientId: string) {
		this.#unavailableClients.delete(clientId)
	}

	// Adds the lifecycle cause to every logical or physical resource associated with one physical device.
	markDeviceUnavailable(key: ResourceKey) {
		for (const resource of this.#resources.values()) {
			if (resource.device !== undefined && resourceKey(resource.device) === key) resource.causes.add('lifecycle')
		}
	}

	// Clears the lifecycle cause from every resource associated with one physical device after all its views
	// pass validation.
	markDeviceAvailable(key: ResourceKey) {
		for (const resource of this.#resources.values()) {
			if (resource.device !== undefined && resourceKey(resource.device) === key) resource.causes.delete('lifecycle')
		}
	}

	// Clears an exact physical device/client association while retaining availability and ownership; returns whether it matched.
	disassociate(key: ResourceKey, device: Device): boolean {
		const resource = this.#resources.get(key)

		if (resource?.device !== device) return false

		resource.device = undefined
		resource.clientId = undefined

		// A record with nothing left to remember carries no state a future acquisition could not rebuild,
		// so removing it keeps device churn from growing the map for the life of the process. A reservation
		// with no active operation matches every other discard condition, and dropping the record would
		// release it in silence: the session would keep believing it owns the device while a manual command
		// took it the moment it came back.
		this.#discard(key, resource)

		return true
	}

	// Reserves every requested resource for the lifetime of one owner, or returns conflicts having reserved
	// nothing. Every key is checked before any is marked, so a refusal leaves no partial reservation to roll
	// back. Reserving again for the same owner extends the same reservation and is idempotent for keys it
	// already holds.
	//
	// A reservation is logical ownership and says nothing about connectivity: an unavailable resource is
	// reserved successfully and stays unacquirable, because reserving a disconnected device must not make it
	// usable. A lease held by anyone else does refuse the reservation, since the two are mutually exclusive.
	reserve(owner: ResourceReservationOwner, requests: readonly ResourceRequest[]): ReserveResult {
		const normalized = normalizeRequests(requests)
		const conflicts: ResourceConflict[] = []
		const current = this.#reservations.get(owner)

		for (const request of normalized) {
			// As in acquire, a rejected contender must not steal the physical association of an existing record.
			const resource = this.#resource(request, false)

			// A lease taken inside the caller's own reservation belongs to the caller: only its own token could
			// have authorized it. Refusing it would make a session unable to extend a reservation it already
			// holds while one of its actions is commanding a device it reserved.
			const own = current !== undefined && resource.reservation === current

			if (resource.owner !== undefined && !own) {
				conflicts.push(conflict(request.key, 'lease', resource.owner))
			} else if (resource.reservation !== undefined && resource.reservation !== current) {
				conflicts.push(conflict(request.key, 'reservation', resource.reservation.owner))
			}
		}

		if (conflicts.length > 0) return { ok: false, conflicts }

		const record = current ?? this.#createReservation(owner)

		for (const request of normalized) {
			this.#resource(request).reservation = record
			record.resources.add(request.key)
		}

		return { ok: true, reservation: record.reservation }
	}

	// Returns the durable reservation owner of one resource, when reserved.
	reservationOwnerOf(key: ResourceKey): ResourceReservationOwner | undefined {
		return this.#resources.get(key)?.reservation?.owner
	}

	// Acquires every sorted unique request or returns conflicts without retaining a partial lease. A token
	// authorizes acquisition inside its own reservation; every other context conflicts with it. A token whose
	// reservation is no longer live refuses the whole acquisition rather than degrading it to an ordinary one.
	acquire(owner: ResourceOwner, requests: readonly ResourceRequest[], token?: ReservationToken): AcquireResult {
		const normalized = normalizeRequests(requests)
		const conflicts: ResourceConflict[] = []
		const reservation = token === undefined ? undefined : this.#reservations.get(token.owner)
		// A token released while the operation was being started no longer authorizes anything.
		const authorized = reservation !== undefined && reservation.token === token && !reservation.released ? reservation : undefined

		// A dead token must refuse the acquisition instead of falling through to an ordinary one. Releasing a
		// reservation also clears it from every resource it covered, so each check below would find the
		// resource free and hand out a plain lease: a retained scope would keep commanding hardware after the
		// session that owned it finished cancelling, awaited by nobody and cancelled by nobody.
		if (token !== undefined && authorized === undefined) {
			return { ok: false, conflicts: normalized.map((request) => conflict(request.key, 'reservation', token.owner)) }
		}

		for (const request of normalized) {
			// Conflict discovery must not replace the physical association of an existing record. A
			// rejected contender must not make the current owner invisible to device lifecycle cancellation.
			const resource = this.#resource(request, false)

			if (!this.#available(resource)) {
				conflicts.push(conflict(request.key, 'unavailable', UNAVAILABLE_OWNER, this.#causesOf(resource)))
			} else if (resource.owner !== undefined && resource.owner !== owner) {
				conflicts.push(conflict(request.key, 'lease', resource.owner))
			} else if (resource.reservation !== undefined && resource.reservation !== authorized) {
				conflicts.push(conflict(request.key, 'reservation', resource.reservation.owner))
			}
		}

		if (conflicts.length > 0) return { ok: false, conflicts }

		let owned = this.#ownerResources.get(owner)

		if (owned === undefined) {
			owned = new Map()
			this.#ownerResources.set(owner, owned)
		}

		for (const request of normalized) {
			const resource = this.#resource(request)
			resource.owner = owner
			resource.depth++
			owned.set(request.key, (owned.get(request.key) ?? 0) + 1)
		}

		let released = false
		const resources = normalized.map((request) => request.key)

		return {
			ok: true,
			lease: {
				ownerId: owner.id,
				resources,
				release: () => {
					if (released) return
					released = true
					this.#release(owner, resources)
				},
			},
		}
	}

	// Tests ownership by exact context object identity.
	owns(owner: ResourceOwner, key: ResourceKey) {
		return this.#resources.get(key)?.owner === owner
	}

	// Returns the current owner of one resource, when present.
	ownersOf(key: ResourceKey): readonly ResourceOwner[] {
		const owner = this.#resources.get(key)?.owner
		return owner === undefined ? [] : [owner]
	}

	// Returns each distinct owner holding any resource associated with one physical device key.
	// A device is arbitrated under its own key, but an operation may hold it under another name: a logical
	// resource standing for the device reserves it without leasing the device itself. Looking the device up
	// by key alone would miss those holders, and a lifecycle event has to reach every one of them.
	ownersOfDevice(key: ResourceKey): readonly ResourceOwner[] {
		const owners = new Set<ResourceOwner>()

		for (const resource of this.#resources.values()) {
			if (resource.owner !== undefined && resource.device !== undefined && resourceKey(resource.device) === key) {
				owners.add(resource.owner)
			}
		}

		return Array.from(owners)
	}

	// Returns each distinct owner holding any physical resource associated with the client id.
	ownersOfClient(clientId: string): readonly ResourceOwner[] {
		const owners = new Set<ResourceOwner>()

		for (const resource of this.#resources.values()) {
			if (resource.clientId === clientId && resource.owner !== undefined) {
				owners.add(resource.owner)
			}
		}

		return Array.from(owners)
	}

	// Lists the canonically sorted resources currently held by a context across reentrant leases.
	resourcesOf(owner: ResourceOwner): readonly ResourceKey[] {
		return this.#ownerResources.get(owner)?.keys().toArray().sort() ?? []
	}

	// Builds the reservation record and its stable public view. The resource list is derived on read so an
	// idempotent extension of the same reservation stays visible through the object already handed out.
	#createReservation(owner: ResourceReservationOwner) {
		const token: ReservationToken = { owner }
		const resources = new Set<ResourceKey>()

		const record: ReservationRecord = {
			owner,
			token,
			resources,
			released: false,
			reservation: {
				ownerId: owner.id,
				token,
				get resources() {
					return resources.values().toArray().sort()
				},
				release: () => this.#releaseReservation(record),
			},
		}

		this.#reservations.set(owner, record)

		return record
	}

	// Clears the reservation from every record it covers, discarding records that keep no state afterwards.
	#releaseReservation(record: ReservationRecord) {
		if (record.released) return

		record.released = true
		this.#reservations.delete(record.owner)

		for (const key of record.resources) {
			const resource = this.#resources.get(key)

			if (resource?.reservation !== record) continue

			resource.reservation = undefined
			this.#discard(key, resource)
		}

		record.resources.clear()
	}

	// Removes a record that remembers nothing a future acquisition could not rebuild.
	#discard(key: ResourceKey, resource: ResourceRecord) {
		if (resource.device === undefined && resource.owner === undefined && resource.reservation === undefined && resource.causes.size === 0) this.#resources.delete(key)
	}

	// Reports whether every cause has been cleared and the owning client still accepts acquisitions.
	#available(resource: ResourceRecord) {
		return resource.causes.size === 0 && (resource.clientId === undefined || !this.#unavailableClients.has(resource.clientId))
	}

	// Lists why a resource is blocked, reporting a disconnected client as a lifecycle cause of its own.
	#causesOf(resource: ResourceRecord): readonly ResourceUnavailableCause[] {
		const causes = Array.from(resource.causes)
		if (resource.clientId !== undefined && this.#unavailableClients.has(resource.clientId) && !resource.causes.has('lifecycle')) causes.push('lifecycle')
		return causes.sort()
	}

	// Finds or creates the persistent record, optionally retaining an existing physical association while
	// checking a prospective acquisition.
	#resource(request: ResourceRequest | ResourceKey, associate: boolean = true) {
		const key = typeof request === 'string' ? request : request.key
		let resource = this.#resources.get(key)

		if (resource === undefined) {
			const requestedDevice = typeof request === 'string' ? undefined : request.device
			const device = requestedDevice === undefined ? undefined : resourceDevice(requestedDevice)

			resource = {
				causes: new Set(device !== undefined && !device.connected ? (['lifecycle'] as const) : undefined),
				clientId: device?.[CLIENT]?.id ?? device?.client.id,
				device,
				depth: 0,
			}

			this.#resources.set(key, resource)
		} else if (typeof request !== 'string' && request.device !== undefined && (associate || resource.device === undefined)) {
			const device = resourceDevice(request.device)

			// A first physical association seeds connectivity; later ones keep the causes already recorded.
			if (resource.device === undefined && !device.connected) resource.causes.add('lifecycle')

			resource.device = device
			resource.clientId = device[CLIENT]?.id ?? device.client.id
		}

		return resource
	}

	// Decrements this lease's reentrant depths and clears ownership only at depth zero.
	#release(owner: ResourceOwner, keys: readonly ResourceKey[]) {
		const owned = this.#ownerResources.get(owner)

		if (owned === undefined) return

		for (const key of keys) {
			const resource = this.#resources.get(key)
			const depth = owned.get(key)

			if (resource?.owner !== owner || depth === undefined) continue

			if (depth <= 1) {
				owned.delete(key)
			} else {
				owned.set(key, depth - 1)
			}

			resource.depth--

			if (resource.depth <= 0) {
				resource.depth = 0
				resource.owner = undefined
			}
		}

		if (owned.size === 0) this.#ownerResources.delete(owner)
	}
}

// Compares two ResourceRequest by key.
function resourceRequestCompare(a: ResourceRequest, b: ResourceRequest) {
	return a.key.localeCompare(b.key)
}

// Sorts and deduplicates an acquisition batch, retaining a provided device association.
function normalizeRequests(requests: readonly ResourceRequest[]) {
	const normalized = new Map<ResourceKey, ResourceRequest>()

	for (const request of requests) {
		const previous = normalized.get(request.key)
		normalized.set(request.key, previous?.device === undefined && request.device !== undefined ? request : (previous ?? request))
	}

	return normalized.values().toArray().sort(resourceRequestCompare)
}

// Projects an owner into the transport-safe conflict contract.
function conflict(key: ResourceKey, by: ResourceConflictKind, owner: ResourceOwner | ResourceReservationOwner, causes: readonly ResourceUnavailableCause[] = []): ResourceConflict {
	return { key, by, ownerId: owner.id, ownerKind: owner.kind, causes }
}
