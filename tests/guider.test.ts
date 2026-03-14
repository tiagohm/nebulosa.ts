import { expect, test } from 'bun:test'
import { applyCalibration, estimateTranslation, filterGuideStars, type GuideFrame, Guider, type GuideStar, invertCalibration, validateCalibration } from '../src/guider'

// Builds synthetic stars translated by dx/dy and optional per-star overrides.
function shiftStars(stars: readonly GuideStar[], dx: number, dy: number, mutate?: (star: GuideStar, index: number) => GuideStar) {
	return stars.map((star, index) => {
		const shifted: GuideStar = { ...star, x: star.x + dx, y: star.y + dy }
		return mutate ? mutate(shifted, index) : shifted
	})
}

// Builds deterministic guide frame fixture.
function guideFrame(stars: readonly GuideStar[], timestamp = 0) {
	return { stars, width: 800, height: 600, timestamp } as GuideFrame
}

const BASE_STARS: readonly GuideStar[] = [
	{ x: 120, y: 130, snr: 25, flux: 3000, hfd: 2.3, ellipticity: 0.12, fwhm: 3.6 },
	{ x: 250, y: 180, snr: 20, flux: 2800, hfd: 2.6, ellipticity: 0.18, fwhm: 4.1 },
	{ x: 390, y: 250, snr: 22, flux: 2600, hfd: 2.8, ellipticity: 0.16, fwhm: 4.2 },
	{ x: 500, y: 320, snr: 21, flux: 2400, hfd: 2.7, ellipticity: 0.15, fwhm: 4.0 },
]

test('star filtering rejects low quality detections', () => {
	const stars: GuideStar[] = [
		{ x: 8, y: 20, snr: 20, flux: 1000, hfd: 2 },
		{ x: 100, y: 100, snr: 2, flux: 1000, hfd: 2 },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, saturated: true },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, ellipticity: 0.8 },
		{ x: 100, y: 100, snr: 20, flux: 1000, hfd: 2, fwhm: 40 },
		{ x: 120, y: 120, snr: 20, flux: 1000, hfd: 2, ellipticity: 0.2, fwhm: 4 },
	]

	const filtered = filterGuideStars(guideFrame(stars), { minStarSnr: 8, minFlux: 100, maxHfd: 8, borderMarginPx: 10, maxEllipticity: 0.5, maxFwhm: 10, saturationPeak: 65000 })

	expect(filtered.accepted).toHaveLength(1)
	expect(filtered.rejectedReasons.border).toBe(1)
	expect(filtered.rejectedReasons.low_snr).toBe(1)
	expect(filtered.rejectedReasons.saturated).toBe(1)
	expect(filtered.rejectedReasons.elongated).toBe(1)
	expect(filtered.rejectedReasons.high_fwhm).toBe(1)
})

test('single-star tracking fallback computes correction pulses', () => {
	const guider = new Guider({ mode: 'single-star', lockAveragingFrames: 2, minMoveRA: 0.01, minMoveDEC: 0.01, msPerRAUnit: 1000, msPerDECUnit: 1000 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	guider.processFrame(guideFrame(BASE_STARS, 1000))
	const moved = shiftStars(BASE_STARS, 0.4, -0.3)
	const cmd = guider.processFrame(guideFrame(moved, 2000))
	expect(cmd.ra.duration).toBeGreaterThan(0)
	expect(cmd.dec.duration).toBeGreaterThan(0)
	expect(cmd.diagnostics.modeUsed).toBe('single-star')
})

test('multi-star translation rejects outlier and keeps weighted estimate', () => {
	const moved = shiftStars(BASE_STARS, 1.5, -0.8, (star, index) => (index === 3 ? { ...star, x: star.x + 20, y: star.y - 15 } : star))
	const translation = estimateTranslation(BASE_STARS, moved, 8, 2.5)
	expect(translation).toBeDefined()
	expect(translation!.matches).toBe(3)
	expect(translation!.dx).toBeCloseTo(1.5, 1)
	expect(translation!.dy).toBeCloseTo(-0.8, 1)
})

test('calibration transform and inverse are coherent', () => {
	const calibration = [0.2, -0.1, 0.05, 0.3] as const
	const validation = validateCalibration(calibration)
	expect(validation.valid).toBeTrue()
	const axis = applyCalibration(calibration, 2, -3)
	expect(axis.ra).toBeCloseTo(0.7, 10)
	expect(axis.dec).toBeCloseTo(-0.8, 10)
	const inv = invertCalibration(calibration)
	const back = applyCalibration(inv, axis.ra, axis.dec)
	expect(back.ra).toBeCloseTo(2, 8)
	expect(back.dec).toBeCloseTo(-3, 8)
})

test('ra deadband suppresses tiny errors', () => {
	const guider = new Guider({ lockAveragingFrames: 1, minMoveRA: 0.2, minMoveDEC: 0.2 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	const tiny = shiftStars(BASE_STARS, 0.03, 0.02)
	const cmd = guider.processFrame(guideFrame(tiny, 1000))
	expect(cmd.ra.duration).toBe(0)
	expect(cmd.dec.duration).toBe(0)
})

test('dec reversal suppression requires accumulated opposite error', () => {
	const guider = new Guider({ lockAveragingFrames: 1, minMoveDEC: 0.01, hysteresisDEC: 0, decReversalThreshold: 0.05, decBacklashAccumThreshold: 0.2 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	let cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0, 0.4), 1000))
	expect(cmd.dec.duration).toBeGreaterThan(0)
	expect(cmd.dec.direction).toBe('north')
	cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.08), 2000))
	expect(cmd.dec.duration).toBe(0)
	cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.18), 3000))
	expect(cmd.dec.duration).toBeGreaterThan(0)
	expect(cmd.dec.direction).toBe('south')
})

test('lost-star state and reacquisition flow', () => {
	const guider = new Guider({ lockAveragingFrames: 1, lostStarFrameCount: 2 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	guider.processFrame(guideFrame([], 1000))
	let cmd = guider.processFrame(guideFrame([], 2000))
	expect(cmd.state).toBe('lost')
	cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0.5, 0.2), 3000))
	expect(cmd.state).toBe('guiding')
	expect(cmd.diagnostics.badFrame).toBeFalse()
})

test('dither offset shifts target and settles after stop', () => {
	const guider = new Guider({ lockAveragingFrames: 1, minMoveRA: 0.01, minMoveDEC: 0.01, hysteresisRA: 0, hysteresisDEC: 0 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	guider.startDither(2, -1)
	let cmd = guider.processFrame(guideFrame(BASE_STARS, 1000))
	expect(cmd.ra.duration).toBeGreaterThan(0)
	expect(cmd.dec.duration).toBeGreaterThan(0)
	guider.stopDither()
	cmd = guider.processFrame(guideFrame(BASE_STARS, 2000))
	expect(cmd.ra.duration).toBe(0)
	expect(cmd.dec.duration).toBe(0)
})

test('large jump rejection and dropped frame diagnostics', () => {
	const guider = new Guider({ lockAveragingFrames: 1, maxFrameJumpPx: 2, nominalCadence: 1000, droppedFrameFactor: 2 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0.3, 0.1), 1000))
	const cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 10, 10), 4000))
	expect(cmd.ra.duration).toBe(0)
	expect(cmd.dec.duration).toBe(0)
	expect(cmd.diagnostics.badFrame).toBeTrue()
	expect(cmd.diagnostics.droppedFrame).toBeTrue()
})

test('cadence scaling uses previous frame timestamp', () => {
	const guider = new Guider({ lockAveragingFrames: 1, calibration: [1, 0, 0, 1], hysteresisRA: 0, hysteresisDEC: 0, minMoveRA: 0.01, minMoveDEC: 1, msPerRAUnit: 1000, nominalCadence: 1000 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	const cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0.2, 0), 1000))
	expect(cmd.ra.duration).toBeCloseTo(140, 8)
	expect(cmd.ra.duration).toBeGreaterThan(100)
})

test('steady drift with seeing noise and oscillation remain bounded', () => {
	const guider = new Guider({ lockAveragingFrames: 1, hysteresisRA: 0.6, hysteresisDEC: 0.6 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	let timestamp = 1000
	let maxPulse = 0
	for (let i = 0; i < 20; i++) {
		const driftX = 0.08 * i + (i % 2 === 0 ? 0.03 : -0.03)
		const driftY = -0.05 * i + (i % 3 === 0 ? 0.02 : -0.02)
		const frame = guideFrame(shiftStars(BASE_STARS, driftX, driftY), timestamp)
		const cmd = guider.processFrame(frame)
		maxPulse = Math.max(maxPulse, cmd.ra.duration, cmd.dec.duration)
		timestamp += i % 5 === 0 ? 1200 : 900
	}
	expect(maxPulse).toBeLessThanOrEqual(2500)
})

test('bad calibration sign flips correction direction', () => {
	const guider = new Guider({ lockAveragingFrames: 1, calibration: [-1, 0, 0, -1], hysteresisRA: 0, hysteresisDEC: 0, minMoveRA: 0.01, minMoveDEC: 0.01 })
	guider.processFrame(guideFrame(BASE_STARS, 0))
	const cmd = guider.processFrame(guideFrame(shiftStars(BASE_STARS, 0.5, 0.5), 1000))
	expect(cmd.ra.direction).toBe('east')
	expect(cmd.dec.direction).toBe('south')
})
