import { expect, test, describe } from 'bun:test'
import { nearestSolarEclipse, type SolarEclipse, type SolarEclipseType } from '../../../../../src/astronomy/bodies/sun'
import { deg, parseAngle, type Angle } from '../../../../../src/math/units/angle'
// oxfmt-ignore
import { BRANCH_MAX_DRAWABLE_GAP, centralAxisIntersectsEarth, computePolynomialBesselianElements, computeRiseSetCurves, computeSolarEclipseMapGeometry, evaluateBesselian, findCentralLineExtremePoint, findCircleIntersections, findCurvePoints, findEclipseCurvePoint, findMaximumPoint, findPenumbraContactPoints, intermediateGreatCircle, projectClosestEarthLimbPoint, projectFundamentalPoint, solarAltitudeAtPoint, solarEclipseMapToSvgPaths, splitAtMaxAbsLatitude, splitCentralLineByKind, splitDisconnectedPolylines, type SolarEclipseGeoBranch, type SolarEclipseGeoPoint, type PolynomialBesselianElements, type SolarEclipseMapGeometry } from '../../../../../src/astronomy/events/eclipse/solar/sun.eclipse.map'
import { DELTA_T_LONGITUDE_FACTOR, EARTH_E2, earthLimbExtremes, earthLimbOmega, sunMoonPosition, type SunMoonPosition } from '../../../../../src/astronomy/events/eclipse/eclipse'
import { PlateCarree, type ProjectionOptions } from '../../../../../src/astronomy/projections/projection'
import { time, Timescale, timeSubtract, timeYMD, toJulianDay } from '../../../../../src/astronomy/time/time'
import { DEG2RAD, PI, PIOVERTWO, TAU } from '../../../../../src/core/constants'
import { sphericalSeparation } from '../../../../../src/math/numerical/geometry'
import { catalogBranchRetraces, countKinks, endpointRetraces, geometryFor, interpolateAtJulianDay, limitTangencyResidual, longestProjectedSegment, maxBranchSegment } from '../../../../eclipse.util'

const JD0 = 2460409.25
const TIME0 = time(JD0)

function pbe(overrides?: Partial<PolynomialBesselianElements>): PolynomialBesselianElements {
	// Synthetic elements follow the internal convention: mu is UT-based, so the longitude correction is 0.
	return { time0: TIME0, maximumTime: TIME0, deltaT: 69, deltaTLongitudeCorrection: 0, step: 0.125, x: [0, 0.9], y: [0], l1: [0.4], l2: [-0.2], d: [0], mu: [0], tanF1: 0.0047, tanF2: -0.004, ...overrides }
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
	// Delta T longitude correction.
	return {
		time0: time(fixture.t0, 0, Timescale.TT),
		maximumTime: time(fixture.greatestEclipse[2], 0, Timescale.TT),
		deltaT: fixture.deltaT,
		deltaTLongitudeCorrection: DELTA_T_LONGITUDE_FACTOR * fixture.deltaT,
		step: 1 / 24,
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

function expectGeoPoint(point: SolarEclipseGeoPoint) {
	expect(Number.isFinite(point.x)).toBe(true)
	expect(Number.isFinite(point.y)).toBe(true)
	expect(point.x).toBeGreaterThanOrEqual(-PI)
	expect(point.x).toBeLessThanOrEqual(PI)
	expect(point.y).toBeGreaterThanOrEqual(-PIOVERTWO)
	expect(point.y).toBeLessThanOrEqual(PIOVERTWO)
}

function expectGeoPointClose(point: SolarEclipseGeoPoint | undefined, longitude: number, latitude: number, jd?: number) {
	expect(point).toBeDefined()
	expectGeoPoint(point!)
	expect(point!.x).toBeCloseTo(longitude, 10)
	expect(point!.y).toBeCloseTo(latitude, 10)
	if (jd !== undefined) expect(Math.abs(point!.jd! - jd)).toBeLessThan(1e-8)
}

function expectIncreasingJd(branch: SolarEclipseGeoBranch) {
	for (let i = 1; i < branch.length; i++) expect(branch[i].jd).toBeGreaterThan(branch[i - 1].jd!)
}

// Rise/set branches may hold two distinct points at the same instant (a tangency cusp anchored at a
// contact plus the first sampled crossing), so time only needs to be non-decreasing along them.
function expectNonDecreasingJd(branch: SolarEclipseGeoBranch) {
	for (let i = 1; i < branch.length; i++) expect(branch[i].jd).toBeGreaterThanOrEqual(branch[i - 1].jd!)
}

function expectMaxAngularStep(branch: SolarEclipseGeoBranch, maxStep: number) {
	for (let i = 1; i < branch.length; i++) expect(sphericalSeparation(branch[i - 1].x, branch[i - 1].y, branch[i].x, branch[i].y)).toBeLessThanOrEqual(maxStep)
}

// Residual of the shadow-axis tangency condition x^2 + (omega*y)^2 = 1 that defines the central
// line endpoints on the flattened Earth limb. Near zero means the axis grazes the ellipsoid.
function axisLimbResidual(elements: PolynomialBesselianElements, jd: number) {
	const be = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const cosD = Math.cos(be.d)
	const omega = 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
	return be.x * be.x + (omega * be.y) ** 2 - 1
}

// Signed distance from the shadow axis (be.x, be.y) to the flattened Earth-limb ellipse at an instant:
// negative inside the limb, positive outside. Built from the exported earthLimbExtremes so the test
// validates the same circle-ellipse geometry the engine uses.
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

function expectTimeNearSeconds(actualJd: number, expectedJd: number, toleranceSeconds: number) {
	expect(Math.abs((actualJd - expectedJd) * 86400)).toBeLessThanOrEqual(toleranceSeconds)
}

function expectGeoNear(actual: SolarEclipseGeoPoint | undefined, lat: Angle, lon: Angle, toleranceArcmin: number) {
	expect(actual).toBeDefined()
	expectGeoPoint(actual!)
	expect(sphericalSeparation(actual!.x, actual!.y, lon, lat)).toBeLessThanOrEqual(deg(toleranceArcmin / 60))
}

const CENTRAL_FIXTURES = NASA_ECLIPSES.filter((fixture) => fixture.central)

// Asserts a geographic point is within toleranceArcmin arcminutes of a NASA reference coordinate.
function expectNearNasa(point: SolarEclipseGeoPoint | undefined, latitudeDeg: number, longitudeDeg: number, toleranceArcmin: number) {
	expect(point).toBeDefined()
	expectGeoPoint(point!)
	expect(sphericalSeparation(point!.x, point!.y, deg(longitudeDeg), deg(latitudeDeg))).toBeLessThan(deg(toleranceArcmin / 60))
}

test('geographic angular helpers handle antimeridian and great-circle interpolation', () => {
	const a: SolarEclipseGeoPoint = { x: deg(179.5), y: 0 }
	const b: SolarEclipseGeoPoint = { x: deg(-179.5), y: 0 }
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
	const generated = computePolynomialBesselianElements(TIME0, (time) => {
		const t = (toJulianDay(time) - JD0) / 0.125

		return {
			sun: {
				rightAscension: deg(359 + 2 * t),
				declination: deg(0.1 * t),
				distance: 23455,
			},
			moon: {
				rightAscension: deg(359.2 + 2.01 * t),
				declination: deg(0.1 * t + 0.001),
				distance: 60,
			},
			deltaT: 70,
		}
	})
	const be = evaluateBesselian(generated, time(JD0 + generated.step))

	expect(generated.x).toHaveLength(4)
	expect(generated.mu).toHaveLength(4)
	// The generator fits five samples over a 6 h window, so the polynomial time unit is one hour.
	expect(generated.step).toBe(1 / 24)
	expect(be.mu).toBeGreaterThanOrEqual(0)
	expect(be.mu).toBeLessThan(TAU)
	expect(be.deltaT).toBeCloseTo(70, 12)
	// Cone tangents and radii follow from the physical Sun-Moon distances; checked to ~1e-6, not frozen
	// to machine precision, so legitimate refinements do not break the test.
	expect(be.l1).toBeCloseTo(0.552934, 5)
	expect(be.l2).toBeCloseTo(0.006762, 5)
	expect(generated.tanF1).toBeCloseTo(0.0046741, 6)
	expect(generated.tanF2).toBeCloseTo(0.0046508, 6)
})

test('computePolynomialBesselianElements derives cone tangents from physical Sun-Moon distance', () => {
	const generated = computePolynomialBesselianElements(TIME0, () => ({ sun: { rightAscension: deg(15), declination: deg(7), distance: 23484 }, moon: { rightAscension: deg(15.2), declination: deg(7.01), distance: 56.28 }, deltaT: 69 }))

	expect(generated.tanF1).toBeCloseTo(0.004667549733963093, 12)
	expect(generated.tanF2).toBeCloseTo(0.004644295797763593, 12)
	expect(generated.tanF2).toBeGreaterThan(0)
})

test('computePolynomialBesselianElements projects the shadow axis onto the fundamental plane', () => {
	const position: SunMoonPosition = { sun: { rightAscension: deg(40), declination: deg(65), distance: 23000 }, moon: { rightAscension: deg(42), declination: deg(64.5), distance: 60 }, deltaT: 70 }
	const generated = computePolynomialBesselianElements(TIME0, () => position)
	const be = evaluateBesselian(generated, TIME0)
	const tangentPlaneX = position.moon.distance * Math.cos(position.sun.declination) * (position.moon.rightAscension - position.sun.rightAscension)
	const tangentPlaneY = position.moon.distance * (position.moon.declination - position.sun.declination)

	// The fundamental-plane projection (x, y, d) is independent of Earth rotation, so it is unchanged by
	// the GMST -> GAST switch; mu now comes from apparent sidereal time.
	expect(be.x).toBeCloseTo(0.903877748055732, 12)
	expect(be.y).toBeCloseTo(-0.5105868561921576, 12)
	expect(be.d).toBeCloseTo(1.1344862148808663, 12)
	expect(be.mu).toBeCloseTo(1.1778503275514438, 9)
	expect(Math.abs(be.x - tangentPlaneX)).toBeGreaterThan(0.01)
	expect(Math.abs(be.y - tangentPlaneY)).toBeGreaterThan(0.01)
})

test('computePolynomialBesselianElements follows the projection convention toward the day side', () => {
	const generated = computePolynomialBesselianElements(TIME0, () => ({ sun: { rightAscension: 0, declination: 0, distance: 23000 }, moon: { rightAscension: 0, declination: 0, distance: 60 }, deltaT: 70 }))
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

describe('findMaximumPoint matches NASA Besselian fixture at greatest eclipse instant', () => {
	for (const fixture of NASA_ECLIPSES) {
		test(fixture.name, () => {
			const point = findMaximumPoint(nasaPbe(fixture))
			// Compared with a tolerance instead of an exact DMS string. For central
			// eclipses Max is the strict axis projection; for partial/non-central ones it is the limb point
			// nearest the axis, matching NASA's greatest-eclipse coordinate to a couple of arcminutes.
			expectGeoNear(point, parseAngle(fixture.greatestEclipse[1])!, parseAngle(fixture.greatestEclipse[0])!, 2)
			expect(point!.jd).toBe(fixture.greatestEclipse[2])
		})
	}
})

describe('NASA Besselian fixtures preserve polynomial values and units', () => {
	for (const fixture of NASA_ECLIPSES) {
		test(fixture.name, () => {
			const elements = nasaPbe(fixture)
			const origin = evaluateBesselian(elements, elements.time0)
			const maximum = evaluateBesselian(elements, elements.maximumTime)
			const t = timeSubtract(elements.maximumTime, elements.time0) / elements.step

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
		})
	}
})

describe('NASA Besselian fixtures cover eclipse classes and central gating', () => {
	for (const fixture of NASA_ECLIPSES) {
		test(fixture.name, () => {
			const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45), includeRiseSetCurves: false })

			expect(geometry.points.Max).toBeDefined()
			expectGeoPoint(geometry.points.Max!)
			for (const point of geometry.lines.penumbraNorth.flat()) expectGeoPoint(point)
			for (const point of geometry.lines.penumbraSouth.flat()) expectGeoPoint(point)

			const { U1, U2, U3, U4, C1, C2 } = geometry.points

			if (fixture.type === 'partial') {
				// The umbra never reaches Earth, so neither the umbral contacts nor the central line exist.
				for (const point of [U1, U2, U3, U4, C1, C2]) expect(point).toBeUndefined()
				expect(geometry.lines.centerLine).toHaveLength(0)
				expect(geometry.lines.umbraNorth).toHaveLength(0)
				expect(geometry.lines.umbraSouth).toHaveLength(0)
				return
			}

			if (fixture.central) {
				// The shadow axis pierces the ellipsoid: all four umbral contacts and both central-line endpoints exist.
				expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(true)
				for (const point of [U1, U2, U3, U4, C1, C2]) expectGeoPoint(point!)
				expect(geometry.lines.centerLine.length).toBeGreaterThan(0)
				return
			}

			// A non-central total/annular eclipse: the umbra only grazes the limb, so the informational
			// external contacts U1/U4 exist while the internal contacts U2/U3 do not. The axis misses the
			// ellipsoid, so there is no central line and no C1/C2 endpoints; umbra limits, however, are no
			// longer forced empty.
			expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(false)
			expectGeoPoint(U1!)
			expectGeoPoint(U4!)
			for (const point of [U2, U3, C1, C2]) expect(point).toBeUndefined()
			expect(geometry.lines.centerLine).toHaveLength(0)
		})
	}
})

test('computeSolarEclipseMapGeometry produces ordered partial contacts and anchored rise-set curves', () => {
	// A genuine partial: the y offset 1.2 keeps the shadow axis closest approach outside the limb (the axis
	// misses the Earth, so no central line or umbral cone), while the penumbra still grazes the surface. Only
	// the external penumbral contacts P1/P4 exist; the internal P2/P3 require the penumbra to sweep fully onto
	// Earth, which only happens when the axis pierces it. The synthetic axis (0.125-day step) takes longer than
	// 3 h to clear the limb, so the search window is widened explicitly rather than relying on the default.
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial'), pbe({ y: [1.2] }), { longitudeStep: deg(90), includeRiseSetCurves: true, riseSetStep: 1800 })
	const { points, lines } = geometry

	// Existence, finiteness and chronological order replace the frozen synthetic coordinates.
	for (const point of [points.P1, points.P4, points.Max]) expectGeoPoint(point!)
	expectIncreasingJd([points.P1!, points.Max!, points.P4!])
	// A pure partial eclipse: no internal penumbral contacts, no umbral cone contacts and no central line.
	for (const point of [points.P2, points.P3, points.U1, points.U2, points.U3, points.U4, points.C1, points.C2]) expect(point).toBeUndefined()
	expect(lines.centerLine).toHaveLength(0)
	expect(lines.umbraNorth).toHaveLength(0)
	expect(lines.umbraSouth).toHaveLength(0)
	for (const point of [...lines.penumbraNorth.flat(), ...lines.penumbraSouth.flat()]) expectGeoPoint(point)

	// The day-side and night-side terminator arcs, each anchored at the external cusp contacts P1 (begin) and
	// P4 (end). A two-contact partial has no internal contacts to split the rise-set family further.
	expect(lines.riseSetCurves).toHaveLength(2)
	for (const curve of lines.riseSetCurves) {
		expectGeoPointClose(curve[0], points.P1!.x, points.P1!.y, points.P1!.jd)
		expectGeoPointClose(curve.at(-1), points.P4!.x, points.P4!.y, points.P4!.jd)
		expect(curve.length).toBeGreaterThan(1)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('contact and central endpoint searches are centered on maximumTime', () => {
	// The shadow axis sweeps across the limb around a maximum offset from the polynomial origin t0, so
	// the searches must bracket maximumTime, not t0. The exact instants are not frozen; the
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
	// invariant; exact coordinates are intentionally not frozen.
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
	const penumbraNorth = lines.penumbraNorth.flat()
	const penumbraSouth = lines.penumbraSouth.flat()

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
	// produced: the geometric test on the Besselian elements drives the gating, not gamma.
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
		// not, because the axis never intersects the ellipsoid.
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

test('projectFundamentalPoint is strict outside the limb and projectClosestEarthLimbPoint clamps explicitly', () => {
	const be = evaluateBesselian(pbe({ d: [deg(12)], mu: [deg(35)] }), TIME0)
	const omega = earthLimbOmega(be.d)

	// A point inside the limb projects to a finite geographic coordinate.
	const inside = projectFundamentalPoint(be, 0.2, -0.1)
	expect(inside).toBeDefined()
	expectGeoPoint(inside!)
	expect(inside!.jd).toBe(JD0)

	// A point well outside the limb is rejected: no hidden clamp.
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
	// generic spherical utility.
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

test('projectFundamentalPoint rejects points outside the limb ellipse (no clamp)', () => {
	const be = evaluateBesselian(pbe({ d: [deg(20)], mu: [deg(50)] }), TIME0)
	const w = earthLimbOmega(be.d)
	// A point strictly outside the ellipse is rejected.
	expect(0.9 * 0.9 + (w * 0.9) ** 2).toBeGreaterThan(1)
	expect(projectFundamentalPoint(be, 0.9, 0.9)).toBeUndefined()
	// Its closest limb projection exists and is finite.
	expectGeoPoint(projectClosestEarthLimbPoint(be, 0.9, 0.9)!)
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

test('splitDisconnectedPolylines breaks a curve at gaps and drops undrawable pieces', () => {
	const points: SolarEclipseGeoBranch = [
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
	// Axis misses the Earth (y offset 1.2): a genuine partial whose geometry, not just the Meeus type tag,
	// has no central or umbral path. A central-geometry fixture would now (correctly) draw both.
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial', 1.1), pbe({ y: [1.2] }), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: false })

	expect(geometry.points.Max).toBeDefined()
	for (const point of [geometry.points.U1, geometry.points.U2, geometry.points.U3, geometry.points.U4, geometry.points.C1, geometry.points.C2]) expect(point).toBeUndefined()
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth).toHaveLength(0)
	expect(geometry.lines.umbraSouth).toHaveLength(0)
})

test('central total eclipse geometry exposes a populated central and umbral path when enabled', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('total'), pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: true, riseSetStep: 1800 })

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
	for (const point of geometry.lines.penumbraNorth.flat()) expectGeoPoint(point)
	for (const point of geometry.lines.penumbraSouth.flat()) expectGeoPoint(point)
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
	// A true fold-back: longitude rises to the apex then reverses, so the limit doubles back near the pole.
	const split = splitAtMaxAbsLatitude([
		{ x: 0, y: deg(10) },
		{ x: deg(1), y: deg(80) },
		{ x: 0, y: deg(20) },
	])

	expect(split).toHaveLength(2)
	// The fold apex is shared between both branches so they meet without a gap.
	expect(split[0].map((point) => point.y)).toEqual([deg(10), deg(80)])
	expect(split[1].map((point) => point.y)).toEqual([deg(80), deg(20)])
})

test('splitAtMaxAbsLatitude keeps a latitude peak with monotonic longitude whole', () => {
	// Longitude is monotonic across the apex, so the arc merely peaks in latitude without folding back: it
	// is one continuous limit and must not be split into two apex-sharing branches (which would look like a
	// bridgeable gap), as for the 8291-08-05 umbra-north and 6026-10-07 umbra-south limits.
	const split = splitAtMaxAbsLatitude([
		{ x: 0, y: deg(10) },
		{ x: deg(1), y: deg(80) },
		{ x: deg(2), y: deg(20) },
	])

	expect(split).toHaveLength(1)
	expect(split[0]).toHaveLength(3)
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

describe('map geometry exposes the NASA greatest-eclipse point for every eclipse class', () => {
	for (const fixture of NASA_ECLIPSES) {
		test(fixture.name, () => {
			const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(90), maxAngularStep: deg(45) })

			expectGeoNear(geometry.points.Max, parseAngle(fixture.greatestEclipse[1])!, parseAngle(fixture.greatestEclipse[0])!, 2)
			expect(geometry.points.Max!.jd).toBe(fixture.greatestEclipse[2])
		})
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

	// Umbra limit branches never bridge a discontinuity: edges within a branch stay below the drawable-gap
	// threshold. Branches follow solver continuity, not a global time order, so jd monotonicity is not asserted.
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth]) {
		expect(segment.length).toBeGreaterThan(1)
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

	expectGeoNear(points.Max, parseAngle(fixture.greatestEclipse[1])!, parseAngle(fixture.greatestEclipse[0])!, 2)
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
		expect(Math.abs((north!.jd - APR8_2024_DELTA_T_DAYS - expectedUt) * 86400)).toBeLessThan(60)
		expect(Math.abs((south!.jd - APR8_2024_DELTA_T_DAYS - expectedUt) * 86400)).toBeLessThan(60)
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

	expect(geometry.lines.penumbraNorth.flat().length).toBeGreaterThan(5)
	expect(geometry.lines.penumbraSouth.flat().length).toBeGreaterThan(5)
	for (const point of geometry.lines.penumbraNorth.flat()) expectGeoPoint(point)
	for (const point of geometry.lines.penumbraSouth.flat()) expectGeoPoint(point)
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
	step: 1 / 24,
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

	for (const feature of [paths.centerLine, paths.umbraNorth, paths.umbraSouth]) {
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
			for (const point of penumbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
			for (const point of penumbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)

			// Sun altitude: every drawn curve point lies on the sunlit side, with the Sun above the horizon
			// (a small negative tolerance absorbs refraction at the contacts, where the Sun grazes the horizon).
			for (const point of [...umbraNorth.flat(), ...umbraSouth.flat(), ...penumbraNorth.flat(), ...penumbraSouth.flat(), ...centerLine]) {
				expect(solarAltitudeAtPoint(elements, point)).toBeGreaterThan(deg(-1))
			}

			// Smoothness: each physical limit branch bends without sharp kinks.
			for (const piece of [...umbraNorth, ...umbraSouth, ...penumbraNorth, ...penumbraSouth]) expect(countKinks(piece, deg(30))).toBe(0)
		})
	}
})

// Validation cases computed from the VSOP87E/ELPMPP02 ephemerides, covering the three reference
// eclipses of the refactor checklist: a near-grazing annular (2003-05-31), a circumpolar total over
// Antarctica (2003-11-23) and a hybrid (2023-04-20).
describe('solar eclipse map validation cases', () => {
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
			const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
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
				for (const point of lines.penumbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
				for (const point of lines.penumbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
			})

			test('polylines contain only finite coordinates and never bridge a discontinuity', () => {
				const families = [lines.centerLine, ...lines.umbraNorth, ...lines.umbraSouth, ...lines.penumbraNorth, ...lines.penumbraSouth, ...lines.riseSetCurves]
				for (const family of families) for (const point of family) expectGeoPoint(point)
				// Every drawable branch (umbra and penumbra) is split at discontinuities, so no intra-branch
				// edge exceeds the drawable-gap threshold: a branch never chords across a gap. Branches are
				// ordered by solver continuity, not globally by time, so chronological order is not asserted.
				for (const piece of [...lines.umbraNorth, ...lines.umbraSouth, ...lines.penumbraNorth, ...lines.penumbraSouth]) {
					expect(piece.length).toBeGreaterThan(1)
					expectMaxAngularStep(piece, MAX_STEP * 4)
				}
			})

			test('rise/set curves sit near the solar horizon and progress in time', () => {
				expect(lines.riseSetCurves.length).toBeGreaterThan(0)
				for (const curve of lines.riseSetCurves) {
					expect(curve.length).toBeGreaterThan(1)
					expectNonDecreasingJd(curve)
					for (const point of curve) expect(Math.abs(solarAltitudeAtPoint(elements, point))).toBeLessThan(deg(2))
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
		})
	}
})

// Branch-aware topology: penumbra and umbra limits are GeoBranch[] continuity branches. Points inside a
// branch may connect; separate branches never do. These cases (computed from the VSOP87E/ELPMPP02
// ephemerides) cover the eclipses that previously produced topology defects: the 2005-04-08 jd-order spike,
// the 2024-04-08 north-pole spike from global endpoint chaining, and assorted normal eclipses that must stay
// stable.
describe('branch-aware curve topology', () => {
	const STEP = 0.5 * DEG2RAD
	const MAP_WIDTH = 2400
	const MAP_HEIGHT = 1200
	const projection = new PlateCarree(0, { scale: MAP_WIDTH / TAU, falseEasting: MAP_WIDTH / 2, falseNorthing: MAP_HEIGHT / 2, yAxisDirection: 'southUp', centralMeridian: 0, longitudeWrapMode: 'pi', maxLatitude: PIOVERTWO })

	const CASES = [
		{ name: '2005-04-08', date: [2005, 4, 1] },
		{ name: '2005-10-03', date: [2005, 10, 1] },
		{ name: '2006-09-22', date: [2006, 9, 1] },
		{ name: '2024-04-08', date: [2024, 4, 1] },
		{ name: '2000-07-01', date: [2000, 7, 1] },
		{ name: '2001-12-14', date: [2001, 12, 1] },
		{ name: '2003-05-31', date: [2003, 5, 15] },
		{ name: '2003-11-23', date: [2003, 11, 1] },
		{ name: '2008-02-07', date: [2008, 2, 1] },
		{ name: '2009-01-26', date: [2009, 1, 1] },
		{ name: '2021-12-04', date: [2021, 12, 1] },
	] as const

	test('2005-10-03 keeps the lower northern penumbral arc between N1 and N2', () => {
		const { elements, geometry } = geometryFor(2005, 10, 1)
		const expected = findEclipseCurvePoint(elements, deg(55), 0, 1, 0)

		expect(expected).toBeDefined()
		expect(expected!.y).toBeLessThan(deg(70))

		let nearest = Infinity
		let branchWithLowerArc: SolarEclipseGeoBranch | undefined

		for (const branch of geometry.lines.penumbraNorth) {
			for (const point of branch) {
				const distance = sphericalSeparation(expected!.x, expected!.y, point.x, point.y)
				if (distance < nearest) {
					nearest = distance
					branchWithLowerArc = branch
				}
			}
		}

		expect(nearest).toBeLessThan(STEP)
		expect(branchWithLowerArc).toContain(geometry.points.N1)
	}, 3000)

	test('2005-10-03 rise/set curve passes through N1 without a visible cusp gap', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2005, 10, 1), true)
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: STEP, maxAngularStep: STEP, includeRiseSetCurves: true, riseSetStep: 600 })
		const N1 = geometry.points.N1!

		let nearest = Infinity
		for (const point of geometry.lines.riseSetCurves.flat()) {
			nearest = Math.min(nearest, sphericalSeparation(N1.x, N1.y, point.x, point.y))
		}

		expect(nearest).toBeLessThan(1e-9)
	}, 3000)

	test('2006-09-22 southern penumbral limit joins its cusp fragments', () => {
		const { geometry } = geometryFor(2006, 9, 1)
		expect(geometry.lines.penumbraSouth).toHaveLength(1)
	}, 3000)

	test('2082-08-24 keeps the southern penumbral fold connected through S2', () => {
		const { geometry } = geometryFor(2082, 8, 1)
		const S2 = geometry.points.S2!

		expect(geometry.lines.penumbraSouth).toHaveLength(1)
		expect(Math.min(sphericalSeparation(S2.x, S2.y, geometry.lines.penumbraSouth[0][0].x, geometry.lines.penumbraSouth[0][0].y), sphericalSeparation(S2.x, S2.y, geometry.lines.penumbraSouth[0].at(-1)!.x, geometry.lines.penumbraSouth[0].at(-1)!.y))).toBeLessThan(1e-9)
		expect(maxBranchSegment(geometry.lines.penumbraSouth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)

		const paths = solarEclipseMapToSvgPaths(geometry, projection)
		expect(longestProjectedSegment(paths.penumbraSouth)).toBeLessThan(MAP_WIDTH / 2)
	}, 3000)

	test('2026-02-17 trims the southern umbra endpoint fold', () => {
		const { geometry } = geometryFor(2026, 2, 1)

		expect(geometry.lines.umbraSouth).toHaveLength(1)
		expect(endpointRetraces(geometry.lines.umbraSouth[0], false)).toBe(false)
		expect(maxBranchSegment(geometry.lines.umbraSouth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
	}, 3000)

	test('2026-08-12 keeps the north-polar partial boundary anchored', () => {
		const { eclipse, elements } = geometryFor(2026, 8, 1)
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: STEP, maxAngularStep: STEP, includeRiseSetCurves: true, riseSetStep: 600 })
		const { N1, S1 } = geometry.points

		// Each umbral limit sweeps near the pole but stays monotonic in longitude, so it is one continuous
		// arc, not a fold split at its latitude apex.
		expect(geometry.lines.umbraNorth.filter((branch) => branch.length >= 2)).toHaveLength(1)
		expect(geometry.lines.umbraSouth.filter((branch) => branch.length >= 2)).toHaveLength(1)
		expect(geometry.lines.penumbraNorth).toHaveLength(0)
		expect(geometry.lines.penumbraSouth).toHaveLength(1)
		expect(N1).toBeDefined()
		expect(S1).toBeDefined()
		expect(Math.min(sphericalSeparation(N1!.x, N1!.y, geometry.lines.penumbraSouth[0][0].x, geometry.lines.penumbraSouth[0][0].y), sphericalSeparation(N1!.x, N1!.y, geometry.lines.penumbraSouth[0].at(-1)!.x, geometry.lines.penumbraSouth[0].at(-1)!.y))).toBeLessThan(1e-9)
		expect(Math.min(sphericalSeparation(S1!.x, S1!.y, geometry.lines.penumbraSouth[0][0].x, geometry.lines.penumbraSouth[0][0].y), sphericalSeparation(S1!.x, S1!.y, geometry.lines.penumbraSouth[0].at(-1)!.x, geometry.lines.penumbraSouth[0].at(-1)!.y))).toBeLessThan(1e-9)

		for (const cusp of [N1!, S1!]) {
			let nearest = Infinity
			for (const point of geometry.lines.riseSetCurves.flat()) nearest = Math.min(nearest, sphericalSeparation(cusp.x, cusp.y, point.x, point.y))
			expect(nearest).toBeLessThan(1e-9)
		}

		const paths = solarEclipseMapToSvgPaths(geometry, projection)
		expect(longestProjectedSegment(paths.riseSetCurves)).toBeLessThan(MAP_WIDTH / 2)
	}, 6000)

	test('2021-12-04 keeps the south-polar umbra connected at U3', () => {
		const { geometry } = geometryFor(2021, 12, 1)
		const U3 = geometry.points.U3!

		// The south-polar umbra limit is monotonic in longitude across its latitude apex, so it stays a
		// single connected arc (no fold-back to split), with the U3 contact lying on it.
		expect(geometry.lines.umbraSouth).toHaveLength(1)
		expect(Math.min(...geometry.lines.umbraSouth.flat().map((point) => sphericalSeparation(U3.x, U3.y, point.x, point.y)))).toBeLessThan(1e-9)
	}, 3000)

	// 1957-10-23 is a non-central total eclipse (|gamma| > 1): the shadow axis misses Earth, so the umbra
	// only grazes the limb and the G = 1 limit is a tiny closed loop near the south pole. The curve tracer
	// used to append a stray closure vertex duplicating an interior point, leaving a ~4 deg chord from U1
	// back into the loop (a visible spike). Every umbra edge must now stay near the sample spacing, well
	// below the fold threshold that the spurious chord exceeded.
	test('1957-10-23 grazing umbra loop has no fold-back spike', () => {
		const { geometry } = geometryFor(1957, 10, 20)
		const branches = [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth]

		expect(branches.length).toBeGreaterThan(0)
		// The fold threshold (maxAngularStep * CURVE_GAP_SPLIT_FACTOR = 0.5 deg * 4); the historical spike was ~4 deg.
		const foldThreshold = STEP * 4
		for (const branch of branches) {
			for (let k = 1; k < branch.length; k++) expect(sphericalSeparation(branch[k - 1].x, branch[k - 1].y, branch[k].x, branch[k].y)).toBeLessThan(foldThreshold)
		}
	}, 2500)

	// 1977-04-08 (S1) and 1994-05-10 (N2) are oblique partial limits whose penumbral terminator cusp is the
	// upper limb crossing while the traced rise/set branch follows the lower crossing ~2-3 deg away. Forcing
	// the cusp onto that branch used to splice a spurious triangular spike (a ~3 deg detour edge) up to the
	// cusp. The cusp insertion must now be rejected when it is off the curve, so every rise/set edge stays
	// near the 1 deg sample spacing and never spikes to the cusp.
	for (const [name, year, month, day] of [
		['1977-04-08', 1977, 4, 8],
		['1994-05-10', 1994, 5, 10],
	] as const) {
		test(`${name} rise/set curve has no off-curve cusp spike`, () => {
			const eclipse = nearestSolarEclipse(timeYMD(year, month, day), true)
			const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
			const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: STEP, maxAngularStep: STEP, includeRiseSetCurves: true, riseSetStep: 600 })

			expect(geometry.lines.riseSetCurves.length).toBeGreaterThan(0)
			// The historical spikes were ~2-3 deg; a correctly sampled rise/set edge stays near the 1 deg step.
			for (const branch of geometry.lines.riseSetCurves) {
				for (let k = 1; k < branch.length; k++) expect(sphericalSeparation(branch[k - 1].x, branch[k - 1].y, branch[k].x, branch[k].y)).toBeLessThan(deg(1.5))
			}
		}, 4000)
	}

	test('2024-04-08 connects N2 to the northern penumbral limit', () => {
		const { geometry } = geometryFor(2024, 4, 1)
		const N2 = geometry.points.N2!
		const branch = geometry.lines.penumbraNorth.find((piece) => piece.some((point) => sphericalSeparation(N2.x, N2.y, point.x, point.y) < 1e-9))

		expect(branch).toBeDefined()
		expect(branch!.length).toBeGreaterThan(100)
		expect(Math.min(sphericalSeparation(N2.x, N2.y, branch![0].x, branch![0].y), sphericalSeparation(N2.x, N2.y, branch!.at(-1)!.x, branch!.at(-1)!.y))).toBeLessThan(1e-9)
	}, 3000)

	for (const fixture of CASES) {
		describe(fixture.name, () => {
			const { elements, geometry } = geometryFor(fixture.date[0], fixture.date[1], fixture.date[2])
			const { penumbraNorth, penumbraSouth, umbraNorth, umbraSouth } = geometry.lines

			// Invariant 1: no consecutive segment inside any drawable branch exceeds the drawable gap. This is
			// the spike test at the geometry level: the 2005-04-08 and 2024-04-08 spikes were single segments
			// of ~16 deg, which this rejects.
			test('drawable branches contain no large angular segment', () => {
				expect(maxBranchSegment(penumbraNorth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
				expect(maxBranchSegment(penumbraSouth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
				expect(maxBranchSegment(umbraNorth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
				expect(maxBranchSegment(umbraSouth)).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
			})

			// Invariant 4/5: each branch serializes as its own M-subpath and the antimeridian split keeps
			// wraps as separate subpaths, so no projected segment connects the end of one branch to the start
			// of another (a spike) nor draws a giant horizontal line across the seam.
			test('no projected SVG path connects separate branches', () => {
				const paths = solarEclipseMapToSvgPaths(geometry, projection)
				for (const path of [paths.penumbraNorth, paths.penumbraSouth, paths.umbraNorth, paths.umbraSouth]) {
					expect(longestProjectedSegment(path)).toBeLessThan(MAP_WIDTH / 2)
				}
			})

			// Invariant 7/8: every sampled branch point still satisfies its magnitude residual (G = 0 for
			// penumbra, G = 1 for umbra), proving branch preservation did not move points off their loci.
			test('branch points satisfy their magnitude residual', () => {
				for (const point of penumbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
				for (const point of penumbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
				for (const point of umbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 1)).toBeLessThan(1e-3)
				for (const point of umbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 1)).toBeLessThan(1e-3)
			})

			// Invariant 9: N1/N2/S1/S2 stay chronological even though the drawable branches are ordered by
			// solver continuity, not globally by time.
			test('named penumbral extremes remain chronological', () => {
				const { N1, N2, S1, S2 } = geometry.points
				if (N1?.jd !== undefined && N2?.jd !== undefined) expect(N1.jd).toBeLessThanOrEqual(N2.jd)
				if (S1?.jd !== undefined && S2?.jd !== undefined) expect(S1.jd).toBeLessThanOrEqual(S2.jd)
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
				const families = [lines.centerLine, ...lines.umbraNorth, ...lines.umbraSouth, ...lines.penumbraNorth, ...lines.penumbraSouth, ...lines.riseSetCurves]
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
				expect(solarAltitudeAtPoint(elements, points.Max!)).toBeGreaterThan(deg(-1))
				let nearest = Number.POSITIVE_INFINITY
				for (const point of lines.centerLine) nearest = Math.min(nearest, sphericalSeparation(points.Max!.x, points.Max!.y, point.x, point.y))
				expect(nearest).toBeLessThan(deg(2))
			})

			// Rise/set curves are horizon-contact curves, so the Sun is near the horizon along them.
			test('rise/set curves sit near the solar horizon', () => {
				for (const curve of lines.riseSetCurves) for (const point of curve) expect(Math.abs(solarAltitudeAtPoint(elements, point))).toBeLessThan(deg(2))
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

		// The penumbral limit is produced (at least one of the two tangent branches) on the magnitude-0 locus.
		const penumbra = [...geometry.lines.penumbraNorth.flat(), ...geometry.lines.penumbraSouth.flat()]
		expect(penumbra.length).toBeGreaterThan(0)
		for (const point of geometry.lines.penumbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
		for (const point of geometry.lines.penumbraSouth.flat()) expect(limitTangencyResidual(elements, point, -1, 0)).toBeLessThan(1e-3)
		for (const point of penumbra) expect(solarAltitudeAtPoint(elements, point)).toBeGreaterThan(deg(-1))
	}, 2000)

	// A pure partial eclipse draws the penumbral limit (magnitude 0), and that limit spans the
	// published northern/southern penumbral extremes N1/S1. Verified against the 2000-02-05 partial over
	// the southern hemisphere (EclipseWise: N1 ~ 50.23 deg S, 95.645 deg W; S1 ~ 28.305 deg S, 66.562 deg E).
	test('2000-02-05 partial eclipse penumbral limit matches the published N1/S1 extremes', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2000, 2, 1), true)
		expect(eclipse.type).toBe('partial')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
		const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: deg(1), maxAngularStep: deg(3) })
		const limit = geometry.lines.penumbraNorth.flat()
		expect(limit.length).toBeGreaterThan(0)

		// Every point is on the magnitude-0 locus with the Sun above the horizon.
		for (const point of limit) {
			expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-3)
			expect(solarAltitudeAtPoint(elements, point)).toBeGreaterThan(deg(-1))
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
	}, 2000)

	// Same convention checked on a northern-hemisphere grazing partial: 2000-07-31 (EclipseWise N1 ~ 49.49 deg N,
	// 55.6 deg E, the earlier cusp; S1 ~ 32.19 deg N, 129.74 deg W, the later cusp). Here the earlier cusp
	// also happens to be poleward, but the label is chronological.
	test('2000-07-31 partial eclipse names its single-limit cusps chronologically (N1 first, S1 last)', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2000, 7, 15), true)
		expect(eclipse.type).toBe('partial')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
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
	}, 2000)

	// Regression for 2003-05-31 (annular grazing): BOTH terminator cusps are in the northern hemisphere
	// (N1 ~ 10.86 deg N, 52.00 deg E; S1 ~ 37.09 deg N, 164.07 deg W), so a poleward/equatorward label
	// would swap them. EclipseWise names them chronologically, and N1 (the earlier cusp) is the more
	// equatorward one here.
	test('2003-05-31 grazing eclipse names same-hemisphere cusps chronologically, not by latitude', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2003, 5, 15), true)
		expect(eclipse.type).toBe('annular')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
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
	}, 2000)

	// An annular (both-limit) eclipse names the penumbral extremes chronologically -- N1/S1 where
	// each limit begins, N2/S2 where it ends -- not by latitude. Regression for the 2001-12-14 annular, where
	// the latitude ordering swapped N1<->N2 and S1<->S2. EclipseWise: N1 ~ 66.19 deg N, 139.72 deg W;
	// N2 ~ 57.93 deg N, 95.30 deg W; S1 ~ 0.60 deg N, 160.89 deg E; S2 ~ 15.54 deg S, 62.29 deg W.
	test('2001-12-14 annular eclipse labels penumbral extremes chronologically (N1/N2, S1/S2)', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2001, 12, 1), true)
		expect(eclipse.type).toBe('annular')
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
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
	}, 3000)
})

describe('reference data and conventions', () => {
	for (const fixture of NASA_ECLIPSES) {
		test('central-axis geometry classifies every NASA fixture central/non-central:' + fixture.name, () => {
			// The fixture's hand-set `central` flag must agree with the geometric axis-intersection test that now gates the central line.
			expect(centralAxisIntersectsEarth(nasaPbe(fixture))).toBe(fixture.central)
		})

		test('TD/UT/Delta T convention: longitude correction is explicit and Delta T is applied once:' + fixture.name, () => {
			const elements = nasaPbe(fixture)
			// NASA mu is in dynamical time, so the geographic projection carries an explicit Delta T
			// longitude correction of DELTA_T_LONGITUDE_FACTOR * deltaT.
			expect(elements.deltaTLongitudeCorrection).toBeCloseTo(DELTA_T_LONGITUDE_FACTOR * fixture.deltaT, 12)
			// The correction equals 0.00417807 deg per second of Delta T.
			expect(elements.deltaTLongitudeCorrection).toBeCloseTo(deg(0.00417807) * fixture.deltaT, 12)
		})

		test('polynomial origin t0 falls on the day of greatest eclipse:' + fixture.name, () => {
			expect(Math.abs(fixture.t0 - fixture.greatestEclipse[2])).toBeLessThan(0.5)
		})
	}

	// Internally generated elements use UT-based mu, so their correction is exactly 0: no double Delta T.
	const generated = computePolynomialBesselianElements(TIME0, () => ({ sun: { rightAscension: 0, declination: 0, distance: 23000 }, moon: { rightAscension: 0, declination: 0, distance: 60 }, deltaT: 70 }))
	expect(generated.deltaTLongitudeCorrection).toBe(0)
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
				// point to the shadow axis at distance l1.
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
		// The local umbral radius changes sign along a hybrid path, so both characters appear.
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

describe('greatest eclipse uses closest-approach minimization for an inconsistent maximumTime', () => {
	// When the supplied maximumTime is materially off the fitted closest shadow-axis approach, the
	// partial/non-central greatest-eclipse location is recomputed at the minimized instant rather than
	// trusting maximumTime. Synthetic axis x(t) = (t-1)^2 + 1 stays off the Earth at t0
	// (x = 2) and reaches its closest approach (x = 1, grazing the limb) at a fixed interior t = +1 step,
	// independent of the search-span width; maximumTime is deliberately pinned to t0.
	test('findMaximumPoint recomputes at the minimized instant', () => {
		const elements = pbe({ x: [2, -2, 1], y: [0], d: [0], maximumTime: time(JD0) })
		const max = findMaximumPoint(elements)

		expect(max).toBeDefined()
		expectGeoPoint(max!)
		// The returned instant is the closest approach at t0 + one step, not the inconsistent maximumTime.
		expect(Math.abs(max!.jd! - (JD0 + elements.step))).toBeLessThan(0.01)
	}, 2000)

	// A consistent maximumTime (the published greatest-eclipse epoch) is kept verbatim, so the jd is exact.
	describe('findMaximumPoint keeps a consistent published maximumTime', () => {
		for (const fixture of NASA_ECLIPSES) {
			test(fixture.name, () => {
				expect(findMaximumPoint(nasaPbe(fixture))!.jd).toBe(fixture.greatestEclipse[2])
			})
		}
	})
})

describe('refraction mode is an explicit solver option', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)

	test("'none' solves pure geometry and 'empirical' stays the default refracted behavior", () => {
		const geometric = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(2), maxAngularStep: deg(6), refractionMode: 'none' })
		const refracted = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(2), maxAngularStep: deg(6), refractionMode: 'empirical' })

		expect(geometric.lines.penumbraNorth.length).toBeGreaterThan(0)
		expect(refracted.lines.penumbraNorth.length).toBeGreaterThan(0)

		// In the geometric mode every penumbra-limit point is an unrefracted magnitude-0 solution.
		for (const point of geometric.lines.penumbraNorth.flat()) expect(limitTangencyResidual(elements, point, 1, 0)).toBeLessThan(1e-4)

		// Both modes name the same cusp family (N1); they agree to within a fraction of a degree because the
		// horizon lift is small, proving the option threads through without diverging the geometry.
		expect(geometric.points.N1).toBeDefined()
		expect(refracted.points.N1).toBeDefined()
		expect(sphericalSeparation(geometric.points.N1!.x, geometric.points.N1!.y, refracted.points.N1!.x, refracted.points.N1!.y)).toBeLessThan(deg(2))
	})

	test('the empirical default matches an explicit empirical request', () => {
		const def = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(4), maxAngularStep: deg(6) })
		const empirical = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { longitudeStep: deg(4), maxAngularStep: deg(6), refractionMode: 'empirical' })
		expect(JSON.stringify(def.lines.penumbraNorth)).toBe(JSON.stringify(empirical.lines.penumbraNorth))
	})
})

describe('splitCentralLineByKind segments a hybrid central line', () => {
	test('a hybrid central line yields both total and annular sub-polylines', () => {
		const fixture = NASA_ECLIPSES[3]
		expect(fixture.type).toBe('hybrid')
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(2), maxAngularStep: deg(4) })
		const { total, annular } = splitCentralLineByKind(geometry.lines.centerLine)

		expect(total.length).toBeGreaterThan(0)
		expect(annular.length).toBeGreaterThan(0)
		// Each sub-polyline is drawable and homogeneous in kind.
		for (const segment of total) {
			expect(segment.length).toBeGreaterThanOrEqual(2)
			for (const point of segment) expect(point.kind).toBe('total')
		}
		for (const segment of annular) {
			expect(segment.length).toBeGreaterThanOrEqual(2)
			for (const point of segment) expect(point.kind).toBe('annular')
		}
	}, 2000)

	test('a pure total central line has no annular sub-polyline', () => {
		const fixture = NASA_ECLIPSES[0]
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(4), maxAngularStep: deg(6) })
		const { total, annular } = splitCentralLineByKind(geometry.lines.centerLine)

		expect(annular).toHaveLength(0)
		expect(total.length).toBeGreaterThan(0)
	}, 2000)

	// With pbe, splitCentralLineByKind root-solves the exact total<->annular crossover and shares it, so the
	// total and annular segments touch instead of leaving a sampling-resolution gap.
	test('passing pbe closes the total/annular seam with a resolved transition point', () => {
		const fixture = NASA_ECLIPSES[3]
		const pbe = nasaPbe(fixture)
		const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), pbe, { longitudeStep: deg(2), maxAngularStep: deg(4) })

		function nearestCrossKindEndpointGap({ total, annular }: ReturnType<typeof splitCentralLineByKind>) {
			let best = Infinity
			for (const t of total) {
				for (const a of annular) {
					for (const tp of [t[0], t.at(-1)!]) {
						for (const ap of [a[0], a.at(-1)!]) {
							best = Math.min(best, sphericalSeparation(tp.x, tp.y, ap.x, ap.y))
						}
					}
				}
			}
			return best
		}

		const withoutPbe = splitCentralLineByKind(geometry.lines.centerLine)
		const withPbe = splitCentralLineByKind(geometry.lines.centerLine, pbe)

		// The shared seam makes a total and an annular segment meet within a hair, much closer than the
		// unresolved sampling gap.
		const seamGap = nearestCrossKindEndpointGap(withPbe)
		expect(seamGap).toBeLessThan(deg(0.01))
		expect(seamGap).toBeLessThan(nearestCrossKindEndpointGap(withoutPbe))
		// Each segment stays homogeneous in kind, seam copies included.
		for (const segment of withPbe.total) for (const point of segment) expect(point.kind).toBe('total')
		for (const segment of withPbe.annular) for (const point of segment) expect(point.kind).toBe('annular')
	}, 2000)
})

test('1862-11-21 trims the penumbral single-vertex branch switch near S1', () => {
	const { geometry } = geometryFor(1862, 11, 1)

	expect(geometry.lines.penumbraNorth.length).toBeGreaterThan(0)
	expect(geometry.points.S1).toBeDefined()

	for (const branch of geometry.lines.penumbraNorth) {
		expect(catalogBranchRetraces(branch, deg(0.5), deg(5))).toBe(false)
		expect(maxBranchSegment([branch])).toBeLessThanOrEqual(BRANCH_MAX_DRAWABLE_GAP)
	}
}, 2000)
