import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { TAU } from '../src/constants'
import { nearestSolarEclipse, type SolarEclipse } from '../src/sun'
import { computePolynomialBesselianElements, computeSunMoonPositionAt, type PolynomialBesselianElements } from '../src/sun.eclipse'
import { buildLocalSolarEclipseViewGeometry, computeLocalSolarEclipseCircumstances, type LocalSolarEclipseEvent, type LocalSolarEclipseViewOptions } from '../src/sun.eclipse.local'
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
	return computeLocalSolarEclipseCircumstances(eclipse, pbe, deg(lon), deg(lat), { sunMoonPosition, ...options })
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
		// Ghost disks for the other contacts are present, again without any label.
		expect(roles).toContain('ghostSunDisk')
		expect(roles).toContain('ghostMoonDisk')
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
})
