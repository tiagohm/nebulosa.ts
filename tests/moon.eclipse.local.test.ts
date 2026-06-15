import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PIOVERTWO, TAU } from '../src/constants'
import * as elpmpp02 from '../src/elpmpp02'
import { nearestLunarEclipse, type LunarEclipse } from '../src/moon'
import { computeLocalLunarEclipseCircumstances, computeLocalLunarEclipseViewGeometry, type LocalLunarEclipseSvgCircle } from '../src/moon.eclipse.local'
import { computeLunarEclipseMapGeometry } from '../src/moon.eclipse.map'
import { computeSunMoonPositionAt } from '../src/sun.eclipse.map'
import { type Time, timeYMDHMS } from '../src/time'
import * as vsop87e from '../src/vsop87e'

function sunMoonPosition(t: Time) {
	return computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
}

const PENUMBRAL = nearestLunarEclipse(timeYMDHMS(1973, 6, 1), true)
const TOTAL = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)
const PARTIAL = nearestLunarEclipse(timeYMDHMS(1994, 5, 25), true)

// Sublunar point (longitude, latitude) at maximal eclipse, where the Moon is at the zenith.
function sublunarAtMax(eclipse: LunarEclipse) {
	const geometry = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition)
	const max = geometry.events.find((e) => e.kind === 'MAX')!
	return { longitude: max.sublunar.x, latitude: max.sublunar.y }
}

describe('per-contact magnitudes', () => {
	const { longitude, latitude } = sublunarAtMax(TOTAL)
	const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)

	test('umbral magnitude is 0 at U1/U4 and 1 at U2/U3', () => {
		expect(local.events.U1!.umbralMagnitude).toBeCloseTo(0, 6)
		expect(local.events.U4!.umbralMagnitude).toBeCloseTo(0, 6)
		expect(local.events.U2!.umbralMagnitude).toBeCloseTo(1, 6)
		expect(local.events.U3!.umbralMagnitude).toBeCloseTo(1, 6)
	})

	test('penumbral magnitude is 0 at P1/P4', () => {
		expect(local.events.P1!.penumbralMagnitude).toBeCloseTo(0, 6)
		expect(local.events.P4!.penumbralMagnitude).toBeCloseTo(0, 6)
	})

	test('umbral magnitude at MAX matches the eclipse magnitude', () => {
		expect(local.events.MAX!.umbralMagnitude).toBeCloseTo(TOTAL.magnitude, 6)
	})

	test('penumbral-only eclipse exposes its penumbral magnitude at MAX', () => {
		const sub = sublunarAtMax(PENUMBRAL)
		const localPen = computeLocalLunarEclipseCircumstances(PENUMBRAL, sub.longitude, sub.latitude, sunMoonPosition)
		expect(localPen.events.MAX!.penumbralMagnitude).toBeCloseTo(PENUMBRAL.magnitude, 6)
		expect(localPen.details.maximalUmbralMagnitude).toBeNull()
	}, 6000)
})

describe('visibility classification', () => {
	test('observer at the sublunar point sees the whole eclipse above the horizon', () => {
		const { longitude, latitude } = sublunarAtMax(TOTAL)
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)
		expect(local.visibility.hasObservableEclipse).toBe(true)
		expect(local.events.MAX!.observable).toBe(true)
		expect(local.events.MAX!.altitude).toBeGreaterThan(0)
		expect(local.visibility.kind).toBe('completelyVisible')
		// The whole eclipse is above the horizon here, so the observable time must equal the penumbral phase
		// duration, never exceed it (the previous sample-count formula overcounted by one step).
		expect(local.details.observableDuration).toBeLessThanOrEqual(local.details.penumbralPhaseDuration + 1e-6)
		expect(local.details.observableDuration).toBeGreaterThan(local.details.penumbralPhaseDuration * 0.99)
	}, 6000)

	test('observer at the antipode has the Moon below the horizon throughout', () => {
		const sub = sublunarAtMax(TOTAL)
		const longitude = sub.longitude > 0 ? sub.longitude - Math.PI : sub.longitude + Math.PI
		const latitude = -sub.latitude
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)
		expect(local.visibility.hasObservableEclipse).toBe(false)
		expect(local.visibility.kind).toBe('geometricOnlyBelowHorizon')
		expect(local.events.MAX!.observable).toBe(false)
		expect(local.details.observableDuration).toBe(0)
	}, 6000)

	test('hasGeometricEclipse is true regardless of horizon', () => {
		const sub = sublunarAtMax(TOTAL)
		const longitude = sub.longitude > 0 ? sub.longitude - Math.PI : sub.longitude + Math.PI
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, -sub.latitude, sunMoonPosition)
		expect(local.visibility.hasGeometricEclipse).toBe(true)
	}, 6000)

	// An observer a hair inside the geocentric MAX horizon curve: the geocentric Moon center is above the
	// horizon, but once diurnal parallax (~0.95 deg) is applied the topocentric center is below it. The old
	// geocentric conversion marked this location observable; the topocentric one must not.
	test('observer just inside the geocentric horizon is below the topocentric horizon', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		// On the sublunar meridian (hour angle 0), geocentric altitude = 90 deg - |latitude - declination|; place
		// the observer 0.3 deg inside the 90 deg horizon. (declination < 0 here keeps the latitude within range.)
		const longitude = max.sublunar.x
		const latitude = max.declination + (PIOVERTWO - deg(0.3))
		const H = max.gast + longitude - max.rightAscension
		const geocentricAltitude = Math.asin(Math.sin(latitude) * Math.sin(max.declination) + Math.cos(latitude) * Math.cos(max.declination) * Math.cos(H))
		expect(geocentricAltitude).toBeGreaterThan(0)

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)
		expect(local.events.MAX!.altitude).toBeLessThan(0)
		expect(local.events.MAX!.altitude).toBeLessThan(geocentricAltitude)
		expect(local.events.MAX!.observable).toBe(false)
	}, 6000)
})

describe('P/Z orientation angles and Alt/Az', () => {
	const { longitude, latitude } = sublunarAtMax(TOTAL)
	const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)

	test('every event angle is finite and normalized to [0, TAU)', () => {
		for (const kind of Object.keys(local.events) as (keyof typeof local.events)[]) {
			const event = local.events[kind]!
			for (const angle of [event.azimuth, event.positionAngle, event.zenithAngle]) {
				expect(Number.isFinite(angle)).toBe(true)
				expect(angle).toBeGreaterThanOrEqual(0)
				expect(angle).toBeLessThan(TAU + 1e-9)
			}
			expect(Number.isFinite(event.altitude)).toBe(true)
		}
	})

	test('details report phase durations for a total eclipse', () => {
		expect(local.details.penumbralPhaseDuration).toBeGreaterThan(0)
		expect(local.details.partialPhaseDuration).toBeGreaterThan(0)
		expect(local.details.totalPhaseDuration).toBeGreaterThan(0)
	})

	test('partial eclipse has no total phase duration', () => {
		const sub = sublunarAtMax(PARTIAL)
		const localPartial = computeLocalLunarEclipseCircumstances(PARTIAL, sub.longitude, sub.latitude, sunMoonPosition)
		expect(localPartial.details.totalPhaseDuration).toBeNull()
		expect(localPartial.details.partialPhaseDuration).toBeGreaterThan(0)
	}, 6000)
})

describe('Local View geometry', () => {
	const { longitude, latitude } = sublunarAtMax(TOTAL)
	const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition)
	const view = computeLocalLunarEclipseViewGeometry(local, TOTAL, { selectedEvent: 'MAX' })

	function circles(role: LocalLunarEclipseSvgCircle['role']) {
		return view.shapes.filter((s): s is LocalLunarEclipseSvgCircle => s.kind === 'circle' && s.role === role)
	}

	test('draws exactly one umbra and one penumbra ring with penumbra larger', () => {
		const umbra = circles('umbra')
		const penumbra = circles('penumbra')
		expect(umbra).toHaveLength(1)
		expect(penumbra).toHaveLength(1)
		expect(penumbra[0].r).toBeGreaterThan(umbra[0].r)
	})

	test('selected contact is drawn as the primary Moon disk and the rest as ghosts', () => {
		const primary = circles('moonDisk')
		const ghosts = circles('ghostMoonDisk')
		expect(primary).toHaveLength(1)
		expect(primary[0].event).toBe('MAX')
		expect(ghosts).toHaveLength(6)
		expect(view.selectedEvent).toBe('MAX')
	})

	test('includes a trajectory path and a horizon band, all finite', () => {
		expect(view.shapes.some((s) => s.kind === 'path' && s.role === 'trajectoryPath')).toBe(true)
		expect(view.shapes.some((s) => s.kind === 'polygon' && s.role === 'horizonBand')).toBe(true)
		for (const shape of view.shapes) {
			if (shape.kind === 'circle') {
				expect(Number.isFinite(shape.cx) && Number.isFinite(shape.cy) && Number.isFinite(shape.r)).toBe(true)
				expect(shape.r).toBeGreaterThanOrEqual(0)
			} else if (shape.kind === 'path') {
				expect(shape.d).not.toContain('NaN')
			}
		}
	})

	test('falls back to MAX when the requested contact is absent', () => {
		const sub = sublunarAtMax(PENUMBRAL)
		const localPen = computeLocalLunarEclipseCircumstances(PENUMBRAL, sub.longitude, sub.latitude, sunMoonPosition)
		const penView = computeLocalLunarEclipseViewGeometry(localPen, PENUMBRAL, { selectedEvent: 'U2' })
		expect(penView.requestedEvent).toBe('U2')
		expect(penView.selectedEvent).toBe('MAX')
	}, 6000)
})
