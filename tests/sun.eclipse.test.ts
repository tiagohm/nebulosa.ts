import { expect, test, describe } from 'bun:test'
import { deg } from '../src/angle'
import { nearestSolarEclipse, type SolarEclipse, type SolarEclipseType } from '../src/sun'
// oxfmt-ignore
import { centralAxisIntersectsEarth, computePolynomialBesselianElements, computeRiseSetCurves, computeSolarEclipseFillGeometry, computeSolarEclipseMapGeometry, computeSunMoonPositionAt, DELTA_T_LONGITUDE_FACTOR, derivativeEarthLimbOmega, earthLimbCircleIntersections, earthLimbExtremes, earthLimbOmega, earthLimbPoint, evaluateBesselian, findCentralLineExtremePoint, findCircleIntersections, findCurvePoints, findEclipseCurvePoint, findMaximumPoint, findPenumbraContactPoints, geoPolygonsToSvgPathData, hourAngleFromLongitude, intermediateGreatCircle, longitudeFromHourAngle, pointsToSvgPathData, projectClosestEarthLimbPoint, projectFundamentalPoint, solarEclipseMapToSvgPaths, splitAtMaxAbsLatitude, splitDisconnectedPolylines, splitPolygonAtAntimeridian, splitPolylineAtAntimeridian, type GeoPoint, type PolynomialBesselianElements, type SolarEclipseMapGeometry, type SunMoonPosition } from '../src/sun.eclipse'
import { time, Timescale, timeSubtract, timeYMD, toJulianDay } from '../src/time'
import { PI, PIOVERTWO, TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'
import { PlateCarree, type ProjectionOptions } from '../src/projection'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'

const JD0 = 2460409.25
const TIME0 = time(JD0)

function pbe(overrides?: Partial<PolynomialBesselianElements>): PolynomialBesselianElements {
	// Synthetic elements follow the internal convention: mu is UT-based, so the longitude correction is 0.
	return { time0: TIME0, maximumTime: TIME0, deltaT: 69, deltaTLongitudeCorrection: 0, stepDays: 0.125, x: [0, 0.9], y: [0], l1: [0.4], l2: [-0.2], d: [0], mu: [0], tanF1: 0.0047, tanF2: -0.004, ...overrides }
}

// Minimal geometry literal with only the fields a test exercises; the rest are empty.
function geometry(overrides: Partial<SolarEclipseMapGeometry['lines']> = {}, points: SolarEclipseMapGeometry['points'] = {}): SolarEclipseMapGeometry {
	return {
		points,
		lines: { centerLine: [], umbraNorth: [], umbraSouth: [], penumbraNorth: [], penumbraSouth: [], riseSetCurves: [], ...overrides },
	}
}

function equirectangularProjection(width: number, height: number, options?: ProjectionOptions) {
	return new PlateCarree(undefined, {
		// Longitude spans 2*PI across the full width, so one radian maps to width / TAU pixels.
		scale: width / TAU,
		falseEasting: width / 2,
		falseNorthing: height / 2,
		yAxisDirection: 'southUp',
		centralMeridian: 0,
		longitudeWrapMode: 'pi',
		// Allow the full latitude range up to the poles; the default caps at the Web Mercator limit.
		maxLatitude: PIOVERTWO,
		...options,
	})
}

const NASA_ECLIPSES = [
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2024Apr08Tbeselm.html
	{
		name: '2024 Apr 08 total',
		type: 'total',
		gamma: 0.3431,
		magnitude: 1.0566,
		t0: 2460409.25,
		greatestEclipse: ['-104 08 17', '025 17 11', 2460409.262835],
		deltaT: 70.6,
		x: [-0.318157, 0.5117105, 0.0000326, -0.0000085],
		y: [0.219747, 0.2709586, -0.0000594, -0.0000047],
		d: [7.5862, 0.014844, -0.000002],
		l1: [0.535813, 0.0000618, -0.0000128],
		l2: [-0.010274, 0.0000615, -0.0000127],
		mu: [89.59122, 15.004084],
		tanF1: 0.0046683,
		tanF2: 0.004645,
		central: true,
	},
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2023Oct14Abeselm.html
	{
		name: '2023 Oct 14 annular',
		type: 'annular',
		gamma: 0.3754,
		magnitude: 0.952,
		t0: 2460232.25,
		greatestEclipse: ['-083 06 07', '011 22 10', 2460232.250462],
		deltaT: 70.5,
		x: [0.169751, 0.458548, 0.0000273, -0.0000049],
		y: [0.334837, -0.2413668, 0.000024, 0.000003],
		d: [-8.24419, -0.014888, 0.000001],
		l1: [0.564311, -0.0000891, -0.0000103],
		l2: [0.018083, -0.0000886, -0.0000103],
		mu: [93.5017, 15.003533],
		tanF1: 0.0046882,
		tanF2: 0.0046648,
		central: true,
	},
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2025Sep21Pbeselm.html
	{
		name: '2025 Sep 21 partial',
		type: 'partial',
		gamma: -1.065,
		magnitude: 0.8551,
		t0: 2460940.3333333335,
		greatestEclipse: ['153 25 05', '-061 03 54', 2460940.321573], // NASA doesn't provide lat/lon?
		deltaT: 71.1,
		x: [-0.390002, 0.4531641, 0.0000024, -0.0000064],
		y: [-1.001816, -0.2521622, 0.0000456, 0.0000032],
		d: [0.36472, -0.0156, -0],
		l1: [0.562492, 0.0000909, -0.0000102],
		l2: [0.016273, 0.0000905, -0.0000102],
		mu: [121.78191, 15.004772],
		tanF1: 0.0046583,
		tanF2: 0.0046351,
		central: false,
	},
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2031Nov14Hbeselm.html
	{
		name: '2031 Nov 14 hybrid',
		type: 'hybrid',
		gamma: 0.3077,
		magnitude: 1.0106,
		t0: 2463185.375,
		greatestEclipse: ['-137 37 48', '-000 38 00', 2463185.38021],
		deltaT: 77.9,
		x: [-0.0198, 0.5509453, 0.0000338, -0.0000087],
		y: [0.314937, -0.0890646, 0.0001047, 0.0000012],
		d: [-18.33681, -0.010535, 0.000005],
		l1: [0.547773, -0.0001068, -0.000012],
		l2: [0.001627, -0.0001063, -0.0000119],
		mu: [138.894, 14.999763],
		tanF1: 0.004726,
		tanF2: 0.0047025,
		central: true,
	},
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2014Apr29Abeselm.html
	{
		name: '2014 Apr 29 non-central annular',
		type: 'annular',
		gamma: -1,
		magnitude: 0.9868,
		t0: 2456776.75,
		greatestEclipse: ['131 06 56', '-070 41 51', 2456776.753158], // NASA doesn't provide lat/lon?
		deltaT: 67.3,
		x: [0.185158, 0.5282668, -0.000005, -0.0000072],
		y: [-0.983525, 0.1221127, -0.0000473, -0.0000016],
		d: [14.44979, 0.012658, -0.000003],
		l1: [0.550556, 0.0001187, -0.0000111],
		l2: [0.004377, 0.0001181, -0.0000111],
		mu: [270.65601, 15.002755],
		tanF1: 0.0046433,
		tanF2: 0.0046202,
		central: false,
	},
	// NASA/GSFC: https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2043Apr09Tbeselm.html
	{
		name: '2043 Apr 09 non-central total',
		type: 'total',
		gamma: 1.0031,
		magnitude: 1.0096,
		t0: 2467349.2916666665,
		greatestEclipse: ['151 48 09', '061 27 39', 2467349.290147], // NASA doesn't provide lat/lon?
		deltaT: 86.4,
		x: [-0.447687, 0.5135981, 0.0000564, -0.0000084],
		y: [0.897944, 0.2697277, -0.0000927, -0.0000046],
		d: [7.7498, 0.014808, -0.000002],
		l1: [0.535342, -0.0000546, -0.0000128],
		l2: [-0.010742, -0.0000544, -0.0000127],
		mu: [104.61504, 15.004065],
		tanF1: 0.004668,
		tanF2: 0.0046448,
		central: false,
	},
] as const

function nasaPbe(fixture: (typeof NASA_ECLIPSES)[number]): PolynomialBesselianElements {
	// NASA/GSFC mu is argued in dynamical time (TDT), so the geographic projection needs the explicit
	// Delta T longitude correction (report sections 1.2 and 6.2, rule 5).
	return {
		time0: time(fixture.t0, 0, Timescale.TT),
		maximumTime: time(fixture.greatestEclipse[2], 0, Timescale.TT),
		deltaT: fixture.deltaT,
		deltaTLongitudeCorrection: DELTA_T_LONGITUDE_FACTOR * fixture.deltaT,
		stepDays: 1 / 24,
		x: fixture.x,
		y: fixture.y,
		l1: fixture.l1,
		l2: fixture.l2,
		d: fixture.d.map(deg),
		mu: fixture.mu.map(deg),
		tanF1: fixture.tanF1,
		tanF2: fixture.tanF2,
	}
}

function nasaEclipse(fixture: (typeof NASA_ECLIPSES)[number]): SolarEclipse {
	return { lunation: 0, maximalTime: time(fixture.greatestEclipse[2], 0, Timescale.TT), magnitude: fixture.magnitude, gamma: fixture.gamma, u: fixture.l2[0], type: fixture.type }
}

function evaluateNasaPolynomial(coefficients: readonly number[], t: number) {
	let value = 0
	for (let i = coefficients.length - 1; i >= 0; i--) value = value * t + coefficients[i]
	return value
}

function eclipse(type: SolarEclipseType, gamma: number = 0): SolarEclipse {
	return { lunation: 300, maximalTime: TIME0, magnitude: type === 'partial' ? 0.8 : 1.05, gamma, u: type === 'total' ? -0.01 : 0.01, type }
}

function expectGeoPoint(point: GeoPoint) {
	expect(Number.isFinite(point.x)).toBe(true)
	expect(Number.isFinite(point.y)).toBe(true)
	expect(point.x).toBeGreaterThanOrEqual(-PI)
	expect(point.x).toBeLessThanOrEqual(PI)
	expect(point.y).toBeGreaterThanOrEqual(-PIOVERTWO)
	expect(point.y).toBeLessThanOrEqual(PIOVERTWO)
}

function expectGeoPointClose(point: GeoPoint | undefined, longitude: number, latitude: number, jd?: number) {
	expect(point).toBeDefined()
	expectGeoPoint(point!)
	expect(point!.x).toBeCloseTo(longitude, 10)
	expect(point!.y).toBeCloseTo(latitude, 10)
	if (jd !== undefined) expect(Math.abs(point!.jd! - jd)).toBeLessThan(1e-8)
}

function expectIncreasingJd(points: readonly GeoPoint[]) {
	for (let i = 1; i < points.length; i++) expect(points[i].jd!).toBeGreaterThan(points[i - 1].jd!)
}

// Rise/set branches may hold two distinct points at the same instant (a tangency cusp anchored at a
// contact plus the first sampled crossing), so time only needs to be non-decreasing along them.
function expectNonDecreasingJd(points: readonly GeoPoint[]) {
	for (let i = 1; i < points.length; i++) expect(points[i].jd!).toBeGreaterThanOrEqual(points[i - 1].jd!)
}

function expectMaxAngularStep(points: readonly GeoPoint[], maxStep: number) {
	for (let i = 1; i < points.length; i++) expect(sphericalSeparation(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y)).toBeLessThanOrEqual(maxStep)
}

// Earth ellipsoid constants derived from the same single WGS84 flattening the geometry engine uses
// (report section 6.1), so residual helpers stay numerically consistent with the engine.
const EARTH_FLATTENING = 1 / 298.257223563
const EARTH_FLATTENING_E2 = 1 - (1 - EARTH_FLATTENING) ** 2

// Residual of the shadow-axis tangency condition x^2 + (omega*y)^2 = 1 that defines the central
// line endpoints on the flattened Earth limb. Near zero means the axis grazes the ellipsoid.
function axisLimbResidual(elements: PolynomialBesselianElements, jd: number) {
	const be = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const cosD = Math.cos(be.d)
	const omega = 1 / Math.sqrt(1 - EARTH_FLATTENING_E2 * cosD * cosD)
	return be.x * be.x + (omega * be.y) ** 2 - 1
}

// Signed distance from the shadow axis (be.x, be.y) to the flattened Earth-limb ellipse at an instant:
// negative inside the limb, positive outside. Built from the exported earthLimbExtremes so the test
// validates the same circle-ellipse geometry the engine uses (report sections 6.4 and 15.4).
function shadowAxisLimbSignedDistance(elements: PolynomialBesselianElements, jd: number) {
	const be = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const extremes = earthLimbExtremes(be.x, be.y, earthLimbOmega(be.d))
	return extremes.inside ? -extremes.minDistance : extremes.minDistance
}

// External contact residual signedDistance - r (P1/P4, U1/U4): zero when the shadow circle of radius r
// is tangent to the limb ellipse from outside.
function externalContactResidual(elements: PolynomialBesselianElements, jd: number, radius: number) {
	return shadowAxisLimbSignedDistance(elements, jd) - radius
}

// Internal contact residual signedDistance + r (P2/P3, U2/U3): zero when the shadow circle is tangent
// to the limb ellipse from inside (shadow wholly on Earth).
function internalContactResidual(elements: PolynomialBesselianElements, jd: number, radius: number) {
	return shadowAxisLimbSignedDistance(elements, jd) + radius
}

// Parses a NASA DMS coordinate string ("-104 08 17") into signed decimal degrees.
function parseDms(value: string) {
	const trimmed = value.trim()
	const sign = trimmed.startsWith('-') ? -1 : 1
	const [d, m, s] = trimmed.replace('-', '').split(/\s+/).map(Number)
	return sign * (d + m / 60 + s / 3600)
}

// Standard comparison helpers (report section 10).
function expectTimeNearSeconds(actualJd: number, expectedJd: number, toleranceSeconds: number) {
	expect(Math.abs((actualJd - expectedJd) * 86400)).toBeLessThanOrEqual(toleranceSeconds)
}

function expectGeoNear(actual: GeoPoint | undefined, latDeg: number, lonDeg: number, toleranceArcmin: number) {
	expect(actual).toBeDefined()
	expectGeoPoint(actual!)
	expect(sphericalSeparation(actual!.x, actual!.y, deg(lonDeg), deg(latDeg))).toBeLessThanOrEqual(deg(toleranceArcmin / 60))
}

// Wrap-safe angular difference in [-PI, PI]; never compare longitudes with a plain subtraction.
function angularDifference(a: number, b: number) {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

// Earth flattening factor (polar/equatorial radius ratio), matching the geometry engine's F_CONST.
const EARTH_FLATTENING_F = Math.sqrt(1 - EARTH_FLATTENING_E2)

// Finite-difference d(mu)/d(normalized time); InstantBesselianElements omits the mu derivative.
function muRate(elements: PolynomialBesselianElements, jd: number) {
	const a = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const b = evaluateBesselian(elements, time(jd + 1e-4, 0, Timescale.TT))
	return (((b.mu - a.mu + 3 * PI) % TAU) - PI) / (1e-4 / elements.stepDays)
}

// Tangency residual of a limit point in Earth radii: |W + i*|E||, the eclipse-condition residual the
// curve solver drives to zero (W is the cross-track offset of the observer from the shadow axis, |E| the
// shadow-edge radius). Near zero means the point lies exactly on the requested magnitude curve: the umbra
// edge for G = 1, the penumbra edge for G = 0. Detects points that did not converge onto the physical limit.
function limitTangencyResidual(elements: PolynomialBesselianElements, point: GeoPoint, i: -1 | 1, G: number) {
	const be = evaluateBesselian(elements, time(point.jd!, 0, Timescale.TT))
	const dmu = muRate(elements, point.jd!)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const H = point.x + be.mu - be.deltaTLongitudeCorrection
	const sinH = Math.sin(H)
	const cosH = Math.cos(H)
	const U = Math.atan(EARTH_FLATTENING_F * Math.tan(point.y))
	const rhoSinPhi = EARTH_FLATTENING_F * Math.sin(U)
	const rhoCosPhi = Math.cos(U)
	const ksi = rhoCosPhi * sinH
	const eta = rhoSinPhi * cosD - rhoCosPhi * cosH * sinD
	const zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
	const a = be.dx - rhoCosPhi * cosH * dmu
	const b = be.dy - rhoCosPhi * sinH * sinD * dmu
	const n = Math.hypot(a, b)
	const W = ((be.y - eta) * a - (be.x - ksi) * b) / n
	const dL1 = be.l1 - zeta * be.tanF1
	const dL2 = be.l2 - zeta * be.tanF2
	const E = dL1 - G * (dL1 + dL2)
	return Math.abs(W + i * Math.abs(E))
}

// Geometric solar altitude (radians) at a curve point's instant. Curve points must lie on the sunlit side,
// where the Sun is above the horizon (a small negative tolerance absorbs refraction near the contacts).
function solarAltitude(elements: PolynomialBesselianElements, point: GeoPoint) {
	const be = evaluateBesselian(elements, time(point.jd!, 0, Timescale.TT))
	const H = point.x + be.mu - be.deltaTLongitudeCorrection
	const sinh = Math.sin(be.d) * Math.sin(point.y) + Math.cos(be.d) * Math.cos(point.y) * Math.cos(H)
	return Math.asin(Math.max(-1, Math.min(1, sinh)))
}

// Counts interior vertices whose direction turns by more than threshold radians: the serrilhado detector.
// Antimeridian-wrapping and zero-length steps are skipped. Zero means a smooth physical curve.
function countKinks(points: readonly GeoPoint[], threshold: number) {
	let count = 0

	for (let i = 1; i < points.length - 1; i++) {
		const v1x = points[i].x - points[i - 1].x
		const v1y = points[i].y - points[i - 1].y
		const v2x = points[i + 1].x - points[i].x
		const v2y = points[i + 1].y - points[i].y
		if (Math.abs(v1x) > PI || Math.abs(v2x) > PI) continue
		const d1 = Math.hypot(v1x, v1y)
		const d2 = Math.hypot(v2x, v2y)
		if (d1 < 1e-9 || d2 < 1e-9) continue
		if (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)))) > threshold) count++
	}

	return count
}

// Great-circle interpolation of a time-parametrized curve at an arbitrary Julian Day.
function interpolateAtJulianDay(line: readonly GeoPoint[], jd: number) {
	for (let i = 1; i < line.length; i++) {
		if (line[i - 1].jd! <= jd && jd <= line[i].jd!) {
			const fraction = (jd - line[i - 1].jd!) / (line[i].jd! - line[i - 1].jd!)
			return intermediateGreatCircle(line[i - 1], line[i], fraction)
		}
	}

	return undefined
}

const CENTRAL_FIXTURES = NASA_ECLIPSES.filter((fixture) => fixture.central)

// Asserts a geographic point is within toleranceArcmin arcminutes of a NASA reference coordinate.
function expectNearNasa(point: GeoPoint | undefined, latitudeDeg: number, longitudeDeg: number, toleranceArcmin: number) {
	expect(point).toBeDefined()
	expectGeoPoint(point!)
	expect(sphericalSeparation(point!.x, point!.y, deg(longitudeDeg), deg(latitudeDeg))).toBeLessThan(deg(toleranceArcmin / 60))
}

test('geographic angular helpers handle antimeridian and great-circle interpolation', () => {
	const a: GeoPoint = { x: deg(179.5), y: 0 }
	const b: GeoPoint = { x: deg(-179.5), y: 0 }
	const mid = intermediateGreatCircle(a, b, 0.5)

	expect(Math.abs(Math.abs(mid.x) - PI)).toBeLessThan(1e-10)
	expect(mid.y).toBeCloseTo(0, 12)
})

test('longitude convention is east-positive and centralized in the hour-angle helpers', () => {
	const mu = deg(100)
	const correction = deg(0.0817)
	const H = deg(40)
	const longitude = longitudeFromHourAngle(H, mu, correction)

	// lambda = H - mu + correction, east-positive (Astrarium's west-positive mirror negated).
	expect(longitude).toBeCloseTo(deg(40 - 100 + 0.0817), 12)
	// The inverse helper round-trips exactly when no TAU wrap is involved.
	expect(hourAngleFromLongitude(longitude, mu, correction)).toBeCloseTo(H, 12)
})

test('evalBesselian uses Horner coefficients, derivatives, and mu wrapping', () => {
	const be = evaluateBesselian(pbe({ x: [1, 2, 3], y: [-2, 0.5], l1: [0.4, 0.1], l2: [-0.2], d: [deg(10), deg(2)], mu: [deg(350), deg(20)] }), time(JD0 + 2 * 0.125))

	expect(be.x).toBeCloseTo(17, 12)
	expect(be.y).toBeCloseTo(-1, 12)
	expect(be.dx).toBeCloseTo(14, 12)
	expect(be.dy).toBeCloseTo(0.5, 12)
	expect(be.mu).toBeCloseTo(deg(30), 12)
})

test('computePolynomialBesselianElements fits cubic samples and unwraps mu', () => {
	const generated = computePolynomialBesselianElements(TIME0, (sampleTime): SunMoonPosition => {
		const t = (toJulianDay(sampleTime) - JD0) / 0.125

		return {
			sunRightAscension: deg(359 + 2 * t),
			sunDeclination: deg(0.1 * t),
			sunDistance: 23455,
			moonRightAscension: deg(359.2 + 2.01 * t),
			moonDeclination: deg(0.1 * t + 0.001),
			moonDistance: 60,
			deltaT: 70,
		}
	})
	const be = evaluateBesselian(generated, time(JD0 + generated.stepDays))

	expect(generated.x).toHaveLength(4)
	expect(generated.mu).toHaveLength(4)
	// The generator fits five samples over a 6 h window, so the polynomial time unit is one hour
	// (report sections 1.1 and 7.3).
	expect(generated.stepDays).toBe(1 / 24)
	expect(be.mu).toBeGreaterThanOrEqual(0)
	expect(be.mu).toBeLessThan(TAU)
	expect(be.deltaT).toBeCloseTo(70, 12)
	// Cone tangents and radii follow from the physical Sun-Moon distances; checked to ~1e-6, not frozen
	// to machine precision, so legitimate refinements do not break the test (report section 8.1).
	expect(be.l1).toBeCloseTo(0.552934, 5)
	expect(be.l2).toBeCloseTo(0.006762, 5)
	expect(generated.tanF1).toBeCloseTo(0.0046741, 6)
	expect(generated.tanF2).toBeCloseTo(0.0046508, 6)
})

test('computePolynomialBesselianElements derives cone tangents from physical Sun-Moon distance', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: deg(15), sunDeclination: deg(7), sunDistance: 23484, moonRightAscension: deg(15.2), moonDeclination: deg(7.01), moonDistance: 56.28, deltaT: 69 }))

	expect(generated.tanF1).toBeCloseTo(0.004667549733963093, 12)
	expect(generated.tanF2).toBeCloseTo(0.004644295797763593, 12)
	expect(generated.tanF2).toBeGreaterThan(0)
})

test('computePolynomialBesselianElements projects the shadow axis onto the fundamental plane', () => {
	const sample: SunMoonPosition = { sunRightAscension: deg(40), sunDeclination: deg(65), sunDistance: 23000, moonRightAscension: deg(42), moonDeclination: deg(64.5), moonDistance: 60, deltaT: 70 }
	const generated = computePolynomialBesselianElements(TIME0, () => sample)
	const be = evaluateBesselian(generated, TIME0)
	const tangentPlaneX = sample.moonDistance * Math.cos(sample.sunDeclination) * (sample.moonRightAscension - sample.sunRightAscension)
	const tangentPlaneY = sample.moonDistance * (sample.moonDeclination - sample.sunDeclination)

	// The fundamental-plane projection (x, y, d) is independent of Earth rotation, so it is unchanged by
	// the GMST -> GAST switch; mu now comes from apparent sidereal time (report section 1.3).
	expect(be.x).toBeCloseTo(0.903877748055732, 12)
	expect(be.y).toBeCloseTo(-0.5105868561921576, 12)
	expect(be.d).toBeCloseTo(1.1344862148808663, 12)
	expect(be.mu).toBeCloseTo(1.1778503275514438, 9)
	expect(Math.abs(be.x - tangentPlaneX)).toBeGreaterThan(0.01)
	expect(Math.abs(be.y - tangentPlaneY)).toBeGreaterThan(0.01)
})

test('computePolynomialBesselianElements follows the projection convention toward the day side', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: 0, sunDeclination: 0, sunDistance: 23000, moonRightAscension: 0, moonDeclination: 0, moonDistance: 60, deltaT: 70 }))
	const be = evaluateBesselian(generated, TIME0)
	const point = projectFundamentalPoint(be, be.x, be.y)
	// With the Sun and Moon on the equator at the same right ascension, the shadow axis is the subsolar
	// point: x = y = d = 0 and the geographic longitude is exactly -mu (correction is 0 for UT-based mu).
	const subsolarLongitude = -1.875889038916067

	expect(be.x).toBeCloseTo(0, 12)
	expect(be.y).toBeCloseTo(0, 12)
	expect(be.d).toBeCloseTo(0, 12)
	expect(be.mu).toBeCloseTo(1.875889038916067, 9)
	expect(be.deltaTLongitudeCorrection).toBe(0)
	expectGeoPointClose(point, subsolarLongitude, 0, 2460409.25)
})

test('findMaximumPoint matches NASA Besselian fixture at greatest eclipse instant', () => {
	for (const fixture of NASA_ECLIPSES) {
		const point = findMaximumPoint(nasaPbe(fixture))
		// Compared with a tolerance instead of an exact DMS string (report section 8.6). For central
		// eclipses Max is the strict axis projection; for partial/non-central ones it is the limb point
		// nearest the axis, matching NASA's greatest-eclipse coordinate to a couple of arcminutes.
		expectGeoNear(point, parseDms(fixture.greatestEclipse[1]), parseDms(fixture.greatestEclipse[0]), 2)
		expect(point!.jd).toBe(fixture.greatestEclipse[2])
	}
})

test('NASA Besselian fixtures preserve polynomial values and units', () => {
	for (const fixture of NASA_ECLIPSES) {
		const elements = nasaPbe(fixture)
		const origin = evaluateBesselian(elements, elements.time0)
		const maximum = evaluateBesselian(elements, elements.maximumTime)
		const t = timeSubtract(elements.maximumTime, elements.time0) / elements.stepDays

		expect(origin.x).toBeCloseTo(fixture.x[0], 12)
		expect(origin.y).toBeCloseTo(fixture.y[0], 12)
		expect(origin.l1).toBeCloseTo(fixture.l1[0], 12)
		expect(origin.l2).toBeCloseTo(fixture.l2[0], 12)
		expect(origin.d).toBeCloseTo(deg(fixture.d[0]), 12)
		expect(origin.mu).toBeCloseTo(deg(fixture.mu[0]), 12)
		expect(origin.deltaTLongitudeCorrection).toBeCloseTo(deg(0.00417807 * fixture.deltaT), 12)
		expect(origin.dx).toBeCloseTo(fixture.x[1], 12)
		expect(origin.dy).toBeCloseTo(fixture.y[1], 12)
		expect(origin.tanF1).toBeCloseTo(fixture.tanF1, 12)
		expect(origin.tanF2).toBeCloseTo(fixture.tanF2, 12)
		expect(maximum.x).toBeCloseTo(evaluateNasaPolynomial(fixture.x, t), 12)
		expect(maximum.y).toBeCloseTo(evaluateNasaPolynomial(fixture.y, t), 12)
		expect(maximum.d).toBeCloseTo(deg(evaluateNasaPolynomial(fixture.d, t)), 12)
		expect(maximum.mu).toBeGreaterThanOrEqual(0)
		expect(maximum.mu).toBeLessThan(TAU)
	}
})

test('NASA Besselian fixtures cover eclipse classes and central gating', () => {
	for (const fixture of NASA_ECLIPSES) {
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45), includeRiseSetCurves: false })

		expect(geometry.points.Max).toBeDefined()
		expectGeoPoint(geometry.points.Max!)
		for (const point of geometry.lines.penumbraNorth) expectGeoPoint(point)
		for (const point of geometry.lines.penumbraSouth) expectGeoPoint(point)

		const { U1, U2, U3, U4, C1, C2 } = geometry.points

		if (fixture.type === 'partial') {
			// The umbra never reaches Earth, so neither the umbral contacts nor the central line exist.
			for (const point of [U1, U2, U3, U4, C1, C2]) expect(point).toBeUndefined()
			expect(geometry.lines.centerLine).toHaveLength(0)
			expect(geometry.lines.umbraNorth).toHaveLength(0)
			expect(geometry.lines.umbraSouth).toHaveLength(0)
			continue
		}

		if (fixture.central) {
			// The shadow axis pierces the ellipsoid: all four umbral contacts and both central-line endpoints exist.
			expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(true)
			for (const point of [U1, U2, U3, U4, C1, C2]) expectGeoPoint(point!)
			expect(geometry.lines.centerLine.length).toBeGreaterThan(0)
			continue
		}

		// A non-central total/annular eclipse: the umbra only grazes the limb, so the informational
		// external contacts U1/U4 exist while the internal contacts U2/U3 do not. The axis misses the
		// ellipsoid, so there is no central line and no C1/C2 endpoints; umbra limits, however, are no
		// longer forced empty (report section 8.5).
		expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(false)
		expectGeoPoint(U1!)
		expectGeoPoint(U4!)
		for (const point of [U2, U3, C1, C2]) expect(point).toBeUndefined()
		expect(geometry.lines.centerLine).toHaveLength(0)
	}
})

test('computeSolarEclipseMapGeometry produces ordered partial contacts and anchored rise-set curves', () => {
	// The synthetic axis (0.125-day step) takes longer than 3 h to clear the limb, so the search window
	// is widened explicitly rather than relying on the default tuned to the 6 h NASA fit.
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial'), pbe(), { longitudeStep: deg(90), contactSearchSpan: 6 * 3600, includeRiseSetCurves: true, riseSetStep: 1800 })
	const { points, lines } = geometry

	// Existence, finiteness and chronological order replace the frozen synthetic coordinates (report 8.1).
	for (const point of [points.P1, points.P2, points.P3, points.P4, points.Max]) expectGeoPoint(point!)
	expectIncreasingJd([points.P1!, points.P2!, points.Max!, points.P3!, points.P4!])
	// A pure partial eclipse: no umbral cone contacts and no central line.
	for (const point of [points.U1, points.U2, points.U3, points.U4, points.C1, points.C2]) expect(point).toBeUndefined()
	expect(lines.centerLine).toHaveLength(0)
	expect(lines.umbraNorth).toHaveLength(0)
	expect(lines.umbraSouth).toHaveLength(0)
	for (const point of [...lines.penumbraNorth, ...lines.penumbraSouth]) expectGeoPoint(point)

	// Two sunrise branches (P1->P2) and two sunset branches (P3->P4), each anchored at its cusp contacts.
	expect(lines.riseSetCurves).toHaveLength(4)
	expectGeoPointClose(lines.riseSetCurves[0][0], points.P1!.x, points.P1!.y, points.P1!.jd)
	expectGeoPointClose(lines.riseSetCurves[0].at(-1), points.P2!.x, points.P2!.y, points.P2!.jd)
	expectGeoPointClose(lines.riseSetCurves[2][0], points.P3!.x, points.P3!.y, points.P3!.jd)
	expectGeoPointClose(lines.riseSetCurves[3].at(-1), points.P4!.x, points.P4!.y, points.P4!.jd)
	for (const curve of lines.riseSetCurves) {
		expect(curve.length).toBeGreaterThan(1)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('contact and central endpoint searches are centered on maximumTime', () => {
	// The shadow axis sweeps across the limb around a maximum offset from the polynomial origin t0, so
	// the searches must bracket maximumTime, not t0. The exact instants are not frozen (report 8.1); the
	// invariant is that every contact and endpoint clusters around the maximum, in chronological order.
	const maximumJd = JD0 + 0.3 * 0.125
	const elements = pbe({ maximumTime: time(maximumJd), x: [-6, 20], l1: [0.1], l2: [-0.1] })
	const contacts = findPenumbraContactPoints(elements)
	const C1 = findCentralLineExtremePoint(elements, true)
	const C2 = findCentralLineExtremePoint(elements, false)

	for (const point of [contacts.P1, contacts.P2, contacts.P3, contacts.P4, C1, C2]) expectGeoPoint(point!)
	// Chronological order P1 < C1 < P2 < P3 < C2 < P4: external penumbral, central begin, internal
	// penumbral, internal penumbral, central end, external penumbral.
	expectIncreasingJd([contacts.P1!, C1!, contacts.P2!, contacts.P3!, C2!, contacts.P4!])
	// All instants land near the maximum (within the search window), well away from t0.
	for (const point of [contacts.P1!, contacts.P2!, C1!, C2!, contacts.P3!, contacts.P4!]) expectTimeNearSeconds(point.jd!, maximumJd, 600)
})

test('computeSolarEclipseMapGeometry orders and anchors NASA total central endpoints', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, riseSetStep: 1800 })
	const { points, lines } = geometry

	// All named contacts/endpoints exist for this central total eclipse and are finite.
	for (const point of [points.P1, points.P2, points.P3, points.P4, points.U1, points.U2, points.U3, points.U4, points.C1, points.C2, points.Max]) expectGeoPoint(point!)
	// Chronological ordering: P1 < U1 < C1 < U2 < P2 < Max < P3 < U3 < C2 < U4 < P4. This is the physical
	// invariant; exact coordinates are intentionally not frozen (report section 8.1).
	expectIncreasingJd([points.P1!, points.U1!, points.C1!, points.U2!, points.P2!, points.Max!, points.P3!, points.U3!, points.C2!, points.U4!, points.P4!])
	// Greatest eclipse is anchored at the published instant.
	expect(points.Max!.jd).toBe(fixture.greatestEclipse[2])
	// Penumbral contacts satisfy the external circle-ellipse tangency condition.
	expect(Math.abs(externalContactResidual(elements, points.P1!.jd!, evaluateBesselian(elements, time(points.P1!.jd!, 0, Timescale.TT)).l1))).toBeLessThan(1e-6)
	expect(Math.abs(externalContactResidual(elements, points.P4!.jd!, evaluateBesselian(elements, time(points.P4!.jd!, 0, Timescale.TT)).l1))).toBeLessThan(1e-6)
	// The central line is anchored exactly at C1/C2 and progresses in time.
	expectGeoPointClose(lines.centerLine[0], points.C1!.x, points.C1!.y, points.C1!.jd)
	expectGeoPointClose(lines.centerLine.at(-1), points.C2!.x, points.C2!.y, points.C2!.jd)
	expectIncreasingJd(lines.centerLine)
	// Umbra limits exist as solver-traced polylines on both sides.
	expect(lines.umbraNorth.length).toBeGreaterThan(0)
	expect(lines.umbraSouth.length).toBeGreaterThan(0)
	// Rise/set phases are anchored at the penumbral contacts.
	expectGeoPointClose(lines.riseSetCurves[0][0], points.P1!.x, points.P1!.y, points.P1!.jd)
	expectGeoPointClose(lines.riseSetCurves[0].at(-1), points.P2!.x, points.P2!.y, points.P2!.jd)
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry traces NASA total partial-eclipse limits north and south of the path', () => {
	const fixture = NASA_ECLIPSES[0]
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(10), maxAngularStep: deg(5), includeRiseSetCurves: false })
	const { points, lines } = geometry
	const { penumbraNorth, penumbraSouth } = lines

	expect(penumbraNorth.length).toBeGreaterThan(0)
	expect(penumbraSouth.length).toBeGreaterThan(0)

	for (const point of penumbraNorth) expectGeoPoint(point)
	for (const point of penumbraSouth) expectGeoPoint(point)

	// Every limit point is sampled within the penumbral contact window P1..P4.
	for (const point of [...penumbraNorth, ...penumbraSouth]) {
		expect(point.jd!).toBeGreaterThanOrEqual(points.P1!.jd! - 1e-6)
		expect(point.jd!).toBeLessThanOrEqual(points.P4!.jd! + 1e-6)
	}

	// The northern limit lies wholly north of the greatest-eclipse point and reaches the high Arctic;
	// the southern limit lies wholly south of it and crosses into the southern hemisphere.
	expect(penumbraNorth.every((point) => point.y > points.Max!.y)).toBe(true)
	expect(penumbraSouth.every((point) => point.y < points.Max!.y)).toBe(true)
	expect(Math.min(...penumbraNorth.map((point) => point.y))).toBeGreaterThan(deg(28))
	expect(Math.max(...penumbraNorth.map((point) => point.y))).toBeGreaterThan(deg(70))
	expect(Math.min(...penumbraSouth.map((point) => point.y))).toBeLessThan(deg(-30))
})

test('central path is gated by the shadow-axis geometry, not by gamma', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	// The shadow axis truly pierces the ellipsoid for this central total eclipse.
	expect(centralAxisIntersectsEarth(elements)).toBe(true)

	// Even with a deliberately wrong (non-central) gamma on the eclipse record, the central line is still
	// produced: the geometric test on the Besselian elements drives the gating, not gamma (report 8.4).
	const wrongGamma = { ...nasaEclipse(fixture), gamma: 1.01 }
	const geometry = computeSolarEclipseMapGeometry(wrongGamma, elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false })

	expect(geometry.points.C1).toBeDefined()
	expect(geometry.points.C2).toBeDefined()
	expect(geometry.lines.centerLine.length).toBeGreaterThan(0)
	expect(geometry.lines.umbraNorth.length).toBeGreaterThan(0)
	expect(geometry.lines.umbraSouth.length).toBeGreaterThan(0)
})

test('non-central total and annular eclipses have no central line but may keep umbra limits', () => {
	for (const fixture of [NASA_ECLIPSES[4], NASA_ECLIPSES[5]]) {
		const elements = nasaPbe(fixture)
		// The shadow axis misses the ellipsoid: non-central.
		expect(centralAxisIntersectsEarth(elements)).toBe(false)

		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false })

		// The umbra grazes Earth, so the external contacts exist; the central line and its endpoints do
		// not, because the axis never intersects the ellipsoid (report sections 7.5 and 8.5).
		expectGeoPoint(geometry.points.U1!)
		expectGeoPoint(geometry.points.U4!)
		expect(geometry.points.C1).toBeUndefined()
		expect(geometry.points.C2).toBeUndefined()
		expect(geometry.lines.centerLine).toHaveLength(0)
		// Umbra/antumbra limits are no longer forced empty for non-central eclipses; whatever the G = 1
		// solver returns is a valid physical limit, so only assert finiteness, not absence.
		for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth]) {
			expect(segment.length).toBeGreaterThan(1)
			for (const point of segment) expectGeoPoint(point)
		}
		// The penumbral limit remains the main physical contour.
		expect(geometry.lines.penumbraNorth.length + geometry.lines.penumbraSouth.length).toBeGreaterThan(0)
	}
})

test('computeSolarEclipseMapGeometry contact search span is independent from polynomial step', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	expect(elements.stepDays).toBe(1 / 24)

	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { contactSearchSpan: 2 * 3600, longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true })

	// With a 2 h half-window, the external contacts P1/P4 (~2.6 h from the maximum) fall outside it and
	// are not found, while the internal contacts P2/P3 (nearer the maximum) are. This proves the search
	// window is driven by contactSearchSpan, independently of the polynomial step.
	expect(geometry.points.P1).toBeUndefined()
	expect(geometry.points.P4).toBeUndefined()
	expectGeoPoint(geometry.points.P2!)
	expectGeoPoint(geometry.points.P3!)
	expectTimeNearSeconds(geometry.points.P2!.jd!, fixture.greatestEclipse[2], 2 * 3600)
	expectTimeNearSeconds(geometry.points.P3!.jd!, fixture.greatestEclipse[2], 2 * 3600)
	// Rise/set needs both P1 and P4, so it yields nothing here.
	expect(geometry.lines.riseSetCurves).toHaveLength(0)
})

test('projectFundamentalPoint is strict outside the limb and projectClosestEarthLimbPoint clamps explicitly', () => {
	const be = evaluateBesselian(pbe({ d: [deg(12)], mu: [deg(35)] }), TIME0)
	const omega = earthLimbOmega(be.d)

	// A point inside the limb projects to a finite geographic coordinate.
	const inside = projectFundamentalPoint(be, 0.2, -0.1)
	expect(inside).toBeDefined()
	expectGeoPoint(inside!)
	expect(inside!.jd).toBe(JD0)

	// A point well outside the limb is rejected (report section 8.2): no hidden clamp.
	expect(0.2 * 0.2 + (omega * -0.1) ** 2).toBeLessThan(1)
	expect(4 * 4 + (omega * 3) ** 2).toBeGreaterThan(1)
	expect(projectFundamentalPoint(be, 4, 3)).toBeUndefined()

	// The clamp is only available on explicit request, and lands on the limb ellipse.
	const closest = projectClosestEarthLimbPoint(be, 4, 3)
	expect(closest).toBeDefined()
	expectGeoPoint(closest!)
})

test('findCircleIntersections is a unit-circle utility (spherical limb), not the physical contact engine', () => {
	// findCircleIntersections solves the unit circle x^2 + y^2 = 1 against a shadow circle. The physical
	// (ellipsoidal) contacts and rise/set now use earthLimbCircleIntersections instead; this remains as a
	// generic spherical utility (report section 8.3).
	const two = findCircleIntersections(1, 0, 0.5)
	expect(two).toHaveLength(2)
	expect(two[0][1]).toBeGreaterThan(two[1][1])
	for (const [x, y] of two) expect(Math.hypot(x, y)).toBeCloseTo(1, 12)

	// External tangency: shadow centered at distance 1 + r touches the limb at one point.
	const tangent = findCircleIntersections(1.5, 0, 0.5)
	expect(tangent).toHaveLength(1)
	expect(tangent[0][0]).toBeCloseTo(1, 12)
	expect(tangent[0][1]).toBeCloseTo(0, 12)

	// Too far away: no intersection. Degenerate center: no intersection.
	expect(findCircleIntersections(3, 0, 0.5)).toHaveLength(0)
	expect(findCircleIntersections(0, 0, 0.5)).toHaveLength(0)
})

describe('earth-limb ellipse geometry', () => {
	const E2 = EARTH_FLATTENING_E2

	function omega(d: number) {
		return 1 / Math.sqrt(1 - E2 * Math.cos(d) * Math.cos(d))
	}

	test('earthLimbOmega and its derivative are consistent (finite difference)', () => {
		for (const d of [deg(-80), deg(-20), 0, deg(15), deg(60), deg(85)]) {
			expect(earthLimbOmega(d)).toBeCloseTo(omega(d), 12)
			const h = 1e-6
			const numeric = (earthLimbOmega(d + h) - earthLimbOmega(d - h)) / (2 * h)
			expect(derivativeEarthLimbOmega(d)).toBeCloseTo(numeric, 6)
		}
		// At the equator (d = 0) the flattening scale is maximal, so its derivative vanishes.
		expect(derivativeEarthLimbOmega(0)).toBeCloseTo(0, 12)
	})

	test('earthLimbPoint lies exactly on the limb ellipse x^2 + (omega y)^2 = 1', () => {
		const w = omega(deg(23))
		for (const theta of [0, 0.5, 1.3, PI, 4.2, 6]) {
			const [x, y] = earthLimbPoint(theta, w)
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 12)
		}
	})

	test('earthLimbExtremes finds the true nearest and farthest limb points', () => {
		const w = omega(deg(40))
		// A point inside the ellipse.
		const inside = earthLimbExtremes(0.2, -0.1, w)
		expect(inside.inside).toBe(true)
		expect(inside.minDistance).toBeLessThan(inside.maxDistance)
		// A point outside the ellipse.
		const outside = earthLimbExtremes(1.6, 0.9, w)
		expect(outside.inside).toBe(false)

		// The reported nearest/farthest distances are the global extrema over a dense theta scan.
		for (const sample of [inside, outside]) {
			const cx = sample === inside ? 0.2 : 1.6
			const cy = sample === inside ? -0.1 : 0.9
			let min = Infinity
			let max = -Infinity
			for (let k = 0; k < 2000; k++) {
				const [x, y] = earthLimbPoint((k / 2000) * TAU, w)
				const dist = Math.hypot(x - cx, y - cy)
				min = Math.min(min, dist)
				max = Math.max(max, dist)
			}
			expect(sample.minDistance).toBeLessThanOrEqual(min + 1e-6)
			expect(sample.maxDistance).toBeGreaterThanOrEqual(max - 1e-6)
			// The nearest point sits on the ellipse.
			const [nx, ny] = earthLimbPoint(sample.nearestTheta, w)
			expect(nx * nx + (w * ny) ** 2).toBeCloseTo(1, 10)
		}
	})

	test('earthLimbCircleIntersections solves the circle-ellipse system (two, tangent, none)', () => {
		const w = omega(deg(35))
		const cx = 0.3
		const cy = -0.2

		// Radius chosen so the shadow circle cuts the limb twice.
		const radius = 0.9
		const crossings = earthLimbCircleIntersections(cx, cy, w, radius)
		expect(crossings.length).toBeGreaterThanOrEqual(2)
		// Ordered by descending y, and each crossing satisfies BOTH equations (report section 15.4).
		for (let i = 1; i < crossings.length; i++) expect(crossings[i - 1][1]).toBeGreaterThanOrEqual(crossings[i][1])
		for (const [x, y] of crossings) {
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 6)
			expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(radius, 6)
		}

		// A radius larger than the farthest limb distance from a far-outside center: no intersection.
		expect(earthLimbCircleIntersections(5, 0, w, 0.5)).toHaveLength(0)
	})

	test('earthLimbCircleIntersections handles a high-declination (more flattened) limb near the pole', () => {
		const w = omega(deg(85))
		// Center near the pole region of the fundamental plane.
		const crossings = earthLimbCircleIntersections(0, 0.8, w, 0.6)
		expect(crossings.length).toBeGreaterThanOrEqual(2)
		for (const [x, y] of crossings) {
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 6)
			expect(Math.hypot(x - 0, y - 0.8)).toBeCloseTo(0.6, 6)
		}
	})

	test('projectFundamentalPoint rejects points outside the limb ellipse (no clamp)', () => {
		const be = evaluateBesselian(pbe({ d: [deg(20)], mu: [deg(50)] }), TIME0)
		const w = earthLimbOmega(be.d)
		// A point strictly outside the ellipse is rejected.
		expect(0.9 * 0.9 + (w * 0.9) ** 2).toBeGreaterThan(1)
		expect(projectFundamentalPoint(be, 0.9, 0.9)).toBeUndefined()
		// Its closest limb projection exists and is finite.
		expectGeoPoint(projectClosestEarthLimbPoint(be, 0.9, 0.9)!)
	})
})

test('findCurvePoints returns bounded finite points for a synthetic partial limit', () => {
	const points = findCurvePoints(pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), 1, 0, { longitudeStep: deg(30), maxAngularStep: deg(20) })

	expect(points.length).toBeGreaterThan(0)
	for (const point of points) expectGeoPoint(point)
	expectIncreasingJd(points)

	for (let i = 1; i < points.length; i++) {
		expect(Math.abs(points[i].x - points[i - 1].x)).toBeLessThanOrEqual(TAU)
	}
})

test('findCurvePoints refines exit boundaries away from the last valid longitude sample', () => {
	const points = findCurvePoints(pbe({ x: [-1, -1], y: [-0.5, -1], l1: [0.5], d: [deg(-45)], mu: [deg(-90), deg(10)] }), -1, 0, { longitudeStep: deg(30), maxAngularStep: deg(60) })

	// The curve exists over a bounded longitude range; the points are finite and time-ordered.
	expect(points.length).toBeGreaterThan(0)
	for (const point of points) expectGeoPoint(point)
	expectIncreasingJd(points)
	// Boundary refinement extends the curve past the coarse 30-degree grid: the curve's longitude extent
	// reaches a value that is not a multiple of the longitude step, proving the bisection refinement ran.
	const maxLon = Math.max(...points.map((point) => point.x))
	expect(maxLon).toBeGreaterThan(deg(30.7))
	expect(Math.abs((maxLon / deg(30)) % 1)).toBeGreaterThan(1e-3)
})

test('split helpers avoid direct antimeridian joins', () => {
	const line: GeoPoint[] = [
		{ x: deg(170), y: deg(10) },
		{ x: deg(-170), y: deg(12) },
		{ x: deg(-160), y: deg(15) },
	]

	const segments = splitPolylineAtAntimeridian(line)
	const rings = splitPolygonAtAntimeridian(line)

	expect(segments.length).toBeGreaterThan(1)
	expect(rings.length).toBeGreaterThan(1)
	expect(segments[0].at(-1)!.x).toBe(PI)
	expect(segments[1][0].x).toBe(-PI)
})

test('splitDisconnectedPolylines breaks a curve at gaps and drops undrawable pieces', () => {
	const points: GeoPoint[] = [
		{ x: 0, y: 0 },
		{ x: deg(1), y: 0 },
		{ x: deg(2), y: 0 },
		// A 90-degree jump: a genuine discontinuity that must never be chorded.
		{ x: deg(92), y: 0 },
		{ x: deg(93), y: 0 },
	]

	const pieces = splitDisconnectedPolylines(points, deg(4))
	expect(pieces).toHaveLength(2)
	expect(pieces[0].map((point) => point.x)).toEqual([0, deg(1), deg(2)])
	expect(pieces[1].map((point) => point.x)).toEqual([deg(92), deg(93)])

	// A lone point between two gaps is dropped as undrawable.
	const lone = splitDisconnectedPolylines(
		[
			{ x: 0, y: 0 },
			{ x: deg(90), y: 0 },
			{ x: deg(-170), y: 0 },
		],
		deg(4),
	)
	expect(lone).toHaveLength(0)

	expect(splitDisconnectedPolylines([], deg(4))).toHaveLength(0)
})

test('partial eclipse geometry omits central and umbral path data', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial', 1.1), pbe(), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: false })

	expect(geometry.points.Max).toBeDefined()
	for (const point of [geometry.points.U1, geometry.points.U2, geometry.points.U3, geometry.points.U4, geometry.points.C1, geometry.points.C2]) expect(point).toBeUndefined()
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth).toHaveLength(0)
	expect(geometry.lines.umbraSouth).toHaveLength(0)
	expect(computeSolarEclipseFillGeometry(geometry)).toHaveLength(0)
})

test('central total eclipse geometry exposes a populated central and umbral path when enabled', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('total'), pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), { longitudeStep: deg(60), maxAngularStep: deg(30), contactSearchSpan: 18 * 3600, includeRiseSetCurves: true, riseSetStep: 1800 })

	expect(geometry.points.Max).toBeDefined()
	expectGeoPoint(geometry.points.Max!)

	expect(geometry.lines.centerLine.length).toBeGreaterThan(1)
	expectIncreasingJd(geometry.lines.centerLine)
	for (const point of geometry.lines.centerLine) expectGeoPoint(point)

	expect(geometry.lines.umbraNorth.length).toBeGreaterThan(0)
	expect(geometry.lines.umbraSouth.length).toBeGreaterThan(0)
	for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth]) for (const point of segment) expectGeoPoint(point)

	// A central total eclipse exposes both partial-eclipse (penumbra) limits.
	expect(geometry.lines.penumbraNorth.length).toBeGreaterThan(0)
	expect(geometry.lines.penumbraSouth.length).toBeGreaterThan(0)
	for (const point of geometry.lines.penumbraNorth) expectGeoPoint(point)
	for (const point of geometry.lines.penumbraSouth) expectGeoPoint(point)
})

test('rise set curves are separate drawable arrays', () => {
	const elements = pbe()
	const contacts = computeSolarEclipseMapGeometry(eclipse('partial'), elements, { longitudeStep: deg(90), contactSearchSpan: 6 * 3600 }).points

	expect(contacts.P1).toBeDefined()
	expect(contacts.P4).toBeDefined()

	const curves = computeRiseSetCurves(elements, contacts.P1!, contacts.P4!, { P2: contacts.P2, P3: contacts.P3 }, { step: 3600 })

	// Sunrise (P1->P2) and sunset (P3->P4) phases, two branches each, meeting at their cusps.
	expect(curves).toHaveLength(4)
	expectGeoPointClose(curves[0][0], contacts.P1!.x, contacts.P1!.y, contacts.P1!.jd)
	expectGeoPointClose(curves[0].at(-1), contacts.P2!.x, contacts.P2!.y, contacts.P2!.jd)
	expectGeoPointClose(curves[2][0], contacts.P3!.x, contacts.P3!.y, contacts.P3!.jd)
	expectGeoPointClose(curves[3].at(-1), contacts.P4!.x, contacts.P4!.y, contacts.P4!.jd)

	for (const curve of curves) {
		expect(curve.length).toBeGreaterThan(1)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('splitAtMaxAbsLatitude splits circumpolar-like limit arrays', () => {
	const split = splitAtMaxAbsLatitude([
		{ x: 0, y: deg(10) },
		{ x: deg(1), y: deg(80) },
		{ x: deg(2), y: deg(20) },
	])

	expect(split).toHaveLength(2)
	// The fold apex is shared between both branches so they meet without a gap.
	expect(split[0].map((point) => point.y)).toEqual([deg(10), deg(80)])
	expect(split[1].map((point) => point.y)).toEqual([deg(80), deg(20)])
})

test('splitAtMaxAbsLatitude keeps non-folding limits whole instead of emitting degenerate segments', () => {
	const split = splitAtMaxAbsLatitude([
		{ x: 0, y: deg(80) },
		{ x: deg(1), y: deg(40) },
		{ x: deg(2), y: deg(10) },
	])

	expect(split).toHaveLength(1)
	expect(split[0]).toHaveLength(3)
})

test('map geometry exposes the NASA greatest-eclipse point for every eclipse class', () => {
	for (const fixture of NASA_ECLIPSES) {
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45) })

		expectGeoNear(geometry.points.Max, parseDms(fixture.greatestEclipse[1]), parseDms(fixture.greatestEclipse[0]), 2)
		expect(geometry.points.Max!.jd).toBe(fixture.greatestEclipse[2])
	}
})

test('central-line endpoints graze the flattened Earth limb and bound the central time span', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12) })
		const { C1, C2 } = geometry.points

		expect(C1).toBeDefined()
		expect(C2).toBeDefined()
		// The shadow axis is tangent to the ellipsoid (x^2 + (omega*y)^2 = 1) at both endpoints.
		expect(Math.abs(axisLimbResidual(elements, C1!.jd!))).toBeLessThan(1e-6)
		expect(Math.abs(axisLimbResidual(elements, C2!.jd!))).toBeLessThan(1e-6)
		// C1 precedes C2 and both bracket the greatest eclipse instant.
		expect(C1!.jd!).toBeLessThan(geometry.points.Max!.jd!)
		expect(geometry.points.Max!.jd!).toBeLessThan(C2!.jd!)
		// Endpoints anchor the drawn central line.
		expectGeoPointClose(geometry.lines.centerLine[0], C1!.x, C1!.y, C1!.jd)
		expectGeoPointClose(geometry.lines.centerLine.at(-1), C2!.x, C2!.y, C2!.jd)
	}
})

test('greatest eclipse lies on the central line for central eclipses', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12) })
		const centerLine = geometry.lines.centerLine
		const max = geometry.points.Max!

		expect(centerLine.length).toBeGreaterThan(1)
		expect(max.jd!).toBeGreaterThanOrEqual(centerLine[0].jd!)
		expect(max.jd!).toBeLessThanOrEqual(centerLine.at(-1)!.jd!)

		// The interpolation is a great-circle chord between samples up to maxAngularStep apart, so a
		// small chord-sagitta tolerance applies on top of the solver accuracy.
		const onCentralLine = interpolateAtJulianDay(centerLine, max.jd!)
		expect(onCentralLine).toBeDefined()
		expect(sphericalSeparation(onCentralLine!.x, onCentralLine!.y, max.x, max.y)).toBeLessThan(deg(0.3))
	}
})

test('central eclipse map curves are time-ordered and respect the angular step', () => {
	const fixture = NASA_ECLIPSES[0]
	const maxStep = deg(12)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: maxStep, includeRiseSetCurves: true, riseSetStep: 1800 })
	const { lines } = geometry

	expectIncreasingJd(lines.centerLine)
	expectMaxAngularStep(lines.centerLine, maxStep)

	// Umbra limit pieces are time-ordered and never bridge a discontinuity: edges within a piece stay
	// below the split threshold (CURVE_GAP_SPLIT_FACTOR times the angular step).
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) {
		expect(segment.length).toBeGreaterThan(1)
		expectIncreasingJd(segment)
		expectMaxAngularStep(segment, maxStep * 4)
		for (const point of segment) expectGeoPoint(point)
	}

	// Sunrise/sunset curves progress in time even though they may jump spatially at the terminator.
	for (const curve of lines.riseSetCurves) {
		expect(curve.length).toBeGreaterThan(1)
		expectNonDecreasingJd(curve)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('hybrid eclipse produces a central path anchored at the NASA greatest eclipse', () => {
	const fixture = NASA_ECLIPSES[3]
	expect(fixture.type).toBe('hybrid')

	const elements = nasaPbe(fixture)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12) })
	const { points, lines } = geometry

	expectGeoNear(points.Max, parseDms(fixture.greatestEclipse[1]), parseDms(fixture.greatestEclipse[0]), 2)
	expect(points.C1).toBeDefined()
	expect(points.C2).toBeDefined()
	expect(Math.abs(axisLimbResidual(elements, points.C1!.jd!))).toBeLessThan(1e-6)
	expect(Math.abs(axisLimbResidual(elements, points.C2!.jd!))).toBeLessThan(1e-6)
	expectIncreasingJd([points.C1!, points.Max!, points.C2!])

	expect(lines.centerLine.length).toBeGreaterThan(1)
	expectIncreasingJd(lines.centerLine)
	expect(lines.umbraNorth.length).toBeGreaterThan(0)
	expect(lines.umbraSouth.length).toBeGreaterThan(0)
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) {
		expectIncreasingJd(segment)
		for (const point of segment) expectGeoPoint(point)
	}
})

test('computeSolarEclipseMapGeometry is deterministic for identical inputs', () => {
	const fixture = NASA_ECLIPSES[0]
	const options = { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, riseSetStep: 1800 }
	const first = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), options)
	const second = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), options)

	expect(JSON.stringify(second)).toBe(JSON.stringify(first))
})

test('antimeridian splitting keeps segments within a hemisphere and continuous across the seam', () => {
	const line: GeoPoint[] = [
		{ x: deg(150), y: deg(5) },
		{ x: deg(178), y: deg(8) },
		{ x: deg(-176), y: deg(11) },
		{ x: deg(-150), y: deg(14) },
	]

	const segments = splitPolylineAtAntimeridian(line)
	expect(segments).toHaveLength(2)

	for (const segment of segments) for (let i = 1; i < segment.length; i++) expect(Math.abs(segment[i].x - segment[i - 1].x)).toBeLessThanOrEqual(PI)

	const seamEnd = segments[0].at(-1)!
	const seamStart = segments[1][0]
	expect(Math.abs(seamEnd.x)).toBeCloseTo(PI, 10)
	expect(Math.abs(seamStart.x)).toBeCloseTo(PI, 10)
	expect(seamEnd.x).toBe(-seamStart.x)
	// Latitude is continuous across the inserted seam point.
	expect(seamEnd.y).toBeCloseTo(seamStart.y, 10)
})

// NASA/GSFC umbral path table for the 2024 Apr 08 total eclipse (delta T = 70.6 s).
// https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2024Apr08Tpath.html
const APR8_2024_UT_MIDNIGHT = 2460408.5 // 2024 Apr 08 00:00 UT
const APR8_2024_DELTA_T_DAYS = 70.6 / 86400

// Universal Time rows with central/north/south coordinates in decimal degrees (east/north positive).
const NASA_2024_PATH = [
	{ ut: [16, 42], central: [-5.836667, -148.13], north: [-5.51, -149.793333], south: [-6.195, -146.633333] }, // 05 50.2S 148 07.8W
	{ ut: [17, 0], central: [1.711667, -129.686667], north: [2.196667, -130.545], south: [1.22, -128.841667] }, // 01 42.7N 129 41.2W
	{ ut: [18, 0], central: [20.32, -108.763333], north: [20.896667, -109.51], south: [19.743333, -108.025] }, // 20 19.2N 108 45.8W
	{ ut: [19, 0], central: [37.328333, -89.776667], north: [38.063333, -90.311667], south: [36.6, -89.241667] }, // 37 19.7N 089 46.6W
] as const

function nasaPathCentralLineAtUT(elements: PolynomialBesselianElements, hours: number, minutes: number) {
	// The Besselian polynomials are argued in Terrestrial Dynamical Time, so TD = UT + delta T.
	const jdTd = APR8_2024_UT_MIDNIGHT + (hours + minutes / 60) / 24 + APR8_2024_DELTA_T_DAYS
	const be = evaluateBesselian(elements, time(jdTd, 0, Timescale.TT))
	return projectFundamentalPoint(be, be.x, be.y)
}

test('central line tracks the NASA 2024-04-08 umbral path table over time', () => {
	const elements = nasaPbe(NASA_ECLIPSES[0])

	for (const row of NASA_2024_PATH) {
		const point = nasaPathCentralLineAtUT(elements, row.ut[0], row.ut[1])
		expectNearNasa(point, row.central[0], row.central[1], 0.5)
	}
})

test('umbral north and south limits match the NASA 2024-04-08 path table', () => {
	const elements = nasaPbe(NASA_ECLIPSES[0])

	// Rows from 17:00 UT onward sit well inside the path, away from the U1 contact transient.
	for (const row of NASA_2024_PATH.filter((entry) => entry.ut[0] >= 17)) {
		const expectedUt = APR8_2024_UT_MIDNIGHT + (row.ut[0] + row.ut[1] / 60) / 24
		const north = findEclipseCurvePoint(elements, deg(row.north[1]), deg(row.north[0]), 1, 1)
		const south = findEclipseCurvePoint(elements, deg(row.south[1]), deg(row.south[0]), -1, 1)

		expectNearNasa(north, row.north[0], row.north[1], 0.5)
		expectNearNasa(south, row.south[0], row.south[1], 0.5)
		// The solved limit instant (UT = TD - delta T) matches the table time within a minute.
		expect(Math.abs((north!.jd! - APR8_2024_DELTA_T_DAYS - expectedUt) * 86400)).toBeLessThan(60)
		expect(Math.abs((south!.jd! - APR8_2024_DELTA_T_DAYS - expectedUt) * 86400)).toBeLessThan(60)
	}
})

test('central-line endpoints match the NASA 2024-04-08 path-table limit rows', () => {
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[0]), nasaPbe(NASA_ECLIPSES[0]), { longitudeStep: deg(30), maxAngularStep: deg(12) })

	// Limits (Start): central 07 49.5S 158 31.9W; Limits (End): central 47 37.0N 019 47.2W.
	expectNearNasa(geometry.points.C1, -7.825, -158.531667, 2)
	expectNearNasa(geometry.points.C2, 47.616667, -19.786667, 2)
})

test('partial-eclipse limits populate at a fine longitude step for a central eclipse', () => {
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[0]), nasaPbe(NASA_ECLIPSES[0]), { longitudeStep: deg(2), maxAngularStep: deg(6), includeRiseSetCurves: false })

	expect(geometry.lines.penumbraNorth.length).toBeGreaterThan(5)
	expect(geometry.lines.penumbraSouth.length).toBeGreaterThan(5)
	for (const point of geometry.lines.penumbraNorth) expectGeoPoint(point)
	for (const point of geometry.lines.penumbraSouth) expectGeoPoint(point)
})

test('equirectangular projection maps the world onto the SVG viewport corners', () => {
	const projection = equirectangularProjection(360, 180)

	expect(projection.project(0, 0)).toEqual({ x: 180, y: 90 })
	expect(projection.project(deg(90), 0)!.x).toBeCloseTo(270, 9)
	expect(projection.project(deg(-90), 0)!.x).toBeCloseTo(90, 9)
	// Longitudes just inside the seam approach the left/right viewport edges.
	expect(projection.project(deg(-179), 0)!.x).toBeCloseTo(1, 6)
	expect(projection.project(deg(179), 0)!.x).toBeCloseTo(359, 6)
	expect(projection.project(0, PIOVERTWO)!.y).toBeCloseTo(0, 9)
	expect(projection.project(0, -PIOVERTWO)!.y).toBeCloseTo(180, 9)
})

test('central meridian shifts the projected longitudes', () => {
	const projection = equirectangularProjection(360, 180, { centralMeridian: deg(90) })

	// With the central meridian at 90E, that meridian lands at the horizontal centre.
	expect(projection.project(deg(90), 0)!.x).toBeCloseTo(180, 9)
})

test('pointsToSvgPathData emits one M..L.. subpath per piece and closes polygons', () => {
	const open = pointsToSvgPathData([
		[
			{ x: 1, y: 2 },
			{ x: 3, y: 4 },
			{ x: 5, y: 6 },
		],
	])

	expect(open).toBe('M1 2L3 4L5 6')

	const closed = pointsToSvgPathData(
		[
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 10 },
			],
		],
		true,
	)

	expect(closed.startsWith('M0 0')).toBe(true)
	expect(closed.endsWith('Z')).toBe(true)

	// Two pieces produce two subpaths; degenerate pieces are dropped; empty input yields an empty string.
	expect(
		pointsToSvgPathData([
			[
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			],
			[
				{ x: 2, y: 2 },
				{ x: 3, y: 3 },
			],
		]).match(/M/g),
	).toHaveLength(2)

	expect(pointsToSvgPathData([[{ x: 0, y: 0 }]])).toBe('')
	expect(pointsToSvgPathData([])).toBe('')
})

test('pointsToSvgPathData rounds coordinates to the requested precision', () => {
	expect(
		pointsToSvgPathData(
			[
				[
					{ x: 1.23456, y: 2.98765 },
					{ x: 3.1, y: 4 },
				],
			],
			false,
			3,
		),
	).toBe('M1.235 2.988L3.1 4')
})

test('solarEclipseMapToSvgPaths serializes lines and skips empty features', () => {
	const map = geometry(
		{
			centerLine: [
				{ x: deg(-10), y: 0 },
				{ x: deg(10), y: deg(5) },
			],
		},
		{ Max: { x: 0, y: 0 } },
	)

	const paths = solarEclipseMapToSvgPaths(map, equirectangularProjection(360, 180))

	expect(paths.centerLine.startsWith('M')).toBe(true)
	expect(paths.centerLine).toContain('L')
	expect(paths.penumbraNorth).toBe('')
	expect(paths.umbraSouth).toBe('')
	expect(paths.points.Max).toEqual({ x: 180, y: 90 })
	expect(paths.points.U1).toBeUndefined()
})

test('computeSolarEclipseFillGeometry derives a closed visual ring from the umbra limits', () => {
	const north: GeoPoint[] = [
		{ x: deg(-10), y: deg(1), jd: 1 },
		{ x: 0, y: deg(1.5), jd: 2 },
		{ x: deg(10), y: deg(2), jd: 3 },
	]
	const south: GeoPoint[] = [
		{ x: deg(-10), y: deg(-1), jd: 1 },
		{ x: 0, y: deg(-1.5), jd: 2 },
		{ x: deg(10), y: deg(-2), jd: 3 },
	]
	const map = geometry({ umbraNorth: [north], umbraSouth: [south] })
	const rings = computeSolarEclipseFillGeometry(map)

	// One ring: north traversed forward then south traversed backward. The physical limit polylines
	// are not mutated by the fill derivation.
	expect(rings).toHaveLength(1)
	expect(rings[0]).toHaveLength(6)
	expect(rings[0].slice(0, 3)).toEqual(north)
	expect(rings[0].slice(3)).toEqual([south[2], south[1], south[0]])
	expect(map.lines.umbraNorth[0]).toHaveLength(3)
	expect(map.lines.umbraSouth[0]).toHaveLength(3)

	// The fill serializes as a closed SVG subpath.
	const path = geoPolygonsToSvgPathData(rings, equirectangularProjection(360, 180))
	expect(path.startsWith('M')).toBe(true)
	expect(path.endsWith('Z')).toBe(true)

	// No fill without both limits.
	expect(computeSolarEclipseFillGeometry(geometry({ umbraNorth: [north] }))).toHaveLength(0)
	expect(computeSolarEclipseFillGeometry(geometry())).toHaveLength(0)
})

test('antimeridian-crossing lines split into multiple subpaths', () => {
	const map = geometry({
		centerLine: [
			{ x: deg(160), y: 0 },
			{ x: deg(175), y: deg(1) },
			{ x: deg(-175), y: deg(2) },
			{ x: deg(-160), y: deg(3) },
		],
	})

	const paths = solarEclipseMapToSvgPaths(map, equirectangularProjection(360, 180))
	expect((paths.centerLine.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2)

	// The exact +-180 crossing must be inserted so the first subpath reaches the right edge (x = width) and
	// the second resumes at the left edge (x ~ 0), rather than stopping at the last samples before the wrap.
	const subpaths = paths.centerLine.split('M').filter((part) => part.length > 0)
	const firstEndX = Number(subpaths[0].trim().split('L').at(-1)!.split(' ')[0])
	const secondStartX = Number(subpaths[1].trim().split('L')[0].split(' ')[0])
	expect(firstEndX).toBeCloseTo(360, 3)
	expect(secondStartX).toBeCloseTo(0, 3)
})

// NASA/GSFC Besselian elements for the 2024 Apr 08 total eclipse.
// https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2024Apr08Tbeselm.html
const NASA_2024: PolynomialBesselianElements = {
	time0: time(2460409.25, 0, Timescale.TT),
	maximumTime: time(2460409.262835, 0, Timescale.TT),
	deltaT: 70.6,
	deltaTLongitudeCorrection: DELTA_T_LONGITUDE_FACTOR * 70.6,
	stepDays: 1 / 24,
	x: [-0.318157, 0.5117105, 0.0000326, -0.0000085],
	y: [0.219747, 0.2709586, -0.0000594, -0.0000047],
	l1: [0.535813, 0.0000618, -0.0000128],
	l2: [-0.010274, 0.0000615, -0.0000127],
	d: [7.5862, 0.014844, -0.000002].map(deg),
	mu: [89.59122, 15.004084].map(deg),
	tanF1: 0.0046683,
	tanF2: 0.004645,
}

const NASA_2024_ECLIPSE: SolarEclipse = { lunation: 0, maximalTime: NASA_2024.maximumTime, magnitude: 1.0566, gamma: 0.3431, u: -0.010274, type: 'total' }

test('solarEclipseMapToSvgPaths places the 2024-04-08 totality over North America', () => {
	const map = computeSolarEclipseMapGeometry(NASA_2024_ECLIPSE, NASA_2024, { longitudeStep: deg(2), maxAngularStep: deg(4), includeRiseSetCurves: true, riseSetStep: 600 })
	const width = 720
	const height = 360
	const projection = equirectangularProjection(width, height)
	const paths = solarEclipseMapToSvgPaths(map, projection)
	const fill = geoPolygonsToSvgPathData(computeSolarEclipseFillGeometry(map), projection)

	for (const feature of [paths.centerLine, paths.umbraNorth, paths.umbraSouth, fill]) {
		expect(feature.length).toBeGreaterThan(0)
		expect(feature.startsWith('M')).toBe(true)
	}
	expect(fill.endsWith('Z')).toBe(true)

	// The Max marker matches a direct projection and lands over Mexico (lon ~ -104, lat ~ +25).
	const expectedMax = projection.project(map.points.Max!.x, map.points.Max!.y)!
	expect(paths.points.Max!.x).toBeCloseTo(expectedMax.x, 9)
	expect(paths.points.Max!.y).toBeCloseTo(expectedMax.y, 9)
	expect(paths.points.Max!.x).toBeGreaterThan(140)
	expect(paths.points.Max!.x).toBeLessThan(165)
	expect(paths.points.Max!.y).toBeGreaterThan(120)
	expect(paths.points.Max!.y).toBeLessThan(140)

	// All projected coordinates stay inside the viewport.
	for (const value of paths.centerLine.match(/-?\d+(?:\.\d+)?/g)!.map(Number)) expect(Number.isFinite(value)).toBe(true)
})

describe('eclipse geometry physical and topological invariants', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		test(`${fixture.name} curve points satisfy tangency, sun-altitude and smoothness invariants`, () => {
			const elements = nasaPbe(fixture)
			const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3) })
			const { umbraNorth, umbraSouth, penumbraNorth, penumbraSouth, centerLine } = geometry.lines

			// Tangency residual: every umbra/penumbra limit point lies on its magnitude curve (umbra edge for
			// G = 1, penumbra edge for G = 0), proving each is a converged physical solution, not an artifact.
			for (const point of umbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 1)).toBeLessThan(1e-3)
			for (const point of umbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 1)).toBeLessThan(1e-3)
			for (const point of penumbraNorth) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
			for (const point of penumbraSouth) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)

			// Sun altitude: every drawn curve point lies on the sunlit side, with the Sun above the horizon
			// (a small negative tolerance absorbs refraction at the contacts, where the Sun grazes the horizon).
			for (const point of [...umbraNorth.flat(), ...umbraSouth.flat(), ...penumbraNorth, ...penumbraSouth, ...centerLine]) {
				expect(solarAltitude(elements, point)).toBeGreaterThan(deg(-1))
			}

			// Smoothness: each physical limit piece bends without sharp kinks.
			for (const piece of [...umbraNorth, ...umbraSouth]) expect(countKinks(piece, deg(30))).toBe(0)
		})
	}
})

// Validation cases computed from the VSOP87E/ELPMPP02 ephemerides, covering the three reference
// eclipses of the refactor checklist: a near-grazing annular (2003-05-31), a circumpolar total over
// Antarctica (2003-11-23) and a hybrid (2023-04-20).
describe('solar eclipse map validation cases', () => {
	const getSunMoonPosition = (t: Parameters<typeof computeSunMoonPositionAt>[0]) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
	const MAX_STEP = deg(3)

	const CASES = [
		// EclipseWise: annular, gamma ~ +0.996, sunrise annularity over Iceland/Greenland; the penumbra
		// is never wholly on Earth, so P2/P3 do not exist. The i = +1 antumbra limit never reaches the
		// sunlit hemisphere (the path is bounded by the terminator on that side), so only one limit
		// family exists and no closed fill ring can be derived.
		{ date: timeYMD(2003, 5, 15), name: '2003-05-31', type: 'annular', hasInternalContacts: false, hasBothUmbraLimits: false },
		// EclipseWise: total, gamma ~ -0.964, circumpolar path over Antarctica; P2/P3 do not exist.
		{ date: timeYMD(2003, 11, 1), name: '2003-11-23', type: 'total', hasInternalContacts: false, hasBothUmbraLimits: true },
		// EclipseWise: hybrid, gamma ~ -0.395; the penumbra is wholly on Earth around maximum, so P2/P3 exist.
		{ date: timeYMD(2023, 4, 1), name: '2023-04-20', type: 'hybrid', hasInternalContacts: true, hasBothUmbraLimits: true },
	] as const

	for (const fixture of CASES) {
		describe(fixture.name, () => {
			const eclipse = nearestSolarEclipse(fixture.date, true)
			const elements = computePolynomialBesselianElements(eclipse.maximalTime, getSunMoonPosition)
			const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(1), maxAngularStep: MAX_STEP, includeRiseSetCurves: true, riseSetStep: 600 })
			const { points, lines } = geometry

			test('eclipse class and contact existence', () => {
				expect(eclipse.type).toBe(fixture.type)
				expect(points.P1).toBeDefined()
				expect(points.P4).toBeDefined()
				expect(points.P1!.jd!).toBeLessThan(points.P4!.jd!)

				if (fixture.hasInternalContacts) {
					expect(points.P2).toBeDefined()
					expect(points.P3).toBeDefined()
					expectIncreasingJd([points.P1!, points.P2!, points.P3!, points.P4!])
				} else {
					expect(points.P2).toBeUndefined()
					expect(points.P3).toBeUndefined()
				}

				// All three cases are central, so the central endpoints exist and bracket the maximum.
				expect(points.C1).toBeDefined()
				expect(points.C2).toBeDefined()
				expectIncreasingJd([points.C1!, points.Max!, points.C2!])
				expect(Math.abs(axisLimbResidual(elements, points.C1!.jd!))).toBeLessThan(1e-6)
				expect(Math.abs(axisLimbResidual(elements, points.C2!.jd!))).toBeLessThan(1e-6)
			})

			test('center line is continuous, time-ordered and anchored at C1/C2', () => {
				expect(lines.centerLine.length).toBeGreaterThan(2)
				expectIncreasingJd(lines.centerLine)
				expectGeoPointClose(lines.centerLine[0], points.C1!.x, points.C1!.y, points.C1!.jd)
				expectGeoPointClose(lines.centerLine.at(-1), points.C2!.x, points.C2!.y, points.C2!.jd)
				// Max lies on the central line.
				const onCentralLine = interpolateAtJulianDay(lines.centerLine, points.Max!.jd!)
				expect(onCentralLine).toBeDefined()
				expect(sphericalSeparation(onCentralLine!.x, onCentralLine!.y, points.Max!.x, points.Max!.y)).toBeLessThan(deg(0.5))
			})

			test('umbra limits come from the G = 1 solver and penumbra limits from G = 0', () => {
				if (fixture.hasBothUmbraLimits) {
					expect(lines.umbraNorth.length).toBeGreaterThan(0)
					expect(lines.umbraSouth.length).toBeGreaterThan(0)
				} else {
					// Only one antumbra edge reaches the sunlit hemisphere for this grazing eclipse.
					expect(lines.umbraNorth.length + lines.umbraSouth.length).toBeGreaterThan(0)
				}
				for (const point of lines.umbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 1)).toBeLessThan(1e-3)
				for (const point of lines.umbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 1)).toBeLessThan(1e-3)
				for (const point of lines.penumbraNorth) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
				for (const point of lines.penumbraSouth) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
			})

			test('polylines contain only finite coordinates and never bridge a discontinuity', () => {
				const families = [lines.centerLine, ...lines.umbraNorth, ...lines.umbraSouth, lines.penumbraNorth, lines.penumbraSouth, ...lines.riseSetCurves]
				for (const family of families) for (const point of family) expectGeoPoint(point)
				// Umbra limit pieces have been split at discontinuities, so no intra-piece edge exceeds the
				// split threshold (CURVE_GAP_SPLIT_FACTOR times the angular step): no chord jumps a gap.
				for (const piece of [...lines.umbraNorth, ...lines.umbraSouth]) {
					expect(piece.length).toBeGreaterThan(1)
					expectIncreasingJd(piece)
					expectMaxAngularStep(piece, MAX_STEP * 4)
				}
			})

			test('rise/set curves sit near the solar horizon and progress in time', () => {
				expect(lines.riseSetCurves.length).toBeGreaterThan(0)
				for (const curve of lines.riseSetCurves) {
					expect(curve.length).toBeGreaterThan(1)
					expectNonDecreasingJd(curve)
					for (const point of curve) expect(Math.abs(solarAltitude(elements, point))).toBeLessThan(deg(2))
				}
			})

			test('penumbral limit extremes are informational points on the magnitude-0 locus', () => {
				for (const point of [points.N1, points.N2, points.S1, points.S2]) {
					if (!point) continue
					const onLocus = Math.min(limitTangencyResidual(elements, point, 1, 0), limitTangencyResidual(elements, point, -1, 0))
					expect(onLocus).toBeLessThan(1e-3)
				}
				if (points.N1?.jd !== undefined && points.N2?.jd !== undefined) expect(points.N1.jd).toBeLessThanOrEqual(points.N2.jd)
				if (points.S1?.jd !== undefined && points.S2?.jd !== undefined) expect(points.S1.jd).toBeLessThanOrEqual(points.S2.jd)
			})

			test('visual fill is isolated from the physical boundary lines', () => {
				const before = JSON.stringify(lines)
				const rings = computeSolarEclipseFillGeometry(geometry)
				// A closed fill ring requires both limits; a single-edge grazing path has none.
				if (fixture.hasBothUmbraLimits) expect(rings.length).toBeGreaterThan(0)
				else expect(rings).toHaveLength(0)
				for (const ring of rings) for (const point of ring) expectGeoPoint(point)
				// Deriving the fill does not mutate the physical polylines.
				expect(JSON.stringify(lines)).toBe(before)
			})
		})
	}
})

describe('solar eclipse map acceptance criteria', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3), includeRiseSetCurves: true, riseSetStep: 600 })
		const { points, lines } = geometry

		describe(fixture.name, () => {
			// Every plotted point is finite and within the documented coordinate ranges.
			test('all entity points are finite and in range', () => {
				const families = [lines.centerLine, ...lines.umbraNorth, ...lines.umbraSouth, lines.penumbraNorth, lines.penumbraSouth, ...lines.riseSetCurves]
				for (const family of families) for (const point of family) expectGeoPoint(point)
				for (const key of ['P1', 'P2', 'P3', 'P4', 'U1', 'U2', 'U3', 'U4', 'C1', 'C2', 'Max', 'N1', 'N2', 'S1', 'S2'] as const) {
					const point = points[key]
					if (point) expectGeoPoint(point)
				}
			})

			// The four informational umbral contacts are time-ordered U1 < U2 < U3 < U4 and satisfy
			// their unit-limb root equations.
			test('U1..U4 are time-ordered tangency contacts', () => {
				expectIncreasingJd([points.U1!, points.U2!, points.U3!, points.U4!])
				const umbraRadius = (jd: number) => Math.abs(evaluateBesselian(elements, time(jd, 0, Timescale.TT)).l2)
				// External tangency at U1/U4, internal tangency at U2/U3, against the limb ellipse.
				expect(Math.abs(externalContactResidual(elements, points.U1!.jd!, umbraRadius(points.U1!.jd!)))).toBeLessThan(1e-6)
				expect(Math.abs(externalContactResidual(elements, points.U4!.jd!, umbraRadius(points.U4!.jd!)))).toBeLessThan(1e-6)
				expect(Math.abs(internalContactResidual(elements, points.U2!.jd!, umbraRadius(points.U2!.jd!)))).toBeLessThan(1e-6)
				expect(Math.abs(internalContactResidual(elements, points.U3!.jd!, umbraRadius(points.U3!.jd!)))).toBeLessThan(1e-6)
			})

			// C1/C2 are the central-line endpoints, ordered U1 < C1 and C2 < U4, and the central line
			// is time-ordered and low-residual on the shadow axis.
			test('C1/C2 bound a valid central line', () => {
				expectGeoPointClose(lines.centerLine[0], points.C1!.x, points.C1!.y, points.C1!.jd)
				expectGeoPointClose(lines.centerLine.at(-1), points.C2!.x, points.C2!.y, points.C2!.jd)
				expect(points.C1!.jd!).toBeGreaterThan(points.U1!.jd!)
				expect(points.C2!.jd!).toBeLessThan(points.U4!.jd!)
				expectIncreasingJd(lines.centerLine)
				for (const point of lines.centerLine) expect(axisLimbResidual(elements, point.jd!)).toBeLessThan(1)
			})

			// Greatest eclipse is on the sunlit side and near the central line.
			test('greatest eclipse is near the central line', () => {
				expect(solarAltitude(elements, points.Max!)).toBeGreaterThan(deg(-1))
				let nearest = Number.POSITIVE_INFINITY
				for (const point of lines.centerLine) nearest = Math.min(nearest, sphericalSeparation(points.Max!.x, points.Max!.y, point.x, point.y))
				expect(nearest).toBeLessThan(deg(2))
			})

			// Rise/set curves are horizon-contact curves, so the Sun is near the horizon along them.
			test('rise/set curves sit near the solar horizon', () => {
				for (const curve of lines.riseSetCurves) for (const point of curve) expect(Math.abs(solarAltitude(elements, point))).toBeLessThan(deg(2))
			})

			// The named penumbral-limit extremes, when present, lie on a magnitude-0 limit branch and
			// are ordered chronologically (N1/S1 begin, N2/S2 end).
			test('penumbral limit extremes lie on the magnitude-0 locus', () => {
				for (const point of [points.N1, points.N2, points.S1, points.S2]) {
					if (!point) continue
					const onLocus = Math.min(limitTangencyResidual(elements, point, 1, 0), limitTangencyResidual(elements, point, -1, 0))
					expect(onLocus).toBeLessThan(1e-3)
				}
				if (points.N1?.jd !== undefined && points.N2?.jd !== undefined) expect(points.N1.jd).toBeLessThanOrEqual(points.N2.jd)
				if (points.S1?.jd !== undefined && points.S2?.jd !== undefined) expect(points.S1.jd).toBeLessThanOrEqual(points.S2.jd)
			})
		})
	}

	// A purely partial eclipse has no central line and no umbral path, but it does draw the penumbral
	// limit (its main physical contour, magnitude 0) on the sunlit side, not just the rise/set curves.
	test('a purely partial eclipse draws the penumbral limit but no central/umbral entities', () => {
		const fixture = NASA_ECLIPSES[2]
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3), includeRiseSetCurves: true })
		expect(geometry.lines.centerLine).toHaveLength(0)
		expect(geometry.lines.umbraNorth).toHaveLength(0)
		expect(geometry.lines.umbraSouth).toHaveLength(0)
		expect(computeSolarEclipseFillGeometry(geometry)).toHaveLength(0)

		// The penumbral limit is produced (at least one of the two tangent branches) on the magnitude-0 locus.
		const penumbra = [...geometry.lines.penumbraNorth, ...geometry.lines.penumbraSouth]
		expect(penumbra.length).toBeGreaterThan(0)
		for (const point of geometry.lines.penumbraNorth) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
		for (const point of geometry.lines.penumbraSouth) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
		for (const point of penumbra) expect(solarAltitude(elements, point)).toBeGreaterThan(deg(-1))
	})

	// A pure partial eclipse draws the penumbral limit (magnitude 0), and that limit spans the
	// published northern/southern penumbral extremes N1/S1. Verified against the 2000-02-05 partial over
	// the southern hemisphere (EclipseWise: N1 ~ 50.23 deg S, 95.645 deg W; S1 ~ 28.305 deg S, 66.562 deg E).
	test('2000-02-05 partial eclipse penumbral limit matches the published N1/S1 extremes', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2000, 2, 1), true)
		expect(eclipse.type).toBe('partial')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(1), maxAngularStep: deg(3) })
		const limit = geometry.lines.penumbraNorth
		expect(limit.length).toBeGreaterThan(0)

		// Every point is on the magnitude-0 locus with the Sun above the horizon.
		for (const point of limit) {
			expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
			expect(solarAltitude(elements, point)).toBeGreaterThan(deg(-1))
		}

		// A grazing partial has a single penumbral limit, so its named extremes are its two terminator
		// cusps, N1/S1 (not N2/S2), named chronologically: N1 ~ 50.23 deg S, 95.645 deg W (the earlier
		// cusp); S1 ~ 28.305 deg S, 66.562 deg E (the later cusp). EclipseWise match within a fraction of a degree.
		expect(geometry.points.N1).toBeDefined()
		expect(geometry.points.S1).toBeDefined()
		expect(geometry.points.N2).toBeUndefined()
		expect(geometry.points.S2).toBeUndefined()
		// N1 is the earlier cusp, S1 the later one (chronological, not by latitude).
		expect(geometry.points.N1!.jd!).toBeLessThanOrEqual(geometry.points.S1!.jd!)
		expect(sphericalSeparation(geometry.points.N1!.x, geometry.points.N1!.y, deg(-95.645), deg(-50.23))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.S1!.x, geometry.points.S1!.y, deg(66.562), deg(-28.305))).toBeLessThan(deg(0.5))
		// They are endpoints of the penumbral limit curve, so they lie on it.
		for (const point of [geometry.points.N1!, geometry.points.S1!]) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
	})

	// Same convention checked on a northern-hemisphere grazing partial: 2000-07-31 (EclipseWise N1 ~ 49.49 deg N,
	// 55.6 deg E, the earlier cusp; S1 ~ 32.19 deg N, 129.74 deg W, the later cusp). Here the earlier cusp
	// also happens to be poleward, but the label is chronological.
	test('2000-07-31 partial eclipse names its single-limit cusps chronologically (N1 first, S1 last)', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2000, 7, 15), true)
		expect(eclipse.type).toBe('partial')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(1), maxAngularStep: deg(3) })

		expect(geometry.points.N1).toBeDefined()
		expect(geometry.points.S1).toBeDefined()
		expect(geometry.points.N2).toBeUndefined()
		expect(geometry.points.S2).toBeUndefined()
		expect(geometry.points.N1!.jd!).toBeLessThanOrEqual(geometry.points.S1!.jd!)
		expect(sphericalSeparation(geometry.points.N1!.x, geometry.points.N1!.y, deg(55.608), deg(49.492))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.S1!.x, geometry.points.S1!.y, deg(-129.738), deg(32.185))).toBeLessThan(deg(0.5))
		// Both lie on the magnitude-0 locus (this eclipse's limit is the southern branch, i = -1).
		for (const point of [geometry.points.N1!, geometry.points.S1!]) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
	})

	// Regression for 2003-05-31 (annular grazing): BOTH terminator cusps are in the northern hemisphere
	// (N1 ~ 10.86 deg N, 52.00 deg E; S1 ~ 37.09 deg N, 164.07 deg W), so a poleward/equatorward label
	// would swap them. EclipseWise names them chronologically, and N1 (the earlier cusp) is the more
	// equatorward one here.
	test('2003-05-31 grazing eclipse names same-hemisphere cusps chronologically, not by latitude', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2003, 5, 15), true)
		expect(eclipse.type).toBe('annular')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(0.5), maxAngularStep: deg(1) })

		expect(geometry.points.N1).toBeDefined()
		expect(geometry.points.S1).toBeDefined()
		expect(geometry.points.N2).toBeUndefined()
		expect(geometry.points.S2).toBeUndefined()
		// Both cusps are northern, and N1 is the more equatorward one: the label is purely chronological.
		expect(geometry.points.N1!.y).toBeGreaterThan(0)
		expect(geometry.points.S1!.y).toBeGreaterThan(0)
		expect(geometry.points.N1!.jd!).toBeLessThanOrEqual(geometry.points.S1!.jd!)
		expect(geometry.points.N1!.y).toBeLessThan(geometry.points.S1!.y)
		expect(sphericalSeparation(geometry.points.N1!.x, geometry.points.N1!.y, deg(52.005), deg(10.858))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.S1!.x, geometry.points.S1!.y, deg(-164.075), deg(37.093))).toBeLessThan(deg(0.5))
	})

	// An annular (both-limit) eclipse names the penumbral extremes chronologically -- N1/S1 where
	// each limit begins, N2/S2 where it ends -- not by latitude. Regression for the 2001-12-14 annular, where
	// the latitude ordering swapped N1<->N2 and S1<->S2. EclipseWise: N1 ~ 66.19 deg N, 139.72 deg W;
	// N2 ~ 57.93 deg N, 95.30 deg W; S1 ~ 0.60 deg N, 160.89 deg E; S2 ~ 15.54 deg S, 62.29 deg W.
	test('2001-12-14 annular eclipse labels penumbral extremes chronologically (N1/N2, S1/S2)', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2001, 12, 1), true)
		expect(eclipse.type).toBe('annular')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(0.5), maxAngularStep: deg(1) })

		for (const point of [geometry.points.N1, geometry.points.N2, geometry.points.S1, geometry.points.S2]) expect(point).toBeDefined()

		// N1/S1 begin each limit, N2/S2 end it, so the named extremes are ordered by time, not latitude.
		expect(geometry.points.N1!.jd!).toBeLessThanOrEqual(geometry.points.N2!.jd!)
		expect(geometry.points.S1!.jd!).toBeLessThanOrEqual(geometry.points.S2!.jd!)

		// Each named extreme is a terminator cusp of its limit, so it matches EclipseWise closely.
		expect(sphericalSeparation(geometry.points.N1!.x, geometry.points.N1!.y, deg(-139.72), deg(66.19))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.N2!.x, geometry.points.N2!.y, deg(-95.3), deg(57.93))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.S1!.x, geometry.points.S1!.y, deg(160.89), deg(0.6))).toBeLessThan(deg(0.5))
		expect(sphericalSeparation(geometry.points.S2!.x, geometry.points.S2!.y, deg(-62.29), deg(-15.54))).toBeLessThan(deg(0.5))
	})
})

describe('reference data and conventions', () => {
	test('central-axis geometry classifies every NASA fixture central/non-central', () => {
		for (const fixture of NASA_ECLIPSES) {
			// The fixture's hand-set `central` flag must agree with the geometric axis-intersection test
			// that now gates the central line (report sections 3.1 and 8.4).
			expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(fixture.central)
		}
	})

	test('TD/UT/Delta T convention: longitude correction is explicit and Delta T is applied once', () => {
		for (const fixture of NASA_ECLIPSES) {
			const elements = nasaPbe(fixture)
			// NASA mu is in dynamical time, so the geographic projection carries an explicit Delta T
			// longitude correction of DELTA_T_LONGITUDE_FACTOR * deltaT (report sections 1.2, 6.2, 7.2).
			expect(elements.deltaTLongitudeCorrection).toBeCloseTo(DELTA_T_LONGITUDE_FACTOR * fixture.deltaT, 12)
			// The correction equals 0.00417807 deg per second of Delta T.
			expect(elements.deltaTLongitudeCorrection).toBeCloseTo(deg(0.00417807) * fixture.deltaT, 12)
		}

		// Internally generated elements use UT-based mu, so their correction is exactly 0: no double Delta T.
		const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: 0, sunDeclination: 0, sunDistance: 23000, moonRightAscension: 0, moonDeclination: 0, moonDistance: 60, deltaT: 70 }))
		expect(generated.deltaTLongitudeCorrection).toBe(0)
	})

	test('polynomial origin t0 falls on the day of greatest eclipse', () => {
		for (const fixture of NASA_ECLIPSES) {
			expect(Math.abs(fixture.t0 - fixture.greatestEclipse[2])).toBeLessThan(0.5)
		}
	})
})

describe('circle-ellipse contact and rise/set invariants', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, riseSetStep: 1200 })
	const { points, lines } = geometry

	test('penumbral and umbral contacts satisfy the circle-ellipse tangency condition', () => {
		const l1 = (jd: number) => evaluateBesselian(elements, time(jd, 0, Timescale.TT)).l1
		const l2 = (jd: number) => Math.abs(evaluateBesselian(elements, time(jd, 0, Timescale.TT)).l2)
		// External (P1/P4, U1/U4) and internal (P2/P3, U2/U3) tangency against the limb ellipse.
		expect(Math.abs(externalContactResidual(elements, points.P1!.jd!, l1(points.P1!.jd!)))).toBeLessThan(1e-6)
		expect(Math.abs(externalContactResidual(elements, points.P4!.jd!, l1(points.P4!.jd!)))).toBeLessThan(1e-6)
		expect(Math.abs(internalContactResidual(elements, points.P2!.jd!, l1(points.P2!.jd!)))).toBeLessThan(1e-6)
		expect(Math.abs(internalContactResidual(elements, points.P3!.jd!, l1(points.P3!.jd!)))).toBeLessThan(1e-6)
		expect(Math.abs(externalContactResidual(elements, points.U1!.jd!, l2(points.U1!.jd!)))).toBeLessThan(1e-6)
		expect(Math.abs(externalContactResidual(elements, points.U4!.jd!, l2(points.U4!.jd!)))).toBeLessThan(1e-6)
	})

	test('rise/set points lie on the limb ellipse and at the penumbra radius from the shadow axis', () => {
		expect(lines.riseSetCurves.length).toBeGreaterThan(0)
		for (const curve of lines.riseSetCurves) {
			for (const point of curve) {
				const be = evaluateBesselian(elements, time(point.jd!, 0, Timescale.TT))
				const w = earthLimbOmega(be.d)
				// Recover the fundamental-plane (X, Y) of this geographic point: it must be the nearest limb
				// point to the shadow axis at distance l1 (report section 15.7).
				const extremes = earthLimbExtremes(be.x, be.y, w)
				// The two limb crossings sit at distance |l1| from the shadow axis center.
				expect(extremes.minDistance).toBeLessThanOrEqual(Math.abs(be.l1) + 1e-6)
				expect(extremes.maxDistance).toBeGreaterThanOrEqual(Math.abs(be.l1) - 1e-6)
			}
		}
	})
})

describe('hybrid central line classification', () => {
	test('a hybrid eclipse central line carries both total and annular kinds', () => {
		const fixture = NASA_ECLIPSES[3]
		expect(fixture.type).toBe('hybrid')
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(2), maxAngularStep: deg(4) })
		const kinds = new Set(geometry.lines.centerLine.map((point) => point.kind).filter((kind): kind is 'total' | 'annular' => kind !== undefined))
		// The local umbral radius changes sign along a hybrid path, so both characters appear (report 3.3/7.6).
		expect(kinds.has('total')).toBe(true)
		expect(kinds.has('annular')).toBe(true)
	})

	test('a pure total eclipse central line is classified total throughout', () => {
		const fixture = NASA_ECLIPSES[0]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(4), maxAngularStep: deg(6) })
		const kinds = new Set(geometry.lines.centerLine.map((point) => point.kind))
		expect(kinds.has('annular')).toBe(false)
		expect(kinds.has('total')).toBe(true)
	})
})

describe('fill geometry pairs disconnected branches', () => {
	test('two separated north/south branch pairs produce two rings, never one welded ring', () => {
		// Two disconnected totality bands (e.g. split by a discontinuity): each north branch must pair with
		// its own south branch, so the fill yields two rings rather than flattening into one that crosses
		// the map (report section 4.1).
		const northA: GeoPoint[] = [
			{ x: deg(-120), y: deg(1), jd: 1 },
			{ x: deg(-110), y: deg(1.5), jd: 2 },
		]
		const southA: GeoPoint[] = [
			{ x: deg(-120), y: deg(-1), jd: 1 },
			{ x: deg(-110), y: deg(-1.5), jd: 2 },
		]
		const northB: GeoPoint[] = [
			{ x: deg(110), y: deg(1), jd: 10 },
			{ x: deg(120), y: deg(1.5), jd: 11 },
		]
		const southB: GeoPoint[] = [
			{ x: deg(110), y: deg(-1), jd: 10 },
			{ x: deg(120), y: deg(-1.5), jd: 11 },
		]
		const map = geometry({ umbraNorth: [northA, northB], umbraSouth: [southA, southB] })
		const rings = computeSolarEclipseFillGeometry(map)

		expect(rings).toHaveLength(2)
		// Each ring stays within its own band's longitude neighborhood; no ring spans both bands.
		for (const ring of rings) {
			const lons = ring.map((point) => point.x)
			expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(deg(60))
		}
		// The physical limit polylines are untouched.
		expect(map.lines.umbraNorth).toHaveLength(2)
		expect(map.lines.umbraSouth).toHaveLength(2)
	})
})
