import { expect, test } from 'bun:test'
import { StarTracker } from '../../../src/observation/guiding/tracker.star'

test('missing image publishes a fresh non-stellar result without reusing identity', () => {
	const tracker = new StarTracker()
	const context = { phase: 'guiding' as const, allowAcquisition: true, preserveIdentity: true }

	const first = tracker.track({ width: 800, height: 600, timestamp: 1, frameId: 1 }, context)
	const second = tracker.track({ width: 800, height: 600, timestamp: 2, frameId: 2 }, context)

	expect(first).toEqual(second)
	expect(tracker.lastResult).toBe(second)
	expect(second.measurement).toBeUndefined()
	expect(second.detections).toEqual([])
})

test('reset drops the last frame result and target identity', () => {
	const tracker = new StarTracker()
	tracker.track({ width: 100, height: 80, timestamp: 1, frameId: 1 }, { phase: 'looping', allowAcquisition: false, preserveIdentity: false })

	expect(tracker.lastResult).toBeDefined()
	tracker.reset()
	expect(tracker.lastResult).toBeUndefined()
})
