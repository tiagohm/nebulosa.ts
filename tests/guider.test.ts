import { describe, expect, test } from 'bun:test'
import { applyCalibration, estimateTranslation, filterGuideStars, type GuideFrame, Guider, type GuiderConfig, type GuideStar, invertCalibration, validateCalibration } from '../src/guider'

const WIDTH = 800
const HEIGHT = 600

// Builds one synthetic star with configurable quality and optional id.
function star(index: number, patch: Partial<GuideStar> = {}): GuideStar {
	const baseX = 120 + index * 90
	const baseY = 140 + index * 50
	return { x: baseX, y: baseY, snr: 20 + (index % 3), flux: 2400 + index * 150, hfd: 2.5 + index * 0.05, ellipticity: 0.18, fwhm: 4, ...patch }
}

// Builds a deterministic list of stars.
function starList(count: number, patch?: (value: GuideStar, index: number) => GuideStar) {
	const stars = new Array<GuideStar>(count)

	for (let i = 0; i < count; i++) {
		const current = star(i)
		stars[i] = patch ? patch(current, i) : current
	}

	return stars
}

// Builds a guide frame fixture with explicit timestamp.
function guideFrame(stars: readonly GuideStar[], timestamp = 0, frameId?: number) {
	return { stars, width: WIDTH, height: HEIGHT, timestamp, frameId } as GuideFrame
}

// Shifts stars by dx/dy with deterministic optional mutation.
function shiftStars(stars: readonly GuideStar[], dx: number, dy: number, mutate?: (star: GuideStar, index: number) => GuideStar) {
	return stars.map((star, index) => {
		const shifted: GuideStar = { ...star, x: star.x + dx, y: star.y + dy }
		return mutate ? mutate(shifted, index) : shifted
	})
}

// Creates a guider tuned for deterministic pulse assertions.
function guider(config: Partial<GuiderConfig> = {}) {
	return new Guider({ lockAveragingFrames: 1, hysteresisRA: 0, hysteresisDEC: 0, minMoveRA: 0.01, minMoveDEC: 0.01, aggressivenessRA: 1, aggressivenessDEC: 1, msPerRAUnit: 100, msPerDECUnit: 100, minPulseMsRA: 5, minPulseMsDEC: 7, maxPulseMsRA: 1000, maxPulseMsDEC: 1200, ...config })
}

const BASE_STARS = starList(5)

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
	expect(translation!.matches).toBe(4)
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

describe('math and calibration foundations', () => {
	test('applies 2x2 calibration matrix with axis-aligned and mixed terms', () => {
		const table = [
			{ calibration: [1, 0, 0, 1], dx: 2, dy: -3, expectedRa: 2, expectedDec: -3 },
			{ calibration: [-1, 0, 0, 2], dx: 1.5, dy: 0.5, expectedRa: -1.5, expectedDec: 1 },
			{ calibration: [0.6, -0.3, 0.2, 0.4], dx: 4, dy: -2, expectedRa: 3, expectedDec: 0 },
		] as const
		for (const entry of table) {
			const axis = applyCalibration(entry.calibration, entry.dx, entry.dy)
			expect(axis.ra).toBeCloseTo(entry.expectedRa, 10)
			expect(axis.dec).toBeCloseTo(entry.expectedDec, 10)
		}
	})

	test('inverts valid matrix and rejects singular matrix', () => {
		const calibration = [0.3, 0.1, -0.2, 0.4] as const
		const inverse = invertCalibration(calibration)
		const p1 = applyCalibration(calibration, 2, -1)
		const p2 = applyCalibration(inverse, p1.ra, p1.dec)
		expect(p2.ra).toBeCloseTo(2, 8)
		expect(p2.dec).toBeCloseTo(-1, 8)
		expect(validateCalibration([1, 2, 2, 4]).valid).toBeFalse()
		expect(validateCalibration([1, 0.999999, 1.000001, 1], 1e-3).valid).toBeFalse()
	})

	test('preserves sign conventions and zero/small vectors', () => {
		const calibration = [1.2, -0.2, -0.1, 0.9] as const
		const zero = applyCalibration(calibration, 0, 0)
		expect(zero.ra).toBe(0)
		expect(zero.dec).toBe(0)
		const small = applyCalibration(calibration, 1e-6, -2e-6)
		expect(Number.isFinite(small.ra)).toBeTrue()
		expect(Number.isFinite(small.dec)).toBeTrue()
		expect(small.ra).toBeGreaterThan(0)
		expect(small.dec).toBeLessThan(0)
	})
})

describe('star filtering and star matching', () => {
	test('filters mixed star list with per-edge border rejection', () => {
		const stars = [star(0, { x: 15, y: 15 }), star(1, { x: 5 }), star(2, { x: WIDTH - 8 }), star(3, { y: 4 }), star(4, { y: HEIGHT - 1 }), star(5, { snr: 2 }), star(6, { saturated: true }), star(7, { valid: false }), star(8, { ellipticity: 0.9 }), star(9, { fwhm: 100 })]
		const filtered = filterGuideStars(guideFrame(stars), {
			minStarSnr: 8,
			minFlux: 100,
			maxHfd: 8,
			borderMarginPx: 10,
			maxEllipticity: 0.5,
			maxFwhm: 10,
			saturationPeak: 65000,
		})
		expect(filtered.accepted).toHaveLength(1)
		expect(filtered.rejectedReasons.border).toBe(4)
		expect(filtered.rejectedReasons.low_snr).toBe(1)
		expect(filtered.rejectedReasons.saturated).toBe(1)
		expect(filtered.rejectedReasons.invalid).toBe(1)
		expect(filtered.rejectedReasons.elongated).toBe(1)
		expect(filtered.rejectedReasons.high_fwhm).toBe(1)
	})

	test('classifies detector artifacts like clipped peaks and NaN centroids', () => {
		const stars = [
			star(0, { peak: 70000 }),
			star(1, { x: Number.NaN }),
			star(2, { flux: 80 }),
			star(3, { hfd: 12 }),
			star(4, { peak: 64000 }),
		]
		const filtered = filterGuideStars(guideFrame(stars), {
			minStarSnr: 8,
			minFlux: 100,
			maxHfd: 8,
			borderMarginPx: 10,
			maxEllipticity: 0.5,
			maxFwhm: 10,
			saturationPeak: 65000,
		})
		expect(filtered.accepted).toHaveLength(1)
		expect(filtered.rejectedReasons.saturated_peak).toBe(1)
		expect(filtered.rejectedReasons.nan).toBe(1)
		expect(filtered.rejectedReasons.low_flux).toBe(1)
		expect(filtered.rejectedReasons.high_hfd).toBe(1)
	})

	test('enforces one-to-one nearest matching and max radius', () => {
		const reference = [star(0), star(1), star(2)]
		const current = [star(20, { x: reference[0].x + 1, y: reference[0].y }), star(21, { x: reference[1].x + 1, y: reference[1].y })]
		const ok = estimateTranslation(reference, current, 3, 2)
		expect(ok).toBeDefined()
		expect(ok!.matches).toBe(2)
		const far = shiftStars(reference, 20, 20, (value) => ({ ...value }))
		expect(estimateTranslation(reference, far, 3, 2)).toBeNull()
	})
})

describe('tracking, translation, and lock acquisition', () => {
	test('single-star initializes and follows modest drift', () => {
		const g = guider({ mode: 'single-star' })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.3, -0.2), 1000))
		expect(cmd.state).toBe('guiding')
		expect(cmd.diagnostics.modeUsed).toBe('single-star')
		expect(cmd.diagnostics.dx).toBeCloseTo(0.3, 6)
		expect(cmd.diagnostics.dy).toBeCloseTo(-0.2, 6)
	})

	test('multi-star translation rejects outlier and preserves inlier shift', () => {
		const moved = shiftStars(BASE_STARS, 1.2, -0.6, (value, index) => (index === 4 ? { ...value, x: value.x + 30, y: value.y - 20 } : value))
		const translation = estimateTranslation(BASE_STARS, moved, 8, 2.5)
		expect(translation).toBeDefined()
		expect(translation!.matches).toBe(BASE_STARS.length - 1)
		expect(translation!.dx).toBeCloseTo(1.2, 1)
		expect(translation!.dy).toBeCloseTo(-0.6, 1)
	})

	test('reference lock averages startup frames and ignores bad startup frame', () => {
		const g = guider({ lockAveragingFrames: 3, minFrameQuality: 0.4 })
		g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.2, 0.2), 0))
		g.processFrame(guideFrame([], 1000))
		g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.4, 0.4), 2000))
		const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.6, 0.6), 3000))
		expect(cmd.state).toBe('guiding')
		const state = g.currentState
		expect(state.referenceX).toBeCloseTo(BASE_STARS[0].x + 0.4, 6)
		expect(state.referenceY).toBeCloseTo(BASE_STARS[0].y + 0.4, 6)
	})

	test('single-star tracking keeps the nearest lock even if another star becomes brighter', () => {
		const g = guider({ mode: 'single-star' })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const moved = shiftStars(BASE_STARS, 0.35, -0.25, (value, index) => {
			if (index === 0) return { ...value, snr: 9, flux: 300 }
			if (index === 4) return { ...value, snr: 200, flux: 50000 }
			return value
		})
		const cmd = g.processFrame(guideFrame(moved, 1000))
		expect(cmd.state).toBe('guiding')
		expect(cmd.diagnostics.modeUsed).toBe('single-star')
		expect(cmd.diagnostics.dx).toBeCloseTo(0.35, 6)
		expect(cmd.diagnostics.dy).toBeCloseTo(-0.25, 6)
	})

	test('multi-star mode falls back to one visible star after cloud loss', () => {
		const g = guider({ mode: 'multi-star', maxFrameJumpPx: 20 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const survivingStar = [{ ...BASE_STARS[0], x: BASE_STARS[0].x + 0.6, y: BASE_STARS[0].y - 0.4 }]
		const cmd = g.processFrame(guideFrame(survivingStar, 1000))
		expect(cmd.state).toBe('guiding')
		expect(cmd.diagnostics.modeUsed).toBe('single-star')
		expect(cmd.diagnostics.dx).toBeCloseTo(0.6, 6)
		expect(cmd.diagnostics.dy).toBeCloseTo(-0.4, 6)
	})
})

describe('ra and dec controller fundamentals', () => {
	test('ra deadband, minPulse, maxPulse, and direction mapping', () => {
		const g = guider({ minMoveRA: 0.2, msPerRAUnit: 100, minPulseMsRA: 10, maxPulseMsRA: 50 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		let cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.05, 0), 1000))
		expect(cmd.ra.duration).toBe(0)
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.25, 0), 2000))
		expect(cmd.ra.duration).toBe(25)
		expect(cmd.ra.direction).toBe('west')
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, -1.2, 0), 3000))
		expect(cmd.ra.duration).toBe(50)
		expect(cmd.ra.direction).toBe('east')
	})

	test('ra hysteresis smooths pulses and cadence scaling responds to dropped cadence', () => {
		const smooth = guider({ hysteresisRA: 0.8, minMoveRA: 0.01, msPerRAUnit: 100, nominalCadence: 1000 })
		smooth.processFrame(guideFrame(BASE_STARS, 0))
		const a = smooth.processFrame(guideFrame(shiftStars(BASE_STARS, 0.4, 0), 1000))
		const b = smooth.processFrame(guideFrame(shiftStars(BASE_STARS, 0.4, 0), 3000))
		expect(a.ra.duration).toBeLessThan(40)
		expect(b.ra.duration).toBeGreaterThan(a.ra.duration)
	})

	test('dec modes and backlash reversal suppression', () => {
		const g = guider({ decMode: 'auto', decReversalThreshold: 0.05, decBacklashAccumThreshold: 0.25, minMoveDEC: 0.01 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		let cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0, 0.3), 1000))
		expect(cmd.dec.direction).toBe('north')
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.1), 2000))
		expect(cmd.dec.duration).toBe(0)
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.2), 3000))
		expect(cmd.dec.direction).toBe('south')

		const northOnly = guider({ decMode: 'north-only' })
		northOnly.processFrame(guideFrame(BASE_STARS, 0))
		const suppressedSouth = northOnly.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.5), 1000))
		expect(suppressedSouth.dec.duration).toBe(0)

		const off = guider({ decMode: 'off' })
		off.processFrame(guideFrame(BASE_STARS, 0))
		expect(off.processFrame(guideFrame(shiftStars(BASE_STARS, 0, 1), 1000)).dec.duration).toBe(0)
	})
})

describe('quality, loss state machine, and processFrame diagnostics', () => {
	test('bad frame suppresses pulses and increments lost counter', () => {
		const g = guider({ lostStarFrameCount: 2 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const bad1 = g.processFrame(guideFrame([], 1000, 1))
		expect(bad1.ra.duration).toBe(0)
		expect(bad1.dec.duration).toBe(0)
		expect(bad1.diagnostics.badFrame).toBeTrue()
		expect(bad1.diagnostics.lostFrames).toBe(1)
		const bad2 = g.processFrame(guideFrame([], 2000, 2))
		expect(bad2.state).toBe('lost')
		expect(bad2.diagnostics.lost).toBeTrue()
	})

	test('reacquisition clears lost counters and resumes guiding', () => {
		const g = guider({ lostStarFrameCount: 2 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		g.processFrame(guideFrame([], 1000))
		g.processFrame(guideFrame([], 2000))
		const reacquired = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.4, -0.2), 3000, 3))
		expect(reacquired.state).toBe('guiding')
		expect(reacquired.diagnostics.badFrame).toBeFalse()
		expect(reacquired.diagnostics.qualityScore).toBeGreaterThan(0)
		expect(reacquired.diagnostics.axisErrorRA).toBeDefined()
		expect(reacquired.diagnostics.axisErrorDEC).toBeDefined()
	})

	test('end-to-end x/y drifts map to axis pulses and no-pulse when centered', () => {
		const g = guider()
		g.processFrame(guideFrame(BASE_STARS, 0))
		let cmd = g.processFrame(guideFrame(BASE_STARS, 1000))
		expect(cmd.ra.duration).toBe(0)
		expect(cmd.dec.duration).toBe(0)
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.4, 0), 2000))
		expect(cmd.ra.duration).toBeGreaterThan(0)
		expect(cmd.dec.duration).toBe(0)
		cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0, -0.4), 3000))
		expect(cmd.dec.duration).toBeGreaterThan(0)
	})

	test('timestamp-less frames neither flag dropped cadence nor scale pulses', () => {
		const g = guider({ minMoveDEC: 1, msPerRAUnit: 100 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const cmd = g.processFrame({ stars: shiftStars(BASE_STARS, 0.4, 0), width: WIDTH, height: HEIGHT })
		expect(cmd.diagnostics.droppedFrame).toBeFalse()
		expect(cmd.ra.duration).toBeCloseTo(40, 8)
		expect(cmd.dec.duration).toBe(0)
	})
})

describe('dithering behavior', () => {
	test('dither start/stop applies target offset in image space and clamps large offsets', () => {
		const g = guider({ maxPulseMsRA: 80, maxPulseMsDEC: 90, msPerRAUnit: 100, msPerDECUnit: 100 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		g.startDither(2, -1)
		let cmd = g.processFrame(guideFrame(BASE_STARS, 1000))
		expect(cmd.ra.duration).toBeGreaterThan(0)
		expect(cmd.dec.duration).toBeGreaterThan(0)
		g.startDither(50, -50)
		cmd = g.processFrame(guideFrame(BASE_STARS, 2000))
		expect(cmd.ra.duration).toBe(80)
		expect(cmd.dec.duration).toBe(90)
		g.stopDither()
		cmd = g.processFrame(guideFrame(BASE_STARS, 3000))
		expect(cmd.ra.duration).toBe(0)
		expect(cmd.dec.duration).toBe(0)
	})

	test('dither state persists through temporary star loss', () => {
		const g = guider({ lostStarFrameCount: 3 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		g.startDither(1, 1)
		g.processFrame(guideFrame([], 1000))
		g.processFrame(guideFrame([], 2000))
		const recovered = g.processFrame(guideFrame(shiftStars(BASE_STARS, 1, 1), 3000))
		expect(recovered.diagnostics.ditherActive).toBeTrue()
		expect(g.currentState.ditherActive).toBeTrue()
	})
})

describe('configuration and regression tests', () => {
	test('rejects invalid controller configuration', () => {
		expect(() => guider({ minMoveRA: -1 })).toThrow()
		expect(() => guider({ minPulseMsRA: -1 })).toThrow()
		expect(() => guider({ minPulseMsRA: 10, maxPulseMsRA: 5 })).toThrow()
		expect(() => guider({ hysteresisRA: 1.5 })).toThrow()
		expect(() => guider({ maxMatchDistancePx: 0 })).toThrow()
		expect(() => guider({ lostStarFrameCount: 0 })).toThrow()
		expect(() => guider({ calibration: [1, 2, 2, 4] })).toThrow()
	})

	test('regression: no stale pulse emitted after bad frame and no NaN propagation', () => {
		const g = guider()
		g.processFrame(guideFrame(BASE_STARS, 0))
		const good = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.6, 0.2), 1000))
		expect(good.ra.duration).toBeGreaterThan(0)
		const badStars = [star(0, { x: Number.NaN }), star(1, { snr: 30 })]
		const bad = g.processFrame(guideFrame(badStars, 2000))
		expect(bad.ra.duration).toBe(0)
		expect(bad.dec.duration).toBe(0)
		expect(bad.diagnostics.badFrame).toBeTrue()
	})

	test('regression: wrong calibration sign inverts pulse direction', () => {
		const g = guider({ calibration: [-1, 0, 0, -1] })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.5, 0.5), 1000))
		expect(cmd.ra.direction).toBe('east')
		expect(cmd.dec.direction).toBe('south')
	})

	test('reset clears dither, loss counters, and controller memory before reacquiring', () => {
		const g = guider({ lostStarFrameCount: 2, hysteresisRA: 0.5, hysteresisDEC: 0.5 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		g.startDither(1, -1)
		g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.8, 0.6), 1000))
		g.processFrame(guideFrame([], 2000))
		g.reset()
		const resetState = g.currentState
		expect(resetState.state).toBe('idle')
		expect(resetState.ditherActive).toBeFalse()
		expect(resetState.consecutiveBadFrames).toBe(0)
		expect(resetState.filteredRA).toBe(0)
		expect(resetState.filteredDEC).toBe(0)
		const reacquired = g.processFrame(guideFrame(BASE_STARS, 3000))
		expect(reacquired.state).toBe('guiding')
		expect(reacquired.diagnostics.ditherActive).toBeFalse()
		expect(reacquired.ra.duration).toBe(0)
		expect(reacquired.dec.duration).toBe(0)
	})
})

describe('deterministic simulation scenarios', () => {
	test('drift-only RA simulation keeps corrective direction and bounded pulses', () => {
		const g = guider({ hysteresisRA: 0.4, hysteresisDEC: 0.4 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		let ts = 1000
		let maxPulse = 0
		for (let i = 1; i <= 12; i++) {
			const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, i * 0.15, 0), ts, i))
			expect(cmd.ra.direction).toBe('west')
			maxPulse = Math.max(maxPulse, cmd.ra.duration)
			ts += 1000
		}
		expect(maxPulse).toBeLessThanOrEqual(1000)
	})

	test('drift with seeing noise and one outlier jump suppresses outlier frame', () => {
		const g = guider({ maxFrameJumpPx: 2.5, hysteresisRA: 0.5, hysteresisDEC: 0.5 })
		g.processFrame(guideFrame(BASE_STARS, 0))

		const offsets = [
			[0.1, -0.05],
			[0.2, -0.1],
			[0.3, -0.13],
			[5, 5],
			[0.4, -0.2],
		] as const

		for (let i = 0; i < offsets.length; i++) {
			const [dx, dy] = offsets[i]
			const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, dx, dy), (i + 1) * 1000))
			if (i === 3) {
				expect(cmd.diagnostics.badFrame).toBeTrue()
				expect(cmd.ra.duration).toBe(0)
				expect(cmd.dec.duration).toBe(0)
			}
		}
	})

	test('temporary cloud and loss for two frames reacquires on third', () => {
		const g = guider({ lostStarFrameCount: 3 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		g.processFrame(guideFrame([], 1000))
		g.processFrame(guideFrame([], 2000))
		const recovered = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0.3, 0.2), 3000))
		expect(recovered.state).toBe('guiding')
		expect(recovered.diagnostics.lostFrames).toBe(0)
	})

	test('dec backlash simulation suppresses alternating jitter near zero', () => {
		const g = guider({ hysteresisDEC: 0, decReversalThreshold: 0.08, decBacklashAccumThreshold: 0.25, minMoveDEC: 0.01 })
		g.processFrame(guideFrame(BASE_STARS, 0))
		const sequence = [0.2, -0.05, 0.04, -0.06, 0.03, -0.07]
		let reversalCount = 0

		for (let i = 0; i < sequence.length; i++) {
			const cmd = g.processFrame(guideFrame(shiftStars(BASE_STARS, 0, sequence[i]), (i + 1) * 1000))
			if (cmd.dec.duration > 0 && cmd.dec.direction === 'south') reversalCount++
		}

		expect(reversalCount).toBe(0)
	})
})
