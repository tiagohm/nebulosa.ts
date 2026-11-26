import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { astapPlateSolve } from '../../../src/astrometry/solvers/astap'
import { type PlateSolution, plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP } from '../../../src/astrometry/wcs/fits.wcs'
import { angularDistance, equatorialFromJ2000, equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { timeUnix } from '../../../src/astronomy/time/time'
import type { MountCommander, MountCommandOptions } from '../../../src/devices/commanders/mount'
import type { RotatorCommander } from '../../../src/devices/commanders/rotator'
import type { Camera, Mount, MountTargetCoordinate, Rotator } from '../../../src/devices/indi/device'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay, type CooperativeJobHealth } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { type FitsHeader, isFits, readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { type Angle, deg, normalizeAngle, toArcsec, toDeg } from '../../../src/math/units/angle'
import type { CameraCaptureHooks, CameraCapturer, CameraCaptureResult } from '../../../src/observation/capture/capture'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'
import {
	type CenteringCaptureOptions,
	type CenteringCorrection,
	type CenteringFrame,
	type CenteringMeasurement,
	type CenteringOptions,
	type CenteringResult,
	type CenteringRotation,
	type CenteringRotationCheck,
	type CenteringServices,
	type CenteringSolver,
	type CenteringStep,
	type CenteringTarget,
	centerTarget,
	centeringCaptureRequest,
	centeringStalled,
	exposureMidpoint,
	plannedRotation,
	positionAngleError,
	responseCheck,
} from '../../../src/observation/mount/centering'
import { applyPointingOffset, computePointingError } from '../../../src/observation/mount/pointing'
import { isBinaryTestSkipped, waitUntil } from '../../util'
import { connectSimulatorRig, createSimulatorRig, ManualClock, RIG_INITIAL_POINTING, resetSimulatorRig } from '../../util/rig'

// Plate-solved centering as a reusable operation: the loop, the coordinate contract and the cooperative solver over
// fakes and a manual clock, then the auxiliary FITS of the real CameraCapturer on the INDI simulators, and a real ASTAP
// solve (binary tests only).

const CAPTURE: CenteringCaptureOptions = { exposureTime: 2, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const TARGET: CenteringTarget = { frame: 'J2000', rightAscension: deg(83.82), declination: deg(-5.39) }
const OPTIONS: CenteringOptions = { tolerance: deg(1 / 60), maximumAttempts: 3, settle: 0, syncMount: false, capture: CAPTURE, solveTimeout: 60, abortGrace: 5 }
// Smallest valid FITS: one header block.
const FITS_BLOCK = Buffer.from(`${'SIMPLE  =                    T'.padEnd(80)}${'BITPIX  =                    8'.padEnd(80)}${'NAXIS   =                    0'.padEnd(80)}${'END'.padEnd(80)}`.padEnd(2880))

// Equatorial TAN solution centered on (rightAscension, declination), radians, from a header `plateSolutionFrom` accepts.
function tanSolution(rightAscension: Angle, declination: Angle) {
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, RADESYS: 'ICRS', CRVAL1: toDeg(normalizeAngle(rightAscension)), CRVAL2: toDeg(declination), CRPIX1: 50.5, CRPIX2: 50.5, CD1_1: -1e-3, CD1_2: 0, CD2_1: 0, CD2_2: 1e-3, NAXIS1: 100, NAXIS2: 100 }
	return plateSolutionFrom(header)!
}

// Mount of the fake commander: where it believes it points (J2000) and the error of the sky from that, east and north
// offsets in the tangent plane, radians. A goTo moves where it believes it points; a sync redefines it, keeping the sky.
class FakeMount {
	readonly mount: Mount
	readonly commands: { readonly kind: 'goTo' | 'sync'; readonly target: MountTargetCoordinate<string | Angle>; readonly options: MountCommandOptions }[] = []
	reported: [Angle, Angle]
	error: { dx: number; dy: number }
	// Failure the next goTo returns.
	failGoTo?: OperationResult<never>
	// Whether goTo leaves the mount where it was.
	stuck = false

	// `wallNow` (Unix ms) is the instant of the first published position.
	constructor(reported: readonly [Angle, Angle], dx: number, dy: number, wallNow: number = Date.UTC(2026, 0, 1)) {
		this.reported = [...reported]
		this.error = { dx, dy }
		this.mount = { name: 'Fake Mount', connected: true, hasEquatorialCoordinate: true, equatorialCoordinate: { rightAscension: 0, declination: 0 } } as Mount
		this.#publish(timeUnix(wallNow / 1000))
	}

	// Where the sky really is, J2000.
	sky(): [Angle, Angle] {
		const { rightAscension, declination } = applyPointingOffset(this.reported[0], this.reported[1], this.error.dx, this.error.dy)
		return [rightAscension, declination]
	}

	readonly commander = {
		goTo: (_scope: OperationScope, _mount: Mount, target: MountTargetCoordinate<string | Angle>, options: MountCommandOptions = {}) => {
			this.commands.push({ kind: 'goTo', target, options })
			if (this.failGoTo !== undefined) return Promise.resolve(this.failGoTo)
			if (!this.stuck) {
				const { x, y } = target.J2000!
				this.reported = [x as Angle, y as Angle]
				this.#publish(options.time!)
			}
			return Promise.resolve(successfulOperationResult({ rightAscension: 0, declination: 0, pierSide: 'EAST' }))
		},
		sync: (_scope: OperationScope, _mount: Mount, target: MountTargetCoordinate<string | Angle>, options: MountCommandOptions = {}) => {
			this.commands.push({ kind: 'sync', target, options })
			const sky = this.sky()
			const { x, y } = target.J2000!
			this.reported = [x as Angle, y as Angle]
			const error = computePointingError(this.reported[0], this.reported[1], sky[0], sky[1])
			this.error = { dx: error.dx, dy: error.dy }
			this.#publish(options.time!)
			return Promise.resolve(successfulOperationResult(undefined))
		},
	} as unknown as MountCommander

	// Publishes the believed J2000 position as the equinox-of-date coordinate a mount reports.
	#publish(time: ReturnType<typeof timeUnix>) {
		const [rightAscension, declination] = equatorialFromJ2000(this.reported[0], this.reported[1], time)
		Object.assign(this.mount, { equatorialCoordinate: { rightAscension: normalizeAngle(rightAscension), declination } })
	}
}

// Behavior of the fake capturer for one capture.
interface FakeCaptureBehavior {
	readonly fail?: boolean
	// Writes the file, then waits for the cancellation of its scope.
	readonly hang?: boolean
}

// Capturer recording each request, writing the minimal FITS at the requested path and reporting the instants of the
// clock: Busy when it starts, Ok after `exposure` (applied by the test through the clock, or immediately).
function fakeCapturer(clock: ManualClock, behaviors: FakeCaptureBehavior[] = []) {
	const starts: { readonly request: CameraCaptureStart; readonly hooks?: CameraCaptureHooks; readonly signal: AbortSignal; resolved?: number }[] = []
	let order = 0

	const capturer = {
		start: (scope: OperationScope, _camera: Camera, request: CameraCaptureStart, hooks?: CameraCaptureHooks) => {
			const { signal } = scope as OperationContext
			const start: (typeof starts)[number] = { request, hooks, signal }
			starts.push(start)
			const behavior = behaviors.shift() ?? {}

			const result = (async (): Promise<OperationResult<CameraCaptureResult>> => {
				if (behavior.fail) return failedOperationResult('commandFailed', 'camera failed')
				const exposureStartedAt = clock.wallNow()
				const exposureStartedMonotonic = clock.monotonicNow()
				const path = join(request.outputPath!, request.outputName!)
				await Bun.write(path, FITS_BLOCK)

				if (behavior.hang) {
					if (!signal.aborted) {
						await new Promise((resolve) => {
							signal.addEventListener('abort', resolve, { once: true })
						})
					}
					return failedOperationResult('aborted')
				}

				start.resolved = ++order
				return successfulOperationResult({ frames: [{ operation: 'op', session: 's', generation: 1, camera: 'cam', path, exposureStartedAt, exposureStartedMonotonic, exposureFinishedAt: clock.wallNow(), exposureFinishedMonotonic: clock.monotonicNow() }], frameCount: 1 })
			})()

			return { id: 'capture', started: Promise.resolve(successfulOperationResult(undefined)), result, cancel: () => Promise.resolve() }
		},
	} as unknown as CameraCapturer

	return { capturer, starts, order: () => ++order }
}

// Solver over the fake sky: the solution centered where the sky is, after recording the frame it received.
function skySolver(sky: FakeMount, frames: CenteringFrame[] = []): CenteringSolver {
	return (frame) => {
		frames.push(frame)
		expect(isFits(readFileSync(frame.path))).toBeTrue()
		const [rightAscension, declination] = sky.sky()
		return Promise.resolve(tanSolution(rightAscension, declination))
	}
}

const CAMERA = { name: 'Fake Camera' } as Camera

interface Harness {
	readonly clock: ManualClock
	readonly directory: string
	readonly services: CenteringServices
	readonly starts: ReturnType<typeof fakeCapturer>['starts']
	readonly run: (options?: Partial<CenteringOptions>) => Promise<OperationResult<CenteringResult>>
}

// Centering over the fake sky, a fake capturer and a manual clock; auxiliary frames in a fresh directory.
function harness(sky: FakeMount, solver: CenteringSolver, behaviors: FakeCaptureBehavior[] = [], health?: CooperativeJobHealth): Harness {
	const clock = new ManualClock()
	const directory = mkdtempSync(join(tmpdir(), 'nebulosa-centering-'))
	const { capturer, starts } = fakeCapturer(clock, behaviors)
	const services: CenteringServices = { mountCommander: sky.commander, cameraCapturer: capturer, solver, auxiliaryPath: (attempt) => join(directory, `aux.${attempt}.fit`), clock, ...(health !== undefined && { solverHealth: health }) }
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const run = (options: Partial<CenteringOptions> = {}) => centerTarget(coordinator, sky.mount, CAMERA, TARGET, { ...OPTIONS, ...options }, services)
	return { clock, directory, services, starts, run }
}

// Expects a command time to be the UTC instant `wallNow` (Unix ms).
function expectInstant(time: MountCommandOptions['time'], wallNow: number) {
	const expected = timeUnix(wallNow / 1000)
	expect(time!.day).toBe(expected.day)
	expect(time!.fraction).toBeCloseTo(expected.fraction, 12)
	expect(time!.scale).toBe(expected.scale)
}

function arcsec(angle: Angle) {
	return toArcsec(angle)
}

describe('centering loop', () => {
	test('already centered on the first solution: nothing is commanded and the auxiliary frame is removed', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(2 / 3600), 0)
		const { run, directory, starts } = harness(sky, skySolver(sky))
		const result = await run()

		expect(result).toMatchObject({ ok: true, value: { attempts: 1 } })
		expect(arcsec((result as { value: CenteringResult }).value.separation)).toBeCloseTo(2, 3)
		expect(sky.commands).toEqual([])
		expect(starts).toHaveLength(1)
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()
	})

	test('a corrective slew of the J2000 offset at the wall instant, then a second solution verifies it', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), deg(-6 / 60), Date.UTC(2031, 5, 1))
		const { run, clock } = harness(sky, skySolver(sky))
		clock.jumpWall(Date.UTC(2031, 5, 1) - clock.wallNow())
		const result = await run()

		expect(result).toMatchObject({ ok: true, value: { attempts: 2 } })
		expect(arcsec((result as { value: CenteringResult }).value.separation)).toBeLessThan(5)
		expect(sky.commands).toHaveLength(1)
		const [goTo] = sky.commands
		expect(goTo.kind).toBe('goTo')
		// J2000 destination, never a pre-converted JNOW, converted at the wall instant of the clock (2031, not the host).
		expect(goTo.target.type).toBe('J2000')
		expectInstant(goTo.options.time, clock.wallNow())
		expect(goTo.options.tolerance).toBe(OPTIONS.tolerance)
		// The destination is the target moved against the measured error.
		const [dx, dy] = [deg(10 / 60), deg(-6 / 60)]
		const expected = applyPointingOffset(TARGET.rightAscension, TARGET.declination, -dx, -dy)
		expect(arcsec(angularDistance(goTo.target.J2000!.x as Angle, goTo.target.J2000!.y as Angle, expected.rightAscension, expected.declination))).toBeLessThan(3)
	})

	test('with sync the mount is synced to the solved center and sent to the target itself', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), deg(6 / 60))
		const solved = sky.sky()
		const { run, clock } = harness(sky, skySolver(sky))
		const result = await run({ syncMount: true })

		expect(result).toMatchObject({ ok: true, value: { attempts: 2 } })
		expect(sky.commands.map((command) => command.kind)).toEqual(['sync', 'goTo'])
		const [sync, goTo] = sky.commands
		expect(sync.target.type).toBe('J2000')
		expect(arcsec(angularDistance(sync.target.J2000!.x as Angle, sync.target.J2000!.y as Angle, solved[0], solved[1]))).toBeLessThan(1e-6)
		expect(goTo.target).toEqual({ type: 'J2000', J2000: { x: TARGET.rightAscension, y: TARGET.declination } })
		expectInstant(sync.options.time, clock.wallNow())
	})

	test('a mount that does not converge fails after maximumAttempts measured solutions', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		sky.stuck = true
		const { run, starts } = harness(sky, skySolver(sky))
		const result = await run()

		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(starts).toHaveLength(3)
		expect(sky.commands.filter((command) => command.kind === 'goTo')).toHaveLength(2)
	})

	test('a frame without solution consumes its attempt and commands nothing; none solving fails', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		const results: (PlateSolution | undefined)[] = [undefined, { ...tanSolution(0, 0), rightAscension: Number.NaN }]
		let calls = 0
		const solver: CenteringSolver = () => {
			calls++
			const next = results.shift()
			return next === undefined && calls === 3 ? Promise.reject(new Error('no stars')) : Promise.resolve(next)
		}
		const { run, directory } = harness(sky, solver)
		const result = await run()

		expect(result).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(calls).toBe(3)
		expect(sky.commands).toEqual([])
		for (const attempt of [1, 2, 3]) expect(existsSync(join(directory, `aux.${attempt}.fit`))).toBeFalse()
	})

	test('no correction allowed only measures: nothing is commanded, even far from the target', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(5), 0)
		const { run, starts } = harness(sky, skySolver(sky))
		const result = await run({ maximumCorrections: 0 })

		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(starts).toHaveLength(1)
		expect(sky.commands).toEqual([])
	})

	test('measuring repeats a frame without a solution and still commands nothing', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const results = [undefined, tanSolution(...sky.sky())]
		const { run, starts } = harness(sky, () => Promise.resolve(results.shift()))

		expect(await run({ maximumCorrections: 0 })).toMatchObject({ ok: true, value: { attempts: 2 } })
		expect(starts).toHaveLength(2)
		expect(sky.commands).toEqual([])
	})

	test('the corrections are bounded apart from the attempts', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		sky.stuck = true
		const { run, starts } = harness(sky, skySolver(sky))

		expect(await run({ maximumAttempts: 6, maximumCorrections: 2 })).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(sky.commands).toHaveLength(2)
		expect(starts).toHaveLength(3)
	})

	test('frames in a row without a solution end the centering before its attempts run out', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		const { run, starts } = harness(sky, () => Promise.resolve(undefined))

		expect(await run({ maximumAttempts: 6, maximumUnsolved: 2 })).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(starts).toHaveLength(2)
		expect(sky.commands).toEqual([])
	})

	test('a solved frame resets the frames without a solution in a row', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), 0)
		const results: (PlateSolution | undefined)[] = [undefined, tanSolution(...sky.sky()), undefined]
		const solver: CenteringSolver = () => Promise.resolve(results.length > 0 ? results.shift() : tanSolution(...sky.sky()))
		const { run } = harness(sky, solver)

		expect(await run({ maximumAttempts: 4, maximumUnsolved: 2 })).toMatchObject({ ok: true, value: { attempts: 4 } })
		expect(sky.commands).toHaveLength(1)
	})

	test('corrections that do not shrink the distance end the centering at the stall limit', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		sky.stuck = true
		const { run, starts } = harness(sky, skySolver(sky))

		expect(await run({ maximumAttempts: 6, stallLimit: 2 })).toMatchObject({ ok: false, reason: 'unexpectedState', error: 'the distance to the target did not shrink in 2 corrections' })
		expect(starts).toHaveLength(3)
		expect(sky.commands).toHaveLength(2)
	})

	test('a shrinking distance resets the stall', () => {
		expect(centeringStalled(undefined, 1)).toBeFalse()
		expect(centeringStalled(2, 1)).toBeFalse()
		expect(centeringStalled(1, 1)).toBeTrue()
		expect(centeringStalled(1, 2)).toBeTrue()
	})

	test('the observer sees every step and measurement, and the last measurement of a failure', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), deg(-1))
		sky.stuck = true
		const { services, run } = harness(sky, skySolver(sky))
		const steps: string[] = []
		const measurements: CenteringMeasurement[] = []
		Object.assign(services, { observer: { step: (step: CenteringStep, attempt: number) => steps.push(`${step} ${attempt}`), measured: (measurement: CenteringMeasurement) => measurements.push(measurement) } })

		expect(await run({ maximumAttempts: 2 })).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(steps).toEqual(['exposing 1', 'solving 1', 'correcting 1', 'settling 1', 'exposing 2', 'solving 2'])
		expect(measurements.map(({ attempt }) => attempt)).toEqual([1, 2])
		expect(toDeg(measurements[1].dx!)).toBeCloseTo(1, 3)
		expect(toDeg(measurements[1].dy!)).toBeCloseTo(-1, 3)
		expect(toDeg(measurements[1].separation!)).toBeCloseTo(Math.SQRT2, 3)
	})

	test('a frame without a solution is measured with its attempt alone', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const { services, run } = harness(sky, () => Promise.resolve(undefined))
		const measurements: CenteringMeasurement[] = []
		Object.assign(services, { observer: { measured: (measurement: CenteringMeasurement) => measurements.push(measurement) } })

		await run({ maximumAttempts: 1 })
		expect(measurements).toEqual([{ attempt: 1 }])
	})

	test('a correction the observer refuses commands nothing and fails with its text', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), 0)
		const { services, run } = harness(sky, skySolver(sky))
		const corrections: CenteringCorrection[] = []
		const beforeCorrection = (correction: CenteringCorrection) => {
			corrections.push(correction)
			return 'below the horizon'
		}
		Object.assign(services, { observer: { beforeCorrection } })

		expect(await run({ syncMount: false })).toMatchObject({ ok: false, reason: 'unexpectedState', error: 'below the horizon' })
		expect(sky.commands).toEqual([])
		expect(corrections).toHaveLength(1)
		const expected = applyPointingOffset(TARGET.rightAscension, TARGET.declination, -deg(10 / 60), 0)
		expect(corrections[0].rotator).toBeUndefined()
		expect(arcsec(angularDistance(corrections[0].mount!.rightAscension, corrections[0].mount!.declination, expected.rightAscension, expected.declination))).toBeLessThan(3)
	})

	test('a refused correction with sync neither syncs nor slews', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), 0)
		const { services, run } = harness(sky, skySolver(sky))
		Object.assign(services, { observer: { beforeCorrection: () => 'refused' } })

		expect(await run({ syncMount: true })).toMatchObject({ ok: false, error: 'refused' })
		expect(sky.commands).toEqual([])
	})

	test('the capture listener of the observer reaches every auxiliary capture', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const { services, run, starts } = harness(sky, skySolver(sky))
		const captureListener = () => {}
		Object.assign(services, { observer: { captureListener } })

		await run()
		expect(starts[0].hooks?.listener).toBe(captureListener)
	})

	test('camera and mount failures end the centering with their failure', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(1), 0)
		let calls = 0
		const counting: CenteringSolver = (frame, signal) => {
			calls++
			return skySolver(sky)(frame, signal)
		}

		const camera = harness(sky, counting, [{ fail: true }])
		expect(await camera.run()).toMatchObject({ ok: false, reason: 'commandFailed', error: 'camera failed' })
		expect(calls).toBe(0)

		sky.failGoTo = failedOperationResult('alert', 'slew limit')
		const mount = harness(sky, counting)
		expect(await mount.run()).toMatchObject({ ok: false, reason: 'alert', error: 'slew limit' })
		expect(calls).toBe(1)
	})

	test('the J2000 target is compared directly with the solution; the exposure midpoint never moves it', async () => {
		// @ts-expect-error a JNOW target is not accepted: the caller converts it first.
		const jnow: CenteringTarget = { frame: 'JNOW', rightAscension: 0, declination: 0 }
		expect(jnow).toEqual({ frame: 'JNOW', rightAscension: 0, declination: 0 } as never)

		const destinations: unknown[] = []

		for (const shift of [0, 3_600_000]) {
			// The mount publishes its first position at the shifted wall clock, as a real one reports it when read.
			const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(5 / 60), 0, Date.UTC(2026, 0, 1) + shift)
			const frames: CenteringFrame[] = []
			const { run, clock } = harness(sky, skySolver(sky, frames))
			clock.jumpWall(shift)
			expect(await run()).toMatchObject({ ok: true })
			destinations.push(sky.commands[0].target)
			expect(frames[0].observedAt).toBe(Date.UTC(2026, 0, 1) + shift + 1000)
		}

		const [a, b] = destinations as MountTargetCoordinate<Angle>[]
		expect(arcsec(angularDistance(a.J2000!.x, a.J2000!.y, b.J2000!.x, b.J2000!.y))).toBeLessThan(1e-3)
	})

	test('the midpoint is the first Busy plus half the requested exposure, not the mean with the end', () => {
		const frame = { exposureStartedAt: 1_000_000, exposureFinishedAt: 1_000_000 + 9000 }
		expect(exposureMidpoint(frame, { exposureTime: 4, exposureTimeUnit: 'second' })).toBe(1_002_000)
		expect(exposureMidpoint(frame, { exposureTime: 500_000, exposureTimeUnit: 'microsecond' })).toBe(1_000_250)
		// A wall step after the Busy changes the end the driver reports, never the midpoint.
		expect(exposureMidpoint({ exposureStartedAt: 1_000_000 }, { exposureTime: 4, exposureTimeUnit: 'second' })).toBe(1_002_000)
	})

	test('right ascension wraps at 0/2π and the pole keeps a finite separation', async () => {
		const wrapping: CenteringTarget = { frame: 'J2000', rightAscension: deg(0.001), declination: deg(10) }
		const sky = new FakeMount([deg(359.999), deg(10)], 0, 0)
		const clock = new ManualClock()
		const directory = mkdtempSync(join(tmpdir(), 'nebulosa-centering-'))
		const services: CenteringServices = { mountCommander: sky.commander, cameraCapturer: fakeCapturer(clock).capturer, solver: skySolver(sky), auxiliaryPath: (attempt) => join(directory, `wrap.${attempt}.fit`), clock }
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		const result = await centerTarget(coordinator, sky.mount, CAMERA, wrapping, { ...OPTIONS, tolerance: deg(0.01) }, services)
		expect(result).toMatchObject({ ok: true, value: { attempts: 1 } })
		expect(toDeg((result as { value: CenteringResult }).value.separation)).toBeCloseTo(0.002 * Math.cos(deg(10)), 5)

		const pole: CenteringTarget = { frame: 'J2000', rightAscension: deg(120), declination: deg(90) }
		const polar = new FakeMount([deg(300), deg(89.99)], 0, 0)
		const polarServices = { ...services, mountCommander: polar.commander, solver: skySolver(polar) }
		const near = await centerTarget(coordinator, polar.mount, CAMERA, pole, { ...OPTIONS, tolerance: deg(0.02) }, polarServices)
		expect(near).toMatchObject({ ok: true })
		expect(Number.isFinite((near as { value: CenteringResult }).value.separation)).toBeTrue()
		expect(toDeg((near as { value: CenteringResult }).value.separation)).toBeCloseTo(0.01, 5)
	})

	test('cancellation during the capture removes the auxiliary frame', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const { services, directory } = harness(sky, skySolver(sky), [{ hang: true }])
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		const handle = coordinator.start('caller', [], (context) => centerTarget(context, sky.mount, CAMERA, TARGET, OPTIONS, services))

		await waitUntil(() => existsSync(join(directory, 'aux.1.fit')), 5000, 5)
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()
	})

	test('the M101 solution corrects to its real center, never to CRVAL (I39)', async () => {
		const header: FitsHeader = {
			CTYPE1: RA_TAN_SIP,
			CTYPE2: DEC_TAN_SIP,
			EQUINOX: 2000,
			CRVAL1: 211.789996831,
			CRVAL2: 54.3250783745,
			CRPIX1: 6844.54215495,
			CRPIX2: 2924.71455892,
			CD1_1: 0.00024098759167,
			CD1_2: -5.0386872296e-5,
			CD2_1: 5.05049438425e-5,
			CD2_2: 0.000241100662196,
			IMAGEW: 9176,
			IMAGEH: 6870,
			A_ORDER: 2,
			A_0_2: -1.19977665955e-8,
			A_1_1: 3.64583422462e-7,
			A_2_0: 4.56030084803e-8,
			B_ORDER: 2,
			B_0_2: 6.99507235566e-8,
			B_1_1: 1.19143632657e-7,
			B_2_0: -1.51089049833e-8,
		}
		const solution = plateSolutionFrom(header)!
		const target: CenteringTarget = { frame: 'J2000', rightAscension: deg(211), declination: deg(54) }
		const sky = new FakeMount([target.rightAscension, target.declination], 0, 0)
		const { services } = harness(sky, () => Promise.resolve(solution))
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		await centerTarget(coordinator, sky.mount, CAMERA, target, { ...OPTIONS, syncMount: true, maximumAttempts: 2 }, services)

		const sync = sky.commands.find((command) => command.kind === 'sync')!
		// Astropy 7.1.0 center of the image (see platesolver.test.ts), not CRVAL 211.79°.
		expect(toDeg(sync.target.J2000!.x as Angle)).toBeCloseTo(210.8134, 3)
		expect(toDeg(sync.target.J2000!.y as Angle)).toBeCloseTo(54.3303, 3)
	})

	test('auxiliary capture request: one FITS frame at the exact path, the camera settings, the mount snooped', () => {
		const request = centeringCaptureRequest(CAPTURE, join('aux', 'centering', 'run.1.fit'), { name: 'Mount Simulator' })
		expect(request).toMatchObject({ ...CAPTURE, exposureMode: 'single', count: 1, delay: 0, transferFormat: 'FITS', autoSave: true, autoSubFolderMode: 'off', outputPath: join('aux', 'centering'), outputName: 'run.1.fit', mount: 'Mount Simulator' })
		expect(request.publishPath).toBeUndefined()

		// @ts-expect-error the transfer format is fixed to FITS, never configured.
		const options: CenteringCaptureOptions = { ...CAPTURE, transferFormat: 'XISF' }
		expect(options.exposureTime).toBe(2)
	})
})

// Equatorial TAN solution centered on (rightAscension, declination), radians, whose image top points at `positionAngle`
// (radians, from north through east), with the handedness of tanSolution, or the mirrored one.
function orientedSolution(rightAscension: Angle, declination: Angle, positionAngle: Angle, mirrored: boolean = false) {
	const s = 1e-3
	const cos = Math.cos(positionAngle)
	const sin = Math.sin(positionAngle)
	// +X runs along u, +Y along v, both (east, north); the image top is −v.
	const u = mirrored ? [-cos, sin] : [cos, -sin]
	const v = [-sin, -cos]
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, RADESYS: 'ICRS', CRVAL1: toDeg(normalizeAngle(rightAscension)), CRVAL2: toDeg(declination), CRPIX1: 50.5, CRPIX2: 50.5, CD1_1: s * u[0], CD2_1: s * u[1], CD1_2: s * v[0], CD2_2: s * v[1], NAXIS1: 100, NAXIS2: 100 }
	return plateSolutionFrom(header)!
}

// Rotator of the fake commander: its mechanical angle, the moves commanded, and a failure for the next one.
class FakeRotator {
	readonly rotator: Rotator
	readonly moves: number[] = []
	failMove?: OperationResult<never>

	constructor(angle: number, min: number = 0, max: number = 360) {
		this.rotator = { name: 'Fake Rotator', connected: true, moving: false, angle: { value: angle, min, max, step: 0.01 } } as Rotator
	}

	get angle() {
		return this.rotator.angle.value
	}

	readonly commander = {
		moveTo: (_scope: OperationScope, _rotator: Rotator, angle: number) => {
			if (this.failMove !== undefined) return Promise.resolve(this.failMove)
			this.moves.push(angle)
			Object.assign(this.rotator.angle, { value: angle })
			return Promise.resolve(successfulOperationResult(undefined))
		},
	} as unknown as RotatorCommander
}

// Field of a camera on a rotator: PA of the image top = sense·M + offset, in degrees, when coupled, else the offset
// alone; the center shifts with the rotation by `pivot` radians about the rotator axis.
interface RotatingField {
	readonly sense: 1 | -1
	readonly offset: number
	readonly pivot?: number
	readonly coupled?: boolean
	readonly mirrored?: boolean
}

// Solver over the fake sky and the fake rotator.
function rotatingSolver(sky: FakeMount, rotator: FakeRotator, field: RotatingField): CenteringSolver {
	const initial = rotator.angle
	return () => {
		const [rightAscension, declination] = sky.sky()
		const pivot = field.pivot ?? 0
		const m = deg(rotator.angle)
		const m0 = deg(initial)
		const center = applyPointingOffset(rightAscension, declination, pivot * (Math.cos(m) - Math.cos(m0)), pivot * (Math.sin(m) - Math.sin(m0)))
		const positionAngle = field.coupled === false ? field.offset : field.sense * rotator.angle + field.offset
		return Promise.resolve(orientedSolution(center.rightAscension, center.declination, deg(positionAngle), field.mirrored))
	}
}

// Centering with an orientation over the fake sky, a fake rotator and a manual clock.
function rotationHarness(sky: FakeMount, rotator: FakeRotator, field: RotatingField) {
	const base = harness(sky, rotatingSolver(sky, rotator, field))
	const steps: string[] = []
	const checks: CenteringRotationCheck[] = []
	const corrections: CenteringCorrection[] = []
	const measurements: CenteringMeasurement[] = []
	let unreachable = 0
	const services: CenteringServices = {
		...base.services,
		rotatorCommander: rotator.commander,
		observer: {
			step: (step, attempt) => steps.push(`${step} ${attempt}`),
			measured: (measurement) => measurements.push(measurement),
			rotationChecked: (check) => checks.push(check),
			rotationUnreachable: () => unreachable++,
			beforeCorrection: (correction) => {
				corrections.push(correction)
				return undefined
			},
		},
	}
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const run = (positionAngle: number, options: Partial<CenteringOptions> = {}, rotation: Partial<CenteringRotation> | false = {}) =>
		centerTarget(coordinator, sky.mount, CAMERA, TARGET, { ...OPTIONS, maximumAttempts: 6, orientation: { positionAngle: deg(positionAngle), tolerance: deg(0.5), halfTurn: true }, ...(rotation !== false && { rotation: { rotator: rotator.rotator, ...rotation } }), ...options }, services)
	return { run, steps, checks, corrections, measurements, unreachable: () => unreachable, starts: base.starts }
}

describe('centering with a rotator', () => {
	test('a known sense turns once by the error and the next frame verifies both axes', async () => {
		for (const sense of [1, -1] as const) {
			const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
			const rotator = new FakeRotator(100)
			const { run, checks, measurements, steps } = rotationHarness(sky, rotator, { sense, offset: -30 })
			// PA now: sense·100 − 30; requested 50° away from it.
			const requested = sense * 100 - 30 + 50
			const result = await run(normalizeDegrees(requested), {}, { sense: { value: sense } })

			expect(result).toMatchObject({ ok: true, value: { attempts: 2, sense } })
			expectMoves(rotator.moves, [100 + sense * 50])
			expect(toDeg((result as { value: CenteringResult }).value.positionAngleError!)).toBeCloseTo(0, 3)
			expect(checks).toMatchObject([{ attempt: 2, sense, source: 'confirmed' }])
			expect(checks[0].gain).toBeCloseTo(1, 3)
			expectMoves(
				measurements.map(({ rotatorAngle }) => rotatorAngle!),
				[100, 100 + sense * 50],
			)
			expect(steps).toEqual(['exposing 1', 'solving 1', 'rotating 1', 'settling 1', 'exposing 2', 'solving 2'])
			expect(sky.commands).toEqual([])
		}
	})

	test('an unknown sense is probed, learned, and then corrected with at most one extra rotation', async () => {
		for (const sense of [1, -1] as const) {
			const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
			const rotator = new FakeRotator(100)
			const { run, checks } = rotationHarness(sky, rotator, { sense, offset: 20 })
			const result = await run(normalizeDegrees(sense * 100 + 20 + 40))

			expect(result).toMatchObject({ ok: true, value: { attempts: 3, sense } })
			// The probe turns 10° the way of the error, then the learned sense finishes the move.
			expect(rotator.moves).toHaveLength(2)
			expect(rotator.moves[0]).toBe(110)
			expect(rotator.moves[1]).toBeCloseTo(100 + sense * 40, 6)
			expect(checks.map(({ source, sense }) => [source, sense])).toEqual([
				['learned', sense],
				['confirmed', sense],
			])
		}
	})

	test('a stored sense the field contradicts is relearned and the centering goes on', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const rotator = new FakeRotator(100)
		const { run, checks } = rotationHarness(sky, rotator, { sense: -1, offset: 0 })
		const result = await run(normalizeDegrees(-100 + 30), {}, { sense: { value: 1 } })

		expect(result).toMatchObject({ ok: true, value: { sense: -1 } })
		expect(checks[0]).toMatchObject({ source: 'relearned', sense: -1 })
	})

	test('a stored sense learned with the other parity is discarded and probed', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const rotator = new FakeRotator(100)
		const { run, checks } = rotationHarness(sky, rotator, { sense: 1, offset: 0 })
		const parity = orientedSolution(0, 0, 0).parity
		const result = await run(140, {}, { sense: { value: 1, parity: parity === 'NORMAL' ? 'FLIPPED' : 'NORMAL' } })

		expect(result).toMatchObject({ ok: true, value: { sense: 1 } })
		expect(rotator.moves[0]).toBe(110)
		expect(checks[0]).toMatchObject({ source: 'learned', parity })
	})

	test('with halfTurn the shorter of θ and θ + 180° is reached; without it the full error is turned', async () => {
		const near = new FakeRotator(100)
		const half = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), near, { sense: 1, offset: 0 })
		expect(await half.run(270, {}, { sense: { value: 1 } })).toMatchObject({ ok: true })
		expectMoves(near.moves, [90])

		const far = new FakeRotator(100)
		const full = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), far, { sense: 1, offset: 0 })
		const result = await full.run(270, { orientation: { positionAngle: deg(270), tolerance: deg(0.5), halfTurn: false } }, { sense: { value: 1 } })
		expect(result).toMatchObject({ ok: true })
		expectMoves(far.moves, [270])
	})

	test('a direction past 360° is commanded as its representative inside the limits', async () => {
		const rotator = new FakeRotator(355)
		const { run } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: 1, offset: 0 })
		expect(await run(15, { orientation: { positionAngle: deg(15), tolerance: deg(0.5), halfTurn: false } }, { sense: { value: 1 } })).toMatchObject({ ok: true })
		expectMoves(rotator.moves, [15])
	})

	test('an orientation outside the rotator limits fails before any motion', async () => {
		for (const sense of [{ value: 1 as const }, undefined]) {
			const rotator = new FakeRotator(45, 0, 90)
			const { run, unreachable } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: 1, offset: 0 })
			const result = await run(195, { orientation: { positionAngle: deg(195), tolerance: deg(0.5), halfTurn: false } }, { sense })

			expect(result).toMatchObject({ ok: false, reason: 'unexpectedState' })
			expect((result as { error: string }).error).toContain('outside the limits')
			expect(rotator.moves).toEqual([])
			expect(unreachable()).toBe(1)
		}
	})

	test('a rotator that does not turn the field fails after its first rotation', async () => {
		const rotator = new FakeRotator(100)
		const { run, starts } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: 1, offset: 0, coupled: false })
		const result = await run(40)

		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect((result as { error: string }).error).toContain('did not turn')
		expect(rotator.moves).toHaveLength(1)
		expect(starts).toHaveLength(2)
	})

	test('position and orientation off in one iteration: the rotation comes first, then the slew, and the pivot shift is corrected', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(10 / 60), 0)
		const rotator = new FakeRotator(100)
		const { run, steps, corrections } = rotationHarness(sky, rotator, { sense: 1, offset: 0, pivot: deg(2 / 60) })
		const result = await run(160, {}, { sense: { value: 1 } })

		expect(result).toMatchObject({ ok: true })
		expect(steps.slice(0, 4)).toEqual(['exposing 1', 'solving 1', 'rotating 1', 'correcting 1'])
		expect(corrections[0].rotator).toEqual({ from: 100, to: 160 })
		expect(corrections[0].mount).toBeDefined()
		expect(toDeg(corrections[0].positionAngleError!)).toBeCloseTo(60, 3)
	})

	test('only measuring reports the orientation and commands nothing', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const rotator = new FakeRotator(100)
		const { run, measurements } = rotationHarness(sky, rotator, { sense: 1, offset: 0 })

		expect(await run(130, { maximumCorrections: 0 })).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(toDeg(measurements[0].positionAngle!)).toBeCloseTo(100, 3)
		expect(toDeg(measurements[0].positionAngleError!)).toBeCloseTo(30, 3)
		expect(rotator.moves).toEqual([])
		expect(sky.commands).toEqual([])

		expect(await run(100.2, { maximumCorrections: 0 })).toMatchObject({ ok: true, value: { attempts: 1 } })
	})

	test('an orientation without a rotator is measured, and a wrong one fails at once', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const rotator = new FakeRotator(100)
		const { run, starts } = rotationHarness(sky, rotator, { sense: 1, offset: 0 })
		const result = await run(130, {}, false)

		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect((result as { error: string }).error).toContain('no rotator')
		expect(starts).toHaveLength(1)
	})

	test('a failed or cancelled rotation ends the centering with its failure', async () => {
		const rotator = new FakeRotator(100)
		rotator.failMove = failedOperationResult('aborted')
		const { run } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: 1, offset: 0 })
		expect(await run(130, {}, { sense: { value: 1 } })).toMatchObject({ ok: false, reason: 'aborted' })
	})

	test('the auxiliary frames snoop the rotator', async () => {
		const rotator = new FakeRotator(100)
		const { run, starts } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: 1, offset: 0 })
		await run(100)
		expect(starts[0].request.rotator).toBe('Fake Rotator')
		expect(centeringCaptureRequest(CAPTURE, 'a.fit', { name: 'M' }).rotator).toBeUndefined()
	})

	test('a mirrored field rotates the other way and is learned as such', async () => {
		const rotator = new FakeRotator(100)
		const { run, checks } = rotationHarness(new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0), rotator, { sense: -1, offset: 0, mirrored: true })
		expect(await run(normalizeDegrees(-100 + 30))).toMatchObject({ ok: true, value: { sense: -1 } })
		expect(checks[0].parity).toBe(orientedSolution(0, 0, 0, true).parity)
	})
})

describe('rotation planning', () => {
	test('the PA error wraps to a half turn or a whole turn', () => {
		expect(toDeg(positionAngleError(deg(10), deg(350), false))).toBeCloseTo(20, 9)
		expect(toDeg(positionAngleError(deg(350), deg(10), false))).toBeCloseTo(-20, 9)
		expect(toDeg(positionAngleError(deg(190), deg(10), true))).toBeCloseTo(0, 9)
		expect(toDeg(positionAngleError(deg(100), deg(0), true))).toBeCloseTo(-80, 9)
		expect(toDeg(positionAngleError(deg(90), deg(0), true))).toBeCloseTo(90, 9)
		expect(toDeg(positionAngleError(deg(180), deg(0), false))).toBeCloseTo(180, 9)
	})

	test('the response check learns, confirms, reverses, is inconclusive for a tiny rotation, and fails without response', () => {
		expect(responseCheck(2, 9.9, 10, undefined, 'NORMAL')).toMatchObject({ sense: 1, source: 'learned' })
		expect(responseCheck(2, -10.1, 10, 1, 'NORMAL')).toMatchObject({ sense: -1, source: 'relearned' })
		expect(responseCheck(2, -10.1, 10, -1, 'NORMAL')).toMatchObject({ sense: -1, source: 'confirmed' })
		expect(responseCheck(2, 0.2, 0.3, 1, 'NORMAL')).toBe('inconclusive')
		expect(responseCheck(2, 0, 10, undefined, 'NORMAL')).toBeUndefined()
		expect(responseCheck(2, 5, 10, 1, 'NORMAL')).toBeUndefined()
	})

	test('a partial range keeps the reachable candidate, and the probe turns the other way when it must', () => {
		const rotator = { angle: { value: 0, min: -90, max: 90, step: 0.01 } } as Rotator
		expect(plannedRotation(rotator, 80, 30, false, 1, { minimum: 2, maximum: 10 })).toBeUndefined()
		expect(plannedRotation(rotator, 80, 30, true, 1, { minimum: 2, maximum: 10 })).toBeCloseTo(-70, 9)
		expect(plannedRotation(rotator, 85, 30, true, undefined, { minimum: 2, maximum: 10 })).toBeCloseTo(75, 9)
		expect(plannedRotation(rotator, 0, 1, true, undefined, { minimum: 2, maximum: 10 })).toBeCloseTo(2, 9)
	})
})

// Degrees wrapped to [0, 360).
function normalizeDegrees(value: number) {
	return ((value % 360) + 360) % 360
}

test('I46: the centering imports no solver, star detector or binding and creates no Worker', async () => {
	const root = join(dirname(dirname(dirname(__dirname))), 'src', 'observation')
	const text = readFileSync(join(root, 'mount', 'centering.ts'), 'utf8')
	const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1])
	expect(imports.filter((path) => /solvers\/(?!platesolver$)|bindings\/|imaging\/stars\//.test(path))).toEqual([])
	expect(text).not.toMatch(/new Worker\b/)

	// The centering itself never reaches for a Worker.
	const worker = spyOn(globalThis, 'Worker')
	const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], deg(5 / 60), 0)
	const { run } = harness(sky, skySolver(sky))
	expect(await run()).toMatchObject({ ok: true })
	expect(worker).not.toHaveBeenCalled()
	worker.mockRestore()
})

describe('cooperative solve', () => {
	// Solver that ignores its signal and ends only when released.
	function stubbornSolver(sky: FakeMount) {
		const pending: { readonly frame: CenteringFrame; readonly signal: AbortSignal; readonly release: VoidFunction }[] = []
		const solver: CenteringSolver = (frame, signal) => {
			const { promise, resolve } = Promise.withResolvers<PlateSolution | undefined>()
			pending.push({ frame, signal, release: () => resolve(tanSolution(...sky.sky())) })
			return promise
		}
		return { solver, pending }
	}

	test('a timed-out solve is awaited to its end before the frame is removed; within the grace nothing faults', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const { solver, pending } = stubbornSolver(sky)
		const health: CooperativeJobHealth = { faulted: false }
		const { run, clock, directory } = harness(sky, solver, [], health)
		let result: OperationResult<CenteringResult> | undefined
		void run().then((value) => (result = value))

		await waitUntil(() => pending.length === 1, 5000, 5)
		await clock.advance(60_000)
		expect(pending[0].signal.aborted).toBeTrue()
		await clock.advance(2000)
		// The solver still runs: the frame stays where it is.
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeTrue()
		expect(result).toBeUndefined()

		pending[0].release()
		await waitUntil(() => result !== undefined, 5000, 5)
		expect(result).toMatchObject({ ok: false, reason: 'timeout' })
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()
		expect(health.faulted).toBeFalse()
		expect(clock.pending).toBe(0)
	})

	test('a solve that outlives its grace is reported once, faults the solver when it ends, and is never called again (18f)', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const { solver, pending } = stubbornSolver(sky)
		const reports: string[] = []
		const health: CooperativeJobHealth = { faulted: false, onUnresponsive: () => reports.push('unresponsive'), onFaulted: () => reports.push('faulted') }
		const { run, clock, directory } = harness(sky, solver, [], health)
		let result: OperationResult<CenteringResult> | undefined
		void run().then((value) => (result = value))

		await waitUntil(() => pending.length === 1, 5000, 5)
		await clock.advance(60_000 + 4999)
		expect(reports).toEqual([])
		await clock.advance(1)
		expect(reports).toEqual(['unresponsive'])
		await clock.advance(3_600_000)
		expect(result).toBeUndefined()
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeTrue()

		pending[0].release()
		await waitUntil(() => result !== undefined, 5000, 5)
		expect(result).toMatchObject({ ok: false, reason: 'timeout' })
		expect(reports).toEqual(['unresponsive', 'faulted'])
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()

		const next = await run()
		expect(next).toMatchObject({ ok: false, reason: 'unexpectedState', error: 'the plate solver is faulted' })
		expect(pending).toHaveLength(1)
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()
	})

	test('cancelling the centering aborts the solve with the signal of the centering operation', async () => {
		const sky = new FakeMount([TARGET.rightAscension, TARGET.declination], 0, 0)
		const signals: AbortSignal[] = []
		const solver: CenteringSolver = (_, signal) => {
			signals.push(signal)
			return new Promise((_, reject) => {
				signal.addEventListener('abort', () => reject(new Error('killed')), { once: true })
			})
		}
		const { services, directory, starts } = harness(sky, solver)
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		const handle = coordinator.start('caller', [], (context) => centerTarget(context, sky.mount, CAMERA, TARGET, OPTIONS, services))

		await waitUntil(() => signals.length === 1, 5000, 5)
		// Not the signal of the capture, which already ended.
		expect(signals[0]).not.toBe(starts[0].signal)
		expect(starts[0].signal.aborted).toBeFalse()
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(signals[0].aborted).toBeTrue()
		expect(existsSync(join(directory, 'aux.1.fit'))).toBeFalse()
	})
})

// Rig of the simulator scenarios, created once for the file.
const rig = await createSimulatorRig()

describe('on the simulator rig', () => {
	const directory = join(rig.capturesDir, 'auxiliary', 'centering')
	const clock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }

	beforeAll(async () => {
		await connectSimulatorRig(rig)
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		mkdirSync(directory, { recursive: true })
	})

	afterAll(async () => {
		await rig[Symbol.asyncDispose]()
	})

	// J2000 coordinate the camera simulator stamps into a frame (RA/DEC keywords), in radians.
	async function stampedCenter(path: string): Promise<[Angle, Angle]> {
		const fits = await readFits(bufferSource(readFileSync(path)))
		const { header } = fits!.hdus[0]
		return [deg(header.RA as number), deg(header.DEC as number)]
	}

	// Solver over the files of the simulator: the stamped center moved by a fixed error of the mount, east 6′.
	function fileSolver(calls: { readonly frame: CenteringFrame; readonly signal: AbortSignal; readonly size: number }[]): CenteringSolver {
		return async (frame, signal) => {
			calls.push({ frame, signal, size: statSync(frame.path).size })
			expect(typeof frame.path).toBe('string')
			expect(isFits(readFileSync(frame.path))).toBeTrue()
			const [rightAscension, declination] = await stampedCenter(frame.path)
			const sky = applyPointingOffset(rightAscension, declination, deg(6 / 60), 0)
			return tanSolution(sky.rightAscension, sky.declination)
		}
	}

	function servicesOf(solver: CenteringSolver, name: string): CenteringServices {
		return { mountCommander: rig.commanders.mount, cameraCapturer: rig.capturer, solver, auxiliaryPath: (attempt) => join(directory, `${name}.${attempt}.fit`), clock }
	}

	// Target where the rig points, J2000 at the mount clock.
	function rigTarget(): CenteringTarget {
		const [rightAscension, declination] = equatorialToJ2000(RIG_INITIAL_POINTING.rightAscension, RIG_INITIAL_POINTING.declination, timeUnix(clock.wallNow() / 1000))
		return { frame: 'J2000', rightAscension: normalizeAngle(rightAscension), declination }
	}

	const OPTIONS_RIG: CenteringOptions = { ...OPTIONS, capture: { ...CAPTURE, exposureTime: 10, exposureTimeUnit: 'millisecond' }, tolerance: deg(1 / 60), maximumAttempts: 3 }

	test('auxiliary frames are FITS files of the real capturer, solved after the capture result and corrected by a real slew', async () => {
		const { mount, camera } = rig.devices()
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		const calls: { readonly frame: CenteringFrame; readonly signal: AbortSignal; readonly size: number }[] = []
		const starts: { readonly request: CameraCaptureStart; readonly signal: AbortSignal; resolvedBefore?: number }[] = []
		const start = rig.capturer.start.bind(rig.capturer)
		const spy = spyOn(rig.capturer, 'start').mockImplementation((scope, device, request, hooks) => {
			const handle = start(scope, device, request, hooks)
			const entry: (typeof starts)[number] = { request, signal: (scope as OperationContext).signal }
			starts.push(entry)
			void handle.result.then(() => (entry.resolvedBefore = calls.length))
			return handle
		})

		try {
			const result = await centerTarget(rig.coordinator, mount, camera, rigTarget(), OPTIONS_RIG, servicesOf(fileSolver(calls), 'real'))
			expect(result).toMatchObject({ ok: true, value: { attempts: 2 } })
		} finally {
			spy.mockRestore()
		}

		expect(starts).toHaveLength(2)
		for (const [i, { request, resolvedBefore }] of starts.entries()) {
			expect(request).toMatchObject({ transferFormat: 'FITS', autoSave: true, exposureMode: 'single', count: 1, outputPath: directory, outputName: `real.${i + 1}.fit` })
			// The capture result came before the solve of its frame.
			expect(resolvedBefore).toBe(i)
			expect(calls[i].frame.path).toBe(join(directory, `real.${i + 1}.fit`))
			expect(calls[i].size).toBeGreaterThan(2880)
			// The solver signal is the one of the centering operation, never the capture's.
			expect(calls[i].signal).not.toBe(starts[i].signal)
		}

		// Removed after each solve (default 'delete').
		expect(existsSync(join(directory, 'real.1.fit'))).toBeFalse()
		expect(existsSync(join(directory, 'real.2.fit'))).toBeFalse()
		await waitUntil(() => !mount.slewing, 5000, 10)
	})

	test('a correction of 30″, the smallest kind a centering sends, completes on the simulated mount', async () => {
		const { mount, camera } = rig.devices()
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		const solver: CenteringSolver = async (frame) => {
			const [rightAscension, declination] = await stampedCenter(frame.path)
			const sky = applyPointingOffset(rightAscension, declination, deg(30 / 3600), 0)
			return tanSolution(sky.rightAscension, sky.declination)
		}
		const options = { ...OPTIONS_RIG, tolerance: deg(10 / 3600), slew: { timeout: 10000 } }

		expect(await centerTarget(rig.coordinator, mount, camera, rigTarget(), options, servicesOf(solver, 'small'))).toMatchObject({ ok: true, value: { attempts: 2 } })
		await waitUntil(() => !mount.slewing, 5000, 10)
	})

	test("'keep' preserves the frames; a failed capture never calls the solver", async () => {
		const { mount, camera } = rig.devices()
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		const calls: { readonly frame: CenteringFrame; readonly signal: AbortSignal; readonly size: number }[] = []
		const kept = await centerTarget(rig.coordinator, mount, camera, rigTarget(), { ...OPTIONS_RIG, auxiliary: 'keep', tolerance: deg(1) }, servicesOf(fileSolver(calls), 'kept'))
		expect(kept).toMatchObject({ ok: true, value: { attempts: 1 } })
		expect(isFits(readFileSync(join(directory, 'kept.1.fit')))).toBeTrue()
		rmSync(join(directory, 'kept.1.fit'))

		const failing = spyOn(rig.capturer, 'start').mockImplementation(() => ({
			id: 'refused',
			started: Promise.resolve(failedOperationResult('busy')),
			result: Promise.resolve(failedOperationResult('busy')),
			cancel: () => Promise.resolve(),
			stop: () => {},
			suspend: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
		}))
		const refused = await centerTarget(rig.coordinator, mount, camera, rigTarget(), OPTIONS_RIG, servicesOf(fileSolver(calls), 'refused'))
		failing.mockRestore()
		expect(refused).toMatchObject({ ok: false, reason: 'busy' })
		expect(calls).toHaveLength(1)
	})

	test('cancelling during an external solve kills it through the signal of the centering, without watchdog', async () => {
		const { mount, camera } = rig.devices()
		await resetSimulatorRig(rig, rig.devices().focuser.position.value)
		const kill = { solving: 0, killed: 0 }
		const reports: string[] = []
		// A one-hour external process that is killed on abort.
		const solver: CenteringSolver = (_, signal) =>
			new Promise((resolve) => {
				kill.solving++
				const timer = setTimeout(() => resolve(undefined), 3_600_000)
				signal.addEventListener(
					'abort',
					() => {
						kill.killed++
						clearTimeout(timer)
						resolve(undefined)
					},
					{ once: true },
				)
			})
		const services = { ...servicesOf(solver, 'killed'), solverHealth: { faulted: false, onUnresponsive: () => reports.push('unresponsive') } }
		const handle = rig.coordinator.start('caller', [], (context) => centerTarget(context, mount, camera, rigTarget(), OPTIONS_RIG, services))

		await waitUntil(() => kill.solving === 1, 10000, 10)
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(kill.killed).toBe(1)
		expect(reports).toEqual([])
		expect(existsSync(join(directory, 'killed.1.fit'))).toBeFalse()
	})
})

test.skipIf(isBinaryTestSkipped())('a real solver over a FITS of data/ verifies the centering', async () => {
	const source = join(dirname(dirname(dirname(__dirname))), 'data', 'NGC3372--32.1.fit')
	const solver: CenteringSolver = (frame, signal) => astapPlateSolve(frame.path, { rightAscension: deg(10.7345 * 15), declination: deg(-59.6022), radius: deg(4), fov: deg(0.54) }, signal)
	const sky = new FakeMount([deg(10.7345 * 15), deg(-59.6022)], 0, 0)
	const clock = new ManualClock()
	const directory = mkdtempSync(join(tmpdir(), 'nebulosa-astap-'))
	const capturer = {
		start: (_scope: OperationScope, _camera: Camera, request: CameraCaptureStart) => {
			const path = join(request.outputPath!, request.outputName!)
			const result = Bun.write(path, Bun.file(source)).then(() =>
				successfulOperationResult({ frames: [{ operation: 'op', session: 's', generation: 1, camera: 'cam', path, exposureStartedAt: clock.wallNow(), exposureStartedMonotonic: 0, exposureFinishedAt: clock.wallNow(), exposureFinishedMonotonic: 0 }], frameCount: 1 }),
			)
			return { id: 'capture', started: Promise.resolve(successfulOperationResult(undefined)), result, cancel: () => Promise.resolve() }
		},
	} as unknown as CameraCapturer
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const services: CenteringServices = { mountCommander: sky.commander, cameraCapturer: capturer, solver, auxiliaryPath: (attempt) => join(directory, `astap.${attempt}.fit`), clock }
	const result = await centerTarget(coordinator, sky.mount, CAMERA, { frame: 'J2000', rightAscension: deg(10.7345 * 15), declination: deg(-59.6022) }, { ...OPTIONS, tolerance: deg(0.2), solveTimeout: 120 }, services)

	expect(result).toMatchObject({ ok: true, value: { attempts: 1 } })
	expect(existsSync(join(directory, 'astap.1.fit'))).toBeFalse()
})

// Expects the commanded rotator angles, in degrees, within rounding.
function expectMoves(moves: readonly number[], expected: readonly number[]) {
	expect(moves).toHaveLength(expected.length)
	for (let i = 0; i < expected.length; i++) expect(moves[i]).toBeCloseTo(expected[i], 9)
}
