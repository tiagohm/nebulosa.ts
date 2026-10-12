import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { positionAngleBetween } from '../../../src/astronomy/coordinates/coordinate'
import { eraSeps } from '../../../src/astronomy/coordinates/erfa/erfa'
import { PIOVERTWO, TAU } from '../../../src/core/constants'
import { guidePulseReleaseBound } from '../../../src/devices/commanders/guideoutput'
import { resourceKey } from '../../../src/devices/orchestration/resource'
import { mulberry32 } from '../../../src/math/numerical/random'
import { arcsec, deg, safeAngularDifference, toArcsec } from '../../../src/math/units/angle'
import type { DitherOffset } from '../../../src/observation/guiding/dither'
import { type DitherPhase, type DitherRequest, ditherSlewTarget, MountDitherer, type MountDithererOptions } from '../../../src/observation/guiding/ditherer'
import { waitUntil } from '../../util'
import { connectSequencerRig, createSequencerRig, expectNoSequencerLeaks, resetSequencerRig } from '../sequencer/util'

const AMOUNTS = [arcsec(1), arcsec(10), arcsec(60), deg(0.1), deg(1)]
const POSITION_ANGLES = [0, 0.3, 1.2, 2.5, -0.7, -2.9, Math.PI]

describe('49.10 ditherSlewTarget', () => {
	test('17: the great-circle separation is hypot(east, north) and the position angle atan2(east, north)', () => {
		for (const amount of AMOUNTS) {
			const declinations = [0, deg(30), deg(-30), deg(60), deg(-60), deg(89), deg(-89), PIOVERTWO - 2 * amount, -(PIOVERTWO - 2 * amount)]

			for (const dec of declinations) {
				for (const pa of POSITION_ANGLES) {
					const offset: DitherOffset = { rightAscension: amount * Math.sin(pa), declination: amount * Math.cos(pa) }
					const target = ditherSlewTarget(1.3, dec, offset, false)!
					expect(Math.abs(eraSeps(1.3, dec, target.rightAscension, target.declination) - amount)).toBeLessThanOrEqual(1e-12)
					expect(safeAngularDifference(positionAngleBetween(1.3, dec, target.rightAscension, target.declination), pa)).toBeLessThanOrEqual(1e-9)
				}
			}
		}
	})

	test('18: on the equator a small dither moves RA by east and DEC by north to second order', () => {
		const amount = arcsec(10)
		const target = ditherSlewTarget(2, 0, { rightAscension: amount, declination: -amount / 2 }, false)!
		expect(Math.abs(target.rightAscension - 2 - amount)).toBeLessThan(amount ** 2)
		expect(Math.abs(target.declination + amount / 2)).toBeLessThan(amount ** 2)
	})

	test('19: near the pole the target is finite and exact (2 variants)', () => {
		const amount = arcsec(10)
		const dec = PIOVERTWO - 1.5 * amount
		const offset: DitherOffset = { rightAscension: amount, declination: 0 }
		const target = ditherSlewTarget(0.5, dec, offset, false)!

		expect(Number.isFinite(target.rightAscension) && Number.isFinite(target.declination)).toBeTrue()
		expect(Math.abs(eraSeps(0.5, dec, target.rightAscension, target.declination) - amount)).toBeLessThanOrEqual(1e-12)

		// RA += east / cos(dec) misses the amount by more than a percent this close to the pole.
		const naive = eraSeps(0.5, dec, 0.5 + amount / Math.cos(dec), dec)
		expect(Math.abs(naive - amount)).toBeGreaterThan(0.01 * amount)
	})

	test('20: a dither disc containing the pole has no target', () => {
		const amount = arcsec(10)
		for (const dec of [PIOVERTWO, -PIOVERTWO, PIOVERTWO - 0.999 * amount, PIOVERTWO - amount / 2, -(PIOVERTWO - 0.999 * amount)]) {
			expect(ditherSlewTarget(1, dec, { rightAscension: amount, declination: 0 }, false)).toBeUndefined()
			expect(ditherSlewTarget(1, dec, { rightAscension: amount, declination: 0 }, true)).toBeUndefined()
		}

		expect(ditherSlewTarget(1, 0, { rightAscension: Number.NaN, declination: 0 }, false)).toBeUndefined()
	})

	test('21: RA only keeps the declination, moves by |east| on the sphere with the sign of east', () => {
		for (const amount of AMOUNTS) {
			for (const dec of [0, deg(45), deg(-75), PIOVERTWO - 1.05 * amount]) {
				for (const east of [amount, -amount]) {
					const target = ditherSlewTarget(3, dec, { rightAscension: east, declination: 0 }, true)!
					expect(target.declination).toBe(dec)
					expect(Math.abs(eraSeps(3, dec, target.rightAscension, target.declination) - amount)).toBeLessThanOrEqual(1e-12)
					expect(Math.sign(Math.atan2(Math.sin(target.rightAscension - 3), Math.cos(target.rightAscension - 3)))).toBe(Math.sign(east))
					expect(Math.sin(amount / 2) / Math.cos(dec)).toBeLessThanOrEqual(0.51)
				}
			}
		}
	})

	test('22: right ascension wraps into [0, 2π) and no NaN appears on a grid', () => {
		const amount = deg(1)
		expect(ditherSlewTarget(TAU - 1e-6, 0, { rightAscension: amount, declination: 0 }, false)!.rightAscension).toBeCloseTo(amount - 1e-6, 12)
		expect(ditherSlewTarget(0, 0, { rightAscension: -amount, declination: 0 }, true)!.rightAscension).toBeCloseTo(TAU - amount, 12)

		for (let ra = 0; ra < TAU; ra += 0.37) {
			for (let dec = -1.5; dec <= 1.5; dec += 0.11) {
				for (const pa of POSITION_ANGLES) {
					const target = ditherSlewTarget(ra, dec, { rightAscension: amount * Math.sin(pa), declination: amount * Math.cos(pa) }, false)!
					expect(target.rightAscension >= 0 && target.rightAscension < TAU && Number.isFinite(target.declination)).toBeTrue()
				}
			}
		}
	})
})

const rig = await createSequencerRig()

beforeAll(async () => {
	await connectSequencerRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSequencerRig(rig, rig.devices().focuser.position.value)
	const { mount } = rig.devices()
	const tracked = await rig.commanders.mount.setTracking(rig.coordinator, mount, true)
	if (!tracked.ok) throw new Error(`tracking: ${tracked.reason}`)
})

function ditherer(options: Partial<MountDithererOptions> = {}) {
	const { mount, guideOutput } = rig.devices()
	return new MountDitherer(mount, guideOutput, { mountCommander: rig.commanders.mount, guideOutputCommander: rig.commanders.guideOutput }, { method: 'pulse', pattern: 'spiral', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: 5000, ...options })
}

function request(amount: number, raOnly = false): DitherRequest {
	return { amount: { unit: 'angle', value: amount }, raOnly, settle: { kind: 'mechanical', time: 0 } }
}

describe('49.10 MountDitherer by pulse', () => {
	test('13: the mount moves by the increment and the dither resolves only with the guide output stopped', async () => {
		const { mount, guideOutput } = rig.devices()
		const amount = arcsec(5)
		const spiral = ditherer()
		const phases: DitherPhase[] = []
		const before = { ...mount.equatorialCoordinate }

		// The first spiral step is north by the amount.
		const north = await spiral.dither(rig.coordinator, request(amount), (phase) => phases.push(phase))
		expect(north).toEqual({ ok: true, value: { kind: 'mount', offset: { rightAscension: 0, declination: amount } } })
		expect(guideOutput.pulsing || guideOutput.pulsingNS || guideOutput.pulsingWE).toBeFalse()
		expect(phases).toEqual(['dithering', 'dithered', 'settling', 'settled'])
		await waitUntil(() => Math.abs(toArcsec(mount.equatorialCoordinate.declination - before.declination) - 5) < 1, 3000, 10)

		// The second is east by the amount, which leaves the declination alone.
		const middle = { ...mount.equatorialCoordinate }
		const east = await spiral.dither(rig.coordinator, request(amount))
		expect(east.ok && east.value.kind === 'mount' && east.value.offset.rightAscension === amount && Math.abs(east.value.offset.declination) === 0).toBeTrue()
		await Bun.sleep(300)
		expect(Math.abs(toArcsec(mount.equatorialCoordinate.declination - middle.declination))).toBeLessThan(0.5)
		const moved = eraSeps(middle.rightAscension, middle.declination, mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination)
		expect(Math.abs(toArcsec(moved) - 5)).toBeLessThan(1)

		await expectNoSequencerLeaks(rig)
	}, 15000)

	test('13: RA only never moves the declination', async () => {
		const { mount } = rig.devices()
		const before = { ...mount.equatorialCoordinate }
		expect(await ditherer({ pattern: 'random', random: mulberry32(7) }).dither(rig.coordinator, request(arcsec(4), true))).toMatchObject({ ok: true, value: { offset: { declination: 0 } } })
		await Bun.sleep(300)
		expect(Math.abs(toArcsec(mount.equatorialCoordinate.declination - before.declination))).toBeLessThan(0.5)
	}, 15000)

	test('13: a dither disc containing the pole fails without any pulse', async () => {
		const { mount } = rig.devices()
		const synced = await rig.commanders.mount.sync(rig.coordinator, mount, { type: 'JNOW', JNOW: { x: 1, y: PIOVERTWO - arcsec(2) } })
		expect(synced.ok).toBeTrue()
		await waitUntil(() => mount.equatorialCoordinate.declination > deg(89.9), 3000, 10)

		const pulse = spyOn(rig.managers.guideOutput, 'pulse')

		try {
			expect(await ditherer().dither(rig.coordinator, request(arcsec(5)))).toMatchObject({ ok: false, reason: 'unexpectedState' })
			expect(pulse).not.toHaveBeenCalled()
		} finally {
			pulse.mockRestore()
		}
	})

	test('13: a cancelled dither releases the guide output only once its pulses stopped', async () => {
		const { guideOutput } = rig.devices()
		const handle = rig.coordinator.start('task', [], (scope) => ditherer().dither(scope, request(arcsec(20))))
		await waitUntil(() => guideOutput.pulsing, 3000, 5)
		await handle.cancel('aborted')

		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(guideOutput.pulsing).toBeFalse()
		expect(rig.arbiter.ownersOf(resourceKey(guideOutput))).toEqual([])
	}, 15000)

	test('13: a seeded pattern is reproducible and a new instance restarts the spiral', async () => {
		const first = await ditherer({ pattern: 'random', random: mulberry32(42) }).dither(rig.coordinator, request(arcsec(3)))
		const second = await ditherer({ pattern: 'random', random: mulberry32(42) }).dither(rig.coordinator, request(arcsec(3)))
		expect(first).toEqual(second)

		const spiral = ditherer()
		const firstStep = await spiral.dither(rig.coordinator, request(arcsec(2)))
		expect(await spiral.dither(rig.coordinator, request(arcsec(2)))).not.toEqual(firstStep)
		expect(await ditherer().dither(rig.coordinator, request(arcsec(2)))).toEqual(firstStep)
	}, 20000)

	test('16: asymmetric pulses of about 100 ms and 2000 ms both succeed with every flag down', async () => {
		const { guideOutput, mount } = rig.devices()
		const rate = arcsec(15.041) * guideOutput.guideRate.rightAscension
		const cos = Math.cos(mount.equatorialCoordinate.declination)

		// A random source whose draws give exactly the RA and DEC increments: amount × (2r − 1).
		const drawing = (east: number, north: number, amount: number) => {
			const draws = [(east / amount + 1) / 2, (north / amount + 1) / 2]
			return () => draws.shift() ?? 0.5
		}

		for (const [raMs, decMs] of [
			[100, 2000],
			[2000, 100],
		]) {
			const east = rate * cos * (raMs / 1000)
			const north = rate * (decMs / 1000)
			const amount = Math.max(east, north) * 1.0001
			const result = await ditherer({ pattern: 'random', random: drawing(east, north, amount) }).dither(rig.coordinator, request(amount))
			expect(result.ok).toBeTrue()
			expect(guideOutput.pulsing || guideOutput.pulsingNS || guideOutput.pulsingWE).toBeFalse()
		}
	}, 20000)

	test('the barrier of inherited pulses blocks the guide output until both axes were observed stopped', async () => {
		const { guideOutput } = rig.devices()
		const pulser = ditherer({ maxPulseDuration: 300 })
		const window = pulser.assumeDispatchedPulses()!
		expect(window.endsBy - window.busyAckDeadline).toBe(300 + 250)
		expect(rig.arbiter.snapshot(resourceKey(guideOutput)).causes).toContain('guidePulse')

		const controller = new AbortController()
		expect(await pulser.awaitPulseQuiescence(controller.signal)).toEqual({ ok: true, value: undefined })
		expect(rig.commanders.guideOutput.dispatchedPulseWindow(guideOutput)).toBeUndefined()
		expect(rig.arbiter.snapshot(resourceKey(guideOutput)).causes).not.toContain('guidePulse')
	})
})

describe('49.10 MountDitherer by slew', () => {
	test('14: the slew goes to ditherSlewTarget of the reported pointing, wrapping right ascension', async () => {
		const { mount } = rig.devices()
		const synced = await rig.commanders.mount.sync(rig.coordinator, mount, { type: 'JNOW', JNOW: { x: TAU - arcsec(5), y: deg(-30) } })
		expect(synced.ok).toBeTrue()
		await waitUntil(() => mount.equatorialCoordinate.rightAscension > TAU - arcsec(60), 3000, 10)

		const goTo = spyOn(rig.managers.mount, 'goTo')

		try {
			// The second spiral step is east by the amount.
			const slewer = ditherer({ method: 'slew', settleTimeout: 10000 })
			expect((await slewer.dither(rig.coordinator, request(arcsec(30)))).ok).toBeTrue()
			const before = { ...mount.equatorialCoordinate }
			expect((await slewer.dither(rig.coordinator, request(arcsec(30)))).ok).toBeTrue()

			const [, rightAscension, declination] = goTo.mock.calls[1] as unknown as [unknown, number, number]
			const expected = ditherSlewTarget(before.rightAscension, before.declination, { rightAscension: arcsec(30), declination: 0 }, false)!
			expect(rightAscension).toBeCloseTo(expected.rightAscension, 10)
			expect(declination).toBeCloseTo(expected.declination, 10)
			expect(rightAscension).toBeLessThan(arcsec(60))
		} finally {
			goTo.mockRestore()
		}
	}, 20000)

	test('the movement and the reservation are the mount for a slew and the guide output for a pulse', () => {
		const { mount, guideOutput } = rig.devices()
		const slewer = ditherer({ method: 'slew', settleTimeout: 7000 })
		expect(slewer.movement(7000)).toEqual([{ request: { key: resourceKey(mount), device: mount }, releaseBound: 7000 }])
		expect(slewer.resources()).toEqual({ reserve: [{ key: resourceKey(mount), device: mount }], hold: [] })

		const pulser = ditherer({ maxPulseDuration: 2500 })
		expect(pulser.movement(7000)).toEqual([{ request: { key: resourceKey(guideOutput), device: guideOutput }, releaseBound: guidePulseReleaseBound(2500) }])
		expect(pulser.resources().reserve).toEqual(pulser.movement(0).map((movement) => movement.request))
		expect(pulser.accepts(request(1))).toBeTrue()
		expect(pulser.accepts({ amount: { unit: 'guidePixel', value: 1 }, raOnly: false, settle: { kind: 'mechanical', time: 0 } })).toBeFalse()
		expect(pulser.accepts({ ...request(1), settle: { kind: 'guided', pixels: 1, time: 1, timeout: 10 } })).toBeFalse()
	})
})
