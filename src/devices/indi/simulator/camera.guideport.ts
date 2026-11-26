import type { GuideDirection } from '../device'
import { makeNumberVector, type NewNumberVector, type PropertyState } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import { timedGuidePulse } from './util'

// Guide-port circuit of the simulated camera: an ST-4 output that relays timed pulses to whatever
// drives the mount and reports each axis Busy while its pulse lasts. Durations and instants are
// milliseconds, instants on the bus clock.

// Where the guide port is wired to.
export interface CameraGuidePortOutput {
	// Whether pulses may be issued now, e.g. the device is connected.
	readonly enabled: () => boolean
	// Relays a pulse of `duration` milliseconds towards `direction`; zero cancels that axis.
	readonly pulse: (direction: GuideDirection, duration: number) => void
}

// Guide axis a direction belongs to.
function isNorthSouth(direction: GuideDirection) {
	return direction === 'NORTH' || direction === 'SOUTH'
}

// A timed-guide property of one axis.
type GuideProperty = ReturnType<typeof makeNumberVector>

// ST-4 guide output with one timer per axis.
export class CameraGuidePort extends SimulatorComponent {
	readonly #northSouth = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #westEast = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	readonly properties = [this.#northSouth, this.#westEast]
	readonly transient = this.properties

	// Instant each axis' pulse ends, milliseconds; zero while the axis is idle.
	#northSouthUntil = 0
	#westEastUntil = 0

	// `output` receives every pulse the port issues.
	constructor(
		bus: ComponentBus,
		readonly output: CameraGuidePortOutput,
	) {
		super(bus)
	}

	// Whether either axis is pulsing.
	get isPulsing() {
		return this.#northSouth.state === 'Busy' || this.#westEast.state === 'Busy'
	}

	// Issues a pulse of `duration` milliseconds towards `direction`, replacing the one in progress on
	// that axis; zero or less cancels the axis. Does nothing while the output is disabled.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.output.enabled()) return
		this.output.pulse(direction, duration)
		const until = duration > 0 ? this.bus.now() + Math.trunc(duration) : 0
		if (isNorthSouth(direction)) this.#northSouthUntil = until
		else this.#westEastUntil = until
		this.#publish()
	}

	// Handles TELESCOPE_TIMED_GUIDE_NS and TELESCOPE_TIMED_GUIDE_WE.
	handleNumber(vector: NewNumberVector) {
		const { elements } = vector
		const pulse = vector.name === 'TELESCOPE_TIMED_GUIDE_NS' ? timedGuidePulse('NORTH', elements.TIMED_GUIDE_N, 'SOUTH', elements.TIMED_GUIDE_S) : vector.name === 'TELESCOPE_TIMED_GUIDE_WE' ? timedGuidePulse('WEST', elements.TIMED_GUIDE_W, 'EAST', elements.TIMED_GUIDE_E) : false
		if (pulse === false) return false
		if (pulse !== undefined) this.pulse(pulse[0], pulse[1])
		return true
	}

	// Ends the pulses that expired by `now`, milliseconds.
	tick(now: number) {
		if (this.#northSouthUntil <= now) this.#northSouthUntil = 0
		if (this.#westEastUntil <= now) this.#westEastUntil = 0
		this.#publish()
	}

	// Cancels both axes when the device disconnects.
	reset() {
		this.#northSouthUntil = 0
		this.#westEastUntil = 0
		this.#publish()
	}

	// Publishes each axis whose Busy/Idle state changed.
	#publish() {
		this.#publishAxis(this.#northSouth, this.#northSouthUntil > 0 ? 'Busy' : 'Idle')
		this.#publishAxis(this.#westEast, this.#westEastUntil > 0 ? 'Busy' : 'Idle')
	}

	// Sets the state of one axis' property, publishing it when it changed.
	#publishAxis(property: GuideProperty, state: PropertyState) {
		if (property.state === state) return
		property.state = state
		this.bus.notify(property)
	}
}
