import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { timeUnix } from '../../../src/astronomy/time/time'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import type { MountCommander, MountMoveDirection } from '../../../src/devices/commanders/mount'
import type { Camera, Mount } from '../../../src/devices/indi/device'
import { failedOperationResult, OperationCoordinator, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { matMulVec, matRodriguesRotation } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecCross, vecDot, vecNormalize } from '../../../src/math/linear-algebra/vec3'
import { arcmin, arcsec, deg, toArcsec, toDeg } from '../../../src/math/units/angle'
import { IPOLAR_CONVERGENCE_START } from '../../../src/observation/alignment/ipolar'
import { ipolarFrameContext, type IPolarObserver, ipolarItrsToIcrs } from '../../../src/observation/alignment/ipolar.geometry'
import { type IPolarCalibrationOptions, type IPolarEvent, type IPolarRefinementOptions, type IPolarServices, ipolarMountRefusal, runIPolarCalibration, runIPolarRefinement } from '../../../src/observation/alignment/ipolar.runner'
import type { CameraCapturer, CameraCaptureResult } from '../../../src/observation/capture/capture'
import type { CenteringCaptureOptions } from '../../../src/observation/mount/centering'

// Manual and automatic iPolar runs over a rigid fake rig: a camera turning about a terrestrial axis
// with a known polar error (the manual rotation, the motor and the sidereal tracking), whose plate
// solution at each exposure midpoint is built from its attitude, a fake capturer and a clock whose
// waits complete at once, so the runs are deterministic and the commands can be counted.

const CAPTURE: CenteringCaptureOptions = { exposureTime: 2, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 640, height: 480, subframe: false, binX: 1, binY: 1, frameFormat: 'MONO', gain: 0, offset: 0, compressed: false }
const LOCATION = geodeticLocation(deg(-45), deg(40))
const OBSERVER: IPolarObserver = { location: LOCATION, refraction: false }
const MANUAL: IPolarCalibrationOptions = { mode: 'manual', capture: CAPTURE, observer: OBSERVER, settle: 1, maximumAttempts: 4, maximumDeclinationChange: deg(0.5), solveTimeout: 60, abortGrace: 5 }
const AUTOMATIC: IPolarCalibrationOptions = { ...MANUAL, mode: 'automatic', motion: { direction: 'WEST', slewRate: 'SLOW', targetRotation: deg(25), initialMotion: 2, maximumMotion: 30, maximumTotalMotion: 120 }, maximumAttempts: 8 }
const REFINEMENT: IPolarRefinementOptions = { capture: CAPTURE, delay: 5, maximumFailures: 1, maximumDeclinationChange: deg(0.5), solveTimeout: 60, abortGrace: 5 }
const CAMERA = { name: 'Fake Camera' } as Camera
const UP: Vec3 = [Math.cos(deg(40)) * Math.cos(deg(-45)), Math.cos(deg(40)) * Math.sin(deg(-45)), Math.sin(deg(40))]
const EAST: Vec3 = [-Math.sin(deg(-45)), Math.cos(deg(-45)), 0]
const ZENITH = vecCross(EAST, [0, 0, 1])

let directory = ''

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'nebulosa-ipolar-'))
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

// Clock whose waits complete at once, unless a hook cancels them first. A wait of exactly a minute
// is the solve timeout, which only ends by cancellation.
class InstantClock {
	wall = Date.UTC(2026, 10, 8, 23, 0)
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

// Axis displaced from the north pole (ITRS +z) by on-sky east and up components.
function axisWith(azimuth: number, altitude: number) {
	return vecNormalize([azimuth * EAST[0] + altitude * ZENITH[0], azimuth * EAST[1] + altitude * ZENITH[1], 1 + azimuth * EAST[2] + altitude * ZENITH[2]])
}

class FakeRig {
	readonly clock = new InstantClock()
	readonly start = this.clock.wall
	readonly motions: { direction: MountMoveDirection; seconds: number }[] = []
	readonly commands: string[] = []
	// Mount snooped by every capture request, in order.
	readonly snooped: string[] = []
	axis = axisWith(arcmin(20), arcmin(-10))
	// Camera attitude (row-major active rotation) applied to the reference camera basis.
	attitude = matRodriguesRotation([1, 0, 0], 0)
	forward = matMulVec(matRodriguesRotation(EAST, deg(1)), this.axis)
	rates: Record<string, number> = { SLOW: deg(0.5), FAST: deg(4) }
	response = 1
	tracking = true
	solves = 0
	unsolved: (index: number) => boolean = () => false
	readonly mount = {
		name: 'Fake Mount',
		connected: true,
		mountType: 'EQ_GEM',
		canMove: true,
		canMoveWE: true,
		canAbort: true,
		parked: false,
		parking: false,
		tracking: true,
		slewRates: [
			{ name: 'SLOW', label: 'Slow' },
			{ name: 'FAST', label: 'Fast' },
		],
		slewRate: 'FAST',
		hasPierSide: true,
		pierSide: 'WEST',
		equatorialCoordinate: { rightAscension: 0, declination: deg(89) },
	} as unknown as Mount

	// Turns the camera about the mechanical axis (an RA rotation).
	turn(angle: number) {
		this.attitude = mul(matRodriguesRotation(this.axis, angle), this.attitude)
	}

	// Turns the camera alone about an axis perpendicular to the mechanical one (a DEC rotation).
	tilt(angle: number) {
		const forward = matMulVec(this.attitude, this.forward)
		this.attitude = mul(matRodriguesRotation(vecNormalize(vecCross(this.axis, forward)), angle), this.attitude)
	}

	// Adjusts the base: turns the axis and the camera together towards the new axis.
	adjust(azimuth: number, altitude: number) {
		const moved = axisWith(azimuth, altitude)
		const pivot = vecCross(this.axis, moved)
		const angle = Math.asin(Math.min(1, Math.hypot(...pivot)))
		if (angle > 0) this.attitude = mul(matRodriguesRotation(vecNormalize(pivot), angle), this.attitude)
		this.axis = moved
	}

	readonly commander = {
		setSlewRate: (_scope: OperationScope, mount: Mount, rate: string) => {
			this.commands.push(`slewRate ${rate}`)
			Object.assign(mount, { slewRate: rate })
			return Promise.resolve(successfulOperationResult(undefined))
		},
		startManualMove: (_scope: OperationScope, mount: Mount, direction: MountMoveDirection) => {
			this.commands.push(`move ${direction}`)
			const startedAt = this.clock.wall
			const stop = () => {
				const seconds = (this.clock.wall - startedAt) / 1000
				this.motions.push({ direction, seconds })
				this.turn((direction === 'WEST' ? -1 : 1) * this.response * this.rates[mount.slewRate!] * seconds)
				return Promise.resolve(successfulOperationResult(undefined))
			}
			return Promise.resolve(successfulOperationResult({ id: 'move', directions: () => [direction], move: () => Promise.resolve(successfulOperationResult(undefined)), stop }))
		},
	} as unknown as MountCommander

	// Plate solution of the camera at the wall instant `at`, tracking included.
	solution(at: number) {
		const time = timeUnix(at / 1000)
		const context = ipolarFrameContext(time, OBSERVER)
		const tracked = this.tracking ? mul(matRodriguesRotation(this.axis, -SIDEREAL_DRIFT_RATE * ((at - this.start) / 1000)), this.attitude) : this.attitude
		const f = matMulVec(tracked, this.forward)
		const r = vecNormalize(matMulVec(tracked, vecCross(this.forward, [0, 0, 1])))
		const d = vecCross(f, r)
		const step = arcsec(10)
		const sky = (u: number, v: number) => eraS2c(...ipolarItrsToIcrs(vecNormalize([f[0] + u * r[0] + v * d[0], f[1] + u * r[1] + v * d[1], f[2] + u * r[2] + v * d[2]]), context))
		const center = sky(0, 0)
		const e = vecNormalize(vecCross([0, 0, 1], center))
		const n = vecCross(center, e)
		const [x, y] = [sky(step, 0), sky(0, step)]
		const [ra, dec] = ipolarItrsToIcrs(f, context)
		const header = {
			NAXIS1: 640,
			NAXIS2: 480,
			CTYPE1: 'RA---TAN',
			CTYPE2: 'DEC--TAN',
			CRPIX1: 320.5,
			CRPIX2: 240.5,
			CRVAL1: toDeg(ra),
			CRVAL2: toDeg(dec),
			RADESYS: 'ICRS',
			CD1_1: toDeg(vecDot(x, e) / vecDot(x, center)),
			CD1_2: toDeg(vecDot(y, e) / vecDot(y, center)),
			CD2_1: toDeg(vecDot(x, n) / vecDot(x, center)),
			CD2_2: toDeg(vecDot(y, n) / vecDot(y, center)),
		}
		return plateSolutionFrom(header)!
	}

	readonly capturer = {
		start: (scope: OperationScope, _camera: Camera, request: { readonly mount?: string }) => {
			const { signal } = scope as OperationContext
			this.snooped.push(request.mount ?? '')
			const result = ((): Promise<OperationResult<CameraCaptureResult>> => {
				if (signal.aborted) return Promise.resolve(failedOperationResult('aborted'))
				const exposureStartedAt = this.clock.wall
				this.clock.wall += CAPTURE.exposureTime * 1000
				return Promise.resolve(successfulOperationResult({ frames: [{ operation: 'op', session: 's', generation: 1, camera: 'cam', path: '', exposureStartedAt, exposureStartedMonotonic: exposureStartedAt, exposureFinishedAt: this.clock.wall, exposureFinishedMonotonic: this.clock.wall }], frameCount: 1 }))
			})()
			return { id: 'capture', started: Promise.resolve(successfulOperationResult(undefined)), result, cancel: () => Promise.resolve() }
		},
	} as unknown as CameraCapturer

	services(events: IPolarEvent[] = [], confirm?: (attempt: number) => boolean): IPolarServices {
		let attempt = 0
		return {
			mountCommander: this.commander,
			cameraCapturer: this.capturer,
			solver: (frame) => Promise.resolve(this.unsolved(++this.solves) ? undefined : this.solution(frame.observedAt)),
			auxiliaryPath: (stage, index) => join(directory, `${stage}-${index}.fit`),
			clock: this.clock,
			rotationConfirmed: (signal) => Promise.resolve(!signal.aborted && (confirm?.(++attempt) ?? true)),
			listener: (event) => events.push(event),
		}
	}
}

function mul(a: readonly number[], b: readonly number[]) {
	const out = new Array<number>(9)
	for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
	return out as unknown as ReturnType<typeof matRodriguesRotation>
}

function coordinator() {
	return new OperationCoordinator(new ResourceArbiter())
}

describe('manual calibration', () => {
	test('calibrates with the camera alone and never commands a mount', async () => {
		const rig = new FakeRig()
		const events: IPolarEvent[] = []
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			undefined,
			MANUAL,
			rig.services(events, () => (rig.turn(deg(30)), true)),
		)
		expect(result.ok).toBeTrue()
		if (!result.ok) return
		expect(rig.commands).toEqual([])
		expect(result.value.captures).toBe(2)
		expect(result.value.mount).toBeUndefined()
		expect(toDeg(result.value.calibration.quality.rotation)).toBeCloseTo(30 + toDeg(SIDEREAL_DRIFT_RATE * 5), 1)
		expect(result.value.measurement.valid).toBeTrue()
		if (!result.value.measurement.valid) return
		expect(toArcsec(Math.abs(result.value.measurement.error.azimuth - arcmin(20)))).toBeLessThan(2)
		expect(toArcsec(Math.abs(result.value.measurement.error.altitude - arcmin(-10)))).toBeLessThan(2)
		expect(events.map((e) => e.type)).toEqual(['capture', 'solved', 'waitingForRotation', 'capture', 'solved', 'calibrationAccepted'])
		expect(events.at(-1)).toMatchObject({ verified: false })
	})

	test('watches an assigned mount without commanding it', async () => {
		const rig = new FakeRig()
		const events: IPolarEvent[] = []
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			rig.mount,
			MANUAL,
			rig.services(events, () => (rig.turn(deg(30)), true)),
		)
		expect(result).toMatchObject({ ok: true, value: { mount: { declination: deg(89), pierSide: 'WEST' } } })
		expect(rig.commands).toEqual([])
		expect(events.at(-1)).toMatchObject({ type: 'calibrationAccepted', verified: true })
		// The pointing of a mount turned by hand is stale, so it is never snooped as a hint.
		expect(rig.snooped).toEqual(['', ''])
	})

	test('keeps the first pose while the rotation is too small', async () => {
		const rig = new FakeRig()
		const events: IPolarEvent[] = []
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			undefined,
			MANUAL,
			rig.services(events, (attempt) => (rig.turn(attempt === 1 ? deg(4) : deg(20)), true)),
		)
		expect(result).toMatchObject({ ok: true, value: { captures: 3 } })
		const rejected = events.find((e) => e.type === 'calibrationRejected')
		expect(rejected).toMatchObject({ reason: 'insufficientRotation', retry: true })
		expect(toDeg(rejected?.type === 'calibrationRejected' ? rejected.quality.rotation! : 0)).toBeCloseTo(4, 1)
		expect(events.filter((e) => e.type === 'waitingForRotation')).toHaveLength(2)
	})

	test('ends on a declination motion, whether the mount reports it or the geometry shows it', async () => {
		const reported = new FakeRig()
		const moved = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			reported.mount,
			MANUAL,
			reported.services([], () => (Object.assign(reported.mount.equatorialCoordinate, { declination: deg(87) }), true)),
		)
		expect(moved).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('declination') })
		const unreported = new FakeRig()
		const events: IPolarEvent[] = []
		const tilted = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			undefined,
			MANUAL,
			unreported.services(events, () => (unreported.tilt(deg(20)), true)),
		)
		expect(tilted).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('wrongAxis') })
		expect(events.at(-1)).toMatchObject({ type: 'calibrationRejected', reason: 'wrongAxis', retry: false })
	})

	test('ends when cancelled while waiting for the operator', async () => {
		const rig = new FakeRig()
		const operations = coordinator()
		const events: IPolarEvent[] = []
		const confirmation = Promise.withResolvers<boolean>()
		const services: IPolarServices = {
			...rig.services(events),
			rotationConfirmed: (signal) => {
				signal.addEventListener('abort', () => confirmation.resolve(false), { once: true })
				return confirmation.promise
			},
		}
		const handle = operations.start('session', [], (context) => runIPolarCalibration(context, CAMERA, undefined, MANUAL, services))
		while (!events.some((e) => e.type === 'waitingForRotation')) await Bun.sleep(0)
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(events.filter((e) => e.type === 'capture')).toHaveLength(1)
	})

	test('fails when the first frame does not solve and retries an unsolved second frame', async () => {
		const unsolvedFirst = new FakeRig()
		unsolvedFirst.unsolved = (index) => index === 1
		expect(await runIPolarCalibration(coordinator(), CAMERA, undefined, MANUAL, unsolvedFirst.services())).toMatchObject({ ok: false, reason: 'commandFailed' })
		const unsolvedSecond = new FakeRig()
		unsolvedSecond.unsolved = (index) => index === 2
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			undefined,
			MANUAL,
			unsolvedSecond.services([], (attempt) => (attempt === 1 && unsolvedSecond.turn(deg(30)), true)),
		)
		expect(result).toMatchObject({ ok: true, value: { captures: 3 } })
	})

	test('fails as a timeout when the solver answers only its abort', async () => {
		const rig = new FakeRig()
		const services: IPolarServices = {
			...rig.services(),
			solver: (_, signal) =>
				new Promise((resolve) => {
					signal.addEventListener('abort', () => resolve(undefined), { once: true })
				}),
		}
		expect(await runIPolarCalibration(coordinator(), CAMERA, undefined, { ...MANUAL, solveTimeout: 30 }, services)).toMatchObject({ ok: false, reason: 'timeout' })
	})

	test('fails after the attempts without enough rotation', async () => {
		const rig = new FakeRig()
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			undefined,
			MANUAL,
			rig.services([], () => (rig.turn(deg(1)), true)),
		)
		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('4 attempts') })
	})
})

describe('automatic calibration', () => {
	test('turns the mount until the measured rotation reaches the target', async () => {
		const rig = new FakeRig()
		const events: IPolarEvent[] = []
		const result = await runIPolarCalibration(coordinator(), CAMERA, rig.mount, AUTOMATIC, rig.services(events))
		expect(result.ok).toBeTrue()
		if (!result.ok) return
		expect(toDeg(result.value.calibration.quality.rotation)).toBeGreaterThanOrEqual(10)
		expect(toDeg(result.value.calibration.quality.rotation)).toBeLessThanOrEqual(30)
		expect(rig.motions.every((e) => e.direction === 'WEST')).toBeTrue()
		expect(rig.motions[0].seconds).toBe(2)
		expect(rig.motions.reduce((a, e) => a + e.seconds, 0)).toBeLessThanOrEqual(120)
		expect(events[0]).toEqual({ type: 'slewRate', previous: 'FAST', applied: 'SLOW' })
		expect(events.filter((e) => e.type === 'waitingForRotation')).toHaveLength(0)
		expect(rig.commands.filter((e) => e.startsWith('move'))).toHaveLength(rig.motions.length)
		expect(rig.snooped.every((e) => e === 'Fake Mount')).toBeTrue()
	})

	test('refuses an unusable mount before any command', async () => {
		const rig = new FakeRig()
		Object.assign(rig.mount, { mountType: 'ALTAZ' })
		expect(await runIPolarCalibration(coordinator(), CAMERA, rig.mount, AUTOMATIC, rig.services())).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(await runIPolarCalibration(coordinator(), CAMERA, undefined, AUTOMATIC, rig.services())).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(rig.commands).toEqual([])
		Object.assign(rig.mount, { mountType: 'EQ_GEM', tracking: false })
		expect(ipolarMountRefusal(rig.mount, 'SLOW')).toBeUndefined()
		expect(ipolarMountRefusal(rig.mount, 'WARP')).toContain('no slew rate')
	})

	test('fails when the mount does not move, or the motion budget runs out', async () => {
		const still = new FakeRig()
		still.response = 0
		still.tracking = false
		expect(await runIPolarCalibration(coordinator(), CAMERA, still.mount, AUTOMATIC, still.services())).toMatchObject({ ok: false, error: expect.stringContaining('did not rotate') })
		expect(still.motions.map((e) => e.seconds)).toEqual([2, 8, 30])
		const slow = new FakeRig()
		slow.rates.SLOW = deg(0.05)
		expect(await runIPolarCalibration(coordinator(), CAMERA, slow.mount, { ...AUTOMATIC, maximumAttempts: 20 }, slow.services())).toMatchObject({ ok: false, error: expect.stringContaining('within 120 s') })
		expect(slow.motions.reduce((a, e) => a + e.seconds, 0)).toBeLessThanOrEqual(120)
	})

	test('sends the stop when cancelled during a motion and commands nothing more', async () => {
		const rig = new FakeRig()
		const operations = coordinator()
		const handle = operations.start('session', [], (context) => runIPolarCalibration(context, CAMERA, rig.mount, AUTOMATIC, rig.services()))
		rig.clock.onDelay = (ms) => {
			if (ms === 2000) void handle.cancel('aborted')
		}
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(rig.motions).toHaveLength(1)
		expect(rig.commands).toEqual(['slewRate SLOW', 'move WEST'])
	})
})

describe('refinement', () => {
	async function calibrated(rig: FakeRig) {
		const result = await runIPolarCalibration(
			coordinator(),
			CAMERA,
			rig.mount,
			MANUAL,
			rig.services([], () => (rig.turn(deg(30)), true)),
		)
		if (!result.ok) throw new Error(result.error ?? result.reason)
		return result.value
	}

	test('follows base adjustments to convergence without commanding the mount', async () => {
		const rig = new FakeRig()
		const run = await calibrated(rig)
		const events: IPolarEvent[] = []
		const operations = coordinator()
		const done = Promise.withResolvers<void>()
		let frames = 0
		const services: IPolarServices = {
			...rig.services(),
			listener: (event) => {
				events.push(event)
				if (event.type !== 'measurement') return
				if (++frames === 1) rig.adjust(arcsec(5), arcsec(-3))
				else if (frames === 5) done.resolve()
			},
		}
		const handle = operations.start('session', [], (context) => runIPolarRefinement(context, CAMERA, rig.mount, run.mount, run.calibration, { convergence: IPOLAR_CONVERGENCE_START }, REFINEMENT, services))
		void done.promise.then(() => handle.cancel('aborted'))
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		const measurements = events.filter((e) => e.type === 'measurement')
		expect(measurements.map((e) => e.type === 'measurement' && e.measurement.valid)).toEqual([true, true, true, true, true])
		const last = measurements.at(-1)!
		if (last.type !== 'measurement' || !last.measurement.valid) throw new Error('no measurement')
		expect(toArcsec(Math.abs(last.measurement.error.azimuth - arcsec(5)))).toBeLessThan(2)
		expect(toArcsec(Math.abs(last.measurement.error.altitude - arcsec(-3)))).toBeLessThan(2)
		expect(last.convergence).toMatchObject({ streak: 4, converged: true })
		expect(measurements[0].type === 'measurement' && measurements[0].convergence.converged).toBeFalse()
		expect(rig.commands).toEqual([])
	})

	test('continues the streak of a resumed refinement', async () => {
		const rig = new FakeRig()
		rig.adjust(arcsec(4), arcsec(4))
		const run = await calibrated(rig)
		const operations = coordinator()
		const events: IPolarEvent[] = []
		const services: IPolarServices = { ...rig.services(), listener: (event) => (events.push(event), event.type === 'measurement' && void handle.cancel('aborted')) }
		const state = { convergence: { streak: 2, converged: false, last: timeUnix(rig.clock.wall / 1000) } }
		const handle = operations.start('session', [], (context) => runIPolarRefinement(context, CAMERA, rig.mount, run.mount, run.calibration, state, REFINEMENT, services, 7))
		await handle.result
		expect(events.find((e) => e.type === 'measurement')).toMatchObject({ frame: { index: 7 }, convergence: { streak: 3, converged: true } })
	})

	test('clears the streak on a frame that does not solve', async () => {
		const rig = new FakeRig()
		rig.adjust(arcsec(4), arcsec(4))
		const run = await calibrated(rig)
		const operations = coordinator()
		const streaks: number[] = []
		// Solves 1 and 2 calibrated; the fourth refinement frame (solve 6) does not solve.
		rig.unsolved = (index) => index === 6
		const services: IPolarServices = {
			...rig.services(),
			listener: (event) => {
				if (event.type !== 'measurement') return
				streaks.push(event.convergence.streak)
				if (streaks.length === 4) void handle.cancel('aborted')
			},
		}
		const handle = operations.start('session', [], (context) => runIPolarRefinement(context, CAMERA, rig.mount, run.mount, run.calibration, { convergence: IPOLAR_CONVERGENCE_START }, REFINEMENT, services))
		await handle.result
		expect(streaks).toEqual([1, 2, 3, 1])
	})

	test('fails when the calibration no longer matches, the mount moves or the frames stop solving', async () => {
		const rig = new FakeRig()
		const run = await calibrated(rig)
		expect(await runIPolarRefinement(coordinator(), CAMERA, rig.mount, run.mount, run.calibration, { convergence: IPOLAR_CONVERGENCE_START }, { ...REFINEMENT, capture: { ...CAPTURE, binX: 2, binY: 2 } }, rig.services())).toMatchObject({
			ok: false,
			reason: 'unexpectedState',
			error: expect.stringContaining('geometryMismatch'),
		})
		rig.unsolved = () => true
		expect(await runIPolarRefinement(coordinator(), CAMERA, rig.mount, run.mount, run.calibration, { convergence: IPOLAR_CONVERGENCE_START }, REFINEMENT, rig.services())).toMatchObject({ ok: false, reason: 'commandFailed' })
		rig.unsolved = () => false
		Object.assign(rig.mount, { pierSide: 'EAST' })
		expect(await runIPolarRefinement(coordinator(), CAMERA, rig.mount, run.mount, run.calibration, { convergence: IPOLAR_CONVERGENCE_START }, REFINEMENT, rig.services())).toMatchObject({ ok: false, error: expect.stringContaining('pier side') })
	})
})
