import { describe, expect, test } from 'bun:test'
import { nearestLunarEclipse } from '../../../../../src/astronomy/bodies/moon'
import type { SunMoonPosition } from '../../../../../src/astronomy/events/eclipse/eclipse'
import { computeLocalLunarEclipseCircumstances, computeLocalLunarEclipseViewGeometry, listLocalLunarEclipses, moonAltitudeAt, type LocalLunarEclipseSvgCircle, type LocalLunarEclipseSvgPolygon } from '../../../../../src/astronomy/events/eclipse/lunar/local'
import { computeLunarEclipseMapGeometry } from '../../../../../src/astronomy/events/eclipse/lunar/map'
import { toJulianDay, type Time, timeYMDHMS, greenwichApparentSiderealTime, timeAtJulianDay } from '../../../../../src/astronomy/time/time'
import { PI, PIOVERTWO, TAU } from '../../../../../src/core/constants'
import { deg } from '../../../../../src/math/units/angle'
import { fixedSunMoonPosition } from '../../../../util/eclipse.util'

const FAST_LONGITUDE = deg(5)
const FAST_LATITUDE = 0

// Cheap deterministic position provider for tests that exercise local-circumstance plumbing rather than the
// analytical VSOP87/ELP ephemerides. The Moon stays high for FAST_LONGITUDE/FAST_LATITUDE, keeping visibility
// and duration assertions stable while avoiding hundreds of expensive series evaluations.
function fastSunMoonPosition(time: Time) {
	const gast = greenwichApparentSiderealTime(time)

	return {
		sun: { rightAscension: gast - PI + deg(0.1), declination: 0, distance: 1 },
		moon: { rightAscension: gast, declination: 0, distance: 60 },
		deltaT: 0,
	}
}

const PENUMBRAL = nearestLunarEclipse(timeYMDHMS(1973, 6, 1), true)
const TOTAL = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)
const PARTIAL = nearestLunarEclipse(timeYMDHMS(1994, 5, 25), true)

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
		const local = computeLocalLunarEclipseCircumstances(ancient, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })
		expect(local.visibility.hasGeometricEclipse).toBe(true)
		expect(Object.keys(local.events)).toEqual(['P1', 'U1', 'MAX', 'U4', 'P4'])
		expect(local.events.MAX!.time.day).toBeLessThan(0)
	})
})

describe('altitudeSamples normalization', () => {
	// The synthetic Moon stays above the horizon throughout the eclipse, so observableDuration equals the full
	// penumbral phase only when the scan reaches P4. A fractional sample count must not make it stop short, and a
	// non-finite count must neither hang (Infinity) nor skip the scan (NaN); all normalize to the default 48.
	const reference = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition).details.observableDuration

	test('fractional altitudeSamples is floored and still reaches P4', () => {
		const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 48.5 })
		expect(local.details.observableDuration).toBeCloseTo(reference, 6)
		expect(local.details.observableDuration).toBeGreaterThan(local.details.penumbralPhaseDuration * 0.99)
	})

	test('non-finite altitudeSamples falls back to the default without hanging', () => {
		for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: bad })
			expect(local.details.observableDuration).toBeCloseTo(reference, 6)
		}
	})
})

describe('horizonAltitude normalization', () => {
	test('non-finite horizonAltitude falls back to the geometric horizon', () => {
		const reference = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 12 })
		for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 12, horizonAltitude: bad })
			expect(local.visibility.kind).toBe(reference.visibility.kind)
			expect(local.details.observableDuration).toBeCloseTo(reference.details.observableDuration, 6)
			expect(local.events.MAX!.observable).toBe(reference.events.MAX!.observable)
		}
	})
})

describe('per-contact magnitudes', () => {
	const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })

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
		const localPen = computeLocalLunarEclipseCircumstances(PENUMBRAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })
		expect(localPen.events.MAX!.penumbralMagnitude).toBeCloseTo(PENUMBRAL.magnitude, 6)
		expect(localPen.details.maximalUmbralMagnitude).toBeNull()
	})
})

describe('visibility classification', () => {
	test('observer at the sublunar point sees the whole eclipse above the horizon', () => {
		const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition)
		expect(local.visibility.hasObservableEclipse).toBe(true)
		expect(local.events.MAX!.observable).toBe(true)
		expect(local.events.MAX!.altitude).toBeGreaterThan(0)
		expect(local.visibility.kind).toBe('completelyVisible')
		// The whole eclipse is above the horizon here, so the observable time must equal the penumbral phase
		// duration, never exceed it (the previous sample-count formula overcounted by one step).
		expect(local.details.observableDuration).toBeLessThanOrEqual(local.details.penumbralPhaseDuration + 1e-6)
		expect(local.details.observableDuration).toBeGreaterThan(local.details.penumbralPhaseDuration * 0.99)
	})

	test('observer at the antipode has the Moon below the horizon throughout', () => {
		const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE + PI, -FAST_LATITUDE, fastSunMoonPosition)
		expect(local.visibility.hasObservableEclipse).toBe(false)
		expect(local.visibility.kind).toBe('geometricOnlyBelowHorizon')
		expect(local.events.MAX!.observable).toBe(false)
		expect(local.details.observableDuration).toBe(0)
	})

	test('hasGeometricEclipse is true regardless of horizon', () => {
		const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE + PI, -FAST_LATITUDE, fastSunMoonPosition)
		expect(local.visibility.hasGeometricEclipse).toBe(true)
	})

	// An observer a hair inside the geocentric MAX horizon curve: the geocentric Moon center is above the
	// horizon, but once diurnal parallax (~0.95 deg) is applied the topocentric center is below it. The old
	// geocentric conversion marked this location observable; the topocentric one must not.
	test('observer just inside the geocentric horizon is below the topocentric horizon', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition)
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		// On the sublunar meridian (hour angle 0), geocentric altitude = 90 deg - |latitude - declination|; place
		// the observer 0.3 deg inside the 90 deg horizon.
		const longitude = max.sublunar.x
		const latitude = max.declination + (PIOVERTWO - deg(0.3))
		const H = max.gast + longitude - max.rightAscension
		const geocentricAltitude = Math.asin(Math.sin(latitude) * Math.sin(max.declination) + Math.cos(latitude) * Math.cos(max.declination) * Math.cos(H))
		expect(geocentricAltitude).toBeGreaterThan(0)

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, fastSunMoonPosition)
		expect(local.events.MAX!.altitude).toBeLessThan(0)
		expect(local.events.MAX!.altitude).toBeLessThan(geocentricAltitude)
		expect(local.events.MAX!.observable).toBe(false)
	})

	// Replicates one point of the module's exact penumbral sample grid (reference = maximalTime, see scanAltitudes).
	function gridAltitude(jd: number, longitude: number, latitude: number, sunMoonPosition: (time: Time) => SunMoonPosition = fastSunMoonPosition) {
		return moonAltitudeAt(timeAtJulianDay(TOTAL.maximalTime, jd), longitude, latitude, sunMoonPosition)
	}

	// A short above-horizon stretch (here the sharp upper-transit peak) can fall between two fixed samples, so a
	// sample-only check would report it unobservable; the interior search must still catch it.
	test('Moon above the horizon only between two default samples is still classified observable', () => {
		// Latitude = declination puts the Moon through the zenith at its transit (a sharp altitude peak);
		// offsetting the longitude by ~half a sample step moves that peak between two default samples.
		const latitude = 0
		const longitude = 0

		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		const samples = 48
		const step = (p4jd - p1jd) / samples
		const targetJd = p1jd + 20.5 * step
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(timeAtJulianDay(TOTAL.maximalTime, targetJd)))

		// Maximum over the exact default sample grid (what a sample-only check would see), and its location.
		let coarseMax = -Infinity
		let imax = 0
		for (let i = 0; i <= samples; i++) {
			const altitude = gridAltitude(p1jd + i * step, longitude, latitude, sunMoonPosition)
			if (altitude > coarseMax) {
				coarseMax = altitude
				imax = i
			}
		}

		// True peak between the two samples bracketing the coarse maximum.
		const loZoom = p1jd + Math.max(0, imax - 1) * step
		const hiZoom = p1jd + Math.min(samples, imax + 1) * step
		let fineMax = -Infinity
		for (let i = 0; i <= 40; i++) fineMax = Math.max(fineMax, gridAltitude(loZoom + (i / 40) * (hiZoom - loZoom), longitude, latitude, sunMoonPosition))

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
	})

	// The hard case a discrete monotonic-window test would skip: an upper-transit peak inside the FIRST scan step,
	// after which the samples descend monotonically. The duration must still integrate the brief stretch.
	test('a peak in the first step with monotonic neighbours still yields a positive duration', () => {
		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		const samples = 48
		const step = (p4jd - p1jd) / samples

		// Place the Moon's zenith transit a quarter step after P1. Latitude = declination makes that transit a
		// sharp ~90 deg peak while the coarse grid samples descend monotonically after P1.
		const targetJd = p1jd + 0.25 * step
		const longitude = 0
		const latitude = 0
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(timeAtJulianDay(TOTAL.maximalTime, targetJd)))

		// On the coarse default grid P1 is the highest sample and the grid descends monotonically afterwards: the
		// window the discrete monotonic test would (wrongly) skip.
		let coarseMax = -Infinity
		let imax = 0
		for (let i = 0; i <= samples; i++) {
			const altitude = gridAltitude(p1jd + i * step, longitude, latitude, sunMoonPosition)
			if (altitude > coarseMax) {
				coarseMax = altitude
				imax = i
			}
		}
		expect(imax).toBe(0)
		expect(gridAltitude(p1jd, longitude, latitude, sunMoonPosition)).toBeGreaterThan(gridAltitude(p1jd + step, longitude, latitude, sunMoonPosition))
		expect(gridAltitude(p1jd + step, longitude, latitude, sunMoonPosition)).toBeGreaterThan(gridAltitude(p1jd + 2 * step, longitude, latitude, sunMoonPosition))

		// The true peak in the first step exceeds every coarse sample.
		let fineMax = -Infinity
		for (let i = 0; i <= 40; i++) fineMax = Math.max(fineMax, gridAltitude(p1jd + (i / 40) * step, longitude, latitude, sunMoonPosition))
		expect(fineMax).toBeGreaterThan(coarseMax)

		const horizonAltitude = (coarseMax + fineMax) / 2
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { horizonAltitude })
		expect(local.visibility.hasObservableEclipse).toBe(true)
		expect(local.details.observableDuration).toBeGreaterThan(0)
		expect(local.details.observableDuration).toBeLessThanOrEqual(local.details.penumbralPhaseDuration + 1e-6)
	})

	// A high-latitude grazing moonrise/moonset whose entire above-horizon window is far shorter than scan.step / 16.
	// With a coarse scan (2 samples, one ~2.5 h step), a fixed 16-piece subdivision of the suspect step would find
	// both ends of the relevant sub-step below the horizon and report nothing, while phaseReachesHorizon still
	// classifies the eclipse observable from its interior maximum. Bracketing that maximum and solving the two
	// horizon roots around it recovers the brief duration, keeping observableDuration consistent with observability.
	test('a grazing window shorter than a refinement sub-step still yields a positive duration', () => {
		const samples = 2
		const longitude = 0
		const latitude = 0
		const p1jd = toJulianDay(TOTAL.firstContactPenumbraTime)
		const p4jd = toJulianDay(TOTAL.lastContactPenumbraTime)
		const step = (p4jd - p1jd) / samples
		const targetJd = p1jd + 0.5 * step
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(timeAtJulianDay(TOTAL.maximalTime, targetJd)))
		const fineMax = gridAltitude(targetJd, longitude, latitude, sunMoonPosition)
		const horizonAltitude = fineMax - deg(0.5)
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { altitudeSamples: samples, horizonAltitude })

		const subStepSeconds = local.details.penumbralPhaseDuration / samples / 16
		expect(local.visibility.hasObservableEclipse).toBe(true)
		// The window is real but shorter than one refinement sub-step, so a both-below sub-step integration misses it.
		expect(local.details.observableDuration).toBeGreaterThan(0)
		expect(local.details.observableDuration).toBeLessThan(subStepSeconds)
	})

	// Every contact can be above the horizon while the Moon still dips below it between contacts (a high-latitude
	// lower culmination during the multi-hour penumbral interval). 'completelyVisible' must check the whole
	// interval, not just the contact samples.
	test('contacts above the horizon with a dip below between them is not completelyVisible', () => {
		// High latitude keeps the full Moon up but low; the fixed right ascension places its lower culmination
		// roughly midway between U1 and U2, so the altitude dips to an interior minimum between contacts.
		const latitude = deg(70)
		const declination = deg(30)
		const longitude = 0
		const targetJd = (toJulianDay(TOTAL.firstContactUmbraTime) + toJulianDay(TOTAL.totalBeginTime)) * 0.5
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(timeAtJulianDay(TOTAL.maximalTime, targetJd)) + longitude - PI, declination)

		function altAt(jd: number) {
			return gridAltitude(jd, longitude, latitude, sunMoonPosition)
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
	})
})

describe('listLocalLunarEclipses', () => {
	// In the fast provider the Moon's hour angle equals the observer longitude (constant in time), so at
	// FAST_LONGITUDE (latitude 0) it stays high - every eclipse observable - and at the antimeridian it stays
	// below the horizon - none observable. Contact times still come from the real Meeus series.
	const start = timeYMDHMS(1997, 1, 1)
	const end = timeYMDHMS(2000, 1, 1)
	const startJd = toJulianDay(start)
	const endJd = toJulianDay(end)
	const antiLongitude = FAST_LONGITUDE + PI

	test('lists every eclipse in (start, end] observable from the location, earliest-first', () => {
		const list = listLocalLunarEclipses(FAST_LONGITUDE, FAST_LATITUDE, start, end, fastSunMoonPosition)
		expect(list.length).toBeGreaterThan(0)

		for (let i = 0; i < list.length; i++) {
			const jd = toJulianDay(list[i].eclipse.maximalTime)
			expect(jd).toBeGreaterThan(startJd)
			expect(jd).toBeLessThanOrEqual(endJd)
			expect(list[i].circumstances.visibility.hasObservableEclipse).toBe(true)
			if (i > 0) expect(jd).toBeGreaterThan(toJulianDay(list[i - 1].eclipse.maximalTime))
		}
	})

	test('omits eclipses with the Moon below the horizon throughout', () => {
		expect(listLocalLunarEclipses(antiLongitude, FAST_LATITUDE, start, end, fastSunMoonPosition)).toEqual([])
	})

	test('an inverted interval returns no eclipses', () => {
		expect(listLocalLunarEclipses(FAST_LONGITUDE, FAST_LATITUDE, end, start, fastSunMoonPosition)).toEqual([])
	})

	test('returns the same circumstances a direct call would compute', () => {
		const first = listLocalLunarEclipses(FAST_LONGITUDE, FAST_LATITUDE, start, end, fastSunMoonPosition)[0]
		const direct = computeLocalLunarEclipseCircumstances(first.eclipse, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition)
		expect(first.circumstances.visibility.kind).toBe(direct.visibility.kind)
		expect(first.circumstances.details.observableDuration).toBeCloseTo(direct.details.observableDuration, 6)
	})
})

describe('P/Z orientation angles and Alt/Az', () => {
	const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })

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
		const localPartial = computeLocalLunarEclipseCircumstances(PARTIAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })
		expect(localPartial.details.totalPhaseDuration).toBeNull()
		expect(localPartial.details.partialPhaseDuration).toBeGreaterThan(0)
	})

	// Position angle of the Earth-shadow center on the lunar disk at a given instant (geocentric, antisolar).
	function shadowCenterPositionAngle(time: Time) {
		const position = fastSunMoonPosition(time)
		const moonRA = position.moon.rightAscension
		const moonDEC = position.moon.declination
		// Mirror positionAngleBetween(moon, antisolar) with shadowDEC = -sunDEC: y = cos(dec2) sin(dRA),
		// x = cos(dec1) sin(dec2) - sin(dec1) cos(dec2) cos(dRA).
		const dRA = position.sun.rightAscension + PI - moonRA
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
		expect(angleSeparation(local.events.U2!.positionAngle, shadowCenterPositionAngle(TOTAL.totalBeginTime) + PI)).toBeLessThan(1e-9)
		expect(angleSeparation(local.events.U3!.positionAngle, shadowCenterPositionAngle(TOTAL.totalEndTime) + PI)).toBeLessThan(1e-9)
	})
})

describe('Local View geometry', () => {
	const local = computeLocalLunarEclipseCircumstances(TOTAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })
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
		const localPen = computeLocalLunarEclipseCircumstances(PENUMBRAL, FAST_LONGITUDE, FAST_LATITUDE, fastSunMoonPosition, { altitudeSamples: 4 })
		const penView = computeLocalLunarEclipseViewGeometry(localPen, PENUMBRAL, { selectedEvent: 'U2' })
		expect(penView.requestedEvent).toBe('U2')
		expect(penView.selectedEvent).toBe('MAX')
	})

	// With an obstructed horizon the view horizon must track horizonAltitude, not true altitude 0: a Moon above
	// the true horizon but below the configured one is not observable and must be drawn below the band.
	test('selected event below a custom horizon is drawn below the band', () => {
		// Fixed right ascension puts MAX a few degrees up, between 0 and a 10 deg obstructed horizon.
		const longitude = 0
		const latitude = 0
		const customHorizon = deg(10)
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(TOTAL.maximalTime) + longitude - deg(85))

		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { altitudeSamples: 4, horizonAltitude: customHorizon })
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
	})

	// A non-MAX selected contact whose disk is offset from the shadow center: the horizon must be anchored at the
	// disk, not the shadow center, so the band agrees with the contact's observable flag. The synthetic P1 altitude
	// is slightly negative (not observable).
	test('a non-MAX contact just below the horizon is drawn inside the band', () => {
		const longitude = 0
		const latitude = 0
		const sunMoonPosition = fixedSunMoonPosition(greenwichApparentSiderealTime(TOTAL.firstContactPenumbraTime) + longitude - deg(90.5))
		const local = computeLocalLunarEclipseCircumstances(TOTAL, longitude, latitude, sunMoonPosition, { altitudeSamples: 4 })
		expect(local.events.P1!.altitude).toBeLessThan(0)
		expect(local.events.P1!.observable).toBe(false)

		const view = computeLocalLunarEclipseViewGeometry(local, TOTAL, { selectedEvent: 'P1' })
		expect(view.selectedEvent).toBe('P1')
		const band = view.shapes.find((s): s is LocalLunarEclipseSvgPolygon => s.kind === 'polygon' && s.role === 'horizonBand')!
		const moon = view.shapes.find((s): s is LocalLunarEclipseSvgCircle => s.kind === 'circle' && s.role === 'moonDisk')!
		// The below-horizon disk lands inside the below-horizon band, consistent with observable === false.
		expect(pointInPolygon(moon.cx, moon.cy, band.points)).toBe(true)
	})
})
