import { expect, test } from 'bun:test'
import type { GuideCommand, GuideFrame, GuideStar } from '../src/guider'
import { GuidingAssistant, type GuidingAssistantResult } from '../src/guider.assistant'
import { GuiderClient } from '../src/guider.client'

const WIDTH = 800
const HEIGHT = 600

// Builds one guide star with deterministic photometry.
function star(patch: Partial<GuideStar> = {}): GuideStar {
	return { x: 120, y: 140, snr: 20, flux: 3000, hfd: 3, ellipticity: 0.15, fwhm: 4, ...patch }
}

// Builds one frame carrying a single guide star.
function frame(timestamp: number, frameId: number, patch: Partial<GuideStar> = {}): GuideFrame {
	return { stars: [star(patch)], width: WIDTH, height: HEIGHT, timestamp, frameId }
}

// Builds a guide command with mount-axis diagnostics in pixels.
function command(raPx: number, decPx: number, patch: Partial<GuideCommand['diagnostics']> = {}, state: GuideCommand['state'] = 'guiding'): GuideCommand {
	return {
		state,
		ra: { direction: null, duration: 0 },
		dec: { direction: null, duration: 0 },
		diagnostics: {
			totalStars: 1,
			acceptedStars: 1,
			qualityScore: 1,
			modeUsed: 'single-star',
			axisErrorRA: raPx,
			axisErrorDEC: decPx,
			dx: raPx,
			dy: decPx,
			rejectedReasons: {},
			badFrame: false,
			lostFrames: 0,
			lost: false,
			ditherActive: false,
			droppedFrame: false,
			notes: [],
			...patch,
		},
	}
}

// Feeds a sequence of synthetic guide samples into an assistant run.
function run(samples: readonly [number, number, number, Partial<GuideStar>?][], config: ConstructorParameters<typeof GuidingAssistant>[0] = {}): GuidingAssistantResult {
	const assistant = new GuidingAssistant(config)
	assistant.start(0)

	for (let i = 0; i < samples.length; i++) {
		const [timestamp, ra, dec, patch] = samples[i]
		assistant.addSample(frame(timestamp, i + 1, patch), command(ra, dec))
	}

	return assistant.complete(samples.at(-1)?.[0] ?? 0)
}

test('computes guide-assistant motion metrics and arc-second conversions', () => {
	const result = run(
		[
			[0, 0, 0],
			[1000, 0.8, -0.4],
			[2000, -0.6, 0.3],
			[3000, 1.1, -0.5],
		],
		{ imageScaleArcsecPerPixel: 2, declination: 0, exposureSeconds: 1 },
	)

	expect(result.sampleCount).toBe(4)
	expect(result.motion.ra.peakPx).toBeCloseTo(1.1, 8)
	expect(result.motion.ra.peakArcsec).toBeCloseTo(2.2, 8)
	expect(result.motion.raPeakPeakPx).toBeCloseTo(1.7, 8)
	expect(result.motion.raPeakPeakArcsec).toBeCloseTo(3.4, 8)
	expect(result.motion.totalRmsPx).toBeGreaterThan(0)
	expect(result.motion.totalRmsArcsec).toBeCloseTo(result.motion.totalRmsPx * 2, 8)
	expect(result.meanSnr).toBeCloseTo(20, 8)
	expect(result.meanStarMass).toBeCloseTo(3000, 8)
})

test('uses calibrated axis errors when image motion is in a rotated frame', () => {
	const assistant = new GuidingAssistant({ imageScaleArcsecPerPixel: 2 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0, { axisErrorRA: 0, axisErrorDEC: 0, dx: 0, dy: 0 }))
	assistant.addSample(frame(1000, 2), command(0, 1, { axisErrorRA: 0, axisErrorDEC: 1, dx: 1, dy: 0 }))

	const result = assistant.complete(1000)

	expect(result.motion.ra.peakPx).toBeCloseTo(0, 8)
	expect(result.motion.dec.peakPx).toBeCloseTo(1, 8)
	expect(result.motion.ra.peakArcsec).toBeCloseTo(0, 8)
	expect(result.motion.dec.peakArcsec).toBeCloseTo(2, 8)
})

test('requires declination and image scale for polar alignment error', () => {
	const samples: readonly [number, number, number][] = [
		[0, 0, 0],
		[60000, 0, 2],
		[120000, 0, 4],
	]

	const withoutContext = run(samples)
	expect(withoutContext.motion.polarAlignmentErrorArcmin).toBeNull()
	expect(withoutContext.notes).toContain('image_scale_unavailable')
	expect(withoutContext.notes).toContain('declination_unavailable')

	const withContext = run(samples, { imageScaleArcsecPerPixel: 1, declination: 0 })
	expect(withContext.motion.dec.driftRatePxPerMinute).toBeCloseTo(2, 8)
	expect(withContext.motion.polarAlignmentErrorArcmin).toBeCloseTo(7.6394, 4)
})

test('generates PHD2-like recommendations for exposure, min-move, star quality, focus, and polar error', () => {
	const result = run(
		[
			[0, 0, 0, { snr: 8, flux: 1000, hfd: 5 }],
			[60000, 0.2, 2, { snr: 9, flux: 1200, hfd: 5.4 }],
			[120000, -0.2, 4, { snr: 7, flux: 1100, hfd: 5.2 }],
		],
		{ imageScaleArcsecPerPixel: 1.2, declination: 0, suspectCalibration: true },
	)

	const kinds = result.recommendations.map((recommendation) => recommendation.kind)
	expect(kinds).toContain('exposure')
	expect(kinds).toContain('calibration')
	expect(kinds).toContain('star')
	expect(kinds).toContain('focus')
	expect(kinds).toContain('polar-alignment')
	expect(kinds).toContain('ra-min-move')
	expect(kinds).toContain('dec-min-move')
	expect(result.recommendedRaMinMove).toBeGreaterThan(0)
	expect(result.recommendedDecMinMove).toBeGreaterThanOrEqual(result.recommendedRaMinMove)
})

test('applies the single-star min-move floor to DEC recommendations', () => {
	const result = run(
		[
			[0, 0, 0],
			[1000, 0, 0],
		],
		{ multiStar: false },
	)

	expect(result.recommendedRaMinMove).toBeCloseTo(0.1, 8)
	expect(result.recommendedDecMinMove).toBeCloseTo(0.1, 8)
})

test('uses the high-precision exposure ceiling when RA drift is absent', () => {
	const result = run(
		[
			[0, 0, 0],
			[1000, 0, 0],
		],
		{ hasHighPrecisionEncoders: true },
	)

	expect(result.motion.raMaxDriftRatePxPerSecond).toBe(0)
	expect(result.recommendedMinExposureSeconds).toBe(4)
	expect(result.recommendedMaxExposureSeconds).toBe(8)
})

test('bases drift-limited exposure on RA min-move instead of residual RMS', () => {
	const result = run([
		[0, 0, 0],
		[1000, 0.01, 0],
		[2000, 0.02, 0],
		[3000, 0.03, 0],
	])

	expect(result.motion.ra.rmsPx).toBeCloseTo(0, 8)
	expect(result.motion.raMaxDriftRatePxPerSecond).toBeCloseTo(0.01, 8)
	expect(result.recommendedRaMinMove).toBeCloseTo(0.05, 8)
	expect(result.recommendedMinExposureSeconds).toBe(2)
	expect(result.recommendedMaxExposureSeconds).toBe(4)
})

test('caps exposure recommendations at the RA drift limit', () => {
	const result = run([
		[0, 0, 0],
		[1000, 0.05, 0],
		[2000, 0.1, 0],
	])

	expect(result.motion.raMaxDriftRatePxPerSecond).toBeCloseTo(0.05, 8)
	expect(result.recommendedRaMinMove).toBeCloseTo(0.05, 8)
	expect(result.motion.driftLimitingExposureSeconds).toBeCloseTo(1, 8)
	expect(result.recommendedMinExposureSeconds).toBe(1)
	expect(result.recommendedMaxExposureSeconds).toBe(1)
})

test('skips non-guiding and bad frames before recording samples', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0, {}, 'initializing'))
	assistant.addSample(frame(1000, 2), command(0, 0, { badFrame: true }))

	let result = assistant.result(1000)
	expect(result.sampleCount).toBe(0)
	expect(result.notes).toContain('no_samples')

	assistant.addSample(frame(2000, 3), command(0.3, -0.2))
	result = assistant.result(2000)

	expect(result.sampleCount).toBe(1)
	expect(result.motion.ra.peakPx).toBeCloseTo(0, 8)
	expect(result.motion.dec.peakPx).toBeCloseTo(0, 8)
})

test('measures compensable DEC backlash from delayed south motion', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(1000, 2), command(0, 0.6))
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(2000, 3), command(0, 1.2))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(3000, 4), command(0, 1.2))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(4000, 5), command(0, 1.2))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(5000, 6), command(0, 0.6))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(6000, 7), command(0, 0.1))
	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.backlashMs).toBe(200)
	expect(step.result.backlash?.recommendedCompensationMs).toBe(200)
	expect(step.result.recommendations.some((recommendation) => recommendation.kind === 'backlash' && recommendation.actionable)).toBeTrue()
})

test('uses DEC calibration sign when measuring backlash motion', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, decPositiveDirection: 'south', backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(1000, 2), command(0, -0.6))
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(2000, 3), command(0, -1.2))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(3000, 4), command(0, -0.6))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(4000, 5), command(0, -0.1))
	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.northDistancePx).toBeCloseTo(1.2, 8)
})

test('uses calibrated DEC-axis errors for backlash despite rotated image deltas', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0, { dx: 0, dy: 0 }))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(1000, 2), command(0, 1.2, { dx: 1.2, dy: 0 }))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(2000, 3), command(0, 0.1, { dx: 0.1, dy: 0 }))
	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.northDistancePx).toBeCloseTo(1.2, 8)
})

test('completes DEC backlash when south return overshoots the origin', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	step = assistant.addSample(frame(1000, 2), command(0, 1))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(2000, 3), command(0, -0.6))
	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.phase).toBe('completed')
	expect(step.result.backlash?.southDistancePx).toBeCloseTo(1, 8)
})

test('keeps DEC backlash running until the south return is within tolerance', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 4, backlashReturnTolerancePx: 0.05, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	let step = assistant.addSample(frame(1000, 2), command(0, 4))
	expect(step.pulse?.dec.direction).toBe('south')

	step = assistant.addSample(frame(2000, 3), command(0, 0.4))
	expect(step.result.status).toBe('backlash')
	expect(step.result.backlash).toBeNull()
	expect(step.pulse?.dec.direction).toBe('south')
})

test('waits for a valid frame before aligning the first backlash pulse', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1.2, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	const badAlignment = assistant.alignBacklashOrigin(frame(1000, 2), command(0, 3, { badFrame: true }))
	expect(badAlignment.aligned).toBeFalse()
	expect(badAlignment.result.status).toBe('backlash')

	const goodAlignment = assistant.alignBacklashOrigin(frame(2000, 3), command(0, 0.4))
	expect(goodAlignment.aligned).toBeTrue()

	step = assistant.addSample(frame(3000, 4), command(0, 1.4))
	expect(step.pulse?.dec.direction).toBe('north')
	expect(step.result.status).toBe('backlash')
})

test('aligns the first backlash pulse to the current frame boundary', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1.2, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	let step = assistant.startBacklashTest()
	expect(step.pulse?.dec.direction).toBe('north')

	const alignment = assistant.alignBacklashOrigin(frame(1000, 2), command(0, 0.4))
	expect(alignment.aligned).toBeTrue()

	step = assistant.addSample(frame(2000, 3), command(0, 1.4))

	expect(step.pulse?.dec.direction).toBe('north')
	expect(step.result.status).toBe('backlash')
})

test('keeps backlash frames out of passive guiding metrics', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.addSample(frame(1000, 2), command(0.2, 0.1))

	const before = assistant.result(1000)
	assistant.startBacklashTest()
	assistant.addSample(frame(2000, 3), command(0, 2))
	assistant.addSample(frame(3000, 4), command(0, 4))
	const after = assistant.result(3000)

	expect(after.sampleCount).toBe(before.sampleCount)
	expect(after.motion.dec.peakPx).toBeCloseTo(before.motion.dec.peakPx, 8)
	expect(after.motion.dec.driftRatePxPerMinute).toBeCloseTo(before.motion.dec.driftRatePxPerMinute, 8)
	expect(after.recommendedDecMinMove).toBeCloseTo(before.recommendedDecMinMove, 8)
})

test('fails DEC backlash when south motion never returns', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 0.5, backlashMaxPulsesPerDirection: 2, backlashPulseMs: 100 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()
	assistant.addSample(frame(1000, 2), command(0, 0.6))

	let step = assistant.addSample(frame(2000, 3), command(0, 0.6))
	expect(step.pulse?.dec.direction).toBe('south')
	step = assistant.addSample(frame(3000, 4), command(0, 0.6))
	expect(step.result.status).toBe('failed')
	expect(step.result.backlash?.phase).toBe('failed')
	expect(step.result.recommendations.some((recommendation) => recommendation.kind === 'backlash')).toBeTrue()
})

test('aborts active DEC backlash instead of completing it', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashPulseMs: 100 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	const result = assistant.abortBacklash('backlash test aborted', 1000)

	expect(result.status).toBe('failed')
	expect(result.backlash?.phase).toBe('aborted')
	expect(result.backlash?.northPulses).toBe(1)
	expect(result.recommendations.some((recommendation) => recommendation.kind === 'backlash')).toBeFalse()
})

test('preserves partial DEC backlash data when an active test fails', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()
	assistant.addSample(frame(1000, 2), command(0, 1.2))
	assistant.addSample(frame(2000, 3), command(0, 1.2))

	const result = assistant.fail('guide star lost', 3000)

	expect(result.status).toBe('failed')
	expect(result.backlash?.phase).toBe('failed')
	expect(result.backlash?.northDistancePx).toBeCloseTo(1.2, 8)
	expect(result.backlash?.northPulses).toBe(1)
	expect(result.backlash?.southPulses).toBe(2)
})

test('does not report passive guide failures as backlash failures', () => {
	const assistant = new GuidingAssistant({ measureBacklash: false })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))

	const result = assistant.fail('guide star lost', 1000)

	expect(result.status).toBe('failed')
	expect(result.backlash).toBeNull()
	expect(result.recommendations.some((recommendation) => recommendation.kind === 'backlash')).toBeFalse()
})

test('guider client exposes guiding-assistant hooks without starting outside guiding', () => {
	const client = new GuiderClient({} as never, {} as never)
	expect(client.guidingAssistantResult()).toBeUndefined()
	expect(client.startGuidingAssistant()).toBeFalse()
	expect(client.stopGuidingAssistant()).toBeUndefined()
})

test('auto-starts from idle and resets samples on a fresh start', () => {
	const assistant = new GuidingAssistant()
	const step = assistant.addSample(frame(5000, 1), command(0.3, -0.2))

	expect(step.result.status).toBe('measuring')
	expect(step.result.startTime).toBe(5000)
	expect(step.result.sampleCount).toBe(1)

	const restarted = assistant.start(0)
	expect(restarted.status).toBe('measuring')
	expect(restarted.startTime).toBe(0)
	expect(restarted.sampleCount).toBe(0)
})

test('does not accept samples after completion', () => {
	const assistant = new GuidingAssistant()
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.addSample(frame(1000, 2), command(0.5, -0.25))

	const completed = assistant.complete(1000)
	const late = assistant.addSample(frame(2000, 3), command(10, 10)).result

	expect(late.status).toBe('completed')
	expect(late.sampleCount).toBe(completed.sampleCount)
	expect(late.motion.ra.peakPx).toBeCloseTo(completed.motion.ra.peakPx, 8)
	expect(late.motion.dec.peakPx).toBeCloseTo(completed.motion.dec.peakPx, 8)
})

test('produces finite baseline recommendations with no samples', () => {
	const result = new GuidingAssistant().complete(0)

	expect(result.status).toBe('completed')
	expect(result.sampleCount).toBe(0)
	expect(result.notes).toContain('no_samples')
	expect(result.meanSnr).toBe(0)
	expect(result.meanHfd).toBe(0)
	expect(result.motion.totalRmsPx).toBe(0)
	expect(result.motion.driftLimitingExposureSeconds).toBeNull()

	const kinds = result.recommendations.map((recommendation) => recommendation.kind)
	expect(kinds).toContain('exposure')
	expect(kinds).toContain('ra-min-move')
	expect(kinds).toContain('dec-min-move')
	expect(kinds).not.toContain('star')
	expect(Number.isFinite(result.recommendedDecMinMove)).toBeTrue()
	expect(Number.isFinite(result.recommendedRaMinMove)).toBeTrue()
	expect(Number.isFinite(result.recommendedMinExposureSeconds)).toBeTrue()
	expect(Number.isFinite(result.recommendedMaxExposureSeconds)).toBeTrue()
})

test('keeps calibrated axes paired when falling back to image deltas', () => {
	const assistant = new GuidingAssistant()
	assistant.start(0)

	// axis-resolved errors missing: the image-space dx/dy fallback is used.
	assistant.addSample(frame(0, 1), command(0, 0, { axisErrorRA: undefined, axisErrorDEC: undefined, dx: 0.3, dy: -0.2 }))
	// partial/non-finite axis errors fall back to the complete dx/dy pair instead of mixing frames.
	assistant.addSample(frame(1000, 2), command(0, 0, { axisErrorRA: Number.NaN, dx: 0.5, dy: 0.5 }))
	// no complete axis or image-space pair is rejected.
	assistant.addSample(frame(2000, 3), command(0, 0, { axisErrorRA: 0.7, axisErrorDEC: undefined, dx: 0.9, dy: undefined }))
	assistant.addSample(frame(2000, 3), command(0, 0, { axisErrorRA: undefined, axisErrorDEC: undefined, dx: undefined, dy: undefined }))

	expect(assistant.result(2000).sampleCount).toBe(2)
})

test('exposes backlash readiness through its getters', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashPulseMs: 100 })
	assistant.start(0)

	expect(assistant.canMeasureBacklash).toBeFalse()

	assistant.addSample(frame(0, 1), command(0, 0))
	expect(assistant.canMeasureBacklash).toBeTrue()
	expect(assistant.measuringBacklash).toBeFalse()

	assistant.startBacklashTest()
	expect(assistant.canMeasureBacklash).toBeFalse()
	expect(assistant.measuringBacklash).toBeTrue()
})

test('never reports backlash readiness when measurement is disabled', () => {
	const assistant = new GuidingAssistant({ measureBacklash: false })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	expect(assistant.canMeasureBacklash).toBeFalse()
})

test('flags short sampling intervals and clears the flag once satisfied', () => {
	const short = run([
		[0, 0, 0],
		[1000, 0.1, 0.1],
	])
	expect(short.notes).toContain('sampling_interval_short')

	const enough = run(
		[
			[0, 0, 0],
			[2000, 0.1, 0.1],
		],
		{ minSamplingSeconds: 1 },
	)
	expect(enough.notes).not.toContain('sampling_interval_short')
	expect(enough.notes).not.toContain('no_samples')
})

test('reports drift-limited exposure from RA min-move and clears it without drift', () => {
	const drifting = run([
		[0, 0, 0],
		[1000, 0.01, 0],
		[2000, 0.02, 0],
		[3000, 0.03, 0],
	])
	// recommended RA min-move 0.05 px / max adjacent RA rate 0.01 px/s = 5 s.
	expect(drifting.motion.driftLimitingExposureSeconds).toBeCloseTo(5, 6)

	const calm = run([
		[0, 0, 0],
		[1000, 0, 0],
	])
	expect(calm.motion.driftLimitingExposureSeconds).toBeNull()
})

test('estimates seeing from the quietest window on long runs', () => {
	// Calm first two minutes, noisy zig-zag tail; the run spans > 144 s so the
	// overlapping-window seeing estimator (not the single-fit branch) is exercised.
	const series: [number, number, number][] = []

	for (let i = 0; i <= 20; i++) {
		const dec = i <= 12 ? 0 : i % 2 === 0 ? 1 : -1
		series.push([i * 10000, 0, dec])
	}

	const result = run(series)

	expect(result.elapsedSeconds).toBeCloseTo(200, 6)
	// the quiet [0, 120] s window drives the seeing estimate toward zero...
	expect(result.motion.decCorrectedRmsPx).toBeCloseTo(0, 6)
	// ...while the whole-run residual still carries the noisy tail.
	expect(result.motion.dec.rmsPx).toBeGreaterThan(0.1)
	expect(result.recommendedDecMinMove).toBeCloseTo(0.05, 8)
})

test('falls back to a safe DEC min-move when seeing fails the sanity check', () => {
	const result = run(
		[
			[0, 0, 1],
			[1000, 0, -1],
			[2000, 0, -1],
			[3000, 0, 1],
		],
		{ imageScaleArcsecPerPixel: 2 },
	)

	// DEC residual RMS is 1 px; 0.9 * 1.65 -> 1.5 px which at 2"/px exceeds the 1.25"/px sanity limit.
	expect(result.motion.decCorrectedRmsPx).toBeCloseTo(1, 8)
	expect(result.recommendedDecMinMove).toBeCloseTo(0.2, 8)
	expect(result.recommendedRaMinMove).toBeCloseTo(0.15, 8)
})

test('returns no polar alignment estimate near the celestial pole', () => {
	const result = run(
		[
			[0, 0, 0],
			[60000, 0, 2],
			[120000, 0, 4],
		],
		{ imageScaleArcsecPerPixel: 1, declination: Math.PI / 2 },
	)

	expect(result.motion.dec.driftRatePxPerMinute).toBeCloseTo(2, 8)
	expect(result.motion.polarAlignmentErrorArcmin).toBeNull()
	expect(result.notes).not.toContain('declination_unavailable')
	expect(result.recommendations.some((recommendation) => recommendation.kind === 'polar-alignment')).toBeFalse()
})

test('recommends drift alignment for large polar alignment error', () => {
	const result = run(
		[
			[0, 0, 0],
			[60000, 0, 4],
			[120000, 0, 8],
		],
		{ imageScaleArcsecPerPixel: 1, declination: 0 },
	)

	expect(result.motion.polarAlignmentErrorArcmin).toBeCloseTo(15.2788, 3)

	const polar = result.recommendations.find((recommendation) => recommendation.kind === 'polar-alignment')
	expect(polar?.message).toContain('drift alignment')
	expect(polar?.value).toBeCloseTo(15.2788, 3)
})

test('recommends no compensation for negligible DEC backlash', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 100, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	assistant.addSample(frame(1000, 2), command(0, 1)) // north reaches target immediately
	const step = assistant.addSample(frame(2000, 3), command(0, 0.1)) // south returns with no dead zone

	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.backlashMs).toBe(0)
	expect(step.result.backlash?.recommendedCompensationMs).toBeNull()

	const backlash = step.result.recommendations.find((recommendation) => recommendation.kind === 'backlash')
	expect(backlash?.message).toContain('no compensation needed')
	expect(backlash?.actionable).toBeFalse()
})

test('recommends single-direction guiding for excessive DEC backlash', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 2000, backlashMaxPulsesPerDirection: 20 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	assistant.addSample(frame(1000, 2), command(0, 1)) // north target reached -> first south pulse
	assistant.addSample(frame(2000, 3), command(0, 1)) // no return: +2000 ms dead zone
	assistant.addSample(frame(3000, 4), command(0, 1)) // no return: +2000 ms dead zone
	const step = assistant.addSample(frame(4000, 5), command(0, 0.1)) // finally returns

	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.backlashMs).toBe(4000)
	expect(step.result.backlash?.recommendedCompensationMs).toBeNull()

	const decMode = step.result.recommendations.find((recommendation) => recommendation.kind === 'dec-mode')
	expect(decMode?.appliesTo).toBe('decGuideMode')
	expect(decMode?.actionable).toBeTrue()
	expect(decMode?.message).toContain('one Dec direction')
	expect(decMode?.message).toContain('currently north')
})

test('maps excessive-backlash one-direction advice through south-positive DEC calibration', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, decPositiveDirection: 'south', backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 2000, backlashMaxPulsesPerDirection: 20 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	assistant.addSample(frame(1000, 2), command(0, -1)) // north target reached with south-positive calibration
	assistant.addSample(frame(2000, 3), command(0, -1))
	assistant.addSample(frame(3000, 4), command(0, -1))
	const step = assistant.addSample(frame(4000, 5), command(0, -0.1))

	expect(step.result.status).toBe('completed')
	expect(step.result.backlash?.backlashMs).toBe(4000)

	const decMode = step.result.recommendations.find((recommendation) => recommendation.kind === 'dec-mode')
	expect(decMode?.message).toContain('currently south')
})

test('floors recommended DEC backlash compensation to 10 ms', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 1, backlashReturnTolerancePx: 0.2, backlashPulseMs: 255, backlashMaxPulsesPerDirection: 8 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest()

	assistant.addSample(frame(1000, 2), command(0, 1)) // north target -> first south pulse (255 ms)
	assistant.addSample(frame(2000, 3), command(0, 1)) // dead zone: +255 ms
	const step = assistant.addSample(frame(3000, 4), command(0, 0.1)) // returns

	expect(step.result.backlash?.backlashMs).toBe(255)
	expect(step.result.backlash?.recommendedCompensationMs).toBe(250)
})

test('fails the backlash test when north motion is insufficient', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true, backlashTargetPx: 5, backlashMaxPulsesPerDirection: 2, backlashPulseMs: 100 })
	assistant.start(0)
	assistant.addSample(frame(0, 1), command(0, 0))
	assistant.startBacklashTest() // north pulse #1

	assistant.addSample(frame(1000, 2), command(0, 0.5)) // north pulse #2
	const step = assistant.addSample(frame(2000, 3), command(0, 1)) // pulse cap hit before target

	expect(step.result.status).toBe('failed')
	expect(step.result.backlash?.phase).toBe('failed')
	expect(step.result.backlash?.message).toContain('insufficient north')
	expect(step.result.backlash?.northDistancePx).toBeCloseTo(1, 8)
	expect(step.result.backlash?.southPulses).toBe(0)
})

test('fails immediately when no samples precede the backlash test', () => {
	const assistant = new GuidingAssistant({ measureBacklash: true })
	assistant.start(0)

	const step = assistant.startBacklashTest()

	expect(step.result.status).toBe('failed')
	expect(step.result.backlash?.phase).toBe('failed')
	expect(step.result.backlash?.message).toContain('no guide samples')
	expect(step.pulse).toBeUndefined()
})
