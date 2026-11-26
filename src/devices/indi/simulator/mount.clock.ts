import { formatTemporal, TIMEZONE } from '../../../astronomy/time/temporal'
import type { UTCTime } from '../device'
import { makeTextVector, type NewTextVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'

// Clock circuit of the simulated mount: simulated UTC in milliseconds since the epoch. The published
// clock is whole milliseconds, the INDI resolution, while the fraction of a millisecond a step leaves is
// carried, so a run of sub-millisecond steps adds up to the time that really passed. The UTC offset is
// minutes, a timezone for display that no geometry reads.

// Simulated UTC clock.
export class MountClock extends SimulatorComponent {
	readonly #time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', ''], ['OFFSET', 'UTC Offset', ''])

	readonly properties = [this.#time]
	readonly transient = this.properties

	// Simulated UTC, whole milliseconds.
	#utc: number
	// Fraction of a millisecond not yet handed to the clock, in [0, 1).
	#remainder = 0
	// UTC offset, minutes.
	#offset = TIMEZONE / 60
	// Wall-clock instant the automatic ticking stopped, milliseconds, or undefined while it runs.
	#suspendedAt?: number

	// `start` is the initial UTC, milliseconds; `set` applies a TIME_UTC command through the device,
	// which moves what depends on the clock along with it.
	constructor(
		bus: ComponentBus,
		start: number,
		readonly set: (value: UTCTime) => void,
	) {
		super(bus)
		this.#utc = start
		this.#publishValues()
	}

	// Simulated UTC, whole milliseconds.
	get utc() {
		return this.#utc
	}

	// Simulated UTC with the carried fraction, milliseconds.
	get exact() {
		return this.#utc + this.#remainder
	}

	// UTC offset, minutes.
	get offset() {
		return this.#offset
	}

	// Advances the clock by `dtSeconds`, returning the exact instants the step starts and ends at.
	step(dtSeconds: number): readonly [number, number] {
		const start = this.exact
		this.#remainder += dtSeconds * 1000
		const elapsed = Math.trunc(this.#remainder)
		this.#remainder -= elapsed
		this.#utc += elapsed
		return [start, this.exact]
	}

	// Sets the clock to `value`, returning how far UTC moved, milliseconds; the carried fraction belongs
	// to the clock replaced. Publishes TIME_UTC.
	apply(value: UTCTime) {
		const delta = value.utc - this.#utc
		this.#offset = value.offset
		if (delta !== 0) {
			this.#utc = value.utc
			this.#remainder = 0
		}
		this.#publishValues()
		this.bus.notify(this.#time)
		return delta
	}

	// Records the wall-clock instant `now`, milliseconds, at which automatic ticking stopped.
	suspend(now: number) {
		this.#suspendedAt ??= now
	}

	// Moves the clock on by the wall-clock time spent suspended, up to `now`, milliseconds, so a mount
	// that was disconnected does not come back behind the time it keeps. Publishes TIME_UTC when it
	// moved, and returns how far.
	resume(now: number) {
		const suspendedAt = this.#suspendedAt
		this.#suspendedAt = undefined
		if (suspendedAt === undefined || now <= suspendedAt) return 0
		this.#utc += now - suspendedAt
		this.#publishValues()
		this.bus.notify(this.#time)
		return now - suspendedAt
	}

	// Handles TIME_UTC: a UTC without a timezone is UTC, and an absent offset keeps the current one.
	handleText(vector: NewTextVector) {
		if (vector.name !== this.#time.name) return false

		const text = vector.elements.UTC

		if (text) {
			const utc = Date.parse(/[zZ]$|[+-]\d{2}(?::?\d{2})?$/.test(text) ? text : `${text}Z`)
			const offset = vector.elements.OFFSET === undefined ? this.#offset : Math.trunc(+vector.elements.OFFSET * 60)
			if (!Number.isNaN(utc)) this.set({ utc, offset })
		}

		return true
	}

	// Writes the current UTC and offset into TIME_UTC.
	#publishValues() {
		this.#time.elements.UTC.value = formatTemporal(this.#utc, 'YYYY-MM-DDTHH:mm:ss.SSSZ')
		this.#time.elements.OFFSET.value = (this.#offset / 60).toFixed(2)
	}
}
