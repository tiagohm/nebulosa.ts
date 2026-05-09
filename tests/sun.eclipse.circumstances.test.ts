import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { nearestSolarEclipse } from '../src/sun'
import { generateBesselianElements } from '../src/sun.eclipse.besselian'
import { computeLocalCircumstances, computeLocalEclipseAt } from '../src/sun.eclipse.circumstances'
import { timeYMD, toJulianDay } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const annular2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })

const dallas = { latitude: deg(32.7767), longitude: deg(-96.797) }
const newYork = { latitude: deg(40.7128), longitude: deg(-74.006) }
const rapaNui = { latitude: deg(-27.1127), longitude: deg(-109.3497) }
const capeTown = { latitude: deg(-33.9249), longitude: deg(18.4241) }
const london = { latitude: deg(51.5074), longitude: deg(-0.1278) }
const southPacific = { latitude: deg(-30), longitude: deg(-160) }

describe('local solar eclipse circumstances', () => {
	test('returns no local eclipse outside the penumbra', () => {
		const circumstances = computeLocalCircumstances(total2024, capeTown)

		expect(circumstances.geometricallyOccurs).toBeFalse()
		expect(circumstances.visible).toBeFalse()
		expect(circumstances.type).toBe('NONE')
		expect(circumstances.contacts).toHaveLength(0)
		expect(circumstances.MAX).toBeUndefined()
		expect(circumstances.maximumMagnitude).toBe(0)
	})

	test('computes a visible partial eclipse', () => {
		const circumstances = computeLocalCircumstances(total2024, newYork)

		expect(circumstances.geometricallyOccurs).toBeTrue()
		expect(circumstances.visible).toBeTrue()
		expect(circumstances.type).toBe('PARTIAL')
		expect(circumstances.C1).toBeDefined()
		expect(circumstances.MAX).toBeDefined()
		expect(circumstances.C4).toBeDefined()
		expect(circumstances.C2).toBeUndefined()
		expect(circumstances.C3).toBeUndefined()
		expect(circumstances.maximumMagnitude).toBeGreaterThan(0)
		expect(circumstances.maximumMagnitude).toBeLessThan(1)
		expect(circumstances.partialDurationSeconds).toBeGreaterThan(0)
	})

	test('computes a visible total eclipse', () => {
		const circumstances = computeLocalCircumstances(total2024, dallas)

		expect(circumstances.visible).toBeTrue()
		expect(circumstances.type).toBe('TOTAL')
		expect(circumstances.C1).toBeDefined()
		expect(circumstances.C2).toBeDefined()
		expect(circumstances.MAX).toBeDefined()
		expect(circumstances.C3).toBeDefined()
		expect(circumstances.C4).toBeDefined()
		expect(circumstances.MAX!.phase.isTotal).toBeTrue()
		expect(circumstances.maximumMagnitude).toBeGreaterThan(1)
		expect(circumstances.moonSunDiameterRatioAtMaximum).toBeGreaterThan(1)
		expect(circumstances.totalOrAnnularDurationSeconds).toBeGreaterThan(0)
		expect(circumstances.approximateShadowWidthKmAtMaximum).toBeGreaterThan(0)
		expect(circumstances.contacts.map((contact) => contact.type)).toEqual(['C1', 'C2', 'MAX', 'C3', 'C4'])
	})

	test('computes a visible annular eclipse', () => {
		const circumstances = computeLocalCircumstances(annular2024, rapaNui)

		expect(circumstances.visible).toBeTrue()
		expect(circumstances.type).toBe('ANNULAR')
		expect(circumstances.C2).toBeDefined()
		expect(circumstances.C3).toBeDefined()
		expect(circumstances.MAX!.phase.isAnnular).toBeTrue()
		expect(circumstances.maximumMagnitude).toBeGreaterThan(0.9)
		expect(circumstances.maximumMagnitude).toBeLessThan(1)
		expect(circumstances.moonSunDiameterRatioAtMaximum).toBeLessThan(1)
		expect(circumstances.totalOrAnnularDurationSeconds).toBeGreaterThan(0)
	})

	test('separates below-horizon geometry from visible classification', () => {
		const circumstances = computeLocalCircumstances(total2024, london)

		expect(circumstances.geometricallyOccurs).toBeTrue()
		expect(circumstances.visibleAboveHorizon).toBeFalse()
		expect(circumstances.visible).toBeFalse()
		expect(circumstances.type).toBe('NONE')
		expect(circumstances.maximumMagnitude).toBeGreaterThan(0)
		expect(circumstances.contacts.every((contact) => !contact.visible)).toBeTrue()
	})

	test('is visible when sunrise or sunset clips part of the eclipse', () => {
		const circumstances = computeLocalCircumstances(total2024, southPacific, { scanStepSeconds: 600 })

		expect(circumstances.geometricallyOccurs).toBeTrue()
		expect(circumstances.visibleAboveHorizon).toBeTrue()
		expect(circumstances.visible).toBeTrue()
		expect(circumstances.type).toBe('PARTIAL')
		expect(circumstances.contacts.some((contact) => contact.visible)).toBeTrue()
		expect(circumstances.contacts.some((contact) => !contact.visible)).toBeTrue()
	})

	test('longitude convention preserves the physical location', () => {
		const eastPositive = computeLocalCircumstances(total2024, dallas)
		const westPositive = computeLocalCircumstances(total2024, { latitude: dallas.latitude, longitude: -dallas.longitude }, { longitudeConvention: 'westPositive' })

		expect(westPositive.type).toBe(eastPositive.type)
		expect(westPositive.maximumMagnitude).toBeCloseTo(eastPositive.maximumMagnitude, 12)
		expect(toJulianDay(westPositive.MAX!.time)).toBeCloseTo(toJulianDay(eastPositive.MAX!.time), 12)
	})

	test('ellipsoid and spherical observer modes are finite and distinct', () => {
		const ellipsoid = computeLocalEclipseAt(total2024, dallas, total2024.geocentricMaximum, { useEarthEllipsoid: true })
		const spherical = computeLocalEclipseAt(total2024, dallas, total2024.geocentricMaximum, { useEarthEllipsoid: false })

		expect(ellipsoid.xi).toBeFinite()
		expect(ellipsoid.eta).toBeFinite()
		expect(spherical.xi).toBeFinite()
		expect(spherical.eta).toBeFinite()
		expect(Math.abs(ellipsoid.eta - spherical.eta)).toBeGreaterThan(1e-4)
	})

	test('refraction changes apparent altitude without changing geometry', () => {
		const geometric = computeLocalEclipseAt(total2024, southPacific, total2024.geocentricMaximum)
		const refracted = computeLocalEclipseAt(total2024, southPacific, total2024.geocentricMaximum, { includeRefraction: true })

		expect(refracted.sunAltitude).toBeGreaterThan(geometric.sunAltitude)
		expect(refracted.m).toBeCloseTo(geometric.m, 15)
		expect(refracted.magnitude).toBeCloseTo(geometric.magnitude, 15)
	})

	test('handles a grazing partial event without central contacts', () => {
		const circumstances = computeLocalCircumstances(total2024, { latitude: deg(89), longitude: 0 }, { scanStepSeconds: 300 })

		expect(circumstances.geometricallyOccurs).toBeTrue()
		expect(circumstances.maximumMagnitude).toBeGreaterThan(0)
		expect(circumstances.maximumMagnitude).toBeLessThan(0.05)
		expect(circumstances.C2).toBeUndefined()
		expect(circumstances.C3).toBeUndefined()
		expect(circumstances.contacts.length).toBeGreaterThanOrEqual(3)
	})
})
