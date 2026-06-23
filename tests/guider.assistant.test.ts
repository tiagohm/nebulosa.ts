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
function command(raPx: number, decPx: number, patch: Partial<GuideCommand['diagnostics']> = {}): GuideCommand {
	return {
		state: 'guiding',
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
