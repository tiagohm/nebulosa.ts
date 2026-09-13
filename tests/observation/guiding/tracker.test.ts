import { expect, test } from 'bun:test'
import { trackingOf, trackingResultFromStars, type GuideTracker, type GuideTrackerResult } from '../../../src/observation/guiding/tracker'

test('generic tracking result preserves measurements, quality, notes, and offsets', () => {
	const result: GuideTrackerResult = {
		measurement: { x: 12.5, y: 8.25, confidence: 0.75 },
		candidateCount: 3,
		acceptedCount: 2,
		qualityScore: 2 / 3,
		rejectedReasons: { low_snr: 1 },
		notes: ['reacquired'],
		targetOffset: [0.5, -0.25],
		measurementMode: 'singleStar',
	}

	expect(result.measurement).toEqual({ x: 12.5, y: 8.25, confidence: 0.75 })
	expect(result.targetOffset).toEqual([0.5, -0.25])
	expect(result.notes).toEqual(['reacquired'])
})

test('failed decode is represented without carrying pixels from another frame', () => {
	const tracker: GuideTracker = {
		reset: () => {},
		track: (frame) => ({
			candidateCount: 0,
			acceptedCount: 0,
			qualityScore: 0,
			rejectedReasons: {},
			notes: frame.image === undefined ? ['image_unavailable'] : [],
		}),
	}

	const result = tracker.track(
		{ width: 100, height: 80, timestamp: 10, frameId: 2 },
		{
			phase: 'looping',
			allowAcquisition: false,
			preserveIdentity: true,
		},
	)

	expect(result.measurement).toBeUndefined()
	expect(result.notes).toEqual(['image_unavailable'])
})

test('legacy star fixtures adapt to generic measurement and telemetry', () => {
	const stars = [{ x: 10, y: 20, snr: 12, flux: 400, hfd: 3 }]
	const result = trackingResultFromStars(stars)

	expect(result).toEqual({
		measurement: { x: 10, y: 20, confidence: 1 },
		candidateCount: 1,
		acceptedCount: 1,
		qualityScore: 1,
		rejectedReasons: {},
		notes: [],
		measurementMode: 'singleStar',
		telemetry: { signalToNoise: 12, mass: 400, hfdPx: 3 },
	})

	const frame = { tracking: result, width: 100, height: 80 }
	expect(trackingOf(frame).measurement).toEqual({ x: 10, y: 20, confidence: 1 })
})
