import { describe, expect, test } from 'bun:test'
import { PI, PIOVERTWO, TAU } from '../../../../src/core/constants'
// oxfmt-ignore
import { IDENTITY_PERIODIC_ERROR_CURVE, PERIODIC_ERROR_HARMONICS, periodicErrorAt, periodicErrorBound, periodicErrorCorrectionAt, type PeriodicErrorCurve, rawPeriodicErrorAt, trainPeriodicErrorCorrection } from '../../../../src/devices/indi/simulator/mount.periodic'
import { arcsec, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the harmonic periodic error of a worm and for the correction a controller trains
// against it.

// Builds a curve from semi-amplitudes in arcseconds and phases in radians.
function curve(amplitudes: readonly number[], phases: readonly number[] = []): PeriodicErrorCurve {
	const a = new Float64Array(PERIODIC_ERROR_HARMONICS)
	const p = new Float64Array(PERIODIC_ERROR_HARMONICS)

	for (let i = 0; i < PERIODIC_ERROR_HARMONICS; i++) {
		a[i] = arcsec(amplitudes[i] ?? 0)
		p[i] = phases[i] ?? 0
	}

	return { amplitudes: a, phases: p }
}

// Largest absolute residual over one revolution, arcseconds.
function peakResidual(target: PeriodicErrorCurve, samples = 2000) {
	let peak = 0

	for (let i = 0; i < samples; i++) {
		peak = Math.max(peak, Math.abs(toArcsec(periodicErrorAt((i * TAU) / samples, target))))
	}

	return peak
}

describe('periodic error', () => {
	// A 5 arcsec semi-amplitude is typical of a small equatorial mount.
	const amplitude = 5

	test('follows the sine over one full worm revolution', () => {
		const worm = curve([amplitude])

		expect(toArcsec(rawPeriodicErrorAt(0, worm))).toBeCloseTo(0, 9)
		expect(toArcsec(rawPeriodicErrorAt(PIOVERTWO, worm))).toBeCloseTo(amplitude, 9)
		expect(toArcsec(rawPeriodicErrorAt(PI, worm))).toBeCloseTo(0, 9)
		expect(toArcsec(rawPeriodicErrorAt(3 * PIOVERTWO, worm))).toBeCloseTo(-amplitude, 9)
	})

	test('is periodic across revolution boundaries', () => {
		const worm = curve([amplitude, 2, 1])

		for (const phase of [0.3, 1.7, PI, 5.2]) {
			expect(rawPeriodicErrorAt(phase + TAU * 7, worm)).toBeCloseTo(rawPeriodicErrorAt(phase, worm), 12)
		}
	})

	test('is an absolute offset, not an increment', () => {
		// The regression this guards: the offset used to be applied as the difference from the previous
		// evaluation, so a second call at the same point returned zero instead of the same value.
		const worm = curve([amplitude])
		const first = rawPeriodicErrorAt(1.234, worm)
		expect(rawPeriodicErrorAt(1.234, worm)).toBe(first)
		expect(first).not.toBe(0)
	})

	test('is disabled by zero amplitudes', () => {
		expect(rawPeriodicErrorAt(1.234, IDENTITY_PERIODIC_ERROR_CURVE)).toBe(0)
		expect(periodicErrorBound(IDENTITY_PERIODIC_ERROR_CURVE)).toBe(0)
	})

	test('turns each harmonic at its own order', () => {
		// The second harmonic completes two cycles per revolution, so it repeats at half a turn while the
		// fundamental has changed sign.
		const second = curve([0, amplitude])
		expect(rawPeriodicErrorAt(0.4 + PI, second)).toBeCloseTo(rawPeriodicErrorAt(0.4, second), 12)

		const third = curve([0, 0, amplitude])
		expect(rawPeriodicErrorAt(0.4 + TAU / 3, third)).toBeCloseTo(rawPeriodicErrorAt(0.4, third), 12)
	})

	test('shifts a harmonic by its phase', () => {
		// A quarter turn of phase on the fundamental turns the sine into a cosine, so the peak moves to
		// the start of the revolution.
		expect(toArcsec(rawPeriodicErrorAt(0, curve([amplitude], [PIOVERTWO])))).toBeCloseTo(amplitude, 9)
	})

	test('sums the harmonics', () => {
		const combined = curve([amplitude, 2, 1])
		const parts = [curve([amplitude]), curve([0, 2]), curve([0, 0, 1])]
		const phase = 1.234
		const sum = parts.reduce((total, part) => total + rawPeriodicErrorAt(phase, part), 0)
		expect(rawPeriodicErrorAt(phase, combined)).toBeCloseTo(sum, 15)
	})

	test('bounds the error by the sum of the amplitudes', () => {
		const worm = curve([amplitude, 2, 1])
		expect(toArcsec(periodicErrorBound(worm))).toBeCloseTo(8, 9)
		expect(peakResidual(worm)).toBeLessThanOrEqual(8 + 1e-9)
	})
})

describe('periodic error correction', () => {
	test('leaves the error untouched without a trained table', () => {
		const worm = curve([5])
		expect(periodicErrorCorrectionAt(1.234, worm)).toBe(0)
		expect(periodicErrorAt(1.234, worm)).toBe(rawPeriodicErrorAt(1.234, worm))
	})

	test('cancels almost all of a well-sampled fundamental', () => {
		const trained = trainPeriodicErrorCorrection(curve([5]), 256, 1)
		// What is left is the linear interpolation error between bins, quadratic in the bin spacing.
		expect(peakResidual(trained)).toBeLessThan(0.005)
	})

	test('leaves the uncaptured fraction behind when the gain is below one', () => {
		const trained = trainPeriodicErrorCorrection(curve([5]), 256, 0.8)
		// A recording that caught only 80% of the error plays back 80% of it, so a fifth survives.
		expect(peakResidual(trained)).toBeCloseTo(1, 2)
	})

	test('cannot correct a harmonic the table is too short to represent', () => {
		// Four bins resolve the fundamental and nothing above it. The third harmonic completes three
		// cycles between the samples, so playback barely touches it and can only make it worse.
		const worm = curve([0, 0, 5])
		const trained = trainPeriodicErrorCorrection(worm, 4, 1)
		expect(peakResidual(trained)).toBeGreaterThan(4)

		// The same curve with enough bins is corrected properly, which is what makes this a sampling
		// limit rather than a defect of the training.
		expect(peakResidual(trainPeriodicErrorCorrection(worm, 256, 1))).toBeLessThan(0.05)
	})

	test('interpolates and wraps across the end of the revolution', () => {
		const trained = trainPeriodicErrorCorrection(curve([5]), 8, 1)
		// Just before and just after the wrap the correction must be continuous, not jump back to the
		// first sample.
		const before = periodicErrorCorrectionAt(TAU - 1e-6, trained)
		const after = periodicErrorCorrectionAt(1e-6, trained)
		expect(toArcsec(Math.abs(after - before))).toBeLessThan(0.01)

		// Phases beyond a full revolution fold back onto it.
		expect(periodicErrorCorrectionAt(1.2 + TAU * 3, trained)).toBeCloseTo(periodicErrorCorrectionAt(1.2, trained), 12)
	})

	test('bounds a residual that playback made worse than the raw curve', () => {
		// Four bins cannot represent a third harmonic, so the correction reconstructs it wrongly between
		// its samples and opposes the raw curve there, leaving more error than there was to begin with.
		// A bound that ignored the correction would understate this and under-size a camera margin.
		const worm = curve([0, 0, 5])
		const trained = trainPeriodicErrorCorrection(worm, 4, 1)

		const residual = peakResidual(trained)
		expect(residual).toBeGreaterThan(toArcsec(periodicErrorBound(worm)))
		expect(residual).toBeLessThanOrEqual(toArcsec(periodicErrorBound(trained)))
	})

	test('bounds the residual of every training length', () => {
		for (const samples of [4, 5, 8, 16, 64, 256]) {
			for (const gain of [0.5, 1]) {
				const trained = trainPeriodicErrorCorrection(curve([5, 2, 1]), samples, gain)
				expect(peakResidual(trained)).toBeLessThanOrEqual(toArcsec(periodicErrorBound(trained)))
			}
		}
	})

	test('refuses to train from a table too short or a non-positive gain', () => {
		const worm = curve([5])
		expect(trainPeriodicErrorCorrection(worm, 3, 1).correction).toBeUndefined()
		expect(trainPeriodicErrorCorrection(worm, 0, 1).correction).toBeUndefined()
		expect(trainPeriodicErrorCorrection(worm, 256, 0).correction).toBeUndefined()
	})

	test('caps the size of the table it will build', () => {
		const worm = curve([5])

		// The count sizes an allocation, and this is exported: an infinite or absurd request has to come
		// back as the largest table rather than as a RangeError or a multi-gigabyte array.
		expect(trainPeriodicErrorCorrection(worm, Infinity, 1).correction).toHaveLength(1024)
		expect(trainPeriodicErrorCorrection(worm, 1e12, 1).correction).toHaveLength(1024)
		expect(trainPeriodicErrorCorrection(worm, 1024, 1).correction).toHaveLength(1024)

		// A count that is not a number is no instruction at all, so nothing is trained.
		expect(trainPeriodicErrorCorrection(worm, Number.NaN, 1).correction).toBeUndefined()
	})
})
