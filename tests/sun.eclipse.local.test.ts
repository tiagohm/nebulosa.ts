import { describe, expect, test } from 'bun:test'
import { deg, normalizeAngle } from '../src/angle'
import { ASEC2RAD, PI, RAD2DEG, TAU } from '../src/constants'
import { nearestSolarEclipse, type SolarEclipse } from '../src/sun'
import { computePolynomialBesselianElements, type PolynomialBesselianElements } from '../src/sun.eclipse.map'
// oxfmt-ignore
import { buildLocalSolarEclipseViewGeometry, buildLocalViewHorizonGeometry, computeGreatestDurationCircumstances, computeGreatestEclipseCircumstances, computeLocalSolarEclipseCircumstances, findLocalContactRoots, findLocalMaximumTime, type LocalFundamentalState, type LocalSolarEclipseCircumstancesOptions, type LocalSolarEclipseEvent, type LocalSolarEclipseViewOptions, } from '../src/sun.eclipse.local'
import { sphericalSeparation } from '../src/geometry'
import { timeToDate, timeYMD, toJulianDay, type Time } from '../src/time'
import { sunMoonPosition } from './sun.eclipse.test'

function viewOptions(overrides: Partial<LocalSolarEclipseViewOptions> = {}): LocalSolarEclipseViewOptions {
	return { width: 450, height: 160, selectedEvent: 'MAX', orientationMode: 'zenith', solarRadiusPx: 34, includeGhostDisks: true, includeHorizon: true, horizonBandPaddingPx: 4, ...overrides }
}

// The 2024-04-08 total eclipse, with elements and a consistent Sun/Moon source.
const total2024 = (() => {
	const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 8), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	return { eclipse, pbe }
})()

// The 2023-10-14 annular eclipse.
const annular2023 = (() => {
	const eclipse = nearestSolarEclipse(timeYMD(2023, 10, 14), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	return { eclipse, pbe }
})()

// The 2025-09-21 partial eclipse.
const partial2025 = (() => {
	const eclipse = nearestSolarEclipse(timeYMD(2025, 9, 21), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	return { eclipse, pbe }
})()

function local(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, lon: number, lat: number, options: LocalSolarEclipseCircumstancesOptions = {}) {
	return computeLocalSolarEclipseCircumstances(pbe, deg(lon), deg(lat), { sunMoonPosition, ...options })
}

function expectContactKind(event: LocalSolarEclipseEvent | null, kind: string) {
	expect(event).not.toBeNull()
	expect(event!.kind).toBe(kind as LocalSolarEclipseEvent['kind'])
}

describe('local circumstances', () => {
	test('point outside the eclipse region has no events and is not visible', () => {
		const c = local(total2024.eclipse, total2024.pbe, 115, -32) // Perth: nowhere near the 2024 penumbra.
		expect(c.events.C1).toBeNull()
		expect(c.events.C2).toBeNull()
		expect(c.events.MAX).toBeNull()
		expect(c.events.C3).toBeNull()
		expect(c.events.C4).toBeNull()
		expect(c.visibility.kind).toBe('notVisible')
		expect(c.visibility.hasGeometricEclipse).toBe(false)
		expect(c.details.maximalMagnitude).toBeNull()
		expect(c.details.partialPhaseDurationSeconds).toBeNull()
		expect(c.details.centralPhaseDurationSeconds).toBeNull()
		expect(c.details.shadowPathWidthKm).toBeNull()
	})

	test('partial-only location resolves C1/MAX/C4 but no central contacts', () => {
		const c = local(total2024.eclipse, total2024.pbe, -74, 40.71) // New York: deep partial, not on the path.
		expectContactKind(c.events.C1, 'C1')
		expectContactKind(c.events.MAX, 'MAX')
		expectContactKind(c.events.C4, 'C4')
		expect(c.events.C2).toBeNull()
		expect(c.events.C3).toBeNull()
		expect(c.events.MAX!.centralPhaseKind).toBe('none')
		expect(c.events.MAX!.magnitude).toBeGreaterThan(0)
		expect(c.events.MAX!.magnitude).toBeLessThan(1)
		// Partial duration is C4 - C1 and is several thousand seconds; the central duration is undefined.
		expect(c.details.partialPhaseDurationSeconds).toBeCloseTo((c.events.C4!.jd - c.events.C1!.jd) * 86400, 6)
		expect(c.details.partialPhaseDurationSeconds!).toBeGreaterThan(3600)
		expect(c.details.centralPhaseDurationSeconds).toBeNull()
	})

	test('total location resolves all five contacts with magnitude above one', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25) // Mazatlan: on the central line.
		for (const kind of ['C1', 'C2', 'MAX', 'C3', 'C4'] as const) expectContactKind(c.events[kind], kind)
		expect(c.events.MAX!.centralPhaseKind).toBe('total')
		expect(c.events.MAX!.magnitude).toBeGreaterThan(1)
		expect(c.events.MAX!.moonSunDiameterRatio!).toBeGreaterThan(1)
		expect(c.visibility.hasCentralPhase).toBe(true)
		expect(c.visibility.centralPhaseKind).toBe('total')
		expect(c.details.centralPhaseDurationSeconds!).toBeGreaterThan(0)
		// Contacts are time-ordered C1 < C2 < MAX < C3 < C4.
		const jds = [c.events.C1!, c.events.C2!, c.events.MAX!, c.events.C3!, c.events.C4!].map((e) => e.jd)
		for (let i = 1; i < jds.length; i++) expect(jds[i]).toBeGreaterThan(jds[i - 1])
		// A robust local shadow-path width is reported for the central phase.
		expect(c.details.shadowPathWidthKm!).toBeGreaterThan(0)
	})

	test('annular location resolves all five contacts with a sub-unity diameter ratio', () => {
		const c = local(annular2023.eclipse, annular2023.pbe, -123, 43) // Oregon: on the 2023 annular path.
		for (const kind of ['C1', 'C2', 'MAX', 'C3', 'C4'] as const) expectContactKind(c.events[kind], kind)
		expect(c.events.MAX!.centralPhaseKind).toBe('annular')
		// For an annular eclipse the Moon is smaller than the Sun, so the diameter ratio stays below one and
		// the diameter-ratio magnitude never reaches one.
		expect(c.events.MAX!.moonSunDiameterRatio!).toBeLessThan(1)
		expect(c.events.MAX!.moonSunDiameterRatio!).toBeGreaterThan(0)
		expect(c.visibility.centralPhaseKind).toBe('annular')
		expect(c.details.centralPhaseDurationSeconds!).toBeGreaterThan(0)
	})

	test('an eclipse whose maximum is below the horizon stays geometric but not observable', () => {
		const c = local(total2024.eclipse, total2024.pbe, -0.13, 51.5) // London: a small partial at/after sunset.
		expect(c.events.MAX).not.toBeNull()
		expect(c.events.MAX!.sunAltitude).toBeLessThan(0)
		expect(c.events.MAX!.observable).toBe(false)
		expect(c.events.MAX!.visibility).toBe('belowHorizon')
		expect(c.visibility.kind).toBe('geometricOnlyBelowHorizon')
		expect(c.visibility.hasGeometricEclipse).toBe(true)
		expect(c.visibility.hasObservableEclipse).toBe(false)
	})

	test('detects an observable culmination sliver between below-horizon contacts', () => {
		// Mazatlan's eclipse straddles local noon: every contact is below ~73.5 deg, but the Sun climbs to a
		// ~74.35 deg culmination BETWEEN C3 and C4. With a raised horizon between those values the eclipse is
		// still observable at culmination even though every contact is below the (raised) horizon -- a case the
		// event-only check would miss. A higher horizon than the culmination leaves nothing observable.
		const justBelowCulmination = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { horizonAltitude: deg(73.8) })
		for (const kind of ['C1', 'C2', 'MAX', 'C3', 'C4'] as const) expect(justBelowCulmination.events[kind]!.observable).toBe(false)
		expect(justBelowCulmination.visibility.hasObservableEclipse).toBe(true)
		expect(justBelowCulmination.visibility.kind).not.toBe('geometricOnlyBelowHorizon')

		const aboveCulmination = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { horizonAltitude: deg(75) })
		expect(aboveCulmination.visibility.hasObservableEclipse).toBe(false)
		expect(aboveCulmination.visibility.kind).toBe('geometricOnlyBelowHorizon')
	}, 8000)

	test('the continuous valley check never downgrades a daytime fully-visible eclipse', () => {
		// Mazatlan's eclipse is a daytime hump (no lower-culmination valley), so the interior-minimum check must
		// not run / must not spuriously break completelyVisible. Raising the horizon to just below the lowest
		// contact keeps every contact above it, so the eclipse stays completely visible.
		const c1Altitude = local(total2024.eclipse, total2024.pbe, -106.4, 23.25).events.C1!.sunAltitude
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { horizonAltitude: c1Altitude - deg(1) })
		expect(c.visibility.kind).toBe('completelyVisible')
		expect(c.visibility.hasObservableEclipse).toBe(true)
	})

	test('reports the Sun vertical trend across the eclipse', () => {
		// New York saw the 2024 eclipse in the afternoon (Sun descending) -> setting.
		const afternoon = local(total2024.eclipse, total2024.pbe, -74, 40.71)
		expect(afternoon.visibility.sunMotion).toBe('setting')
		expect(afternoon.events.C4!.sunAltitude).toBeLessThan(afternoon.events.C1!.sunAltitude)
		// Honolulu saw it in the morning (Sun ascending) -> rising.
		const morning = local(total2024.eclipse, total2024.pbe, -157.86, 21.3)
		expect(morning.visibility.sunMotion).toBe('rising')
		expect(morning.events.C4!.sunAltitude).toBeGreaterThan(morning.events.C1!.sunAltitude)
		// No eclipse -> no defined motion.
		const none = local(total2024.eclipse, total2024.pbe, 115, -32)
		expect(none.visibility.sunMotion).toBe('none')
	})

	test('a fully visible total eclipse reports complete contacts', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
		expect(c.visibility.kind).toBe('completelyVisible')
		expect(c.visibility.completeness.partialContactsComplete).toBe(true)
		expect(c.visibility.completeness.centralContactsComplete).toBe(true)
	})

	test('event observability honors a configured horizon altitude', () => {
		// Raising the horizon just above the maximum's altitude makes the maximum unobservable, even though it
		// is geometrically far above the true (zero) horizon.
		const base = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
		const raisedHorizon = base.events.MAX!.sunAltitude + deg(0.1)
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { horizonAltitude: raisedHorizon })
		expect(c.events.MAX!.observable).toBe(false)
		expect(c.events.MAX!.visibility).toBe('belowHorizon')
	})

	test('a partial-only eclipse has no central shadow-path width', () => {
		const c = local(total2024.eclipse, total2024.pbe, -74, 40.71) // New York: partial only.
		expect(c.events.MAX).not.toBeNull()
		expect(c.events.MAX!.centralPhaseKind).toBe('none')
		expect(c.details.shadowPathWidthKm).toBeNull()
	})

	describe('recovers C2/C3 for any search step, even far coarser than the central phase', () => {
		// The 2024 totality at Mazatlan lasts ~259 s. For a search step much larger than that, the whole
		// central phase sits between two positive samples with no sign change, and the magnitude peak is much
		// narrower than the step. Both the maximum search and the contact search must stay robust regardless of
		// localSearchStepSeconds, so every step recovers the same central contacts and duration.
		const fine = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { localSearchStepSeconds: 30 })
		for (const localSearchStepSeconds of [400, 700, 900, 1300, 1800, 3000]) {
			test(localSearchStepSeconds.toFixed(0), () => {
				const coarse = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { localSearchStepSeconds })
				expect(coarse.events.C2).not.toBeNull()
				expect(coarse.events.C3).not.toBeNull()
				expect(coarse.events.C3!.jd).toBeGreaterThan(coarse.events.C2!.jd)
				expect(coarse.events.MAX!.centralPhaseKind).toBe('total')
				// The coarse-step central duration matches the fine-step one to within a second.
				expect(coarse.details.centralPhaseDurationSeconds!).toBeCloseTo(fine.details.centralPhaseDurationSeconds!, 0)
			})
		}
	})

	describe('recovers contacts even when the search window starts entirely inside the phase', () => {
		// The 2024 partial at Mazatlan lasts ~9641 s (half ~4820 s). A small contactSearchSpan puts the whole
		// initial window inside the partial phase, where the contact function never changes sign (no roots), so
		// the window must keep expanding instead of stopping early. Every span recovers the same contacts.
		const reference = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
		for (const contactSearchSpan of [3600, 1800, 600]) {
			test(contactSearchSpan.toFixed(0), () => {
				const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { contactSearchSpan })
				expect(c.events.C1).not.toBeNull()
				expect(c.events.C4).not.toBeNull()
				expect(c.events.C2).not.toBeNull()
				expect(c.events.C3).not.toBeNull()
				expect(c.details.partialPhaseDurationSeconds!).toBeCloseTo(reference.details.partialPhaseDurationSeconds!, 0)
				expect(c.details.centralPhaseDurationSeconds!).toBeCloseTo(reference.details.centralPhaseDurationSeconds!, 0)
			})
		}
	})

	describe('recovers contacts when the local maximum lies far outside the initial search window', () => {
		// Honolulu's 2024 local maximum is ~65 min before the global maximum (the eclipse is seen in the
		// morning, far from the central path). With a small contactSearchSpan the initial window around the
		// global maximum is entirely outside the phase, so the contact search must seed its window from the
		// (adaptively found) local maximum rather than from the small initial span.
		const reference = local(total2024.eclipse, total2024.pbe, -157.86, 21.3)
		for (const contactSearchSpan of [1800, 600]) {
			test(contactSearchSpan.toFixed(0), () => {
				const c = local(total2024.eclipse, total2024.pbe, -157.86, 21.3, { contactSearchSpan })
				expect(c.events.C1).not.toBeNull()
				expect(c.events.C4).not.toBeNull()
				expect(c.events.C1!.jd).toBeLessThan(c.events.MAX!.jd)
				expect(c.events.C4!.jd).toBeGreaterThan(c.events.MAX!.jd)
				expect(c.details.partialPhaseDurationSeconds!).toBeCloseTo(reference.details.partialPhaseDurationSeconds!, 0)
			})
		}
	})

	test('observability of every event matches its solar altitude against the horizon', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
		for (const kind of ['C1', 'C2', 'MAX', 'C3', 'C4'] as const) {
			const event = c.events[kind]!
			expect(event.observable).toBe(event.sunAltitude >= 0)
			expect(event.positionAngleP!).toBeGreaterThanOrEqual(0)
			expect(event.positionAngleP!).toBeLessThan(TAU)
			expect(event.zenithAngleZ!).toBeGreaterThanOrEqual(0)
			expect(event.zenithAngleZ!).toBeLessThan(TAU)
		}
	})
})

describe('local view geometry', () => {
	const base = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)

	test('emits only geometric shapes (no labels, no buttons) with Sun and Moon disks', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { includeLocalView: true })
		const view = c.localView!
		expect(view.shapes.length).toBeGreaterThan(0)
		// Every shape is a known geometric primitive; there is no text/label/button kind.
		const allowedKinds = new Set(['circle', 'line', 'path', 'polygon'])
		for (const shape of view.shapes) expect(allowedKinds.has(shape.kind)).toBe(true)
		// Contains the Sun and the Moon disks.
		const roles = view.shapes.map((s) => s.role)
		expect(roles).toContain('sunDisk')
		expect(roles).toContain('moonDisk')
		// Ghost MOON disks for the other contacts are present (the Sun is fixed at center, so it is never ghosted), again without any label.
		expect(roles).toContain('ghostMoonDisk')
		expect(roles).not.toContain('ghostSunDisk')
		// Exactly one Sun disk is drawn.
		expect(roles.filter((r) => r === 'sunDisk')).toHaveLength(1)
	})

	test('includes horizon geometry only when requested', () => {
		const withHorizon = buildLocalSolarEclipseViewGeometry(base, viewOptions({ includeHorizon: true }))
		const withoutHorizon = buildLocalSolarEclipseViewGeometry(base, viewOptions({ includeHorizon: false }))
		expect(withHorizon.shapes.some((s) => s.role === 'horizonLine')).toBe(true)
		expect(withoutHorizon.shapes.some((s) => s.role === 'horizonLine')).toBe(false)
	})

	test('orientation mode selects the zenith angle Z or the position angle P', () => {
		const zenith = buildLocalSolarEclipseViewGeometry(base, viewOptions({ orientationMode: 'zenith', includeGhostDisks: false, includeHorizon: false }))
		const north = buildLocalSolarEclipseViewGeometry(base, viewOptions({ orientationMode: 'north', includeGhostDisks: false, includeHorizon: false }))
		const zenithMoon = zenith.shapes.find((s) => s.role === 'moonDisk')!
		const northMoon = north.shapes.find((s) => s.role === 'moonDisk')!
		expect(zenithMoon.kind).toBe('circle')
		expect(northMoon.kind).toBe('circle')
		// P and Z differ at this event, so the Moon disk lands at different pixels in each frame.
		const moved = zenithMoon.kind === 'circle' && northMoon.kind === 'circle' && (Math.abs(zenithMoon.cx - northMoon.cx) > 1e-6 || Math.abs(zenithMoon.cy - northMoon.cy) > 1e-6)
		expect(moved).toBe(true)
		// No button geometry is ever generated; only the four primitive kinds appear.
		for (const view of [zenith, north]) for (const shape of view.shapes) expect(['circle', 'line', 'path', 'polygon']).toContain(shape.kind)
	})

	test('projects ghost disks in the primary event frame in zenith mode', () => {
		// New York sees a partial: ghosts are C1 and C4 with MAX as primary. The parallactic angle drifts over
		// the eclipse, so a ghost must use the PRIMARY (MAX) zenith, not its own instantaneous vertical.
		const c = local(total2024.eclipse, total2024.pbe, -74, 40.71, { includeLocalView: true, localView: { selectedEvent: 'MAX', orientationMode: 'zenith', includeHorizon: false } })
		const view = c.localView!
		const c1 = c.events.C1!
		const max = c.events.MAX!
		// The choice of frame is observable only because q differs between C1 and MAX.
		expect(Math.abs(c1.localViewState!.parallacticAngle! - max.localViewState!.parallacticAngle!)).toBeGreaterThan(0.05)

		const sunCx = view.width / 2
		const sunCy = view.height / 2
		const sep = c1.localViewState!.separationSolarRadii * view.solarRadiusPx
		const firstGhost = view.shapes.find((s): s is Extract<(typeof view.shapes)[number], { kind: 'circle' }> => s.role === 'ghostMoonDisk')!

		// C1 ghost drawn in the MAX zenith frame: angle = centerP(C1) - q(MAX).
		const primaryFrameAngle = normalizeAngle(c1.localViewState!.centerPositionAngleP! - max.localViewState!.parallacticAngle!)
		expect(firstGhost.cx).toBeCloseTo(sunCx + sep * Math.sin(primaryFrameAngle), 6)
		expect(firstGhost.cy).toBeCloseTo(sunCy - sep * Math.cos(primaryFrameAngle), 6)
		// It is NOT the C1 own-frame position (centerZenithAngleZ = centerP(C1) - q(C1)).
		const ownFrameAngle = c1.localViewState!.centerZenithAngleZ!
		expect(Math.abs(firstGhost.cx - (sunCx + sep * Math.sin(ownFrameAngle)))).toBeGreaterThan(1)
	})

	test('reports the actually-drawn event, falling back when the requested one is absent', () => {
		// A partial-only location has no C2; the builder falls back to MAX and reports it honestly.
		const partial = local(total2024.eclipse, total2024.pbe, -74, 40.71)
		const view = buildLocalSolarEclipseViewGeometry(partial, viewOptions({ selectedEvent: 'C2' }))
		expect(view.requestedEvent).toBe('C2')
		expect(view.selectedEvent).toBe('MAX')
	})

	test('tags every disk with its contact so the UI can label them', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25, { includeLocalView: true, localView: { selectedEvent: 'MAX' } })
		const shapes = c.localView!.shapes
		const circles = shapes.filter((s): s is Extract<(typeof shapes)[number], { kind: 'circle' }> => s.kind === 'circle')
		// Primary Sun and Moon are tagged with the selected event.
		const sun = circles.find((s) => s.role === 'sunDisk')!
		const moon = circles.find((s) => s.role === 'moonDisk')!
		expect(sun.event).toBe('MAX')
		expect(moon.event).toBe('MAX')
		// Each ghost Moon carries its own contact (so it can be labelled C1/C2/C3/C4 like Astrarium): a total
		// eclipse at Mazatlan has all five contacts, so the ghosts are every contact except the primary MAX.
		const ghostEvents = circles.filter((s) => s.role === 'ghostMoonDisk').map((s) => s.event)
		expect(ghostEvents).toEqual(['C1', 'C2', 'C3', 'C4'])
	})

	test('draws the horizon as foreground over the primary disks', () => {
		const view = buildLocalSolarEclipseViewGeometry(base, viewOptions())
		const roles = view.shapes.map((s) => s.role)
		// The ground band and horizon line are painted after the Sun/Moon disks so they can occlude them.
		expect(roles.indexOf('horizonBand')).toBeGreaterThan(roles.indexOf('moonDisk'))
		expect(roles.indexOf('horizonBand')).toBeGreaterThan(roles.indexOf('sunDisk'))
		// The line is drawn on top of its own band.
		expect(roles.indexOf('horizonLine')).toBeGreaterThan(roles.indexOf('horizonBand'))
	})

	test('handedness mirrors only the horizontal axis', () => {
		const right = buildLocalSolarEclipseViewGeometry(base, viewOptions({ handedness: 'eastRight', includeGhostDisks: false, includeHorizon: false }))
		const left = buildLocalSolarEclipseViewGeometry(base, viewOptions({ handedness: 'eastLeft', includeGhostDisks: false, includeHorizon: false }))
		const rightMoon = right.shapes.find((s) => s.role === 'moonDisk') as Extract<(typeof right.shapes)[number], { kind: 'circle' }>
		const leftMoon = left.shapes.find((s) => s.role === 'moonDisk') as Extract<(typeof left.shapes)[number], { kind: 'circle' }>
		const sunCx = 450 / 2
		// The Moon's horizontal offset from the Sun flips sign; its vertical offset is unchanged.
		expect(leftMoon.cx - sunCx).toBeCloseTo(-(rightMoon.cx - sunCx), 9)
		expect(leftMoon.cy).toBeCloseTo(rightMoon.cy, 9)
	})

	test('a location with no eclipse produces an empty Local View', () => {
		const c = local(total2024.eclipse, total2024.pbe, 115, -32) // Perth: no eclipse.
		const view = buildLocalSolarEclipseViewGeometry(c, viewOptions())
		expect(view.selectedEvent).toBeNull()
		expect(view.shapes).toHaveLength(0)
	})
})

describe('local view topocentric invariants', () => {
	const total = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
	const annular = local(annular2023.eclipse, annular2023.pbe, -123, 43)

	describe('separations match the tangency geometry at every contact', () => {
		for (const c of [total, annular]) {
			test(c.visibility.centralPhaseKind, () => {
				// External tangency at C1/C4: centers separated by the sum of the radii (1 + ratio solar radii).
				for (const k of ['C1', 'C4'] as const) {
					const e = c.events[k]!
					expect(e.localViewState!.separationSolarRadii).toBeCloseTo(1 + e.moonSunDiameterRatio!, 3)
				}
				// Internal tangency at C2/C3: centers separated by the difference of the radii.
				for (const k of ['C2', 'C3'] as const) {
					const e = c.events[k]!
					expect(e.localViewState!.separationSolarRadii).toBeCloseTo(Math.abs(1 - e.moonSunDiameterRatio!), 3)
				}
				// The maximum is the closest approach: its separation is the smallest of all contacts.
				const maxSep = c.events.MAX!.localViewState!.separationSolarRadii
				for (const k of ['C1', 'C2', 'C3', 'C4'] as const) expect(maxSep).toBeLessThanOrEqual(c.events[k]!.localViewState!.separationSolarRadii + 1e-9)
			})
		}
	})

	test('the limb-contact angle is opposite the center only at a total internal tangency', () => {
		const wrap = (a: number) => ((a % TAU) + TAU) % TAU
		// Total C2/C3: the last solar sliver is on the far limb, so contact = center + PI.
		for (const k of ['C2', 'C3'] as const) {
			const e = total.events[k]!
			expect(wrap(e.positionAngleP! - e.localViewState!.centerPositionAngleP!)).toBeCloseTo(PI, 6)
		}
		// Annular C2/C3 and all C1/MAX/C4: contact coincides with the lunar center.
		for (const k of ['C2', 'C3'] as const) {
			const e = annular.events[k]!
			expect(wrap(e.positionAngleP! - e.localViewState!.centerPositionAngleP!)).toBeCloseTo(0, 6)
		}
		for (const k of ['C1', 'MAX', 'C4'] as const) {
			const e = total.events[k]!
			expect(wrap(e.positionAngleP! - e.localViewState!.centerPositionAngleP!)).toBeCloseTo(0, 6)
		}
	})
})

describe('local view horizon geometry', () => {
	const solarRadiusPx = 34
	const solarAngularRadius = deg(0.26)
	const height = 160
	const sunCy = height / 2

	// Minimal renderable event with a hand-set altitude/parallactic angle for horizon geometry checks.
	function horizonEvent(sunAltitude: number, parallacticAngle: number): LocalSolarEclipseEvent {
		return {
			kind: 'MAX',
			description: '',
			time: total2024.eclipse.maximalTime,
			jd: 0,
			sunAltitude,
			positionAngleP: 0,
			zenithAngleZ: 0,
			visibility: 'aboveHorizon',
			observable: true,
			magnitude: 1,
			moonSunDiameterRatio: 1,
			centralPhaseKind: 'total',
			localViewState: { separationSolarRadii: 0, centerPositionAngleP: 0, centerZenithAngleZ: 0, parallacticAngle, sunAltitude, solarAngularRadius },
		}
	}

	// Horizon line of a zenith-frame view at a given solar altitude.
	function zenithHorizonLine(sunAltitude: number) {
		const shapes = buildLocalViewHorizonGeometry(horizonEvent(sunAltitude, 0), viewOptions({ solarRadiusPx, height, orientationMode: 'zenith' }))
		return shapes.find((s) => s.role === 'horizonLine') as Extract<(typeof shapes)[number], { kind: 'line' }>
	}

	test('zenith horizon is horizontal and tracks the solar altitude', () => {
		// Altitude 0: the horizon passes through the Sun center.
		const atZero = zenithHorizonLine(0)
		expect(atZero.y1).toBeCloseTo(atZero.y2, 9)
		expect(atZero.y1).toBeCloseTo(sunCy, 9)
		// Altitude = one solar angular radius: the horizon drops by one solar pixel radius below the center.
		const atOne = zenithHorizonLine(solarAngularRadius)
		expect(atOne.y1).toBeCloseTo(sunCy + solarRadiusPx, 6)
		// Altitude = minus one solar angular radius: the horizon rises one solar pixel radius above the center.
		const atMinusOne = zenithHorizonLine(-solarAngularRadius)
		expect(atMinusOne.y1).toBeCloseTo(sunCy - solarRadiusPx, 6)
	})

	test('north horizon rotates with the parallactic angle', () => {
		// q = 0: the north frame reduces to the zenith frame, so the horizon is horizontal.
		const flat = buildLocalViewHorizonGeometry(horizonEvent(0, 0), viewOptions({ solarRadiusPx, height, orientationMode: 'north' }))
		const flatLine = flat.find((s) => s.role === 'horizonLine') as Extract<(typeof flat)[number], { kind: 'line' }>
		expect(flatLine.y1).toBeCloseTo(flatLine.y2, 9)
		// q = PI/2: the zenith points sideways, so the horizon is vertical.
		const vertical = buildLocalViewHorizonGeometry(horizonEvent(0, PI / 2), viewOptions({ solarRadiusPx, height, orientationMode: 'north' }))
		const verticalLine = vertical.find((s) => s.role === 'horizonLine') as Extract<(typeof vertical)[number], { kind: 'line' }>
		expect(verticalLine.x1).toBeCloseTo(verticalLine.x2, 9)
	})

	test('the ground band covers the whole viewport when the Sun is well below the horizon', () => {
		const shapes = buildLocalViewHorizonGeometry(horizonEvent(deg(-10), 0), viewOptions({ solarRadiusPx, height, orientationMode: 'zenith' }))
		const band = shapes.find((s): s is Extract<(typeof shapes)[number], { kind: 'polygon' }> => s.kind === 'polygon')!
		const ys = band.points.map((p) => p.y)
		// The band spans past both edges of the viewport, so nothing below the horizon is left uncovered.
		expect(Math.min(...ys)).toBeLessThanOrEqual(0)
		expect(Math.max(...ys)).toBeGreaterThanOrEqual(height)
	})

	test('the ground band meets the horizon line with no padding gap', () => {
		const padding = 4
		const shapes = buildLocalViewHorizonGeometry(horizonEvent(0, 0), viewOptions({ solarRadiusPx, height, orientationMode: 'zenith', horizonBandPaddingPx: padding }))
		const line = shapes.find((s) => s.role === 'horizonLine') as Extract<(typeof shapes)[number], { kind: 'line' }>
		const band = shapes.find((s): s is Extract<(typeof shapes)[number], { kind: 'polygon' }> => s.kind === 'polygon')!
		// The band starts the padding ABOVE the line (toward the zenith), not below it, so there is no gap.
		expect(Math.min(...band.points.map((p) => p.y))).toBeCloseTo(line.y1 - padding, 6)
	})

	test('handedness mirrors the tilted north horizon horizontally', () => {
		const width = 450
		const slope = (line: { x1: number; y1: number; x2: number; y2: number }) => (line.y2 - line.y1) / (line.x2 - line.x1)
		const lineFor = (handedness: 'eastRight' | 'eastLeft') => {
			const shapes = buildLocalViewHorizonGeometry(horizonEvent(0, PI / 4), viewOptions({ width, solarRadiusPx, height, orientationMode: 'north', handedness }))
			return shapes.find((s) => s.role === 'horizonLine') as Extract<(typeof shapes)[number], { kind: 'line' }>
		}
		const right = lineFor('eastRight')
		const left = lineFor('eastLeft')
		// At q = PI/4 the horizon is tilted; mirroring east-left negates the slope (horizontal reflection).
		expect(Math.abs(slope(right))).toBeGreaterThan(0.1)
		expect(slope(left)).toBeCloseTo(-slope(right), 9)
		// Both still pass through the diagram center horizontally (altitude 0).
		expect((right.x1 + right.x2) / 2).toBeCloseTo(width / 2, 6)
		expect((left.x1 + left.x2) / 2).toBeCloseTo(width / 2, 6)
	})

	test('north horizon offset follows the rotated zenith normal for a non-zero altitude', () => {
		const width = 450
		const q = PI / 4
		// Altitude of exactly one solar angular radius should push the horizon one solar pixel radius away from
		// the zenith, measured along the rotated zenith normal (not just vertically as in the zenith frame).
		const shapes = buildLocalViewHorizonGeometry(horizonEvent(solarAngularRadius, q), viewOptions({ width, height, solarRadiusPx, orientationMode: 'north' }))
		const line = shapes.find((s) => s.role === 'horizonLine') as Extract<(typeof shapes)[number], { kind: 'line' }>
		const sunCx = width / 2
		const sunCy = height / 2
		const midX = (line.x1 + line.x2) / 2
		const midY = (line.y1 + line.y2) / 2
		// Project the line midpoint's displacement from the Sun onto the away-from-zenith direction (-zenith).
		const awayDotDisplacement = (midX - sunCx) * -Math.sin(q) + (midY - sunCy) * Math.cos(q)
		expect(awayDotDisplacement).toBeCloseTo(solarRadiusPx, 6)
	})
})

describe('local view robustness', () => {
	test('the central-shadow width is defined on the central line', () => {
		// A point essentially on the 2024 central line: the separation is tiny but the width is still resolved
		// (the multi-bearing chord is defined even where the gradient direction would vanish).
		const c = local(total2024.eclipse, total2024.pbe, -104.13, 25.28)
		expect(c.events.MAX!.centralPhaseKind).toBe('total')
		expect(c.events.MAX!.localViewState!.separationSolarRadii).toBeLessThan(0.05)
		expect(c.details.shadowPathWidthKm).not.toBeNull()
		expect(c.details.shadowPathWidthKm!).toBeGreaterThan(0)
	})

	test('contact search samples toJd exactly even when the step does not divide the window', () => {
		// A monotone synthetic contact function with its single root in the final partial sub-interval: the
		// step (0.03 d) does not divide the 0.1 d window, so without a guaranteed toJd sample the root past the
		// last interior sample (at 0.09 d) would be missed.
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		const toJd = fromJd + 0.1
		const target = toJd - 0.005
		const roots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, 0.03, (state: LocalFundamentalState) => state.jd - target)
		expect(roots).toHaveLength(1)
		expect(roots[0]).toBeCloseTo(target, 6)
	})

	test('contact search recovers a short phase wholly inside the first or last window interval', () => {
		const DAYSEC = 86400
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		const stepDays = 1200 / DAYSEC
		const toJd = fromJd + 3 * stepDays
		const halfWidth = 0.05 * stepDays
		// A V-shaped contact function (fn <= 0 inside the phase) with amplitude 0.01 so the minimum (-0.01) is a
		// genuine finite interval, not a grazing tangency. The interior-minimum pass needs a triple, so a dip
		// wholly inside a boundary interval (both endpoints positive) is only caught by the explicit edge refine.
		const vShaped = (center: number) => (state: LocalFundamentalState) => 0.01 * (((state.jd - center) / halfWidth) ** 2 - 1)

		// Dip inside the FIRST interval [fromJd, fromJd + stepDays].
		const firstCenter = fromJd + 0.25 * stepDays
		const firstRoots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, stepDays, vShaped(firstCenter))
		expect(firstRoots).toHaveLength(2)
		expect(firstRoots[0]).toBeCloseTo(firstCenter - halfWidth, 8)
		expect(firstRoots[1]).toBeCloseTo(firstCenter + halfWidth, 8)

		// Dip inside the LAST interval [toJd - stepDays, toJd].
		const lastCenter = toJd - 0.25 * stepDays
		const lastRoots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, stepDays, vShaped(lastCenter))
		expect(lastRoots).toHaveLength(2)
		expect(lastRoots[0]).toBeCloseTo(lastCenter - halfWidth, 8)
		expect(lastRoots[1]).toBeCloseTo(lastCenter + halfWidth, 8)
	})

	test('does not plant a phantom contact when the only root is just outside the window', () => {
		// A monotone contact function whose single zero lies just past toJd: inside the window it stays
		// positive (no eclipse), but its value at toJd is within CONTACT_FUNCTION_TOLERANCE. The boundary refine
		// must not accept that endpoint-pinned near-zero as a grazing root.
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		const toJd = fromJd + 0.1
		const root = toJd + 0.25e-8 // ~0.25 * CONTACT_TOLERANCE_DAYS past the window
		const roots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, 0.03, (state: LocalFundamentalState) => root - state.jd)
		expect(roots).toHaveLength(0)
	})

	test('falls back to the mean solar angular radius for a non-finite Sun distance', () => {
		// A degraded ephemeris reporting an infinite Sun distance must not yield a zero angular radius.
		const infiniteSunDistance: typeof sunMoonPosition = (t) => {
			const position = sunMoonPosition(t)
			position.sun.distance = Infinity
			return position
		}

		const c = computeLocalSolarEclipseCircumstances(total2024.pbe, deg(-106.4), deg(23.25), { sunMoonPosition: infiniteSunDistance })
		expect(c.events.MAX!.localViewState!.solarAngularRadius).toBeCloseTo(959.63 * ASEC2RAD, 9)
	})

	test('contact search finds a root that lands exactly on an interior sample', () => {
		// A root coinciding with a sampled instant must still be captured (it has a neighbor on each side, so it
		// is not the endpoint-grazing case the phantom guard rejects).
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		const stepDays = 0.03
		const toJd = fromJd + 3 * stepDays
		for (const target of [fromJd + stepDays, fromJd + 2 * stepDays]) {
			const roots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, stepDays, (state: LocalFundamentalState) => state.jd - target)
			expect(roots.some((r) => Math.abs(r - target) < 1e-8)).toBe(true)
		}
	})

	test('contact search returns an array without hanging for an invalid step', () => {
		// findLocalContactRoots is exported; a caller passing a degenerate stepDays must not loop forever.
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		const toJd = fromJd + 0.1
		for (const stepDays of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
			const roots = findLocalContactRoots(total2024.pbe, deg(-74), deg(40.71), fromJd, toJd, stepDays, (state: LocalFundamentalState) => state.jd - (fromJd + 0.05))
			expect(Array.isArray(roots)).toBe(true)
		}
	})

	test('maximum search is robust to degenerate inputs and resolves a normal maximum', () => {
		const fromJd = toJulianDay(total2024.pbe.maximumTime)
		// Inverted interval -> no samples -> undefined.
		expect(findLocalMaximumTime(total2024.pbe, deg(-106.4), deg(23.25), fromJd + 0.1, fromJd, 0.001)).toBeUndefined()
		// Degenerate steps must not hang; they fall back to the endpoint samples and return a finite instant.
		for (const stepDays of [0, Number.NaN]) {
			const jd = findLocalMaximumTime(total2024.pbe, deg(-106.4), deg(23.25), fromJd - 0.1, fromJd + 0.1, stepDays)
			expect(jd === undefined || Number.isFinite(jd)).toBe(true)
		}
		// A normal search resolves the local magnitude maximum inside the window.
		const max = findLocalMaximumTime(total2024.pbe, deg(-106.4), deg(23.25), fromJd - 0.15, fromJd + 0.15, 0.001)
		expect(max).toBeDefined()
		expect(max!).toBeGreaterThan(fromJd - 0.15)
		expect(max!).toBeLessThan(fromJd + 0.15)
	})
})

describe('greatest eclipse and greatest duration circumstances', () => {
	const eclipse = nearestSolarEclipse(timeYMD(1995, 4, 29), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	const ge = computeGreatestEclipseCircumstances(pbe)!
	const gd = computeGreatestDurationCircumstances(pbe)!

	// Seconds elapsed since midnight of the time's own scale, for comparing against the published clock times.
	function secondsOfDay(t: Time) {
		const [, , , hour, minute, second] = timeToDate(t)
		return hour * 3600 + minute * 60 + second
	}

	// Reference values from NASA/GSFC for the 1995-04-29 annular eclipse ("Greatest Eclipse and Greatest
	// Duration" table). The library fits approximate Besselian elements from VSOP87E/ELPMPP02 rather than the
	// DE ephemeris, so the tolerances absorb that element-accuracy gap (largest on the small annular antumbra
	// width) while still pinning every quantity to its physical value.
	test('1995-04-29 greatest eclipse matches the published circumstances', () => {
		expect(eclipse.type).toBe('annular')
		expect(ge.kind).toBe('annular')

		// TD 17:33:20.5, UT1 17:32:19.5.
		expect(Math.abs(secondsOfDay(ge.time) - (17 * 3600 + 33 * 60 + 20.5))).toBeLessThan(30)
		// TD - UT1 reproduces the applied Delta T, which matches the published 61 s for 1995.
		expect(ge.deltaT).toBeCloseTo(61, 0)

		// Latitude 04°51.0'S, Longitude 079°23.8'W.
		expect(Math.abs(ge.latitude * RAD2DEG - -(4 + 51 / 60))).toBeLessThan(0.1)
		expect(Math.abs(ge.longitude * RAD2DEG - -(79 + 23.8 / 60))).toBeLessThan(0.1)
		// Sun altitude 70.2°, azimuth 347.5°.
		expect(Math.abs(ge.sunAltitude * RAD2DEG - 70.2)).toBeLessThan(0.5)
		expect(Math.abs(ge.sunAzimuth * RAD2DEG - 347.5)).toBeLessThan(1)
		// Path width 195.5 km, central (annular) duration 06m36.74s = 396.74 s.
		expect(ge.pathWidthKm!).toBeGreaterThan(175)
		expect(ge.pathWidthKm!).toBeLessThan(205)
		expect(Math.abs(ge.centralDurationSeconds! - 396.74)).toBeLessThan(8)
	})

	test('1995-04-29 greatest duration matches the published circumstances', () => {
		expect(gd.kind).toBe('annular')

		// TD 17:43:41.0, UT1 17:42:40.0.
		expect(Math.abs(secondsOfDay(gd.time) - (17 * 3600 + 43 * 60 + 41))).toBeLessThan(30)

		// Latitude 03°48.4'S, Longitude 077°00.9'W.
		expect(Math.abs(gd.latitude * RAD2DEG - -(3 + 48.4 / 60))).toBeLessThan(0.1)
		expect(Math.abs(gd.longitude * RAD2DEG - -(77 + 0.9 / 60))).toBeLessThan(0.1)
		// Sun altitude 69.5°, azimuth 333.4°.
		expect(Math.abs(gd.sunAltitude * RAD2DEG - 69.5)).toBeLessThan(0.5)
		expect(Math.abs(gd.sunAzimuth * RAD2DEG - 333.4)).toBeLessThan(1)
		// Path width 197.2 km, central (annular) duration 06m37.07s = 397.07 s.
		expect(gd.pathWidthKm!).toBeGreaterThan(175)
		expect(gd.pathWidthKm!).toBeLessThan(207)
		expect(Math.abs(gd.centralDurationSeconds! - 397.07)).toBeLessThan(8)
	})

	test('greatest duration lasts at least as long as greatest eclipse and is a distinct, later point', () => {
		// By definition the greatest-duration point maximizes the central phase, so it is not shorter than the
		// duration at greatest eclipse, and for this eclipse it lies further along the path and later in time.
		expect(gd.centralDurationSeconds!).toBeGreaterThanOrEqual(ge.centralDurationSeconds! - 1e-6)
		expect(secondsOfDay(gd.time)).toBeGreaterThan(secondsOfDay(ge.time))
		expect(sphericalSeparation(ge.longitude, ge.latitude, gd.longitude, gd.latitude)).toBeGreaterThan(deg(1))
	})

	test('greatest duration search span is interpreted in seconds', () => {
		const constrained = computeGreatestDurationCircumstances(pbe, { contactSearchSpan: 60 })!

		expect(Math.abs(secondsOfDay(constrained.time) - secondsOfDay(ge.time))).toBeLessThan(90)
		expect(secondsOfDay(gd.time) - secondsOfDay(constrained.time)).toBeGreaterThan(300)
	})

	test('a partial eclipse has no central line, so greatest duration is undefined', () => {
		const partialPbe = partial2025.pbe
		expect(computeGreatestDurationCircumstances(partialPbe)).toBeUndefined()
		// Greatest eclipse still resolves a point for a partial eclipse, but without central path/duration.
		const partialGe = computeGreatestEclipseCircumstances(partialPbe)!
		expect(partialGe).toBeDefined()
		expect(partialGe.centralDurationSeconds).toBeNull()
		expect(partialGe.pathWidthKm).toBeNull()
		expect(partialGe.kind).toBeNull()
	})
})
