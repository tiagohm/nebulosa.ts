import { clamp } from '../../../math/numerical/math'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { CameraShutterConfig } from './camera.config'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'

// Shutter circuit of the simulated camera: the exposure countdown and its states. Durations are
// seconds and instants milliseconds on the bus clock.
//
// An exposure goes from open to closed when its countdown runs out, and from closed to complete once
// its frame has been delivered or has failed. Between closing and completing, the shutter is free:
// CCD_EXPOSURE has reported the countdown at zero, a new exposure may already open, and the state the
// finished one ends in is published only when it completes, after its frame.

// What the shutter tells the device it is mounted on.
export interface CameraShutterListener {
	// Whether an exposure may start now, e.g. the device is connected.
	readonly canOpen: () => boolean
	// The shutter opened for `duration` seconds at `now`, milliseconds.
	readonly opened: (duration: number, now: number) => void
	// The shutter closed after `duration` seconds; the frame is now to be produced, and `complete`
	// called once it was delivered or failed.
	readonly closed: (duration: number) => void
}

// Smallest change of the remaining time worth publishing, seconds.
const COUNTDOWN_NOTIFY_STEP = 1e-3

// Exposure timer with abort.
export class CameraShutter extends SimulatorComponent {
	readonly #exposure = makeNumberVector('', 'CCD_EXPOSURE', 'Exposure', MAIN_CONTROL, 'rw', ['CCD_EXPOSURE_VALUE', 'Exposure (s)', 0, 0, 0, 1e-3, '%.6f'])
	readonly #abort = makeSwitchVector('', 'CCD_ABORT_EXPOSURE', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	readonly properties = [this.#exposure, this.#abort]
	readonly transient = this.properties

	// Instant the open exposure is due to close, milliseconds; zero while none is open.
	#endTime = 0
	// Duration of the open exposure, seconds.
	#duration = 0

	// `config` sets the exposure limits; `listener` is told when an exposure opens and closes.
	constructor(
		bus: ComponentBus,
		config: CameraShutterConfig,
		readonly listener: CameraShutterListener,
	) {
		super(bus)
		this.#exposure.elements.CCD_EXPOSURE_VALUE.min = config.minExposure
		this.#exposure.elements.CCD_EXPOSURE_VALUE.max = config.maxExposure
	}

	// Whether an exposure is open.
	get isExposing() {
		return this.#exposure.state === 'Busy' && this.#endTime > 0
	}

	// Shortest exposure, seconds.
	get minExposure() {
		return this.#exposure.elements.CCD_EXPOSURE_VALUE.min
	}

	// Opens the shutter for `duration` seconds, clamped to the exposure limits. Returns whether it
	// opened: it does not while an exposure is open or the listener refuses.
	open(duration: number) {
		if (this.isExposing || !this.listener.canOpen()) return false
		const { min, max } = this.#exposure.elements.CCD_EXPOSURE_VALUE
		const now = this.bus.now()
		duration = clamp(duration, min, max)
		this.#duration = duration
		this.#endTime = now + Math.trunc(duration * 1000)
		this.#exposure.state = 'Busy'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = duration
		this.#abort.elements.ABORT.value = false
		this.bus.notify(this.#exposure)
		this.listener.opened(duration, now)
		return true
	}

	// Aborts the open exposure without producing a frame, ending it Alert when `alert` and Idle
	// otherwise. Does nothing when no exposure is open.
	abort(alert: boolean = false) {
		if (!this.isExposing) return
		this.#endTime = 0
		this.#duration = 0
		this.#exposure.state = alert ? 'Alert' : 'Idle'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.bus.notify(this.#exposure)
	}

	// Ends a closed exposure once its frame was delivered, Ok when `succeeded` and Alert otherwise.
	// Ignored while a newer exposure is open, whose own state must not be overwritten.
	complete(succeeded: boolean) {
		if (this.isExposing) return
		this.#exposure.state = succeeded ? 'Ok' : 'Alert'
		this.bus.notify(this.#exposure)
	}

	// Handles CCD_EXPOSURE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== 'CCD_EXPOSURE') return false
		const value = vector.elements.CCD_EXPOSURE_VALUE
		if (value !== undefined) this.open(value)
		return true
	}

	// Handles CCD_ABORT_EXPOSURE.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== 'CCD_ABORT_EXPOSURE') return false
		if (vector.elements.ABORT === true) this.abort()
		return true
	}

	// Counts the open exposure down to `now`, milliseconds, and closes it when it is due.
	tick(now: number) {
		if (!this.isExposing) return

		const remaining = Math.max(0, (this.#endTime - now) / 1000)
		const value = this.#exposure.elements.CCD_EXPOSURE_VALUE

		if (remaining > 0) {
			if (Math.abs(value.value - remaining) >= COUNTDOWN_NOTIFY_STEP) {
				value.value = remaining
				this.bus.notify(this.#exposure)
			}

			return
		}

		const duration = this.#duration
		this.#endTime = 0
		this.#duration = 0
		value.value = 0
		this.bus.notify(this.#exposure)
		// Marked finished before the frame is produced, without publishing it: the next exposure is free
		// to open, and the state a client sees changes only once the frame has arrived.
		this.#exposure.state = 'Ok'
		this.listener.closed(duration)
	}

	// Aborts the open exposure when the device disconnects.
	reset() {
		this.abort()
	}
}
