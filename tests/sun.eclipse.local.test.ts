import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, TAU } from '../src/constants'
import { nearestSolarEclipse, type SolarEclipse } from '../src/sun'
import { computePolynomialBesselianElements, computeSunMoonPositionAt, type PolynomialBesselianElements } from '../src/sun.eclipse'
import { buildLocalSolarEclipseViewGeometry, buildLocalViewHorizonGeometry, computeLocalSolarEclipseCircumstances, type LocalSolarEclipseEvent, type LocalSolarEclipseViewOptions } from '../src/sun.eclipse.local'
import { timeYMD } from '../src/time'
import * as elpmpp02 from '../src/elpmpp02'
import * as vsop87e from '../src/vsop87e'

// Same physical Sun/Moon source used to build the elements, as the local layer prefers.
function sunMoonPosition(t: Parameters<typeof computeSunMoonPositionAt>[0]) {
	return computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
}

function viewOptions(overrides: Partial<LocalSolarEclipseViewOptions> = {}): LocalSolarEclipseViewOptions {
	return { width: 450, height: 160, selectedEvent: 'MAX', orientationMode: 'zenith', solarRadiusPx: 34, includeGhostDisks: true, includeHorizon: true, horizonBandPaddingPx: 4, ...overrides }
}

// The 2024-04-08 total eclipse, with elements and a consistent Sun/Moon source.
const total2024 = (() => {
	const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 1), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	return { eclipse, pbe }
})()

// The 2023-10-14 annular eclipse.
const annular2023 = (() => {
	const eclipse = nearestSolarEclipse(timeYMD(2023, 10, 1), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	return { eclipse, pbe }
})()

function local(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, lon: number, lat: number, options = {}) {
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

	test('a fully visible total eclipse reports complete contacts', () => {
		const c = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
		expect(c.visibility.kind).toBe('completelyVisible')
		expect(c.visibility.completeness.partialContactsComplete).toBe(true)
		expect(c.visibility.completeness.centralContactsComplete).toBe(true)
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

	test('reports the actually-drawn event, falling back when the requested one is absent', () => {
		// A partial-only location has no C2; the builder falls back to MAX and reports it honestly.
		const partial = local(total2024.eclipse, total2024.pbe, -74, 40.71)
		const view = buildLocalSolarEclipseViewGeometry(partial, viewOptions({ selectedEvent: 'C2' }))
		expect(view.requestedEvent).toBe('C2')
		expect(view.selectedEvent).toBe('MAX')
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
})

describe('local view topocentric invariants', () => {
	const total = local(total2024.eclipse, total2024.pbe, -106.4, 23.25)
	const annular = local(annular2023.eclipse, annular2023.pbe, -123, 43)

	test('separations match the tangency geometry at every contact', () => {
		for (const c of [total, annular]) {
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
})
