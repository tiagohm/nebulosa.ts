import { clamp } from '../../../math/numerical/math'
import { CLIENT, type Client, DEFAULT_FOCUSER, DeviceInterfaceType, type Focuser } from '../device'
import type { IndiPropertyRegistry } from '../properties'
import type { DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, PropertyState, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

// Manager for focusers; absolute/relative move, sync, reverse, and abort, reflecting position (steps),
// motion, temperature, and the backlash compensation of the driver (steps), which it can switch on or off.
// Absolute and relative moves are both offered whenever the driver publishes either one: an absolute-only
// focuser gets its relative moves sent as absolute targets, and a relative-only one gets a virtual position
// counter (steps), advanced by the relative moves this manager commands once the driver reports them done.

// Options of the focuser manager.
export interface FocuserManagerOptions {
	// Steps on each side of the origin of the virtual position of a relative-only focuser, which starts at this
	// value inside [0, 2 * virtualRange]. Defaults to DEFAULT_FOCUSER_VIRTUAL_RANGE.
	readonly virtualRange?: number
}

// Default steps on each side of the origin of the virtual position, so a relative-only focuser starts at 50000
// inside [0, 100000].
export const DEFAULT_FOCUSER_VIRTUAL_RANGE = 50000

// Focuser vectors the driver actually publishes, from which the effective and emulated capabilities derive.
interface NativeFocuserVectors {
	// Whether ABS_FOCUS_POSITION is defined.
	absolute: boolean
	// Whether REL_FOCUS_POSITION is defined.
	relative: boolean
	// Whether FOCUS_SYNC is defined.
	sync: boolean
}

// Relative move commanded on a focuser with a virtual position, applied to it once the driver reports the move done.
interface PendingVirtualMove {
	// Signed steps the virtual position changes by, positive outward.
	readonly delta: number
	// Whether the driver has reported the move Busy.
	busy: boolean
}

// Builds and commands Focuser devices from the INDI focuser interface, emulating the missing kind of move.
export class FocuserManager extends DeviceManager<Focuser> {
	// Vectors each focuser's driver publishes.
	readonly #native = new WeakMap<Focuser, NativeFocuserVectors>()
	// Relative move commanded on each focuser with a virtual position and not yet reported done.
	readonly #pending = new WeakMap<Focuser, PendingVirtualMove>()

	// properties is the registry shared with the other managers (see DeviceManager).
	constructor(
		properties?: IndiPropertyRegistry,
		readonly options: FocuserManagerOptions = {},
	) {
		super(properties)
	}

	// Aborts any motion. An aborted move on a virtual position travelled an unknown distance, so the virtual
	// position stays where that move started; syncTo redefines it.
	stop(focuser: Focuser, client = focuser[CLIENT]!) {
		if (focuser.canAbort) {
			this.#pending.delete(focuser)
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	// Moves inward (decreasing position) by a number of steps.
	moveIn(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		this.#moveRelative(focuser, steps, true, client)
	}

	// Moves outward (increasing position) by a number of steps.
	moveOut(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		this.#moveRelative(focuser, steps, false, client)
	}

	// Moves to an absolute position, in steps. On a virtual position, the target is clamped to its range and
	// commanded as the relative move that reaches it; a target already reached sends nothing.
	moveTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (!focuser.canAbsoluteMove) return

		if (focuser.emulatedAbsoluteMove) {
			this.#moveVirtual(focuser, position, client)
		} else {
			client.sendNumber({ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: position } })
		}
	}

	// Redefines the current position without moving, in steps. A virtual position is redefined locally (rounded
	// and clamped to its range), with no driver command, and any move still pending on it is forgotten.
	syncTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (focuser.emulatedAbsoluteMove) {
			this.#pending.delete(focuser)
			this.#setVirtualPosition(focuser, Math.round(clamp(position, focuser.position.min, focuser.position.max)))
		} else if (focuser.canSync) {
			client.sendNumber({ device: focuser.name, name: 'FOCUS_SYNC', elements: { FOCUS_SYNC_VALUE: position } })
		}
	}

	reverse(focuser: Focuser, enabled: boolean, client = focuser[CLIENT]!) {
		if (focuser.canReverse) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_REVERSE_MOTION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Enables or disables the backlash compensation of the driver, when its toggle is writable.
	backlash(focuser: Focuser, enabled: boolean, client = focuser[CLIENT]!) {
		if (focuser.hasBacklash) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Applies focuser switch vectors: abort capability, reverse capability/state, and driver backlash capability/state.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FOCUS_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'FOCUS_REVERSE_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'reversed', message.state)
				}

				return
			case 'FOCUS_BACKLASH_TOGGLE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasBacklash', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'hasBacklash', message.state)
					}
				}

				if (handleSwitchValue(device, 'backlashEnabled', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'backlashEnabled', message.state)
				}
		}
	}

	// Applies focuser number vectors: sync/relative/absolute capabilities, the absolute position (steps),
	// the virtual position advanced by a finished relative move, the moving state, and the driver backlash (steps).
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FOCUS_SYNC':
				if (tag[0] === 'd') {
					this.#nativeVectors(device).sync = true
					this.#updateCapabilities(device, message.state)
				}

				return
			case 'REL_FOCUS_POSITION':
				if (tag[0] === 'd') {
					this.#nativeVectors(device).relative = true
					this.#updateCapabilities(device, message.state)
				} else if (device.emulatedAbsoluteMove) {
					this.#trackVirtualMove(device, message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy', message.state)) {
					this.updated(device, 'moving', message.state)
				}

				return
			case 'FOCUS_BACKLASH_STEPS':
				if (handleMinMaxValue(device.backlash, message.elements.FOCUS_BACKLASH_VALUE, tag)) {
					this.updated(device, 'backlash', message.state)
				}

				return
			case 'ABS_FOCUS_POSITION':
				if (tag[0] === 'd') {
					this.#nativeVectors(device).absolute = true
					this.#updateCapabilities(device, message.state)
				}

				if (handleMinMaxValue(device.position, message.elements.FOCUS_ABSOLUTE_POSITION, tag)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy', message.state)) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Creates/updates the focuser from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FOCUSER)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name
		const native = this.#nativeVectors(device)

		if (full || name === 'FOCUS_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_FOCUSER.canAbort)
		}
		if (full || name === 'FOCUS_REVERSE_MOTION') {
			resetDeviceValue(this, device, 'canReverse', DEFAULT_FOCUSER.canReverse)
			resetDeviceValue(this, device, 'reversed', DEFAULT_FOCUSER.reversed)
		}
		if (full || name === 'FOCUS_BACKLASH_TOGGLE') {
			resetDeviceValue(this, device, 'hasBacklash', DEFAULT_FOCUSER.hasBacklash)
			resetDeviceValue(this, device, 'backlashEnabled', DEFAULT_FOCUSER.backlashEnabled)
		}
		if (full || name === 'FOCUS_BACKLASH_STEPS') {
			resetDeviceValue(this, device, 'backlash', DEFAULT_FOCUSER.backlash)
		}
		if (full || name === 'FOCUS_SYNC') {
			native.sync = false
		}
		if (full || name === 'REL_FOCUS_POSITION') {
			native.relative = false
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}
		if (full || name === 'ABS_FOCUS_POSITION') {
			native.absolute = false
			// A virtual position is reset by the capability update once the relative vector is gone too.
			if (!device.emulatedAbsoluteMove) resetDeviceValue(this, device, 'position', DEFAULT_FOCUSER.position)
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}

		this.#updateCapabilities(device)

		if (full) this.#native.delete(device)

		super.delProperty(client, message)
	}

	// Moves by a relative amount: natively, as the absolute target it ends at on an absolute-only focuser
	// (clamped to the range once it is known), or on a virtual position, as the move to the target it ends at.
	#moveRelative(focuser: Focuser, steps: number, inward: boolean, client: Client) {
		if (!focuser.canRelativeMove) return

		if (focuser.emulatedRelativeMove) {
			const { value, min, max } = focuser.position
			const target = value + (inward ? -steps : steps)
			const position = Math.round(max > min ? clamp(target, min, max) : target)
			client.sendNumber({ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: position } })
		} else if (focuser.emulatedAbsoluteMove) {
			this.#moveVirtual(focuser, focuser.position.value + (inward ? -steps : steps), client)
		} else {
			this.#sendRelative(focuser, steps, inward, client)
		}
	}

	// Commands the relative move that brings a virtual position to a target clamped to its range, so the counter
	// never leaves it, and remembers the move to apply it once the driver reports it done. A new move supersedes
	// one still pending. The step count is left to the driver even when it exceeds the maximum of its relative vector.
	#moveVirtual(focuser: Focuser, position: number, client: Client) {
		const { value, min, max } = focuser.position
		const delta = Math.round(clamp(position, min, max)) - value

		if (delta === 0) return

		this.#pending.set(focuser, { delta, busy: false })
		this.#sendRelative(focuser, Math.abs(delta), delta < 0, client)
	}

	// Selects the motion direction and then writes the unsigned step count of a relative move.
	#sendRelative(focuser: Focuser, steps: number, inward: boolean, client: Client) {
		client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { [inward ? 'FOCUS_INWARD' : 'FOCUS_OUTWARD']: true } })
		client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
	}

	// Applies the pending move of a virtual position from the state of the relative vector: Busy marks it started;
	// Ok, or Idle after Busy (how an Alpaca focuser reports a finished move), advances the position; Alert drops it.
	// A set vector without a state leaves the move as it is. The position is reported before the moving state,
	// which the caller updates afterwards.
	#trackVirtualMove(focuser: Focuser, state?: PropertyState) {
		const pending = this.#pending.get(focuser)

		if (pending === undefined) return

		if (state === 'Busy') {
			pending.busy = true
		} else if (state === 'Ok' || (state === 'Idle' && pending.busy)) {
			this.#pending.delete(focuser)
			const { value, min, max } = focuser.position
			this.#setVirtualPosition(focuser, clamp(value + pending.delta, min, max), state)
		} else if (state === 'Alert') {
			this.#pending.delete(focuser)
		}
	}

	// Writes the virtual position and reports it when it changed.
	#setVirtualPosition(focuser: Focuser, position: number, state?: PropertyState) {
		if (focuser.position.value !== position) {
			focuser.position.value = position
			this.updated(focuser, 'position', state)
		}
	}

	// Returns the native vectors of a focuser, creating the record on first use.
	#nativeVectors(focuser: Focuser) {
		let native = this.#native.get(focuser)

		if (native === undefined) {
			native = { absolute: false, relative: false, sync: false }
			this.#native.set(focuser, native)
		}

		return native
	}

	// Derives the effective capabilities from the native vectors: both moves whenever either vector exists, the
	// emulation flags, and sync, natively or on a virtual position. A virtual position is seeded at the origin of
	// its range when the emulation starts, and reset to the default once no position vector is left. Drivers that
	// define the relative vector before the absolute one start emulated and switch to the reported position as the
	// absolute definition arrives.
	#updateCapabilities(focuser: Focuser, state?: PropertyState) {
		const { absolute, relative, sync } = this.#nativeVectors(focuser)
		const moves = absolute || relative
		const emulatedAbsoluteMove = relative && !absolute
		const wasEmulated = focuser.emulatedAbsoluteMove

		if (handleSwitchValue(focuser, 'canAbsoluteMove', moves)) this.updated(focuser, 'canAbsoluteMove', state)
		if (handleSwitchValue(focuser, 'canRelativeMove', moves)) this.updated(focuser, 'canRelativeMove', state)
		if (handleSwitchValue(focuser, 'emulatedAbsoluteMove', emulatedAbsoluteMove)) this.updated(focuser, 'emulatedAbsoluteMove', state)
		if (handleSwitchValue(focuser, 'emulatedRelativeMove', absolute && !relative)) this.updated(focuser, 'emulatedRelativeMove', state)
		if (handleSwitchValue(focuser, 'canSync', sync || emulatedAbsoluteMove)) this.updated(focuser, 'canSync', state)

		if (emulatedAbsoluteMove === wasEmulated) return

		this.#pending.delete(focuser)

		if (emulatedAbsoluteMove) {
			const range = this.options.virtualRange ?? DEFAULT_FOCUSER_VIRTUAL_RANGE
			const position = focuser.position
			position.value = range
			position.min = 0
			position.max = 2 * range
			position.step = 1
			this.updated(focuser, 'position', state)
		} else if (!absolute) {
			resetDeviceValue(this, focuser, 'position', DEFAULT_FOCUSER.position)
		}
	}
}
