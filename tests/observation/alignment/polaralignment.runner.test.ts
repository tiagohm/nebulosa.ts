import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { DEC_TAN, RA_TAN } from '../../../src/astrometry/wcs/fits.wcs'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { gcrsToItrsRotationMatrix, timeUnix } from '../../../src/astronomy/time/time'
import { PI, SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import type { MountCommander, MountMoveDirection } from '../../../src/devices/commanders/mount'
import type { Camera, Mount } from '../../../src/devices/indi/device'
import { isDeviceQuiescent } from '../../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { type FitsHeader, readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { matMulVec, matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecCross, vecNormalize, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { type Angle, arcsec, deg, normalizeAngle, toArcsec, toDeg } from '../../../src/math/units/angle'
import { applyMountAdjustment } from '../../../src/observation/alignment/polaralignment.util'
// oxfmt-ignore
import { acquireThreePointPolarAlignment, refineThreePointPolarAlignment, type ThreePointPolarAlignmentAcquisitionOptions, type ThreePointPolarAlignmentEvent, type ThreePointPolarAlignmentRefinementOptions, type ThreePointPolarAlignmentServices } from '../../../src/observation/alignment/polaralignment.runner'
import type { CameraCaptureHooks, CameraCapturer, CameraCaptureResult } from '../../../src/observation/capture/capture'
import type { CameraCaptureListener } from '../../../src/observation/capture/reporter'
import type { CenteringCaptureOptions } from '../../../src/observation/mount/centering'
import { connectSimulatorRig, createSimulatorRig, resetSimulatorRig } from '../../util/rig'

// Automatic three-point acquisition and refinement over a rigid fake mount whose boresight turns
// about a terrestrial axis with a polar error, a fake capturer and an exact solver, so the run is
// deterministic and the recovered pole can be compared with the configured one.

const CAPTURE: CenteringCaptureOptions = { exposureTime: 2, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: false, binX: 1, binY: 1, frameFormat: 'MONO', gain: 0, offset: 0, compressed: false }
const OPTIONS: ThreePointPolarAlignmentAcquisitionOptions = { direction: 'WEST', slewRate: 'SLOW', capture: CAPTURE, settle: 1, initialMotion: 2, maximumMotion: 30, maximumAttempts: 6, solveTimeout: 60, abortGrace: 5, refraction: false }
const REFINEMENT: ThreePointPolarAlignmentRefinementOptions = { capture: CAPTURE, delay: 5, maximumFailures: 1, maximumShift: deg(3), solveTimeout: 60, abortGrace: 5 }
const LATITUDE = deg(40)
const LOCATION = geodeticLocation(deg(-45), LATITUDE)

let directory = ''

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'nebulosa-tppa-'))
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

// Equatorial TAN solution centered on (rightAscension, declination), radians.
function tanSolution(rightAscension: Angle, declination: Angle) {
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, RADESYS: 'ICRS', CRVAL1: toDeg(normalizeAngle(rightAscension)), CRVAL2: toDeg(declination), CRPIX1: 50.5, CRPIX2: 50.5, CD1_1: -1e-3, CD1_2: 0, CD2_1: 0, CD2_2: 1e-3, NAXIS1: 100, NAXIS2: 100 }
	return plateSolutionFrom(header)!
}

// Clock whose waits complete at once by moving both domains, unless a hook cancels them first. A wait
// of exactly a minute is the solve timeout, which only ends by cancellation.
class InstantClock {
	wall = Date.UTC(2026, 8, 9, 0, 30)
	onDelay?: (ms: number) => void

	readonly wallNow = () => this.wall
	readonly monotonicNow = () => this.wall
	readonly delay = (ms: number, signal: AbortSignal): Promise<OperationResult<void>> => {
		if (ms === 60000) {
			return new Promise((resolve) => {
				if (signal.aborted) resolve(failedOperationResult('aborted'))
				else signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			})
		}
		this.onDelay?.(ms)
		if (signal.aborted) return Promise.resolve(failedOperationResult('aborted'))
		this.wall += ms
		return Promise.resolve(successfulOperationResult(undefined))
	}
}

// Rigid equatorial mount: the boresight turns about `pole` (ITRS) by the manual rotation plus the
// sidereal tracking since the start; positive rotations go west.
class FakeMount {
	readonly mount: Mount
	readonly clock: InstantClock
	readonly start: number
	readonly motions: { direction: MountMoveDirection; seconds: number }[] = []
	pole: Vec3
	boresight: Vec3
	// Rotation of the manual motion, radians per second, per preset.
	rates: Record<string, number> = { SLOW: deg(0.5), FAST: deg(4) }
	// Multiplies the commanded direction: -1 for a driver that moves the other way, 0 for one that never moves.
	response = 1
	// Whether the slew-rate echo never arrives.
	ignoresSlewRate = false

	constructor(clock: InstantClock, declination: Angle = deg(20), azimuthError: Angle = arcsec(600), altitudeError: Angle = arcsec(-400)) {
		this.clock = clock
		this.start = clock.wall
		this.pole = rigidPole(azimuthError, altitudeError)
		const meridian = vecNormalize(vecCross(this.pole, up()))
		this.boresight = vecRotateByRodrigues(this.pole, vecNormalize(vecCross(this.pole, meridian)), PI / 2 - declination)
		this.mount = {
			name: 'Fake Mount',
			connected: true,
			mountType: 'EQ_GEM',
			canMove: true,
			canMoveWE: true,
			canMoveNS: true,
			canAbort: true,
			parked: false,
			parking: false,
			tracking: true,
			trackModes: ['SIDEREAL'],
			trackMode: 'SIDEREAL',
			slewRates: [
				{ name: 'SLOW', label: 'Slow' },
				{ name: 'FAST', label: 'Fast' },
			],
			slewRate: 'FAST',
			hasPierSide: true,
			pierSide: 'WEST',
		} as unknown as Mount
	}

	// Boresight in ICRS at the wall instant `at` (Unix ms), including tracking since the start.
	sky(at: number): [Angle, Angle] {
		const tracked = vecRotateByRodrigues(this.boresight, this.pole, -SIDEREAL_DRIFT_RATE * ((at - this.start) / 1000))
		const time = timeUnix(at / 1000)
		const [rightAscension, declination] = eraC2s(...matTransposeMulVec(gcrsToItrsRotationMatrix(time), tracked))
		return [rightAscension, declination]
	}

	readonly commander = {
		setSlewRate: (_scope: OperationScope, mount: Mount, rate: string) => {
			if (this.ignoresSlewRate) return Promise.resolve(failedOperationResult('timeout'))
			Object.assign(mount, { slewRate: rate })
			return Promise.resolve(successfulOperationResult(undefined))
		},
		startManualMove: (_scope: OperationScope, mount: Mount, direction: MountMoveDirection) => {
			const startedAt = this.clock.wall
			const stop = () => {
				const seconds = (this.clock.wall - startedAt) / 1000
				this.motions.push({ direction, seconds })
				// A westward rotation about the northern pole is negative (right-handed about +Z).
				const rotation = (direction === 'WEST' ? 1 : -1) * this.response * this.rates[mount.slewRate!] * seconds
				this.boresight = vecRotateByRodrigues(this.boresight, this.pole, -rotation)
				return Promise.resolve(successfulOperationResult(undefined))
			}
			return Promise.resolve(successfulOperationResult({ id: 'move', directions: () => [direction], move: () => Promise.resolve(successfulOperationResult(undefined)), stop }))
		},
	} as unknown as MountCommander

	// Turns the mount base by the knobs, which tilts the axis and the boresight together.
	adjust(azimuth: Angle, altitude: Angle) {
		const [upAxis, eastAxis] = [up(), east()]
		this.boresight = applyMountAdjustment(this.boresight, upAxis, eastAxis, azimuth, altitude)
		this.pole = applyMountAdjustment(this.pole, upAxis, eastAxis, azimuth, altitude)
	}
}

function up(): Vec3 {
	return [Math.cos(LATITUDE) * Math.cos(LOCATION.longitude), Math.cos(LATITUDE) * Math.sin(LOCATION.longitude), Math.sin(LATITUDE)]
}

function east(): Vec3 {
	return [-Math.sin(LOCATION.longitude), Math.cos(LOCATION.longitude), 0]
}

// Mechanical axis (ITRS) with the given azimuth and altitude errors in the north.
function rigidPole(azimuthError: Angle, altitudeError: Angle): Vec3 {
	const north: Vec3 = [-Math.sin(LATITUDE) * Math.cos(LOCATION.longitude), -Math.sin(LATITUDE) * Math.sin(LOCATION.longitude), Math.cos(LATITUDE)]
	const [e, u] = [east(), up()]
	const altitude = LATITUDE + altitudeError
	const n = Math.cos(altitude) * Math.cos(azimuthError)
	const ea = Math.cos(altitude) * Math.sin(azimuthError)
	const ua = Math.sin(altitude)
	return vecNormalize([north[0] * n + e[0] * ea + u[0] * ua, north[1] * n + e[1] * ea + u[1] * ua, north[2] * n + u[2] * ua])
}

// Capturer that exposes instantly (advancing the clock by the exposure) and writes nothing useful.
function fakeCapturer(clock: InstantClock, fails: () => boolean = () => false, hooks: (CameraCaptureHooks | undefined)[] = []) {
	return {
		start: (scope: OperationScope, _camera: Camera, _request: unknown, captureHooks?: CameraCaptureHooks) => {
			hooks.push(captureHooks)
			const { signal } = scope as OperationContext
			const result = ((): Promise<OperationResult<CameraCaptureResult>> => {
				if (signal.aborted) return Promise.resolve(failedOperationResult('aborted'))
				if (fails()) return Promise.resolve(failedOperationResult('commandFailed', 'camera failed'))
				const exposureStartedAt = clock.wall
				clock.wall += CAPTURE.exposureTime * 1000
				return Promise.resolve(successfulOperationResult({ frames: [{ operation: 'op', session: 's', generation: 1, camera: 'cam', path: '', exposureStartedAt, exposureStartedMonotonic: exposureStartedAt, exposureFinishedAt: clock.wall, exposureFinishedMonotonic: clock.wall }], frameCount: 1 }))
			})()
			return { id: 'capture', started: Promise.resolve(successfulOperationResult(undefined)), result, cancel: () => Promise.resolve() }
		},
	} as unknown as CameraCapturer
}

function services(fake: FakeMount, events: ThreePointPolarAlignmentEvent[] = [], unsolved: () => boolean = () => false): ThreePointPolarAlignmentServices {
	return {
		mountCommander: fake.commander,
		cameraCapturer: fakeCapturer(fake.clock),
		solver: (frame) => Promise.resolve(unsolved() ? undefined : tanSolution(...fake.sky(frame.observedAt))),
		auxiliaryPath: (stage, index) => join(directory, `${stage}-${index}.fit`),
		clock: fake.clock,
		location: LOCATION,
		listener: (event) => events.push(event),
	}
}

function coordinator() {
	return new OperationCoordinator(new ResourceArbiter())
}

const CAMERA = { name: 'Fake Camera' } as Camera

function expectPole(pole: Vec3, time: Parameters<typeof gcrsToItrsRotationMatrix>[0], expected: Vec3, tolerance: number) {
	expect(toArcsec(vecAngle(matMulVec(gcrsToItrsRotationMatrix(time), pole), expected))).toBeLessThan(tolerance)
}

describe('acquisition', () => {
	test.each(['WEST', 'EAST'] as const)('reaches three poses %s with adaptive motions and recovers the pole', async (direction) => {
		const fake = new FakeMount(new InstantClock())
		const events: ThreePointPolarAlignmentEvent[] = []
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, { ...OPTIONS, direction }, services(fake, events))

		expect(result.ok).toBeTrue()
		if (!result.ok) return
		const { quality, result: estimate } = result.value
		expect(quality.acceptable).toBeTrue()
		expect(Math.abs(toDeg(quality.rotation12))).toBeGreaterThanOrEqual(6)
		expect(Math.abs(toDeg(quality.rotation13))).toBeLessThanOrEqual(30)
		expectPole(estimate.pole, estimate.time, fake.pole, 1)
		expect(fake.motions.every((m) => m.direction === direction)).toBeTrue()
		// The first motion is the initial one; the rate observed then sizes the next ones.
		expect(fake.motions[0].seconds).toBe(OPTIONS.initialMotion)
		expect(fake.motions[1].seconds).toBeGreaterThan(OPTIONS.initialMotion)
		expect(events[0]).toEqual({ type: 'slewRate', previous: 'FAST', applied: 'SLOW' })
		expect(events.filter((e) => e.type === 'accepted').map((e) => e.type === 'accepted' && e.point)).toEqual([1, 2, 3])
		expect(events.at(-1)?.type).toBe('result')
	})

	test('gives the capture listener of the services to every auxiliary capture', async () => {
		const fake = new FakeMount(new InstantClock())
		const hooks: (CameraCaptureHooks | undefined)[] = []
		const captureListener: CameraCaptureListener = () => {}
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, { ...services(fake), cameraCapturer: fakeCapturer(fake.clock, undefined, hooks), captureListener })

		expect(result.ok).toBeTrue()
		expect(hooks.length).toBeGreaterThanOrEqual(3)
		expect(hooks.every((hook) => hook?.listener === captureListener)).toBeTrue()
	})

	test('fails before moving when the slew rate is not confirmed', async () => {
		const fake = new FakeMount(new InstantClock())
		fake.ignoresSlewRate = true
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		expect(result).toMatchObject({ ok: false, reason: 'timeout' })
		expect(fake.motions).toHaveLength(0)
	})

	test('refuses a mount that is not tracking or announces no such slew rate', async () => {
		const fake = new FakeMount(new InstantClock())
		Object.assign(fake.mount, { tracking: false })
		expect(await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))).toMatchObject({ ok: false, reason: 'unexpectedState' })
		Object.assign(fake.mount, { tracking: true })
		expect(await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, { ...OPTIONS, slewRate: 'WARP' }, services(fake))).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(fake.motions).toHaveLength(0)
	})

	test('fails when the mount does not move', async () => {
		const fake = new FakeMount(new InstantClock())
		fake.response = 0
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('did not rotate') })
		// Probes of 2, 8 and then the longest motion, 30 s.
		expect(fake.motions.map((m) => m.seconds)).toEqual([2, 8, 30])
	})

	test('probes a slow preset with longer motions before sizing them from the rate', async () => {
		const fake = new FakeMount(new InstantClock())
		fake.rates.SLOW = deg(0.01)
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, { ...OPTIONS, maximumMotion: 600, maximumAttempts: 10 }, services(fake))
		expect(result.ok).toBeTrue()
		expect(fake.motions.slice(0, 2).map((m) => m.seconds)).toEqual([2, 8])
		expect(fake.motions[2].seconds).toBeGreaterThan(300)
	})

	test('stops on a motion in the opposite direction', async () => {
		const fake = new FakeMount(new InstantClock())
		fake.response = -1
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('reversedRotation') })
		expect(fake.motions).toHaveLength(1)
	})

	test('stops when a motion overshoots the total rotation', async () => {
		const fake = new FakeMount(new InstantClock())
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, { ...OPTIONS, slewRate: 'FAST', initialMotion: 10 }, services(fake))
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('excessiveRotation') })
	})

	test('refuses a first pose near the pole before moving', async () => {
		const fake = new FakeMount(new InstantClock(), deg(85))
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('nearPole') })
		expect(fake.motions).toHaveLength(0)
	})

	test('stops on a pier-side change', async () => {
		const fake = new FakeMount(new InstantClock())
		fake.clock.onDelay = () => Object.assign(fake.mount, { pierSide: 'EAST' })
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('pier side') })
	})

	test('sends the stop when cancelled during a motion and commands nothing more', async () => {
		const fake = new FakeMount(new InstantClock())
		const operations = coordinator()
		const handle = operations.start('session', [], (context) => acquireThreePointPolarAlignment(context, fake.mount, CAMERA, OPTIONS, services(fake)))
		fake.clock.onDelay = (ms) => {
			if (ms === OPTIONS.initialMotion * 1000) void handle.cancel('aborted')
		}
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(fake.motions).toHaveLength(1)
	})

	test('a frame without solution still moves further but keeps the rate', async () => {
		const fake = new FakeMount(new InstantClock())
		let solves = 0
		const result = await acquireThreePointPolarAlignment(
			coordinator(),
			fake.mount,
			CAMERA,
			OPTIONS,
			services(fake, [], () => ++solves === 2),
		)
		expect(result.ok).toBeTrue()
		expect(fake.motions[1].seconds).toBe(OPTIONS.initialMotion)
	})
})

describe('refinement', () => {
	async function acquired(fake: FakeMount) {
		const result = await acquireThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, OPTIONS, services(fake))
		if (!result.ok) throw new Error(`acquisition failed: ${result.reason}`)
		return result.value
	}

	test('follows a knob adjustment without commanding the mount', async () => {
		const fake = new FakeMount(new InstantClock())
		const acquisition = await acquired(fake)
		const motions = fake.motions.length
		const events: ThreePointPolarAlignmentEvent[] = []
		const operations = coordinator()
		let frames = 0
		const cancel = Promise.withResolvers<void>()
		const refine: ThreePointPolarAlignmentServices = {
			...services(fake),
			listener: (event) => {
				events.push(event)
				if (event.type !== 'result') return
				if (++frames === 1) fake.adjust(arcsec(-600), arcsec(400))
				else if (frames === 3) cancel.resolve()
			},
		}
		const handle = operations.start('session', [], (context) => refineThreePointPolarAlignment(context, fake.mount, CAMERA, acquisition.alignment, acquisition.points[2], acquisition.pierSide, REFINEMENT, refine))
		void cancel.promise.then(() => handle.cancel('aborted'))
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })

		const results = events.filter((e) => e.type === 'result')
		expect(results).toHaveLength(3)
		const last = results.at(-1)!
		if (last.type !== 'result') return
		expectPole(last.result.pole, last.result.time, fake.pole, 5)
		expect(last.stage).toBe('refinement')
		expect(fake.motions).toHaveLength(motions)
	})

	test('invalidates the estimate when the field jumps', async () => {
		const fake = new FakeMount(new InstantClock())
		const acquisition = await acquired(fake)
		fake.clock.onDelay = () => fake.adjust(deg(5), 0)
		const result = await refineThreePointPolarAlignment(coordinator(), fake.mount, CAMERA, acquisition.alignment, acquisition.points[2], acquisition.pierSide, REFINEMENT, services(fake))
		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('moved') })
	})

	test('a long pause while tracking does not invalidate the estimate', async () => {
		const fake = new FakeMount(new InstantClock())
		const acquisition = await acquired(fake)
		const events: ThreePointPolarAlignmentEvent[] = []
		const operations = coordinator()
		const cancel = Promise.withResolvers<void>()
		const refine: ThreePointPolarAlignmentServices = { ...services(fake), listener: (event) => (events.push(event), event.type === 'result' && cancel.resolve()) }
		const handle = operations.start('session', [], (context) => refineThreePointPolarAlignment(context, fake.mount, CAMERA, acquisition.alignment, acquisition.points[2], acquisition.pierSide, { ...REFINEMENT, delay: 1800 }, refine))
		void cancel.promise.then(() => handle.cancel('aborted'))
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		const result = events.find((e) => e.type === 'result')
		if (result?.type !== 'result') throw new Error('no refinement result')
		expectPole(result.result.pole, result.result.time, fake.pole, 5)
	})

	test('fails after consecutive frames without solution', async () => {
		const fake = new FakeMount(new InstantClock())
		const acquisition = await acquired(fake)
		const result = await refineThreePointPolarAlignment(
			coordinator(),
			fake.mount,
			CAMERA,
			acquisition.alignment,
			acquisition.points[2],
			acquisition.pierSide,
			REFINEMENT,
			services(fake, [], () => true),
		)
		expect(result).toMatchObject({ ok: false, reason: 'commandFailed' })
	})
})

const rig = await createSimulatorRig()

describe('on the simulator rig', () => {
	const directory = join(rig.capturesDir, 'auxiliary', 'tppa')
	const clock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }

	beforeAll(async () => {
		await connectSimulatorRig(rig)
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		mkdirSync(directory, { recursive: true })
	})

	afterAll(async () => {
		await rig[Symbol.asyncDispose]()
	})

	// Solver reading the J2000 center the camera simulator stamps (RA/DEC keywords, degrees).
	const solver: ThreePointPolarAlignmentServices['solver'] = async (frame) => {
		const fits = await readFits(bufferSource(readFileSync(frame.path)))
		const { header } = fits!.hdus[0]
		return tanSolution(deg(header.RA as number), deg(header.DEC as number))
	}

	test('rotates the real mount westward through the commander and recovers its axis', async () => {
		const { mount, camera } = rig.devices()
		expect(await rig.commanders.mount.setTracking(rig.coordinator, mount, true)).toMatchObject({ ok: true })
		const { latitude, longitude, elevation } = mount.geographicCoordinate
		const events: ThreePointPolarAlignmentEvent[] = []
		const options: ThreePointPolarAlignmentAcquisitionOptions = { ...OPTIONS, slewRate: 'SPEED_4', capture: { ...CAPTURE, exposureTime: 10, exposureTimeUnit: 'millisecond' }, settle: 0.2, initialMotion: 0.5, maximumMotion: 4 }
		const result = await acquireThreePointPolarAlignment(rig.coordinator, mount, camera, options, {
			mountCommander: rig.commanders.mount,
			cameraCapturer: rig.capturer,
			solver,
			auxiliaryPath: (stage, index) => join(directory, `${stage}.${index}.fit`),
			clock,
			location: geodeticLocation(longitude, latitude, elevation),
			listener: (event) => events.push(event),
		})

		expect(result.ok).toBeTrue()
		if (!result.ok) return
		expect(mount.slewRate).toBe('SPEED_4')
		expect(result.value.quality.acceptable).toBeTrue()
		// The simulator applies no polar error by default, so the mount axis is the celestial pole.
		expect(toArcsec(Math.hypot(result.value.result.azimuthError, result.value.result.altitudeError))).toBeLessThan(120)
		expect(rig.arbiter.ownersOf(resourceKey(mount))).toHaveLength(0)
		expect(isDeviceQuiescent(mount)).toBeTrue()
	}, 60000)
})
