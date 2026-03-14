import { describe, expect, test } from 'bun:test'
import { applyCalibration, applyDeadband, clamp, estimateTranslation, filterGuideStars, Guider, invertCalibration, validateCalibration, type GuideFrame, type GuideStar } from '../src/guider'

const WIDTH = 800
const HEIGHT = 600
const EPS = 1e-9

// Builds one synthetic star with configurable quality and optional id.
function star(index: number, patch: Partial<GuideStar> = {}) {
	const baseX = 120 + index * 90
	const baseY = 140 + index * 50
	return {
		id: `s${index}`,
		x: baseX,
		y: baseY,
		snr: 20 + (index % 3),
		flux: 2400 + index * 150,
		hfd: 2.5 + index * 0.05,
		ellipticity: 0.18,
		fwhm: 4,
		...patch,
	} as GuideStar
}

// Builds a deterministic list of stars.
function starList(count: number, patch?: (value: GuideStar, index: number) => GuideStar) {
	const stars: GuideStar[] = []
	for (let i = 0; i < count; i++) {
		const current = star(i)
		stars.push(patch ? patch(current, i) : current)
	}
	return stars
}

// Builds a guide frame fixture with explicit timestamp.
function frame(stars: readonly GuideStar[], timestampMs = 0, frameId?: number) {
	return { stars, width: WIDTH, height: HEIGHT, timestampMs, frameId } as GuideFrame
}

// Shifts stars by dx/dy with deterministic optional mutation.
function shift(stars: readonly GuideStar[], dx: number, dy: number, mutate?: (value: GuideStar, index: number) => GuideStar) {
	const moved: GuideStar[] = []
	for (let i = 0; i < stars.length; i++) {
		const current = stars[i]
		const translated = { ...current, x: current.x + dx, y: current.y + dy } as GuideStar
		moved.push(mutate ? mutate(translated, i) : translated)
	}
	return moved
}

// Creates a guider tuned for deterministic pulse assertions.
function guider(config: ConstructorParameters<typeof Guider>[0] = {}) {
	return new Guider({
		lockAveragingFrames: 1,
		hysteresisRA: 0,
		hysteresisDEC: 0,
		minMoveRA: 0.01,
		minMoveDEC: 0.01,
		aggressivenessRA: 1,
		aggressivenessDEC: 1,
		msPerRAUnit: 100,
		msPerDECUnit: 100,
		minPulseMsRA: 5,
		minPulseMsDEC: 7,
		maxPulseMsRA: 1000,
		maxPulseMsDEC: 1200,
		...config,
	})
}

const BASE_STARS = starList(5)

describe('1/8. math and calibration foundations', () => {
	test('applies 2x2 calibration matrix with axis-aligned and mixed terms', () => {
		const table = [
			{ calibration: { m00: 1, m01: 0, m10: 0, m11: 1 }, dx: 2, dy: -3, expectedRa: 2, expectedDec: -3 },
			{ calibration: { m00: -1, m01: 0, m10: 0, m11: 2 }, dx: 1.5, dy: 0.5, expectedRa: -1.5, expectedDec: 1 },
			{ calibration: { m00: 0.6, m01: -0.3, m10: 0.2, m11: 0.4 }, dx: 4, dy: -2, expectedRa: 3, expectedDec: 0 },
		]
		for (const entry of table) {
			const axis = applyCalibration(entry.calibration, entry.dx, entry.dy)
			expect(axis.ra).toBeCloseTo(entry.expectedRa, 10)
			expect(axis.dec).toBeCloseTo(entry.expectedDec, 10)
		}
	})

	test('inverts valid matrix and rejects singular matrix', () => {
		const calibration = { m00: 0.3, m01: 0.1, m10: -0.2, m11: 0.4 }
		const inverse = invertCalibration(calibration)
		const p1 = applyCalibration(calibration, 2, -1)
		const p2 = applyCalibration(inverse, p1.ra, p1.dec)
		expect(p2.ra).toBeCloseTo(2, 8)
		expect(p2.dec).toBeCloseTo(-1, 8)
		expect(validateCalibration({ m00: 1, m01: 2, m10: 2, m11: 4 }).valid).toBeFalse()
		expect(validateCalibration({ m00: 1, m01: 0.999999, m10: 1.000001, m11: 1 }, 1e-3).valid).toBeFalse()
	})

	test('preserves sign conventions and zero/small vectors', () => {
		const calibration = { m00: 1.2, m01: -0.2, m10: -0.1, m11: 0.9 }
		const zero = applyCalibration(calibration, 0, 0)
		expect(zero.ra).toBe(0)
		expect(zero.dec).toBe(0)
		const small = applyCalibration(calibration, 1e-6, -2e-6)
		expect(Number.isFinite(small.ra)).toBeTrue()
		expect(Number.isFinite(small.dec)).toBeTrue()
		expect(small.ra).toBeGreaterThan(0)
		expect(small.dec).toBeLessThan(0)
	})

	test('clamp and deadband helpers', () => {
		expect(clamp(-2, 0, 3)).toBe(0)
		expect(clamp(5, 0, 3)).toBe(3)
		expect(clamp(2, 0, 3)).toBe(2)
		expect(applyDeadband(0.09, 0.1)).toBe(0)
		expect(applyDeadband(0.1, 0.1)).toBeCloseTo(0.1, 12)
		expect(applyDeadband(-0.11, 0.1)).toBeCloseTo(-0.11, 12)
	})
})

describe('2/3. star filtering and star matching', () => {
	test('filters mixed star list with per-edge border rejection', () => {
		const stars = [star(0, { x: 15, y: 15 }), star(1, { x: 5 }), star(2, { x: WIDTH - 8 }), star(3, { y: 4 }), star(4, { y: HEIGHT - 1 }), star(5, { snr: 2 }), star(6, { saturated: true }), star(7, { valid: false }), star(8, { ellipticity: 0.9 }), star(9, { fwhm: 100 })]
		const filtered = filterGuideStars(frame(stars), {
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

	test('matches by star id before nearest-neighbor and handles duplicates deterministically', () => {
		const reference = [star(0, { id: 'A' }), star(1, { id: 'B' })]
		const current = [star(10, { id: 'A', x: reference[0].x + 2, y: reference[0].y - 1 }), star(11, { id: 'B', x: reference[1].x + 2, y: reference[1].y - 1 })]
		const translation = estimateTranslation(reference, current, 8, 2)
		expect(translation).toBeDefined()
		expect(translation!.dx).toBeCloseTo(2, 10)
		expect(translation!.dy).toBeCloseTo(-1, 10)

		const duplicateCurrent = [star(10, { id: 'A', x: reference[0].x + 2, y: reference[0].y }), star(11, { id: 'A', x: reference[0].x + 2, y: reference[0].y })]
		const fallback = estimateTranslation(reference, duplicateCurrent, 8, 2)
		expect(fallback).toBeNull()
	})

	test('enforces one-to-one nearest matching and max radius', () => {
		const reference = [star(0, { id: undefined }), star(1, { id: undefined }), star(2, { id: undefined })]
		const current = [star(20, { id: undefined, x: reference[0].x + 1, y: reference[0].y }), star(21, { id: undefined, x: reference[1].x + 1, y: reference[1].y })]
		const ok = estimateTranslation(reference, current, 3, 2)
		expect(ok).toBeDefined()
		expect(ok!.matches).toBe(2)
		const far = shift(reference, 20, 20, (value) => ({ ...value, id: undefined }))
		expect(estimateTranslation(reference, far, 3, 2)).toBeNull()
	})
})

describe('4/5/6. tracking, translation, and lock acquisition', () => {
	test('single-star initializes and follows modest drift', () => {
		const g = guider({ mode: 'single-star' })
		g.initialize(frame(BASE_STARS, 0))
		const cmd = g.processFrame(frame(shift(BASE_STARS, 0.3, -0.2), 1000))
		expect(cmd.state).toBe('guiding')
		expect(cmd.diagnostics.modeUsed).toBe('single-star')
		expect(cmd.diagnostics.dxPixels).toBeCloseTo(0.3, 6)
		expect(cmd.diagnostics.dyPixels).toBeCloseTo(-0.2, 6)
	})

	test('multi-star translation rejects outlier and preserves inlier shift', () => {
		const moved = shift(BASE_STARS, 1.2, -0.6, (value, index) => (index === 4 ? { ...value, x: value.x + 30, y: value.y - 20 } : value))
		const translation = estimateTranslation(BASE_STARS, moved, 8, 2.5)
		expect(translation).toBeDefined()
		expect(translation!.matches).toBe(BASE_STARS.length - 1)
		expect(translation!.dx).toBeCloseTo(1.2, 1)
		expect(translation!.dy).toBeCloseTo(-0.6, 1)
	})

	test('reference lock averages startup frames and ignores bad startup frame', () => {
		const g = guider({ lockAveragingFrames: 3, minFrameQuality: 0.4 })
		g.initialize(frame(shift(BASE_STARS, 0.2, 0.2), 0))
		g.processFrame(frame([], 1000))
		g.processFrame(frame(shift(BASE_STARS, 0.4, 0.4), 2000))
		const cmd = g.processFrame(frame(shift(BASE_STARS, 0.6, 0.6), 3000))
		expect(cmd.state).toBe('guiding')
		const state = g.getState()
		expect(state.referenceX).toBeCloseTo(BASE_STARS[0].x + 0.4, 6)
		expect(state.referenceY).toBeCloseTo(BASE_STARS[0].y + 0.4, 6)
	})
})

describe('9/10/11. ra and dec controller fundamentals', () => {
	test('ra deadband, minPulse, maxPulse, and direction mapping', () => {
		const g = guider({ minMoveRA: 0.2, msPerRAUnit: 100, minPulseMsRA: 10, maxPulseMsRA: 50 })
		g.initialize(frame(BASE_STARS, 0))
		let cmd = g.processFrame(frame(shift(BASE_STARS, 0.05, 0), 1000))
		expect(cmd.ra.durationMs).toBe(0)
		cmd = g.processFrame(frame(shift(BASE_STARS, 0.25, 0), 2000))
		expect(cmd.ra.durationMs).toBe(25)
		expect(cmd.ra.direction).toBe('west')
		cmd = g.processFrame(frame(shift(BASE_STARS, -1.2, 0), 3000))
		expect(cmd.ra.durationMs).toBe(50)
		expect(cmd.ra.direction).toBe('east')
	})

	test('ra hysteresis smooths pulses and cadence scaling responds to dropped cadence', () => {
		const smooth = guider({ hysteresisRA: 0.8, minMoveRA: 0.01, msPerRAUnit: 100, nominalCadenceMs: 1000 })
		smooth.initialize(frame(BASE_STARS, 0))
		const a = smooth.processFrame(frame(shift(BASE_STARS, 0.4, 0), 1000))
		const b = smooth.processFrame(frame(shift(BASE_STARS, 0.4, 0), 3000))
		expect(a.ra.durationMs).toBeLessThan(40)
		expect(b.ra.durationMs).toBeGreaterThan(a.ra.durationMs)
	})

	test('dec modes and backlash reversal suppression', () => {
		const g = guider({
			decMode: 'auto',
			decReversalThreshold: 0.05,
			decBacklashAccumThreshold: 0.25,
			minMoveDEC: 0.01,
		})
		g.initialize(frame(BASE_STARS, 0))
		let cmd = g.processFrame(frame(shift(BASE_STARS, 0, 0.3), 1000))
		expect(cmd.dec.direction).toBe('north')
		cmd = g.processFrame(frame(shift(BASE_STARS, 0, -0.1), 2000))
		expect(cmd.dec.durationMs).toBe(0)
		cmd = g.processFrame(frame(shift(BASE_STARS, 0, -0.2), 3000))
		expect(cmd.dec.direction).toBe('south')

		const northOnly = guider({ decMode: 'north-only' })
		northOnly.initialize(frame(BASE_STARS, 0))
		const suppressedSouth = northOnly.processFrame(frame(shift(BASE_STARS, 0, -0.5), 1000))
		expect(suppressedSouth.dec.durationMs).toBe(0)

		const off = guider({ decMode: 'off' })
		off.initialize(frame(BASE_STARS, 0))
		expect(off.processFrame(frame(shift(BASE_STARS, 0, 1), 1000)).dec.durationMs).toBe(0)
	})
})

describe('12/13/14/15. quality, loss state machine, and processFrame diagnostics', () => {
	test('bad frame suppresses pulses and increments lost counter', () => {
		const g = guider({ lostStarFrameCount: 2 })
		g.initialize(frame(BASE_STARS, 0))
		const bad1 = g.processFrame(frame([], 1000, 1))
		expect(bad1.ra.durationMs).toBe(0)
		expect(bad1.dec.durationMs).toBe(0)
		expect(bad1.diagnostics.badFrame).toBeTrue()
		expect(bad1.diagnostics.lostFrames).toBe(1)
		const bad2 = g.processFrame(frame([], 2000, 2))
		expect(bad2.state).toBe('lost')
		expect(bad2.diagnostics.lost).toBeTrue()
	})

	test('reacquisition clears lost counters and resumes guiding', () => {
		const g = guider({ lostStarFrameCount: 2 })
		g.initialize(frame(BASE_STARS, 0))
		g.processFrame(frame([], 1000))
		g.processFrame(frame([], 2000))
		const reacquired = g.processFrame(frame(shift(BASE_STARS, 0.4, -0.2), 3000, 3))
		expect(reacquired.state).toBe('guiding')
		expect(reacquired.diagnostics.badFrame).toBeFalse()
		expect(reacquired.diagnostics.frameId).toBe(3)
		expect(reacquired.diagnostics.qualityScore).toBeGreaterThan(0)
		expect(reacquired.diagnostics.axisErrorRA).toBeDefined()
		expect(reacquired.diagnostics.axisErrorDEC).toBeDefined()
	})

	test('end-to-end x/y drifts map to axis pulses and no-pulse when centered', () => {
		const g = guider()
		g.initialize(frame(BASE_STARS, 0))
		let cmd = g.processFrame(frame(BASE_STARS, 1000))
		expect(cmd.ra.durationMs).toBe(0)
		expect(cmd.dec.durationMs).toBe(0)
		cmd = g.processFrame(frame(shift(BASE_STARS, 0.4, 0), 2000))
		expect(cmd.ra.durationMs).toBeGreaterThan(0)
		expect(cmd.dec.durationMs).toBe(0)
		cmd = g.processFrame(frame(shift(BASE_STARS, 0, -0.4), 3000))
		expect(cmd.dec.durationMs).toBeGreaterThan(0)
	})
})

describe('7/19. dithering behavior', () => {
	test('dither start/stop applies target offset in image space and clamps large offsets', () => {
		const g = guider({ maxPulseMsRA: 80, maxPulseMsDEC: 90, msPerRAUnit: 100, msPerDECUnit: 100 })
		g.initialize(frame(BASE_STARS, 0))
		g.startDither({ dxPixels: 2, dyPixels: -1 })
		let cmd = g.processFrame(frame(BASE_STARS, 1000))
		expect(cmd.ra.durationMs).toBeGreaterThan(0)
		expect(cmd.dec.durationMs).toBeGreaterThan(0)
		g.startDither({ dxPixels: 50, dyPixels: -50 })
		cmd = g.processFrame(frame(BASE_STARS, 2000))
		expect(cmd.ra.durationMs).toBe(80)
		expect(cmd.dec.durationMs).toBe(90)
		g.stopDither()
		cmd = g.processFrame(frame(BASE_STARS, 3000))
		expect(cmd.ra.durationMs).toBe(0)
		expect(cmd.dec.durationMs).toBe(0)
	})

	test('dither state persists through temporary star loss', () => {
		const g = guider({ lostStarFrameCount: 3 })
		g.initialize(frame(BASE_STARS, 0))
		g.startDither({ dxPixels: 1, dyPixels: 1 })
		g.processFrame(frame([], 1000))
		g.processFrame(frame([], 2000))
		const recovered = g.processFrame(frame(shift(BASE_STARS, 1, 1), 3000))
		expect(recovered.diagnostics.ditherActive).toBeTrue()
		expect(g.getState().ditherActive).toBeTrue()
	})
})

describe('16/20. configuration and regression tests', () => {
	test('rejects invalid controller configuration', () => {
		expect(() => guider({ minMoveRA: -1 })).toThrow()
		expect(() => guider({ minPulseMsRA: -1 })).toThrow()
		expect(() => guider({ minPulseMsRA: 10, maxPulseMsRA: 5 })).toThrow()
		expect(() => guider({ hysteresisRA: 1.5 })).toThrow()
		expect(() => guider({ maxMatchDistancePx: 0 })).toThrow()
		expect(() => guider({ lostStarFrameCount: 0 })).toThrow()
		expect(() => guider({ calibration: { m00: 1, m01: 2, m10: 2, m11: 4 } })).toThrow()
	})

	test('regression: no stale pulse emitted after bad frame and no NaN propagation', () => {
		const g = guider()
		g.initialize(frame(BASE_STARS, 0))
		const good = g.processFrame(frame(shift(BASE_STARS, 0.6, 0.2), 1000))
		expect(good.ra.durationMs).toBeGreaterThan(0)
		const badStars = [star(0, { x: Number.NaN }), star(1, { snr: 30 })]
		const bad = g.processFrame(frame(badStars, 2000))
		expect(bad.ra.durationMs).toBe(0)
		expect(bad.dec.durationMs).toBe(0)
		expect(bad.diagnostics.badFrame).toBeTrue()
	})

	test('regression: wrong calibration sign inverts pulse direction', () => {
		const g = guider({ calibration: { m00: -1, m01: 0, m10: 0, m11: -1 } })
		g.initialize(frame(BASE_STARS, 0))
		const cmd = g.processFrame(frame(shift(BASE_STARS, 0.5, 0.5), 1000))
		expect(cmd.ra.direction).toBe('east')
		expect(cmd.dec.direction).toBe('south')
	})
})

describe('17/18/21. deterministic simulation scenarios', () => {
	test('drift-only RA simulation keeps corrective direction and bounded pulses', () => {
		const g = guider({ hysteresisRA: 0.4, hysteresisDEC: 0.4 })
		g.initialize(frame(BASE_STARS, 0))
		let ts = 1000
		let maxPulse = 0
		for (let i = 1; i <= 12; i++) {
			const cmd = g.processFrame(frame(shift(BASE_STARS, i * 0.15, 0), ts, i))
			expect(cmd.ra.direction).toBe('west')
			maxPulse = Math.max(maxPulse, cmd.ra.durationMs)
			ts += 1000
		}
		expect(maxPulse).toBeLessThanOrEqual(1000)
	})

	test('drift with seeing noise and one outlier jump suppresses outlier frame', () => {
		const g = guider({ maxFrameJumpPx: 2.5, hysteresisRA: 0.5, hysteresisDEC: 0.5 })
		g.initialize(frame(BASE_STARS, 0))
		const offsets = [
			[0.1, -0.05],
			[0.2, -0.1],
			[0.3, -0.13],
			[5, 5],
			[0.4, -0.2],
		] as const
		for (let i = 0; i < offsets.length; i++) {
			const [dx, dy] = offsets[i]
			const cmd = g.processFrame(frame(shift(BASE_STARS, dx, dy), (i + 1) * 1000))
			if (i === 3) {
				expect(cmd.diagnostics.badFrame).toBeTrue()
				expect(cmd.ra.durationMs).toBe(0)
				expect(cmd.dec.durationMs).toBe(0)
			}
		}
	})

	test('temporary cloud and loss for two frames reacquires on third', () => {
		const g = guider({ lostStarFrameCount: 3 })
		g.initialize(frame(BASE_STARS, 0))
		g.processFrame(frame([], 1000))
		g.processFrame(frame([], 2000))
		const recovered = g.processFrame(frame(shift(BASE_STARS, 0.3, 0.2), 3000))
		expect(recovered.state).toBe('guiding')
		expect(recovered.diagnostics.lostFrames).toBe(0)
	})

	test('dec backlash simulation suppresses alternating jitter near zero', () => {
		const g = guider({
			hysteresisDEC: 0,
			decReversalThreshold: 0.08,
			decBacklashAccumThreshold: 0.25,
			minMoveDEC: 0.01,
		})
		g.initialize(frame(BASE_STARS, 0))
		const sequence = [0.2, -0.05, 0.04, -0.06, 0.03, -0.07]
		let reversalCount = 0
		for (let i = 0; i < sequence.length; i++) {
			const cmd = g.processFrame(frame(shift(BASE_STARS, 0, sequence[i]), (i + 1) * 1000))
			if (cmd.dec.durationMs > 0 && cmd.dec.direction === 'south') reversalCount++
		}
		expect(reversalCount).toBe(0)
	})
})

// Sanity guard for floating-point tolerance helper usage.
test('epsilon sanity', () => {
	expect(Math.abs(0.1 + 0.2 - 0.3)).toBeLessThan(1e-12 + EPS)
})
