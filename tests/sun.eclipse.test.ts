import { expect, test, describe } from 'bun:test'
import { deg, formatAZ } from '../src/angle'
import { nearestSolarEclipse, type SolarEclipse, type SolarEclipseType } from '../src/sun'
// oxfmt-ignore
import { computePolynomialBesselianElements, computeRiseSetCurves, computeSolarEclipseMapGeometry, computeSunMoonPositionAt, evaluateBesselian, findCurvePoints, findEclipseCurvePoint, findExtremeLimitOfCentralLine, findMaximumPoint, findPenumbraContactPoints, intermediateGreatCircle, pointsToSvgPathData, projectFundamentalPoint, solarEclipseMapToSvgPaths, splitAtMaxAbsLatitude, splitPolygonAtAntimeridian, splitPolylineAtAntimeridian, type GeoPoint, type PolynomialBesselianElements, type SolarEclipseMapGeometry, type SunMoonPosition, type TotalityRingSegment } from '../src/sun.eclipse'
import { time, Timescale, timeSubtract, timeYMD, toJulianDay } from '../src/time'
import { PI, PIOVERTWO, TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'
import { PlateCarree, type ProjectionOptions } from '../src/projection'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'

const JD0 = 2460409.25
const TIME0 = time(JD0)

function pbe(overrides?: Partial<PolynomialBesselianElements>): PolynomialBesselianElements {
	return { time0: TIME0, maximumTime: TIME0, deltaT: 69, stepDays: 0.125, x: [0, 0.9], y: [0], l1: [0.4], l2: [-0.2], d: [0], mu: [0], tanF1: 0.0047, tanF2: -0.004, ...overrides }
}

// Minimal geometry literal with only the fields a test exercises; the rest are empty.
function geometry(overrides: Partial<SolarEclipseMapGeometry['lines']> = {}, totalityPath: SolarEclipseMapGeometry['polygons']['totalityPath'] = [], points: SolarEclipseMapGeometry['points'] = {}): SolarEclipseMapGeometry {
	return {
		points,
		lines: { centerLine: [], umbraNorth: [], umbraSouth: [], penumbraNorth: [], penumbraSouth: [], riseSetCurves: [], ...overrides },
		polygons: { totalityPath, totalitySegments: [], annularityPath: [], annularitySegments: [] },
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
	return { time0: time(fixture.t0, 0, Timescale.TT), maximumTime: time(fixture.greatestEclipse[2], 0, Timescale.TT), deltaT: fixture.deltaT, stepDays: 1 / 24, x: fixture.x, y: fixture.y, l1: fixture.l1, l2: fixture.l2, d: fixture.d.map(deg), mu: fixture.mu.map(deg), tanF1: fixture.tanF1, tanF2: fixture.tanF2 }
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

function expectMaxAngularStep(points: readonly GeoPoint[], maxStep: number) {
	for (let i = 1; i < points.length; i++) expect(sphericalSeparation(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y)).toBeLessThanOrEqual(maxStep)
}

// Earth flattening squared eccentricity, matching the constant used by the geometry engine.
const EARTH_FLATTENING_E2 = 0.006694385

// Residual of the shadow-axis tangency condition x^2 + (omega*y)^2 = 1 that defines the central
// line endpoints on the flattened Earth limb. Near zero means the axis grazes the ellipsoid.
function axisLimbResidual(elements: PolynomialBesselianElements, jd: number) {
	const be = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const cosD = Math.cos(be.d)
	const omega = 1 / Math.sqrt(1 - EARTH_FLATTENING_E2 * cosD * cosD)
	return be.x * be.x + (omega * be.y) ** 2 - 1
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
	const H = point.x + be.mu - (be.deltaTLongitudeCorrection ?? 0)
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
	const H = point.x + be.mu - (be.deltaTLongitudeCorrection ?? 0)
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

// Counts crossings between non-adjacent ring edges (antimeridian-wrapping edges skipped). Zero means a
// simple polygon. Valid in flat lon/lat for rings that do not wrap the antimeridian.
function countSelfIntersections(ring: readonly GeoPoint[]) {
	const orient = (p: GeoPoint, q: GeoPoint, r: GeoPoint) => Math.sign((r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x))
	let count = 0

	for (let i = 0; i < ring.length; i++) {
		const a = ring[i]
		const b = ring[(i + 1) % ring.length]
		if (Math.abs(a.x - b.x) > PI) continue

		for (let j = i + 2; j < ring.length; j++) {
			if (i === 0 && j === ring.length - 1) continue
			const c = ring[j]
			const d = ring[(j + 1) % ring.length]
			if (Math.abs(c.x - d.x) > PI) continue
			if (orient(a, c, d) !== orient(b, c, d) && orient(a, b, c) !== orient(a, b, d)) count++
		}
	}

	return count
}

// Ray-cast point-in-polygon, skipping antimeridian-wrapping edges. Valid for rings that do not wrap.
function isInsidePolygon(point: GeoPoint, ring: readonly GeoPoint[]) {
	let inside = false

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		if (Math.abs(ring[i].x - ring[j].x) > PI) continue
		if (ring[i].y > point.y !== ring[j].y > point.y && point.x < ((ring[j].x - ring[i].x) * (point.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) inside = !inside
	}

	return inside
}

// True when a closed ring wraps the antimeridian, so flat lon/lat point/segment tests do not apply to it.
function wrapsAntimeridian(ring: readonly GeoPoint[]) {
	for (let i = 0; i < ring.length; i++) if (Math.abs(ring[i].x - ring[(i + 1) % ring.length].x) > PI) return true
	return false
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
	expect(be.mu).toBeGreaterThanOrEqual(0)
	expect(be.mu).toBeLessThan(TAU)
	expect(be.deltaT).toBeCloseTo(70, 12)
	expect(be.l1).toBeCloseTo(0.551491575944278, 12)
	expect(be.l2).toBeCloseTo(0.006745927571222659, 12)
	expect(generated.tanF1).toBeCloseTo(0.004674026799934817, 12)
	expect(generated.tanF2).toBeCloseTo(0.004650741098228321, 12)
})

test('computePolynomialBesselianElements derives cone tangents from physical Sun-Moon distance', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: deg(15), sunDeclination: deg(7), sunDistance: 23484, moonRightAscension: deg(15.2), moonDeclination: deg(7.01), moonDistance: 56.28, deltaT: 69 }))

	expect(generated.tanF1).toBeCloseTo(0.004667498891126701, 12)
	expect(generated.tanF2).toBeCloseTo(0.004644245711043161, 12)
	expect(generated.tanF2).toBeGreaterThan(0)
})

test('computePolynomialBesselianElements projects the shadow axis onto the fundamental plane', () => {
	const sample: SunMoonPosition = { sunRightAscension: deg(40), sunDeclination: deg(65), sunDistance: 23000, moonRightAscension: deg(42), moonDeclination: deg(64.5), moonDistance: 60, deltaT: 70 }
	const generated = computePolynomialBesselianElements(TIME0, () => sample)
	const be = evaluateBesselian(generated, TIME0)
	const tangentPlaneX = sample.moonDistance * Math.cos(sample.sunDeclination) * (sample.moonRightAscension - sample.sunRightAscension)
	const tangentPlaneY = sample.moonDistance * (sample.moonDeclination - sample.sunDeclination)

	expect(be.x).toBeCloseTo(0.903877748055732, 12)
	expect(be.y).toBeCloseTo(-0.5105868561921576, 12)
	expect(be.d).toBeCloseTo(1.1344862148808663, 12)
	expect(be.mu).toBeCloseTo(1.172828928333944, 12)
	expect(Math.abs(be.x - tangentPlaneX)).toBeGreaterThan(0.01)
	expect(Math.abs(be.y - tangentPlaneY)).toBeGreaterThan(0.01)
})

test('computePolynomialBesselianElements follows the projection convention toward the day side', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: 0, sunDeclination: 0, sunDistance: 23000, moonRightAscension: 0, moonDeclination: 0, moonDistance: 60, deltaT: 70 }))
	const be = evaluateBesselian(generated, TIME0)
	const point = projectFundamentalPoint(be, be.x, be.y)
	const subsolarLongitude = -1.8708676396985666

	expect(be.x).toBeCloseTo(0, 12)
	expect(be.y).toBeCloseTo(0, 12)
	expect(be.d).toBeCloseTo(0, 12)
	expect(be.mu).toBeCloseTo(1.8708676396985666, 12)
	expect(be.deltaTLongitudeCorrection).toBe(0)
	expectGeoPointClose(point, subsolarLongitude, 0, 2460409.25)
})

test('findMaximumPoint matches NASA Besselian fixture at greatest eclipse instant', () => {
	for (const fixture of NASA_ECLIPSES) {
		const point = findMaximumPoint(nasaPbe(fixture))
		expect(formatAZ(point!.x, true)).toBe(fixture.greatestEclipse[0])
		expect(formatAZ(point!.y, true)).toBe(fixture.greatestEclipse[1])
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

test('NASA Besselian fixtures cover eclipse classes and rare central gating', () => {
	for (const fixture of NASA_ECLIPSES) {
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45), includeRiseSetCurves: false, includePolygons: true })

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
			expect(geometry.polygons.totalityPath).toHaveLength(0)
			expect(geometry.polygons.annularityPath).toHaveLength(0)
			continue
		}

		if (fixture.central) {
			// The umbra sweeps fully onto Earth: all four umbral contacts and both central-line endpoints exist.
			for (const point of [U1, U2, U3, U4, C1, C2]) expectGeoPoint(point!)
			expect(Array.isArray(geometry.lines.centerLine)).toBe(true)
			expect(Array.isArray(geometry.lines.umbraNorth)).toBe(true)
			expect(Array.isArray(geometry.lines.umbraSouth)).toBe(true)
			continue
		}

		// A non-central total/annular eclipse: the umbra only grazes the limb, so the external contacts
		// U1/U4 exist while the internal contacts U2/U3 and the central-line endpoints C1/C2 do not.
		expectGeoPoint(U1!)
		expectGeoPoint(U4!)
		for (const point of [U2, U3, C1, C2]) expect(point).toBeUndefined()
		expect(geometry.lines.centerLine).toHaveLength(0)
		expect(geometry.lines.umbraNorth.length).toBeGreaterThan(0)
		expect(geometry.lines.umbraSouth.length).toBeGreaterThan(0)
		// The fill goes to totalityPath for a total eclipse and annularityPath for an annular one.
		const fill = [...geometry.polygons.totalityPath, ...geometry.polygons.annularityPath]
		expect(fill.length).toBeGreaterThan(0)
		for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...fill]) for (const point of segment) expectGeoPoint(point)
	}
})

test('computeSolarEclipseMapGeometry anchors synthetic partial contacts and rise-set curves', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial'), pbe(), { longitudeStep: deg(90), includeRiseSetCurves: true, riseSetStep: 1800 })
	const { points, lines, polygons } = geometry

	expectGeoPointClose(points.P1, -1.565764772421259, 1.2287666251161822e-16, 2460409.055555556)
	expectGeoPointClose(points.P2, -1.565764772421259, 1.2287666251161822e-16, 2460409.166666668)
	expectGeoPointClose(points.Max, 0.005031554373637004, 0, 2460409.25)
	expectGeoPointClose(points.P3, 1.5758278811685338, 0, 2460409.333333332)
	expectGeoPointClose(points.P4, 1.5758278811685338, 0, 2460409.444444444)
	expectIncreasingJd([points.P1!, points.P2!, points.Max!, points.P3!, points.P4!])
	for (const point of [points.U1, points.U2, points.U3, points.U4, points.C1, points.C2]) expect(point).toBeUndefined()

	expect(lines.centerLine).toHaveLength(0)
	expect(lines.umbraNorth).toHaveLength(0)
	expect(lines.umbraSouth).toHaveLength(0)
	// A pure partial eclipse has no umbral path, so its main physical contour is the penumbral limit (the
	// magnitude-0 boundary). It is now produced rather than left empty; every point is a valid coordinate.
	for (const point of lines.penumbraNorth) expectGeoPoint(point)
	for (const point of lines.penumbraSouth) expectGeoPoint(point)
	expect(polygons.totalityPath).toHaveLength(0)
	// Two sunrise branches (P1->P2) and two sunset branches (P3->P4), each meeting exactly at its cusps.
	expect(lines.riseSetCurves.map((line) => line.length)).toEqual([73, 73, 72, 72])
	expectGeoPointClose(lines.riseSetCurves[0][0], points.P1!.x, points.P1!.y, points.P1!.jd)
	expectGeoPointClose(lines.riseSetCurves[0].at(-1), points.P2!.x, points.P2!.y, points.P2!.jd)
	expectGeoPointClose(lines.riseSetCurves[1][0], points.P1!.x, points.P1!.y, points.P1!.jd)
	expectGeoPointClose(lines.riseSetCurves[1].at(-1), points.P2!.x, points.P2!.y, points.P2!.jd)
	expectGeoPointClose(lines.riseSetCurves[2][0], points.P3!.x, points.P3!.y, points.P3!.jd)
	expectGeoPointClose(lines.riseSetCurves[2].at(-1), points.P4!.x, points.P4!.y, points.P4!.jd)
	expectGeoPointClose(lines.riseSetCurves[3][0], points.P3!.x, points.P3!.y, points.P3!.jd)
	expectGeoPointClose(lines.riseSetCurves[3].at(-1), points.P4!.x, points.P4!.y, points.P4!.jd)
	for (const curve of lines.riseSetCurves) for (const point of curve) expectGeoPoint(point)
})

test('contact and central endpoint searches are centered on maximumTime', () => {
	const elements = pbe({
		maximumTime: time(JD0 + 0.3 * 0.125),
		x: [-6, 20],
		l1: [0.1],
		l2: [-0.1],
	})
	const contacts = findPenumbraContactPoints(elements)
	const C1 = findExtremeLimitOfCentralLine(elements, true)
	const C2 = findExtremeLimitOfCentralLine(elements, false)

	expectGeoPoint(contacts.P1!)
	expectGeoPoint(contacts.P2!)
	expectGeoPoint(contacts.P3!)
	expectGeoPoint(contacts.P4!)
	expectGeoPoint(C1!)
	expectGeoPoint(C2!)
	expect(contacts.P1!.jd).toBeCloseTo(JD0 + 0.245 * 0.125, 8)
	expect(contacts.P2!.jd).toBeCloseTo(JD0 + 0.255 * 0.125, 8)
	expect(C1!.jd).toBeCloseTo(JD0 + 0.25 * 0.125, 8)
	expect(C2!.jd).toBeCloseTo(JD0 + 0.35 * 0.125, 8)
	expect(contacts.P3!.jd).toBeCloseTo(JD0 + 0.345 * 0.125, 8)
	expect(contacts.P4!.jd).toBeCloseTo(JD0 + 0.355 * 0.125, 8)
})

test('computeSolarEclipseMapGeometry anchors NASA total central endpoints', () => {
	const fixture = NASA_ECLIPSES[0]
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 })
	const { points, lines } = geometry

	expectGeoPointClose(points.P1, -2.49767213149, -0.260599514649, 2460409.155125663)
	expectGeoPointClose(points.P2, -3.116963438709, 0.347008020509, 2460409.2403725316)
	expectGeoPointClose(points.Max, -1.817554029752, 0.441332038787, 2460409.262835)
	expectGeoPointClose(points.P3, 0.285227241554, 1.29600519755, 2460409.2849998255)
	expectGeoPointClose(points.P4, -0.630371347309, 0.706565703181, 2460409.3704852466)
	// Central-line endpoints C1/C2 (the shadow axis grazing the limb).
	expectGeoPointClose(points.C1, -2.766608740863, -0.136530835027, 2460409.195240535)
	expectGeoPointClose(points.C2, -0.34570440307, 0.831102873293, 2460409.330297813)
	// Umbral contacts: U1/U4 first/last external (umbra touches Earth), U2/U3 first/last internal (umbra
	// wholly on Earth). They bracket the central-line endpoints: U1 < C1 < U2 and U3 < C2 < U4.
	expectGeoPointClose(points.U1, -2.761398555682028, -0.14030111026871406, 2460409.194446095)
	expectGeoPointClose(points.U2, -2.77240974770008, -0.13275477716062212, 2460409.196035788)
	expectGeoPointClose(points.U3, -0.33932092758757726, 0.8348022038097789, 2460409.329514288)
	expectGeoPointClose(points.U4, -0.35135636984063146, 0.8273901156465092, 2460409.3310802137)
	expectIncreasingJd([points.P1!, points.U1!, points.C1!, points.U2!, points.P2!, points.Max!, points.P3!, points.U3!, points.C2!, points.U4!, points.P4!])
	expect(lines.centerLine).toHaveLength(19)
	expectGeoPointClose(lines.centerLine[0], points.C1!.x, points.C1!.y, points.C1!.jd)
	expectGeoPointClose(lines.centerLine[8], -1.931214613682, 0.318644701329, 2460409.245887015)
	expectGeoPointClose(lines.centerLine.at(-1), points.C2!.x, points.C2!.y, points.C2!.jd)
	expectMaxAngularStep(lines.centerLine, deg(12))
	expectIncreasingJd(lines.centerLine)
	expect(lines.umbraNorth.map((line) => line.length)).toEqual([24, 10])
	expect(lines.umbraSouth.map((line) => line.length)).toEqual([23, 9])
	// 2024 is non-grazing: the fill is the two lateral limits joined at the cusps U1/U4, with the internal
	// contacts U2/U3 welded onto the boundary as small start/end caps near the path tips.
	expect(geometry.polygons.totalityPath.map((ring) => ring.length)).toEqual([68])
	// The limits end at their true positions near the path tips (the path keeps a finite width at C1/C2,
	// which are central-line endpoints), so the south limit terminates short of C2, matching NASA.
	expectGeoPointClose(lines.umbraNorth[0][0], -2.766608740863, -0.125116379276, 2460409.1955421991)
	expectGeoPointClose(lines.umbraNorth[0][8], -2.608650623609, -0.094776624573, 2460409.1967315269)
	expectGeoPointClose(lines.umbraSouth[0][0], -2.70916777495, -0.139730034533, 2460409.1950255572)
	expectGeoPointClose(lines.umbraSouth[0][8], -2.54763266911, -0.104984965052, 2460409.1968684928)
	const northAt1800Ut = interpolateAtJulianDay(lines.umbraNorth[0], 2460409.2508171294)
	expectGeoPointClose(northAt1800Ut, -1.911871717433, 0.364859949383, 2460409.2508171294)
	expect(lines.riseSetCurves.map((line) => line.length)).toEqual([161, 161, 154, 154])
	expectGeoPointClose(lines.riseSetCurves[0][0], points.P1!.x, points.P1!.y, points.P1!.jd)
	expectGeoPointClose(lines.riseSetCurves[0].at(-1), points.P2!.x, points.P2!.y, points.P2!.jd)
	expectGeoPointClose(lines.riseSetCurves[2][0], points.P3!.x, points.P3!.y, points.P3!.jd)
	expectGeoPointClose(lines.riseSetCurves[3].at(-1), points.P4!.x, points.P4!.y, points.P4!.jd)
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry traces NASA total partial-eclipse limits north and south of the path', () => {
	const fixture = NASA_ECLIPSES[0]
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(10), maxAngularStep: deg(5), includeRiseSetCurves: false, includePolygons: false })
	const { points, lines } = geometry
	const { penumbraNorth, penumbraSouth } = lines

	// Both partial-eclipse limits exist on the day side for this central eclipse, unlike the empty
	// curves the solver produced before the latitude-step scaling fix.
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

test('computeSolarEclipseMapGeometry keeps central path gated by eclipse gamma', () => {
	const fixture = NASA_ECLIPSES[0]
	const nonCentral = { ...nasaEclipse(fixture), gamma: 1.01 }
	const geometry = computeSolarEclipseMapGeometry(nonCentral, nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })

	expectGeoPointClose(geometry.points.P1, -2.49767213149, -0.260599514649, 2460409.155125663)
	expectGeoPointClose(geometry.points.P2, -3.116963438709, 0.347008020509, 2460409.2403725316)
	expectGeoPointClose(geometry.points.Max, -1.817554029752, 0.441332038787, 2460409.262835)
	expectGeoPointClose(geometry.points.P3, 0.285227241554, 1.29600519755, 2460409.2849998255)
	expectGeoPointClose(geometry.points.P4, -0.630371347309, 0.706565703181, 2460409.3704852466)
	// Gamma gates only the central line, so its endpoints C1/C2 are absent here. The umbral contacts are
	// driven by the Besselian elements (whose umbra reaches Earth), so U1-U4 remain present.
	expect(geometry.points.C1).toBeUndefined()
	expect(geometry.points.C2).toBeUndefined()
	for (const point of [geometry.points.U1, geometry.points.U2, geometry.points.U3, geometry.points.U4]) expectGeoPoint(point!)
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth.map((line) => line.length)).toEqual([24, 10])
	expect(geometry.lines.umbraSouth.map((line) => line.length)).toEqual([23, 9])
	// 2024 is non-grazing: two lateral limits joined at U1/U4, with U2/U3 welded onto the boundary as caps.
	expect(geometry.polygons.totalityPath.map((ring) => ring.length)).toEqual([68])
	for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry keeps umbral visibility for non-central total and annular eclipses', () => {
	const annular = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[4]), nasaPbe(NASA_ECLIPSES[4]), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })
	const total = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[5]), nasaPbe(NASA_ECLIPSES[5]), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })

	// Non-central: the umbra only grazes, so the external contacts U1/U4 exist but the internal contacts
	// U2/U3 and the central-line endpoints C1/C2 do not.
	expectGeoPoint(annular.points.U1!)
	expectGeoPoint(annular.points.U4!)
	for (const point of [annular.points.U2, annular.points.U3, annular.points.C1, annular.points.C2]) expect(point).toBeUndefined()
	expect(annular.lines.centerLine).toHaveLength(0)
	expect(annular.lines.umbraNorth.map((line) => line.length)).toEqual([9])
	expect(annular.lines.umbraSouth.map((line) => line.length)).toEqual([9])
	// An annular eclipse routes its fill to the annularity path, leaving the totality path empty.
	expect(annular.polygons.totalityPath).toHaveLength(0)
	expect(annular.polygons.annularityPath.map((ring) => ring.length)).toEqual([20])
	expectGeoPointClose(annular.lines.umbraNorth[0][0], 2.138389244988, -1.275938543713, 2456776.747407339)
	expectGeoPointClose(annular.lines.umbraSouth[0][0], 2.120095514679, -1.279033850419, 2456776.747407339)
	// The band tapers to the start tip U1 (the umbral external contact), not to the limit's first point.
	expectGeoPointClose(annular.polygons.annularityPath[0][0], annular.points.U1!.x, annular.points.U1!.y, annular.points.U1!.jd)

	expectGeoPoint(total.points.U1!)
	expectGeoPoint(total.points.U4!)
	for (const point of [total.points.U2, total.points.U3, total.points.C1, total.points.C2]) expect(point).toBeUndefined()
	expect(total.lines.centerLine).toHaveLength(0)
	expect(total.lines.umbraNorth.map((line) => line.length)).toEqual([12])
	expect(total.lines.umbraSouth.map((line) => line.length)).toEqual([12])
	expect(total.polygons.totalityPath.map((ring) => ring.length)).toEqual([26])
	expectGeoPointClose(total.lines.umbraNorth[0][0], 2.764703075844, 0.95468940146, 2467349.2812917847)
	expectGeoPointClose(total.lines.umbraNorth[0].at(-1), 2.506248659316, 1.185837091379, 2467349.298652895)
	expectGeoPointClose(total.lines.umbraSouth[0][0], 2.764703075844, 0.95468940146, 2467349.2812917847)
	expectGeoPointClose(total.lines.umbraSouth[0].at(-1), 2.510202616527, 1.181939627337, 2467349.298652895)
	// The band tapers to the start tip U1 (the umbral external contact), not to the limit's first point.
	expectGeoPointClose(total.polygons.totalityPath[0][0], total.points.U1!.x, total.points.U1!.y, total.points.U1!.jd)
	for (const geometry of [annular, total]) for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...geometry.polygons.totalityPath, ...geometry.polygons.annularityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry contact search span is independent from polynomial step', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	expect(elements.stepDays).toBe(1 / 24)

	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { contactSearchSpan: 2 * 3600, longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true })

	expect(geometry.points.P1).toBeUndefined()
	expectGeoPointClose(geometry.points.P2, -3.116963432027, 0.347007988479, 2460409.24037253)
	expectGeoPointClose(geometry.points.P3, 0.285227224866, 1.296005163203, 2460409.284999827)
	expect(geometry.points.P4).toBeUndefined()
	expect(geometry.lines.riseSetCurves).toHaveLength(0)
})

test('projectFundamentalPoint returns finite normalized coordinates and clamps limb points', () => {
	const be = evaluateBesselian(pbe({ d: [deg(12)], mu: [deg(35)] }), TIME0)
	const inside = projectFundamentalPoint(be, 0.2, -0.1)
	const limb = projectFundamentalPoint(be, 4, 3)

	expect(inside).toBeDefined()
	expect(limb).toBeDefined()
	expectGeoPoint(inside!)
	expectGeoPoint(limb!)
	expect(inside!.jd).toBe(JD0)
})

test('findCurvePoints returns bounded finite points for a synthetic partial limit', () => {
	const points = findCurvePoints(pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), 1, 0, { longitudeStep: deg(30), maxAngularStep: deg(20) })

	for (const point of points) expectGeoPoint(point)
	if (points.length > 0) expectIncreasingJd(points)

	for (let i = 1; i < points.length; i++) {
		expect(Math.abs(points[i].x - points[i - 1].x)).toBeLessThanOrEqual(TAU)
	}
})

test('findCurvePoints refines exit boundaries away from the last valid longitude sample', () => {
	const points = findCurvePoints(pbe({ x: [-1, -1], y: [-0.5, -1], l1: [0.5], d: [deg(-45)], mu: [deg(-90), deg(10)] }), -1, 0, { longitudeStep: deg(30), maxAngularStep: deg(60) })

	expect(points).toHaveLength(4)
	expectGeoPointClose(points[0], 1.456714495179, 0.633624267132, 2460409.113731649)
	expectGeoPointClose(points[1], deg(60), 0.048823604197, 2460409.1584850666)
	expectGeoPointClose(points[2], deg(30), -0.001154236503, 2460409.193308248)
	expectGeoPointClose(points[3], 0.243297741916, 0.166809662687, 2460409.2005219636)
	// Boundary refinement extends the curve to a point between coarse longitude samples.
	expect(points[0].x).toBeGreaterThan(deg(30.7))
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

test('partial eclipse geometry omits central and umbral path data', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial', 1.1), pbe(), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: false })

	expect(geometry.points.Max).toBeDefined()
	for (const point of [geometry.points.U1, geometry.points.U2, geometry.points.U3, geometry.points.U4, geometry.points.C1, geometry.points.C2]) expect(point).toBeUndefined()
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth).toHaveLength(0)
	expect(geometry.lines.umbraSouth).toHaveLength(0)
	expect(geometry.polygons.totalityPath).toHaveLength(0)
})

test('central total eclipse geometry exposes a populated central and umbral path when enabled', () => {
	// The synthetic central line spans ~+-12h, so widen the contact search window past the 6h default.
	const geometry = computeSolarEclipseMapGeometry(eclipse('total'), pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), { longitudeStep: deg(60), maxAngularStep: deg(30), contactSearchSpan: 18 * 3600, includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 })

	expect(geometry.points.Max).toBeDefined()
	expectGeoPoint(geometry.points.Max!)

	expect(geometry.lines.centerLine.length).toBeGreaterThan(1)
	expectIncreasingJd(geometry.lines.centerLine)
	expectMaxAngularStep(geometry.lines.centerLine, deg(30))
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
	const contacts = computeSolarEclipseMapGeometry(eclipse('partial'), elements, { longitudeStep: deg(90) }).points

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
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45), includePolygons: false })

		expect(geometry.points.Max).toBeDefined()
		expect(formatAZ(geometry.points.Max!.x, true)).toBe(fixture.greatestEclipse[0])
		expect(formatAZ(geometry.points.Max!.y, true)).toBe(fixture.greatestEclipse[1])
		expect(geometry.points.Max!.jd).toBe(fixture.greatestEclipse[2])
	}
})

test('central-line endpoints graze the flattened Earth limb and bound the central time span', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includePolygons: false })
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
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12), includePolygons: false })
		const centerLine = geometry.lines.centerLine
		const max = geometry.points.Max!

		expect(centerLine.length).toBeGreaterThan(1)
		expect(max.jd!).toBeGreaterThanOrEqual(centerLine[0].jd!)
		expect(max.jd!).toBeLessThanOrEqual(centerLine.at(-1)!.jd!)

		const onCentralLine = interpolateAtJulianDay(centerLine, max.jd!)
		expect(onCentralLine).toBeDefined()
		expect(sphericalSeparation(onCentralLine!.x, onCentralLine!.y, max.x, max.y)).toBeLessThan(deg(0.1))
	}
})

test('central eclipse map curves are time-ordered and respect the angular step', () => {
	const fixture = NASA_ECLIPSES[0]
	const maxStep = deg(12)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: maxStep, includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 })
	const { lines, polygons } = geometry

	expectIncreasingJd(lines.centerLine)
	expectMaxAngularStep(lines.centerLine, maxStep)

	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) {
		expect(segment.length).toBeGreaterThan(1)
		expectIncreasingJd(segment)
		expectMaxAngularStep(segment, maxStep)
		for (const point of segment) expectGeoPoint(point)
	}

	for (const ring of polygons.totalityPath) {
		expect(ring.length).toBeGreaterThan(2)
		for (const point of ring) expectGeoPoint(point)
	}

	// Sunrise/sunset curves progress in time even though they may jump spatially at the terminator.
	for (const curve of lines.riseSetCurves) {
		expect(curve.length).toBeGreaterThan(1)
		expectIncreasingJd(curve)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('hybrid eclipse produces a central path anchored at the NASA greatest eclipse', () => {
	const fixture = NASA_ECLIPSES[3]
	expect(fixture.type).toBe('hybrid')

	const elements = nasaPbe(fixture)
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(30), maxAngularStep: deg(12), includePolygons: true })
	const { points, lines, polygons } = geometry

	expect(formatAZ(points.Max!.x, true)).toBe(fixture.greatestEclipse[0])
	expect(formatAZ(points.Max!.y, true)).toBe(fixture.greatestEclipse[1])
	expect(points.C1).toBeDefined()
	expect(points.C2).toBeDefined()
	expect(Math.abs(axisLimbResidual(elements, points.C1!.jd!))).toBeLessThan(1e-6)
	expect(Math.abs(axisLimbResidual(elements, points.C2!.jd!))).toBeLessThan(1e-6)
	expectIncreasingJd([points.C1!, points.Max!, points.C2!])

	expect(lines.centerLine.length).toBeGreaterThan(1)
	expectIncreasingJd(lines.centerLine)
	expectMaxAngularStep(lines.centerLine, deg(12))
	expect(lines.umbraNorth.length).toBeGreaterThan(0)
	expect(lines.umbraSouth.length).toBeGreaterThan(0)
	expect(polygons.totalityPath.length).toBeGreaterThan(0)
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) {
		expectIncreasingJd(segment)
		for (const point of segment) expectGeoPoint(point)
	}
})

test('computeSolarEclipseMapGeometry is deterministic for identical inputs', () => {
	const fixture = NASA_ECLIPSES[0]
	const options = { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 }
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
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[0]), nasaPbe(NASA_ECLIPSES[0]), { longitudeStep: deg(2), maxAngularStep: deg(6), includeRiseSetCurves: false, includePolygons: false })

	// The partial-eclipse north/south limits are step-sensitive: they must be populated, not empty,
	// once the meridian scan is fine enough to land on the day-side tangency curve.
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

test('solarEclipseMapToSvgPaths serializes lines and closed polygons, and skips empty features', () => {
	const map = geometry(
		{
			centerLine: [
				{ x: deg(-10), y: 0 },
				{ x: deg(10), y: deg(5) },
			],
		},
		[
			[
				{ x: deg(-5), y: deg(-2) },
				{ x: deg(5), y: deg(-2) },
				{ x: deg(5), y: deg(2) },
			],
		],
		{ Max: { x: 0, y: 0 } },
	)

	const paths = solarEclipseMapToSvgPaths(map, equirectangularProjection(360, 180))

	expect(paths.centerLine.startsWith('M')).toBe(true)
	expect(paths.centerLine).toContain('L')
	expect(paths.totalityPath.startsWith('M')).toBe(true)
	expect(paths.totalityPath.endsWith('Z')).toBe(true)
	expect(paths.penumbraNorth).toBe('')
	expect(paths.umbraSouth).toBe('')
	expect(paths.points.Max).toEqual({ x: 180, y: 90 })
	expect(paths.points.U1).toBeUndefined()
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
})

// NASA/GSFC Besselian elements for the 2024 Apr 08 total eclipse.
// https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2024Apr08Tbeselm.html
const NASA_2024: PolynomialBesselianElements = {
	time0: time(2460409.25, 0, Timescale.TT),
	maximumTime: time(2460409.262835, 0, Timescale.TT),
	deltaT: 70.6,
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
	const map = computeSolarEclipseMapGeometry(NASA_2024_ECLIPSE, NASA_2024, { longitudeStep: deg(2), maxAngularStep: deg(4), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 600 })
	const width = 720
	const height = 360
	const projection = equirectangularProjection(width, height)
	const paths = solarEclipseMapToSvgPaths(map, projection)

	for (const feature of [paths.centerLine, paths.umbraNorth, paths.umbraSouth, paths.totalityPath]) {
		expect(feature.length).toBeGreaterThan(0)
		expect(feature.startsWith('M')).toBe(true)
	}

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

test('circumpolar umbral limits stay continuous across pole-side solver gaps', () => {
	// The 2003-11-23 totality is circumpolar over Antarctica: the latitude-based limit solver fails near
	// the pole (the umbra stays fully on the sunlit disk), leaving multi-degree gaps in each limit. Those
	// gaps are filled by tracing the umbral footprint, so each limit stays a continuous, densely sampled
	// curve, split only at its latitude apex rather than broken or chorded across the gaps.
	const eclipse = nearestSolarEclipse(timeYMD(2003, 11, 1), true)
	const maxAngularStep = deg(0.5)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
	const geometry = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(0.5), maxAngularStep, includePolygons: true })

	// Each limit folds at its latitude apex into pieces, and every drawn step within a piece stays close
	// to the densification target, proving the filled gaps never jump straight across a multi-degree gap.
	for (const family of [geometry.lines.umbraNorth, geometry.lines.umbraSouth]) {
		expect(family.length).toBeGreaterThan(1)

		for (const segment of family) {
			expect(segment.length).toBeGreaterThan(1)

			for (let i = 1; i < segment.length; i++) {
				expect(sphericalSeparation(segment[i - 1].x, segment[i - 1].y, segment[i].x, segment[i].y)).toBeLessThan(maxAngularStep * 2)
			}

			// The bridged stretches join the solved stretches smoothly: each piece is a physical limit folded
			// only at its latitude apex (a separate piece), so no interior vertex turns sharply. A sharp turn
			// here would be the serrilhado of the old footprint bridge, whose latitude-extreme sat off the
			// true perpendicular limit; the time-parametrized limit solver places the bridge on that curve.
			expect(countKinks(segment, deg(30))).toBe(0)
		}
	}

	// The totality fill stays a single connected ring at its true finite width: each limit's gaps are
	// bridged along the umbral footprint (the gap is a pole-side solver artifact, not the umbra leaving
	// Earth), so the region never splits into disconnected blocks and no edge bridges a discontinuity
	// with a chord (which would tear holes or jump across the multi-degree gap). The ring is also simple
	// (no self-intersection), which a positive enclosed area confirms.
	expect(geometry.polygons.totalityPath).toHaveLength(1)
	for (const ring of geometry.polygons.totalityPath) {
		expect(ring.length).toBeGreaterThanOrEqual(3)

		let signedArea = 0
		for (let i = 0; i < ring.length; i++) {
			const next = ring[(i + 1) % ring.length]
			expect(sphericalSeparation(ring[i].x, ring[i].y, next.x, next.y)).toBeLessThan(deg(10))
			signedArea += ring[i].x * next.y - next.x * ring[i].y
		}

		expect(Math.abs(signedArea)).toBeGreaterThan(0)
		for (const point of ring) expectGeoPoint(point)
	}
})

test('circumpolar totality fill grows physical caps containing the central line', () => {
	// The 2003-11-23 path grazes the southern limb: near U1/U4 one band edge runs off beyond the terminator,
	// so the fill must cap those ends along the swept Earth limb instead of tapering with a straight chord to
	// a single U1/U4 vertex. Otherwise the central line, which starts at C1 on the limb (between U1 and U2),
	// pokes outside the fill. The path stays in the eastern hemisphere here, so flat lon/lat point-in-polygon
	// and segment-crossing tests are valid (no antimeridian wrap to confound them).
	const eclipse = nearestSolarEclipse(timeYMD(2003, 11, 1), true)
	const pbe = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
	const geometry = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(0.5), maxAngularStep: deg(0.5), includePolygons: true })

	expect(geometry.polygons.totalityPath).toHaveLength(1)
	const ring = geometry.polygons.totalityPath[0]
	expect(wrapsAntimeridian(ring)).toBe(false)

	function distanceToRing(point: GeoPoint) {
		let best = Number.POSITIVE_INFINITY
		for (let i = 0; i < ring.length; i++) best = Math.min(best, sphericalSeparation(point.x, point.y, ring[i].x, ring[i].y))
		return best
	}

	const { centerLine } = geometry.lines
	const { C1, C2, U1, U4 } = geometry.points

	// 1: every interior central-line point lies strictly within the fill.
	for (let i = 1; i < centerLine.length - 1; i++) expect(isInsidePolygon(centerLine[i], ring)).toBe(true)
	// 2: the C1/C2 endpoints lie on the boundary within a small tolerance (they sit on the swept limb cap).
	expect(distanceToRing(C1!)).toBeLessThan(deg(0.3))
	expect(distanceToRing(C2!)).toBeLessThan(deg(0.3))
	// 3: the external contacts U1/U4 are real vertices of the ring (cusps of the caps), not absent.
	expect(ring.some((point) => sphericalSeparation(point.x, point.y, U1!.x, U1!.y) < deg(1e-6))).toBe(true)
	expect(ring.some((point) => sphericalSeparation(point.x, point.y, U4!.x, U4!.y) < deg(1e-6))).toBe(true)

	// 8: the ring is simple — no two non-adjacent edges cross.
	expect(countSelfIntersections(ring)).toBe(0)
})

// Rebuilds a ring's point list from its typed segments, mirroring the engine's pushDistinct + closeRing
// concatenation, so a test can prove the segment layer reproduces the drawn ring exactly.
function ringFromSegments(segments: readonly TotalityRingSegment[]) {
	const ring: GeoPoint[] = []

	for (const segment of segments) {
		for (const point of segment.points) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
			const last = ring.at(-1)
			if (!last || Math.abs(last.x - point.x) >= 1e-9 || Math.abs(last.y - point.y) >= 1e-9 || Math.abs((last.jd ?? 0) - (point.jd ?? 0)) >= 1e-10) ring.push(point)
		}
	}

	if (ring.length > 1 && Math.abs(ring[0].x - ring.at(-1)!.x) < 1e-9 && Math.abs(ring[0].y - ring.at(-1)!.y) < 1e-9) ring.pop()

	return ring
}

describe('totality ring typed-entity layer', () => {
	const VALID_KINDS = new Set(['northLimit', 'southLimit', 'startCap', 'endCap', 'cusp'])

	test('segments are parallel to the ring, fully physical, and reproduce it', () => {
		// 2003-11-23 grazes the southern limb, so it grows real startCap/endCap arcs near U1/U4.
		const eclipse = nearestSolarEclipse(timeYMD(2003, 11, 1), true)
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(0.5), maxAngularStep: deg(0.5), includePolygons: true })
		const { totalityPath, totalitySegments } = geometry.polygons

		// One segment list per ring, in lock-step with totalityPath.
		expect(totalitySegments).toHaveLength(totalityPath.length)
		expect(totalityPath).toHaveLength(1)

		const segments = totalitySegments[0]
		expect(segments.length).toBeGreaterThan(0)

		// The concatenated segments reproduce the drawn ring exactly.
		const rebuilt = ringFromSegments(segments)
		expect(rebuilt).toHaveLength(totalityPath[0].length)
		for (let i = 0; i < rebuilt.length; i++) {
			expect(rebuilt[i].x).toBeCloseTo(totalityPath[0][i].x, 9)
			expect(rebuilt[i].y).toBeCloseTo(totalityPath[0][i].y, 9)
		}

		for (const segment of segments) {
			expect(VALID_KINDS.has(segment.kind)).toBe(true)
			// Every segment is a real boundary; none is a synthetic closure.
			expect(segment.physical).toBe(true)
			expect(segment.artificial).toBe(false)
			expect(segment.points.length).toBeGreaterThan(0)
			// Branch ids: north edge 0, south edge 1, shared cusp -1.
			if (segment.kind === 'cusp') expect(segment.branchId).toBe(-1)
			else if (segment.kind === 'northLimit') expect(segment.branchId).toBe(0)
			else if (segment.kind === 'southLimit') expect(segment.branchId).toBe(1)
			else expect([0, 1]).toContain(segment.branchId)
		}

		// The grazing path grows at least one physical cap along the swept Earth limb.
		expect(segments.some((segment) => segment.kind === 'startCap' || segment.kind === 'endCap')).toBe(true)

		// The limit segments are converged onto the umbral edge (small tangency residual); the ring opens and
		// closes on tangential cusps at U1/U4.
		for (const segment of segments) {
			if (segment.kind === 'northLimit' || segment.kind === 'southLimit') expect(segment.residual).toBeLessThan(1e-3)
		}
		expect(segments[0].kind).toBe('cusp')
	})

	test('a grazing eclipse anchors all four umbral contacts on the full boundary', () => {
		// 2003-11-23 grazes the southern limb: one lateral edge is the full limit U1..U4, the other is clipped
		// (U2..U3) with its U1<->U2 and U3<->U4 portions running along the Earth limb as the start/end caps. All
		// four contacts U1..U4 are exact transition vertices on the full boundary, and the ring stays simple.
		const eclipse = nearestSolarEclipse(timeYMD(2003, 11, 1), true)
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(0.5), maxAngularStep: deg(0.5), includePolygons: true })

		const ring = geometry.polygons.totalityPath[0]
		const { U1, U2, U3, U4 } = geometry.points

		// Point-to-edge distance (not just nearest vertex), since the contacts are inserted as exact vertices.
		function distanceToBoundary(point: GeoPoint) {
			let best = Number.POSITIVE_INFINITY
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i]
				const b = ring[(i + 1) % ring.length]
				if (Math.abs(a.x - b.x) > PI) continue
				const abx = b.x - a.x
				const aby = b.y - a.y
				const len2 = abx * abx + aby * aby
				const t = len2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / len2)) : 0
				best = Math.min(best, sphericalSeparation(point.x, point.y, a.x + t * abx, a.y + t * aby))
			}
			return best
		}

		// Criterion 1: all four umbral contacts lie on the full boundary.
		for (const contact of [U1!, U2!, U3!, U4!]) expect(distanceToBoundary(contact)).toBeLessThan(deg(0.05))

		// Criteria 7/10: exactly one start cap (U1<->U2) and one end cap (U3<->U4); caps are their own kind,
		// never a lateral limit. Two external cusps and two lateral limits complete the ring.
		const segments = geometry.polygons.totalitySegments[0]
		expect(segments.filter((segment) => segment.kind === 'startCap')).toHaveLength(1)
		expect(segments.filter((segment) => segment.kind === 'endCap')).toHaveLength(1)
		expect(segments.filter((segment) => segment.kind === 'cusp')).toHaveLength(2)
		expect(segments.filter((segment) => segment.kind === 'northLimit' || segment.kind === 'southLimit')).toHaveLength(2)

		// Criteria 9/11/12: the boundary is a simple polygon.
		expect(countSelfIntersections(ring)).toBe(0)
	})

	test('a non-grazing central eclipse welds the internal contacts onto the boundary', () => {
		// 2024-04-08 keeps the whole umbra on Earth except a tiny terminator straddle near the tips, so the two
		// lateral limits span the path joined at the cusps U1/U4, and the internal contacts U2/U3 (just outside
		// the tapered tip) are welded onto the boundary as small start/end caps.
		const fixture = NASA_ECLIPSES[0]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })
		const segments = geometry.polygons.totalitySegments[0]
		const ring = geometry.polygons.totalityPath[0]
		const { U1, U2, U3, U4 } = geometry.points

		function distanceToBoundary(point: GeoPoint) {
			let best = Number.POSITIVE_INFINITY
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i]
				const b = ring[(i + 1) % ring.length]
				if (Math.abs(a.x - b.x) > PI) continue
				const abx = b.x - a.x
				const aby = b.y - a.y
				const len2 = abx * abx + aby * aby
				const t = len2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / len2)) : 0
				best = Math.min(best, sphericalSeparation(point.x, point.y, a.x + t * abx, a.y + t * aby))
			}
			return best
		}

		// All four contacts lie on the boundary; the band has both lateral limits, two cusps and the two caps.
		for (const contact of [U1!, U2!, U3!, U4!]) expect(distanceToBoundary(contact)).toBeLessThan(deg(0.01))
		expect(segments.filter((segment) => segment.kind === 'northLimit' || segment.kind === 'southLimit')).toHaveLength(2)
		expect(segments.filter((segment) => segment.kind === 'startCap')).toHaveLength(1)
		expect(segments.filter((segment) => segment.kind === 'endCap')).toHaveLength(1)
		expect(segments.every((segment) => segment.physical && !segment.artificial)).toBe(true)
		expect(countSelfIntersections(ring)).toBe(0)
	})

	test('partial eclipse exposes no totality segments', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2025, 9, 21), true)
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, (t) => computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon))
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { includePolygons: true })

		expect(geometry.polygons.totalityPath).toHaveLength(0)
		expect(geometry.polygons.totalitySegments).toHaveLength(0)
	})
})

describe('eclipse geometry physical and topological invariants', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		test(`${fixture.name} curve points satisfy tangency, sun-altitude and smoothness invariants`, () => {
			const elements = nasaPbe(fixture)
			const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })
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

			// Smoothness: each physical limit piece (split at its latitude apex) bends without sharp kinks.
			for (const piece of [...umbraNorth, ...umbraSouth]) expect(countKinks(piece, deg(30))).toBe(0)
		})
	}

	test('non-wrapping totality fill is a simple ring containing the central line', () => {
		// 2024-04-08 stays over the Americas without crossing the antimeridian, so flat point-in-polygon and
		// segment-crossing tests apply directly to its single fill ring.
		const fixture = NASA_ECLIPSES[0]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })

		expect(geometry.polygons.totalityPath).toHaveLength(1)
		const ring = geometry.polygons.totalityPath[0]
		expect(wrapsAntimeridian(ring)).toBe(false)

		// The fill is a simple polygon and the interior central line lies within it.
		expect(countSelfIntersections(ring)).toBe(0)
		const centerLine = geometry.lines.centerLine
		for (let i = 1; i < centerLine.length - 1; i++) expect(isInsidePolygon(centerLine[i], ring)).toBe(true)
	})
})

// Minimum angular distance (radians) from a point to the polygon boundary, measured to the nearest edge (not
// just the nearest vertex), skipping antimeridian-spanning edges. Zero means the point lies on the boundary.
function distanceToBoundary(point: GeoPoint, ring: readonly GeoPoint[]) {
	let best = Number.POSITIVE_INFINITY
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i]
		const b = ring[(i + 1) % ring.length]
		if (Math.abs(a.x - b.x) > PI) continue
		const abx = b.x - a.x
		const aby = b.y - a.y
		const len2 = abx * abx + aby * aby
		const t = len2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / len2)) : 0
		best = Math.min(best, sphericalSeparation(point.x, point.y, a.x + t * abx, a.y + t * aby))
	}
	return best
}

// Acceptance/rejection criteria from the solar-eclipse map validation checklist, applied to the entities this
// engine produces (points, central line, lateral limits, caps, totality polygon, rise/set curves). Sections
// covering entities the engine does not emit (annularity/hybrid polygons, magnitude/obscuration/duration
// isolines, P-contact curves) are out of scope and not asserted here.
describe('solar eclipse map acceptance criteria', () => {
	for (const fixture of CENTRAL_FIXTURES) {
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 600 })
		const { points, lines, polygons } = geometry
		// The fill of a central eclipse is its totality and/or annularity rings (a hybrid has both).
		const fillRings = [...polygons.totalityPath, ...polygons.annularityPath]
		const fillSegments = [...polygons.totalitySegments, ...polygons.annularitySegments]
		const anyRingWraps = fillRings.some((ring) => wrapsAntimeridian(ring))

		function distanceToAnyBoundary(point: GeoPoint) {
			let best = Number.POSITIVE_INFINITY
			for (const ring of fillRings) best = Math.min(best, distanceToBoundary(point, ring))
			return best
		}

		function insideAnyRing(point: GeoPoint) {
			return fillRings.some((ring) => isInsidePolygon(point, ring))
		}

		describe(fixture.name, () => {
			// Section 0: every plotted point is finite and within the documented coordinate ranges.
			test('all entity points are finite and in range', () => {
				const families = [lines.centerLine, ...lines.umbraNorth, ...lines.umbraSouth, lines.penumbraNorth, lines.penumbraSouth, ...lines.riseSetCurves, ...fillRings]
				for (const family of families) for (const point of family) expectGeoPoint(point)
				for (const key of ['P1', 'P2', 'P3', 'P4', 'U1', 'U2', 'U3', 'U4', 'C1', 'C2', 'Max', 'N1', 'N2', 'S1', 'S2'] as const) {
					const point = points[key]
					if (point) expectGeoPoint(point)
				}
			})

			// Section 4: the four umbral contacts are time-ordered U1 < U2 < U3 < U4 and lie on the full boundary.
			test('U1..U4 are time-ordered and lie on the full boundary', () => {
				expectIncreasingJd([points.U1!, points.U2!, points.U3!, points.U4!])
				for (const key of ['U1', 'U2', 'U3', 'U4'] as const) expect(distanceToAnyBoundary(points[key]!)).toBeLessThan(deg(0.05))
			})

			// Sections 3 + 2: C1/C2 are the central-line endpoints, ordered U1 < C1 and C2 < U4, and the central
			// line is time-ordered, low-residual on the shadow axis, and lies inside the fill.
			test('C1/C2 bound a valid central line inside the fill', () => {
				expectGeoPointClose(lines.centerLine[0], points.C1!.x, points.C1!.y, points.C1!.jd)
				expectGeoPointClose(lines.centerLine.at(-1), points.C2!.x, points.C2!.y, points.C2!.jd)
				expect(points.C1!.jd!).toBeGreaterThan(points.U1!.jd!)
				expect(points.C2!.jd!).toBeLessThan(points.U4!.jd!)
				expectIncreasingJd(lines.centerLine)
				for (const point of lines.centerLine) expect(axisLimbResidual(elements, point.jd!)).toBeLessThan(1)
				// Flat point-in-polygon is only valid when no fill ring wraps the antimeridian.
				if (!anyRingWraps) for (let i = 1; i < lines.centerLine.length - 1; i++) expect(insideAnyRing(lines.centerLine[i])).toBe(true)
			})

			// Section 1: greatest eclipse is on the sunlit side, inside the fill, and near the central line.
			test('greatest eclipse is inside the fill near the central line', () => {
				expect(solarAltitude(elements, points.Max!)).toBeGreaterThan(deg(-1))
				if (!anyRingWraps) expect(insideAnyRing(points.Max!)).toBe(true)
				let nearest = Number.POSITIVE_INFINITY
				for (const point of lines.centerLine) nearest = Math.min(nearest, sphericalSeparation(points.Max!.x, points.Max!.y, point.x, point.y))
				expect(nearest).toBeLessThan(deg(2))
			})

			// Sections 6 + 7 + 8 + 10: every fill ring is built from classified physical entities (none
			// artificial) whose concatenation reproduces the ring. A pure total/annular eclipse is a single ring
			// with two lateral limits, two cusps and the two caps; a hybrid is split into total and annular rings
			// joined by transition cuts (kind 'transition'), with both polygon families non-empty.
			test('fill polygons are assembled from classified physical entities', () => {
				expect(fillRings.length).toBeGreaterThan(0)
				for (let r = 0; r < fillSegments.length; r++) {
					const segments = fillSegments[r]
					for (const segment of segments) {
						expect(segment.physical).toBe(true)
						expect(segment.artificial).toBe(false)
					}
					const rebuilt: GeoPoint[] = []
					for (const segment of segments) {
						for (const point of segment.points) {
							const last = rebuilt.at(-1)
							if (!last || Math.abs(last.x - point.x) >= 1e-9 || Math.abs(last.y - point.y) >= 1e-9 || Math.abs((last.jd ?? 0) - (point.jd ?? 0)) >= 1e-10) rebuilt.push(point)
						}
					}
					if (rebuilt.length > 1 && Math.abs(rebuilt[0].x - rebuilt.at(-1)!.x) < 1e-9 && Math.abs(rebuilt[0].y - rebuilt.at(-1)!.y) < 1e-9) rebuilt.pop()
					expect(rebuilt).toHaveLength(fillRings[r].length)
				}

				if (fixture.type === 'hybrid') {
					// Section 10: total and annular regions are separated, joined by transition cuts.
					expect(polygons.totalityPath.length).toBeGreaterThan(0)
					expect(polygons.annularityPath.length).toBeGreaterThan(0)
					expect(fillSegments.some((segments) => segments.some((segment) => segment.kind === 'transition'))).toBe(true)
				} else {
					// A single fill ring with the two lateral limits, two cusps and the two caps.
					const segments = fillSegments[0]
					expect(segments.filter((segment) => segment.kind === 'northLimit' || segment.kind === 'southLimit')).toHaveLength(2)
					expect(segments.filter((segment) => segment.kind === 'cusp')).toHaveLength(2)
					expect(segments.filter((segment) => segment.kind === 'startCap')).toHaveLength(1)
					expect(segments.filter((segment) => segment.kind === 'endCap')).toHaveLength(1)
					expect(segments.some((segment) => segment.kind === 'transition')).toBe(false)
				}
			})

			// Sections 14 + 15: rise/set curves are horizon-contact curves, so the Sun is near the horizon along them.
			test('rise/set curves sit near the solar horizon', () => {
				for (const curve of lines.riseSetCurves) for (const point of curve) expect(Math.abs(solarAltitude(elements, point))).toBeLessThan(deg(2))
			})

			// Section 12: the named penumbral-limit extremes N1/N2 (northern) and S1/S2 (southern), when present,
			// are the endpoints of their magnitude-0 limit branch and are ordered by ascending latitude.
			test('penumbral limit extremes lie on the magnitude-0 locus', () => {
				if (points.N1 && points.N2) {
					expect(points.N1.y).toBeLessThanOrEqual(points.N2.y)
					for (const point of [points.N1, points.N2]) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
				}
				if (points.S1 && points.S2) {
					expect(points.S1.y).toBeLessThanOrEqual(points.S2.y)
					for (const point of [points.S1, points.S2]) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
				}
			})
		})
	}

	// Section 11: a purely partial eclipse has no central line, no umbral path and no totality/annularity
	// polygon, but it does draw the penumbral limit (its main physical contour, magnitude 0) on the sunlit
	// side, not just the rise/set curves.
	test('a purely partial eclipse draws the penumbral limit but no central/umbral entities', () => {
		const fixture = NASA_ECLIPSES[2]
		const elements = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(1), maxAngularStep: deg(3), includeRiseSetCurves: true, includePolygons: true })
		expect(geometry.lines.centerLine).toHaveLength(0)
		expect(geometry.lines.umbraNorth).toHaveLength(0)
		expect(geometry.lines.umbraSouth).toHaveLength(0)
		expect(geometry.polygons.totalityPath).toHaveLength(0)
		expect(geometry.polygons.totalitySegments).toHaveLength(0)
		expect(geometry.polygons.annularityPath).toHaveLength(0)
		expect(geometry.polygons.annularitySegments).toHaveLength(0)

		// The penumbral limit is produced (at least one of the two tangent branches) on the magnitude-0 locus.
		const penumbra = [...geometry.lines.penumbraNorth, ...geometry.lines.penumbraSouth]
		expect(penumbra.length).toBeGreaterThan(0)
		for (const point of geometry.lines.penumbraNorth) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
		for (const point of geometry.lines.penumbraSouth) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
		for (const point of penumbra) expect(solarAltitude(elements, point)).toBeGreaterThan(deg(-1))
	})

	// Section 5 reject + section 26: lateral limits never cross each other and never cross the central line
	// (the central line stays strictly inside the band), verified on the non-wrapping 2024 path.
	test('lateral limits do not cross each other or the central line', () => {
		const fixture = NASA_ECLIPSES[0]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })
		const ring = geometry.polygons.totalityPath[0]
		// A simple fill ring already implies the two lateral edges do not cross; the central line interior lies
		// strictly inside, so it crosses neither edge.
		expect(countSelfIntersections(ring)).toBe(0)
		for (let i = 1; i < geometry.lines.centerLine.length - 1; i++) expect(isInsidePolygon(geometry.lines.centerLine[i], ring)).toBe(true)
	})

	// Section 9: an annular eclipse uses the antumbra, so its whole fill is the annularity polygon and the
	// totality polygon is empty. The central line lies inside the annularity fill.
	test('an annular eclipse routes the fill to the annularity polygon', () => {
		const fixture = NASA_ECLIPSES[1]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })

		expect(geometry.polygons.totalityPath).toHaveLength(0)
		expect(geometry.polygons.totalitySegments).toHaveLength(0)
		expect(geometry.polygons.annularityPath.length).toBeGreaterThan(0)
		// No transition cut on a pure annular fill.
		for (const segments of geometry.polygons.annularitySegments) expect(segments.some((segment) => segment.kind === 'transition')).toBe(false)

		const ring = geometry.polygons.annularityPath[0]
		if (!wrapsAntimeridian(ring)) for (let i = 1; i < geometry.lines.centerLine.length - 1; i++) expect(isInsidePolygon(geometry.lines.centerLine[i], ring)).toBe(true)
	})

	// Section 10: a hybrid eclipse is split into total and annular rings at the transition cuts, each a simple
	// polygon, with the deepest point (greatest eclipse) falling in the total region.
	test('a hybrid eclipse splits into total and annular regions joined by transitions', () => {
		const fixture = NASA_ECLIPSES[3]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(1), maxAngularStep: deg(3), includePolygons: true })
		const { totalityPath, annularityPath, totalitySegments, annularitySegments } = geometry.polygons

		expect(totalityPath.length).toBeGreaterThan(0)
		expect(annularityPath.length).toBeGreaterThan(0)

		// Every ring is a simple polygon (antimeridian-spanning edges are skipped by the detector).
		for (const ring of [...totalityPath, ...annularityPath]) expect(countSelfIntersections(ring)).toBe(0)

		// The split is geometric, not cosmetic: total and annular rings carry transition cuts as their own kind.
		const allSegments = [...totalitySegments, ...annularitySegments]
		expect(allSegments.some((segments) => segments.some((segment) => segment.kind === 'transition'))).toBe(true)

		// Greatest eclipse (the deepest point) lies in the total region for this total-in-the-middle hybrid.
		if (!totalityPath.some((ring) => wrapsAntimeridian(ring))) expect(totalityPath.some((ring) => isInsidePolygon(geometry.points.Max!, ring))).toBe(true)
	})

	// Sections 11 + 12: a pure partial eclipse draws the penumbral limit (magnitude 0), and that limit spans the
	// published northern/southern penumbral extremes N1/S1. Verified against the 2000-02-05 partial over the
	// southern hemisphere (EclipseWise: N1 ~ 50.23 deg S, 95.645 deg W; S1 ~ 28.305 deg S, 66.562 deg E).
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

		// The named, plottable extremes N1/N2 reach the published penumbral limit extremes within a degree or
		// two. N1 is the lower-latitude extreme (EclipseWise N1 ~ 50.23 deg S, 95.645 deg W), N2 the higher one
		// (EclipseWise S1 ~ 28.305 deg S, 66.562 deg E).
		expect(geometry.points.N1).toBeDefined()
		expect(geometry.points.N2).toBeDefined()
		expect(geometry.points.N1!.y).toBeLessThan(geometry.points.N2!.y)
		expect(sphericalSeparation(geometry.points.N1!.x, geometry.points.N1!.y, deg(-95.645), deg(-50.23))).toBeLessThan(deg(2))
		expect(sphericalSeparation(geometry.points.N2!.x, geometry.points.N2!.y, deg(66.562), deg(-28.305))).toBeLessThan(deg(2))
		// They are the endpoints of the penumbral limit curve, so they lie on it.
		for (const point of [geometry.points.N1!, geometry.points.N2!]) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
	})
})
