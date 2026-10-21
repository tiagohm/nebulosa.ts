import { describe, expect, test } from 'bun:test'
import { nearestLunarPhase } from '../../../src/astronomy/bodies/moon'
import { zeroPositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { altitudeOf } from '../../../src/astronomy/events/horizon'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { fitSkyBaseline, KRISCIUNAS_SCHAEFER_V, nanolambertsToSkyMagnitude, skyBrightness, skyBrightnessGeometryAt, type SkyBrightnessGeometry, skyMagnitudeToNanolamberts } from '../../../src/astronomy/sky/brightness'
import { type Time, Timescale, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { EARTH_RADIUS_AU, PIOVERTWO } from '../../../src/core/constants'
import { type Vec3, vecAngle, vecCross, vecLength, vecMinus, vecMulScalar, vecNegate, vecNormalize, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'
import { kilometer, toKilometer } from '../../../src/math/units/distance'

const NIGHT = deg(-30)

function moonlit(altitude: number, moonAltitude: number, separation: number, phaseAngle: number): SkyBrightnessGeometry {
	return { altitude: deg(altitude), sunAltitude: NIGHT, moon: { altitude: deg(moonAltitude), phaseAngle: deg(phaseAngle), separation: deg(separation) } }
}

test('nanolambert conversion round-trips and matches the K&S dark zenith', () => {
	expect(skyMagnitudeToNanolamberts(21.587)).toBeCloseTo(79, 1)
	expect(nanolambertsToSkyMagnitude(skyMagnitudeToNanolamberts(18.25))).toBeCloseTo(18.25, 12)
	// One magnitude is a factor 10^0.4 in flux.
	expect(skyMagnitudeToNanolamberts(20) / skyMagnitudeToNanolamberts(21)).toBeCloseTo(10 ** 0.4, 4)
})

test('dark zenith sky without the Moon is the natural baseline', () => {
	const result = skyBrightness({ altitude: PIOVERTWO, sunAltitude: NIGHT })
	expect(result.total).toBeCloseTo(21.587, 10)
	expect(result.natural).toBeCloseTo(21.587, 10)
	expect(result.lightPollution).toBeUndefined()
	expect(result.moon).toBeUndefined()
	expect(result.moonDelta).toBe(0)
	expect(result.airmass).toBeCloseTo(1, 12)
	expect(result.fluxes.moon).toBe(0)
	expect(result.warnings).toEqual([])
})

test('a set Moon contributes nothing', () => {
	const set = skyBrightness(moonlit(60, -5, 40, 0))
	const absent = skyBrightness({ altitude: deg(60), sunAltitude: NIGHT })
	expect(set.total).toBe(absent.total)
	expect(set.moon).toBeUndefined()
	expect(set.moonAirmass).toBeUndefined()
	expect(set.moonDelta).toBe(0)
})

// Reference: specsim 1.0.0 (DESI, astropy 8.0.1) specsim.atmosphere.krisciunas_schaefer, which implements
// K&S eqs. 3, 9/20 and 21 without the opposition surge, the distance scaling or the eq. 19 aureole. All
// cases use phase angles above 7° and separations above 10° so the implementations coincide.
// Columns: target zenith, Moon zenith, separation (deg), specsim phase (α/180), k, moonlight V mag/arcsec².
const SPECSIM = [
	[0, 30, 60, 0.1, 0.172, 19.078404531414748],
	[30, 50, 30, 0.3, 0.172, 19.259710788308343],
	[45, 20, 90, 0.5, 0.172, 21.22050447598305],
	[60, 40, 20, 0.2, 0.172, 17.927558348615168],
	[10, 70, 120, 0.15, 0.2, 19.610182560163395],
] as const

test('scattered moonlight matches the specsim Krisciunas-Schaefer implementation', () => {
	for (const [zenith, moonZenith, separation, phase, extinction, expected] of SPECSIM) {
		const result = skyBrightness(moonlit(90 - zenith, 90 - moonZenith, separation, 180 * phase), { ...KRISCIUNAS_SCHAEFER_V, extinction })
		expect(result.moon).toBeCloseTo(expected, 10)
	}
})

describe('lunar phase', () => {
	test('full Moon brightens the sky by magnitudes and new Moon barely at all', () => {
		const full = skyBrightness(moonlit(70, 45, 45, 10))
		const quarter = skyBrightness(moonlit(70, 45, 45, 90))
		const crescent = skyBrightness(moonlit(70, 45, 45, 150))
		const fresh = skyBrightness(moonlit(70, 45, 45, 180))
		expect(full.moonDelta).toBeLessThan(-2.5)
		expect(full.total).toBeLessThan(quarter.total)
		expect(quarter.total).toBeLessThan(crescent.total)
		expect(crescent.total).toBeLessThan(fresh.total)
		expect(fresh.moonDelta).toBeGreaterThan(-0.05)
	})

	test('the opposition surge adds 35% at full Moon and vanishes at 7 degrees', () => {
		const surge = (alpha: number) => {
			const moonFlux = skyBrightness(moonlit(70, 45, 45, alpha)).fluxes.moon
			const law = 10 ** (-0.4 * (0.026 * alpha + 4e-9 * alpha ** 4))
			return moonFlux / law
		}

		expect(surge(0) / surge(7)).toBeCloseTo(1.35, 10)
		expect(surge(7) / surge(8)).toBeCloseTo(1, 10)
	})

	test('a closer Moon is brighter by the inverse square of the distance', () => {
		const geometry = moonlit(70, 45, 45, 30)
		const moonGeometry = geometry.moon!
		const mean = skyBrightness(geometry).fluxes.moon
		const perigee = skyBrightness({ ...geometry, moon: { ...moonGeometry, distance: kilometer(356500) } }).fluxes.moon
		expect(perigee / mean).toBeCloseTo((384400 / 356500) ** 2, 10)
	})
})

describe('separation', () => {
	test('moonlight falls from the Moon to about 90 degrees and rises again toward the anti-Moon side', () => {
		const at = (separation: number) => skyBrightness(moonlit(60, 50, separation, 40)).moon!
		expect(at(15)).toBeLessThan(at(30))
		expect(at(30)).toBeLessThan(at(60))
		expect(at(60)).toBeLessThan(at(90))
		expect(at(150)).toBeLessThan(at(110))
	})

	test('separations wrap and the lunar disk stays finite', () => {
		expect(skyBrightness(moonlit(60, 50, 340, 40)).total).toBeCloseTo(skyBrightness(moonlit(60, 50, 20, 40)).total, 10)
		const onDisk = skyBrightness(moonlit(50, 50, 0, 0))
		expect(Number.isFinite(onDisk.total)).toBeTrue()
		// Only the Rayleigh cos²ρ term still changes inside the 0.25° floor of the aureole term.
		expect(onDisk.total).toBeCloseTo(skyBrightness(moonlit(50, 50, 0.25, 0)).total, 6)
		expect(onDisk.warnings).toEqual(['moonClose'])
	})

	test('the published aureole and Mie fits do not meet at 10 degrees, which the close-Moon warning covers', () => {
		const inside = skyBrightness(moonlit(60, 50, 10, 10))
		const outside = skyBrightness(moonlit(60, 50, 10.0001, 10))
		// 6.2e7/10² = 6.2e5 against 10^(6.15 − 10/40) ≈ 7.94e5: a 0.16 mag step for a 0.0001° change.
		expect(inside.total - outside.total).toBeCloseTo(0.158, 3)
		expect(inside.warnings).toEqual(['moonClose'])
		expect(outside.warnings).toEqual(['moonClose'])
		expect(skyBrightness(moonlit(60, 50, 14.9, 10)).warnings).toEqual(['moonClose'])
		expect(skyBrightness(moonlit(60, 50, 15, 10)).warnings).toEqual([])
	})
})

describe('airmass', () => {
	test('the dark sky brightens monotonically toward the horizon', () => {
		let previous = Infinity
		for (const altitude of [90, 70, 50, 30, 20, 10, 5]) {
			const { total, airmass } = skyBrightness({ altitude: deg(altitude), sunAltitude: NIGHT })
			expect(total).toBeLessThan(previous)
			expect(airmass).toBeGreaterThanOrEqual(1)
			previous = total
		}

		const horizon = skyBrightness({ altitude: 0, sunAltitude: NIGHT })
		expect(horizon.airmass).toBeCloseTo(5, 12)
		expect(horizon.warnings).toEqual(['belowHorizon'])
	})

	test('a higher extinction dims a dark zenith-adjacent sky and scatters more moonlight into the column', () => {
		const geometry = moonlit(60, 40, 60, 30)
		const clear = skyBrightness(geometry, { ...KRISCIUNAS_SCHAEFER_V, extinction: 0.1 })
		const hazy = skyBrightness(geometry, { ...KRISCIUNAS_SCHAEFER_V, extinction: 0.3 })
		expect(hazy.natural).toBeGreaterThan(clear.natural)
		expect(hazy.moon!).toBeLessThan(clear.moon!)
	})
})

test('warnings mark twilight, high airmass and a close Moon', () => {
	expect(skyBrightness({ altitude: deg(60), sunAltitude: deg(-12) }).warnings).toEqual(['twilight'])
	expect(skyBrightness({ altitude: deg(60), sunAltitude: deg(-18) }).warnings).toEqual([])
	expect(skyBrightness({ altitude: deg(15), sunAltitude: NIGHT }).warnings).toEqual(['highAirmass'])
	expect(skyBrightness(moonlit(60, 10, 5, 30)).warnings).toEqual(['moonHighAirmass', 'moonClose'])
	expect(skyBrightness(moonlit(-5, 10, 50, 30)).warnings).toEqual(['belowHorizon', 'moonHighAirmass'])
})

test('a non-V moonlight colour offset scales both scattering terms and is flagged as an extrapolation', () => {
	const model = { ...KRISCIUNAS_SCHAEFER_V, moonOffset: 0.5 }
	const near = moonlit(60, 50, 20, 40)
	const far = moonlit(60, 50, 90, 40)

	// One offset cannot change the Rayleigh/Mie ratio, so it shifts every separation by the same factor.
	for (const geometry of [near, far]) {
		const shifted = skyBrightness(geometry, model)
		expect(shifted.fluxes.moon / skyBrightness(geometry).fluxes.moon).toBeCloseTo(10 ** -0.2, 12)
		expect(shifted.warnings).toEqual(['moonColorExtrapolated'])
	}

	expect(skyBrightness(moonlit(60, -5, 20, 40), model).warnings).toEqual([])
	expect(skyBrightness({ altitude: PIOVERTWO, sunAltitude: NIGHT }, model).warnings).toEqual([])
	// A moonlit reading in an extrapolated band cannot calibrate the baseline; a moonless one can.
	const fit = fitSkyBaseline(
		[
			{ ...far, measured: 19 },
			{ altitude: PIOVERTWO, sunAltitude: NIGHT, measured: 20 },
		],
		model,
	)
	expect(fit!.used).toBe(1)
	expect(fit!.rejected).toBe(1)
})

test('light pollution and moonlight add as fluxes and stay separate', () => {
	const model = { ...KRISCIUNAS_SCHAEFER_V, lightPollutionZenith: 20.5 }
	const result = skyBrightness(moonlit(70, 40, 50, 60), model)
	// The K&S scale 0.92104 rounds 0.4·ln 10 in the sixth digit, hence the tolerance against 2.5·log10.
	expect(result.lightPollution).toBeCloseTo(20.5 + 2.5 * Math.log10(skyBrightness({ altitude: PIOVERTWO, sunAltitude: NIGHT }).fluxes.natural / result.fluxes.natural), 6)
	expect(result.fluxes.total).toBeCloseTo(result.fluxes.natural + result.fluxes.lightPollution + result.fluxes.moon, 10)
	expect(result.total).toBeCloseTo(nanolambertsToSkyMagnitude(result.fluxes.total), 12)
	expect(result.moonDelta).toBeCloseTo(result.total - nanolambertsToSkyMagnitude(result.fluxes.natural + result.fluxes.lightPollution), 12)

	// A brighter baseline hides the same moonlight better.
	const dark = skyBrightness(moonlit(70, 40, 50, 60))
	expect(result.moonDelta).toBeGreaterThan(dark.moonDelta)
	expect(result.moon).toBe(dark.moon)
})

describe('baseline fit', () => {
	const truth = { ...KRISCIUNAS_SCHAEFER_V, lightPollutionZenith: 20.3 }
	const geometries: SkyBrightnessGeometry[] = [{ altitude: PIOVERTWO, sunAltitude: NIGHT }, { altitude: deg(60), sunAltitude: NIGHT }, { altitude: deg(35), sunAltitude: NIGHT }, moonlit(70, 30, 60, 100), moonlit(45, 50, 80, 60)]

	test('recovers the light-pollution zenith from noiseless measurements, with or without the Moon', () => {
		const measurements = geometries.map((geometry) => ({ altitude: geometry.altitude, sunAltitude: geometry.sunAltitude, moon: geometry.moon, measured: skyBrightness(geometry, truth).total }))
		const fit = fitSkyBaseline(measurements)
		expect(fit).toBeDefined()
		expect(fit!.model.lightPollutionZenith).toBeCloseTo(20.3, 8)
		expect(fit!.residualRms).toBeLessThan(1e-8)
		expect(fit!.used).toBe(5)
		expect(fit!.rejected).toBe(0)
	})

	test('a single zenith SQM reading sets the baseline exactly', () => {
		const fit = fitSkyBaseline([{ altitude: PIOVERTWO, sunAltitude: NIGHT, measured: 19.5 }])
		expect(skyBrightness({ altitude: PIOVERTWO, sunAltitude: NIGHT }, fit!.model).total).toBeCloseTo(19.5, 10)
	})

	test('rejects twilight, low and non-finite readings and reports a sky darker than the natural model', () => {
		const fit = fitSkyBaseline([
			{ altitude: PIOVERTWO, sunAltitude: deg(-10), measured: 17 },
			{ altitude: deg(10), sunAltitude: NIGHT, measured: 18 },
			{ altitude: PIOVERTWO, sunAltitude: NIGHT, measured: Number.NaN },
			{ altitude: PIOVERTWO, sunAltitude: NIGHT, measured: 21.8 },
		])

		expect(fit!.used).toBe(1)
		expect(fit!.rejected).toBe(3)
		expect(fit!.model.lightPollutionZenith).toBeUndefined()
		expect(fit!.residualRms).toBeCloseTo(21.8 - 21.587, 10)
		expect(fitSkyBaseline([{ altitude: PIOVERTWO, sunAltitude: deg(-5), measured: 15 }])).toBeUndefined()
		expect(fitSkyBaseline([])).toBeUndefined()
	})
})

describe('observer and epoch', () => {
	// Cerro Pachón around the full Moon of 2026-10-26.
	const SITE = geodeticLocation(deg(-70.7375), deg(-30.24), kilometer(2.2), Ellipsoid.WGS84)
	const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])
	const moonAt = (time: Time) => moon(time)[0]
	const FULL = nearestLunarPhase(timeYMDHMS(2026, 10, 20, 0, 0, 0, Timescale.UTC), 'FULL', true)
	const SOUTH_POLE = [0, 0, -1] as const
	const ZERO_STATE = zeroPositionAndVelocity()

	// The hour within half a day of full Moon at which the Moon stands highest.
	let time = FULL
	for (let hours = -12; hours <= 12; hours++) {
		const candidate = timeShift(FULL, hours / 24)
		if (altitudeOf(moonAt(candidate), candidate, SITE) > altitudeOf(moonAt(time), time, SITE)) time = candidate
	}

	test('reduces the full Moon geometry with topocentric lunar altitude', () => {
		const geometry = skyBrightnessGeometryAt(SOUTH_POLE, time, SITE, { sunAt, moonAt })
		const lunar = geometry.moon!
		const observer = observerState(time, ZERO_STATE, SITE)[0]
		const geocentric = altitudeOf(moonAt(time), time, SITE)

		expect(geometry.sunAltitude).toBeLessThan(deg(-18))
		// The south celestial pole stands at the site's latitude, within precession of J2000.
		expect(geometry.altitude).toBeCloseTo(deg(30.24), 2)
		expect(lunar.altitude).toBeGreaterThan(deg(40))
		expect(lunar.phaseAngle).toBeLessThan(deg(6))
		expect(lunar.distance).toBeCloseTo(vecLength(vecMinus(moonAt(time), observer)), 15)
		// Parallax lowers the Moon by about asin(R⊕/d)·cos h (≈ 0.6° here).
		expect(Math.abs(geocentric - lunar.altitude - Math.asin(EARTH_RADIUS_AU / lunar.distance!) * Math.cos(geocentric))).toBeLessThan(3e-4)
		expect(lunar.separation).toBeCloseTo(vecAngle(vecMinus(moonAt(time), observer), SOUTH_POLE), 12)
	})

	test('lunar altitude, distance, separation and phase all use the same topocentric Moon', () => {
		// A synthetic Moon placed 384 400 km from the observer along u, 40° from the geocentric zenith in
		// the eastward vertical plane; the target is 9.881° below it in the same plane, so its topocentric
		// separation is exact while the geocentric one, ~10.5°, falls on the other side of the 10° seam.
		const observer = observerState(time, ZERO_STATE, SITE)[0]
		const up = vecNormalize(observer)
		const east = vecNormalize(vecCross([0, 0, 1], up))
		const along = (zenithDistance: number): Vec3 => vecPlus(vecMulScalar(up, Math.cos(deg(zenithDistance))), vecMulScalar(east, Math.sin(deg(zenithDistance))))
		const distance = kilometer(384400)
		const moonGeocentric = vecPlus(observer, vecMulScalar(along(40), distance))
		const sunGeocentric = vecMulScalar(up, -1)
		const target = along(40 + 9.881)

		const geometry = skyBrightnessGeometryAt(target, time, SITE, { sunAt: () => sunGeocentric, moonAt: () => moonGeocentric })
		const lunar = geometry.moon!
		expect(lunar.distance).toBeCloseTo(distance, 15)
		expect(toKilometer(lunar.distance!)).toBeCloseTo(384400, 6)
		expect(lunar.separation).toBeCloseTo(deg(9.881), 10)
		expect(vecAngle(moonGeocentric, target) - lunar.separation).toBeGreaterThan(deg(0.5))
		expect(lunar.altitude).toBeCloseTo(altitudeOf(along(40), time, SITE), 12)
		expect(lunar.phaseAngle).toBeCloseTo(vecAngle(vecMinus(sunGeocentric, moonGeocentric), vecMinus(observer, moonGeocentric)), 12)
		expect(lunar.phaseAngle - vecAngle(vecMinus(sunGeocentric, moonGeocentric), vecNegate(moonGeocentric))).toBeGreaterThan(deg(0.5))
		expect(skyBrightness(geometry).warnings).toContain('moonClose')
	})

	test('the sky near the full Moon is brighter than the sky far from it', () => {
		const toward = skyBrightness(skyBrightnessGeometryAt(moonAt(time), time, SITE, { sunAt, moonAt }))
		const pole = skyBrightness(skyBrightnessGeometryAt(SOUTH_POLE, time, SITE, { sunAt, moonAt }))
		expect(toward.warnings).toEqual(['moonClose'])
		expect(pole.warnings).toEqual([])
		expect(toward.moonDelta).toBeLessThan(pole.moonDelta)
		expect(pole.moonDelta).toBeLessThan(-1)

		const withoutMoon = skyBrightnessGeometryAt(SOUTH_POLE, time, SITE, { sunAt })
		expect(withoutMoon.moon).toBeUndefined()
		expect(skyBrightness(withoutMoon).total).toBeCloseTo(pole.natural, 12)
	})
})
