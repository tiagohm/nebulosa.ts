import { expect, test } from 'bun:test'
import { galileanMutualEvents, saturnianMutualEvents } from '../../../src/astronomy/events/mutual'
import { Timescale, type Time, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'

// The 2026-2027 Jupiter mutual-event season (Earth and Sun near the Jovian equatorial plane) provides the
// reference events. Positions come from the L1.2 Galilean theory; the geometry is cross-checked against
// JPL Horizons, whose independent JUP365 ephemeris agrees to the L1.2 accuracy (~0.005" for the
// occultation separation, a few hundred km for the eclipse shadow distance).

// Seconds of elapsed UTC from a reference instant.
function secondsAfter(time: Time, reference: Time): number {
	return timeSubtract(time, reference, Timescale.UTC) * 86400
}

test('finds the Europa-Ganymede mutual occultation on 2026-12-05', () => {
	const start = timeYMDHMS(2026, 12, 5, 18, 0, 0, Timescale.UTC)
	const events = galileanMutualEvents(start, timeYMDHMS(2026, 12, 5, 21, 0, 0, Timescale.UTC))
	expect(events.length).toBe(1)

	const occultation = events[0]
	expect(occultation.kind).toBe('occultation')
	// Europa is nearer Earth, so it passes in front of Ganymede.
	expect(occultation.front).toBe('europa')
	expect(occultation.back).toBe('ganymede')

	// Impact 0.318: Horizons gives the two moons' apparent separation as 0.366" at mid-event versus 0.371"
	// here (the L1.2-vs-JUP365 ephemeris difference), i.e. the same fraction of the ~1.16" contact limit.
	expect(occultation.impactParameter).toBeCloseTo(0.318, 2)

	// Mid-occultation 2026-12-05 19:17:59.7 UTC; the event lasts ~17.7 min with its contacts bracketing it.
	expect(secondsAfter(occultation.middle, start)).toBeCloseTo(4679.7, -1)
	expect(secondsAfter(occultation.start!, start)).toBeLessThan(secondsAfter(occultation.middle, start))
	expect(secondsAfter(occultation.end!, start)).toBeGreaterThan(secondsAfter(occultation.middle, start))
	expect(secondsAfter(occultation.end!, occultation.start!)).toBeGreaterThan(900)
	expect(secondsAfter(occultation.end!, occultation.start!)).toBeLessThan(1200)
}, 2000)

test('finds the Ganymede-shadow mutual eclipses on 2026-12-02', () => {
	const start = timeYMDHMS(2026, 12, 2, 19, 0, 0, Timescale.UTC)
	const events = galileanMutualEvents(start, timeYMDHMS(2026, 12, 2, 22, 0, 0, Timescale.UTC))
	expect(events.length).toBe(2)

	// Ganymede is nearer the Sun and casts its shadow; the first event is a nearly central eclipse of
	// Callisto. Horizons Sun-centered geometric vectors put Callisto ~620 km from the shadow axis (~445 km
	// here), both far inside the ~7600 km penumbra.
	const central = events[0]
	expect(central.kind).toBe('eclipse')
	expect(central.front).toBe('ganymede')
	expect(central.back).toBe('callisto')
	expect(central.impactParameter).toBeCloseTo(0.058, 2)
	expect(secondsAfter(central.middle, start)).toBeCloseTo(6714.3, -1)

	// The second is Ganymede shadowing Europa, less central and later; events are chronological.
	expect(events[1].kind).toBe('eclipse')
	expect(events[1].back).toBe('europa')
	expect(secondsAfter(events[1].middle, start)).toBeGreaterThan(secondsAfter(central.middle, start))
}, 2000)

test('reports an event that is only underway during the window', () => {
	// A narrow window wholly inside the 2026-12-05 Europa-Ganymede occultation (mid 19:17:59.7, ending
	// 19:26:56): the event overlaps the window although both its minimum and first contact lie before the
	// window start, so it must still be reported with the first contact blanked as undefined.
	const start = timeYMDHMS(2026, 12, 5, 19, 20, 0, Timescale.UTC)
	const stop = timeYMDHMS(2026, 12, 5, 19, 30, 0, Timescale.UTC)
	const events = galileanMutualEvents(start, stop)
	expect(events.length).toBe(1)

	const event = events[0]
	expect(event.kind).toBe('occultation')
	expect(event.front).toBe('europa')
	expect(event.back).toBe('ganymede')
	// Already underway at the window start: the first contact is dropped, the last contact is in-window.
	expect(event.start).toBeUndefined()
	expect(event.end).toBeDefined()
	expect(secondsAfter(event.end!, start)).toBeGreaterThan(0)
	expect(secondsAfter(event.end!, stop)).toBeLessThan(0)
	// The middle is the true peak of the occultation, just before the window start.
	expect(secondsAfter(event.middle, start)).toBeLessThan(0)
})

test('finds the Titan-Rhea mutual events in the 2025 Saturn season', () => {
	// Near Saturn's 2025 conjunction (just after the ring-plane crossing) the Sun and Earth are almost in
	// line, so Titan eclipses Rhea and then occults it a few minutes later.
	const start = timeYMDHMS(2025, 3, 12, 10, 0, 0, Timescale.UTC)
	const events = saturnianMutualEvents(start, timeYMDHMS(2025, 3, 12, 13, 0, 0, Timescale.UTC))
	expect(events.length).toBe(2)

	const eclipse = events[0]
	expect(eclipse.kind).toBe('eclipse')
	expect(eclipse.front).toBe('titan')
	expect(eclipse.back).toBe('rhea')

	const occultation = events[1]
	expect(occultation.kind).toBe('occultation')
	expect(occultation.front).toBe('titan')
	expect(occultation.back).toBe('rhea')
	// Impact 0.245: Horizons gives the apparent separation as 0.112" at mid-occultation versus 0.107" here
	// (the TASS17-vs-SAT441 ephemeris difference).
	expect(occultation.impactParameter).toBeCloseTo(0.245, 2)
	// Mid-occultation 2025-03-12 11:34:01 UTC, minutes after the eclipse.
	expect(secondsAfter(occultation.middle, start)).toBeCloseTo(5641.3, -1)
	expect(secondsAfter(occultation.middle, eclipse.middle)).toBeGreaterThan(0)
}, 6000)

test('contacts bracket every event and impact parameters stay in range', () => {
	const events = galileanMutualEvents(timeYMDHMS(2026, 12, 2, 19, 0, 0, Timescale.UTC), timeYMDHMS(2026, 12, 2, 22, 0, 0, Timescale.UTC))
	expect(events.length).toBeGreaterThan(0)

	for (const event of events) {
		expect(event.impactParameter).toBeGreaterThanOrEqual(0)
		expect(event.impactParameter).toBeLessThan(1)
		if (event.start !== undefined) expect(timeSubtract(event.middle, event.start)).toBeGreaterThan(0)
		if (event.end !== undefined) expect(timeSubtract(event.end, event.middle)).toBeGreaterThan(0)
	}
})
