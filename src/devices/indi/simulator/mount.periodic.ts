import { TAU } from '../../../core/constants'
import { type Angle, normalizeAngle } from '../../../math/units/angle'

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
