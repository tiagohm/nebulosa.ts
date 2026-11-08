import { describe, expect, test } from 'bun:test'
import { plateSolutionFrom, type PlateSolution } from '../../../src/astrometry/solvers/platesolver'
import { tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { cirsToIcrs, DEFAULT_REFRACTION_PARAMETERS, observedToCirs, type RefractionParameters, refractedAltitude } from '../../../src/astronomy/coordinates/astrometry'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation, type GeographicPosition } from '../../../src/astronomy/observer/location'
import { gcrsToItrsRotationMatrix, tdb, type Time, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, PI } from '../../../src/core/constants'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { matMulVec, matRodriguesRotation, matToVec3, matTranspose } from '../../../src/math/linear-algebra/mat3'
import { fitRotation } from '../../../src/math/linear-algebra/rotation.fit'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDot, vecNormalize, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { normal, splitmix32 } from '../../../src/math/numerical/random'
import { arcmin, arcsec, deg, toArcsec, toDeg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { advanceIPolarConvergence, calibrateIPolar, DEFAULT_IPOLAR_CONVERGENCE, type IPolarAcceptedMeasurement, type IPolarCalibration, type IPolarFrame, IPOLAR_CONVERGENCE_START, type IPolarMeasurement, type IPolarSensorGeometry, measureIPolar } from '../../../src/observation/alignment/ipolar'
import { ipolarSamplePixels, type IPolarObserver } from '../../../src/observation/alignment/ipolar.geometry'

// The scenarios build an exact rigid mount in ITRS, independently of the module: a mechanical axis
// displaced from the pole by known on-sky east and up components, a gnomonic camera rigid with it,
// physical rays turned about the axis, and their astrometric places through observedToCirs and
// cirsToIcrs (ERFA's apio13/apci13 path, not the apco13 path of the module) at each exposure's own
// instant, fitted with a TAN or TAN-SIP header. No Earth-orientation tables are installed, so
// UT1 = UTC and polar motion is zero, making the geometric target pole the ITRS ±z axis.

const START = timeYMDHMS(2026, 11, 8, 23, 0, 0)
const SIDEREAL_RATE = (2 * PI * 1.00273781191135448) / DAYSEC

interface MountDefinition {
	readonly latitude: number
	readonly longitude?: number
	readonly azimuthError?: number
	readonly altitudeError?: number
	readonly refraction?: RefractionParameters | false
	// Angle between the boresight and the mechanical axis.
	readonly offset?: number
	readonly roll?: number
	readonly width?: number
	readonly height?: number
	readonly scale?: number
	readonly flipped?: boolean
	// Radial SIP coefficient, in pixels⁻².
	readonly distortion?: number
}

interface PoseDefinition {
	// Rotation about the mechanical axis, in radians.
	readonly rotation: number
	// Seconds after START.
	readonly seconds?: number
	// Extra rotation of the camera and axis together, as an adjustment of the base.
	readonly base?: { readonly azimuth: number; readonly altitude: number }
	// Rotation of the camera alone about an axis perpendicular to the mechanical axis (DEC).
	readonly declination?: number
	readonly sensor?: Partial<IPolarSensorGeometry>
	readonly scale?: number
	// Random attitude noise per axis, in radians.
	readonly noise?: () => number
	// Replace the pointing by another field entirely (a wrong blind solve).
	readonly field?: Vec3
}

function horizon({ latitude, longitude }: GeographicPosition) {
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinLon = Math.sin(longitude)
	const cosLon = Math.cos(longitude)
	return { north: [-sinLat * cosLon, -sinLat * sinLon, cosLat] as Vec3, east: [-sinLon, cosLon, 0] as Vec3, up: [cosLat * cosLon, cosLat * sinLon, sinLat] as Vec3 }
}

function horizontal(azimuth: number, altitude: number, { north, east, up }: ReturnType<typeof horizon>): MutVec3 {
	const n = Math.cos(altitude) * Math.cos(azimuth)
	const e = Math.cos(altitude) * Math.sin(azimuth)
	const u = Math.sin(altitude)
	return [north[0] * n + east[0] * e + up[0] * u, north[1] * n + east[1] * e + up[1] * u, north[2] * n + east[2] * e + up[2] * u]
}

function tangent(vector: Vec3, point: Vec3, other?: Vec3) {
	const p = vecDot(vector, point)
	const t: MutVec3 = [vector[0] - p * point[0], vector[1] - p * point[1], vector[2] - p * point[2]]
	if (other) {
		const o = vecDot(t, other)
		t[0] -= o * other[0]
		t[1] -= o * other[1]
		t[2] -= o * other[2]
	}
	return vecNormalize(t)
}

// Exponential map at `point`: the direction `east` and `up` radians away along the local tangents.
function displaced(point: Vec3, east: number, up: number, basis: ReturnType<typeof horizon>) {
	const e = tangent(basis.east, point)
	const z = tangent(basis.up, point, e)
	const angle = Math.hypot(east, up)
	if (angle === 0) return [...point] as MutVec3
	const s = Math.sin(angle) / angle
	return vecNormalize([Math.cos(angle) * point[0] + s * (east * e[0] + up * z[0]), Math.cos(angle) * point[1] + s * (east * e[1] + up * z[1]), Math.cos(angle) * point[2] + s * (east * e[2] + up * z[2])])
}

function physicalToIcrs(ray: Vec3, time: Time, location: GeographicPosition, refraction: RefractionParameters | false, basis: ReturnType<typeof horizon>, ephemeris: ReturnType<typeof eraEpv00>) {
	const n = vecDot(ray, basis.north)
	const e = vecDot(ray, basis.east)
	const u = vecDot(ray, basis.up)
	const cirs = observedToCirs(Math.atan2(e, n), Math.atan2(u, Math.hypot(n, e)), time, refraction, location)
	return cirsToIcrs(cirs, time, ephemeris[0], ephemeris[1][0])
}

function mount(definition: MountDefinition) {
	const { latitude, longitude = deg(-45), azimuthError = 0, altitudeError = 0, refraction = false, offset = deg(1.5), roll = deg(33), width = 1280, height = 960, scale = arcsec(6), flipped = false, distortion = 0 } = definition
	const location = geodeticLocation(longitude, latitude, meter(800))
	const basis = horizon(location)
	const north = latitude >= 0
	const geometric = Math.abs(latitude)
	const target = horizontal(north ? 0 : PI, refraction === false ? geometric : refractedAltitude(geometric, refraction), basis)
	const axis = displaced(target, azimuthError, altitudeError, basis)
	const forward = offset === 0 ? axis : displaced(axis, deg(0.2) * offset, offset, basis)
	const right0 = offset === 0 ? tangent(basis.east, axis) : vecNormalize(vecCross(forward, axis))
	const right = vecRotateByRodrigues(right0, forward, roll)
	const down = vecNormalize(vecCross(forward, right))
	const observer: IPolarObserver = { location, refraction }
	const sensor: IPolarSensorGeometry = { width, height, binX: 1, binY: 1, x: 0, y: 0 }

	// Camera ray of the distorted pixel offset (U, V) from the center, before any rotation.
	const cameraRay = (u: number, v: number, s: number) => {
		const r2 = u * u + v * v
		const U = (flipped ? -1 : 1) * (u + distortion * r2 * u)
		const V = v + distortion * r2 * v
		return vecNormalize([forward[0] + s * (U * right[0] + V * down[0]), forward[1] + s * (U * right[1] + V * down[1]), forward[2] + s * (U * right[2] + V * down[2])])
	}

	const attitude = (pose: PoseDefinition) => {
		let rotation = matRodriguesRotation(axis, pose.rotation)
		if (pose.declination) rotation = mul(rotation, matRodriguesRotation(vecNormalize(vecCross(axis, forward)), pose.declination))
		if (pose.base) {
			const moved = displaced(target, azimuthError + pose.base.azimuth, altitudeError + pose.base.altitude, basis)
			const pivot = vecCross(axis, moved)
			const angle = vecAngle(axis, moved)
			if (angle > 0) rotation = mul(matRodriguesRotation(vecNormalize(pivot), angle), rotation)
		}
		if (pose.noise) {
			const n: Vec3 = [pose.noise(), pose.noise(), pose.noise()]
			const length = Math.hypot(...n)
			if (length > 0) rotation = mul(matRodriguesRotation(n, length), rotation)
		}
		if (pose.field) {
			const pivot = vecCross(forward, pose.field)
			rotation = mul(matRodriguesRotation(vecNormalize(pivot), vecAngle(forward, pose.field)), rotation)
		}
		return rotation
	}

	const frame = (pose: PoseDefinition): IPolarFrame & { readonly attitude: ReturnType<typeof attitude> } => {
		const time = timeShift(START, (pose.seconds ?? 0) / DAYSEC)
		time.location = location
		const ephemeris = eraEpv00(tdb(time).day, tdb(time).fraction)
		const rotation = attitude(pose)
		const s = pose.scale ?? scale
		const physical = (u: number, v: number) => matMulVec(rotation, cameraRay(u, v, s))
		const [crval1, crval2] = physicalToIcrs(physical(0, 0), time, location, refraction, basis, ephemeris)
		const center = eraS2c(crval1, crval2)
		const east = vecNormalize(vecCross([0, 0, 1], center))
		const northward = vecCross(center, east)

		// Least-squares CD over a grid of distorted offsets: standard coordinates (deg) = CD · (U, V).
		let suu = 0
		let suv = 0
		let svv = 0
		let sxu = 0
		let sxv = 0
		let syu = 0
		let syv = 0
		for (let j = 0; j <= 8; j++) {
			for (let i = 0; i <= 8; i++) {
				const u = (i / 8 - 0.5) * width
				const v = (j / 8 - 0.5) * height
				const r2 = u * u + v * v
				const U = u + distortion * r2 * u
				const V = v + distortion * r2 * v
				const sky = eraS2c(...physicalToIcrs(physical(u, v), time, location, refraction, basis, ephemeris))
				const d = vecDot(sky, center)
				const xi = toDeg(vecDot(sky, east) / d)
				const eta = toDeg(vecDot(sky, northward) / d)
				suu += U * U
				suv += U * V
				svv += V * V
				sxu += xi * U
				sxv += xi * V
				syu += eta * U
				syv += eta * V
			}
		}
		const det = suu * svv - suv * suv
		const header: FitsHeader = {
			NAXIS: 2,
			NAXIS1: width,
			NAXIS2: height,
			CTYPE1: distortion ? 'RA---TAN-SIP' : 'RA---TAN',
			CTYPE2: distortion ? 'DEC--TAN-SIP' : 'DEC--TAN',
			CUNIT1: 'deg',
			CUNIT2: 'deg',
			CRPIX1: (width + 1) / 2,
			CRPIX2: (height + 1) / 2,
			CRVAL1: toDeg(crval1),
			CRVAL2: toDeg(crval2),
			CD1_1: (sxu * svv - sxv * suv) / det,
			CD1_2: (sxv * suu - sxu * suv) / det,
			CD2_1: (syu * svv - syv * suv) / det,
			CD2_2: (syv * suu - syu * suv) / det,
			RADESYS: 'ICRS',
			...(distortion && { A_ORDER: 3, B_ORDER: 3, A_3_0: distortion, A_1_2: distortion, B_2_1: distortion, B_0_3: distortion }),
		}
		const solution = plateSolutionFrom(header)
		if (!solution) throw new Error('failed to build a synthetic plate solution')
		return { time, solution: { ...solution }, sensor: { ...sensor, ...pose.sensor }, attitude: rotation }
	}

	// FITS pixel where the physical `direction` falls in the camera at `pose` (undistorted model).
	const pixelOf = (direction: Vec3, pose: PoseDefinition) => {
		const local = matMulVec(matTranspose(attitude(pose)), direction)
		const d = vecDot(local, forward)
		const sign = flipped ? -1 : 1
		const s = pose.scale ?? scale
		return { x: (width + 1) / 2 + (sign * vecDot(local, right)) / d / s, y: (height + 1) / 2 + vecDot(local, down) / d / s }
	}

	return { location, observer, axis, target, frame, pixelOf, sensor }
}

function mul(a: readonly number[], b: readonly number[]) {
	const out = new Array<number>(9)
	for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
	return out as unknown as ReturnType<typeof matRodriguesRotation>
}

function calibrated(m: ReturnType<typeof mount>, rotation = deg(30), seconds = 60) {
	const result = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation, seconds }), m.observer)
	if (!result.accepted) throw new Error(`calibration rejected: ${result.reason}`)
	return result.calibration
}

function accepted(measurement: IPolarMeasurement): IPolarAcceptedMeasurement {
	if (!measurement.valid) throw new Error(`measurement rejected: ${measurement.reason}`)
	return measurement
}

const SITES = [
	{ name: 'north 40°', latitude: deg(40) },
	{ name: 'south 22°', latitude: deg(-22) },
	{ name: 'south 35°', latitude: deg(-35), longitude: deg(149) },
	{ name: 'north 64°', latitude: deg(64), longitude: deg(-21) },
]

const ERRORS = [
	{ name: 'zero', azimuthError: 0, altitudeError: 0 },
	{ name: 'azimuth only', azimuthError: arcmin(20), altitudeError: 0 },
	{ name: 'altitude only', azimuthError: 0, altitudeError: arcmin(-12) },
	{ name: 'combined', azimuthError: arcmin(-45), altitudeError: arcmin(30) },
	{ name: 'small', azimuthError: arcsec(20), altitudeError: arcsec(-15) },
	{ name: 'degree scale', azimuthError: deg(1.5), altitudeError: deg(-2) },
]

describe('calibration recovers the injected axis', () => {
	for (const site of SITES) {
		for (const refraction of [false, DEFAULT_REFRACTION_PARAMETERS] as const) {
			for (const error of ERRORS) {
				test(`${site.name}, ${refraction ? 'refracted' : 'geometric'}, ${error.name}`, () => {
					const m = mount({ ...site, ...error, refraction })
					const calibration = calibrated(m)
					const measurement = accepted(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 60 })))
					expect(toArcsec(Math.abs(measurement.error.azimuth - error.azimuthError))).toBeLessThan(2)
					expect(toArcsec(Math.abs(measurement.error.altitude - error.altitudeError))).toBeLessThan(2)
					expect(toArcsec(vecAngle(measurement.axis, m.axis))).toBeLessThan(2)
					expect(toDeg(calibration.quality.rotation)).toBeCloseTo(30, 3)
					expect(calibration.quality.preferred).toBeTrue()
				})
			}
		}
	}

	test('with a mirrored sensor, a wide field, a main camera far from the axis and SIP distortion', () => {
		for (const definition of [{ flipped: true }, { width: 3000, height: 2000, scale: arcsec(30) }, { offset: deg(40) }, { distortion: 6e-9 }, { offset: 0, roll: deg(-70) }]) {
			const m = mount({ latitude: deg(-30), azimuthError: arcmin(8), altitudeError: arcmin(5), ...definition })
			const measurement = accepted(measureIPolar(calibrated(m), m.frame({ rotation: deg(25), seconds: 300 })))
			expect(toArcsec(Math.abs(measurement.error.azimuth - arcmin(8)))).toBeLessThan(2)
			expect(toArcsec(Math.abs(measurement.error.altitude - arcmin(5)))).toBeLessThan(2)
		}
	})

	test('needs no overlap between the two fields', () => {
		const m = mount({ latitude: deg(45), offset: deg(20), scale: arcsec(3), width: 1000, height: 800, azimuthError: arcmin(-10) })
		const first = m.frame({ rotation: 0 })
		const second = m.frame({ rotation: deg(40), seconds: 90 })
		expect(vecAngle(eraS2c(first.solution.rightAscension, first.solution.declination), eraS2c(second.solution.rightAscension, second.solution.declination))).toBeGreaterThan(first.solution.radius * 4)
		const result = calibrateIPolar(first, second, m.observer)
		expect(result.accepted).toBeTrue()
		const measurement = accepted(measureIPolar((result as { calibration: IPolarCalibration }).calibration, second))
		expect(toArcsec(Math.abs(measurement.error.azimuth - arcmin(-10)))).toBeLessThan(2)
	})
})

describe('time', () => {
	test('the axis does not depend on the delay between the frames', () => {
		for (const latitude of [deg(40), deg(-30)]) {
			const m = mount({ latitude, azimuthError: arcmin(15), altitudeError: arcmin(-7) })
			const prompt = calibrated(m, deg(30), 30)
			const late = calibrated(m, deg(30), 600)
			expect(toArcsec(vecAngle(prompt.axis, late.axis))).toBeLessThan(0.5)
			expect(toArcsec(vecAngle(prompt.axis, m.axis))).toBeLessThan(1)
		}
	})

	test('tracking between the frames only adds RA rotation', () => {
		const m = mount({ latitude: deg(-25), azimuthError: arcmin(-6), altitudeError: arcmin(9) })
		const tracked = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(25) + SIDEREAL_RATE * 600, seconds: 600 }), m.observer)
		expect(tracked.accepted).toBeTrue()
		const calibration = (tracked as { calibration: IPolarCalibration }).calibration
		expect(toDeg(calibration.quality.rotation)).toBeCloseTo(25 + toDeg(SIDEREAL_RATE * 600), 2)
		expect(toArcsec(vecAngle(calibration.axis, m.axis))).toBeLessThan(1)
	})

	test('a naive fit of ICRS rays is biased by the rotation of the Earth', () => {
		const m = mount({ latitude: deg(40), azimuthError: arcmin(15) })
		const first = m.frame({ rotation: 0 })
		const second = m.frame({ rotation: deg(30), seconds: 600 })
		const rays = (solution: PlateSolution) => ipolarSamplePixels(solution.widthInPixels, solution.heightInPixels).map(({ x, y }) => eraS2c(...tanUnproject(solution, x, y)!))
		const fit = fitRotation(rays(first.solution), rays(second.solution))!
		const vector = matToVec3(matTranspose(fit.rotation))
		const naive = matMulVec(gcrsToItrsRotationMatrix(second.time), vecNormalize(vector))
		expect(toArcsec(Math.min(vecAngle(naive, m.axis), vecAngle(naive, [-m.axis[0], -m.axis[1], -m.axis[2]])))).toBeGreaterThan(60)
	})

	test('rejects frames out of order or too far apart', () => {
		const m = mount({ latitude: deg(40) })
		expect(calibrateIPolar(m.frame({ rotation: 0, seconds: 60 }), m.frame({ rotation: deg(30) }), m.observer)).toMatchObject({ accepted: false, reason: 'badTime' })
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(30), seconds: 7200 }), m.observer)).toMatchObject({ accepted: false, reason: 'badTime' })
		const calibration = calibrated(m)
		const first = accepted(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 120 })))
		expect(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 100 }), first)).toMatchObject({ valid: false, reason: 'badTime', invalidatesCalibration: false })
	})
})

describe('calibration gates', () => {
	const m = mount({ latitude: deg(40), azimuthError: arcmin(10) })

	test('measures the rotation and rejects too little or too much', () => {
		const small = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(5), seconds: 30 }), m.observer)
		expect(small).toMatchObject({ accepted: false, reason: 'insufficientRotation' })
		expect(toDeg(small.accepted ? 0 : small.quality.rotation!)).toBeCloseTo(5, 3)
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(70), seconds: 30 }), m.observer)).toMatchObject({ accepted: false, reason: 'excessiveRotation' })
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(-170), seconds: 30 }), m.observer)).toMatchObject({ accepted: false, reason: 'excessiveRotation' })
		const marginal = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(12), seconds: 30 }), m.observer)
		expect(marginal).toMatchObject({ accepted: true, calibration: { quality: { preferred: false } } })
	})

	test('orients the axis to the pole whatever the direction of rotation', () => {
		const east = calibrated(m, deg(-30))
		const west = calibrated(m, deg(30))
		expect(toArcsec(vecAngle(east.axis, west.axis))).toBeLessThan(1)
	})

	test('rejects a declination motion and a wrong blind solve as a wrong axis', () => {
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: 0, declination: deg(20), seconds: 30 }), m.observer)).toMatchObject({ accepted: false, reason: 'wrongAxis' })
		const wrong = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(30), seconds: 30, field: vecNormalize([0.3, 0.6, 0.2]) }), m.observer)
		expect(wrong.accepted).toBeFalse()
	})

	test('never accepts a mixed motion whose axis leaves the envelope', () => {
		const random = splitmix32(7)
		for (let i = 0; i < 40; i++) {
			const declination = deg(8 + 30 * random())
			const result = calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(10 + 30 * random()), declination, seconds: 30 }), m.observer)
			if (result.accepted) expect(toDeg(result.calibration.quality.axisOffset)).toBeLessThanOrEqual(5)
			else expect(['wrongAxis', 'excessiveRotation', 'insufficientRotation']).toContain(result.reason)
		}
	})

	test('rejects a different sensor geometry, a parity change and a non-rigid pair', () => {
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(30), seconds: 30, sensor: { binX: 2 } }), m.observer)).toMatchObject({ accepted: false, reason: 'inconsistentSensor' })
		const mirrored = mount({ latitude: deg(40), azimuthError: arcmin(10), flipped: true })
		expect(calibrateIPolar(m.frame({ rotation: 0 }), mirrored.frame({ rotation: deg(30), seconds: 30 }), m.observer)).toMatchObject({ accepted: false, reason: 'inconsistentSensor' })
		expect(calibrateIPolar(m.frame({ rotation: 0 }), m.frame({ rotation: deg(30), seconds: 30, scale: arcsec(6) * 1.01 }), m.observer)).toMatchObject({ accepted: false, reason: 'unstableFit' })
	})

	test('rejects a field too small and a WCS that cannot be unprojected', () => {
		const narrow = mount({ latitude: deg(40), width: 200, height: 150, scale: arcsec(1) })
		expect(calibrateIPolar(narrow.frame({ rotation: 0 }), narrow.frame({ rotation: deg(30), seconds: 30 }), narrow.observer)).toMatchObject({ accepted: false, reason: 'poorConditioning' })
		const second = m.frame({ rotation: deg(30), seconds: 30 })
		expect(calibrateIPolar(m.frame({ rotation: 0 }), { ...second, solution: { ...second.solution, CTYPE1: 'RA---SIN' } }, m.observer)).toMatchObject({ accepted: false, reason: 'badWcs' })
	})
})

describe('refinement', () => {
	test('follows adjustments of the base with signed errors', () => {
		for (const latitude of [deg(40), deg(-30)]) {
			const m = mount({ latitude, azimuthError: arcmin(30), altitudeError: arcmin(-20), refraction: DEFAULT_REFRACTION_PARAMETERS })
			const calibration = calibrated(m)
			let previous: IPolarAcceptedMeasurement | undefined
			for (const [i, base] of [
				{ azimuth: arcmin(-10), altitude: 0 },
				{ azimuth: arcmin(-30), altitude: arcmin(10) },
				{ azimuth: arcmin(-30), altitude: arcmin(20) },
				{ azimuth: arcmin(-29.5), altitude: arcmin(20.2) },
			].entries()) {
				const measurement = accepted(measureIPolar(calibration, m.frame({ rotation: deg(30) + SIDEREAL_RATE * 120 * (i + 1), seconds: 120 * (i + 1), base }), previous))
				expect(toArcsec(Math.abs(measurement.error.azimuth - (arcmin(30) + base.azimuth)))).toBeLessThan(2)
				expect(toArcsec(Math.abs(measurement.error.altitude - (arcmin(-20) + base.altitude)))).toBeLessThan(2)
				previous = measurement
			}
			expect(toArcsec(previous!.error.total)).toBeLessThan(40)
		}
	})

	test('places the axis and pole markers on the frame', () => {
		const m = mount({ latitude: deg(40), azimuthError: arcmin(4), altitudeError: arcmin(3), offset: arcmin(10) })
		const pose = { rotation: deg(30), seconds: 60 }
		const measurement = accepted(measureIPolar(calibrated(m), m.frame(pose)))
		expect(measurement.axisPoint.kind).toBe('visible')
		expect(measurement.polePoint.kind).toBe('visible')
		const axis = m.pixelOf(m.axis, pose)
		const pole = m.pixelOf(m.target, pose)
		if (measurement.axisPoint.kind !== 'visible' || measurement.polePoint.kind !== 'visible') throw new Error('not visible')
		expect(Math.hypot(measurement.axisPoint.position.x - axis.x, measurement.axisPoint.position.y - axis.y)).toBeLessThan(0.3)
		expect(Math.hypot(measurement.polePoint.position.x - pole.x, measurement.polePoint.position.y - pole.y)).toBeLessThan(0.3)
	})

	test('reports markers off the frame and behind it, never at the center', () => {
		const far = mount({ latitude: deg(40), azimuthError: arcmin(4), offset: deg(30) })
		const offscreen = accepted(measureIPolar(calibrated(far), far.frame({ rotation: deg(30), seconds: 60 })))
		expect(offscreen.polePoint.kind).toBe('offscreen')
		if (offscreen.polePoint.kind !== 'offscreen') throw new Error('not offscreen')
		const expected = far.pixelOf(far.target, { rotation: deg(30), seconds: 60 })
		expect(Math.hypot(offscreen.polePoint.position.x - expected.x, offscreen.polePoint.position.y - expected.y)).toBeLessThan(2)
		expect(Math.hypot(offscreen.polePoint.direction.x, offscreen.polePoint.direction.y)).toBeCloseTo(1, 12)
		const behind = mount({ latitude: deg(40), azimuthError: arcmin(4), offset: deg(100) })
		const unprojectable = accepted(measureIPolar(calibrated(behind), behind.frame({ rotation: deg(30), seconds: 60 })))
		expect(unprojectable.polePoint).toEqual({ kind: 'unprojectable' })
		expect(unprojectable.axisPoint).toEqual({ kind: 'unprojectable' })
	})

	test('invalidates the calibration after a change of geometry or a slew', () => {
		const m = mount({ latitude: deg(40), azimuthError: arcmin(10) })
		const calibration = calibrated(m)
		const first = accepted(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 120 })))
		expect(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 180, sensor: { x: 16 } }), first)).toMatchObject({ valid: false, reason: 'geometryMismatch', invalidatesCalibration: true })
		expect(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 180, declination: deg(4) }), first)).toMatchObject({ valid: false, invalidatesCalibration: true })
		expect(measureIPolar(calibration, m.frame({ rotation: deg(30), seconds: 180, declination: deg(4) }), first)).toMatchObject({ reason: 'geometryMismatch' })
		const slewed = mount({ latitude: deg(40), azimuthError: arcmin(10), offset: deg(30) })
		const slewedCalibration = calibrated(slewed)
		const start = accepted(measureIPolar(slewedCalibration, slewed.frame({ rotation: deg(30), seconds: 120 })))
		expect(measureIPolar(slewedCalibration, slewed.frame({ rotation: deg(50), seconds: 180 }), start)).toMatchObject({ valid: false, reason: 'fieldJump', invalidatesCalibration: true })
		expect(measureIPolar(calibration, { ...m.frame({ rotation: deg(30), seconds: 180 }), solution: { ...m.frame({ rotation: deg(30), seconds: 180 }).solution, CTYPE1: 'RA---SIN' } }, first)).toMatchObject({ valid: false, reason: 'badWcs', invalidatesCalibration: false })
	})

	test('does not mutate the calibration', () => {
		const m = mount({ latitude: deg(-30), azimuthError: arcmin(5) })
		const calibration = calibrated(m)
		const copy = structuredClone(calibration)
		measureIPolar(calibration, m.frame({ rotation: deg(10), seconds: 200, base: { azimuth: arcmin(1), altitude: 0 } }))
		expect(calibration).toEqual(copy)
	})
})

describe('noise', () => {
	test('keeps the axis error within the expected bound', () => {
		const sigma = arcsec(1)
		const random = splitmix32(42)
		const noise = normal(random, 0, sigma)
		const m = mount({ latitude: deg(40), azimuthError: arcmin(12), altitudeError: arcmin(-8) })
		const rotation = deg(30)
		const errors: number[] = []
		for (let i = 0; i < 40; i++) {
			const result = calibrateIPolar(m.frame({ rotation: 0, noise }), m.frame({ rotation, seconds: 60, noise }), m.observer)
			if (!result.accepted) throw new Error(result.reason)
			errors.push(vecAngle(result.calibration.axis, m.axis))
		}
		errors.sort((a, b) => a - b)
		const p95 = errors[Math.floor(errors.length * 0.95) - 1]
		expect(p95).toBeLessThan((3 * sigma) / Math.sin(rotation / 2))
		expect(errors.at(-1)).toBeGreaterThan(0)
	})
})

describe('convergence', () => {
	const m = mount({ latitude: deg(40), azimuthError: arcsec(10) })
	const calibration = calibrated(m)
	const at = (seconds: number, azimuth: number = 0) => measureIPolar(calibration, m.frame({ rotation: deg(30), seconds, base: { azimuth, altitude: 0 } }))

	test('needs consecutive fresh measurements within the threshold and can regress', () => {
		let state = IPOLAR_CONVERGENCE_START
		state = advanceIPolarConvergence(state, at(100))
		state = advanceIPolarConvergence(state, at(110))
		expect(state).toMatchObject({ streak: 2, converged: false })
		state = advanceIPolarConvergence(state, at(120))
		expect(state).toMatchObject({ streak: 3, converged: true })
		state = advanceIPolarConvergence(state, at(130, arcmin(2)))
		expect(state).toMatchObject({ streak: 0, converged: false })
		state = advanceIPolarConvergence(advanceIPolarConvergence(advanceIPolarConvergence(state, at(140)), at(150)), at(160))
		expect(state.converged).toBeTrue()
		state = advanceIPolarConvergence(state, { valid: false, time: m.frame({ rotation: 0, seconds: 170 }).time, reason: 'badWcs', invalidatesCalibration: false })
		expect(state).toEqual(IPOLAR_CONVERGENCE_START)
		state = advanceIPolarConvergence(advanceIPolarConvergence(state, at(200)), at(200 + DEFAULT_IPOLAR_CONVERGENCE.maximumInterval + 1))
		expect(state).toMatchObject({ streak: 1, converged: false })
	})
})
