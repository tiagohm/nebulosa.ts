import { expect, test } from 'bun:test'
import { deg, formatAZ } from '../src/angle'
import type { SolarEclipse, SolarEclipseType } from '../src/sun'
// oxfmt-ignore
import { computePolynomialBesselianElements, computeRiseSetCurves, computeSolarEclipseMapGeometry, evaluateBesselian, findCurvePoints, findExtremeLimitOfCentralLine, findMaximumPoint, findPenumbraContactPoints, intermediateGreatCircle, projectFundamentalPoint, splitAtMaxAbsLatitude, splitPolygonAtAntimeridian, splitPolylineAtAntimeridian, type GeoPoint, type PolynomialBesselianElements, type SunMoonPosition } from '../src/sun.eclipse'
import { time, Timescale, timeSubtract, toJulianDay } from '../src/time'
import { PI, PIOVERTWO, TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'

const JD0 = 2460409.25
const TIME0 = time(JD0)

function pbe(overrides?: Partial<PolynomialBesselianElements>): PolynomialBesselianElements {
	return { time0: TIME0, maximumTime: TIME0, deltaT: 69, stepDays: 0.125, x: [0, 0.9], y: [0], l1: [0.4], l2: [-0.2], d: [0], mu: [0], tanF1: 0.0047, tanF2: -0.004, ...overrides }
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
	expect(Number.isFinite(point.longitude)).toBe(true)
	expect(Number.isFinite(point.latitude)).toBe(true)
	expect(point.longitude).toBeGreaterThanOrEqual(-PI)
	expect(point.longitude).toBeLessThanOrEqual(PI)
	expect(point.latitude).toBeGreaterThanOrEqual(-PIOVERTWO)
	expect(point.latitude).toBeLessThanOrEqual(PIOVERTWO)
}

function expectGeoPointClose(point: GeoPoint | undefined, longitude: number, latitude: number, jd?: number) {
	expect(point).toBeDefined()
	expectGeoPoint(point!)
	expect(point!.longitude).toBeCloseTo(longitude, 10)
	expect(point!.latitude).toBeCloseTo(latitude, 10)
	if (jd !== undefined) expect(Math.abs(point!.jd! - jd)).toBeLessThan(1e-8)
}

function expectIncreasingJd(points: readonly GeoPoint[]) {
	for (let i = 1; i < points.length; i++) expect(points[i].jd!).toBeGreaterThan(points[i - 1].jd!)
}

function expectMaxAngularStep(points: readonly GeoPoint[], maxStep: number) {
	for (let i = 1; i < points.length; i++) expect(sphericalSeparation(points[i - 1].longitude, points[i - 1].latitude, points[i].longitude, points[i].latitude)).toBeLessThanOrEqual(maxStep)
}

test('geographic angular helpers handle antimeridian and great-circle interpolation', () => {
	const a: GeoPoint = { longitude: deg(179.5), latitude: 0 }
	const b: GeoPoint = { longitude: deg(-179.5), latitude: 0 }
	const mid = intermediateGreatCircle(a, b, 0.5)

	expect(Math.abs(Math.abs(mid.longitude) - PI)).toBeLessThan(1e-10)
	expect(mid.latitude).toBeCloseTo(0, 12)
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
	expect(generated.tanF1).toBeCloseTo(0.004674017951890503, 12)
	expect(generated.tanF2).toBeCloseTo(0.004650731412398169, 12)
})

test('computePolynomialBesselianElements derives cone tangents from physical Sun-Moon distance', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: deg(15), sunDeclination: deg(7), sunDistance: 23484, moonRightAscension: deg(15.2), moonDeclination: deg(7.01), moonDistance: 56.28, deltaT: 69 }))

	expect(generated.tanF1).toBeCloseTo(0.004667490055439874, 12)
	expect(generated.tanF2).toBeCloseTo(0.004644236038740575, 12)
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
	expect(be.mu).toBeCloseTo(1.1779334094310219, 12)
	expect(Math.abs(be.x - tangentPlaneX)).toBeGreaterThan(0.01)
	expect(Math.abs(be.y - tangentPlaneY)).toBeGreaterThan(0.01)
})

test('computePolynomialBesselianElements follows the projection convention toward the day side', () => {
	const generated = computePolynomialBesselianElements(TIME0, (): SunMoonPosition => ({ sunRightAscension: 0, sunDeclination: 0, sunDistance: 23000, moonRightAscension: 0, moonDeclination: 0, moonDistance: 60, deltaT: 70 }))
	const be = evaluateBesselian(generated, TIME0)
	const point = projectFundamentalPoint(be, be.x, be.y)
	const subsolarLongitude = -1.870867645344

	expect(be.x).toBeCloseTo(0, 12)
	expect(be.y).toBeCloseTo(0, 12)
	expect(be.d).toBeCloseTo(0, 12)
	expect(be.mu).toBeCloseTo(1.8759721207956446, 12)
	expectGeoPointClose(point, subsolarLongitude, 0, 2460409.25)
})

test('findMaximumPoint matches NASA Besselian fixture at greatest eclipse instant', () => {
	for (const fixture of NASA_ECLIPSES) {
		const point = findMaximumPoint(nasaPbe(fixture))
		expect(formatAZ(point!.longitude, true)).toBe(fixture.greatestEclipse[0])
		expect(formatAZ(point!.latitude, true)).toBe(fixture.greatestEclipse[1])
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

		if (fixture.type === 'partial') {
			expect(geometry.points.U1).toBeUndefined()
			expect(geometry.points.U2).toBeUndefined()
			expect(geometry.lines.centerLine).toHaveLength(0)
			expect(geometry.lines.umbraNorth).toHaveLength(0)
			expect(geometry.lines.umbraSouth).toHaveLength(0)
			expect(geometry.polygons.totalityPath).toHaveLength(0)
			continue
		}

		if (fixture.central) {
			expect(Array.isArray(geometry.lines.centerLine)).toBe(true)
			expect(Array.isArray(geometry.lines.umbraNorth)).toBe(true)
			expect(Array.isArray(geometry.lines.umbraSouth)).toBe(true)
			continue
		}

		expect(geometry.points.U1).toBeUndefined()
		expect(geometry.points.U2).toBeUndefined()
		expect(geometry.lines.centerLine).toHaveLength(0)
		expect(geometry.lines.umbraNorth.length).toBeGreaterThan(0)
		expect(geometry.lines.umbraSouth.length).toBeGreaterThan(0)
		expect(geometry.polygons.totalityPath.length).toBeGreaterThan(0)
		for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
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
	expect(points.U1).toBeUndefined()
	expect(points.U2).toBeUndefined()

	expect(lines.centerLine).toHaveLength(0)
	expect(lines.umbraNorth).toHaveLength(0)
	expect(lines.umbraSouth).toHaveLength(0)
	expect(lines.penumbraNorth).toHaveLength(0)
	expect(lines.penumbraSouth).toHaveLength(0)
	expect(polygons.totalityPath).toHaveLength(0)
	expect(lines.riseSetCurves.map((line) => line.length)).toEqual([85, 85])
	expectGeoPointClose(lines.riseSetCurves[0][0], -1.565764772421259, 0.00004154541673005197, 2460409.055555556)
	expectGeoPointClose(lines.riseSetCurves[0].at(-1), 1.5758278811685338, 0.00004154541673005197, 2460409.444444444)
	expectGeoPointClose(lines.riseSetCurves[1][0], -1.565764772421259, -0.00004154541673005197, 2460409.055555556)
	expectGeoPointClose(lines.riseSetCurves[1].at(-1), 1.5758278811685338, -0.00004154541673005197, 2460409.444444444)
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
	const U1 = findExtremeLimitOfCentralLine(elements, true)
	const U2 = findExtremeLimitOfCentralLine(elements, false)

	expectGeoPoint(contacts.P1!)
	expectGeoPoint(contacts.P2!)
	expectGeoPoint(contacts.P3!)
	expectGeoPoint(contacts.P4!)
	expectGeoPoint(U1!)
	expectGeoPoint(U2!)
	expect(contacts.P1!.jd).toBeCloseTo(JD0 + 0.245 * 0.125, 8)
	expect(contacts.P2!.jd).toBeCloseTo(JD0 + 0.255 * 0.125, 8)
	expect(U1!.jd).toBeCloseTo(JD0 + 0.25 * 0.125, 8)
	expect(U2!.jd).toBeCloseTo(JD0 + 0.35 * 0.125, 8)
	expect(contacts.P3!.jd).toBeCloseTo(JD0 + 0.345 * 0.125, 8)
	expect(contacts.P4!.jd).toBeCloseTo(JD0 + 0.355 * 0.125, 8)
})

test('computeSolarEclipseMapGeometry anchors NASA total central endpoints', () => {
	const fixture = NASA_ECLIPSES[0]
	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 })
	const { points, lines } = geometry

	expectGeoPointClose(points.P1, -2.497483196155, -0.261206630319, 2460409.155109324)
	expectGeoPointClose(points.P2, -3.11620371921, 0.343668372479, 2460409.2403316502)
	expectGeoPointClose(points.Max, -1.817554029752, 0.441332038787, 2460409.262835)
	expectGeoPointClose(points.P3, 0.267164072568, 1.287980898916, 2460409.28533271)
	expectGeoPointClose(points.P4, -0.630810942984, 0.707481518424, 2460409.3705892717)
	expectGeoPointClose(points.U1, -2.766608740863, -0.136530835027, 2460409.195240535)
	expectGeoPointClose(points.U2, -0.34570440307, 0.831102873293, 2460409.330297813)
	expectIncreasingJd([points.P1!, points.U1!, points.P2!, points.Max!, points.P3!, points.U2!, points.P4!])
	expect(lines.centerLine).toHaveLength(19)
	expectGeoPointClose(lines.centerLine[0], points.U1!.longitude, points.U1!.latitude, points.U1!.jd)
	expectGeoPointClose(lines.centerLine[8], -1.931214613682, 0.318644701329, 2460409.245887015)
	expectGeoPointClose(lines.centerLine.at(-1), points.U2!.longitude, points.U2!.latitude, points.U2!.jd)
	expectMaxAngularStep(lines.centerLine, deg(12))
	expectIncreasingJd(lines.centerLine)
	expect(lines.umbraNorth.map((line) => line.length)).toEqual([17, 3])
	expect(lines.umbraSouth.map((line) => line.length)).toEqual([17, 3])
	expect(geometry.polygons.totalityPath.map((ring) => ring.length)).toEqual([34, 6])
	expectGeoPointClose(lines.umbraNorth[0][0], -2.635841172434, -0.111132385467, 2460409.195240535)
	expectGeoPointClose(lines.umbraNorth[0][8], -1.933314258729, 0.333437746204, 2460409.245887015)
	expectGeoPointClose(lines.umbraSouth[0][0], -2.731938032381, -0.142494477901, 2460409.195240535)
	expectGeoPointClose(lines.umbraSouth[0][8], -1.929229286192, 0.303858998691, 2460409.245887015)
	expect(lines.riseSetCurves.map((line) => line.length)).toEqual([103, 103])
	expectGeoPointClose(lines.riseSetCurves[0][0], -2.497500372105, -0.261085793191, 2460409.155109324)
	expectGeoPointClose(lines.riseSetCurves[1].at(-1), -0.632803541921, 0.46892902322, 2460409.363442659)
	for (const segment of [...lines.umbraNorth, ...lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry keeps central path gated by eclipse gamma', () => {
	const fixture = NASA_ECLIPSES[0]
	const nonCentral = { ...nasaEclipse(fixture), gamma: 1.01 }
	const geometry = computeSolarEclipseMapGeometry(nonCentral, nasaPbe(fixture), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })

	expectGeoPointClose(geometry.points.P1, -2.497483196155, -0.261206630319, 2460409.155109324)
	expectGeoPointClose(geometry.points.P2, -3.11620371921, 0.343668372479, 2460409.2403316502)
	expectGeoPointClose(geometry.points.Max, -1.817554029752, 0.441332038787, 2460409.262835)
	expectGeoPointClose(geometry.points.P3, 0.267164072568, 1.287980898916, 2460409.28533271)
	expectGeoPointClose(geometry.points.P4, -0.630810942984, 0.707481518424, 2460409.3705892717)
	expect(geometry.points.U1).toBeUndefined()
	expect(geometry.points.U2).toBeUndefined()
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth.map((line) => line.length)).toEqual([17, 3])
	expect(geometry.lines.umbraSouth.map((line) => line.length)).toEqual([17, 3])
	expect(geometry.polygons.totalityPath.map((ring) => ring.length)).toEqual([34, 6])
	for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry keeps umbral visibility for non-central total and annular eclipses', () => {
	const annular = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[4]), nasaPbe(NASA_ECLIPSES[4]), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })
	const total = computeSolarEclipseMapGeometry(nasaEclipse(NASA_ECLIPSES[5]), nasaPbe(NASA_ECLIPSES[5]), { longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: false, includePolygons: true })

	expect(annular.points.U1).toBeUndefined()
	expect(annular.points.U2).toBeUndefined()
	expect(annular.lines.centerLine).toHaveLength(0)
	expect(annular.lines.umbraNorth.map((line) => line.length)).toEqual([9])
	expect(annular.lines.umbraSouth.map((line) => line.length)).toEqual([9])
	expect(annular.polygons.totalityPath.map((ring) => ring.length)).toEqual([18])
	expectGeoPointClose(annular.lines.umbraNorth[0][0], 2.131883790574, -1.277275695444, 2456776.74720411)
	expectGeoPointClose(annular.lines.umbraSouth[0][0], 2.115351692844, -1.280020082326, 2456776.74720411)
	expectGeoPointClose(annular.polygons.totalityPath[0][0], 2.131883790574, -1.277275695444, 2456776.74720411)

	expect(total.points.U1).toBeUndefined()
	expect(total.points.U2).toBeUndefined()
	expect(total.lines.centerLine).toHaveLength(0)
	expect(total.lines.umbraNorth.map((line) => line.length)).toEqual([12])
	expect(total.lines.umbraSouth.map((line) => line.length)).toEqual([12])
	expect(total.polygons.totalityPath.map((ring) => ring.length)).toEqual([24])
	expectGeoPointClose(total.lines.umbraNorth[0][0], 2.764893002907, 0.954474665903, 2467349.281275766)
	expectGeoPointClose(total.lines.umbraNorth[0].at(-1), 2.506560316006, 1.185631396633, 2467349.298636876)
	expectGeoPointClose(total.lines.umbraSouth[0][0], 2.764893002907, 0.954474665903, 2467349.281275766)
	expectGeoPointClose(total.lines.umbraSouth[0].at(-1), 2.510510403475, 1.181733519179, 2467349.298636876)
	expectGeoPointClose(total.polygons.totalityPath[0][0], 2.764893002907, 0.954474665903, 2467349.281275766)
	for (const geometry of [annular, total]) for (const segment of [...geometry.lines.umbraNorth, ...geometry.lines.umbraSouth, ...geometry.polygons.totalityPath]) for (const point of segment) expectGeoPoint(point)
})

test('computeSolarEclipseMapGeometry contact search span is independent from polynomial step', () => {
	const fixture = NASA_ECLIPSES[0]
	const elements = nasaPbe(fixture)
	expect(elements.stepDays).toBe(1 / 24)

	const geometry = computeSolarEclipseMapGeometry(nasaEclipse(fixture), elements, { contactSearchSpan: 2 * 3600, longitudeStep: deg(30), maxAngularStep: deg(12), includeRiseSetCurves: true })

	expect(geometry.points.P1).toBeUndefined()
	expectGeoPointClose(geometry.points.P2, -3.116203705802, 0.343668341719, 2460409.240331649)
	expectGeoPointClose(geometry.points.P3, 0.267164133517, 1.287980925988, 2460409.2853327086)
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

	for (let i = 1; i < points.length; i++) {
		expect(Math.abs(points[i].longitude - points[i - 1].longitude)).toBeLessThanOrEqual(TAU)
	}
})

test('findCurvePoints refines exit boundaries away from the last valid longitude sample', () => {
	const points = findCurvePoints(pbe({ x: [-1, -1], y: [-0.5, -1], l1: [0.5], d: [deg(-45)], mu: [deg(-90), deg(10)] }), -1, 0, { longitudeStep: deg(30), maxAngularStep: deg(60) })

	expect(points).toHaveLength(3)
	expectGeoPointClose(points[0], 0.540468569523, -0.00009263783, 2460409.192290567)
	expectGeoPointClose(points[1], deg(30), -0.000002857566, 2460409.193263051)
	expectGeoPointClose(points[2], 0.500970561606, 0.000083295136, 2460409.194551978)
	expect(points[0].longitude).toBeGreaterThan(deg(30.7))
})

test('split helpers avoid direct antimeridian joins', () => {
	const line: GeoPoint[] = [
		{ longitude: deg(170), latitude: deg(10) },
		{ longitude: deg(-170), latitude: deg(12) },
		{ longitude: deg(-160), latitude: deg(15) },
	]

	const segments = splitPolylineAtAntimeridian(line)
	const rings = splitPolygonAtAntimeridian(line)

	expect(segments.length).toBeGreaterThan(1)
	expect(rings.length).toBeGreaterThan(1)
	expect(segments[0].at(-1)!.longitude).toBe(PI)
	expect(segments[1][0].longitude).toBe(-PI)
})

test('partial eclipse geometry omits central and umbral path data', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('partial', 1.1), pbe(), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: false })

	expect(geometry.points.Max).toBeDefined()
	expect(geometry.points.U1).toBeUndefined()
	expect(geometry.points.U2).toBeUndefined()
	expect(geometry.lines.centerLine).toHaveLength(0)
	expect(geometry.lines.umbraNorth).toHaveLength(0)
	expect(geometry.lines.umbraSouth).toHaveLength(0)
	expect(geometry.polygons.totalityPath).toHaveLength(0)
})

test('central total eclipse geometry exposes central and umbral containers when enabled', () => {
	const geometry = computeSolarEclipseMapGeometry(eclipse('total'), pbe({ x: [0, 0.25], y: [0.05], mu: [0, deg(8)] }), { longitudeStep: deg(60), maxAngularStep: deg(30), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 1800 })

	expect(geometry.points.Max).toBeDefined()
	expect(Array.isArray(geometry.lines.centerLine)).toBe(true)
	expect(Array.isArray(geometry.lines.umbraNorth)).toBe(true)
	expect(Array.isArray(geometry.lines.umbraSouth)).toBe(true)
	expect(Array.isArray(geometry.polygons.totalityPath)).toBe(true)
	for (const point of geometry.lines.penumbraNorth) expectGeoPoint(point)
	for (const point of geometry.lines.penumbraSouth) expectGeoPoint(point)
})

test('rise set curves are separate drawable arrays', () => {
	const elements = pbe()
	const contacts = computeSolarEclipseMapGeometry(eclipse('partial'), elements, { longitudeStep: deg(90) }).points

	expect(contacts.P1).toBeDefined()
	expect(contacts.P4).toBeDefined()

	const curves = computeRiseSetCurves(elements, contacts.P1!, contacts.P4!, {}, { step: 3600 })

	expect(curves).toHaveLength(2)
	expectGeoPointClose(curves[0][0], -1.565764772421259, 0.00004154541673005197, 2460409.055555556)
	expectGeoPointClose(curves[0].at(-1), 1.5758278811685338, 0.00004154541673005197, 2460409.444444444)
	expectGeoPointClose(curves[1][0], -1.565764772421259, -0.00004154541673005197, 2460409.055555556)
	expectGeoPointClose(curves[1].at(-1), 1.5758278811685338, -0.00004154541673005197, 2460409.444444444)

	for (const curve of curves) {
		expect(curve.length).toBeGreaterThan(0)
		for (const point of curve) expectGeoPoint(point)
	}
})

test('splitAtMaxAbsLatitude splits circumpolar-like limit arrays', () => {
	const split = splitAtMaxAbsLatitude([
		{ longitude: 0, latitude: deg(10) },
		{ longitude: deg(1), latitude: deg(80) },
		{ longitude: deg(2), latitude: deg(20) },
	])

	expect(split).toHaveLength(2)
	// The fold apex is shared between both branches so they meet without a gap.
	expect(split[0].map((point) => point.latitude)).toEqual([deg(10), deg(80)])
	expect(split[1].map((point) => point.latitude)).toEqual([deg(80), deg(20)])
})

test('splitAtMaxAbsLatitude keeps non-folding limits whole instead of emitting degenerate segments', () => {
	const split = splitAtMaxAbsLatitude([
		{ longitude: 0, latitude: deg(80) },
		{ longitude: deg(1), latitude: deg(40) },
		{ longitude: deg(2), latitude: deg(10) },
	])

	expect(split).toHaveLength(1)
	expect(split[0]).toHaveLength(3)
})
