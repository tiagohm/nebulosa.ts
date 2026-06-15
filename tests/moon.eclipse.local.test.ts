import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PIOVERTWO, TAU } from '../src/constants'
import * as elpmpp02 from '../src/elpmpp02'
import { nearestLunarEclipse, type LunarEclipse } from '../src/moon'
import { computeLocalLunarEclipseCircumstances, computeLocalLunarEclipseViewGeometry, moonAltitudeAt, type LocalLunarEclipseSvgCircle, type LocalLunarEclipseSvgPolygon } from '../src/moon.eclipse.local'
import { computeLunarEclipseMapGeometry } from '../src/moon.eclipse.map'
import { computeSunMoonPositionAt } from '../src/sun.eclipse.map'
import { timeShift, toJulianDay, type Time, timeYMDHMS } from '../src/time'
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

// Ray-casting point-in-polygon test.
function pointInPolygon(px: number, py: number, polygon: readonly { readonly x: number; readonly y: number }[]) {
	let inside = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x
		const yi = polygon[i].y
		const xj = polygon[j].x
		const yj = polygon[j].y
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}

describe('ancient dates', () => {
	// Contacts before JD 0 have negative days; lunarEclipseEvents must keep them, so local circumstances report a
	// real geometric eclipse instead of nothing.
	test('local circumstances resolve for an eclipse before JD 0', () => {
		const ancient = nearestLunarEclipse(timeYMDHMS(-5000, 1, 1), true)
		const local = computeLocalLunarEclipseCircumstances(ancient, 0, 0, sunMoonPosition, { altitudeSamples: 12 })
		expect(local.visibility.hasGeometricEclipse).toBe(true)
		expect(Object.keys(local.events)).toEqual(['P1', 'U1', 'MAX', 'U4', 'P4'])
		expect(local.events.MAX!.time.day).toBeLessThan(0)
	}, 6000)
})

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

	// Replicates one point of the module's exact penumbral sample grid (reference = maximalTime, see scanAltitudes).
	function gridAltitude(jd: number, longitude: number, latitude: number) {
		const reference = TOTAL.maximalTime
		return moonAltitudeAt(timeShift(reference, jd - reference.day - reference.fraction), longitude, latitude, sunMoonPosition)
	}

	// A short above-horizon stretch (here the sharp upper-transit peak) can fall between two fixed samples, so a
	// sample-only check would report it unobservable; the interior search must still catch it.
	test('Moon above the horizon only between two default samples is still classified observable', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		// Latitude = declination puts the Moon through the zenith at its transit (a sharp altitude peak);
		// offsetting the longitude by ~half a sample step moves that peak between two default samples.
		const latitude = max.declination
		const longitude = max.sublunar.x + deg(0.94)

		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		const samples = 48
		const step = (p4jd - p1jd) / samples

		// Maximum over the exact default sample grid (what a sample-only check would see), and its location.
		let coarseMax = -Infinity
		let imax = 0
		for (let i = 0; i <= samples; i++) {
			const altitude = gridAltitude(p1jd + i * step, longitude, latitude)
			if (altitude > coarseMax) {
				coarseMax = altitude
				imax = i
			}
		}

		// True peak between the two samples bracketing the coarse maximum.
		const loZoom = p1jd + Math.max(0, imax - 1) * step
		const hiZoom = p1jd + Math.min(samples, imax + 1) * step
		let fineMax = -Infinity
		for (let i = 0; i <= 40; i++) fineMax = Math.max(fineMax, gridAltitude(loZoom + (i / 40) * (hiZoom - loZoom), longitude, latitude))

		// The peak genuinely falls between samples: it exceeds every default sample.
		expect(fineMax).toBeGreaterThan(coarseMax)

		// Horizon set between the coarse samples and the true peak: every default sample is below it (a
		// sample-only check would report 'geometricOnlyBelowHorizon'), yet the Moon does rise above it.
		const horizonAltitude = (coarseMax + fineMax) / 2
		expect(coarseMax).toBeLessThan(horizonAltitude)

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { horizonAltitude })
		expect(local.visibility.hasObservableEclipse).toBe(true)
		expect(local.visibility.kind).not.toBe('geometricOnlyBelowHorizon')
		// The observable duration must agree with the classification: the brief above-horizon stretch between the
		// two coarse samples is integrated, not dropped to zero.
		expect(local.details.observableDuration).toBeGreaterThan(0)
		expect(local.details.observableDuration).toBeLessThanOrEqual(local.details.penumbralPhaseDuration + 1e-6)
	}, 15000)

	// The hard case a discrete monotonic-window test would skip: an upper-transit peak inside the FIRST scan step,
	// after which the samples descend monotonically. The duration must still integrate the brief stretch.
	test('a peak in the first step with monotonic neighbours still yields a positive duration', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
		const p1ev = geometry.events.find((e) => e.kind === 'P1')!
		const u1ev = geometry.events.find((e) => e.kind === 'U1')!

		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		const samples = 48
		const step = (p4jd - p1jd) / samples

		// Place the Moon's zenith transit a quarter step after P1: the sublunar longitude there, extrapolated from
		// the near-P1 linear rate. Latitude = declination makes that transit a sharp ~90 deg peak.
		const wrap = (x: number) => ((((x + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
		const sublunarRate = wrap(u1ev.sublunar.x - p1ev.sublunar.x) / (u1ev.jd - p1ev.jd)
		const targetJd = p1jd + 0.25 * step
		const longitude = p1ev.sublunar.x + sublunarRate * (targetJd - p1jd)
		const latitude = p1ev.declination

		// On the coarse default grid P1 is the highest sample and the grid descends monotonically afterwards: the
		// window the discrete monotonic test would (wrongly) skip.
		let coarseMax = -Infinity
		let imax = 0
		for (let i = 0; i <= samples; i++) {
			const altitude = gridAltitude(p1jd + i * step, longitude, latitude)
			if (altitude > coarseMax) {
				coarseMax = altitude
				imax = i
			}
		}
		expect(imax).toBe(0)
		expect(gridAltitude(p1jd, longitude, latitude)).toBeGreaterThan(gridAltitude(p1jd + step, longitude, latitude))
		expect(gridAltitude(p1jd + step, longitude, latitude)).toBeGreaterThan(gridAltitude(p1jd + 2 * step, longitude, latitude))

		// The true peak in the first step exceeds every coarse sample.
		let fineMax = -Infinity
		for (let i = 0; i <= 40; i++) fineMax = Math.max(fineMax, gridAltitude(p1jd + (i / 40) * step, longitude, latitude))
		expect(fineMax).toBeGreaterThan(coarseMax)

		const horizonAltitude = (coarseMax + fineMax) / 2
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { horizonAltitude })
		expect(local.visibility.hasObservableEclipse).toBe(true)
		expect(local.details.observableDuration).toBeGreaterThan(0)
		expect(local.details.observableDuration).toBeLessThanOrEqual(local.details.penumbralPhaseDuration + 1e-6)
	}, 15000)

	// Every contact can be above the horizon while the Moon still dips below it between contacts (a high-latitude
	// lower culmination during the multi-hour penumbral interval). 'completelyVisible' must check the whole
	// interval, not just the contact samples.
	test('contacts above the horizon with a dip below between them is not completelyVisible', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		// High southern latitude keeps the full Moon up but low; the longitude places its lower culmination
		// roughly midway between U1 and U2, so the altitude dips to an interior minimum between contacts.
		const latitude = -deg(70)
		const longitude = max.sublunar.x + Math.PI + deg(16.2)

		function altAt(jd: number) {
			const reference = TOTAL.maximalTime
			return moonAltitudeAt(timeShift(reference, jd - reference.day - reference.fraction), longitude, latitude, sunMoonPosition)
		}

		// Topocentric contact altitudes (P1, U1, U2, MAX, U3, U4, P4).
		const contactTimes = [TOTAL.firstContactPenumbraTime, TOTAL.firstContactUmbraTime, TOTAL.totalBeginTime, TOTAL.maximalTime, TOTAL.totalEndTime, TOTAL.lastContactUmbraTime, TOTAL.lastContactPenumbraTime]
		const contactAltitudes = contactTimes.map((t) => altAt(toJulianDay(t)))
		const minContact = Math.min(...contactAltitudes)

		// Interior minimum over (P1, P4): the lower culmination, sampled finely between the contacts.
		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		let interiorMin = Infinity
		for (let i = 1; i < 200; i++) interiorMin = Math.min(interiorMin, altAt(p1jd + (i / 200) * (p4jd - p1jd)))

		// The dip is strictly below the lowest contact: an interior below-horizon stretch with every contact above.
		expect(interiorMin).toBeLessThan(minContact)
		const horizonAltitude = interiorMin + 0.3 * (minContact - interiorMin)

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { horizonAltitude })
		// Every contact is above the configured horizon, so a contacts-only test would report completelyVisible...
		for (const event of Object.values(local.events)) expect(event.altitude).toBeGreaterThanOrEqual(horizonAltitude)
		// ...but the Moon drops below the horizon between contacts, so the eclipse is not entirely visible.
		expect(local.visibility.kind).not.toBe('completelyVisible')
		expect(local.visibility.hasObservableEclipse).toBe(true)
	}, 15000)
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

	// Position angle of the Earth-shadow center on the lunar disk at a given instant (geocentric, antisolar).
	function shadowCenterPositionAngle(time: Time) {
		const position = sunMoonPosition(time)
		const moonRA = position.moon.rightAscension
		const moonDEC = position.moon.declination
		// Mirror positionAngleBetween(moon, antisolar) with shadowDEC = -sunDEC: y = cos(dec2) sin(dRA),
		// x = cos(dec1) sin(dec2) - sin(dec1) cos(dec2) cos(dRA).
		const dRA = position.sun.rightAscension + Math.PI - moonRA
		const y = Math.cos(position.sun.declination) * Math.sin(dRA)
		const x = -Math.cos(moonDEC) * Math.sin(position.sun.declination) - Math.sin(moonDEC) * Math.cos(position.sun.declination) * Math.cos(dRA)
		return Math.atan2(y, x)
	}

	// Smallest absolute angular separation (radians) between two angles, accounting for wrap.
	function angleSeparation(a: number, b: number) {
		const d = Math.abs(((a - b) % TAU) + TAU) % TAU
		return Math.min(d, TAU - d)
	}

	// The U2/U3 internal tangency of a total eclipse contacts the umbra on the far side of the disk, so the
	// reported P angle must be opposite the shadow-center direction; the external U1 contact must equal it.
	test('total-eclipse U2/U3 contact point is opposite the shadow-center direction', () => {
		expect(angleSeparation(local.events.U1!.positionAngle, shadowCenterPositionAngle(TOTAL.firstContactUmbraTime))).toBeLessThan(1e-9)
		expect(angleSeparation(local.events.U2!.positionAngle, shadowCenterPositionAngle(TOTAL.totalBeginTime) + Math.PI)).toBeLessThan(1e-9)
		expect(angleSeparation(local.events.U3!.positionAngle, shadowCenterPositionAngle(TOTAL.totalEndTime) + Math.PI)).toBeLessThan(1e-9)
	})
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

	// With an obstructed horizon the view horizon must track horizonAltitude, not true altitude 0: a Moon above
	// the true horizon but below the configured one is not observable and must be drawn below the band.
	test('selected event below a custom horizon is drawn below the band', () => {
		const max = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition).events.find((e) => e.kind === 'MAX')!
		// High latitude so the Moon transits low at MAX: a few degrees up, between 0 and a 10 deg obstructed horizon.
		const longitude = max.sublunar.x
		const latitude = max.declination + deg(83)
		const customHorizon = deg(10)

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { horizonAltitude: customHorizon })
		const maxEvent = local.events.MAX!
		// Above the true horizon but below the obstructed one, hence not observable.
		expect(maxEvent.altitude).toBeGreaterThan(0)
		expect(maxEvent.altitude).toBeLessThan(customHorizon)
		expect(maxEvent.observable).toBe(false)

		function primaryInsideBand(horizonAltitude: number) {
			const view = computeLocalLunarEclipseViewGeometry(local, TOTAL, { selectedEvent: 'MAX', horizonAltitude })
			const band = view.shapes.find((s): s is LocalLunarEclipseSvgPolygon => s.kind === 'polygon' && s.role === 'horizonBand')!
			const moon = view.shapes.find((s): s is LocalLunarEclipseSvgCircle => s.kind === 'circle' && s.role === 'moonDisk')!
			return pointInPolygon(moon.cx, moon.cy, band.points)
		}

		// Drawn against the true horizon (0 deg) the Moon is above it: outside the below-horizon band.
		expect(primaryInsideBand(0)).toBe(false)
		// Drawn against the configured 10 deg horizon the Moon is below it: inside the band, matching observable=false.
		expect(primaryInsideBand(customHorizon)).toBe(true)
	}, 7000)
})
