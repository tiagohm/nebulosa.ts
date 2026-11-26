import { describe, expect, test } from 'bun:test'
import { applyPolarAxisRotation, polarAxisRotation, tubePositionAngle } from '../../../../src/astronomy/coordinates/pointing'
import { timeUnix } from '../../../../src/astronomy/time/time'
import { PI } from '../../../../src/core/constants'
import { type CameraSimulatorConfig, cameraSimulatorConfig } from '../../../../src/devices/indi/simulator/camera.config'
import { CameraNoise } from '../../../../src/devices/indi/simulator/camera.noise'
import { CameraOptics, cameraPixelScale } from '../../../../src/devices/indi/simulator/camera.optics'
import { encodeCameraFrame } from '../../../../src/devices/indi/simulator/camera.output'
import { CameraPsf } from '../../../../src/devices/indi/simulator/camera.psf'
import { CameraReadout } from '../../../../src/devices/indi/simulator/camera.readout'
import { type CameraFrameInput, clipSegment, projectFrameStars, renderCameraFrame } from '../../../../src/devices/indi/simulator/camera.renderer'
import { CameraSensor } from '../../../../src/devices/indi/simulator/camera.sensor'
import { type ExposureTrail, type TrailVertex, trailVertexInJ2000 } from '../../../../src/devices/indi/simulator/camera.trail'
import type { CatalogSourceStar } from '../../../../src/devices/indi/simulator/types'
import { analyzeBahtinov } from '../../../../src/imaging/analysis/bahtinov/bahtinov'
import { bahtinovAxialAngleDistance } from '../../../../src/imaging/analysis/bahtinov/geometry'
import { createBahtinovWorkspace, resolveBahtinovArea } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { BahtinovAnalysisInput, BahtinovAnalysisOptions } from '../../../../src/imaging/analysis/bahtinov/types'
import { readImageFromBuffer } from '../../../../src/imaging/model/image'
import type { Image, ImageRawType } from '../../../../src/imaging/model/types'
import { type Angle, deg, hour } from '../../../../src/math/units/angle'
import { TestBus } from '../../../util/bus'

// Unit coverage of the camera's image formation: where the sky lands on the sensor, how a trail
// carries the light of a star, and the annular and Bahtinov star models, on a noise-free sensor.

const CENTER = [hour(5), deg(20)] as const

// A camera without background or electronics noise, so only the stars reach the frame.
const QUIET = cameraSimulatorConfig({
	noise: {
		sky: { enabled: false },
		moon: { enabled: false },
		lightPollution: { enabled: false },
		sensor: { readNoise: 0, biasElectrons: 0, blackLevelElectrons: 0, darkCurrentAtReferenceTemp: 0, darkSignalNonUniformity: 0, ampGlow: { enabled: false } },
		artifacts: { fixedPatternNoiseStrength: 0, rowNoiseStrength: 0, columnNoiseStrength: 0, bandingStrength: 0, hotPixelRate: 0, warmPixelRate: 0, deadPixelRate: 0 },
		output: { clampMode: 'none' },
	},
})

// Settings of a frame, given as the commands a client would send.
interface FrameSetup {
	readonly config?: CameraSimulatorConfig
	readonly frame?: readonly [number, number, number, number]
	readonly bin?: readonly [number, number]
	readonly psf?: Record<string, Record<string, number | boolean>>
	readonly optics?: Record<string, Record<string, number | boolean>>
	readonly focusPosition?: number
	readonly seeing?: number
	readonly gain?: number
	readonly exposureTime?: number
	readonly rotation?: Angle
}

// Builds the input of a frame through the real circuits, as the camera does when its shutter closes.
function frameInput(setup: FrameSetup = {}): CameraFrameInput {
	const config = setup.config ?? QUIET
	const bus = new TestBus()
	const sensor = new CameraSensor(bus, config.sensor)
	const readout = new CameraReadout(bus, sensor, config.readout)
	const optics = new CameraOptics(bus, config.optics)
	const psf = new CameraPsf(bus, config.psf)
	const noise = new CameraNoise(bus, config.noise, config.shutter.minExposure, config.shutter.maxExposure)

	if (setup.frame) readout.setFrame(...setup.frame)
	if (setup.bin) readout.setBin(...setup.bin)
	if (setup.gain !== undefined) readout.handleNumber({ device: '', name: 'CCD_GAIN', elements: { GAIN: setup.gain } })

	for (const [name, elements] of Object.entries(setup.psf ?? {})) {
		const numbers = Object.fromEntries(Object.entries(elements).filter(([, value]) => typeof value === 'number')) as Record<string, number>
		const switches = Object.fromEntries(Object.entries(elements).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
		psf.handleNumber({ device: '', name, elements: numbers })
		psf.handleSwitch({ device: '', name, elements: switches })
	}

	for (const [name, elements] of Object.entries(setup.optics ?? {})) {
		const numbers = Object.fromEntries(Object.entries(elements).filter(([, value]) => typeof value === 'number')) as Record<string, number>
		const switches = Object.fromEntries(Object.entries(elements).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
		optics.handleNumber({ device: '', name, elements: numbers })
		optics.handleSwitch({ device: '', name, elements: switches })
	}

	const readoutState = readout.snapshot()
	const opticsState = optics.snapshot()
	const exposureTime = setup.exposureTime ?? 0.05
	const exposureScale = exposureTime / noise.referenceExposure

	return {
		sensorWidth: sensor.width,
		sensorHeight: sensor.height,
		readout: readoutState,
		optics: opticsState,
		psf: psf.snapshot(),
		seeing: setup.seeing ?? 0,
		pixelScale: cameraPixelScale(sensor.pixelSize, opticsState.focalLength),
		rotation: setup.rotation ?? 0,
		focusPosition: setup.focusPosition ?? opticsState.bestFocus,
		fluxScale: (1 + readoutState.gain / 100) * exposureScale,
		snrScale: Math.sqrt(Math.max(exposureScale, 0.01)),
		noise: noise.configFor({ frameType: 'LIGHT', exposureTime, temperature: 0, gain: readoutState.gain, offset: 0, seed: 1 }),
	}
}

// Trail of a field standing still at `vertex`.
function still(vertex: TrailVertex): ExposureTrail {
	return { vertices: [vertex], reference: vertex, extent: 0 }
}

// A star at (`rightAscension`, `declination`), J2000 radians.
function star(rightAscension: Angle, declination: Angle, flux: number = 1000, snr: number = 100): CatalogSourceStar {
	return { rightAscension, declination, flux, hfd: 2, snr }
}

const CENTERED = still({ rightAscension: CENTER[0], declination: CENTER[1], positionAngle: 0 })

describe('camera renderer', () => {
	test('puts the boresight at the sensor centre with east towards -x and north towards -y', () => {
		const input = frameInput()
		const offset = 10 * input.pixelScale
		const [atCenter, east, north] = projectFrameStars(input, [star(CENTER[0], CENTER[1]), star(CENTER[0] + offset / Math.cos(CENTER[1]), CENTER[1]), star(CENTER[0], CENTER[1] + offset)], CENTERED, 0.5, 64)

		expect(atCenter.x).toBeCloseTo(639.5, 9)
		expect(atCenter.y).toBeCloseTo(511.5, 9)
		expect(east.x).toBeCloseTo(629.5, 3)
		expect(east.y).toBeCloseTo(511.5, 3)
		expect(north.x).toBeCloseTo(639.5, 3)
		expect(north.y).toBeCloseTo(501.5, 3)
	})

	test('turns the sensor by the position angle and the rotation, then crops and bins', () => {
		const input = frameInput({ frame: [600, 400, 200, 200], bin: [2, 1], rotation: deg(60) })
		const offset = 10 * input.pixelScale
		const trail = still({ rightAscension: CENTER[0], declination: CENTER[1], positionAngle: deg(30) })
		const [north] = projectFrameStars(input, [star(CENTER[0], CENTER[1] + offset)], trail, 0.5, 64)

		// Turned by 30° + 60°, north goes from -y to +x.
		const sensorX = 639.5 + 10 * Math.sin(deg(90))
		const sensorY = 511.5 - 10 * Math.cos(deg(90))
		expect(north.x).toBeCloseTo((sensorX - 600) / 2, 3)
		expect(north.y).toBeCloseTo(sensorY - 400, 3)
		expect(north.scaleX).toBe(0.5)
	})

	test('spreads the light of a star along its trail without creating any', () => {
		const input = frameInput()
		const from = { rightAscension: CENTER[0], declination: CENTER[1], positionAngle: 0 }
		const to = { rightAscension: CENTER[0] + (20 * input.pixelScale) / Math.cos(CENTER[1]), declination: CENTER[1], positionAngle: 0 }
		const trail: ExposureTrail = { vertices: [from, to, from], reference: to, extent: 20 * input.pixelScale }
		const points = projectFrameStars(input, [star(CENTER[0], CENTER[1])], trail, 0.5, 16384)
		const [single] = projectFrameStars(input, [star(CENTER[0], CENTER[1])], CENTERED, 0.5, 64)

		// Two stretches of about 20 px, a point every half pixel or a little less.
		expect(points.length).toBeGreaterThanOrEqual(80)
		expect(points.length).toBeLessThanOrEqual(82)
		expect(points.reduce((total, point) => total + point.flux, 0)).toBeCloseTo(single.flux, 9)
		const xs = points.map((point) => point.x)
		expect(Math.min(...xs)).toBeGreaterThan(639.5)
		expect(Math.max(...xs)).toBeCloseTo(659.5, 0)
	})

	test('draws only the part of a long trail inside the frame, as bright per pixel as the whole', () => {
		// On the equator a motion in right ascension is a great circle, so the trail is a straight line.
		const input = frameInput({ frame: [600, 480, 80, 64] })
		const from = { rightAscension: CENTER[0] - 5000 * input.pixelScale, declination: 0, positionAngle: 0 }
		const to = { rightAscension: CENTER[0] + 5000 * input.pixelScale, declination: 0, positionAngle: 0 }
		const trail: ExposureTrail = { vertices: [from, to], reference: from, extent: 0 }
		const points = projectFrameStars(input, [star(CENTER[0], 0)], trail, 0.5, 16384)
		const [single] = projectFrameStars(input, [star(CENTER[0], 0)], still({ rightAscension: CENTER[0], declination: 0, positionAngle: 0 }), 0.5, 64)

		// About a frame width of points out of twenty thousand, each with its share of a 10000 px trail.
		expect(points.length).toBeGreaterThan(150)
		expect(points.length).toBeLessThan(200)
		expect((points[0].flux * 20000) / single.flux).toBeCloseTo(1, 2)
		const capped = projectFrameStars(input, [star(CENTER[0], 0)], trail, 0.5, 10).length
		expect(capped).toBeGreaterThan(0)
		expect(capped).toBeLessThanOrEqual(10)
	})

	test('clips a segment to a rectangle', () => {
		expect(clipSegment(-10, 5, 30, 0, 0, 0, 10, 10)).toEqual([1 / 3, 2 / 3])
		expect(clipSegment(-10, 20, 30, 0, 0, 0, 10, 10)).toBeUndefined()
		expect(clipSegment(2, 2, 3, 3, 0, 0, 10, 10)).toEqual([0, 1])
	})

	test('keeps the axis of the mount fixed on the sensor as the right-ascension axis turns', () => {
		// A degree of polar misalignment, with the tube half a degree from the mount's axis: two frames
		// taken a quarter turn of the right-ascension axis apart rotate about the mount's axis, which is
		// what a camera-based polar alignment finds, and not about the celestial pole.
		const latitude = deg(-23)
		const rotation = polarAxisRotation(deg(0.6), deg(-0.8), latitude)
		const time = timeUnix(1767225600, true)
		const lst = hour(3)
		const input = frameInput({ config: cameraSimulatorConfig({ optics: { focalLength: 50 } }, QUIET) })
		const axis = applyPolarAxisRotation(lst, -PI / 2, lst, rotation)
		const frames = [hour(1), hour(7)].map((rightAscension) => {
			const boresight = applyPolarAxisRotation(rightAscension, deg(-89.5), lst, rotation)
			const positionAngle = tubePositionAngle(rightAscension, deg(-89.5), lst, false, boresight[0], boresight[1], rotation)
			return still(trailVertexInJ2000(boresight[0], boresight[1], positionAngle, time))
		})
		// The axis and the pole are projected as stars, taken into J2000 the way a catalog would hold them.
		const [axisStar, poleStar] = [axis, [0, -PI / 2] as const].map(([ra, dec]) => {
			const vertex = trailVertexInJ2000(ra, dec, 0, time)
			return star(vertex.rightAscension, vertex.declination)
		})
		const [first, second] = frames.map((trail) => projectFrameStars(input, [axisStar, poleStar], trail, 0.5, 64))

		expect(Math.hypot(first[0].x - second[0].x, first[0].y - second[0].y)).toBeLessThan(0.05)
		expect(Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y)).toBeGreaterThan(50)
	})

	test('draws a defocused star as an obstructed annulus with anisotropic binning', () => {
		const stars = [star(CENTER[0], CENTER[1])]
		const setup: FrameSetup = {
			frame: [512, 384, 256, 256],
			bin: [2, 1],
			psf: { SIMULATOR_STAR_PLOT_PSF_MODEL: { ANNULAR: true }, SIMULATOR_COLLIMATION_PATTERN: { MAX_RADIUS: 40, OBSTRUCTION_RATIO: 0.35, EDGE_SOFTNESS: 0.6, SPIDER_VANES: 4 } },
			optics: { SIMULATOR_ABERRATION_FEATURES: { COLLIMATION: true }, SIMULATOR_ABERRATION_SHAPE: { COLLIMATION: 0.5, COLLIMATION_ANGLE: 0 } },
		}
		const stride = 128
		const at = (raw: ImageRawType, x: number, y: number) => raw[y * stride + x]

		const focused = renderCameraFrame(frameInput(setup), stars, CENTERED, 0.5, 64)
		expect(at(focused, 64, 128)).toBeGreaterThan(at(focused, 80, 128))

		const defocused = renderCameraFrame(frameInput({ ...setup, focusPosition: 52000 }), stars, CENTERED, 0.5, 64)
		let maximum = 0
		for (const value of defocused) maximum = Math.max(maximum, value)
		expect(maximum).toBeGreaterThan(0)
		expect(at(defocused, 70, 128)).toBeLessThan(maximum * 0.35)
		expect(at(defocused, 64, 128)).toBeLessThan(maximum * 0.5)

		const saturated = renderCameraFrame(frameInput({ ...setup, focusPosition: 52000, seeing: 1.2, psf: { ...setup.psf, SIMULATOR_STAR_PLOT_OPTIONS: { SATURATION_LEVEL: 0.1 } } }), stars, CENTERED, 0.5, 64)
		expect(Math.max(...saturated)).toBeLessThanOrEqual(0.1)

		const disabled = renderCameraFrame(frameInput({ ...setup, focusPosition: 52000, optics: { ...setup.optics, SIMULATOR_ABERRATION_FOCUS: { BEST_FOCUS: 0 } } }), stars, CENTERED, 0.5, 64)
		expect(at(disabled, 64, 128)).toBeGreaterThan(at(disabled, 80, 128))

		// An annulus whose centre lies outside the frame still reaches into it.
		const clipped = renderCameraFrame(frameInput({ ...setup, frame: [660, 384, 256, 256], focusPosition: 52000 }), stars, CENTERED, 0.5, 64)
		expect(clipped.reduce((total, value) => total + value, 0)).toBeGreaterThan(0)
	})

	test('draws signed Bahtinov spikes on the brightest star only, with anisotropic binning', async () => {
		const stars = [star(CENTER[0], CENTER[1], 60, 300), star(CENTER[0] + deg(0.1), CENTER[1], 15, 180)]
		const setup: FrameSetup = {
			frame: [384, 384, 512, 256],
			bin: [2, 1],
			config: cameraSimulatorConfig({ noise: { exposure: { exposureTime: 0.05 } } }, QUIET),
			psf: { SIMULATOR_STAR_PLOT_PSF_MODEL: { BAHTINOV: true }, SIMULATOR_BAHTINOV_PATTERN: { FWHM: 4, HALF_LENGTH: 80, TAPER_LENGTH: 12, SPIKE_FLUX_RATIO: 3, FOCUS_STEPS_PER_PIXEL: 200 } },
		}
		const capture = async (extra: FrameSetup = {}) => {
			const input = frameInput({ ...setup, ...extra })
			const raw = renderCameraFrame(input, stars, CENTERED, 0.5, 64)
			const blob = await encodeCameraFrame(raw, { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 256, NAXIS2: 256, BZERO: 32768, BSCALE: 1 }, input.readout, 'RGGB', 'FITS')
			return (await readImageFromBuffer(blob))!
		}

		const focusedImage = await capture()
		expect(focusedImage.metadata.width).toBe(256)
		expect(focusedImage.metadata.height).toBe(256)
		const focused = analyzeCameraBahtinov(focusedImage, { x: 128, y: 128 }, 224)
		expect(focused.success).toBeTrue()

		if (focused.success) {
			const expectedExternalAngles = [Math.atan2(Math.sin(PI / 12), 2 * Math.cos(PI / 12)), Math.atan2(-Math.sin(PI / 12), 2 * Math.cos(PI / 12))]
			expect(focused.absoluteError).toBeLessThan(1)
			expect(bahtinovAxialAngleDistance(focused.centralLine.normalAngle, 0)).toBeLessThan(PI / 90)
			for (const expectedAngle of expectedExternalAngles) expect(Math.min(bahtinovAxialAngleDistance(focused.externalLines[0].normalAngle, expectedAngle), bahtinovAxialAngleDistance(focused.externalLines[1].normalAngle, expectedAngle))).toBeLessThan(PI / 90)
		}

		const dimCore = brightestPixelInArea(focusedImage.raw, 256, 0, 96, 96, 160)
		expect(dimCore.x).toBeLessThan(96)
		expect(verticalSignalOutsideCore(focusedImage.raw, 256, dimCore.x, dimCore.y, 12)).toBeLessThan(verticalSignalOutsideCore(focusedImage.raw, 256, 128, 128, 12) * 0.05)

		const positive = analyzeCameraBahtinov(await capture({ focusPosition: 52000 }), { x: 128, y: 128 }, 224)
		const negative = analyzeCameraBahtinov(await capture({ focusPosition: 48000 }), { x: 128, y: 128 }, 224)
		expect(positive.success && negative.success).toBeTrue()

		if (positive.success && negative.success) {
			expect(positive.absoluteError).toBeCloseTo(5, 0)
			expect(negative.absoluteError).toBeCloseTo(5, 0)
			const positiveCentralX = (positive.centralLine.distance - 128 * Math.sin(positive.centralLine.normalAngle)) / Math.cos(positive.centralLine.normalAngle)
			const negativeCentralX = (negative.centralLine.distance - 128 * Math.sin(negative.centralLine.normalAngle)) / Math.cos(negative.centralLine.normalAngle)
			expect((positiveCentralX - 128) * (negativeCentralX - 128)).toBeLessThan(0)
		}

		const disabled = analyzeCameraBahtinov(await capture({ focusPosition: 52000, optics: { SIMULATOR_ABERRATION_FOCUS: { BEST_FOCUS: 0 } } }), { x: 128, y: 128 }, 224)
		expect(disabled.success).toBeTrue()
		if (disabled.success) expect(disabled.absoluteError).toBeLessThan(1)

		const saturated = await capture({ psf: { ...setup.psf, SIMULATOR_STAR_PLOT_OPTIONS: { SATURATION_LEVEL: 0.1 } } })
		expect(Math.max(...saturated.raw)).toBeLessThanOrEqual(0.1 + 1 / 65535)
	})
})

function analyzeCameraBahtinov(image: Image, center: { readonly x: number; readonly y: number }, size: number) {
	const input: BahtinovAnalysisInput = { image, center, size }
	const area = resolveBahtinovArea(input)
	const options: BahtinovAnalysisOptions = {
		transform: 'linear',
		coreRadius: 3,
		ridgeSigma: 2,
		maximumRidgePoints: 4096,
		minimumSignalToNoise: 1,
		minimumAxialSeparation: PI / 60,
		minimumCoverage: 0.15,
		minimumBalance: 0.05,
		maximumResidual: 2,
		focusTolerance: 1,
		maximumUncertainty: 1,
		minimumConfidence: 0.05,
		minimumCandidateSeparation: 0.01,
	}
	const workspace = createBahtinovWorkspace(area.right - area.left, area.bottom - area.top, { precision: image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32, maximumRidgePoints: 4096 })
	return analyzeBahtinov(input, workspace, options)
}

function brightestPixelInArea(raw: ImageRawType, width: number, left: number, top: number, right: number, bottom: number) {
	let best = { x: left, y: top, value: -Infinity }

	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++) {
			if (raw[y * width + x] > best.value) best = { x, y, value: raw[y * width + x] }
		}
	}

	return best
}

function verticalSignalOutsideCore(raw: ImageRawType, width: number, x: number, centerY: number, coreRadius: number) {
	const height = Math.trunc(raw.length / width)
	let total = 0
	for (let y = 0; y < height; y++) if (Math.abs(y - centerY) > coreRadius) total += raw[y * width + x]
	return total
}
