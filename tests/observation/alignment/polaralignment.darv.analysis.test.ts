import { describe, expect, test } from 'bun:test'
import { equatorialPointingError, polarAlignmentPointingModel } from '../../../src/astronomy/coordinates/pointing'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import type { Streak } from '../../../src/imaging/analysis/streak/types'
import type { Image } from '../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../src/imaging/synthetic/streak'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { type Vec3, vecDot, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import type { Point } from '../../../src/math/numerical/geometry'
import { arcmin, arcsec, deg } from '../../../src/math/units/angle'
import { darvGeometryFactors } from '../../../src/observation/alignment/polaralignment.darv'
import { analyzeDarvImage, type DarvAnalysisInput } from '../../../src/observation/alignment/polaralignment.darv.analysis'
import { estimateDarvPolarErrorComponent, solveDarvPolarError } from '../../../src/observation/alignment/polaralignment.darv.solve'
import { DarvCalibrationTransform, DarvMatrixTransform, DarvWcsTransform } from '../../../src/observation/alignment/polaralignment.darv.transform'
import { applyMountAdjustment } from '../../../src/observation/alignment/polaralignment.util'

const SCALE = arcsec(1)

function image(width = 256, height = 192): Image {
	return { raw: new Float32Array(width * height).fill(0.1), header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function segment(start: Readonly<Point>, end: Readonly<Point>, overrides: Partial<Streak> = {}): Streak {
	return {
		start,
		end,
		center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
		length: Math.hypot(end.x - start.x, end.y - start.y),
		width: 2,
		angle: Math.atan2(end.y - start.y, end.x - start.x),
		rmsResidual: 0.05,
		linearity: 1,
		coverage: 1,
		supportPixels: 400,
		clippedAtBorder: false,
		flux: 100,
		meanSignal: 0.4,
		peakSignal: 0.5,
		snr: 50,
		confidence: 0.9,
		...overrides,
	}
}

function capture(drift = 0.15, outbound = 100, inbound = 100, dwell = 0, angle = 0, parity = 1): DarvAnalysisInput {
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	const pixel = (east: number, north: number) => ({ x: 100 + cos * east - sin * north * parity, y: 80 + sin * east + cos * north * parity })
	const start = pixel(0, 0)
	const turn = pixel(outbound, drift * outbound)
	const returnStart = pixel(outbound, drift * (outbound + dwell))
	const end = pixel(outbound - inbound, drift * (outbound + inbound + dwell))
	return {
		image: image(384, 384),
		exposure: outbound + inbound + dwell,
		legDuration: 100,
		outboundDuration: outbound,
		returnDuration: inbound,
		turnaroundDuration: dwell,
		firstDirection: 'east',
		starts: [start],
		transform: new DarvMatrixTransform([cos * SCALE, sin * SCALE, -sin * parity * SCALE, cos * parity * SCALE]),
		streaks: [segment(start, turn), segment(returnStart, end)],
	}
}

describe('DARV trail measurements', () => {
	for (const angle of [0, Math.PI / 2, 0.71])
		for (const parity of [-1, 1])
			for (const drift of [-0.15, 0.15]) {
				test(`signed drift under rotation ${angle}, parity ${parity}, drift ${drift}`, () => {
					const result = analyzeDarvImage(capture(drift, 100, 100, 0, angle, parity))
					expect(result.status).toBe('ok')
					expect(result.trails).toHaveLength(1)
					expect(result.drift!).toBeCloseTo(drift * SCALE, 13)
					expect(result.trails[0].outbound.length).toBeCloseTo(Math.hypot(100, 100 * drift), 10)
					expect(result.trails[0].driftMagnitude).toBeCloseTo(Math.abs(drift) * SCALE, 13)
				})
			}

	test('actual unequal durations and dwell include drift throughout the shutter interval', () => {
		for (const [outbound, inbound, dwell] of [
			[80, 120, 0],
			[100, 100, 30],
			[80, 120, 30],
		]) {
			const input = capture(0.15, outbound, inbound, dwell)
			const result = analyzeDarvImage({ ...input, legDuration: 999 })
			expect(result.status).toBe('ok')
			expect(result.drift!).toBeCloseTo(0.15 * SCALE, 13)
			expect(result.trails[0].returnStart.y - result.trails[0].turn.y).toBeCloseTo(0.15 * dwell, 10)
		}
	})

	test('unequal timing resolves direction without a start marker', () => {
		const result = analyzeDarvImage({ ...capture(-0.15, 80, 120), starts: undefined })
		expect(result.status).toBe('ok')
		expect(result.drift!).toBeCloseTo(-0.15 * SCALE, 13)
	})

	test('RA direction alone cannot label equal-time outer endpoints', () => {
		const result = analyzeDarvImage({ ...capture(), starts: undefined })
		expect(result.status).toBe('partial')
		expect(result.drift).toBeUndefined()
		expect(result.driftMagnitude!).toBeCloseTo(0.15 * SCALE, 13)
		expect(result.diagnostics).toContain('directionUnresolved')
	})

	test('missing transform preserves unsigned transverse pixel geometry', () => {
		const result = analyzeDarvImage({ ...capture(0.15, 100, 100, 0, 0.71, -1), transform: undefined })
		expect(result.drift).toBeUndefined()
		expect(result.driftMagnitude!).toBeCloseTo(0.15, 10)
		expect(result.driftUnit).toBe('pixelsPerSecond')
		expect(result.diagnostics).toContain('missingAngularTransform')
	})

	test('perfect retrace is retained with a resolution limit instead of a signed zero', () => {
		const input = capture(0)
		const result = analyzeDarvImage({ ...input, streaks: input.streaks!.slice(0, 1) })
		expect(result.status).toBe('partial')
		expect(result.trails[0].driftMagnitude).toBe(0)
		expect(result.trails[0].uncertainty).toBeGreaterThan(0)
		expect(result.drift).toBeUndefined()
		expect(result.diagnostics).toContain('unresolvedSeparation')
	})

	test('clipped, saturated, short and weak trails do not contribute signed drift', () => {
		for (const [override, reason] of [
			[{ clippedAtBorder: true }, 'trailClipped'],
			[{ saturationFraction: 0.1 }, 'trailSaturated'],
			[{ length: 5 }, 'trailTooShort'],
			[{ snr: 2 }, 'insufficientSnr'],
		] as const) {
			const input = capture()
			const result = analyzeDarvImage({ ...input, streaks: input.streaks!.map((streak) => Object.assign({}, streak, override)) })
			expect(result.drift).toBeUndefined()
			expect(result.diagnostics).toContain(reason)
		}
	})

	test('competing pairs are ambiguous rather than greedily assigned', () => {
		const input = capture()
		const extra = segment({ x: 100, y: 117 }, { x: 200, y: 95 })
		const result = analyzeDarvImage({ ...input, streaks: [...input.streaks!, extra] })
		expect(result.drift).toBeUndefined()
		expect(result.diagnostics).toContain('ambiguousTrails')
	})

	test('multiple stars reject one drift outlier and an unrelated crossing', () => {
		const streaks: Streak[] = []
		const starts: Point[] = []
		for (let i = 0; i < 5; i++) {
			const input = capture(i === 4 ? -0.15 : 0.15)
			const shift = (point: Readonly<Point>) => ({ x: point.x, y: point.y + i * 100 })
			starts.push(shift(input.starts![0]))
			for (const streak of input.streaks!) streaks.push(segment(shift(streak.start), shift(streak.end), i === 4 ? { flux: 1e9 } : {}))
		}
		streaks.push(segment({ x: 150, y: 0 }, { x: 150, y: 600 }))
		const result = analyzeDarvImage({ ...capture(), image: image(256, 640), streaks, starts })
		expect(result.trails).toHaveLength(5)
		expect(result.inliers).toBe(4)
		expect(result.drift!).toBeCloseTo(0.15 * SCALE, 13)
		expect(result.diagnostics).toContain('outlierTrails')
	})

	test('inconsistent shutter timing is explicit', () => {
		const result = analyzeDarvImage({ ...capture(), exposure: 210 })
		expect(result.diagnostics).toEqual(['invalidTiming'])
	})

	test('empty supplied detections skip image detection', () => {
		expect(analyzeDarvImage({ ...capture(), streaks: [] }).diagnostics).toContain('noStreaks')
	})

	test('westbound outbound motion and reversed detector endpoint order preserve celestial sign', () => {
		const input = capture(-0.15)
		const reflect = (point: Readonly<Point>) => ({ x: 300 - point.x, y: point.y })
		const streaks = input.streaks!.map((streak) => segment(reflect(streak.end), reflect(streak.start)))
		const result = analyzeDarvImage({ ...input, streaks, starts: input.starts!.map(reflect), firstDirection: 'west' })
		expect(result.status).toBe('ok')
		expect(result.drift!).toBeCloseTo(-0.15 * SCALE, 13)
	})

	test('component conversion is available only for signed, sensitive geometry', () => {
		const input = { ...capture(), geometry: { latitude: 0.5, hourAngle: 0, mode: 'azimuth' as const } }
		const result = analyzeDarvImage(input)
		expect(result.component?.status).toBe('ok')
		const degenerate = analyzeDarvImage({ ...input, geometry: { ...input.geometry, mode: 'altitude' } })
		expect(degenerate.component?.status).toBe('inconclusive')
		expect(degenerate.diagnostics).toContain('geometryDegenerate')
		expect(analyzeDarvImage({ ...input, starts: undefined }).component).toBeUndefined()
	})

	test('pairing has a fixed candidate limit for supplied detections', () => {
		const input = capture()
		const streaks = Array.from({ length: 1000 }, (_, i) => segment({ x: 30, y: 20 + i * 20 }, { x: 200, y: 20 + i * 20 }))
		const result = analyzeDarvImage({ ...input, streaks })
		expect(result.diagnostics).toContain('candidateLimit')
		expect(result.drift).toBeUndefined()
	})
})

describe('DARV adapters', () => {
	test('calibration is evaluated again after a flip and preserves axis units/signs', () => {
		let sign = 1
		const transform = new DarvCalibrationTransform(
			() => [0, sign * 2, 3, 0],
			() => [-SCALE / 2, SCALE / 3],
		)
		expect(transform.imageOffsetToSky(2, 4)).toEqual([-4 * SCALE, 2 * SCALE])
		sign = -1
		expect(transform.imageOffsetToSky(2, 4)).toEqual([4 * SCALE, 2 * SCALE])
	})

	test('WCS uses zero-based centers, local SIP, RA wrap and current parity', () => {
		const header: FitsHeader = { CTYPE1: 'RA---TAN-SIP', CTYPE2: 'DEC--TAN-SIP', CRVAL1: 359.9999, CRVAL2: 30, CRPIX1: 101, CRPIX2: 81, CD1_1: -1 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 1 / 3600, A_ORDER: 2, B_ORDER: 2, A_2_0: 0.001 }
		const transform = new DarvWcsTransform(() => header, { x: 100, y: 80 })
		expect(transform.imageOffsetToSky(1, 0)![0]).toBeCloseTo(-SCALE, 12)
		expect(transform.imageOffsetToSky(0, 1)![1]).toBeCloseTo(SCALE, 12)
		expect(transform.imageOffsetToSky(1, 0, { x: 120, y: 80 })![0]).toBeCloseTo(-SCALE * 1.04, 11)
		header.CD1_1 = 1 / 3600
		expect(transform.imageOffsetToSky(1, 0)![0]).toBeCloseTo(SCALE, 12)
	})

	test('unusable WCS retains pixel geometry and reports the missing angular solution', () => {
		const transform = new DarvWcsTransform(() => ({}), { x: 100, y: 80 })
		expect(transform.imageOffsetToSky(1, 0)).toBeUndefined()
		const result = analyzeDarvImage({ ...capture(), transform })
		expect(result.drift).toBeUndefined()
		expect(result.trails).toHaveLength(1)
		expect(result.driftMagnitude!).toBeCloseTo(0.15, 10)
		expect(result.diagnostics).toContain('geometryDegenerate')
	})
})

// Independent differentiation of the BORESIGHT pointing model, negated for star motion.
function pointingDrift(azimuth: number, altitude: number, latitude: number, hourAngle: number): number {
	const model = polarAlignmentPointingModel(azimuth, altitude, latitude)
	const before = equatorialPointingError(hourAngle - SIDEREAL_DRIFT_RATE / 2, 0.3, model)
	const after = equatorialPointingError(hourAngle + SIDEREAL_DRIFT_RATE / 2, 0.3, model)
	return before[1] - after[1]
}

describe('DARV polar inversion', () => {
	for (const latitude of [deg(-45), deg(45)])
		for (const sign of [-1, 1])
			for (const h of [-1.3, -0.5, 0.5, 1.3]) {
				test(`pointing derivative at latitude ${latitude}, H ${h}, sign ${sign}`, () => {
					const error = sign * arcmin(30)
					for (const mode of ['azimuth', 'altitude'] as const) {
						const drift = pointingDrift(mode === 'azimuth' ? error : 0, mode === 'altitude' ? error : 0, latitude, h)
						const result = estimateDarvPolarErrorComponent({ drift, latitude, hourAngle: h, uncertainty: 1e-9 }, mode)
						expect(result.status).toBe('ok')
						if (result.status !== 'ok') return
						expect(result.error).toBeCloseTo(error, 10)
						expect(result.uncertainty).toBeGreaterThan(0)
					}
				})
			}

	test('rejects nearly singular component and joint geometry', () => {
		expect(estimateDarvPolarErrorComponent({ drift: 0, latitude: 0.5, hourAngle: 0 }, 'altitude').status).toBe('inconclusive')
		expect(estimateDarvPolarErrorComponent({ drift: 0, latitude: Math.PI / 2, hourAngle: 0 }, 'azimuth').status).toBe('inconclusive')
		for (const delta of [0, 1e-6, 0.001])
			expect(
				solveDarvPolarError([
					{ drift: 0, latitude: 0.5, hourAngle: 0.5 },
					{ drift: 0, latitude: 0.5, hourAngle: 0.5 + delta },
				]).status,
			).toBe('inconclusive')
		expect(solveDarvPolarError([]).status).toBe('inconclusive')
	})

	test('two separated hour angles recover both components through one degree', () => {
		for (const latitude of [-0.6, 0.6])
			for (const [azimuth, altitude] of [
				[0, 0],
				[arcmin(20), -arcmin(10)],
				[-deg(1), deg(1)],
			]) {
				const observations = [0, 1.4].map((hourAngle) => ({ hourAngle, latitude, drift: pointingDrift(azimuth, altitude, latitude, hourAngle) }))
				const result = solveDarvPolarError(observations)
				expect(result.status).toBe('ok')
				if (result.status !== 'ok') return
				expect(result.azimuthError).toBeCloseTo(azimuth, 10)
				expect(result.altitudeError).toBeCloseTo(altitude, 10)
				expect(result.residualRms).toBeLessThan(1e-18)
			}
	})

	test('one-degree small-angle limit stays within one arcminute of exact rigid-axis drift', () => {
		for (const latitude of [-0.6, 0.6])
			for (const sign of [-1, 1]) {
				const azimuth = sign * deg(1)
				const altitude = -sign * deg(0.7)
				const pole = applyMountAdjustment([0, 0, 1], [Math.cos(latitude), 0, Math.sin(latitude)], [0, 1, 0], -azimuth, altitude)
				const observations = [-1.2, 0, 1.2].map((hourAngle) => {
					const star: Vec3 = [Math.cos(hourAngle), -Math.sin(hourAngle), 0]
					const position = (seconds: number) => {
						const earthFixed = vecRotateByRodrigues(star, [0, 0, 1], -SIDEREAL_DRIFT_RATE * seconds)
						const camera = vecRotateByRodrigues(earthFixed, pole, SIDEREAL_DRIFT_RATE * seconds)
						return Math.atan2(camera[2], vecDot(camera, star))
					}
					return { hourAngle, latitude, drift: position(0.5) - position(-0.5) }
				})
				const result = solveDarvPolarError(observations)
				expect(result.status).toBe('ok')
				if (result.status !== 'ok') return
				// Exact vector kinematics recover pY/cos(latitude) and pX in this linear inversion.
				// The azimuth bias includes -azimuth*altitude*tan(latitude), about 0.51 arcmin here.
				expect(result.azimuthError).toBeCloseTo(pole[1] / Math.cos(latitude), 10)
				expect(result.altitudeError).toBeCloseTo(pole[0], 10)
				expect(Math.abs(result.azimuthError - azimuth)).toBeLessThan(arcmin(1))
				expect(Math.abs(result.altitudeError - altitude)).toBeLessThan(arcmin(1))
			}
	})

	test('uncertainty weighting reduces a noisy observation influence', () => {
		const observations = [-1.3, -0.5, 0.2, 1].map((hourAngle, i) => ({ hourAngle, latitude: 0.5, drift: pointingDrift(0.01, -0.004, 0.5, hourAngle) + (i === 3 ? 1e-6 : 0), uncertainty: i === 3 ? 1e-5 : 1e-9 }))
		const result = solveDarvPolarError(observations)
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.azimuthError).toBeCloseTo(0.01, 8)
		expect(result.altitudeError).toBeCloseTo(-0.004, 8)
	})

	test('Huber fit downweights an inconsistent observation', () => {
		const observations = Array.from({ length: 15 }, (_, i) => ({ hourAngle: -1.4 + i * 0.2, latitude: 0.5, drift: pointingDrift(0.01, -0.004, 0.5, -1.4 + i * 0.2) + (i === 7 ? 1e-6 : Math.sin(i) * 1e-10) }))
		const result = solveDarvPolarError(observations, true)
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.azimuthError).toBeCloseTo(0.01, 5)
		expect(result.altitudeError).toBeCloseTo(-0.004, 5)
		expect(result.inliers).toBeLessThan(15)
	})

	test('shared planner factors are stellar, opposite boresight drift', () => {
		const [azimuth, altitude] = darvGeometryFactors(0.5, 0.8)
		expect(azimuth * SIDEREAL_DRIFT_RATE).toBeCloseTo(pointingDrift(1, 0, 0.5, 0.8), 12)
		expect(altitude * SIDEREAL_DRIFT_RATE).toBeCloseTo(pointingDrift(0, 1, 0.5, 0.8), 12)
	})
})

describe('DARV image extraction', () => {
	test('duplicate Hough hypotheses refined onto the same leg do not create ambiguity', () => {
		const frame = image()
		const start = { x: 40, y: 96 }
		const turn = { x: 210, y: 71 }
		renderSyntheticStreak(frame, { start, end: turn, width: 2, intensity: 0.4 })
		renderSyntheticStreak(frame, { start: turn, end: { x: 40, y: 46 }, width: 2, intensity: 0.4 })
		const result = analyzeDarvImage({ ...capture(), image: frame, starts: [start], streaks: undefined, detection: { maxWidth: 6 } })
		expect(result.status).toBe('ok')
		expect(result.inliers).toBe(1)
		expect(result.diagnostics).not.toContain('ambiguousTrails')
		expect(Math.abs(result.drift! / (-0.25 * SCALE) - 1)).toBeLessThan(0.05)
	})

	test('blank and low-signal noisy frames do not invent a measurement', () => {
		const frame = image()
		for (let i = 0; i < frame.raw.length; i++) frame.raw[i] += 0.01 * Math.sin(i * 17.321)
		renderSyntheticStreak(frame, { start: { x: 40, y: 70 }, end: { x: 210, y: 95 }, width: 2, intensity: 1e-5 })
		const result = analyzeDarvImage({ ...capture(), image: frame, streaks: undefined, detection: { maxCandidates: 32 } })
		expect(result.drift).toBeUndefined()
		expect(result.trails).toHaveLength(0)
	})

	test('saturated rendered trails are excluded using the supplied sensor threshold', () => {
		const frame = image()
		renderSyntheticStreak(frame, { start: { x: 40, y: 70 }, end: { x: 210, y: 95 }, width: 2, intensity: 2, saturationLevel: 1 })
		renderSyntheticStreak(frame, { start: { x: 210, y: 95 }, end: { x: 40, y: 120 }, width: 2, intensity: 2, saturationLevel: 1 })
		const result = analyzeDarvImage({ ...capture(), image: frame, streaks: undefined, detection: { saturationLevel: 1 } })
		expect(result.drift).toBeUndefined()
		expect(result.diagnostics).toContain('trailSaturated')
	})

	test('multiple rendered stars survive a transverse unrelated streak', () => {
		const frame = image(384, 384)
		const starts: Point[] = []
		for (const y of [60, 200]) {
			const start = { x: 40, y }
			starts.push(start)
			const turn = { x: 300, y: y + 25 }
			renderSyntheticStreak(frame, { start, end: turn, width: 2, intensity: 0.4 })
			renderSyntheticStreak(frame, { start: turn, end: { x: 40, y: y + 50 }, width: 2, intensity: 0.4 })
		}
		renderSyntheticStreak(frame, { start: { x: 175, y: 20 }, end: { x: 175, y: 350 }, width: 2, intensity: 0.3 })
		const result = analyzeDarvImage({ ...capture(), image: frame, starts, streaks: undefined, detection: { minLength: 100, maxWidth: 6 } })
		expect(result.status).toBe('ok')
		expect(result.inliers).toBe(2)
		expect(Math.abs(result.drift! / (0.25 * SCALE) - 1)).toBeLessThan(0.05)
	})

	test('fits both rendered legs and signed closure without supplied detections', () => {
		const frame = image()
		const start = { x: 40, y: 70 }
		const turn = { x: 210, y: 95 }
		const end = { x: 40, y: 120 }
		renderSyntheticStreak(frame, { start, end: turn, width: 2, intensity: 0.4 })
		renderSyntheticStreak(frame, { start: turn, end, width: 2, intensity: 0.4 })
		const result = analyzeDarvImage({ image: frame, exposure: 200, legDuration: 100, firstDirection: 'east', starts: [start], transform: new DarvMatrixTransform([SCALE, 0, 0, SCALE]) })
		expect(result.status).toBe('ok')
		expect(result.trails).toHaveLength(1)
		expect(Math.abs(result.drift! / (0.25 * SCALE) - 1)).toBeLessThan(0.05)
		expect(Math.hypot(result.trails[0].turn.x - turn.x, result.trails[0].turn.y - turn.y)).toBeLessThan(3)
	})

	for (const latitude of [-0.6, 0.6])
		for (const parity of [-1, 1]) {
			test(`independent rigid-axis star path recovers polar errors, latitude ${latitude}, parity ${parity}`, () => {
				const azimuth = arcmin(10)
				const altitude = -arcmin(8)
				const observations = [0, 1.4].map((hourAngle) => {
					const input = physicalCapture(azimuth, altitude, latitude, hourAngle, 0.4, parity)
					const result = analyzeDarvImage(input)
					expect(result.status).toBe('ok')
					expect(result.drift).toBeDefined()
					return { drift: result.drift!, hourAngle: hourAngle + SIDEREAL_DRIFT_RATE * 80, latitude }
				})
				const solved = solveDarvPolarError(observations)
				expect(solved.status).toBe('ok')
				if (solved.status !== 'ok') return
				// Includes raster sampling, PSF endpoint bias, axis rotation and the short-exposure approximation.
				expect(Math.abs(solved.azimuthError - azimuth)).toBeLessThan(arcmin(0.6))
				expect(Math.abs(solved.altitudeError - altitude)).toBeLessThan(arcmin(0.6))
			})
		}
})

// Independent physical simulation: a fixed celestial star is expressed in the camera basis by
// undoing Earth rotation and rotating about the misaligned mechanical RA axis. The star's PSF is
// integrated over 160 seconds. No DARV drift formula or detector geometry generates these pixels.
function physicalCapture(azimuth: number, altitude: number, latitude: number, hourAngle: number, cameraAngle: number, parity: number): DarvAnalysisInput {
	const frame = image(384, 384)
	const scale = arcsec(0.2)
	const leg = 80
	const exposure = 2 * leg
	const up: Vec3 = [Math.cos(latitude), 0, Math.sin(latitude)]
	const east: Vec3 = [0, 1, 0]
	const pole = applyMountAdjustment([0, 0, 1], up, east, -azimuth, altitude)
	const dec = 0.2
	const ra = -hourAngle
	const star: Vec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]
	const eastBasis: Vec3 = [-Math.sin(ra), Math.cos(ra), 0]
	const northBasis: Vec3 = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)]
	const cos = Math.cos(cameraAngle)
	const sin = Math.sin(cameraAngle)
	const start = { x: 100, y: 160 }
	const sigma = 0.75
	for (let sample = 0; sample <= 2000; sample++) {
		const elapsed = (exposure * sample) / 2000
		const excursion = (2 * scale * (elapsed < leg ? elapsed : exposure - elapsed)) / Math.cos(dec)
		const earthFixed = vecRotateByRodrigues(star, [0, 0, 1], -SIDEREAL_DRIFT_RATE * elapsed)
		const camera = vecRotateByRodrigues(earthFixed, pole, SIDEREAL_DRIFT_RATE * elapsed + excursion)
		const denominator = vecDot(camera, star)
		const e = vecDot(camera, eastBasis) / denominator / scale
		const n = vecDot(camera, northBasis) / denominator / scale
		const x = start.x + cos * e - sin * n * parity
		const y = start.y + sin * e + cos * n * parity
		for (let iy = Math.max(0, Math.floor(y - 3)); iy <= Math.min(frame.metadata.height - 1, Math.ceil(y + 3)); iy++) {
			for (let ix = Math.max(0, Math.floor(x - 3)); ix <= Math.min(frame.metadata.width - 1, Math.ceil(x + 3)); ix++) frame.raw[iy * frame.metadata.width + ix] += 0.05 * Math.exp(-((ix - x) ** 2 + (iy - y) ** 2) / (2 * sigma * sigma))
		}
	}
	let state = 123456
	for (let i = 0; i < frame.raw.length; i++) {
		state = (1664525 * state + 1013904223) >>> 0
		frame.raw[i] += (state / 2 ** 32 - 0.5) * 0.003
	}
	return { image: frame, exposure, legDuration: leg, starts: [start], firstDirection: 'east', transform: new DarvMatrixTransform([cos * scale, sin * scale, -sin * parity * scale, cos * parity * scale]), detection: { maxWidth: 6, minLength: 50 } }
}
