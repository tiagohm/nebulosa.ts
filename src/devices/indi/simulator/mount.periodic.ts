import { ASEC2RAD, DAYSEC, DEG2RAD, SIDEREAL_DRIFT_RATE, TAU } from '../../../core/constants'
import { type Angle, normalizeAngle } from '../../../math/units/angle'
import { makeNumberVector, type NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountPeriodicErrorConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Periodic error of a mount's right-ascension worm, as a function of the accumulated worm phase, plus
// the periodic error correction a controller applies to it.
//
// A real worm produces more than one sinusoid: the fundamental comes from its own eccentricity and the
// higher harmonics from the teeth of the wheel and from the gears driving it, which is why a measured
// PE curve is lumpy rather than a clean sine. Everything here is a function of the phase alone, so the
// error is an absolute offset and evaluating twice at the same phase gives the same number.
//
// Angles are radians and phases are the accumulated angle of the worm, normalized to [0, TAU).

// Harmonics of the worm modelled, from the fundamental upwards. Three covers the fundamental and the
// two orders that dominate a measured curve; beyond that the amplitudes are lost in the seeing.
export const PERIODIC_ERROR_HARMONICS = 3

// Smallest usable correction table. Below this a table cannot even represent the fundamental, so a
// controller asking for fewer bins is treated as having no training at all.
const MIN_CORRECTION_SAMPLES = 4

// Largest correction table that will be built, matching the upper bound of the MOUNT_PEC property.
// Well past the point of diminishing returns: at this many bins the residual of every harmonic
// modelled here is already far below the seeing. The cap exists because the count sizes an allocation,
// and an exported helper must not turn a caller's bad number into a multi-gigabyte array or a
// RangeError from the typed-array constructor.
const MAX_CORRECTION_SAMPLES = 1024

// Harmonic content of a worm, and the correction a controller has learned for it.
export interface PeriodicErrorCurve {
	// Semi-amplitude of each harmonic, radians. Index i is the harmonic of order i + 1, so index 0 turns
	// once per worm revolution, index 1 twice, and so on.
	readonly amplitudes: Readonly<Float64Array>
	// Phase offset of each harmonic, radians. Shifts where in the revolution that harmonic peaks.
	readonly phases: Readonly<Float64Array>
	// Correction sampled evenly over one worm revolution, radians, or undefined when the controller has
	// no training. Subtracted from the raw error, so what survives is the residual a trained mount shows.
	readonly correction?: Readonly<Float64Array>
}

// A perfect worm: no harmonic content and nothing to correct.
export const IDENTITY_PERIODIC_ERROR_CURVE: PeriodicErrorCurve = {
	amplitudes: new Float64Array(PERIODIC_ERROR_HARMONICS),
	phases: new Float64Array(PERIODIC_ERROR_HARMONICS),
}

// Raw periodic error at `phase`, radians, before any correction.
//
// The harmonics simply add: Σ aₙ·sin(n·phase + φₙ). Returns exactly 0 for a worm with no amplitude,
// so the common perfect case costs nothing beyond the loop.
export function rawPeriodicErrorAt(phase: Angle, curve: PeriodicErrorCurve): Angle {
	const { amplitudes, phases } = curve
	let error = 0

	for (let i = 0; i < amplitudes.length; i++) {
		if (amplitudes[i] !== 0) error += amplitudes[i] * Math.sin((i + 1) * phase + phases[i])
	}

	return error
}

// Correction the controller applies at `phase`, radians, interpolated linearly between the samples of
// the trained table and wrapping across the end of the revolution. Returns 0 without a table.
export function periodicErrorCorrectionAt(phase: Angle, curve: PeriodicErrorCurve): Angle {
	const table = curve.correction
	if (table === undefined || table.length === 0) return 0

	const position = (normalizeAngle(phase) / TAU) * table.length
	const index = Math.floor(position)
	const fraction = position - index
	const a = table[index % table.length]
	const b = table[(index + 1) % table.length]
	return a + (b - a) * fraction
}

// Periodic error actually left on the sky at `phase`, radians: the raw error minus whatever the
// controller corrects.
export function periodicErrorAt(phase: Angle, curve: PeriodicErrorCurve): Angle {
	return rawPeriodicErrorAt(phase, curve) - periodicErrorCorrectionAt(phase, curve)
}

// Trains a correction table for `curve` by sampling its raw error into `samples` evenly spaced bins,
// each scaled by `gain`, and returns the curve with that table attached.
//
// This is what a controller does when it records a PE run and plays it back inverted, and it carries
// the two reasons a trained mount still shows residual error. A gain below one is the part of the
// error the recording never captured, from seeing and guiding noise during the run. The bins are the
// more interesting limit: a short table cannot represent a harmonic whose period is comparable to the
// bin spacing, so the higher orders survive playback almost untouched no matter how good the training
// was. Fewer than MIN_CORRECTION_SAMPLES bins leaves the curve untrained, and so does a gain that is
// not a positive finite number: an infinite gain would write a table of infinities, and NaN wherever
// the raw error sampled exactly zero, which `periodicErrorAt` would then hand out as the error left on
// the sky.
//
// `samples` is capped at MAX_CORRECTION_SAMPLES, so asking for more bins than that, or for an infinite
// number of them, produces the largest table rather than an allocation the size of the request. A
// count that is not a number at all is treated as no training.
export function trainPeriodicErrorCorrection(curve: PeriodicErrorCurve, samples: number, gain: number): PeriodicErrorCurve {
	const count = Number.isNaN(samples) ? 0 : Math.min(Math.trunc(samples), MAX_CORRECTION_SAMPLES)
	if (count < MIN_CORRECTION_SAMPLES || !(gain > 0) || !Number.isFinite(gain)) return { amplitudes: curve.amplitudes, phases: curve.phases }

	const correction = new Float64Array(count)
	const step = TAU / count

	for (let i = 0; i < count; i++) {
		correction[i] = rawPeriodicErrorAt(i * step, curve) * gain
	}

	return { amplitudes: curve.amplitudes, phases: curve.phases, correction }
}

// Largest error the curve can leave on the sky, radians.
//
// The raw part is the sum of the harmonic semi-amplitudes, reached only where the harmonics happen to
// peak together, so it already overstates a typical curve; that is the right direction for a caller
// sizing a buffer or a margin.
//
// The correction is added rather than subtracted, because playback does not only reduce the error. A
// table too short to represent a harmonic reconstructs it wrongly between its samples and can oppose
// the raw curve there, leaving more than was there to begin with: a unit third harmonic trained into
// four bins peaks at about 1.36 times its own amplitude. Since interpolation never leaves the range
// of the samples, the magnitude of the largest one bounds the correction everywhere, and the sum
// bounds the residual. That is loose for a well-trained mount, where the two nearly cancel, but a
// margin that is too generous costs a little memory while one that is too small loses stars.
export function periodicErrorBound(curve: PeriodicErrorCurve): Angle {
	let bound = 0
	for (let i = 0; i < curve.amplitudes.length; i++) bound += Math.abs(curve.amplitudes[i])

	const table = curve.correction

	if (table !== undefined) {
		let peak = 0
		for (let i = 0; i < table.length; i++) peak = Math.max(peak, Math.abs(table[i]))
		bound += peak
	}

	return bound
}

// Harmonic terms of MOUNT_PERIODIC_ERROR: worm period in seconds, semi-amplitudes in arcseconds and
// phases in degrees.
const PERIODIC_ERROR: readonly NumberBinding<'period' | 'amplitude' | 'phase' | 'amplitude2' | 'phase2' | 'amplitude3' | 'phase3'>[] = [
	['RA_PERIOD', 'Worm Period (s)', 'period', 0, DAYSEC, 1, '%.0f'],
	['RA_AMPLITUDE', 'Amplitude (arcsec)', 'amplitude', 0, 3600, 0.1, '%.3f'],
	['RA_PHASE', 'Phase (deg)', 'phase', 0, 360, 1, '%.1f'],
	['RA_AMPLITUDE_2', '2nd Harmonic (arcsec)', 'amplitude2', 0, 3600, 0.1, '%.3f'],
	['RA_PHASE_2', '2nd Harmonic Phase (deg)', 'phase2', 0, 360, 1, '%.1f'],
	['RA_AMPLITUDE_3', '3rd Harmonic (arcsec)', 'amplitude3', 0, 3600, 0.1, '%.3f'],
	['RA_PHASE_3', '3rd Harmonic Phase (deg)', 'phase3', 0, 360, 1, '%.1f'],
]

// Trained correction of MOUNT_PEC: recorded samples per revolution and playback gain.
const CORRECTION: readonly NumberBinding<'pecSamples' | 'pecGain'>[] = [
	['SAMPLES', 'Recorded Samples', 'pecSamples', 0, 1024, 1, '%.0f'],
	['GAIN', 'Playback Gain', 'pecGain', 0, 1, 0.01, '%.3f'],
]

// The right-ascension worm: its phase, integrated from the motion of the axis, and the periodic error
// it produces with the trained correction played back.
//
// There is deliberately no declination counterpart: classic periodic error comes from the worm of the
// axis that turns continuously, which during tracking is only right ascension.
export class MountPeriodicError extends SimulatorComponent {
	readonly #error: ReturnType<typeof makeBoundNumberVector>
	readonly #correction: ReturnType<typeof makeBoundNumberVector>
	// Live phase, degrees. Read-only: it stands still while the mount is parked and speeds up in a slew.
	readonly #phaseVector = makeNumberVector('', 'MOUNT_WORM_PHASE', 'Worm Phase', SIMULATION, 'ro', ['PHASE', 'Phase (deg)', 0, 0, 360, 0.1, '%.3f'])

	readonly properties: readonly ReturnType<typeof makeNumberVector>[]
	readonly transient: readonly ReturnType<typeof makeNumberVector>[]

	// Whether the periodic-error family is simulated; set through `refresh`.
	#enabled = false
	// Harmonics with the trained correction, rebuilt whenever a term changes so evaluating the
	// boresight allocates nothing; the shared identity while nothing applies.
	#curve: PeriodicErrorCurve = IDENTITY_PERIODIC_ERROR_CURVE
	// Phase of the worm, radians in [0, TAU). Physical state: it survives a disconnection.
	#phase: Angle = 0
	// Simulated time the phase was last published at, milliseconds.
	#publishedAt = 0

	// `config` gives the initial terms; `changed` runs after a command changed them.
	constructor(
		bus: ComponentBus,
		config: MountPeriodicErrorConfig,
		readonly changed: () => void,
	) {
		super(bus)
		this.#error = makeBoundNumberVector('MOUNT_PERIODIC_ERROR', 'Periodic Error', SIMULATION, PERIODIC_ERROR, config)
		this.#correction = makeBoundNumberVector('MOUNT_PEC', 'PEC', SIMULATION, CORRECTION, config)
		this.properties = [this.#error, this.#correction, this.#phaseVector]
		this.transient = [this.#phaseVector]
	}

	// Phase of the worm, radians in [0, TAU).
	get phase(): Angle {
		return this.#phase
	}

	// Harmonics in effect, the shared identity while the family is off or has nothing to apply.
	get curve() {
		return this.#curve
	}

	// Periodic error at the current phase, radians of right ascension; zero while nothing applies.
	get error(): Angle {
		return this.#curve === IDENTITY_PERIODIC_ERROR_CURVE ? 0 : periodicErrorAt(this.#phase, this.#curve)
	}

	// Rebuilds the curve for the family being `enabled` or not.
	//
	// Retraining on every change is what a controller does when the mechanics change under it. A worm
	// that never turns collapses to the identity too: without a period the harmonics would become a
	// constant offset, which is an index error rather than a periodic one.
	refresh(enabled: boolean) {
		this.#enabled = enabled
		const terms = readBoundNumberVector(this.#error, PERIODIC_ERROR)

		if (!enabled || terms.period <= 0 || (terms.amplitude === 0 && terms.amplitude2 === 0 && terms.amplitude3 === 0)) {
			this.#curve = IDENTITY_PERIODIC_ERROR_CURVE
			return
		}

		const amplitudes = new Float64Array(PERIODIC_ERROR_HARMONICS)
		const phases = new Float64Array(PERIODIC_ERROR_HARMONICS)
		amplitudes[0] = terms.amplitude * ASEC2RAD
		amplitudes[1] = terms.amplitude2 * ASEC2RAD
		amplitudes[2] = terms.amplitude3 * ASEC2RAD
		phases[0] = terms.phase * DEG2RAD
		phases[1] = terms.phase2 * DEG2RAD
		phases[2] = terms.phase3 * DEG2RAD

		const { pecSamples, pecGain } = readBoundNumberVector(this.#correction, CORRECTION)
		this.#curve = trainPeriodicErrorCorrection({ amplitudes, phases }, pecSamples, pecGain)
	}

	// Advances the phase over `dtSeconds` with the right-ascension motor at `motorRate`, radians per
	// second. One revolution per period at the sidereal tracking rate; tracking advances it. Integrated
	// whether or not the family is on, because the worm goes on turning while its error is not applied.
	advance(motorRate: number, dtSeconds: number) {
		const period = this.#error.elements.RA_PERIOD.value
		if (period <= 0) return
		this.#phase = normalizeAngle(this.#phase + (-motorRate / SIDEREAL_DRIFT_RATE) * (TAU / period) * dtSeconds)
	}

	// Publishes the phase at most once per `interval` milliseconds of simulated time `now`. A clock set
	// backwards publishes at once and re-registers the epoch.
	publish(now: number, interval: number) {
		if (!this.#enabled || this.#error.elements.RA_PERIOD.value <= 0) return
		const elapsed = now - this.#publishedAt
		if (elapsed >= 0 && elapsed < interval) return
		this.#publishedAt = now
		this.#phaseVector.elements.PHASE.value = this.#phase / DEG2RAD
		this.bus.notify(this.#phaseVector)
	}

	// Handles MOUNT_PERIODIC_ERROR and MOUNT_PEC.
	handleNumber(vector: NewNumberVector) {
		const property = vector.name === this.#error.name ? this.#error : vector.name === this.#correction.name ? this.#correction : undefined
		if (property === undefined) return false

		if (applyNumberVectorValues(property, vector.elements)) {
			this.refresh(this.#enabled)
			this.changed()
			this.bus.notify(property)
		}

		return true
	}
}
