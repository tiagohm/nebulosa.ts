import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { ALLEN_DIFFERENTIAL_ROTATION, approximateSolarDiskGeometry, HOWARD_1990_DIFFERENTIAL_ROTATION, heliographicToHelioprojective, heliographicToSolarImage, helioprojectiveToHeliographic, rotateCarringtonLongitude, SNODGRASS_1983_DIFFERENTIAL_ROTATION, type SolarDiskGeometry, type SolarImageCalibration, solarDiskGeometry, solarImageScale, solarImageToHeliographic, solarRotationRate } from '../../../src/astronomy/bodies/sun.heliographic'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { arcsec, deg, normalizePI, toArcsec, toDeg } from '../../../src/math/units/angle'

// Geocentric IAU geometry at a UTC instant from the VSOP87E Earth and Sun.
function geocentric(time: Time) {
	return solarDiskGeometry(time, earth(time), sun(time))
}

// Reference values from SunPy 8.0.1 / Astropy 8.0.1 (sunpy.coordinates.sun.P, B0, L0 with its
// defaults, angular_radius, earth_distance, and _sun_north_angle_to_z(GCRS) for P from ICRS north).
const SUNPY = [
	{ date: [1992, 10, 13, 0], p: 26.27374, pIcrs: 26.261425, b0: 5.989809, l0: 238.624162, distance: 0.99760834, semidiameter: 961.5309 },
	{ date: [2000, 1, 1, 12], p: 2.137247, pIcrs: 2.135375, b0: -3.013792, l0: 1.43319, distance: 0.98332767, semidiameter: 975.4951 },
	{ date: [2026, 3, 20, 12], p: -25.175191, pIcrs: -25.171843, b0: -7.042426, l0: 345.22849, distance: 0.99588574, semidiameter: 963.194 },
	{ date: [2026, 6, 29, 0], p: -3.615133, pIcrs: -3.77555, b0: 2.615538, l0: 96.842777, distance: 1.01652713, semidiameter: 943.6355 },
	{ date: [2026, 9, 7, 0], p: 22.44744, pIcrs: 22.407356, b0: 7.248922, l0: 251.181733, distance: 1.00787663, semidiameter: 951.7347 },
	{ date: [2026, 12, 8, 0], p: 13.283587, pIcrs: 13.440544, b0: 0.027545, l0: 117.715289, distance: 0.9851824, semidiameter: 973.6586 },
] as const

const TIME = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const GEOMETRY = geocentric(TIME)

describe('disk geometry', () => {
	test('IAU geometry matches SunPy on standard dates', () => {
		for (const ref of SUNPY) {
			const [year, month, day, hour] = ref.date
			const g = geocentric(timeYMDHMS(year, month, day, hour, 0, 0, Timescale.UTC))
			expect(g.model).toBe('iau')
			// P residual (< 0.001 deg) is SunPy's mean-equator/frame construction versus this true-of-date one.
			expect(toDeg(g.p)).toBeCloseTo(ref.p, 2)
			expect(toDeg(g.pIcrs)).toBeCloseTo(ref.pIcrs, 2)
			expect(toDeg(g.b0)).toBeCloseTo(ref.b0, 4)
			expect(toDeg(g.l0)).toBeCloseTo(ref.l0, 4)
			expect(g.distance).toBeCloseTo(ref.distance, 6)
			expect(toArcsec(g.semidiameter)).toBeCloseTo(ref.semidiameter, 1)
		}
	})

	test('Meeus geometry matches the worked example and stays close to the IAU model', () => {
		// Meeus, Astronomical Algorithms, example 29.a: 1992 Oct 13 0h UT gives P = 26.27, B0 = 5.99, L0 = 238.63 deg.
		const meeus = approximateSolarDiskGeometry(timeYMDHMS(1992, 10, 13, 0, 0, 0, Timescale.UTC))
		expect(meeus.model).toBe('meeus')
		expect(toDeg(meeus.p)).toBeCloseTo(26.27, 2)
		expect(toDeg(meeus.b0)).toBeCloseTo(5.99, 2)
		expect(toDeg(meeus.l0)).toBeCloseTo(238.63, 2)

		for (const ref of SUNPY) {
			const [year, month, day, hour] = ref.date
			const g = approximateSolarDiskGeometry(timeYMDHMS(year, month, day, hour, 0, 0, Timescale.UTC))
			expect(Math.abs(toDeg(g.p) - ref.p)).toBeLessThan(0.005)
			expect(Math.abs(toDeg(g.pIcrs) - ref.pIcrs)).toBeLessThan(0.005)
			expect(Math.abs(toDeg(g.b0) - ref.b0)).toBeLessThan(0.005)
			// Meeus L0 includes aberration (-0.006 deg) and an older rotation phase.
			expect(Math.abs(toDeg(normalizePI(g.l0 - deg(ref.l0))))).toBeLessThan(0.05)
			expect(g.distance).toBeCloseTo(ref.distance, 5)
		}
	})

	test('P and L0 are continuous across the right-ascension seam at the March equinox', () => {
		// The apparent Sun crosses RA = 0 near 2026-03-20 14:46 UTC; hourly samples must change smoothly.
		const samples = [12, 13, 14, 15, 16, 17].map((hour) => geocentric(timeYMDHMS(2026, 3, 20, hour, 0, 0, Timescale.UTC)))

		for (let i = 1; i < samples.length; i++) {
			const a = samples[i - 1]
			const b = samples[i]
			// P decreases by about 0.12 deg/day toward its April minimum of -26.3 deg.
			expect(toDeg(b.p - a.p)).toBeCloseTo(-0.0051, 3)
			expect(toDeg(b.pIcrs - a.pIcrs)).toBeCloseTo(-0.0051, 3)
			// The disk centre advances at the synodic rate, about -13.2 deg/day.
			expect(toDeg(normalizePI(b.l0 - a.l0)) * 24).toBeCloseTo(-13.23, 1)
		}

		expect(toDeg(samples[0].p)).toBeCloseTo(SUNPY[2].p, 2)
	})

	test('topocentric geometry matches SunPy for an observer on the surface', () => {
		// SunPy 8.0.1: observer at 45 W, 23 S, 0 m -> HGS lat 2.6151892 deg, HGC lon 96.8412087 deg, 1.0165588 AU.
		const location = geodeticLocation(deg(-45), deg(-23), 0)
		const topocentric = solarDiskGeometry(TIME, observerState(TIME, earth(TIME), location), sun(TIME))
		expect(toDeg(topocentric.b0)).toBeCloseTo(2.6151892, 5)
		expect(toDeg(topocentric.l0)).toBeCloseTo(96.8412087, 4)
		expect(topocentric.distance).toBeCloseTo(1.0165588, 6)
		expect(toArcsec(normalizePI(topocentric.l0 - GEOMETRY.l0))).toBeCloseTo(-5.66, 1)
	})
})

describe('helioprojective mapping', () => {
	test('helioprojective directions map to SunPy heliographic coordinates', () => {
		// SunPy 8.0.1 Helioprojective(observer=Earth) -> HeliographicStonyhurst / HeliographicCarrington.
		const cases = [
			[0, 0, 0, 2.6155381, 96.842777],
			[300, 200, 19.1003853, 14.657033, 115.943162],
			[-500, -600, -41.7234208, -37.4298432, 55.119356],
			[900, 100, 73.5992208, 6.8201734, 170.441998],
			[0, 940, 0, 87.3234193, 96.842777],
		] as const

		for (const [tx, ty, lon, lat, carrington] of cases) {
			const point = helioprojectiveToHeliographic(arcsec(tx), arcsec(ty), GEOMETRY)
			expect(point.onDisk).toBeTrue()
			if (!point.onDisk) continue
			expect(toDeg(point.stonyhurstLongitude)).toBeCloseTo(lon, 5)
			expect(toDeg(point.latitude)).toBeCloseTo(lat, 5)
			expect(toDeg(point.carringtonLongitude)).toBeCloseTo(carrington, 4)
		}
	})

	test('heliographic points project to SunPy helioprojective directions', () => {
		// SunPy 8.0.1 HeliographicStonyhurst -> Helioprojective(observer=Earth), arcseconds.
		const cases = [
			[30, 20, 445.048389, 288.454094],
			[-60, -45, -578.702453, -682.77543],
			[0, 89, 0, 942.019273],
			[89, 0, 943.557154, -0.751581],
		] as const

		for (const [lon, lat, tx, ty] of cases) {
			const point = heliographicToHelioprojective(deg(lon), deg(lat), 'stonyhurst', GEOMETRY)
			expect(point.visible).toBeTrue()
			expect(toArcsec(point.tx)).toBeCloseTo(tx, 3)
			expect(toArcsec(point.ty)).toBeCloseTo(ty, 3)
		}
	})

	test('limb, off-limb and disk-centre lines of sight', () => {
		const centre = helioprojectiveToHeliographic(0, 0, GEOMETRY)
		expect(centre.onDisk && centre.mu).toBe(1)

		const inside = helioprojectiveToHeliographic(GEOMETRY.semidiameter * 0.999999, 0, GEOMETRY)
		expect(inside.onDisk).toBeTrue()
		if (inside.onDisk) {
			expect(inside.mu).toBeLessThan(0.002)
			expect(toDeg(inside.stonyhurstLongitude)).toBeCloseTo(90, 0)
		}

		const outside = helioprojectiveToHeliographic(GEOMETRY.semidiameter * 1.000001, 0, GEOMETRY)
		expect(outside.onDisk).toBeFalse()

		const far = helioprojectiveToHeliographic(arcsec(1200), arcsec(-300), GEOMETRY)
		expect(far.onDisk).toBeFalse()
		if (!far.onDisk) expect(toArcsec(far.elongation)).toBeCloseTo(1236.93, 1)

		// A ray pointing away from the Sun never meets the sphere.
		expect(helioprojectiveToHeliographic(Math.PI, 0, GEOMETRY).onDisk).toBeFalse()
	})

	test('exact limb tangents stay on the disk despite rounding', () => {
		// semidiameter = asin(R / D) is the exact tangent; its zero discriminant rounds to either sign.
		for (const ref of SUNPY) {
			const [year, month, day, hour] = ref.date
			const g = geocentric(timeYMDHMS(year, month, day, hour, 0, 0, Timescale.UTC))
			const s = g.semidiameter

			for (const [tx, ty] of [
				[s, 0],
				[-s, 0],
				[0, s],
				[0, -s],
			]) {
				const limb = helioprojectiveToHeliographic(tx, ty, g)
				expect(limb.onDisk).toBeTrue()
				if (limb.onDisk) expect(limb.mu).toBeLessThan(1e-7)
				expect(helioprojectiveToHeliographic(tx * (1 + 1e-12), ty * (1 + 1e-12), g).onDisk).toBeFalse()
			}

			const cal: SolarImageCalibration = { centerX: 512, centerY: 512, scale: solarImageScale(g, 480), positionAngle: deg(33) }
			for (const [x, y] of [
				[992, 512],
				[32, 512],
				[512, 32],
				[512, 992],
			]) {
				expect(solarImageToHeliographic(x, y, g, cal).onDisk).toBeTrue()
			}
		}
	})

	test('far-side points and the hidden pole are flagged', () => {
		// B0 > 0 tilts the north pole toward the observer and hides the south pole.
		expect(heliographicToHelioprojective(0, deg(90), 'stonyhurst', GEOMETRY).visible).toBeTrue()
		expect(heliographicToHelioprojective(0, deg(-90), 'stonyhurst', GEOMETRY).visible).toBeFalse()
		expect(heliographicToHelioprojective(deg(120), 0, 'stonyhurst', GEOMETRY).visible).toBeFalse()
		expect(heliographicToHelioprojective(GEOMETRY.l0, 0, 'carrington', GEOMETRY).tx).toBeCloseTo(0, 12)
	})

	test('Carrington longitude wraps through zero', () => {
		// L0 is 1.43 deg on 2000-01-01 12:00 UTC, so a point 10 deg east of the central meridian is at 351.43 deg.
		const g = geocentric(timeYMDHMS(2000, 1, 1, 12, 0, 0, Timescale.UTC))
		const projected = heliographicToHelioprojective(deg(-10), deg(15), 'stonyhurst', g)
		const point = helioprojectiveToHeliographic(projected.tx, projected.ty, g)
		expect(point.onDisk).toBeTrue()
		if (!point.onDisk) return
		expect(toDeg(point.carringtonLongitude)).toBeCloseTo(351.43319, 4)
		expect(toDeg(point.stonyhurstLongitude)).toBeCloseTo(-10, 8)

		const fromCarrington = heliographicToHelioprojective(point.carringtonLongitude, deg(15), 'carrington', g)
		expect(fromCarrington.tx).toBeCloseTo(projected.tx, 12)
		expect(fromCarrington.ty).toBeCloseTo(projected.ty, 12)
	})
})

describe('image mapping', () => {
	// 1 arcsec/pixel image with the disk centre at (1000, 800).
	function calibration(positionAngle: number, options?: Partial<SolarImageCalibration>): SolarImageCalibration {
		return { centerX: 1000, centerY: 800, scale: arcsec(1), positionAngle, ...options }
	}

	function heliographic(x: number, y: number, geometry: SolarDiskGeometry, cal: SolarImageCalibration) {
		const point = solarImageToHeliographic(x, y, geometry, cal)
		if (!point.onDisk) throw new Error('expected an on-disk pixel')
		return point
	}

	test('solar north up places west to the right of a normal image', () => {
		const cal = calibration(GEOMETRY.p)
		const up = heliographic(1000, 300, GEOMETRY, cal)
		expect(toDeg(up.stonyhurstLongitude)).toBeCloseTo(0, 8)
		expect(up.latitude).toBeGreaterThan(deg(30))

		const right = heliographic(1500, 800, GEOMETRY, cal)
		expect(right.stonyhurstLongitude).toBeGreaterThan(deg(30))

		// A mirrored image swaps east and west.
		const mirrored = heliographic(1500, 800, GEOMETRY, calibration(GEOMETRY.p, { mirrored: true }))
		expect(mirrored.stonyhurstLongitude).toBeCloseTo(-right.stonyhurstLongitude, 12)
		expect(mirrored.latitude).toBeCloseTo(right.latitude, 12)
	})

	test('a celestial-north-up image is rotated by P', () => {
		// With celestial north up, a point 500 px (500 arcsec) up lies at position angle -P from solar north,
		// so its tangent-plane offsets are (west, north) = (-500 sin(-P), 500 cos(-P)) arcsec.
		const point = heliographic(1000, 300, GEOMETRY, calibration(0))
		const xi = arcsec(-500 * Math.sin(-GEOMETRY.p))
		const eta = arcsec(500 * Math.cos(-GEOMETRY.p))
		// Gnomonic (xi, eta) to helioprojective angles.
		const expected = helioprojectiveToHeliographic(Math.atan(xi), Math.atan2(eta, Math.sqrt(1 + xi * xi)), GEOMETRY)
		expect(expected.onDisk).toBeTrue()
		if (expected.onDisk) {
			expect(point.stonyhurstLongitude).toBeCloseTo(expected.stonyhurstLongitude, 10)
			expect(point.latitude).toBeCloseTo(expected.latitude, 10)
		}
		// P < 0 puts celestial north east (left) of solar north.
		expect(point.stonyhurstLongitude).toBeLessThan(0)
	})

	test('ICRS and true-of-date position angles describe the same image', () => {
		const date = heliographic(1234, 567, GEOMETRY, calibration(deg(40)))
		const icrs = heliographic(1234, 567, GEOMETRY, calibration(deg(40) + GEOMETRY.pIcrs - GEOMETRY.p, { north: 'icrs' }))
		expect(icrs.carringtonLongitude).toBeCloseTo(date.carringtonLongitude, 12)
		expect(icrs.latitude).toBeCloseTo(date.latitude, 12)
	})

	test('pixel to heliographic to pixel round trips', () => {
		for (const cal of [calibration(deg(37)), calibration(deg(-150), { mirrored: true }), calibration(deg(200), { north: 'icrs', scale: arcsec(0.37) })]) {
			const radius = Math.tan(GEOMETRY.semidiameter) / cal.scale
			for (const [fx, fy] of [
				[0, 0],
				[0.3, -0.4],
				[-0.7, 0.2],
				[0.05, 0.99],
				[-0.99, -0.05],
				[0.6, 0.79],
			]) {
				const x = cal.centerX + fx * radius
				const y = cal.centerY + fy * radius
				const point = heliographic(x, y, GEOMETRY, cal)

				for (const [longitude, system] of [
					[point.stonyhurstLongitude, 'stonyhurst'],
					[point.carringtonLongitude, 'carrington'],
				] as const) {
					const pixel = heliographicToSolarImage(longitude, point.latitude, system, GEOMETRY, cal)
					expect(pixel.visible).toBeTrue()
					expect(pixel.x).toBeCloseTo(x, 7)
					expect(pixel.y).toBeCloseTo(y, 7)
				}
			}
		}
	})

	test('heliographic to pixel to heliographic round trips near the poles and the limb', () => {
		const cal = calibration(deg(-75), { mirrored: true })
		// B0 = 2.6 deg makes points just beyond the pole, such as 120 deg east at 88 deg latitude, visible.
		for (const [lon, lat] of [
			[0, 89.9],
			[45, 80],
			[-89.5, 10],
			[60, -60],
			[-120, 88],
		]) {
			const pixel = heliographicToSolarImage(deg(lon), deg(lat), 'stonyhurst', GEOMETRY, cal)
			expect(pixel.visible).toBeTrue()
			const point = heliographic(pixel.x, pixel.y, GEOMETRY, cal)
			expect(toDeg(point.latitude)).toBeCloseTo(lat, 7)
			expect(toDeg(point.stonyhurstLongitude)).toBeCloseTo(lon, lat > 89 ? 4 : 7)
		}
	})

	test('a measured disk radius sets the scale and the limb', () => {
		const scale = solarImageScale(GEOMETRY, 480)
		expect(toArcsec(scale)).toBeCloseTo(943.6355 / 480, 3)

		const cal: SolarImageCalibration = { centerX: 512, centerY: 512, scale, positionAngle: 0 }
		const limb = solarImageToHeliographic(512 + 479.999, 512, GEOMETRY, cal)
		expect(limb.onDisk).toBeTrue()
		expect(solarImageToHeliographic(512 + 480.001, 512, GEOMETRY, cal).onDisk).toBeFalse()
		expect(solarImageToHeliographic(512, 512 - 480.001, GEOMETRY, cal).onDisk).toBeFalse()
	})
})

describe('differential rotation', () => {
	test('sidereal rates match the SunPy models', () => {
		// SunPy 8.0.1 sunpy.sun.models.differential_rotation(1 day, lat), degrees.
		const cases = [
			[HOWARD_1990_DIFFERENTIAL_ROTATION, [14.3263284, 13.6821634, 11.7069716, 10.3759448]],
			[SNODGRASS_1983_DIFFERENTIAL_ROTATION, [14.1134631, 13.5423159, 11.5200957, 10.0690228]],
			[ALLEN_DIFFERENTIAL_ROTATION, [14.44, 13.69, 12.19, 11.44]],
		] as const

		for (const [model, rates] of cases) {
			for (const [i, lat] of [0, 30, 60, 90].entries()) {
				expect(toDeg(solarRotationRate(deg(lat), model))).toBeCloseTo(rates[i], 6)
				expect(solarRotationRate(deg(-lat), model)).toBeCloseTo(solarRotationRate(deg(lat), model), 15)
			}
		}

		expect(solarRotationRate(0)).toBe(HOWARD_1990_DIFFERENTIAL_ROTATION.a)
	})

	test('features drift relative to the Carrington frame', () => {
		const later = timeShift(TIME, 3)

		// The equator outruns the Carrington rate by (14.3263 - 14.1844) deg/day under the Howard model.
		const equator = rotateCarringtonLongitude(deg(100), 0, TIME, later)
		expect(toDeg(equator)).toBeCloseTo(100 + 3 * (14.3263284 - 14.1844), 6)

		// High latitudes lag; the result wraps into [0, 360).
		const polar = rotateCarringtonLongitude(deg(1), deg(60), TIME, later)
		expect(toDeg(polar)).toBeCloseTo(361 + 3 * (11.7069716 - 14.1844), 6)

		// Reversing the interval undoes the drift.
		expect(rotateCarringtonLongitude(equator, 0, later, TIME)).toBeCloseTo(deg(100), 12)
	})

	test('a rotated feature reappears where the new geometry predicts', () => {
		const later = timeShift(TIME, 1)
		const laterGeometry = geocentric(later)
		const start = helioprojectiveToHeliographic(arcsec(-300), arcsec(200), GEOMETRY)
		expect(start.onDisk).toBeTrue()
		if (!start.onDisk) return

		const carrington = rotateCarringtonLongitude(start.carringtonLongitude, start.latitude, TIME, later)
		const moved = heliographicToHelioprojective(carrington, start.latitude, 'carrington', laterGeometry)
		expect(moved.visible).toBeTrue()
		// The Stonyhurst shift is the differential drift plus the disk-centre motion L0(t) - L0(t + 1 day).
		const point = helioprojectiveToHeliographic(moved.tx, moved.ty, laterGeometry)
		expect(point.onDisk).toBeTrue()
		if (!point.onDisk) return
		const shift = point.stonyhurstLongitude - start.stonyhurstLongitude
		expect(shift).toBeCloseTo(solarRotationRate(start.latitude) - deg(14.1844) + normalizePI(GEOMETRY.l0 - laterGeometry.l0), 10)
		expect(toDeg(point.latitude)).toBeCloseTo(toDeg(start.latitude), 8)
		// About 13.2 deg/day westward for a feature at 13.5 deg latitude.
		expect(toDeg(shift)).toBeCloseTo(13.24, 1)
	})
})
