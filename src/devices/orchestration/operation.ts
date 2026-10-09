import { errorMessage } from '../../core/util'
import { type ReservationToken, type ResourceConflict, type ResourceKey, type ResourceLease, type ResourceOwner, type ResourceRequest, type ResourceReservation, type ResourceReservationOwner, ResourceArbiter } from './resource'

// Operation lifetimes for device orchestration. An OperationCoordinator acquires resources atomically
// through a ResourceArbiter, runs an executor inside a cancellable operation tree, unwinds nested scopes
// and LIFO cleanups before releasing the lease, and resolves a total OperationResult that never rejects.
// Expected failures are values of the OperationFailureReason union rather than exceptions.

// Expected operational terminal causes that callers can handle without exceptions.
// - busy: a requested resource was leased, reserved, or unavailable at start.
// - aborted: the operation was cancelled by its caller or by an ancestor.
// - disconnected: a device the operation held disconnected.
// - removed: a device the operation held was removed by its manager.
// - timeout: the device did not reach the expected state in time.
// - alert: the device reported an Alert state.
// - commandFailed: a command threw, or the executor or a cleanup failed unexpectedly.
// - unexpectedState: the device reported a state that contradicts the command.
export type OperationFailureReason = 'busy' | 'aborted' | 'disconnected' | 'removed' | 'timeout' | 'alert' | 'commandFailed' | 'unexpectedState'

// Failed terminal outcome carrying its cause and an optional human-readable detail.
export interface FailedOperationResult {
	// Discriminant of a failed outcome.
	readonly ok: false
	// Expected cause of the failure.
	readonly reason: OperationFailureReason
	// Diagnostic detail; absent rather than undefined when there is none.
	readonly error?: string
}

// Successful terminal outcome carrying the operation value.
export interface SuccessfulOperationResult<T = never> {
	// Discriminant of a successful outcome.
	readonly ok: true
	// Value produced by the operation.
	readonly value: T
}

// Discriminated terminal outcome for expected success and operational failure.
export type OperationResult<T> = FailedOperationResult | SuccessfulOperationResult<T>

// Builds a failed outcome, omitting the detail property entirely when there is no message. An explicit
// `error: undefined` would make the result a partial match only against outcomes that carry no detail,
// which silently breaks every `toMatchObject(failedOperationResult(reason))` comparison.
export function failedOperationResult(reason: OperationFailureReason, error?: string): FailedOperationResult {
	return error === undefined ? { ok: false, reason } : { ok: false, reason, error }
}

// Builds a successful outcome wrapping the value without copying it.
export function successfulOperationResult<T>(value: T): SuccessfulOperationResult<T> {
	return { ok: true, value }
}

// Anything able to start an operation. The coordinator opens a new tree; a context nests inside its own,
// so a service takes one scope parameter and behaves identically whether it runs top-level or composed.
export interface OperationScope {
	// Acquires the requested resources and runs the executor, returning a busy handle on conflict.
	readonly start: <T>(kind: string, resources: readonly ResourceRequest[], executor: OperationExecutor<T>) => OperationHandle<T>
}

// Ownership, cancellation, and cleanup scope of one operation within a tree.
export interface OperationContext extends OperationScope {
	// Stable operation identifier.
	readonly id: string
	// Human-readable operation category.
	readonly kind: string
	// Cancellation signal of this scope; aborting an ancestor aborts it too.
	readonly signal: AbortSignal
	// Checks whether this scope or one of its ancestors holds the resource.
	readonly owns: (resource: ResourceKey) => boolean
	// Registers cleanup in LIFO order and returns an idempotent unregister function.
	readonly onCleanup: (cleanup: () => void | Promise<void>) => VoidFunction
}

// Public control and result surface for one top-level operation.
export interface OperationHandle<T> {
	// Stable operation identifier.
	readonly id: string
	// Human-readable operation category.
	readonly kind: string
	// Signal aborted synchronously when cancellation begins.
	readonly signal: AbortSignal
	// Terminal result resolved only after cleanup and lease release; never rejects.
	readonly result: Promise<OperationResult<T>>
	// Requests idempotent cancellation and waits for cleanup completion.
	readonly cancel: (reason?: OperationFailureReason) => Promise<void>
}

// Work invoked after acquisition that reports expected success or failure without routine exceptions.
export type OperationExecutor<T> = (context: OperationContext) => OperationResult<T> | Promise<OperationResult<T>>

// Cleanup step that may quiesce a device asynchronously.
type Cleanup = () => void | Promise<void>

// Internal terminal value preserving unexpected exceptions outside OperationResult.
type Terminal<T> = { readonly result: OperationResult<T> } | { readonly error: unknown }

// Distinct stack entry retained so each unregister function removes its own cleanup registration.
interface CleanupRegistration {
	// Cleanup callback invoked when this registration remains active at finalization.
	readonly cleanup: Cleanup
}

// Mutable state retained until cleanup and lease release complete.
interface ActiveOperation<T> {
	// Context of this scope; only the root's context is used as the arbiter owner token.
	readonly context: OperationContext
	// Enclosing scope, absent on the root of an operation tree.
	readonly parent?: ActiveOperation<unknown>
	// Nested scopes that must stop before this one undoes its own work.
	readonly children: Set<ActiveOperation<unknown>>
	// Holder stack per resource, meaningful only on the root. Because a scope that does not enclose the
	// current holder is refused, each stack is an ancestor chain whose top is the innermost holder.
	readonly holders: Map<ResourceKey, ActiveOperation<unknown>[]>
	// Sole abort source for the operation tree.
	readonly controller: AbortController
	// Public handle returned to callers.
	readonly handle: OperationHandle<T>
	// Resolver for the public terminal result.
	readonly result: PromiseWithResolvers<OperationResult<T>>
	// Cleanup stack in registration order.
	readonly cleanups: CleanupRegistration[]
	// Completion resolver used by idempotent cancellation calls.
	readonly completion: PromiseWithResolvers<void>
	// Reservation this tree runs inside, retained on the root and inherited by every nested scope.
	readonly token?: ReservationToken
	// Atomic resource lease, absent only for busy operations.
	lease?: ResourceLease
	// First cancellation cause reported after the executor has stopped.
	cancelReason?: OperationFailureReason
	// Prevents cleanup registration after terminalization starts.
	cleanupStarted: boolean
	// Exactly-once guard for all terminal paths.
	terminalStarted: boolean
}

// Owns operation lifetimes and releases resources after LIFO cleanup.
export class OperationCoordinator {
	// Every live scope of every tree, by operation id. Entries are removed during finalization, so a
	// completed operation is no longer reachable and cannot be canceled twice.
	readonly #operations = new Map<string, ActiveOperation<unknown>>()
	// Roots only, keyed by the context the arbiter holds as owner token. This is what turns an arbiter
	// answer such as "who owns this camera" back into an operation the coordinator can cancel.
	readonly #operationsByOwner = new Map<ResourceOwner, ActiveOperation<unknown>>()
	// Roots started inside a reservation, grouped by reservation owner. A session cannot cancel "its"
	// operations through the handles it kept, because a service such as the guider owns a root of its own;
	// the reservation owner is the only criterion that reaches every one of them.
	readonly #operationsByReservationOwner = new Map<ResourceReservationOwner, Set<ActiveOperation<unknown>>>()
	// Tokens of the reservations that have been cancelled. Cancelling one closes it to new roots for good: a
	// root opened during the drain would not be in the set that cancellation is awaiting, and one opened after
	// it would be awaited and aborted by nobody, since the caller cancels precisely because it is done with
	// the reservation. Weakly held so a token forgotten with its session does not stay here for the life of
	// the process.
	readonly #cancelledReservations = new WeakSet<ReservationToken>()
	// Token each reservation owner is currently running under, recorded when its scope is built so that a
	// cancellation closes the reservation even when it has not started a single tree yet. Weakly held for the
	// same reason.
	readonly #reservationTokens = new WeakMap<ResourceReservationOwner, ReservationToken>()

	// Creates a coordinator over the process-wide resource arbiter.
	constructor(readonly arbiter: ResourceArbiter) {}

	// Acquires all resources and starts a new operation tree, returning an immediate busy handle on conflict.
	start<T>(kind: string, resources: readonly ResourceRequest[], executor: OperationExecutor<T>): OperationHandle<T> {
		return this.#start(undefined, kind, resources, executor)
	}

	// Builds a scope whose operations run inside one reservation, so they acquire resources the reservation
	// already holds instead of competing for them. The scope is passed to services exactly like any other,
	// and a service composed under it cannot tell the difference.
	reservedScope(reservation: ResourceReservation): OperationScope {
		return this.tokenScope(reservation.token)
	}

	// Builds the same scope from the token alone, for a service that keeps a root operation of its own.
	//
	// The guider session is the declared exception to the operation tree: a connection outlives every command
	// issued through it, so it is a root owned by the commander rather than a scope nested in whoever asked
	// for it. Such a service cannot be handed the reservation scope of its caller — it does not open its
	// operation inside the caller's tree — but it still has to acquire under the reservation, and the token is
	// exactly that credential. Nested operations inherit it from the root, so every later command acquires the
	// physical devices with no further plumbing.
	tokenScope(token: ReservationToken): OperationScope {
		this.#reservationTokens.set(token.owner, token)

		return Object.freeze({
			start: <T>(kind: string, resources: readonly ResourceRequest[], executor: OperationExecutor<T>) => this.#start(undefined, kind, resources, executor, token),
		})
	}

	// Opens one scope, nested when a parent is given, and runs its executor after atomic acquisition.
	#start<T>(parent: ActiveOperation<unknown> | undefined, kind: string, resources: readonly ResourceRequest[], executor: OperationExecutor<T>, reservationToken?: ReservationToken): OperationHandle<T> {
		const id = Bun.randomUUIDv7()
		const controller = new AbortController()
		const result = Promise.withResolvers<OperationResult<T>>()
		const completion = Promise.withResolvers<void>()

		// Settles a scope that never ran, so a rejected start still produces a total, awaited handle.
		const rejected = (failure: Extract<OperationResult<T>, { readonly ok: false }>): OperationHandle<T> => {
			controller.abort(failure.reason)
			result.resolve(failure)
			completion.resolve()
			return Object.freeze({ id, kind, signal: controller.signal, result: result.promise, cancel: () => completion.promise })
		}

		// A cancelled scope must not gain new work: a nested scope owns a fresh controller, so it would not
		// inherit the abort and would command devices the tree is about to release. A scope started after
		// finalization began would also never be awaited by its parent.
		if (parent !== undefined && (parent.terminalStarted || parent.controller.signal.aborted)) {
			return rejected(failedOperationResult(parent.cancelReason ?? 'aborted', 'parent operation is no longer running'))
		}

		const root = parent === undefined ? undefined : rootOf(parent)
		// A nested scope commands the same devices as its tree, so it inherits the authorization of the root
		// rather than taking one from the caller.
		const token = root === undefined ? reservationToken : root.token

		// Same rule one level up: a cancelled reservation must not gain new work either. A tree opened now
		// commands devices under a token whose holder has already given them up, and nothing is left to wait
		// for its cleanup — an executor that opened one and awaited it would hang the stop that cancelled it.
		if (token !== undefined && this.#cancelledReservations.has(token)) {
			return rejected(failedOperationResult('aborted', 'reservation has been cancelled'))
		}

		const context: OperationContext = Object.freeze({
			id,
			kind,
			signal: controller.signal,
			start: <R>(childKind: string, childResources: readonly ResourceRequest[], childExecutor: OperationExecutor<R>) => this.#start(node, childKind, childResources, childExecutor),
			owns: (resource: ResourceKey) => {
				const holder = holders.get(resource)?.at(-1)
				return holder !== undefined && isSelfOrAncestor(holder, node)
			},
			onCleanup: (cleanup: Cleanup) => {
				// Registration loses to a cancellation that already began finalizing. An executor that starts
				// physical work before registering its cleanup can hit this legitimately, so it is reported
				// rather than thrown: the work it wanted to undo is now nobody's responsibility.
				if (operation.cleanupStarted) {
					console.error('cleanup registered after finalization started:', kind, id)
					return () => {}
				}

				const registration = { cleanup }
				operation.cleanups.push(registration)
				let registered = true

				return () => {
					if (!registered || operation.cleanupStarted) return
					registered = false
					const index = operation.cleanups.indexOf(registration)
					if (index >= 0) operation.cleanups.splice(index, 1)
				}
			},
		})

		const handle: OperationHandle<T> = Object.freeze({
			id,
			kind,
			signal: controller.signal,
			result: result.promise,
			cancel: (reason: OperationFailureReason = 'aborted') => this.#cancel(operation, reason),
		})

		const operation: ActiveOperation<T> = {
			context,
			parent,
			token,
			children: new Set(),
			holders: new Map(),
			controller,
			handle,
			result,
			cleanups: [],
			completion,
			cleanupStarted: false,
			terminalStarted: false,
		}

		// The result resolver is contravariant in T, so the tree is traversed through this erased view.
		const node = operation as ActiveOperation<unknown>
		const holders = (root ?? node).holders

		// The arbiter only separates trees, so a sibling scope holding the resource has to be refused here.
		// Inheriting an ancestor's hold instead of conflicting with it is what makes nesting reentrant, and
		// it is also what keeps two concurrent captures off the same camera inside one feature.
		const siblingConflicts = treeConflicts(holders, parent, resources)

		if (siblingConflicts.length > 0) return rejected(failedOperationResult('busy', formatConflicts(siblingConflicts)))

		// Every scope of a tree acquires under the root's context, so the arbiter sees one owner per operation.
		const acquired = this.arbiter.acquire(root?.context ?? context, resources, token)

		if (!acquired.ok) return rejected(failedOperationResult('busy', formatConflicts(acquired.conflicts)))

		operation.lease = acquired.lease
		this.#operations.set(id, node)
		parent?.children.add(node)

		for (const key of acquired.lease.resources) {
			const stack = holders.get(key)
			if (stack === undefined) holders.set(key, [node])
			else stack.push(node)
		}

		// Only the root context is an arbiter owner, so it is the only one lifecycle cancellation resolves.
		if (parent === undefined) {
			this.#operationsByOwner.set(context, node)

			if (token !== undefined) {
				let roots = this.#operationsByReservationOwner.get(token.owner)

				if (roots === undefined) {
					roots = new Set()
					this.#operationsByReservationOwner.set(token.owner, roots)
				}

				roots.add(node)
			}
		}

		void (async () => {
			try {
				const operationResult = await executor(context)
				const terminal: Terminal<T> = operation.cancelReason === undefined ? { result: operationResult } : { result: failedOperationResult(operation.cancelReason, detailOf(operationResult)) }
				await this.#finalize(operation, terminal)
			} catch (error) {
				const terminal: Terminal<T> = operation.cancelReason === undefined ? { error } : { result: failedOperationResult(operation.cancelReason, errorMessage(error)) }
				await this.#finalize(operation, terminal)
			}
		})()

		return handle
	}

	// Returns an active operation handle by id; completed operations are no longer retained.
	get<T = unknown>(id: string) {
		return this.#operations.get(id)?.handle as OperationHandle<T> | undefined
	}

	// Cancels an active operation by id and waits for cleanup; unknown ids are a no-op.
	cancel(id: string, reason: OperationFailureReason = 'aborted') {
		const operation = this.#operations.get(id)
		return operation === undefined ? Promise.resolve() : this.#cancel(operation, reason)
	}

	// Aborts the owner of one affected resource synchronously, then waits for its cleanup.
	cancelByResource(resource: ResourceKey, reason: OperationFailureReason = 'aborted') {
		return this.#cancelOwners(this.arbiter.ownersOf(resource), reason)
	}

	// Aborts every owner holding one physical device, under its own key or under a logical resource that
	// stands for it, then waits for all cleanup. This is what a lifecycle event has to use: an operation may
	// reserve a device without leasing it, and a disconnect must still reach it.
	cancelByDevice(resource: ResourceKey, reason: OperationFailureReason = 'aborted') {
		return this.#cancelOwners(this.arbiter.ownersOfDevice(resource), reason)
	}

	// Aborts every distinct owner associated with a client, then waits for all cleanup.
	cancelByClient(clientId: string, reason: OperationFailureReason = 'aborted') {
		return this.#cancelOwners(this.arbiter.ownersOfClient(clientId), reason)
	}

	// Aborts every operation tree started inside one reservation, then waits for all cleanup, and closes the
	// reservation to further starts. This is what a session releasing its reservation has to use: releasing
	// before these cleanups finish would hand the devices to a third party while the session is still
	// quiescing them.
	//
	// Cancelling is terminal for the reservation, not a pass over the trees that exist right now: it is called
	// by a holder that is giving the devices up, and reopening it afterwards would only admit work nothing is
	// waiting for. A reservation that must run again is a new reservation, and its token is a new token.
	cancelByReservationOwner(owner: ResourceReservationOwner, reason: OperationFailureReason = 'aborted') {
		return this.#drainReservation(owner, reason, true)
	}

	// Aborts every operation tree started inside one reservation and waits for all cleanup, leaving the
	// reservation open to the work that comes after.
	//
	// This is the non-terminal half of `cancelByReservationOwner`, for a holder interrupting its own work and
	// keeping the devices. The sequencer has two such moments and neither gives the reservation up: an immediate
	// pause cancels the action and resumes into the same reservation, and an immediate stop cancels the action
	// and then runs its terminal pipeline under it. Closing the reservation for good at either point refuses
	// everything the session does next with `reservation has been cancelled` — a pause that can never resume,
	// and a stop whose mount is never parked and whose camera is never warmed.
	//
	// The tokens are still closed for the duration of the drain, for the reason the terminal form closes them:
	// an executor resuming from its abort must not open one more tree behind the snapshot being awaited. They
	// are reopened once every cleanup resolved, which is the instant nothing of the cancelled work is left
	// running. A token another caller had already closed for good stays closed.
	//
	// `preserve` is the id of one root the drain leaves running, for the collaborator whose lifetime is the
	// holder's and not the work being interrupted. The sequencer's guiding session is exactly that: it is a
	// root of the reservation because a connection outlives every command issued through it, so a drain that
	// tore it down for an interruption the holder resumes from would leave the session pointing at a session
	// that no longer exists, with nothing on the resume path reconnecting it. It has no effect on the terminal
	// form, which is called by a holder that is giving the devices up.
	drainByReservationOwner(owner: ResourceReservationOwner, reason: OperationFailureReason = 'aborted', preserve?: string) {
		return this.#drainReservation(owner, reason, false, preserve)
	}

	// Cancels the trees of one reservation and awaits their cleanups, closing the reservation permanently when
	// `terminal` and reopening exactly the tokens this call closed otherwise. `preserve` names a root that is
	// left running, and is ignored when `terminal`.
	async #drainReservation(owner: ResourceReservationOwner, reason: OperationFailureReason, terminal: boolean, preserve?: string) {
		const token = this.#reservationTokens.get(owner)
		const roots = this.#operationsByReservationOwner.get(owner)
		// Tokens closed by this call, which are the only ones a non-terminal drain may reopen: one that was
		// already closed belongs to a caller that gave the reservation up, and reopening it would readmit work
		// nothing is waiting for.
		const closed: ReservationToken[] = []

		// Closing the reservation is synchronous and happens before the first await, so the snapshot below is
		// complete: an executor resuming from its abort cannot open one more tree behind it. Draining in a loop
		// instead would let a cleanup that starts a compensating operation on every pass never terminate. The
		// roots are closed by their own token too, which is the current one unless the owner reserved again.
		if (token !== undefined && !this.#cancelledReservations.has(token)) {
			this.#cancelledReservations.add(token)
			closed.push(token)
		}

		const snapshot = roots === undefined ? [] : roots.values().toArray()

		for (const operation of snapshot) {
			if (operation.token !== undefined && !this.#cancelledReservations.has(operation.token)) {
				this.#cancelledReservations.add(operation.token)
				closed.push(operation.token)
			}
		}

		// The preserved root is excluded from the cancellation only, never from the closing above: its token is
		// the reservation's, and leaving it open during the drain would readmit the trees the snapshot is meant
		// to be complete against.
		const cancelling = terminal || preserve === undefined ? snapshot : snapshot.filter((operation) => operation.context.id !== preserve)

		try {
			// Roots leave the set only in their own finalization, which cannot run before this snapshot is taken.
			await Promise.all(cancelling.map((operation) => this.#cancel(operation, reason)))
		} finally {
			// A cleanup that threw still leaves the reservation usable: the drain is over either way, and holding
			// it closed would strand the pause or the terminal pipeline the caller is about to run.
			if (!terminal) for (const each of closed) this.#cancelledReservations.delete(each)
		}
	}

	// Aborts every operation tree synchronously and waits for all cleanup; roots cascade to their scopes.
	async cancelAll(reason: OperationFailureReason = 'aborted') {
		const roots = this.#operations.values().filter((operation) => operation.parent === undefined)
		await Promise.all(roots.map((operation) => this.#cancel(operation, reason)))
	}

	// Resolves arbiter owner tokens to active operations without relying on caller-visible ids.
	async #cancelOwners(owners: readonly ResourceOwner[], reason: OperationFailureReason) {
		const cancellations: Promise<void>[] = []

		for (const owner of owners) {
			const operation = this.#operationsByOwner.get(owner)
			if (operation !== undefined) cancellations.push(this.#cancel(operation, reason))
		}

		await Promise.all(cancellations)
	}

	// Aborts the scope and its nested scopes immediately, returning completion after every cleanup has released.
	#cancel<T>(operation: ActiveOperation<T>, reason: OperationFailureReason) {
		if (!operation.terminalStarted) operation.cancelReason ??= reason
		const effective = operation.cancelReason ?? reason
		if (!operation.controller.signal.aborted) operation.controller.abort(effective)

		// Propagation must be synchronous: a parent awaiting a child's result would otherwise never observe
		// its own cancellation. Children leave the set only in their own finalization, which cannot run
		// before this loop ends, and they are awaited there rather than here.
		for (const child of operation.children) void this.#cancel(child, effective)

		return operation.completion.promise
	}

	// Removes this scope from the tree's holder stacks so an ancestor becomes the innermost holder again.
	#releaseHolders<T>(operation: ActiveOperation<T>) {
		if (operation.lease === undefined) return

		const node = operation as ActiveOperation<unknown>
		const holders = rootOf(node).holders

		for (const key of operation.lease.resources) {
			const stack = holders.get(key)

			if (stack === undefined) continue

			const index = stack.lastIndexOf(node)

			if (index >= 0) stack.splice(index, 1)
			if (stack.length === 0) holders.delete(key)
		}
	}

	// Runs cleanup exactly once in reverse order, releases the lease, and settles the result.
	async #finalize<T>(operation: ActiveOperation<T>, terminal: Terminal<T>) {
		if (operation.terminalStarted) return operation.completion.promise

		operation.terminalStarted = true

		if (!operation.controller.signal.aborted) {
			if ('error' in terminal) {
				operation.controller.abort(terminal.error)
			} else if (!terminal.result.ok) {
				operation.controller.abort(terminal.result.reason)
			}
		}

		// Nested scopes command the same devices, so none may still be running while this scope undoes its
		// own work. They unwind first because they are the innermost frames of the operation tree.
		if (operation.children.size > 0) {
			await Promise.all(operation.children.values().map((child) => this.#cancel(child, operation.cancelReason ?? 'aborted')))
		}

		operation.cleanupStarted = true
		const cleanupErrors: unknown[] = []

		try {
			for (let i = operation.cleanups.length - 1; i >= 0; i--) {
				try {
					await operation.cleanups[i].cleanup()
				} catch (error) {
					cleanupErrors.push(error)
				}
			}
		} finally {
			this.#releaseHolders(operation)
			operation.lease?.release()
			this.#operations.delete(operation.context.id)
			operation.parent?.children.delete(operation as ActiveOperation<unknown>)
			if (operation.parent === undefined) {
				this.#operationsByOwner.delete(operation.context)

				if (operation.token !== undefined) {
					const roots = this.#operationsByReservationOwner.get(operation.token.owner)

					if (roots?.delete(operation as ActiveOperation<unknown>) && roots.size === 0) this.#operationsByReservationOwner.delete(operation.token.owner)
				}
			}
		}

		// An exception is a defect rather than an operational outcome, so the raw value is logged here and
		// reported as commandFailed. Callers get a total result and never have to handle a rejection.
		if ('error' in terminal) {
			console.error('operation failed unexpectedly:', operation.context.kind, operation.context.id, terminal.error)
			terminal = { result: failedOperationResult('commandFailed', errorMessage(terminal.error)) }
		}

		if (cleanupErrors.length > 0) {
			for (const error of cleanupErrors) console.error('operation cleanup failed:', operation.context.kind, operation.context.id, error)

			const detail = `cleanup failed: ${cleanupErrors.map(errorMessage).join('; ')}`

			// A failed cleanup means the devices may not be quiescent, so success cannot stand. An existing
			// failure keeps its cause and only gains the detail.
			terminal = {
				result: terminal.result.ok ? failedOperationResult('commandFailed', detail) : { ...terminal.result, error: terminal.result.error ? `${terminal.result.error}; ${detail}` : detail },
			}
		}

		operation.result.resolve(terminal.result)
		operation.completion.resolve()
	}
}

// Walks up to the root of an operation tree, which owns the arbiter lease and the holder stacks.
function rootOf(operation: ActiveOperation<unknown>) {
	let current = operation
	while (current.parent !== undefined) current = current.parent
	return current
}

// Reports whether candidate is the operation itself or one of its enclosing scopes.
function isSelfOrAncestor(candidate: ActiveOperation<unknown>, operation: ActiveOperation<unknown>) {
	let current: ActiveOperation<unknown> | undefined = operation

	while (current !== undefined) {
		if (current === candidate) return true
		current = current.parent
	}

	return false
}

// Detects resources held by a scope of the same tree that does not enclose the one being started.
function treeConflicts(holders: Map<ResourceKey, ActiveOperation<unknown>[]>, parent: ActiveOperation<unknown> | undefined, requests: readonly ResourceRequest[]) {
	// A new tree has no holders of its own, so only a nested scope can conflict with its own operation.
	if (parent === undefined) return []

	const conflicts: ResourceConflict[] = []
	const reported = new Set<ResourceKey>()

	for (const request of requests) {
		if (reported.has(request.key)) continue

		const holder = holders.get(request.key)?.at(-1)

		if (holder !== undefined && !isSelfOrAncestor(holder, parent)) {
			reported.add(request.key)
			conflicts.push({ key: request.key, by: 'lease', ownerId: holder.context.id, ownerKind: holder.context.kind, causes: [] })
		}
	}

	return conflicts
}

// Extracts the diagnostic detail of an executor result, if it carried one.
function detailOf<T>(result: OperationResult<T>) {
	return result.ok ? undefined : result.error
}

// Produces a compact diagnostic for an atomic busy result, naming why each resource was refused.
function formatConflicts(conflicts: readonly ResourceConflict[]) {
	return conflicts
		.map((conflict) => {
			if (conflict.by === 'unavailable') return `${conflict.key} is unavailable (${conflict.causes.join(', ')})`
			if (conflict.by === 'reservation') return `${conflict.key} is reserved by ${conflict.ownerKind} ${conflict.ownerId}`
			return `${conflict.key} is owned by ${conflict.ownerKind} ${conflict.ownerId}`
		})
		.join(', ')
}
