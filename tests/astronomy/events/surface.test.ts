import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { bodyFixedFrame, MOON_ROTATION } from '../../../src/astronomy/bodies/orientation'
import { frameToBase, ICRS, type Frame } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { bodyRadii, SpiceFrames } from '../../../src/astronomy/ephemeris/kernels/frame.kernel'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readPck } from '../../../src/astronomy/ephemeris/kernels/pck'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { readTextKernel, SpiceKernelPool } from '../../../src/astronomy/ephemeris/kernels/text.kernel'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { bodySurfaceSolarAltitude, bodySurfaceSunEvents, surfaceFeature, surfaceFeatureIllumination, surfaceFeatureWindows } from '../../../src/astronomy/events/surface'
import { bodyShape, bodySurfaceLocation, bodySurfaceNormal } from '../../../src/astronomy/observer/body'
import { type Time, time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI, PIOVERFOUR, PIOVERTWO, SUN_RADIUS_AU, TAU } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { matRotZ } from '../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecMinus, vecPlus, vecXAxis } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'
import { expectNumberArrayToBeCloseTo } from '../../util'

await downloadPerTag('frame.kernel')

const EPOCH = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const SPHERE = bodyShape([1, 1, 1])
const SOLAR = () => vecXAxis()
const ROTATING: Frame = { rotationAt: (time) => matRotZ(TAU * timeSubtract(time, EPOCH)) }

test('sphere equator, poles, near poles and longitude wrap have analytic solar altitudes', () => {
	for (const longitude of [0, TAU, -TAU]) {
		const location = bodySurfaceLocation(longitude, 0, 0, SPHERE, ICRS)
		expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(PIOVERTWO, 12)
	}
	for (const latitude of [PIOVERTWO, -PIOVERTWO, PIOVERTWO - 1e-7]) {
		const location = bodySurfaceLocation(0, latitude, 0, SPHERE, ICRS)
		expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(PIOVERTWO - Math.abs(latitude), 12)
	}
	const equator = bodySurfaceLocation(PIOVERTWO, 0, 0, SPHERE, ICRS)
	expect(bodySurfaceSolarAltitude(equator, SOLAR, EPOCH)).toBeCloseTo(0, 12)
})

test('tri-axial local vertical follows the ellipsoid gradient rather than the radial direction', () => {
	const location = bodySurfaceLocation(PIOVERFOUR, 0, 10, bodyShape([2, 1, 0.5]), ICRS)
	const out: MutVec3 = [0, 0, 0]
	expect(bodySurfaceNormal(location, out)).toBe(out)
	expect(out[0]).toBeCloseTo(1 / Math.sqrt(17), 12)
	expect(out[1]).toBeCloseTo(4 / Math.sqrt(17), 12)
	expect(out[2]).toBeCloseTo(0, 12)
	expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(Math.asin(1 / Math.sqrt(17)), 12)
	const small = bodySurfaceLocation(PIOVERFOUR, 0, 0, bodyShape([2e-150, 1e-150, 0.5e-150]), ICRS)
	expect(bodySurfaceNormal(small)[0]).toBeCloseTo(out[0], 12)
})

test('rotating surface produces chronological sunset and sunrise, including initial daylight', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING)
	const events = bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 1), { step: 0.1, tolerance: 1e-8 })
	expect(events.map((event) => event.kind)).toEqual(['sunset', 'sunrise'])
	expect(timeSubtract(events[0].time, EPOCH)).toBeCloseTo(0.25, 7)
	expect(timeSubtract(events[1].time, EPOCH)).toBeCloseTo(0.75, 7)
	for (const event of events) expect(event.altitude).toBeCloseTo(0, 7)
	expect(bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 0.1))).toEqual([])
	const raised = bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 1), { horizon: deg(30), step: 0.1 })
	expect(timeSubtract(raised[0].time, EPOCH)).toBeCloseTo(1 / 6, 6)
	expect(timeSubtract(raised[1].time, EPOCH)).toBeCloseTo(5 / 6, 6)
})

test('body frame orientation is evaluated at each epoch without mutating the provider', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING)
	const shared: MutVec3 = [1, 0, 0]
	const time = timeShift(EPOCH, 0.1)
	const solar = () => frameToBase([1, 0, 0], ROTATING, time, shared)
	const expected = solar()
	expect(bodySurfaceSolarAltitude(location, solar, time)).toBeCloseTo(PIOVERTWO, 7)
	expect(shared).toEqual(expected)
})

test('Copernicus sunrise/set agrees with independent SPICE reference-surface illumination', () => {
	// SPICE/spiceypy 8.0.0, NAIF pck00011.tpc IAU_MOON, Skyfield 1.55 DE421 geometric
	// body-center Sun directions; no light time, no solar disk/refraction/terrain. Offsets are TT
	// days from 2020-01-01. A 0.002-day tolerance covers VSOP/ELP vs DE421 and the omitted
	// quadratic prime-meridian term of MOON_ROTATION. Copernicus: 20.08 W, 9.62 N.
	const radius = kilometer(1737.4)
	const location = bodySurfaceLocation(deg(-20.08), deg(9.62), 0, bodyShape([radius, radius, radius]), bodyFixedFrame(MOON_ROTATION))
	const solar = (time: Time) => vecMinus(vecMinus(sun(time)[0], earth(time)[0]), moon(time)[0])
	const events = bodySurfaceSunEvents(location, solar, EPOCH, timeShift(EPOCH, 32), { step: 0.5 })
	expect(events.map((event) => event.kind)).toEqual(['sunrise', 'sunset'])
	expect(Math.abs(timeSubtract(events[0].time, EPOCH) - 3.673623231)).toBeLessThan(0.002)
	expect(Math.abs(timeSubtract(events[1].time, EPOCH) - 18.491828933)).toBeLessThan(0.002)
})

// Far-away targets keep surface parallax below 1e-9 rad for the analytic unit-sphere cases.
const FAR = 1e9

// Window boundaries as day offsets from origin.
function windowOffsets(windows: readonly { readonly start: Time; readonly end: Time }[], origin: Time) {
	return windows.flatMap((window) => [timeSubtract(window.start, origin), timeSubtract(window.end, origin)])
}

test('feature horizon angles, phase, and observer parallax on a sphere', () => {
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, 0, SPHERE, ICRS))
	const sunAt = () => [FAR, 0, FAR] as const
	// Observer at 60 radii along +Y, like the Earth from the Moon: parallax drops it below the horizon.
	const observerAt = () => [0, 60, 0] as const
	const result = surfaceFeatureIllumination(feature, sunAt, observerAt, EPOCH)
	expect(result.solarAltitude).toBeCloseTo(PIOVERFOUR, 8)
	expect(result.solarAzimuth).toBeCloseTo(0, 9)
	expect(result.incidence).toBeCloseTo(PIOVERFOUR, 8)
	expect(result.observerAltitude).toBeCloseTo(Math.atan2(-1, 60), 12)
	expect(result.observerAzimuth).toBeCloseTo(PIOVERTWO, 12)
	expect(result.emission).toBeCloseTo(PIOVERTWO + Math.atan2(1, 60), 12)
	expect(result.phase).toBeCloseTo(Math.acos(-1 / (Math.SQRT2 * Math.sqrt(3601))), 9)
	expect(result.solarAngularRadius).toBeCloseTo(SUN_RADIUS_AU / (Math.SQRT2 * FAR), 15)
	expect(result.terminatorDistance).toBeCloseTo(PIOVERFOUR, 8)
	expect(result.solarHorizon).toBe(0)
	expect(result.observerHorizon).toBe(0)
	expect(result.sunlit).toBeTrue()
	expect(result.visible).toBeFalse()
})

test('feature azimuth is north through east, wraps below TAU, and follows the meridian limit at a pole', () => {
	const equator = surfaceFeature(bodySurfaceLocation(0, 0, 0, SPHERE, ICRS))
	const observerAt = () => [FAR, 0, 0] as const
	const west = surfaceFeatureIllumination(equator, () => [FAR, -1e-3 * FAR, FAR], observerAt, EPOCH)
	expect(west.solarAzimuth).toBeCloseTo(TAU - Math.atan(1e-3), 9)
	expect(west.solarAzimuth).toBeLessThan(TAU)
	expect(surfaceFeatureIllumination(equator, () => [FAR, FAR, 0], observerAt, EPOCH).solarAzimuth).toBeCloseTo(PIOVERTWO, 9)
	expect(surfaceFeatureIllumination(equator, () => [FAR, 0, -FAR], observerAt, EPOCH).solarAzimuth).toBeCloseTo(PI, 9)

	for (const longitude of [0, TAU, -TAU]) {
		const pole = surfaceFeature(bodySurfaceLocation(longitude, PIOVERTWO, 0, SPHERE, ICRS))
		expectNumberArrayToBeCloseTo(pole.up, [0, 0, 1], 15)
		expectNumberArrayToBeCloseTo(pole.north, [-1, 0, 0], 15)
		expectNumberArrayToBeCloseTo(pole.east, [0, 1, 0], 15)
		const toward = surfaceFeatureIllumination(
			pole,
			() => [-FAR, 0, 0],
			() => [0, FAR, 0],
			EPOCH,
		)
		expect(toward.solarAzimuth).toBeCloseTo(0, 9)
		expect(toward.solarAltitude).toBeCloseTo(-1 / FAR, 15)
		expect(toward.observerAzimuth).toBeCloseTo(PIOVERTWO, 9)
		expect(Number.isFinite(toward.phase)).toBeTrue()
	}

	const south = surfaceFeature(bodySurfaceLocation(PIOVERTWO, -PIOVERTWO, 0, SPHERE, ICRS))
	expectNumberArrayToBeCloseTo(south.up, [0, 0, -1], 15)
	expectNumberArrayToBeCloseTo(south.east, [-1, 0, 0], 15)
	expectNumberArrayToBeCloseTo(south.north, [0, 1, 0], 15)
})

test('tilted facets change incidence and self-shadowing but not the reference horizon', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ICRS)
	// Sun 10 degrees above the eastern horizon.
	const sunAt = () => [FAR * Math.sin(deg(10)), FAR * Math.cos(deg(10)), 0] as const
	const observerAt = () => [FAR, 0, 0] as const
	const eastFacing = surfaceFeatureIllumination(surfaceFeature(location, { slope: deg(30), aspect: deg(90) }), sunAt, observerAt, EPOCH)
	const westFacing = surfaceFeatureIllumination(surfaceFeature(location, { slope: deg(30), aspect: deg(270) }), sunAt, observerAt, EPOCH)
	expect(toDeg(eastFacing.solarAltitude)).toBeCloseTo(10, 6)
	expect(toDeg(eastFacing.incidence)).toBeCloseTo(50, 6)
	expect(toDeg(eastFacing.emission)).toBeCloseTo(30, 7)
	expect(eastFacing.sunlit).toBeTrue()
	expect(toDeg(westFacing.solarAltitude)).toBeCloseTo(10, 6)
	expect(toDeg(westFacing.incidence)).toBeCloseTo(110, 6)
	expect(westFacing.sunlit).toBeFalse()
	expect(westFacing.visible).toBeTrue()
})

test('terrain horizon mask occludes a low Sun and narrows rotating windows', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING)
	const sunAt = () => [FAR, 0, 0] as const
	const smooth = surfaceFeature(location)
	const masked = surfaceFeature(location, { horizon: [{ azimuth: 0, minimumAltitude: deg(15) }] })

	// The Sun is 10 degrees high in the west at 2/9 day.
	const low = timeShift(EPOCH, 80 / 360)
	expect(surfaceFeatureIllumination(smooth, sunAt, sunAt, low).sunlit).toBeTrue()
	const occluded = surfaceFeatureIllumination(masked, sunAt, sunAt, low)
	expect(toDeg(occluded.solarAltitude)).toBeCloseTo(10, 6)
	expect(toDeg(occluded.solarAzimuth)).toBeCloseTo(270, 6)
	expect(toDeg(occluded.solarHorizon)).toBeCloseTo(15, 12)
	expect(occluded.sunlit).toBeFalse()

	const stop = timeShift(EPOCH, 1)
	const day = surfaceFeatureWindows(smooth, sunAt, undefined, EPOCH, stop, { step: 0.05, tolerance: 1e-9 })
	expectNumberArrayToBeCloseTo(windowOffsets(day, EPOCH), [0, 0.25, 0.75, 1], 7)
	const terrain = surfaceFeatureWindows(masked, sunAt, undefined, EPOCH, stop, { step: 0.05, tolerance: 1e-9 })
	expectNumberArrayToBeCloseTo(windowOffsets(terrain, EPOCH), [0, 75 / 360, 285 / 360, 1], 7)
	const grazing = surfaceFeatureWindows(smooth, sunAt, undefined, EPOCH, stop, { minSolarAltitude: deg(10), maxSolarAltitude: deg(30), step: 0.02, tolerance: 1e-9 })
	expectNumberArrayToBeCloseTo(windowOffsets(grazing, EPOCH), [60 / 360, 80 / 360, 280 / 360, 300 / 360], 7)
})

test('no window exists when the observer only sees the feature at night', () => {
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING))
	const sunAt = () => [FAR, 0, 0] as const
	const observerAt = () => [-FAR, 0, 0] as const
	const stop = timeShift(EPOCH, 2)
	expect(surfaceFeatureWindows(feature, sunAt, observerAt, EPOCH, stop, { step: 0.05 })).toEqual([])
	const night = surfaceFeatureWindows(feature, sunAt, observerAt, EPOCH, stop, { minSolarAltitude: -PIOVERTWO, maxIncidence: PI, step: 0.05, tolerance: 1e-9 })
	expectNumberArrayToBeCloseTo(windowOffsets(night, EPOCH), [0.25, 0.75, 1.25, 1.75], 7)
})

// Loads DE421 with the lunar FK/PCK and returns geometric Moon-center-to-Sun and Moon-center-to-Earth
// providers in ICRS axes, plus the MOON_ME_DE421 frame and IAU Moon radii.
async function lunarGeometry() {
	const pool = new SpiceKernelPool()
	await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
	pool.load(await readTextKernel(fk))
	await using tpc = fileHandleSource(await fs.open('data/pck00008.tpc'))
	pool.load(await readTextKernel(tpc))
	const bpc = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(bpc))
	await pck.initialize()
	const bsp = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(bsp))
	const solar = (await spk.segment(Naif.SSB, Naif.SUN))!
	const emb = (await spk.segment(Naif.SSB, Naif.EMB))!
	const moonFromEmb = (await spk.segment(Naif.EMB, Naif.MOON))!
	const earthFromEmb = (await spk.segment(Naif.EMB, Naif.EARTH))!

	return {
		frame: await new SpiceFrames(pool, pck).frame('MOON_ME_DE421'),
		shape: bodyShape(bodyRadii(pool, Naif.MOON)!),
		sunAt: (t: Time): Vec3 => vecMinus(solar.at(t)[0], vecPlus(emb.at(t)[0], moonFromEmb.at(t)[0])),
		earthAt: (t: Time): Vec3 => vecMinus(earthFromEmb.at(t)[0], moonFromEmb.at(t)[0]),
		async [Symbol.asyncDispose]() {
			await bpc.close()
			await bsp.close()
		},
	}
}

// SPICE N0067 via spiceypy 8.0.0 with de421.bsp, moon_pa_de421_1900-2050.bpc, moon_080317.tf and
// pck00008.tpc: ilumin/azlcpo/gfilum, method ELLIPSOID, fixref MOON_ME, abcorr NONE, observer EARTH,
// planetocentric surface points on the 1737.4 km sphere. Offsets are TDB days from 2024-01-15 00:00.
const LUNAR_T0 = time(2460324, 0.5, Timescale.TDB)

// Planetocentric east longitude and latitude, degrees.
const LUNAR_FEATURES = {
	copernicus: [-20.08, 9.62],
	grimaldi: [-68.6, -5.2],
	tsiolkovskiy: [129.1, -20.4],
	shackleton: [129.78, -89.67],
} as const

// [offset, phase, incidence, emission, Sun azimuth, Sun elevation, Earth azimuth, Earth elevation], degrees.
const SPICE_ILLUMINATION = {
	copernicus: [
		[0, 131.45058389945984, 152.71064535950745, 22.898844057047874, 74.31557615465991, -62.71064535950747, 102.87410634854459, 67.10115594295212],
		[4.25, 76.08498009823302, 102.17418637758912, 28.60467208547695, 89.48079064786154, -12.174186377589125, 114.04905387139338, 61.39532791452306],
		[10.5, 5.597058653528526, 28.400311328177107, 28.487840685297616, 111.7353037071884, 61.5996886718229, 123.50097272396613, 61.51215931470238],
	],
	grimaldi: [
		[0, 131.29350867876778, 156.72163500022847, 71.53190198876239, 253.83652995055368, -66.72163500022846, 84.03208070193172, 18.468098011237633],
		[4.25, 75.94709112747486, 149.88455680596783, 74.45519791749047, 102.11894008669698, -59.884556805967854, 91.19722653471058, 15.544802082509545],
		[10.5, 5.462135416581627, 74.67639927992307, 71.8362050735632, 90.16122893747715, 15.323600720076946, 95.0341948247136, 18.163794926436793],
	],
	tsiolkovskiy: [
		[0, 131.75406328944115, 19.423239218844838, 126.08952880561189, 13.999754310047278, 70.57676078115516, 259.7407813833106, -36.0895288056119],
		[4.25, 76.40473128242812, 49.67179471725457, 120.16236921086735, 286.17762412848884, 40.32820528274544, 254.3842852737876, -30.16236921086734],
		[10.5, 5.59408826132356, 120.02240753695105, 120.50745343050829, 255.65564055696768, -30.02240753695106, 249.2022703948565, -30.507453430508296],
	],
	shackleton: [
		[0, 131.54556111951572, 88.16389777924026, 94.42844504112989, 3.936540416469634, 1.836102220759766, 232.40284580837988, -4.428445041129917],
		[4.25, 76.2041957123239, 88.26002137035324, 87.88527119162073, 312.2238546072663, 1.7399786296467556, 235.9695677969023, 2.1147288083792843],
		[10.5, 5.372646214330198, 88.65604259349013, 84.03949967294375, 236.3625252562288, 1.343957406509877, 233.60793038302964, 5.96050032705626],
	],
} as const

// Prepares a named lunar feature on the reference sphere in MOON_ME_DE421.
function lunarFeature(lunar: Awaited<ReturnType<typeof lunarGeometry>>, name: keyof typeof LUNAR_FEATURES) {
	const [longitude, latitude] = LUNAR_FEATURES[name]
	return surfaceFeature(bodySurfaceLocation(deg(longitude), deg(latitude), 0, lunar.shape, lunar.frame))
}

test('lunar feature illumination matches SPICE ilumin and azlcpo at equator, limb, farside and pole', async () => {
	await using lunar = await lunarGeometry()

	for (const name of Object.keys(SPICE_ILLUMINATION) as (keyof typeof SPICE_ILLUMINATION)[]) {
		const feature = lunarFeature(lunar, name)

		for (const [offset, phase, incidence, emission, sunAz, sunEl, earthAz, earthEl] of SPICE_ILLUMINATION[name]) {
			const result = surfaceFeatureIllumination(feature, lunar.sunAt, lunar.earthAt, timeShift(LUNAR_T0, offset))
			expect(toDeg(result.phase)).toBeCloseTo(phase, 7)
			expect(toDeg(result.incidence)).toBeCloseTo(incidence, 7)
			expect(toDeg(result.emission)).toBeCloseTo(emission, 7)
			expect(toDeg(result.solarAzimuth)).toBeCloseTo(sunAz, 6)
			expect(toDeg(result.solarAltitude)).toBeCloseTo(sunEl, 7)
			expect(toDeg(result.observerAzimuth)).toBeCloseTo(earthAz, 6)
			expect(toDeg(result.observerAltitude)).toBeCloseTo(earthEl, 7)
			expect(result.sunlit).toBe(sunEl > 0)
			expect(result.visible).toBe(earthEl > 0)
			expect(result.terminatorDistance).toBeCloseTo(kilometer(1737.4) * deg(sunEl), 14)
		}
	}
})

test('lunar grazing, libration and polar windows match SPICE gfilum', async () => {
	await using lunar = await lunarGeometry()
	const stop = timeShift(LUNAR_T0, 32)
	const anySun = { minSolarAltitude: -PIOVERTWO, maxIncidence: PI }

	// Copernicus: incidence in [80, 88] degrees is solar altitude in [2, 10] degrees.
	const copernicus = lunarFeature(lunar, 'copernicus')
	const grazing = surfaceFeatureWindows(copernicus, lunar.sunAt, undefined, LUNAR_T0, stop, { minSolarAltitude: deg(2), maxSolarAltitude: deg(10), step: 0.25 })
	expectNumberArrayToBeCloseTo(windowOffsets(grazing, LUNAR_T0), [5.433650424238294, 6.102589305955917, 19.215685967355967, 19.883335835300386], 5)
	const daylight = surfaceFeatureWindows(copernicus, lunar.sunAt, lunar.earthAt, LUNAR_T0, stop, { step: 0.25 })
	expectNumberArrayToBeCloseTo(windowOffsets(daylight, LUNAR_T0), [5.266544258221984, 20.05011729709804], 5)

	// Grimaldi near the western limb: libration moves emission across 72 degrees.
	const grimaldi = surfaceFeatureWindows(lunarFeature(lunar, 'grimaldi'), lunar.sunAt, lunar.earthAt, LUNAR_T0, stop, { ...anySun, maxEmission: deg(72), step: 0.25 })
	expectNumberArrayToBeCloseTo(windowOffsets(grimaldi, LUNAR_T0), [0, 0.37694862158969045, 10.311931125819683, 28.32600260572508], 5)

	// Tsiolkovskiy on the farside is never visible from the Earth.
	expect(surfaceFeatureWindows(lunarFeature(lunar, 'tsiolkovskiy'), lunar.sunAt, lunar.earthAt, LUNAR_T0, stop, { ...anySun, step: 0.25 })).toEqual([])

	// Shackleton: the Earth grazes the polar horizon as libration changes, under continuous sunlight.
	const shackleton = lunarFeature(lunar, 'shackleton')
	const earthward = surfaceFeatureWindows(shackleton, lunar.sunAt, lunar.earthAt, LUNAR_T0, stop, { ...anySun, step: 0.25 })
	expectNumberArrayToBeCloseTo(windowOffsets(earthward, LUNAR_T0), [2.8655003178864717, 16.54620767617598, 29.999566030222923, 32], 5)
	const polarDay = surfaceFeatureWindows(shackleton, lunar.sunAt, undefined, LUNAR_T0, stop, { step: 0.25 })
	expectNumberArrayToBeCloseTo(windowOffsets(polarDay, LUNAR_T0), [0, 32], 9)
})
