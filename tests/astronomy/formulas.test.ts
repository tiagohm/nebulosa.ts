import { expect, test } from 'bun:test'
// oxfmt-ignore
import { asteroidMagnitudeEstimate, airmass, airmassKastenYoung, airyDiskInPixels, airyDiskSize, altitudeAtTransit, atmosphericExtinction, atmosphericRefraction, cometMagnitudeEstimate, criticalFocusZone, dawesLimit, dewPoint, dynamicRange, dynamicRangeInStops, effectiveApertureWithObstruction, exitPupil, exitPupilFromApertureAndMagnification, exitPupilFromEyepieceAndFocalRatio, eyepieceTrueFovViaFieldStop, eyepieceView, focalLength, focalRatio, guidingErrorInPixels, hourAngleAtAltitude, lightGraspRatio, isMagnusDomain, limitingMagnitude, MAGNUS_MAX_CELSIUS, MAGNUS_MIN_CELSIUS, magnification, maxExposureBeforeTrail, mosaicPanelCount, objectAngularDiameter, obstructionRatio, periodicErrorInPixels, pixelScale, plateScale, rayleighLimit, recommendedFocalLength, relativeHumidity, requiredSubframeCount, samplingRatio, saturationTime, sensorDiagonalFov, sensorFieldOfView, signalToNoiseRatio, skyLimitedExposure, stackingMagnitudeGain, stackingSnrGain, starTrailLength, subframeCount, surfaceBrightness, totalIntegrationTime } from '../../src/astronomy/formulas'
import { DEG2RAD, PIOVERTWO, RAD2DEG } from '../../src/core/constants'

test('visual astronomy and optical planning formulas return expected values', () => {
	expect(focalLength(200, 5)).toBe(1000)
	expect(focalRatio(1000, 200)).toBe(5)
	expect(magnification(1000, 10)).toBe(100)
	expect(dawesLimit(200)).toBe(0.58)
	expect(rayleighLimit(200)).toBe(0.69)
	expect(limitingMagnitude(200)).toBeCloseTo(14.20514998, 8)
	expect(lightGraspRatio(200, 100)).toBe(4)
	expect(exitPupil(200, 100)).toBe(2)
	expect(exitPupilFromApertureAndMagnification(200, 100)).toBe(2)
	expect(exitPupil(10, 5)).toBe(2)
	expect(exitPupilFromEyepieceAndFocalRatio(10, 5)).toBe(2)
	expect(eyepieceTrueFovViaFieldStop(27, 1000)).toBeCloseTo(1.5469860469, 9)
	expect(eyepieceView(1000, 200, 10, 50)).toEqual({ magnification: 100, trueFieldOfViewDegrees: 0.5, exitPupilMm: 2 })
	expect(plateScale(1000)).toBeCloseTo(206.265, 3)
	expect(effectiveApertureWithObstruction(200, 70)).toBeCloseTo(187.34994, 5)
	expect(obstructionRatio(200, 70)).toBe(35)
})

test('astrophotography sampling and sensor planning formulas return expected values', () => {
	expect(pixelScale(3.76, 800)).toBeCloseTo(0.96944459, 7)
	expect(samplingRatio(2.5, 0.9694455)).toBeCloseTo(2.5787938, 7)
	expect(recommendedFocalLength(3.76, 2, 2.5)).toBeCloseTo(620.444537, 5)
	expect(airyDiskSize(0.55, 5)).toBeCloseTo(6.71, 12)
	expect(airyDiskInPixels(6.71, 3.76)).toBeCloseTo(1.7845745, 7)
	expect(criticalFocusZone(0.55, 5)).toBeCloseTo(67.1, 12)
	expect(sensorDiagonalFov(28.4, 800)).toBeCloseTo(0.0354962725, 10)
	expect(sensorDiagonalFov(28.4, 800) * RAD2DEG).toBeCloseTo(2.0337866, 7)
	expect(sensorFieldOfView(22.3, 800)).toBeCloseTo(1.5971198539, 9)
	expect(mosaicPanelCount(5, 2, 0.15)).toBe(3)
})

test('guiding, trailing, exposure, and stacking formulas return expected values', () => {
	expect(guidingErrorInPixels(0.8, 1.2)).toBeCloseTo(0.6666667, 7)
	expect(periodicErrorInPixels(15, 1.2)).toBe(12.5)
	expect(starTrailLength(30 * DEG2RAD, 10, 1.2)).toBeCloseTo(108.5495629, 7)
	expect(maxExposureBeforeTrail(2, 1.2, 30 * DEG2RAD)).toBeCloseTo(0.18424763, 8)
	expect(signalToNoiseRatio(1000, 25, 20, 0.1, 3)).toBeCloseTo(24.0597423, 7)
	expect(stackingSnrGain(16)).toBe(4)
	expect(stackingMagnitudeGain(16)).toBeCloseTo(1.50514998, 8)
	expect(dynamicRange(50000, 3.5)).toBeCloseTo(14285.7142857, 7)
	expect(dynamicRangeInStops(50000, 3.5)).toBeCloseTo(13.80228555, 8)
	expect(saturationTime(50000, 1000)).toBe(50)
	expect(skyLimitedExposure(3, 0.5)).toBe(180)
	expect(totalIntegrationTime(30, 120)).toBe(3600)
	expect(subframeCount(3600, 120)).toBe(30)
	expect(requiredSubframeCount(3610, 120)).toBe(31)
})

test('atmospheric, transit, brightness, comet, and asteroid formulas return expected values', () => {
	expect(airmass(45 * DEG2RAD)).toBeCloseTo(1.41421356, 8)
	expect(airmassKastenYoung(30 * DEG2RAD)).toBeCloseTo(1.99429285, 8)
	expect(atmosphericExtinction(0.2, 1.5)).toBeCloseTo(0.3, 12)
	expect(atmosphericRefraction(45 * DEG2RAD)).toBeCloseTo(1.01270766, 8)
	expect(dewPoint(20, 60)).toBeCloseTo(11.99989462, 8)
	expect(relativeHumidity(20, 11.99989462)).toBeCloseTo(60, 7)
	expect(relativeHumidity(-10, -15)).toBeCloseTo(66.82932857, 8)
	expect(relativeHumidity(20, 20)).toBe(100)
	expect(altitudeAtTransit(-23 * DEG2RAD, -5 * DEG2RAD)).toBeCloseTo(72 * DEG2RAD, 12)
	expect(altitudeAtTransit(-23 * DEG2RAD, -5 * DEG2RAD)).toBeCloseTo(1.2566370614, 10)
	expect(objectAngularDiameter(1391400, 149597870.7)).toBeCloseTo(0.00930086747, 11)
	expect(objectAngularDiameter(1391400, 149597870.7) * RAD2DEG * 60).toBeCloseTo(31.9740271, 7)
	expect(surfaceBrightness(10, 3600)).toBeCloseTo(18.89075625, 8)
	expect(cometMagnitudeEstimate(8, 0.5, 1.2, 10)).toBeCloseTo(7.28666248, 8)
	expect(asteroidMagnitudeEstimate(12, 1.5, 0.8, 0.3)).toBeCloseTo(12.69590623, 8)
})

test('formulas reject structurally inconsistent inputs', () => {
	expect(() => lightGraspRatio(100, 200)).toThrow('larger aperture must be at least smaller aperture')
	expect(() => effectiveApertureWithObstruction(200, 200)).toThrow('obstruction diameter must be smaller than aperture diameter')
	expect(() => obstructionRatio(200, 201)).toThrow('obstruction diameter must be no larger than aperture diameter')
	expect(() => maxExposureBeforeTrail(2, 1.2, 90 * DEG2RAD)).toThrow('declination is too close to the celestial pole')
	expect(() => signalToNoiseRatio(0, 25, 0, 0, 0)).toThrow('noise variance must be positive')
	expect(() => atmosphericExtinction(0.2, 0.9)).toThrow('airmass must be at least 1')
	expect(() => dewPoint(20, 0)).toThrow('relative humidity must be within')
	expect(() => dewPoint(20, 101)).toThrow('relative humidity must be within')
})

test('hour angle at altitude gives a six-hour arc for a body on the celestial equator', () => {
	// A declination-zero body is up exactly half the day at any latitude: H = 90 deg.
	expect(hourAngleAtAltitude(0, 45 * DEG2RAD, 0)).toBeCloseTo(PIOVERTWO, 12)
	expect(hourAngleAtAltitude(0, 0, 0)).toBeCloseTo(PIOVERTWO, 12)
})

test('hour angle at altitude matches the standard semidiurnal arc', () => {
	// cos(H) = -tan(lat) * tan(dec) for h0 = 0.
	const declination = 20 * DEG2RAD
	const latitude = 45 * DEG2RAD
	expect(hourAngleAtAltitude(declination, latitude, 0)).toBeCloseTo(Math.acos(-Math.tan(latitude) * Math.tan(declination)), 12)
})

test('hour angle at altitude returns undefined for circumpolar and never-rising bodies', () => {
	// High-declination star at a high latitude never sets (always above h0 = 0).
	expect(hourAngleAtAltitude(80 * DEG2RAD, 80 * DEG2RAD, 0)).toBeUndefined()
	// Its southern counterpart never rises above h0 = 0.
	expect(hourAngleAtAltitude(-80 * DEG2RAD, 80 * DEG2RAD, 0)).toBeUndefined()
})

test('dew point and relative humidity invert each other over the useful domain', () => {
	for (const temperature of [-30, -5, 0, 12.5, 25, 40]) {
		for (const humidity of [1, 17.5, 50, 82.3, 100]) {
			expect(relativeHumidity(temperature, dewPoint(temperature, humidity))).toBeCloseTo(humidity, 10)
		}
	}
})

test('relative humidity stays finite and positive across its whole domain', () => {
	// The Magnus terms are unbounded near the -243.04 C singularity, so the domain has to be narrow enough
	// that the inverse relation's exponential cannot overflow. The extremes are the worst case.
	expect(relativeHumidity(MAGNUS_MIN_CELSIUS, MAGNUS_MAX_CELSIUS)).toBeFinite()
	expect(relativeHumidity(MAGNUS_MAX_CELSIUS, MAGNUS_MIN_CELSIUS)).toBeGreaterThan(0)
	expect(isMagnusDomain(MAGNUS_MIN_CELSIUS)).toBeTrue()
	expect(isMagnusDomain(MAGNUS_MAX_CELSIUS)).toBeTrue()
	expect(isMagnusDomain(-243.04 + 0.1)).toBeFalse()
	expect(isMagnusDomain(Number.NaN)).toBeFalse()

	for (let temperature = MAGNUS_MIN_CELSIUS; temperature <= MAGNUS_MAX_CELSIUS; temperature += 5) {
		for (let dew = MAGNUS_MIN_CELSIUS; dew <= MAGNUS_MAX_CELSIUS; dew += 5) {
			const humidity = relativeHumidity(temperature, dew)
			expect(humidity).toBeFinite()
			expect(humidity).toBeGreaterThan(0)
		}

		expect(dewPoint(temperature, 1)).toBeFinite()
		expect(dewPoint(temperature, 100)).toBeFinite()
	}
})

test('relative humidity reports supersaturation instead of failing', () => {
	// Saturated air round-trips a hair above the temperature, so a dew point above it must stay usable:
	// it is what a fogged-in station reports, and the Alpaca boundary is where the 0..100 clamp belongs.
	expect(dewPoint(12.5, 100)).toBeGreaterThan(12.5)
	expect(relativeHumidity(12.5, dewPoint(12.5, 100))).toBeCloseTo(100, 10)
	expect(relativeHumidity(20, 22)).toBeGreaterThan(100)
})
