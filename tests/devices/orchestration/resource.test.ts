import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import { type Camera, type Focuser, type GuideOutput, type Rotator, type SubDevice, DEFAULT_CAMERA, DEFAULT_FOCUSER, DEFAULT_GUIDE_OUTPUT, DEFAULT_ROTATOR } from '../../../src/devices/indi/device'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../../src/devices/indi/manager/mount'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import { ResourceArbiter, resourceDevice, resourceKey, type ResourceOwner, type ResourceReservationOwner } from '../../../src/devices/orchestration/resource'

const CAMERA = 'camera-1'
const MOUNT = 'mount-1'

function owner(id: string): ResourceOwner {
	return { id, kind: 'test' }
}

function session(id: string): ResourceReservationOwner {
	return { id, kind: 'sequencer' }
}

function camera(connected: boolean): Camera {
	return {
		...structuredClone(DEFAULT_CAMERA),
		id: 'camera-1',
		hardwareId: 'hardware-1',
		name: 'camera-1',
		connected,
		client: { type: 'SIMULATOR', id: 'client' },
	}
}

function focuser(): Focuser {
	return {
		...structuredClone(DEFAULT_FOCUSER),
		id: 'focuser-1',
		hardwareId: 'hardware-2',
		name: 'combo-1',
		interfaces: ['focuser', 'rotator'],
		connected: true,
		client: { type: 'SIMULATOR', id: 'client' },
	}
}

function rotator(): Rotator {
	return {
		...structuredClone(DEFAULT_ROTATOR),
		id: 'rotator-1',
		hardwareId: 'hardware-2',
		name: 'combo-1',
		interfaces: ['focuser', 'rotator'],
		connected: true,
		client: { type: 'SIMULATOR', id: 'client' },
	}
}

function guideOutputProxy(parent: Camera): SubDevice<GuideOutput, Camera> {
	return {
		...structuredClone(DEFAULT_GUIDE_OUTPUT),
		id: 'guide-output-1',
		hardwareId: parent.hardwareId,
		parentId: parent.id,
		parent,
		name: parent.name,
		connected: parent.connected,
		client: parent.client,
	}
}

describe('resource arbiter', () => {
	test('acquires sorted deduplicated resources and releases once', () => {
		const arbiter = new ResourceArbiter()
		const context = owner('owner-1')
		const acquired = arbiter.acquire(context, [{ key: MOUNT }, { key: CAMERA }, { key: MOUNT }])

		expect(acquired.ok).toBeTrue()

		if (!acquired.ok) return

		expect(acquired.lease.resources).toEqual([CAMERA, MOUNT])
		expect(arbiter.availability(CAMERA)).toBe('leased')
		expect(arbiter.availability(MOUNT)).toBe('leased')

		acquired.lease.release()
		acquired.lease.release()

		expect(arbiter.availability(CAMERA)).toBe('available')
		expect(arbiter.availability(MOUNT)).toBe('available')
	})

	test('reports every ownership conflict in canonical order', () => {
		const arbiter = new ResourceArbiter()
		const cameraLease = arbiter.acquire(owner('camera-owner'), [{ key: CAMERA }])
		const mountLease = arbiter.acquire(owner('mount-owner'), [{ key: MOUNT }])

		const conflicted = arbiter.acquire(owner('contender'), [{ key: MOUNT }, { key: CAMERA }])

		expect(cameraLease.ok).toBeTrue()
		expect(mountLease.ok).toBeTrue()
		expect(conflicted).toEqual({
			ok: false,
			conflicts: [
				{ key: CAMERA, by: 'lease', ownerId: 'camera-owner', ownerKind: 'test', causes: [] },
				{ key: MOUNT, by: 'lease', ownerId: 'mount-owner', ownerKind: 'test', causes: [] },
			],
		})
		expect(arbiter.availability(CAMERA)).toBe('leased')
		expect(arbiter.availability(MOUNT)).toBe('leased')

		if (cameraLease.ok) cameraLease.lease.release()
		if (mountLease.ok) mountLease.lease.release()
	})

	test('does not retain a partial lease after a multi-resource conflict', () => {
		const arbiter = new ResourceArbiter()
		const first = arbiter.acquire(owner('owner-1'), [{ key: CAMERA }])
		const secondOwner = owner('owner-2')
		const conflicted = arbiter.acquire(secondOwner, [{ key: MOUNT }, { key: CAMERA }])

		expect(first.ok).toBeTrue()
		expect(conflicted).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'lease', ownerId: 'owner-1', ownerKind: 'test', causes: [] }],
		})
		expect(arbiter.owns(secondOwner, MOUNT)).toBeFalse()

		const mount = arbiter.acquire(owner('owner-3'), [{ key: MOUNT }])
		expect(mount.ok).toBeTrue()
	})

	test('allows reentrancy only for the same context identity', () => {
		const arbiter = new ResourceArbiter()
		const context = owner('same-id')
		const otherContext = owner('same-id')
		const outer = arbiter.acquire(context, [{ key: CAMERA }])
		const inner = arbiter.acquire(context, [{ key: CAMERA }])
		const conflict = arbiter.acquire(otherContext, [{ key: CAMERA }])

		expect(outer.ok).toBeTrue()
		expect(inner.ok).toBeTrue()
		expect(conflict.ok).toBeFalse()

		if (!outer.ok || !inner.ok) return

		inner.lease.release()
		expect(arbiter.owns(context, CAMERA)).toBeTrue()
		expect(arbiter.acquire(otherContext, [{ key: CAMERA }]).ok).toBeFalse()

		outer.lease.release()
		expect(arbiter.acquire(otherContext, [{ key: CAMERA }]).ok).toBeTrue()
	})

	test('keeps an unavailable resource unavailable after its lease is released', () => {
		const arbiter = new ResourceArbiter()
		const acquired = arbiter.acquire(owner('owner-1'), [{ key: CAMERA }])

		expect(acquired.ok).toBeTrue()
		arbiter.markUnavailable(CAMERA)
		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		if (!acquired.ok) return

		acquired.lease.release()
		expect(arbiter.availability(CAMERA)).toBe('unavailable')
		expect(arbiter.acquire(owner('owner-2'), [{ key: CAMERA }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'unavailable', ownerId: 'resource-arbiter', ownerKind: 'unavailable', causes: ['lifecycle'] }],
		})

		arbiter.markAvailable(CAMERA)
		expect(arbiter.availability(CAMERA)).toBe('available')
	})

	test('keeps a resource unavailable until every cause is cleared', () => {
		const arbiter = new ResourceArbiter()

		arbiter.markUnavailable(CAMERA, 'lifecycle')
		arbiter.markUnavailable(CAMERA, 'quarantine')
		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		arbiter.markAvailable(CAMERA, 'quarantine')
		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		arbiter.markAvailable(CAMERA, 'lifecycle')
		expect(arbiter.availability(CAMERA)).toBe('available')
	})

	test('keeps a client-blocked lease owned until the client reconnects', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const context = owner('owner-1')
		const acquired = arbiter.acquire(context, [{ key: CAMERA, device }])

		expect(acquired.ok).toBeTrue()
		arbiter.markClientUnavailable(device.client.id)

		expect(arbiter.availability(CAMERA)).toBe('unavailable')
		expect(arbiter.ownersOf(CAMERA)).toEqual([context])
		expect(arbiter.acquire(owner('owner-2'), [{ key: CAMERA, device }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'unavailable', ownerId: 'resource-arbiter', ownerKind: 'unavailable', causes: ['lifecycle'] }],
		})

		arbiter.markClientAvailable(device.client.id)
		expect(arbiter.availability(CAMERA)).toBe('leased')

		if (acquired.ok) acquired.lease.release()
		expect(arbiter.availability(CAMERA)).toBe('available')
	})

	test('lists the sorted resources held by a context across reentrant leases', () => {
		const arbiter = new ResourceArbiter()
		const context = owner('owner-1')
		const outer = arbiter.acquire(context, [{ key: MOUNT }, { key: CAMERA }])
		const inner = arbiter.acquire(context, [{ key: CAMERA }])

		expect(outer.ok).toBeTrue()
		expect(inner.ok).toBeTrue()
		expect(arbiter.resourcesOf(context)).toEqual([CAMERA, MOUNT])
		expect(arbiter.resourcesOf(owner('owner-2'))).toEqual([])

		if (!outer.ok || !inner.ok) return

		inner.lease.release()
		expect(arbiter.resourcesOf(context)).toEqual([CAMERA, MOUNT])

		outer.lease.release()
		expect(arbiter.resourcesOf(context)).toEqual([])
	})

	test('retains a physical association when duplicate requests differ by device metadata', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const context = owner('owner-1')
		const acquired = arbiter.acquire(context, [{ key: CAMERA }, { key: CAMERA, device }, { key: MOUNT, device }, { key: MOUNT }])

		expect(acquired.ok).toBeTrue()
		expect(arbiter.ownersOfClient(device.client.id)).toEqual([context])

		if (!acquired.ok) return

		acquired.lease.release()
		expect(arbiter.disassociate(CAMERA, device)).toBeTrue()
		expect(arbiter.disassociate(MOUNT, device)).toBeTrue()
	})

	test('retains the owning device association when a contender conflicts', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const contender = camera(true)
		contender.id = 'camera-2'
		contender.hardwareId = 'hardware-2'
		const logicalKey = 'logical:camera'
		const context = owner('owner-1')

		const acquired = arbiter.acquire(context, [{ key: logicalKey, device }])
		const conflicted = arbiter.acquire(owner('owner-2'), [{ key: logicalKey, device: contender }])

		expect(acquired.ok).toBeTrue()
		expect(conflicted).toEqual({
			ok: false,
			conflicts: [{ key: logicalKey, by: 'lease', ownerId: 'owner-1', ownerKind: 'test', causes: [] }],
		})
		expect(arbiter.ownersOfDevice(resourceKey(device))).toEqual([context])
		expect(arbiter.ownersOfDevice(resourceKey(contender))).toEqual([])

		if (acquired.ok) acquired.lease.release()
	})

	test('keeps an active cause after the physical device is disassociated', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)

		arbiter.markUnavailable({ key: CAMERA, device }, 'quarantine')

		expect(arbiter.disassociate(CAMERA, device)).toBeTrue()
		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		arbiter.markAvailable(CAMERA, 'quarantine')
		expect(arbiter.availability(CAMERA)).toBe('available')
	})

	test('reports every active cause on a conflict', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)

		arbiter.markUnavailable({ key: CAMERA, device }, 'quarantine')
		arbiter.markClientUnavailable(device.client.id)

		const conflicted = arbiter.acquire(owner('owner-1'), [{ key: CAMERA, device }])

		expect(conflicted).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'unavailable', ownerId: 'resource-arbiter', ownerKind: 'unavailable', causes: ['lifecycle', 'quarantine'] }],
		})
	})

	test('seeds availability when a device is associated after logical use', () => {
		const arbiter = new ResourceArbiter()
		const logical = arbiter.acquire(owner('owner-1'), [{ key: CAMERA }])

		expect(logical.ok).toBeTrue()

		if (!logical.ok) return

		logical.lease.release()
		const disconnected = camera(false)

		expect(arbiter.acquire(owner('owner-2'), [{ key: CAMERA, device: disconnected }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'unavailable', ownerId: 'resource-arbiter', ownerKind: 'unavailable', causes: ['lifecycle'] }],
		})

		arbiter.markAvailable(CAMERA)
		expect(arbiter.acquire(owner('owner-3'), [{ key: CAMERA, device: disconnected }]).ok).toBeTrue()
	})

	test('disassociates only the matching physical device', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const replacement = camera(true)
		const context = owner('owner-1')
		const acquired = arbiter.acquire(context, [{ key: CAMERA, device }])

		expect(acquired.ok).toBeTrue()
		arbiter.markUnavailable({ key: CAMERA, device })
		expect(arbiter.disassociate(CAMERA, replacement)).toBeFalse()
		expect(arbiter.ownersOfClient('client')).toEqual([context])

		expect(arbiter.disassociate(CAMERA, device)).toBeTrue()
		expect(arbiter.ownersOfClient('client')).toEqual([])
		expect(arbiter.availability(CAMERA)).toBe('unavailable')
	})

	test('blocks existing and future resources until a client reconnects', () => {
		const arbiter = new ResourceArbiter()
		const first = camera(true)

		arbiter.markAvailable({ key: CAMERA, device: first })
		arbiter.markClientUnavailable(first.client.id)

		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		const second = camera(true)
		second.id = 'camera-2'
		const secondKey = resourceKey(second)
		arbiter.markAvailable({ key: secondKey, device: second })

		expect(arbiter.availability(secondKey)).toBe('unavailable')

		arbiter.markClientAvailable(first.client.id)
		arbiter.markAvailable({ key: CAMERA, device: first })
		arbiter.markAvailable({ key: secondKey, device: second })

		expect(arbiter.availability(CAMERA)).toBe('available')
		expect(arbiter.availability(secondKey)).toBe('available')
	})

	test('associates a subdevice lease with its physical parent identity', () => {
		const arbiter = new ResourceArbiter()
		const parent = camera(true)
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(proxy)
		const context = owner('owner-1')

		expect(key).toBe(parent.hardwareId)
		expect(resourceDevice(proxy)).toBe(parent)
		expect(arbiter.acquire(context, [{ key, device: proxy }]).ok).toBeTrue()
		expect(arbiter.ownersOfClient(parent.client.id)).toEqual([context])
		expect(arbiter.disassociate(key, parent)).toBeTrue()
		expect(arbiter.ownersOfClient(parent.client.id)).toEqual([])
	})

	test('arbitrates two top-level interfaces of one physical device as a single resource', () => {
		const arbiter = new ResourceArbiter()
		const focusing = focuser()
		const rotating = rotator()
		const key = resourceKey(focusing)
		const first = owner('owner-1')
		const second = owner('owner-2')

		expect(focusing.id).not.toBe(rotating.id)
		expect(focusing.parentId).toBeUndefined()
		expect(rotating.parentId).toBeUndefined()
		expect(resourceKey(rotating)).toBe(key)

		expect(arbiter.acquire(first, [{ key, device: focusing }]).ok).toBeTrue()

		const contended = arbiter.acquire(second, [{ key: resourceKey(rotating), device: rotating }])

		expect(contended.ok).toBeFalse()
		expect(!contended.ok && contended.conflicts).toEqual([{ key, by: 'lease', ownerId: 'owner-1', ownerKind: 'test', causes: [] }])
	})

	test('resolves the physical parent from a real manager proxy', () => {
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)
		const handler = new IndiClientHandlerSet([mountManager, guideOutputManager])
		using client = new ClientSimulator('client', handler)
		using simulator = new MountSimulator('Mount Simulator', client)
		const parent = mountManager.get(client, simulator.name)!

		mountManager.connect(parent)

		const proxy = guideOutputManager.get(client, simulator.name)!

		expect(proxy.parentId).toBe(parent.id)
		expect(resourceKey(proxy)).toBe(resourceKey(parent))
		expect(resourceDevice(proxy)).toBe(parent)
	})
})

describe('resource reservation', () => {
	test('reserves every requested resource and releases it once', () => {
		const arbiter = new ResourceArbiter()
		const reserved = arbiter.reserve(session('session-1'), [{ key: MOUNT }, { key: CAMERA }, { key: MOUNT }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		expect(reserved.reservation.ownerId).toBe('session-1')
		expect(reserved.reservation.resources).toEqual([CAMERA, MOUNT])
		expect(arbiter.availability(CAMERA)).toBe('reserved')
		expect(arbiter.reservationOwnerOf(MOUNT)?.id).toBe('session-1')

		reserved.reservation.release()
		reserved.reservation.release()

		expect(arbiter.availability(CAMERA)).toBe('available')
		expect(arbiter.reservationOwnerOf(MOUNT)).toBeUndefined()
	})

	test('refuses a third party and admits the reservation token', () => {
		const arbiter = new ResourceArbiter()
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		expect(arbiter.acquire(owner('manual'), [{ key: CAMERA }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'reservation', ownerId: 'session-1', ownerKind: 'sequencer', causes: [] }],
		})

		const inside = arbiter.acquire(owner('action-1'), [{ key: CAMERA }], reserved.reservation.token)

		expect(inside.ok).toBeTrue()
		expect(arbiter.availability(CAMERA)).toBe('leased')

		if (inside.ok) inside.lease.release()

		expect(arbiter.availability(CAMERA)).toBe('reserved')
	})

	test('keeps two operations of one reservation exclusive over the same resource', () => {
		const arbiter = new ResourceArbiter()
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA }, { key: MOUNT }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		const token = reserved.reservation.token
		const first = arbiter.acquire(owner('action-1'), [{ key: CAMERA }], token)
		const second = arbiter.acquire(owner('action-2'), [{ key: CAMERA }], token)
		const other = arbiter.acquire(owner('action-3'), [{ key: MOUNT }], token)

		expect(first.ok).toBeTrue()
		expect(second).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'lease', ownerId: 'action-1', ownerKind: 'test', causes: [] }],
		})
		expect(other.ok).toBeTrue()
	})

	test('rejects a reservation without reserving anything when one resource is taken', () => {
		const arbiter = new ResourceArbiter()
		const guiding = arbiter.acquire(owner('guider-session'), [{ key: 'logical:guider:camera' }])
		const first = arbiter.reserve(session('session-1'), [{ key: CAMERA }])
		const contender = arbiter.reserve(session('session-2'), [{ key: MOUNT }, { key: CAMERA }, { key: 'logical:guider:camera' }])

		expect(guiding.ok).toBeTrue()
		expect(first.ok).toBeTrue()
		expect(contender).toEqual({
			ok: false,
			conflicts: [
				{ key: CAMERA, by: 'reservation', ownerId: 'session-1', ownerKind: 'sequencer', causes: [] },
				{ key: 'logical:guider:camera', by: 'lease', ownerId: 'guider-session', ownerKind: 'test', causes: [] },
			],
		})
		expect(arbiter.availability(MOUNT)).toBe('available')
	})

	test('extends the same reservation when the owner reserves again', () => {
		const arbiter = new ResourceArbiter()
		const owner = session('session-1')
		const first = arbiter.reserve(owner, [{ key: CAMERA }])
		const second = arbiter.reserve(owner, [{ key: CAMERA }, { key: MOUNT }])

		expect(first.ok).toBeTrue()
		expect(second.ok).toBeTrue()

		if (!first.ok || !second.ok) return

		expect(second.reservation).toBe(first.reservation)
		expect(first.reservation.resources).toEqual([CAMERA, MOUNT])

		second.reservation.release()

		expect(arbiter.availability(MOUNT)).toBe('available')
	})

	test('extends a reservation while its own operation holds the lease', () => {
		const arbiter = new ResourceArbiter()
		const reservationOwner = session('session-1')
		const first = arbiter.reserve(reservationOwner, [{ key: CAMERA }])

		expect(first.ok).toBeTrue()

		if (!first.ok) return

		const acquired = arbiter.acquire(owner('action-1'), [{ key: CAMERA }], first.reservation.token)

		expect(acquired.ok).toBeTrue()

		const second = arbiter.reserve(reservationOwner, [{ key: CAMERA }, { key: MOUNT }])

		expect(second.ok).toBeTrue()

		if (!second.ok) return

		expect(second.reservation).toBe(first.reservation)
		expect(second.reservation.resources).toEqual([CAMERA, MOUNT])
	})

	test('refuses a reservation over a resource leased outside of it', () => {
		const arbiter = new ResourceArbiter()
		const acquired = arbiter.acquire(owner('manual'), [{ key: CAMERA }])

		expect(acquired.ok).toBeTrue()
		expect(arbiter.reserve(session('session-1'), [{ key: CAMERA }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'lease', ownerId: 'manual', ownerKind: 'test', causes: [] }],
		})
	})

	test('reserves a disconnected device without making it acquirable', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(false)
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA, device }])

		expect(reserved.ok).toBeTrue()
		expect(arbiter.availability(CAMERA)).toBe('unavailable')

		if (!reserved.ok) return

		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA }], reserved.reservation.token)).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'unavailable', ownerId: 'resource-arbiter', ownerKind: 'unavailable', causes: ['lifecycle'] }],
		})

		arbiter.markAvailable(CAMERA)

		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA }], reserved.reservation.token).ok).toBeTrue()
	})

	test('stops authorizing acquisitions after the reservation is released', () => {
		const arbiter = new ResourceArbiter()
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		const token = reserved.reservation.token
		reserved.reservation.release()

		const contender = arbiter.reserve(session('session-2'), [{ key: CAMERA }])

		expect(contender.ok).toBeTrue()

		// The dead token is the refusal, and it names the reservation that no longer exists rather than the
		// one that took its place: the caller acquiring with it is the thing that has to be fixed.
		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA }], token)).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'reservation', ownerId: 'session-1', ownerKind: 'sequencer', causes: [] }],
		})

		// An acquisition with no token still meets the reservation that actually holds the resource.
		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA }])).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'reservation', ownerId: 'session-2', ownerKind: 'sequencer', causes: [] }],
		})
	})

	test('refuses a released token even when the resource is free', () => {
		const arbiter = new ResourceArbiter()
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		const token = reserved.reservation.token
		reserved.reservation.release()

		expect(arbiter.availability(CAMERA)).toBe('available')
		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA }], token)).toEqual({
			ok: false,
			conflicts: [{ key: CAMERA, by: 'reservation', ownerId: 'session-1', ownerKind: 'sequencer', causes: [] }],
		})

		// The refusal retained nothing, so the resource is still free for an unreserved acquisition.
		expect(arbiter.acquire(owner('action-2'), [{ key: CAMERA }]).ok).toBeTrue()
	})

	test('survives the removal and the re-addition of the reserved device', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const reserved = arbiter.reserve(session('session-1'), [{ key: CAMERA, device }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		// Removal as the lifecycle performs it: block the resource, then drop the physical association.
		arbiter.markUnavailable({ key: CAMERA, device })
		expect(arbiter.disassociate(CAMERA, device)).toBeTrue()
		expect(arbiter.reservationOwnerOf(CAMERA)?.id).toBe('session-1')

		// Clearing the cause with no device left must not hand the reserved key to a third party.
		arbiter.markAvailable(CAMERA)
		expect(arbiter.availability(CAMERA)).toBe('reserved')
		expect(arbiter.reserve(session('session-2'), [{ key: CAMERA }]).ok).toBeFalse()

		const readded = camera(true)

		expect(arbiter.acquire(owner('action-1'), [{ key: CAMERA, device: readded }], reserved.reservation.token).ok).toBeTrue()

		reserved.reservation.release()
	})

	test('projects availability, ownership, causes, and association into a snapshot', () => {
		const arbiter = new ResourceArbiter()
		const device = camera(true)
		const reservationOwner = session('session-1')
		const reserved = arbiter.reserve(reservationOwner, [{ key: CAMERA, device }])

		expect(reserved.ok).toBeTrue()

		if (!reserved.ok) return

		expect(arbiter.snapshot(MOUNT)).toEqual({ key: MOUNT, availability: 'available', causes: [] })
		expect(arbiter.snapshot(CAMERA)).toEqual({
			key: CAMERA,
			availability: 'reserved',
			owner: undefined,
			reservationOwner,
			causes: [],
			hardwareId: device.hardwareId,
			clientId: device.client.id,
		})

		const context = owner('action-1')
		const acquired = arbiter.acquire(context, [{ key: CAMERA }], reserved.reservation.token)
		arbiter.markUnavailable(CAMERA, 'quarantine')

		expect(acquired.ok).toBeTrue()
		expect(arbiter.snapshot(CAMERA)).toMatchObject({ availability: 'unavailable', owner: context, reservationOwner, causes: ['quarantine'] })
	})
})
