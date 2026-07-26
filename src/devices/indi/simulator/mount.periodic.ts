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
// was. Fewer than MIN_CORRECTION_SAMPLES bins, or a non-positive gain, leaves the curve untrained.
export function trainPeriodicErrorCorrection(curve: PeriodicErrorCurve, samples: number, gain: number): PeriodicErrorCurve {
	const count = Math.trunc(samples)
	if (count < MIN_CORRECTION_SAMPLES || !(gain > 0)) return { amplitudes: curve.amplitudes, phases: curve.phases }

	const correction = new Float64Array(count)
	const step = TAU / count

	for (let i = 0; i < count; i++) {
		correction[i] = rawPeriodicErrorAt(i * step, curve) * gain
	}

	return { amplitudes: curve.amplitudes, phases: curve.phases, correction }
}

// Largest error the curve can produce, radians, being the sum of the harmonic semi-amplitudes.
//
// Reached only where the harmonics happen to peak together, so it overstates a typical curve; that is
// the right direction for a caller sizing a buffer or a margin. The correction is ignored, since it
// can only reduce the residual.
export function periodicErrorBound(curve: PeriodicErrorCurve): Angle {
	let bound = 0
	for (let i = 0; i < curve.amplitudes.length; i++) bound += Math.abs(curve.amplitudes[i])
	return bound
}
