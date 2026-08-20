import { describe, expect, test } from 'bun:test'
import { angularDistance } from '../../../../src/astronomy/coordinates/coordinate'
import { PI, PIOVERTWO, TAU } from '../../../../src/core/constants'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { GuideOutputManager, MountManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { SIDEREAL_DRIFT_RATE, SLEW_RATES, SLEW_SPEED_FACTOR } from '../../../../src/devices/indi/simulator/constants'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { TRACKING_RATE_CALIBRATION_TEMPERATURE } from '../../../../src/devices/indi/simulator/mount.tracking'
import type { SimulatorProperty } from '../../../../src/devices/indi/simulator/types'
import { type Angle, arcsec, deg, hour, normalizeAngle, normalizePI, toArcsec, toDeg } from '../../../../src/math/units/angle'
import { polarAlignmentError } from '../../../../src/observation/alignment/polaralignment'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated mount slewing, tracking, manual motion, and guiding.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('mount simulator', () => {
	test('integrates with mount manager for sync, goto, home and park', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		expect(mount.canAbort).toBeTrue()
		expect(mount.canSync).toBeTrue()
		expect(mount.canGoTo).toBeTrue()
		expect(mount.canHome).toBeTrue()
		expect(mount.canSetHome).toBeTrue()
		expect(mount.canPark).toBeTrue()
		expect(mount.canSetPark).toBeTrue()
		expect(mount.canTracking).toBeTrue()
		expect(mount.canMove).toBeTrue()

		mountManager.slewRate(mount, 'SPEED_6')

		mountManager.syncTo(mount, hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		mountManager.setHome(mount)
		mountManager.setPark(mount)

		mountManager.goTo(mount, hour(5.25), deg(24))
		await waitUntil(() => mount.slewing)
		await waitUntil(() => !mount.slewing, 3000)
		expect(closeTo(mount.equatorialCoordinate.rightAscension, hour(5.25), 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(24), 5e-3)).toBeTrue()

		mountManager.home(mount)
		await waitUntil(() => mount.homing)
		await waitUntil(() => !mount.homing, 3000)
		expect(closeTo(normalizePI(mount.equatorialCoordinate.rightAscension - hour(5)), 0, 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(20), 5e-3)).toBeTrue()

		mountManager.goTo(mount, hour(5.12), deg(22))
		await waitUntil(() => !mount.slewing, 3000)
		mountManager.park(mount)
		await waitUntil(() => mount.parking)
		await waitUntil(() => mount.parked, 3000)
		expect(mount.tracking).toBeFalse()

		mountManager.unpark(mount)
		await waitUntil(() => !mount.parked)

		mountSimulator.disconnect()
		await waitUntil(() => !mount.connected)

		mountSimulator.connect()
		await waitUntil(() => mount.connected)

		mountSimulator.dispose()
		expect(mountManager.has(client, mountSimulator.name)).toBeFalse()
	})

	test('applies tracking drift for disabled, sidereal, king, solar and lunar modes', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(2), deg(5))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(2), 1e-9))

		const stoppedRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const noTrackingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - stoppedRightAscension)
		expect(noTrackingDrift).toBeGreaterThan(5e-6)

		mountManager.tracking(mount, true)
		await waitUntil(() => mount.tracking)
		mountManager.trackMode(mount, 'SIDEREAL')
		await waitUntil(() => mount.trackMode === 'SIDEREAL')

		const siderealRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const siderealDrift = Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - siderealRightAscension))
		expect(siderealDrift).toBeLessThan(1e-6)

		mountManager.trackMode(mount, 'SOLAR')
		await waitUntil(() => mount.trackMode === 'SOLAR')
		const solarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const solarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - solarRightAscension)
		expect(solarDrift).toBeGreaterThan(0)

		mountManager.trackMode(mount, 'KING')
		await waitUntil(() => mount.trackMode === 'KING')
		const kingRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const kingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - kingRightAscension)
		expect(kingDrift).toBeGreaterThan(0)
		expect(kingDrift).toBeLessThan(solarDrift)

		mountManager.trackMode(mount, 'LUNAR')
		await waitUntil(() => mount.trackMode === 'LUNAR')
		const lunarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const lunarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - lunarRightAscension)
		expect(lunarDrift).toBeGreaterThan(solarDrift * 5)
	}, 2000)

	test('supports manual move over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		let manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveEast(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveEast(mount, false)
		await waitUntil(() => !mount.slewing)
		let manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveWest(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveWest(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeLessThan(-1e-3)

		let manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveNorth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveNorth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveSouth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveSouth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeLessThan(-1e-3)
	}, 2000)

	test('supports manual pulse guiding over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		// Guiding is only meaningful while tracking. With the motors stopped the sky keeps turning, so
		// the sidereal drift would swamp a guide pulse instead of the pulse showing up on its own.
		mountManager.tracking(mount, true)
		await waitUntil(() => mount.tracking)

		let pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseNorth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		let pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(5e-5)

		pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseSouth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeLessThan(0)
		expect(pulseDrift).toBeGreaterThan(-5e-5)

		let pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseEast(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(1e-4)

		pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseWest(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeLessThan(5e-6)
		expect(pulseDrift).toBeGreaterThan(-1e-4)

		guideOutputManager.pulseEast(mount, 10000)
		guideOutputManager.pulseSouth(mount, 10000)
		await waitUntil(() => mount.pulsing)
		guideOutputManager.pulseEast(mount, 0)
		guideOutputManager.pulseSouth(mount, 0)
		await waitUntil(() => !mount.pulsing, 10)

		const guideOutput = guideOutputManager.get(client, mount.name)
		expect(guideOutput).toBeDefined()
		expect(guideOutput!.type).toBe('guideOutput')
		expect(guideOutput!.id).not.toBe(mount.id)
		expect(guideOutput!.parentId).toBe(mount.id)
		expect(mount.parentId).toBeUndefined()
		expect(JSON.stringify(guideOutput)).toContain('parentId')
	}, 3000)
})

const FAST_SLEW_SPEED = SLEW_RATES.at(-1)!.speed * SLEW_SPEED_FACTOR
const FAST_FLIP_DURATION = PI / FAST_SLEW_SPEED

describe('mount simulator meridian flip', () => {
	test('keeps manual motion Busy across a sync', () => {
		const { simulator } = makeMeridianFlipMount('mount.sync.manual')

		try {
			simulator.setSlewRate('SPEED_7')
			simulator.moveEast(true)
			expect(simulator.isSlewing).toBeTrue()

			simulator.syncTo(hour(5), deg(20))
			const synced = simulator.mechanical.rightAscension
			expect(simulator.isSlewing).toBeTrue()
			simulator.advance(0.1)
			expect(normalizePI(simulator.mechanical.rightAscension - synced)).toBeGreaterThan(0)

			simulator.moveEast(false)
			expect(simulator.isSlewing).toBeFalse()
		} finally {
			simulator.dispose()
		}
	})

	test('advertises and executes an explicit flip through the mount manager', () => {
		const { manager, mount, simulator } = makeMeridianFlipMount('mount.flip.explicit')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.setTrackingEnabled(true)
			const coordinate = { rightAscension: simulator.rightAscension, declination: simulator.declination }
			const wormPhase = simulator.wormPhase

			expect(mount.canFlip).toBeTrue()
			expect(mount.pierSide).toBe('WEST')
			manager.flipTo(mount, coordinate.rightAscension, coordinate.declination)
			expect(simulator.isSlewing).toBeTrue()
			expect(mount.slewing).toBeTrue()

			simulator.advance(FAST_FLIP_DURATION / 2)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')

			simulator.advance(FAST_FLIP_DURATION / 2 + 1e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(mount.slewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')
			expect(mount.pierSide).toBe('EAST')
			expect(simulator.isTracking).toBeTrue()
			expect(normalizePI(simulator.rightAscension - coordinate.rightAscension)).toBeCloseTo(0, 12)
			expect(simulator.declination).toBeCloseTo(coordinate.declination, 12)
			expect(simulator.wormPhase).not.toBe(wormPhase)

			const returnTarget = { rightAscension: normalizeAngle(lst - hour(1)), declination: coordinate.declination + deg(5) }
			const returnDuration = (PI + Math.abs(normalizePI(returnTarget.rightAscension - simulator.mechanical.rightAscension))) / FAST_SLEW_SPEED
			manager.flipTo(mount, returnTarget.rightAscension, returnTarget.declination)
			simulator.advance(returnDuration + 1e-6)
			expect(simulator.pierSide).toBe('WEST')
			expect(normalizePI(simulator.rightAscension - returnTarget.rightAscension)).toBeCloseTo(0, 12)
			expect(simulator.declination).toBeCloseTo(returnTarget.declination, 12)

			manager.flipTo(mount, simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			manager.stop(mount)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
			simulator.advance(FAST_FLIP_DURATION)
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('uses virtual half-turn travel only when a goto changes pier side', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.goto')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.setTrackingEnabled(true)

			const sameSideTarget = normalizeAngle(lst + hour(2))
			simulator.goTo(sameSideTarget, deg(20))
			simulator.advance(0.2)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
			expect(normalizePI(simulator.rightAscension - sameSideTarget)).toBeCloseTo(0, 12)

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.pierSide).toBe('EAST')
			const currentTarget = { rightAscension: simulator.rightAscension, declination: simulator.declination }
			simulator.goTo(currentTarget.rightAscension, currentTarget.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('EAST')
			simulator.advance(FAST_FLIP_DURATION / 2 + 1e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
			expect(normalizePI(simulator.rightAscension - currentTarget.rightAscension)).toBeCloseTo(0, 12)
			expect(simulator.declination).toBeCloseTo(currentTarget.declination, 12)

			const oppositeSideTarget = normalizeAngle(lst - hour(1))
			const oppositeSideDuration = Math.abs(PI + normalizePI(oppositeSideTarget - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			simulator.goTo(oppositeSideTarget, deg(25))
			simulator.advance(oppositeSideDuration / 2)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')

			simulator.advance(oppositeSideDuration / 2 + 1e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')
			expect(normalizePI(simulator.rightAscension - oppositeSideTarget)).toBeCloseTo(0, 12)
			expect(simulator.declination).toBeCloseTo(deg(25), 12)
		} finally {
			simulator.dispose()
		}
	})

	test('composes opposite celestial and flip travel on the right ascension shaft', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.goto.composed')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(15)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')

			const target = normalizeAngle(lst - deg(15))
			const duration = deg(150) / FAST_SLEW_SPEED
			simulator.goTo(target, simulator.declination)
			simulator.advance(duration - 1e-6)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')

			simulator.advance(2e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')
			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 8)
		} finally {
			simulator.dispose()
		}
	})

	test('selects the goto pier side from the estimated arrival time', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.goto.arrival')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst - hour(8)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			expect(simulator.pierSide).toBe('EAST')

			const target = normalizeAngle(lst + SIDEREAL_DRIFT_RATE)
			const duration = Math.abs(normalizePI(target - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			expect(duration).toBeGreaterThan(1)
			simulator.goTo(target, simulator.declination)
			simulator.advance(duration + 1e-6)

			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')
			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 12)
		} finally {
			simulator.dispose()
		}
	})

	test('keeps an active goto on the slew rate used for its pier-side prediction', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.goto.rate.lock')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(57.4)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			expect(simulator.pierSide).toBe('WEST')

			const target = normalizeAngle(lst + deg(0.1))
			const duration = Math.abs(normalizePI(target - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			simulator.goTo(target, simulator.declination)
			simulator.setSlewRate('SPEED_1')
			simulator.advance(duration + 0.01)

			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 8)
		} finally {
			simulator.dispose()
		}
	})

	test('rebases automatic flip policy when a goto arrives', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.goto.rebase')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(2)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: -7.5 } })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			const target = normalizeAngle(lst + hour(0.25))
			const duration = Math.abs(normalizePI(target - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			simulator.goTo(target, simulator.declination)
			simulator.advance(duration + 0.01)

			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 6)
			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.isSlewing).toBeTrue()
		} finally {
			simulator.dispose()
		}
	})

	test('rebases automatic flip policy when an explicit flip arrives', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.explicit.rebase')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.pierSide).toBe('EAST')
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)

			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.isSlewing).toBeTrue()
		} finally {
			simulator.dispose()
		}
	})

	test('commits pier-side flexure and trajectory only when the flip arrives', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.flexure')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { FLEXURE: true, PERIODIC_ERROR: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_FLEXURE', elements: { TUBE_FLEXURE: 0, PIER_WEST_RA: 0, PIER_WEST_DEC: 90 } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: 10, RA_AMPLITUDE: 60, RA_PHASE: 90, RA_AMPLITUDE_2: 0, RA_AMPLITUDE_3: 0 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			const startTime = simulator.utcTime

			expect(toArcsec(simulator.boresight.declination - simulator.mechanical.declination)).toBeCloseTo(90, 6)
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			expect(toArcsec(simulator.boresight.declination - simulator.mechanical.declination)).toBeCloseTo(90, 6)

			simulator.advance(FAST_FLIP_DURATION / 2 + 1e-6)
			expect(simulator.pierSide).toBe('EAST')
			expect(toArcsec(simulator.boresight.declination - simulator.mechanical.declination)).toBeCloseTo(0, 6)
			const trajectory = new Float64Array(6)
			const arrivalTime = startTime + FAST_FLIP_DURATION * 1000
			expect(simulator.sampleBoresightTrajectory(startTime, arrivalTime, 3, trajectory)).toBe(3)
			expect(toArcsec(trajectory[3] - simulator.mechanical.declination)).toBeCloseTo(90, 6)
			expect(toArcsec(trajectory[5] - simulator.mechanical.declination)).toBeCloseTo(90, 6)
			const jump = new Float64Array(4)
			expect(simulator.sampleBoresightTrajectory(arrivalTime, arrivalTime, 2, jump)).toBe(2)
			expect(toArcsec(normalizePI(jump[0] - jump[2]))).toBeCloseTo(0, 6)
			expect(toArcsec(jump[3] - jump[1])).toBeCloseTo(90, 6)
			expect(simulator.boresightPathLength(startTime, arrivalTime + 1)).toBeGreaterThan(arcsec(80))
		} finally {
			simulator.dispose()
		}
	})

	test('carries declination-shaft momentum through a pier-side flip', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.declination')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.setTrackingEnabled(true)
			const target = simulator.declination

			simulator.flipTo(simulator.rightAscension, target)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')

			simulator.advance(0.05)
			expect(toArcsec(target - simulator.mechanical.declination)).toBeGreaterThan(5)
		} finally {
			simulator.dispose()
		}
	})

	test('guides declination through the transmission shaft frame after a flip', () => {
		function flippedMount(id: string) {
			const setup = makeMeridianFlipMount(id)
			const { client, simulator } = setup
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			simulator.setGuideRate(1, 1)
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.pierSide).toBe('EAST')
			return setup
		}

		const north = flippedMount('mount.flip.guide.north')
		const south = flippedMount('mount.flip.guide.south')

		try {
			const northStart = north.simulator.mechanical.declination
			north.simulator.pulse('NORTH', 1000)
			north.simulator.advance(1)
			expect(north.simulator.mechanical.declination).toBe(northStart)

			const southStart = south.simulator.mechanical.declination
			south.simulator.pulse('SOUTH', 1000)
			south.simulator.advance(1)
			expect(south.simulator.mechanical.declination).toBeLessThan(southStart)
		} finally {
			north.simulator.dispose()
			south.simulator.dispose()
		}
	})

	test('initializes east-side declination shaft travel when leaving a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.pole.east.shaft')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			simulator.setGuideRate(1, 1)
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(lst, PIOVERTWO)
			expect(simulator.pierSide).toBe('NEITHER')

			simulator.goTo(normalizeAngle(lst - hour(1)), deg(20))
			simulator.advance(deg(70) / FAST_SLEW_SPEED + 1e-6)
			expect(simulator.pierSide).toBe('EAST')

			const start = simulator.mechanical.declination
			simulator.pulse('NORTH', 1000)
			simulator.advance(1)
			expect(simulator.mechanical.declination).toBe(start)
		} finally {
			simulator.dispose()
		}
	})

	test('reframes declination shaft state when manual motion leaves a pole on the east side', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.pole.manual.east.shaft')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			simulator.setGuideRate(1, 1)
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst - hour(1)), PIOVERTWO)

			simulator.moveSouth(true)
			simulator.advance(0.1)
			simulator.moveSouth(false)
			expect(simulator.pierSide).toBe('EAST')

			const start = simulator.mechanical.declination
			simulator.pulse('NORTH', 1000)
			simulator.advance(1)
			expect(simulator.mechanical.declination).toBe(start)
		} finally {
			simulator.dispose()
		}
	})

	test('clears declination transmission state when sync changes pier side', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.sync.transmission')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			simulator.setGuideRate(1, 1)
			simulator.setTrackingEnabled(true)

			let lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.pulse('NORTH', 1000)
			simulator.advance(1)
			expect(simulator.pierSide).toBe('WEST')

			lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst - hour(1)), deg(20))
			const start = simulator.mechanical.declination
			simulator.pulse('NORTH', 1000)
			simulator.advance(1)

			expect(simulator.pierSide).toBe('EAST')
			expect(simulator.mechanical.declination).toBeGreaterThan(start)
		} finally {
			simulator.dispose()
		}
	})

	test('keeps automatic flips disabled by default and triggers at signed thresholds', () => {
		for (const thresholdDegrees of [-1, 0, 1]) {
			const { client, simulator } = makeMeridianFlipMount(`mount.flip.auto.${thresholdDegrees}`)

			try {
				const initialHourAngleDegrees = Math.min(-0.1, thresholdDegrees - 0.1)
				const lst = simulator.siderealTimeAt(simulator.utcTime)
				simulator.syncTo(normalizeAngle(lst - deg(initialHourAngleDegrees)), deg(20))
				simulator.setTrackingEnabled(true)
				const secondsToThreshold = deg(thresholdDegrees - initialHourAngleDegrees + 0.01) / SIDEREAL_DRIFT_RATE

				simulator.advance(secondsToThreshold)
				expect(simulator.isSlewing).toBeFalse()
				expect(simulator.pierSide).toBe('WEST')

				simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) - deg(initialHourAngleDegrees)), deg(20))
				client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: thresholdDegrees } })
				client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
				simulator.advance(secondsToThreshold)
				expect(simulator.isSlewing).toBeTrue()
				expect(simulator.pierSide).toBe('WEST')

				simulator.advance(FAST_FLIP_DURATION + 1e-6)
				expect(simulator.isSlewing).toBeFalse()
				expect(simulator.pierSide).toBe('EAST')
				simulator.advance(60)
				expect(simulator.isSlewing).toBeFalse()
			} finally {
				simulator.dispose()
			}
		}
	})

	test('detects an automatic flip threshold crossed through the signed hour-angle wrap', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.wrap')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(1)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.advance(deg(81) / SIDEREAL_DRIFT_RATE)
			expect(simulator.pierSide).toBe('WEST')
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: 90 } })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.advance(deg(105) / SIDEREAL_DRIFT_RATE)

			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.mechanical.rightAscension)).toBeCloseTo(deg(-175), 4)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('retains automatic flip threshold crossings while disabled and across clock updates', () => {
		for (const crossing of ['advance', 'clock'] as const) {
			const { client, simulator } = makeMeridianFlipMount(`mount.flip.auto.disabled.${crossing}`)

			try {
				const lst = simulator.siderealTimeAt(simulator.utcTime)
				simulator.syncTo(normalizeAngle(lst + deg(1)), deg(20))
				simulator.setTrackingEnabled(true)
				client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: 90 } })

				const crossingSeconds = deg(186) / SIDEREAL_DRIFT_RATE
				if (crossing === 'advance') simulator.advance(crossingSeconds)
				else simulator.setTime({ utc: simulator.utcTime + crossingSeconds * 1000, offset: 0 })

				expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeCloseTo(deg(-175), 4)
				expect(simulator.isSlewing).toBeFalse()
				client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
				simulator.advance(0.1)

				expect(simulator.isSlewing).toBeTrue()
				expect(simulator.pierSide).toBe('WEST')
			} finally {
				simulator.dispose()
			}
		}
	})

	test('rebases automatic flip maximum when rewinding simulated time', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.rewind')

		try {
			const startTime = simulator.utcTime
			const lst = simulator.siderealTimeAt(startTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setTrackingEnabled(true)

			simulator.advance(10)
			simulator.setTime({ utc: startTime, offset: 0 })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(0.1)

			expect(simulator.isSlewing).toBeFalse()
			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeLessThan(0)

			simulator.advance(3)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('uses actual guided hour-angle travel when evaluating an automatic flip', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.guide')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(0.02)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setGuideRate(1, 1)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.pulse('EAST', 10_000)

			simulator.advance(10)

			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.mechanical.rightAscension)).toBeCloseTo(deg(-0.02), 8)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')

			simulator.advance(10)
			expect(simulator.isSlewing).toBeTrue()
		} finally {
			simulator.dispose()
		}
	})

	test('includes right ascension settling in automatic flip hour angle', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.settling')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 60, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(1)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			const target = normalizeAngle(lst + arcsec(20))
			const duration = Math.abs(normalizePI(target - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			simulator.goTo(target, simulator.declination)
			simulator.advance(duration + 0.05)

			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeGreaterThan(0)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('evaluates automatic flip thresholds from the reported right ascension', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.reported')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 3600 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(1.5)), deg(20))
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			expect(normalizePI(lst - simulator.mechanical.rightAscension)).toBeCloseTo(deg(-0.5), 8)
			expect(normalizePI(lst - simulator.rightAscension)).toBeCloseTo(deg(-1.5), 8)
			simulator.advance(deg(0.6) / SIDEREAL_DRIFT_RATE)
			expect(simulator.isSlewing).toBeFalse()

			simulator.advance(deg(1) / SIDEREAL_DRIFT_RATE)
			expect(simulator.isSlewing).toBeTrue()
		} finally {
			simulator.dispose()
		}
	})

	test('shifts automatic flip policy with longitude and right ascension index changes', () => {
		for (const frame of ['longitude', 'index'] as const) {
			const { client, simulator } = makeMeridianFlipMount(`mount.flip.auto.frame.${frame}`)

			try {
				if (frame === 'index') {
					client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
					client.sendNumber({ device: simulator.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT } })
				}

				const lst = simulator.siderealTimeAt(simulator.utcTime)
				simulator.syncTo(normalizeAngle(lst + deg(0.5)), deg(20))
				simulator.setTrackingEnabled(true)
				client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

				if (frame === 'longitude') client.sendNumber({ device: simulator.name, name: 'GEOGRAPHIC_COORD', elements: { LONG: 1 } })
				else client.sendNumber({ device: simulator.name, name: 'MOUNT_ALIGNMENT', elements: { RA_INDEX_ERROR: -3600 } })
				simulator.advance(0.1)

				expect(simulator.isSlewing).toBeTrue()
				expect(simulator.pierSide).toBe('WEST')
			} finally {
				simulator.dispose()
			}
		}
	})

	test('shifts automatic flip policy when alignment simulation is toggled', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.alignment.toggle')

		try {
			client.sendNumber({ device: simulator.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: -120 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(60)), deg(20))
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			simulator.advance(0.1)

			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('rebases automatic flip policy after loading persisted alignment', async () => {
		let savedProperties: readonly SimulatorProperty[] = []
		{
			const handler = new IndiClientHandlerSet()
			using client = new ClientSimulator('mount.flip.auto.alignment.save', handler)
			using simulator = new MountSimulator('Mount Simulator', client, {
				save(_, properties) {
					savedProperties = properties
				},
			})
			simulator.connect()
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: -120 } })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.saveProperties()
		}

		const handler = new IndiClientHandlerSet()
		using client = new ClientSimulator('mount.flip.auto.alignment.load', handler)
		using simulator = new MountSimulator('Mount Simulator', client, {
			load() {
				return savedProperties
			},
		})
		simulator.connect()
		const lst = simulator.siderealTimeAt(simulator.utcTime)
		simulator.syncTo(normalizeAngle(lst + arcsec(60)), deg(20))
		simulator.setTrackingEnabled(true)

		await simulator.loadProperties()
		simulator.advance(0.1)

		expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeGreaterThan(0)
		expect(simulator.isSlewing).toBeTrue()
		expect(simulator.pierSide).toBe('WEST')
	})

	test('preserves an aborted automatic flip latch when loading persisted configuration', async () => {
		let savedProperties: readonly SimulatorProperty[] = []
		{
			const handler = new IndiClientHandlerSet()
			using client = new ClientSimulator('mount.flip.auto.abort.save', handler)
			using simulator = new MountSimulator('Mount Simulator', client, {
				save(_, properties) {
					savedProperties = properties
				},
			})
			simulator.connect()
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.saveProperties()
		}

		const handler = new IndiClientHandlerSet()
		using client = new ClientSimulator('mount.flip.auto.abort.load', handler)
		using simulator = new MountSimulator('Mount Simulator', client, {
			load() {
				return savedProperties
			},
		})
		simulator.connect()
		await simulator.loadProperties()
		const lst = simulator.siderealTimeAt(simulator.utcTime)
		simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
		simulator.setTrackingEnabled(true)
		simulator.advance(4)
		expect(simulator.isSlewing).toBeTrue()

		simulator.stop()
		simulator.advance(1)
		expect(simulator.isSlewing).toBeFalse()

		await simulator.loadProperties()
		simulator.advance(0.1)
		expect(simulator.isSlewing).toBeFalse()
		expect(simulator.pierSide).toBe('WEST')

		client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
		simulator.advance(0.1)
		expect(simulator.isSlewing).toBeTrue()
	})

	test('disarms an aborted automatic flip until target or explicit enable rearming', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.abort')

		try {
			let lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(4)
			expect(simulator.isSlewing).toBeTrue()

			simulator.stop()
			simulator.advance(1)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')

			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(0.1)
			expect(simulator.isSlewing).toBeTrue()
			simulator.stop()

			lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(0.1)), deg(20))
			simulator.advance(0.1)
			simulator.advance(deg(0.2) / SIDEREAL_DRIFT_RATE)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('rebases automatic flip history when aborting a partial coordinate slew', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.abort.rebase')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + deg(30)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			const target = normalizeAngle(lst - deg(30))
			const duration = Math.abs(PI + normalizePI(target - simulator.mechanical.rightAscension)) / FAST_SLEW_SPEED
			simulator.goTo(target, simulator.declination)
			simulator.advance(duration * 0.62)
			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeGreaterThan(0)

			simulator.stop()
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')

			simulator.advance(0.1)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('rearms an aborted automatic flip after reconnect', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.reconnect')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(4)
			expect(simulator.isSlewing).toBeTrue()

			simulator.disconnect()
			simulator.connect()
			const reconnectedLst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(reconnectedLst + arcsec(30)), deg(20))
			simulator.setTime({ utc: simulator.utcTime + 10_000, offset: 0 })
			simulator.setTrackingEnabled(true)
			simulator.advance(0.1)

			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('rearms automatic flip after a successful automatic flip and goto placement', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.success.rearm')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: -7.5 } })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(4)
			expect(simulator.isSlewing).toBeTrue()

			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')

			const target = normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + deg(5))
			simulator.goTo(target, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + deg(5) / FAST_SLEW_SPEED + 0.1)

			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 6)
			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.isSlewing).toBeTrue()
		} finally {
			simulator.dispose()
		}
	})

	test('requires tracking, an unparked mount, and a defined pier side for automatic flips', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.eligibility')

		try {
			let lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.setTime({ utc: simulator.utcTime + 10_000, offset: 0 })
			simulator.advance(0.1)
			expect(simulator.isSlewing).toBeFalse()

			simulator.setTrackingEnabled(true)
			simulator.advance(0.1)
			expect(simulator.isSlewing).toBeTrue()
			simulator.stop()

			simulator.syncTo(hour(5), PIOVERTWO)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_DISABLED: true } })
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
			simulator.advance(1)
			expect(simulator.isSlewing).toBeFalse()

			lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			simulator.setPark()
			simulator.park()
			simulator.advance(0.1)
			expect(simulator.isParked).toBeTrue()
			simulator.setTime({ utc: simulator.utcTime + 10_000, offset: 0 })
			simulator.advance(1)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('establishes pier side after manual motion leaves a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.pole.manual')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), PIOVERTWO)
			expect(simulator.pierSide).toBe('NEITHER')
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.moveSouth(true)
			simulator.advance(0.1)
			expect(simulator.pierSide).toBe('WEST')
			simulator.moveSouth(false)

			simulator.advance(3)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('classifies pole departures at the sub-step timestamp', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.auto.pole.timestamp')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + SIDEREAL_DRIFT_RATE), PIOVERTWO)
			expect(simulator.pierSide).toBe('NEITHER')
			simulator.setTrackingEnabled(true)
			simulator.setGuideRate(1, 1)

			simulator.pulse('SOUTH', 100)
			simulator.advance(2)

			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.mechanical.declination).toBeLessThan(PIOVERTWO)
		} finally {
			simulator.dispose()
		}
	})

	test('rebases automatic flip history when manual motion leaves a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.pole.history')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst - arcsec(30)), PIOVERTWO)
			expect(simulator.pierSide).toBe('NEITHER')
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.moveEast(true)
			simulator.advance(0.01)
			simulator.moveEast(false)
			expect(normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)).toBeLessThan(0)

			simulator.moveSouth(true)
			simulator.advance(0.1)
			expect(simulator.pierSide).toBe('WEST')
			simulator.moveSouth(false)
			simulator.advance(0.1)
			expect(simulator.isSlewing).toBeFalse()

			const secondsToThreshold = -normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension) / SIDEREAL_DRIFT_RATE + 0.1
			simulator.advance(secondsToThreshold)
			expect(simulator.isSlewing).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('clears pier side when manual motion reaches a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.manual.pole')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), PIOVERTWO - deg(1))
			expect(simulator.pierSide).toBe('WEST')
			simulator.setTrackingEnabled(true)
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.moveNorth(true)
			simulator.advance(0.1)
			expect(simulator.pierSide).toBe('NEITHER')
			simulator.moveNorth(false)

			simulator.advance(10)
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('NEITHER')
		} finally {
			simulator.dispose()
		}
	})

	test('reconciles pier side when settling reaches or leaves a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.auto.settling.pole')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 600, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: -0.01 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + arcsec(30)), PIOVERTWO - deg(1))
			expect(simulator.pierSide).toBe('WEST')
			simulator.setTrackingEnabled(true)
			simulator.setSlewRate('SPEED_7')
			client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })

			simulator.goTo(simulator.rightAscension, PIOVERTWO - arcsec(1))
			for (let i = 0; i < 50 && simulator.isSlewing; i++) simulator.advance(0.01)

			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('NEITHER')
			expect(simulator.mechanical.declination).toBe(PIOVERTWO)

			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: false } })
			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.mechanical.declination).toBeLessThan(PIOVERTWO)
		} finally {
			simulator.dispose()
		}
	})

	test('preserves celestial settling direction when an east-side slew reaches a pole', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.settling.east.pole')

		try {
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 600, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst - hour(1)), PIOVERTWO - deg(1))
			expect(simulator.pierSide).toBe('EAST')
			simulator.setSlewRate('SPEED_7')

			simulator.goTo(simulator.rightAscension, PIOVERTWO)
			simulator.advance(deg(1) / FAST_SLEW_SPEED + 0.02)

			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('NEITHER')
			expect(simulator.mechanical.declination).toBe(PIOVERTWO)
		} finally {
			simulator.dispose()
		}
	})

	test('rejects a pole flip with Alert and clears it on the next valid operation', () => {
		const { handler, manager, mount, simulator } = makeMeridianFlipMount('mount.flip.alert')
		let coordinateState: string | undefined = 'Idle'
		handler.add({
			numberVector: (_, message) => {
				if (message.name === 'EQUATORIAL_EOD_COORD') coordinateState = message.state
			},
		})

		try {
			simulator.syncTo(hour(5), PIOVERTWO)
			expect(simulator.pierSide).toBe('NEITHER')
			manager.flipTo(mount, simulator.rightAscension, simulator.declination)
			expect(simulator.isSlewing).toBeFalse()
			expect(coordinateState).toBe('Alert')

			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			manager.flipTo(mount, simulator.rightAscension, PIOVERTWO)
			expect(simulator.isSlewing).toBeFalse()
			expect(coordinateState).toBe('Alert')

			manager.flipTo(mount, simulator.rightAscension, simulator.declination)
			expect(simulator.isSlewing).toBeTrue()
			expect(coordinateState).toBe('Busy')
		} finally {
			simulator.dispose()
		}
	})

	test('keeps an active coordinate operation Busy when rejecting a pole flip', () => {
		const { handler, simulator } = makeMeridianFlipMount('mount.flip.alert.busy')
		let coordinateState: string | undefined = 'Idle'
		handler.add({
			numberVector: (_, message) => {
				if (message.name === 'EQUATORIAL_EOD_COORD') coordinateState = message.state
			},
		})

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(2)), deg(20))
			simulator.setTrackingEnabled(true)
			const target = normalizeAngle(lst + hour(1))
			simulator.goTo(target, deg(25))
			expect(simulator.isSlewing).toBeTrue()
			expect(coordinateState).toBe('Busy')

			simulator.flipTo(target, PIOVERTWO)
			expect(simulator.isSlewing).toBeTrue()
			expect(coordinateState).toBe('Busy')

			simulator.advance(FAST_FLIP_DURATION)
			expect(simulator.isSlewing).toBeFalse()
			expect(coordinateState).toBe('Idle')
			expect(normalizePI(simulator.rightAscension - target)).toBeCloseTo(0, 12)
			expect(simulator.declination).toBeCloseTo(deg(25), 12)
		} finally {
			simulator.dispose()
		}
	})

	test('does not change pier side when only time, location, or an aborted replacement changes', () => {
		const { client, simulator } = makeMeridianFlipMount('mount.flip.side.lifecycle')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			expect(simulator.pierSide).toBe('WEST')

			simulator.setTime({ utc: simulator.utcTime + 2 * 3600_000, offset: 0 })
			client.sendNumber({ device: simulator.name, name: 'GEOGRAPHIC_COORD', elements: { LONG: 120 } })
			expect(simulator.pierSide).toBe('WEST')

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			const replacement = normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1))
			simulator.goTo(replacement, simulator.declination)
			simulator.advance(2)
			expect(simulator.pierSide).toBe('WEST')
			expect(simulator.isSlewing).toBeFalse()
		} finally {
			simulator.dispose()
		}
	})

	test('clears pending pier-side changes when manual, home, park, or disconnect supersedes a flip', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.superseded')

		try {
			let lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			simulator.moveEast(true)
			simulator.moveEast(false)
			simulator.advance(FAST_FLIP_DURATION)
			expect(simulator.pierSide).toBe('WEST')

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			simulator.home()
			simulator.advance(2)
			expect(simulator.isHoming).toBeFalse()
			expect(simulator.pierSide).toBe('NEITHER')

			lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.setPark()
			simulator.syncTo(normalizeAngle(lst + hour(2)), deg(20))
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			simulator.park()
			simulator.advance(2)
			expect(simulator.isParked).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')

			simulator.unpark()
			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION / 2)
			simulator.disconnect()
			simulator.advance(FAST_FLIP_DURATION)
			expect(simulator.isConnected).toBeFalse()
			expect(simulator.isSlewing).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('includes pier-side travel when homing and parking', () => {
		const { simulator } = makeMeridianFlipMount('mount.flip.home.park')

		try {
			const lst = simulator.siderealTimeAt(simulator.utcTime)
			simulator.syncTo(normalizeAngle(lst + hour(1)), deg(20))
			simulator.setSlewRate('SPEED_7')
			simulator.setHome()
			simulator.setPark()

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			expect(simulator.pierSide).toBe('EAST')

			simulator.home()
			simulator.advance(FAST_FLIP_DURATION / 2)
			expect(simulator.isHoming).toBeTrue()
			expect(simulator.pierSide).toBe('EAST')
			simulator.advance(FAST_FLIP_DURATION / 2 + 1e-6)
			expect(simulator.isHoming).toBeFalse()
			expect(simulator.pierSide).toBe('WEST')

			simulator.flipTo(simulator.rightAscension, simulator.declination)
			simulator.advance(FAST_FLIP_DURATION + 1e-6)
			simulator.park()
			simulator.advance(FAST_FLIP_DURATION / 2)
			expect(simulator.isParking).toBeTrue()
			expect(simulator.isParked).toBeFalse()
			expect(simulator.pierSide).toBe('EAST')
			simulator.advance(FAST_FLIP_DURATION / 2 + 1e-6)
			expect(simulator.isParking).toBeFalse()
			expect(simulator.isParked).toBeTrue()
			expect(simulator.pierSide).toBe('WEST')
		} finally {
			simulator.dispose()
		}
	})

	test('returns home and park to the pier side on which each pose was saved', () => {
		for (const operation of ['home', 'park'] as const) {
			const { simulator } = makeMeridianFlipMount(`mount.flip.saved.${operation}.side`)

			try {
				const lst = simulator.siderealTimeAt(simulator.utcTime)
				simulator.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
				simulator.setSlewRate('SPEED_7')
				if (operation === 'home') simulator.setHome()
				else simulator.setPark()
				simulator.setTrackingEnabled(true)
				simulator.advance(5)
				expect(simulator.pierSide).toBe('WEST')

				if (operation === 'home') simulator.home()
				else simulator.park()
				simulator.advance(0.01)

				expect(simulator.isSlewing).toBeFalse()
				expect(simulator.pierSide).toBe('WEST')
				if (operation === 'home') expect(simulator.isHoming).toBeFalse()
				else expect(simulator.isParked).toBeTrue()
			} finally {
				simulator.dispose()
			}
		}
	})

	test('persists automatic flip configuration without transient operation state', () => {
		const saved: string[] = []
		let savedProperties: readonly SimulatorProperty[] = []
		const handler = new IndiClientHandlerSet()
		using client = new ClientSimulator('mount.flip.persistence', handler)
		using simulator = new MountSimulator('Mount Simulator', client, {
			save(_, properties) {
				savedProperties = properties
				saved.push(...properties.map(({ name }) => name))
			},
		})

		client.sendSwitch({ device: simulator.name, name: 'MOUNT_AUTO_MERIDIAN_FLIP', elements: { INDI_ENABLED: true } })
		client.sendNumber({ device: simulator.name, name: 'MOUNT_MERIDIAN_FLIP_SETTINGS', elements: { HOUR_ANGLE: 3.5 } })
		simulator.saveProperties()

		expect(saved).toContain('MOUNT_AUTO_MERIDIAN_FLIP')
		expect(saved).toContain('MOUNT_MERIDIAN_FLIP_SETTINGS')
		expect(saved).not.toContain('ON_COORD_SET')
		expect(saved).not.toContain('EQUATORIAL_EOD_COORD')
		expect(savedProperties.find(({ name }) => name === 'MOUNT_AUTO_MERIDIAN_FLIP')?.elements.INDI_ENABLED.value).toBeTrue()
		expect(savedProperties.find(({ name }) => name === 'MOUNT_MERIDIAN_FLIP_SETTINGS')?.elements.HOUR_ANGLE.value).toBe(3.5)
	})
})

// The error model needs no timers, so it is covered without the time-consuming gate.
// Every element of a simulation vector neutralized. A test that isolates one term starts from one of
// these and overrides just that term, since each vector carries realistic defaults for the rest of its
// family and a neighbouring default would otherwise contaminate the measurement.
const NO_ALIGNMENT = { POLAR_AZIMUTH_ERROR: 0, POLAR_ALTITUDE_ERROR: 0, CONE_ERROR: 0, AXIS_NON_ORTHOGONALITY: 0, RA_INDEX_ERROR: 0, DEC_INDEX_ERROR: 0 }
const NO_MECHANICS = { BACKLASH_RA: 0, BACKLASH_DEC: 0, TAKE_UP_RATE: 1, STICTION_RA: 0, STICTION_DEC: 0, HOME_SCATTER: 0 }
const NO_GUIDING = { LATENCY: 0, LATENCY_JITTER: 0, MINIMUM_PULSE: 0, QUANTIZATION: 0, GAIN_NORTH: 1, GAIN_SOUTH: 1, GAIN_EAST: 1, GAIN_WEST: 1 }
const NO_PERIODIC_ERROR = { RA_PERIOD: 0, RA_AMPLITUDE: 0, RA_PHASE: 0, RA_AMPLITUDE_2: 0, RA_PHASE_2: 0, RA_AMPLITUDE_3: 0, RA_PHASE_3: 0 }
const NO_FLEXURE = { TUBE_FLEXURE: 0, PIER_WEST_RA: 0, PIER_WEST_DEC: 0 }
const NO_TRACKING_RATE = { BIAS: 0, TEMPERATURE_COEFFICIENT: 0, TEMPERATURE: TRACKING_RATE_CALIBRATION_TEMPERATURE, RANDOM_WALK: 0 }

describe('mount simulator pointing errors', () => {
	// Builds a connected simulator at a well-conditioned coordinate and site, with the named families of
	// error switched on.
	//
	// Nothing is simulated unless asked for, so a test that names no feature gets a mechanically perfect
	// mount. The values each family uses are the defaults of its vector unless the test overrides them,
	// which is what keeps a test from having to invent plausible numbers just to exercise a behaviour.
	function makeMount(name: string, ...features: readonly string[]) {
		const handler = new IndiClientHandlerSet()
		const client = new ClientSimulator(name, handler)
		const mount = new MountSimulator('Mount Simulator', client)
		mount.connect()
		client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: -22, LONG: -45, ELEV: 0 } })

		if (features.length > 0) {
			const elements: Record<string, boolean> = {}
			for (const feature of features) elements[feature] = true
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements })
		}

		mount.syncTo(hour(5), deg(20))
		return { client, handler, mount }
	}

	test('simulates nothing until a feature is switched on, despite carrying realistic values', () => {
		const { client, mount } = makeMount('mount.features.off')

		try {
			// The vectors are not empty: they describe a mid-range amateur mount. What keeps the default
			// simulator perfect is the switch, not the numbers.
			expect(mount.pointingErrorBound).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)

			// Writing to a family that is off changes nothing either, which is what makes the switch the
			// single gate rather than one of two things to remember.
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 3600 } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 30 } })
			mount.advance(10)

			expect(mount.pointingErrorBound).toBe(0)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('brings in a whole family at its defaults when switched on', () => {
		const { client, mount } = makeMount('mount.features.on')

		try {
			expect(mount.pointingErrorBound).toBe(0)

			// No numbers given: turning the switch on is enough to get a mount with a plausible polar
			// misalignment, cone error and index error, which is the point of the defaults.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			expect(mount.pointingErrorBound).toBeGreaterThan(arcsec(100))
			expect(mount.boresight.declination).not.toBe(mount.mechanical.declination)

			// And switching it back off restores an ideal mount without having to zero anything.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: false } })
			expect(mount.pointingErrorBound).toBe(0)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('restores an ideal mount when a family that accumulates state is switched off', () => {
		const { client, mount } = makeMount('mount.features.accumulated', 'TRACKING_RATE', 'MECHANICS')

		try {
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_6')
			mount.advance(600)

			mount.home()
			for (let i = 0; i < 300 && mount.isSlewing; i++) mount.advance(1)

			// Both families have now integrated into state of their own rather than staying a function of
			// their vector, which is what makes them different from the rest.
			expect(mount.trackingRateOffset).not.toBe(0)
			expect(mount.boresight.declination).not.toBe(mount.mechanical.declination)

			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { TRACKING_RATE: false, MECHANICS: false } })

			// Switching a family off has to mean the error does not exist, not that it is frozen wherever
			// it had already carried the mount.
			expect(mount.trackingRateOffset).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)
			expect(mount.pointingErrorBound).toBe(0)

			// And it must stay ideal: the wander of the rate lives in its own state, so leaving it behind
			// would let the drift keep growing under a family that is no longer simulated.
			mount.advance(600)
			expect(mount.trackingRateOffset).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
		} finally {
			mount.dispose()
		}
	})

	test('keeps the wind blowing steadily across an unrelated feature switch', () => {
		const { client, mount } = makeMount('mount.features.wind', 'WIND')

		try {
			mount.advance(1)
			const before = mount.boresight.declination

			// The wind is a live process, not a value read back from its vector, so rebuilding the cached
			// configurations must not restart it. Teleporting the optical axis here would be the same
			// failure a sync used to cause: an exposure straddling the jump integrates across it and
			// paints a trail the telescope never followed.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: true } })
			expect(mount.boresight.declination).toBe(before)

			// Changing the weather itself still takes effect at once.
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 60 } })
			expect(mount.boresight.declination).not.toBe(before)
		} finally {
			mount.dispose()
		}
	})

	test('normalizes the boresight right ascension past the wrap', () => {
		const { client, mount } = makeMount('mount.boresight.wrap', 'TRACKING_RATE')

		try {
			// A grossly fast drive, so ten minutes of tracking walks the boresight further west than the
			// arcsecond of right ascension the mount starts east of zero.
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 10000 } })
			mount.syncTo(arcsec(1), deg(20))
			mount.setTrackingEnabled(true)
			mount.advance(600)

			const { rightAscension } = mount.boresight
			expect(rightAscension).toBeGreaterThanOrEqual(0)
			expect(rightAscension).toBeLessThan(TAU)

			// It really did wrap rather than staying comfortably inside the range.
			expect(rightAscension).toBeGreaterThan(TAU - arcsec(120))
		} finally {
			mount.dispose()
		}
	})

	test('leaves the worm alone on a goto to the coordinate already reported', () => {
		const { client, mount } = makeMount('mount.slew.noop', 'ALIGNMENT', 'PERIODIC_ERROR')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 600, DEC_INDEX_ERROR: 600 } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: 480, RA_AMPLITUDE: 8 } })

			const mechanical = { ...mount.mechanical }
			const phase = mount.wormPhase

			// The target is converted into a mechanical orientation when commanded, so a goto to the
			// coordinate the controller is already reporting has nothing to travel. Measuring the slew
			// rate against the reported coordinate instead would report a rate of its own and spin the
			// worm through a slew that never moves an axis.
			mount.goTo(mount.rightAscension, mount.declination)
			mount.advance(1)

			// Nothing was travelled under command, so the axes never moved and the worm never turned. The
			// coordinate still follows the sky, which keeps turning over a mount that is not tracking:
			// arriving early hands the rest of the step back to ordinary motion rather than to nothing.
			expect(normalizePI(mount.mechanical.rightAscension - mechanical.rightAscension)).toBeCloseTo(SIDEREAL_DRIFT_RATE, 9)
			expect(mount.mechanical.declination).toBeCloseTo(mechanical.declination, 12)
			expect(mount.wormPhase).toBe(phase)
		} finally {
			mount.dispose()
		}
	})

	test('drops the recorded trajectory when the simulated clock jumps', () => {
		const { mount } = makeMount('mount.trajectory.clock')

		try {
			mount.advance(1)
			mount.advance(1)

			// Rewinding the clock would otherwise append a sample older than the ones already held, and
			// the history is searched assuming its timestamps only increase.
			const rewound = mount.utcTime - 3600 * 1000
			mount.setTime({ utc: rewound, offset: 0 })

			const samples = new Float64Array(8)
			expect(mount.sampleBoresightTrajectory(rewound - 1000, rewound, 4, samples)).toBe(4)

			// Everything retained is the seed at the new time, so nothing interpolates across the jump.
			const boresight = mount.boresight
			for (let i = 0; i < 4; i++) {
				expect(samples[i * 2]).toBeCloseTo(boresight.rightAscension, 12)
				expect(samples[i * 2 + 1]).toBeCloseTo(boresight.declination, 12)
			}

			// And the timestamps that follow stay ordered, so the search invariant holds again.
			mount.advance(1)
			expect(mount.utcTime).toBeGreaterThan(rewound)
		} finally {
			mount.dispose()
		}
	})

	test('notifies a bookkeeping change even when nothing will move again', () => {
		const { client, handler, mount } = makeMount('mount.index.notify', 'ALIGNMENT')

		try {
			// Long enough that the ordinary coordinate cadence would swallow the update.
			mount.minimumNotifyCoordinateInterval = 3600_000

			let notified = 0
			let reported = 0

			handler.add({
				numberVector: (_, message) => {
					if (message.name !== 'EQUATORIAL_EOD_COORD') return
					notified++
					reported = hour(message.elements.RA.value)
				},
			})

			// A mount tracking perfectly at the sidereal rate never moves an axis, so nothing calls back
			// into the coordinate path. A throttled notification here would simply be lost and clients
			// would sit on the old coordinate for as long as the mount kept tracking.
			mount.setTrackingEnabled(true)
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 600 } })

			expect(notified).toBeGreaterThan(0)
			expect(toArcsec(normalizePI(reported - mount.mechanical.rightAscension))).toBeCloseTo(600, 3)

			mount.advance(10)
			expect(toArcsec(normalizePI(reported - mount.mechanical.rightAscension))).toBeCloseTo(600, 3)
		} finally {
			mount.dispose()
		}
	})

	test('discards latent transmission and ring-down state when their families are disabled', () => {
		const { client, mount } = makeMount('mount.features.latent', 'MECHANICS', 'SETTLING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 120 } })
			mount.setTrackingEnabled(true)

			// Open the slack in one direction and start a ring-down, so both families hold live state
			// rather than merely carrying a configuration.
			mount.pulse('NORTH', 4000)
			mount.advance(2)
			mount.setSlewRate('SPEED_6')
			mount.goTo(mount.rightAscension, mount.declination + deg(1))
			for (let i = 0; i < 50 && mount.isSlewing; i++) mount.advance(0.1)
			mount.advance(0.05)

			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: false, SETTLING: false } })

			// An identity configuration only stops the state growing. Left behind, the ring-down would
			// carry its old velocity into the next motion and the slack would still be open on the flank
			// it was driven onto, so re-enabling would resume mid-response instead of from rest.
			const before = { ...mount.mechanical }
			mount.advance(1)
			expect(mount.mechanical.declination).toBeCloseTo(before.declination, 12)

			// With the transmission perfect, a reversal now moves the axis immediately instead of first
			// paying for slack that was taken up while it still had some.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { MECHANICS: true } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS } })
			const reversed = mount.declination
			mount.pulse('SOUTH', 2000)
			mount.advance(1)
			expect(mount.declination).toBeLessThan(reversed)
		} finally {
			mount.dispose()
		}
	})

	test('ignores an interval that is not a finite positive number', () => {
		const { mount } = makeMount('mount.clock.nonfinite')

		try {
			mount.setTrackingEnabled(true)
			mount.advance(1)

			const utcTime = mount.utcTime
			const { rightAscension, declination } = mount.mechanical

			// The simulation is stepped from a clock reading, and one bad reading must cost a step rather
			// than the mount: a non-finite interval propagates into the motor calculation and leaves both
			// the mechanical and the reported coordinate permanently NaN.
			for (const interval of [Number.NaN, Infinity, -Infinity, -1, 0]) mount.advance(interval)

			expect(mount.utcTime).toBe(utcTime)
			expect(mount.mechanical.rightAscension).toBe(rightAscension)
			expect(mount.mechanical.declination).toBe(declination)
			expect(mount.rightAscension).toBeFinite()

			// And the mount still works afterwards.
			mount.advance(1)
			expect(mount.utcTime).toBe(utcTime + 1000)
		} finally {
			mount.dispose()
		}
	})

	test('reads a pointing error switched on as a jump rather than as travel', () => {
		const { client, mount } = makeMount('mount.trajectory.jump')

		try {
			// `makeMount` syncs, which reseeds the history, so the switch below lands on the very instant
			// the trajectory begins at. The boresight moves and the clock does not.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			expect(mount.boresight.declination).not.toBe(mount.mechanical.declination)

			// An exposure beginning here integrates a field that is displaced and still. Holding both
			// positions at one timestamp made a lookup there answer with the superseded one, so the frame
			// came out as a trail running from where the telescope used to point.
			const startTime = mount.utcTime
			expect(toArcsec(mount.boresightPathLength(startTime, startTime + 100))).toBeCloseTo(0, 9)
		} finally {
			mount.dispose()
		}
	})

	test('records where the boresight went between two sub-millisecond steps', () => {
		const { mount } = makeMount('mount.trajectory.subms')

		try {
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_7')

			const startTime = mount.utcTime

			// Half a millisecond east and half a millisecond back west. The mount ends where it started,
			// so only the recorded path says the excursion happened at all.
			mount.moveEast(true)
			mount.advance(0.0005)
			mount.moveWest(true)
			mount.advance(0.0005)
			mount.moveWest(false)

			// Stamping both samples with the truncated clock put two different positions under one
			// timestamp, and the history reads a timestamp as identifying a position: the excursion
			// vanished and the path came back empty.
			expect(toArcsec(mount.boresightPathLength(startTime, mount.utcTime + 1))).toBeGreaterThan(50)
		} finally {
			mount.dispose()
		}
	})

	test('reads a pointing error rewritten as a jump rather than as travel', () => {
		const { client, mount } = makeMount('mount.trajectory.rewrite', 'ALIGNMENT')

		try {
			// One tick of an already configured error, so the history holds a sample of the mount as it was.
			mount.setTrackingEnabled(true)
			mount.advance(0.1)

			const startTime = mount.utcTime
			const before = mount.boresight.declination

			// The value is rewritten and the boresight moves at once, with the clock standing still.
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_ALTITUDE_ERROR: 3600 } })
			expect(toArcsec(Math.abs(mount.boresight.declination - before))).toBeGreaterThan(100)

			// An exposure over the tick that follows sees a mount that was already pointing there. Recorded
			// only on the next step, the jump was left between two samples a tick apart and the history
			// interpolated across it, drawing the frame as a trail from the error the mount used to have.
			mount.advance(0.1)
			expect(toArcsec(mount.boresightPathLength(startTime, mount.utcTime))).toBeLessThan(1)
		} finally {
			mount.dispose()
		}
	})

	test('records a site-induced boresight change at the command time', () => {
		const { client, mount } = makeMount('mount.trajectory.site', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, POLAR_AZIMUTH_ERROR: 3600 } })
			mount.setTrackingEnabled(true)
			mount.advance(0.1)

			const changeTime = mount.utcTime
			const before = mount.boresight
			client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LONG: 45 } })
			const after = mount.boresight
			expect(angularDistance(before.rightAscension, before.declination, after.rightAscension, after.declination)).toBeGreaterThan(arcsec(100))

			mount.advance(0.1)
			expect(toArcsec(mount.boresightPathLength(changeTime - 50, changeTime))).toBeLessThan(1)
			expect(toArcsec(mount.boresightPathLength(changeTime, changeTime + 50))).toBeLessThan(1)
			expect(toArcsec(mount.boresightPathLength(changeTime - 50, changeTime + 50))).toBeGreaterThan(100)
		} finally {
			mount.dispose()
		}
	})

	test('records the instant a slew reached its target', () => {
		const { mount } = makeMount('mount.trajectory.arrival')

		try {
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_7')

			const startTime = mount.utcTime

			// Ninety-six degrees a second, so this goto is over ten milliseconds into a hundred
			// millisecond step and the mount spends the other ninety standing on the target.
			mount.goTo(mount.rightAscension, mount.declination + deg(0.96))
			mount.advance(0.1)
			expect(mount.isSlewing).toBeFalse()

			// The second half of the step is one the mount spent already arrived. Recorded only at the end
			// of the step, the arrival sat between two samples a tick apart and the history interpolated
			// the goto evenly across all of it, so this stretch read as a quarter of a degree of travel
			// that had finished long before it began.
			expect(toArcsec(mount.boresightPathLength(startTime + 50, startTime + 100))).toBeLessThan(1)

			// The travel is still there, in the stretch it really happened in.
			expect(toDeg(mount.boresightPathLength(startTime, startTime + 50))).toBeCloseTo(0.96, 3)
		} finally {
			mount.dispose()
		}
	})

	test('spreads the wind across the pieces of a step rather than onto the first', () => {
		const { client, mount } = makeMount('mount.trajectory.wind', 'WIND')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 30, CORRELATION_TIME: 4 } })
			// A guide rate of zero, so the pulse below moves nothing and cuts the step without disturbing
			// it: every bit of motion left in the tick is wind.
			mount.setGuideRate(0, 0)
			mount.setTrackingEnabled(true)

			const startTime = mount.utcTime

			// The pulse ends halfway through the step, which is where the step is cut.
			mount.pulse('NORTH', 50)
			mount.advance(0.1)

			// The second half of the step has to have some wind in it. Blowing the whole tick at once,
			// before the pieces are walked, stamped the deflection reached at the end of the step onto the
			// sample taken at the middle of it: all of the buffeting landed in the first half and the
			// mount stood perfectly still through the second.
			expect(toArcsec(mount.boresightPathLength(startTime + 50, startTime + 100))).toBeGreaterThan(0)
			expect(toArcsec(mount.boresightPathLength(startTime, startTime + 50))).toBeGreaterThan(0)
		} finally {
			mount.dispose()
		}
	})

	test('resolves a ring-down faster than the simulation tick', () => {
		const { client, mount } = makeMount('mount.trajectory.settling', 'SETTLING')

		try {
			// Ten hertz and no damping: a tenth of a second is exactly one cycle, so the oscillator returns
			// to where it started and a step that only looks at its endpoints sees nothing at all.
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 60, FREQUENCY: 10, DAMPING_RATIO: 0 } })
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_7')

			// A goto that arrives inside its first step, leaving the mount ringing.
			mount.goTo(mount.rightAscension, mount.declination + deg(0.1))
			mount.advance(0.1)
			expect(mount.isSlewing).toBeFalse()

			const startTime = mount.utcTime
			const declination = mount.boresight.declination

			// One whole cycle of ringing, which ends where it began.
			mount.advance(0.1)
			expect(toArcsec(Math.abs(mount.boresight.declination - declination))).toBeLessThan(1)

			// The mount swung a full overshoot each way through that tick, and an exposure taken over it
			// has to be blurred by that. Advancing the oscillator in one closed-form jump left the
			// trajectory with two identical endpoints and no sign of the excursion between them.
			expect(toArcsec(mount.boresightPathLength(startTime, mount.utcTime))).toBeGreaterThan(100)
		} finally {
			mount.dispose()
		}
	})

	test('records where the boresight went at every guide boundary inside a step', () => {
		const { client, mount } = makeMount('mount.trajectory.pulses', 'GUIDING')

		try {
			// An ideal controller apart from the latency, which is what lets the second pulse be queued to
			// start after the first has finished rather than alongside it.
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 0, LATENCY_JITTER: 0, MINIMUM_PULSE: 0, QUANTIZATION: 0, GAIN_NORTH: 1, GAIN_SOUTH: 1 } })
			mount.setTrackingEnabled(true)

			const startTime = mount.utcTime
			const declination = mount.mechanical.declination

			// Four hundred milliseconds north, then four hundred back south, both inside the one step below.
			mount.pulse('NORTH', 400)
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 400 } })
			mount.pulse('SOUTH', 400)
			mount.advance(1)

			// The axis ends where it began, so only the recorded path says the excursion happened at all:
			// three arcseconds out at half the sidereal rate and three back, which a frame exposed over
			// this step has to be drawn as a trail rather than as a point.
			expect(toArcsec(Math.abs(mount.mechanical.declination - declination))).toBeCloseTo(0, 9)
			expect(toArcsec(mount.boresightPathLength(startTime, mount.utcTime))).toBeCloseTo(6, 1)
		} finally {
			mount.dispose()
		}
	})

	test('evaluates intermediate trajectory samples at their own sidereal times', () => {
		const { client, mount } = makeMount('mount.trajectory.sidereal', 'ALIGNMENT', 'GUIDING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, POLAR_AZIMUTH_ERROR: 3600, POLAR_ALTITUDE_ERROR: -2400 } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING } })
			mount.setGuideRate(0, 0)
			mount.setTrackingEnabled(true)

			const startTime = mount.utcTime
			mount.pulse('NORTH', 250)
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 250 } })
			mount.pulse('SOUTH', 250)
			mount.advance(1)

			const samples = new Float64Array(10)
			expect(mount.sampleBoresightTrajectory(startTime, mount.utcTime, 5, samples)).toBe(5)

			for (let i = 0; i < 5; i++) {
				const time = startTime + i * 250
				const [rightAscension, declination] = polarAlignmentError(mount.mechanical.rightAscension, mount.mechanical.declination, mount.latitude, mount.siderealTimeAt(time), arcsec(3600), arcsec(-2400))
				expect(normalizePI(samples[i * 2] - rightAscension)).toBeCloseTo(0, 11)
				expect(samples[i * 2 + 1] - declination).toBeCloseTo(0, 11)
			}
		} finally {
			mount.dispose()
		}
	})

	test('carries sub-millisecond steps instead of discarding them', () => {
		const coarse = makeMount('mount.clock.coarse')
		const fine = makeMount('mount.clock.fine')

		try {
			for (const mount of [coarse.mount, fine.mount]) mount.setTrackingEnabled(false)

			// Each simulator starts from its own wall clock, so only the elapsed time is comparable.
			const coarseStart = coarse.mount.utcTime
			const fineStart = fine.mount.utcTime

			coarse.mount.advance(0.001)
			for (let i = 0; i < 2; i++) fine.mount.advance(0.0005)

			// Two half-millisecond steps have to add up to one of a millisecond. Truncating each step on
			// its own froze the clock while the axes still moved, so physical state ran ahead of the
			// timestamps and the guide queue saw an empty interval.
			expect(coarse.mount.utcTime - coarseStart).toBe(1)
			expect(fine.mount.utcTime - fineStart).toBe(1)

			// A run of steps below the resolution still advances the clock by the time that passed, rather
			// than losing all of it. At most the fraction still in flight is outstanding, which is under
			// one millisecond by construction.
			for (let i = 0; i < 1000; i++) fine.mount.advance(0.0001)
			const elapsed = fine.mount.utcTime - fineStart
			expect(elapsed).toBeGreaterThan(100 - 1)
			expect(elapsed).toBeLessThanOrEqual(101)
		} finally {
			coarse.mount.dispose()
			fine.mount.dispose()
		}
	})

	test('times a guide pulse from the carried fraction of the clock', () => {
		const { mount } = makeMount('mount.guide.fraction')

		try {
			mount.setTrackingEnabled(true)

			// Half a millisecond in, the axes have moved but the published clock has not. A pulse issued
			// now belongs to that instant: scheduling it at the last whole millisecond would place its
			// start in a stretch that has already elapsed.
			mount.advance(0.0005)
			const before = mount.mechanical.declination
			mount.pulse('NORTH', 1)

			// Half of the pulse falls inside this step and half is still to come.
			mount.advance(0.0005)
			expect(mount.isPulsing).toBeTrue()

			const half = mount.mechanical.declination - before
			expect(half).toBeGreaterThan(0)

			// The rest is delivered by the following half step, and the pulse retires exactly there.
			mount.advance(0.0005)
			expect(mount.isPulsing).toBeFalse()
			expect(mount.mechanical.declination - before).toBeCloseTo(2 * half, 15)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('rings down only over the part of the step that followed the stop', () => {
		// Arriving partway through a step and then charging the new ring-down the whole interval shifts
		// its phase. Compared against the same arrival reached with a fine step, where almost none of the
		// interval precedes the stop, the two must agree.
		function overshootAfterArrival(step: number) {
			const { client, mount } = makeMount(`mount.settling.partial.${step}`, 'SETTLING')

			try {
				client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 60, FREQUENCY: 2, DAMPING_RATIO: 0.1 } })
				mount.setSlewRate('SPEED_6')

				const target = mount.declination + deg(0.5)
				mount.goTo(mount.rightAscension, target)

				// Runs the slew out, then samples the ring-down a fixed time after it ended.
				while (mount.isSlewing) mount.advance(step)
				let peak = 0
				for (let elapsed = 0; elapsed < 0.5; elapsed += 0.001) {
					mount.advance(0.001)
					peak = Math.max(peak, Math.abs(toArcsec(mount.mechanical.declination - target)))
				}

				return peak
			} finally {
				mount.dispose()
			}
		}

		const coarse = overshootAfterArrival(0.1)
		const fine = overshootAfterArrival(0.001)

		// Within a few percent: the arrival instants still differ by up to one coarse step, but the
		// oscillator is no longer being advanced through time that passed before it was excited.
		expect(coarse / fine).toBeCloseTo(1, 1)
	})

	test('re-derives the reported coordinate when the encoder index errors change', () => {
		const { client, mount } = makeMount('mount.features.index', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 300 } })

			// An index error is bookkeeping: the axes do not move, but what the controller reports about
			// them must change at once rather than waiting for the next thing that happens to move them.
			expect(toArcsec(normalizePI(mount.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(300, 6)

			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT } })
			expect(toArcsec(normalizePI(mount.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(0, 6)
		} finally {
			mount.dispose()
		}
	})

	test('collapses the three directions onto one another when no error is configured', () => {
		const { mount } = makeMount('mount.boresight.identity')

		try {
			const { reported, mechanical, boresight } = mount.pointingState

			expect(mount.pointingErrorBound).toBe(0)

			// With perfect geometry the boresight is the mechanical orientation itself, exactly.
			expect(boresight.rightAscension).toBe(mechanical.rightAscension)
			expect(boresight.declination).toBe(mechanical.declination)

			// The reported coordinate round-trips through the hours/degrees INDI vector, so it agrees to
			// the resolution of that encoding rather than bit for bit.
			expect(reported.rightAscension).toBeCloseTo(mechanical.rightAscension, 12)
			expect(reported.declination).toBeCloseTo(mechanical.declination, 12)
		} finally {
			mount.dispose()
		}
	})

	test('delays declination guiding after a reversal by the configured backlash', () => {
		const { client, mount } = makeMount('mount.backlash.declination', 'MECHANICS')

		try {
			// Thirty arcseconds of slack. The declination guide rate is half sidereal, so about
			// 7.5 arcsec/s, and taking up that slack costs roughly four seconds of motor travel.
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { BACKLASH_DEC: 30 } })
			mount.setTrackingEnabled(true)

			// Load the transmission northwards first, so the reversal below has slack to open.
			mount.pulse('NORTH', 4000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)

			const afterNorth = mount.mechanical.declination

			// Two seconds of reversal is only half the slack, so the axis must not move at all.
			mount.pulse('SOUTH', 2000)
			for (let i = 0; i < 4; i++) mount.advance(0.5)
			expect(mount.mechanical.declination).toBe(afterNorth)

			// Four more seconds take up the rest and the axis finally follows.
			mount.pulse('SOUTH', 4000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)
			expect(mount.mechanical.declination).toBeLessThan(afterNorth)
		} finally {
			mount.dispose()
		}
	})

	test('leaves the slack open on the flank a goto ended on, even when it fits in one step', () => {
		const { client, mount } = makeMount('mount.backlash.goto', 'MECHANICS')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			mount.setTrackingEnabled(true)

			// Load the transmission northwards, so the southward goto below is a reversal.
			mount.pulse('NORTH', 8000)
			for (let i = 0; i < 16; i++) mount.advance(0.5)

			// A degree at the fastest rate takes a tenth of a second, so the whole goto happens inside a
			// single step and never gets past the arrival branch.
			mount.setSlewRate('SPEED_7')
			mount.goTo(mount.rightAscension, mount.declination - deg(1))
			mount.advance(1)

			expect(mount.isSlewing).toBeFalse()

			const afterGoto = mount.mechanical.declination

			// Fifteen arcseconds of motor travel northwards, against a minute of slack the southward slew
			// left open: the axis must not move at all until that slack is closed.
			mount.pulse('NORTH', 2000)
			for (let i = 0; i < 4; i++) mount.advance(0.5)

			expect(mount.mechanical.declination).toBe(afterGoto)
		} finally {
			mount.dispose()
		}
	})

	test('takes up the slack it drove through during the slew itself', () => {
		const { client, mount } = makeMount('mount.backlash.driven', 'MECHANICS')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			mount.setTrackingEnabled(true)

			// Load the transmission northwards, so the southward goto below is a reversal.
			mount.pulse('NORTH', 8000)
			for (let i = 0; i < 16; i++) mount.advance(0.5)

			// A degree southwards is sixty times the slack, so the axis cannot have moved that far with the
			// gap still open: the slew closed it on the way.
			mount.setSlewRate('SPEED_7')
			mount.goTo(mount.rightAscension, mount.declination - deg(1))
			mount.advance(1)

			expect(mount.isSlewing).toBeFalse()

			const afterGoto = mount.mechanical.declination

			// Continuing southwards must therefore move at once. Charging the backlash again here stalled
			// the guiding that follows a goto for as long as it took to take up slack that was not there.
			mount.pulse('SOUTH', 1000)
			for (let i = 0; i < 2; i++) mount.advance(0.5)

			expect(mount.mechanical.declination).toBeLessThan(afterGoto)
		} finally {
			mount.dispose()
		}
	})

	test('shrinks the slack still open when the configured backlash shrinks', () => {
		const { client, mount } = makeMount('mount.backlash.reconfigured', 'MECHANICS')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 600 } })
			mount.setTrackingEnabled(true)

			// Load northwards, then reverse: ten arcminutes of slack open, barely touched.
			mount.pulse('NORTH', 4000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)
			mount.pulse('SOUTH', 1000)
			for (let i = 0; i < 2; i++) mount.advance(0.5)

			const stalled = mount.mechanical.declination

			// The mount is now declared to have a tenth of that backlash. The gap standing open belongs to
			// the transmission that had ten times as much, so it cannot outlive it: two seconds of
			// southward guiding is fifteen arcseconds, which clears sixty and moves the axis.
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { BACKLASH_DEC: 60 } })
			mount.pulse('SOUTH', 8000)
			for (let i = 0; i < 16; i++) mount.advance(0.5)

			expect(mount.mechanical.declination).toBeLessThan(stalled)
		} finally {
			mount.dispose()
		}
	})

	test('drives the transmission in the order the pulses arrived, not by their sum', () => {
		const { client, mount } = makeMount('mount.guide.ordering', 'MECHANICS', 'GUIDING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, BACKLASH_DEC: 60 } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING, LATENCY: 50 } })
			mount.setGuideRate(1, 1)
			mount.setTrackingEnabled(true)

			// Load the transmission northwards and close the slack.
			mount.pulse('NORTH', 2000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)

			// A north pulse whose tail runs into the next step, and then a south pulse that starts after
			// that tail has ended. Both fall inside the coarse step below, one after the other, which the
			// controller's own latency is what makes possible.
			mount.pulse('NORTH', 200)
			mount.advance(0.1)
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 200 } })
			mount.pulse('SOUTH', 400)

			const before = mount.mechanical.declination
			mount.advance(1)

			// Taken in order, the axis first runs a further 150 ms northwards on a closed flank, and the
			// southward pulse that follows is swallowed whole by the slack it reopens. Summed into one
			// average rate, the step is a single southward command: the northward travel the mount really
			// made is cancelled against a reversal it never saw, and nothing moves at all.
			expect(toArcsec(mount.mechanical.declination - before)).toBeGreaterThan(2)
		} finally {
			mount.dispose()
		}
	})

	test('holds a stuck declination axis until the accumulated pulses break it free', () => {
		const { client, mount } = makeMount('mount.stiction.declination', 'MECHANICS')

		try {
			// Two arcseconds of stiction. The declination guide rate is half sidereal, about
			// 7.5 arcsec/s, so a tenth of a second of travel is well under the threshold.
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { STICTION_DEC: 2 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			// Each pulse runs to completion inside its step, so it contributes its whole 100 ms of
			// travel, about 0.75 arcsec. Two of those stay under the two-arcsecond threshold.
			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBe(start)

			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBe(start)

			// The third crosses it, and everything held back arrives at once.
			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBeGreaterThan(start)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('overshoots and rings after a slew, then lands exactly on target', () => {
		const { client, mount } = makeMount('mount.settling.slew', 'SETTLING')

		try {
			// A springy mount: half an arcminute of overshoot at two hertz, lightly damped.
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			mount.setSlewRate('SPEED_7')

			const target = mount.declination + deg(10)
			mount.goTo(mount.rightAscension, target)

			let overshoot = 0
			let arrived = false

			// Stepped finely enough to resolve a two hertz ring-down.
			for (let i = 0; i < 2000; i++) {
				mount.advance(0.01)
				if (!mount.isSlewing) {
					arrived = true
					overshoot = Math.max(overshoot, Math.abs(mount.mechanical.declination - target))
				}
			}

			expect(arrived).toBeTrue()

			// It went past the target on the way in.
			expect(toArcsec(overshoot)).toBeGreaterThan(5)

			// And came back to it: the excursion is borrowed and paid back, so a goto still lands where
			// it was told to once the ringing dies away.
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeLessThan(0.01)
		} finally {
			mount.dispose()
		}
	})

	test('publishes the worm phase while sidereal tracking holds the coordinate still', () => {
		const handler = new IndiClientHandlerSet()
		const published: number[] = []

		handler.add({
			numberVector: (_, message) => {
				if (message.name === 'MOUNT_WORM_PHASE' && message.elements.PHASE !== undefined) published.push(message.elements.PHASE.value)
			},
		})

		const client = new ClientSimulator('mount.worm.notify', handler)
		const simulator = new MountSimulator('Mount Simulator', client)

		try {
			simulator.connect()
			simulator.minimumNotifyCoordinateInterval = 1000
			client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { PERIODIC_ERROR: true } })
			client.sendNumber({ device: simulator.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: 400, RA_AMPLITUDE: 8 } })
			simulator.syncTo(hour(5), deg(20))

			// Tracking at the sidereal rate is the one mode in which the motor and the sky cancel exactly,
			// so the reported coordinate never changes while the worm keeps turning underneath it.
			simulator.setTrackingEnabled(true)
			published.length = 0
			for (let i = 0; i < 100; i++) simulator.advance(0.1)

			expect(simulator.wormPhase).toBeGreaterThan(0)
			expect(published.length).toBeGreaterThan(5)

			// The phase turns 0.9 degrees per second here, so a value within a degree of the live one is a
			// value published inside the last notification interval rather than a stale one.
			const phase = toDeg(simulator.wormPhase)
			expect(published.at(-1)!).toBeLessThanOrEqual(phase)
			expect(published.at(-1)!).toBeGreaterThan(phase - 1)
		} finally {
			simulator.dispose()
		}
	})

	test('carries a running guide pulse onto the new clock', () => {
		const { mount } = makeMount('mount.settime.pulse')

		try {
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination
			mount.pulse('NORTH', 2000)
			mount.advance(0.5)
			expect(mount.isPulsing).toBeTrue()

			// An hour forward, mid pulse. The pulse was commanded to run for two seconds, not until a
			// particular reading of a clock: left on the old timeline it is already long over, so it would
			// be retired without ever delivering the rest of its motion.
			mount.setTime({ utc: mount.utcTime + 3600_000, offset: 0 })
			expect(mount.isPulsing).toBeTrue()

			mount.advance(1.5)
			expect(mount.isPulsing).toBeFalse()

			// The declination guide rate is half sidereal, so two full seconds are about fifteen arcseconds.
			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(15.04, 1)
		} finally {
			mount.dispose()
		}
	})

	test('keeps the recorded trajectory when only the UTC offset changes', () => {
		const { mount } = makeMount('mount.settime.offset')

		try {
			// With the motors stopped the sky keeps turning, so a couple of seconds leave a measurable
			// trail behind in the history.
			const startTime = mount.utcTime
			mount.advance(2)
			const endTime = mount.utcTime
			const path = mount.boresightPathLength(startTime, endTime)
			expect(toArcsec(path)).toBeGreaterThan(20)

			// A UTC offset is a timezone for display: no timestamp moves with it and no geometry reads it,
			// so every sample already recorded is still exactly where and when it was. Dropping the
			// trajectory for it erased the earlier part of the trail of an exposure in progress.
			mount.setTime({ utc: mount.utcTime, offset: 120 })

			expect(mount.boresightPathLength(startTime, endTime)).toBeCloseTo(path, 12)
		} finally {
			mount.dispose()
		}
	})

	test('keeps publishing coordinates after the clock is set backwards', () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		handler.add(mountManager)

		const client = new ClientSimulator('mount.rewind', handler)
		const simulator = new MountSimulator('Mount Simulator', client)

		try {
			simulator.connect()
			// Long enough that the throttle governs every update in this test.
			simulator.minimumNotifyCoordinateInterval = 1000
			simulator.syncTo(hour(5), deg(20))

			const mount = mountManager.get(client, simulator.name)!

			// An hour backwards. The throttle measures against the simulated clock, so without a new epoch
			// every later update looks like it happened before the previous one.
			simulator.setTime({ utc: simulator.utcTime - 3600_000, offset: 0 })
			const published = mount.equatorialCoordinate.rightAscension

			// With the motors stopped the sky keeps turning, so ten seconds move the coordinate by far
			// more than the client could miss, over ten notification intervals.
			for (let i = 0; i < 20; i++) simulator.advance(0.5)

			expect(normalizePI(mount.equatorialCoordinate.rightAscension - published)).toBeGreaterThan(1e-5)
		} finally {
			simulator.dispose()
		}
	})

	test.skipIf(SKIP)('sets the clock without absorbing the errors only a sync absorbs', () => {
		const { client, mount } = makeMount('mount.settime.errors', 'TRACKING_RATE', 'SETTLING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 5000 } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })

			// Let the drive walk some travel away unnoticed, and leave the structure mid ring-down.
			mount.setTrackingEnabled(true)
			mount.advance(10)
			expect(Math.abs(toArcsec(mount.trackingRateOffset))).toBeGreaterThan(0.5)

			mount.setSlewRate('SPEED_7')
			const target = mount.declination + deg(10)
			mount.goTo(mount.rightAscension, target)
			for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.01)
			mount.advance(0.05)
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeGreaterThan(5)

			// Saying what time it is is not a command to the mount: neither error is registered against
			// the sky by it, so the drift stands and the ring-down still has to be paid back.
			const drift = mount.trackingRateOffset
			mount.setTime({ utc: mount.utcTime + 3600_000, offset: 0 })
			expect(mount.trackingRateOffset).toBe(drift)

			for (let i = 0; i < 2000; i++) mount.advance(0.01)
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeLessThan(0.01)
		} finally {
			mount.dispose()
		}
	})

	test('overshoots in the direction the axis was travelling', () => {
		// Peak excursion past the target, signed, over the quarter cycle that follows a slew of `span`.
		function excursionAfter(name: string, span: Angle) {
			const { client, mount } = makeMount(name, 'SETTLING')

			try {
				client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
				mount.setSlewRate('SPEED_7')

				const target = mount.declination + span
				mount.goTo(mount.rightAscension, target)
				for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.01)

				let excursion = 0
				for (let i = 0; i < 25; i++) {
					mount.advance(0.005)
					const offset = mount.mechanical.declination - target
					if (Math.abs(offset) > Math.abs(excursion)) excursion = offset
				}

				return toArcsec(excursion)
			} finally {
				mount.dispose()
			}
		}

		// Momentum carries the tube on past the target, so which way it first goes is which way it was
		// already going.
		expect(excursionAfter('mount.settling.north', deg(10))).toBeGreaterThan(5)
		expect(excursionAfter('mount.settling.south', deg(-10))).toBeLessThan(-5)
	})

	test('returns the axis to its target when settling is switched off mid ring-down', () => {
		const { client, mount } = makeMount('mount.settling.disabled', 'SETTLING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			mount.setSlewRate('SPEED_7')

			const target = mount.declination + deg(10)
			mount.goTo(mount.rightAscension, target)
			for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.01)

			mount.advance(0.05)
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeGreaterThan(5)

			// An oscillator only ever borrows its displacement and pays it back as it decays. Switching the
			// family off must not keep the loan: leaving it stopped the mount at whatever instant of the
			// overshoot the switch was thrown, permanently off the position it had been commanded to.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { SETTLING: false } })
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeCloseTo(0, 9)

			mount.advance(1)
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeCloseTo(0, 9)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('lands on the pole after ringing against the declination clamp', () => {
		const { client, mount } = makeMount('mount.settling.pole', 'SETTLING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			mount.setSlewRate('SPEED_7')

			// Homing points at the pole, so this is the ordinary path rather than an exotic one. The
			// northward half of the ring-down is discarded by the declination clamp; paying it back anyway
			// left the mount permanently short of the pole it had reached.
			mount.goTo(mount.rightAscension, PIOVERTWO)
			for (let i = 0; i < 2000; i++) mount.advance(0.01)

			expect(mount.isSlewing).toBeFalse()
			expect(toArcsec(PIOVERTWO - mount.mechanical.declination)).toBeCloseTo(0, 6)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('lands on a second target commanded while the first is still ringing', () => {
		const { client, mount } = makeMount('mount.settling.interrupted', 'SETTLING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			mount.setSlewRate('SPEED_7')

			const first = mount.declination + deg(10)
			mount.goTo(mount.rightAscension, first)
			for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.01)

			expect(mount.isSlewing).toBeFalse()

			// Partway into the ring-down, so the axes sit measurably off the target they just reached.
			mount.advance(0.05)
			expect(toArcsec(Math.abs(mount.mechanical.declination - first))).toBeGreaterThan(5)

			// A second goto takes the axes over from there. The excursion it interrupted has been absorbed
			// by the move, so nothing is owed on it and the mount must land on the new target: an
			// oscillator left running would pay the old offset back a second time and stop short.
			const second = first + deg(1)
			mount.goTo(mount.rightAscension, second)
			for (let i = 0; i < 2000; i++) mount.advance(0.01)

			expect(toArcsec(Math.abs(mount.mechanical.declination - second))).toBeLessThan(0.01)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('settles more gently after a slow slew than a fast one', () => {
		function overshootAt(rate: string, name: string) {
			const { client, mount } = makeMount(name, 'SETTLING')

			try {
				client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
				mount.setSlewRate(rate)

				const target = mount.declination + deg(1)
				mount.goTo(mount.rightAscension, target)

				let overshoot = 0

				for (let i = 0; i < 2000; i++) {
					mount.advance(0.01)
					if (!mount.isSlewing) overshoot = Math.max(overshoot, Math.abs(mount.mechanical.declination - target))
				}

				return overshoot
			} finally {
				mount.dispose()
			}
		}

		// The excitation scales with the speed the axes were running at, not with how far they went.
		expect(overshootAt('SPEED_1', 'mount.settling.slow')).toBeLessThan(overshootAt('SPEED_7', 'mount.settling.fast'))
	})

	test('separates the reported coordinate from the axes by the encoder index errors', () => {
		const { client, mount } = makeMount('mount.index.error', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 120, DEC_INDEX_ERROR: -90 } })

			// Syncing places the axes so the controller reports what was asked, which with a non-zero
			// index error is a different orientation.
			mount.syncTo(hour(5), deg(20))

			const { reported, mechanical, boresight } = mount.pointingState

			expect(toArcsec(normalizePI(reported.rightAscension - hour(5)))).toBeCloseTo(0, 3)
			expect(toArcsec(reported.declination - deg(20))).toBeCloseTo(0, 3)

			// The axes sit one index error away from what is reported.
			expect(toArcsec(normalizePI(reported.rightAscension - mechanical.rightAscension))).toBeCloseTo(120, 3)
			expect(toArcsec(reported.declination - mechanical.declination)).toBeCloseTo(-90, 3)

			// An index error is bookkeeping, not optics: it must not move the boresight off the axes.
			expect(boresight.rightAscension).toBe(mechanical.rightAscension)
			expect(boresight.declination).toBe(mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('drives a goto to the orientation that makes the controller report the target', () => {
		const { client, mount } = makeMount('mount.index.goto', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, RA_INDEX_ERROR: 120, DEC_INDEX_ERROR: -90 } })
			mount.setSlewRate('SPEED_7')
			// Tracking, as a client commanding a goto would be: the slew arrives partway through a step and
			// the rest of it goes to ordinary motion, which for an untracked mount is the sky drifting the
			// coordinate away from the target it just reached.
			mount.setTrackingEnabled(true)
			mount.goTo(hour(6), deg(25))

			for (let i = 0; i < 20 && mount.isSlewing; i++) mount.advance(1)

			expect(mount.isSlewing).toBeFalse()
			expect(toArcsec(normalizePI(mount.rightAscension - hour(6)))).toBeCloseTo(0, 3)
			expect(toArcsec(mount.declination - deg(25))).toBeCloseTo(0, 3)
		} finally {
			mount.dispose()
		}
	})

	test('scales the cone error as the secant of the declination', () => {
		const { client, mount } = makeMount('mount.cone.error', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, CONE_ERROR: 60 } })

			// The hour-angle error grows as sec of the declination, but converting it to an on-sky angle
			// multiplies by cos, so the displacement of the boresight is the coefficient itself.
			for (const declination of [deg(0), deg(45), deg(60)]) {
				mount.syncTo(hour(5), declination)
				const { mechanical, boresight } = mount.pointingState
				const onSky = normalizePI(boresight.rightAscension - mechanical.rightAscension) * Math.cos(declination)
				expect(toArcsec(onSky)).toBeCloseTo(-60, 3)
				expect(boresight.declination).toBe(mechanical.declination)
			}
		} finally {
			mount.dispose()
		}
	})

	test('scales the axis non-orthogonality as the tangent of the declination', () => {
		const { client, mount } = makeMount('mount.axis.orthogonality', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, AXIS_NON_ORTHOGONALITY: 90 } })

			// Vanishes at the equator and equals the coefficient at 45 degrees, where tan is one.
			mount.syncTo(hour(5), 0)
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(0, 6)

			mount.syncTo(hour(5), deg(45))
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(-90, 3)
		} finally {
			mount.dispose()
		}
	})

	test('delivers a guide pulse shorter than the simulation step', () => {
		const { mount } = makeMount('mount.guiding.subtick')

		try {
			mount.setTrackingEnabled(true)
			const start = mount.mechanical.declination

			// Thirty milliseconds at half the sidereal rate is about 0.23 arcsec. Stepping a whole second
			// must still deliver exactly that, not a second's worth and not nothing.
			mount.pulse('NORTH', 30)
			mount.advance(1)

			const moved = mount.mechanical.declination - start
			expect(toArcsec(moved)).toBeCloseTo(0.03 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('discards pulses below the minimum and rounds the rest', () => {
		const { client, mount } = makeMount('mount.guiding.admission', 'GUIDING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING, MINIMUM_PULSE: 100, QUANTIZATION: 100 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			mount.pulse('NORTH', 50)
			mount.advance(1)
			expect(mount.mechanical.declination).toBe(start)

			// 120 ms survives the minimum and rounds to 100 ms.
			mount.pulse('NORTH', 120)
			mount.advance(1)
			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.1 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('delays a pulse by the configured latency', () => {
		const { client, mount } = makeMount('mount.guiding.latency', 'GUIDING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING, LATENCY: 500 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			// Nothing happens while the command is still in flight.
			mount.pulse('NORTH', 200)
			mount.advance(0.4)
			expect(mount.mechanical.declination).toBe(start)

			// Past the latency the pulse runs in full.
			mount.advance(0.4)
			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.2 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('applies asymmetric gains per direction', () => {
		const { client, mount } = makeMount('mount.guiding.gain', 'GUIDING')

		try {
			// A declination axis that responds at half strength going south.
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING, GAIN_SOUTH: 0.5 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination
			mount.pulse('NORTH', 400)
			mount.advance(0.5)
			const north = mount.mechanical.declination - start

			const beforeSouth = mount.mechanical.declination
			mount.pulse('SOUTH', 400)
			mount.advance(0.5)
			const south = mount.mechanical.declination - beforeSouth

			expect(north).toBeGreaterThan(0)
			expect(south).toBeLessThan(0)
			expect(-south / north).toBeCloseTo(0.5, 6)
		} finally {
			mount.dispose()
		}
	})

	test('adds overlapping pulses on the same axis instead of replacing them', () => {
		const { mount } = makeMount('mount.guiding.overlap')

		try {
			mount.setTrackingEnabled(true)
			const start = mount.mechanical.declination

			// Two 400 ms pulses issued 200 ms apart overlap for 200 ms, so the axis is driven for a total
			// of 800 ms of pulse time even though only 600 ms of wall time passes.
			mount.pulse('NORTH', 400)
			mount.advance(0.2)
			mount.pulse('NORTH', 400)
			mount.advance(0.6)

			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.8 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('keeps guiding on the mechanical axes while the polar error stays in the boresight', () => {
		const { client, mount } = makeMount('mount.boresight.guiding', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 600, POLAR_ALTITUDE_ERROR: 400 } })

			const before = mount.pointingState
			const residualBefore = before.boresight.declination - before.mechanical.declination
			expect(Math.abs(residualBefore)).toBeGreaterThan(arcsec(1))

			// A guide pulse moves the axes. This is the invariant the separation exists for: the
			// correction lands on the mechanical orientation, and the polar error keeps reappearing in
			// the boresight instead of being cancelled by it.
			// Stepped finely rather than in one jump: expiry runs before the motion, so a step longer
			// than the pulse would retire it without ever applying it. Integrating the overlap instead
			// of sampling it is what removes that quantization, and it belongs with the guide-response
			// model.
			mount.pulse('NORTH', 2000)
			for (let i = 0; i < 4; i++) mount.advance(0.5)

			const after = mount.pointingState
			expect(after.mechanical.declination).not.toBe(before.mechanical.declination)

			const residualAfter = after.boresight.declination - after.mechanical.declination
			expect(Math.abs(residualAfter)).toBeGreaterThan(arcsec(1))
			expect(residualAfter).toBeCloseTo(residualBefore, 6)
		} finally {
			mount.dispose()
		}
	})

	test('reproduces polarAlignmentError for the configured polar axis errors', () => {
		const { client, mount } = makeMount('mount.boresight.polar', 'ALIGNMENT')

		try {
			const azimuthError = 900
			const altitudeError = -600
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, POLAR_AZIMUTH_ERROR: azimuthError, POLAR_ALTITUDE_ERROR: altitudeError } })

			const utcTime = mount.utcTime
			const lst = mount.siderealTimeAt(utcTime)
			const [expectedRightAscension, expectedDeclination] = polarAlignmentError(mount.rightAscension, mount.declination, mount.latitude, lst, arcsec(azimuthError), arcsec(altitudeError))
			const boresight = mount.boresight

			expect(normalizePI(boresight.rightAscension - expectedRightAscension)).toBeCloseTo(0, 12)
			expect(boresight.declination - expectedDeclination).toBeCloseTo(0, 12)
			expect(mount.pointingErrorBound).toBeGreaterThan(0)
		} finally {
			mount.dispose()
		}
	})

	test('advances the worm phase with the axis, not with the clock', () => {
		const { client, mount } = makeMount('mount.worm.phase', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })

			expect(mount.wormPhase).toBe(0)

			// Tracking at the sidereal rate turns the worm exactly once per configured period.
			mount.setTrackingEnabled(true)
			mount.advance(period / 4)
			expect(mount.wormPhase).toBeCloseTo(PIOVERTWO, 9)

			mount.advance(period / 4)
			expect(mount.wormPhase).toBeCloseTo(PI, 9)

			// A full revolution brings it back to where it started.
			mount.advance(period / 2)
			expect(normalizePI(mount.wormPhase)).toBeCloseTo(0, 9)

			// With tracking off and nothing commanded the axis is still, so the worm must not move even
			// though time keeps passing. This is the regression against a clock-driven phase.
			mount.setTrackingEnabled(false)
			const parked = mount.wormPhase
			mount.advance(period)
			expect(mount.wormPhase).toBe(parked)
		} finally {
			mount.dispose()
		}
	})

	test('delivers a pulse that falls entirely after the slew arrived', () => {
		const { client, mount } = makeMount('mount.slew.remainder.pulse', 'GUIDING')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { ...NO_GUIDING, LATENCY: 90 } })
			mount.setGuideRate(1, 1)
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_1')

			// The goto takes nine tenths of the step, and the pulse falls inside the tenth that is left.
			const target = mount.declination + deg(0.135)
			mount.goTo(mount.rightAscension, target)
			mount.pulse('NORTH', 10)
			mount.advance(0.1)

			expect(mount.isSlewing).toBeFalse()

			// Ten milliseconds at the full guide rate is about 0.15 arcseconds. Charging the remainder with
			// a rate averaged over the whole step instead attenuated the pulse by the fraction of the step
			// the slew had taken, delivering a tenth of it.
			expect(toArcsec(mount.mechanical.declination - target)).toBeCloseTo(0.15, 2)
		} finally {
			mount.dispose()
		}
	})

	test('spends the rest of the step tracking once the slew has arrived', () => {
		const { client, mount } = makeMount('mount.slew.remainder', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })
			mount.setTrackingEnabled(true)

			mount.advance(1)
			const oneSecond = mount.wormPhase
			expect(oneSecond).toBeCloseTo(TAU / period, 9)

			// A goto to the coordinate already being reported arrives before the step has begun, so the
			// whole of it is tracking. Handing the step to the slew and stopping there stopped the clock
			// for the mount alone.
			mount.goTo(mount.rightAscension, mount.declination)
			mount.advance(1)

			expect(mount.isSlewing).toBeFalse()
			expect(mount.wormPhase - oneSecond).toBeCloseTo(oneSecond, 9)
		} finally {
			mount.dispose()
		}
	})

	test('turns the worm by the travel of the motor, including the sky it cancels', () => {
		const { client, mount } = makeMount('mount.worm.sidereal', 'PERIODIC_ERROR')

		try {
			const period = 480
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })
			mount.setTrackingEnabled(true)
			mount.setSlewRate('SPEED_1')

			const startTime = mount.utcTime
			const startRightAscension = mount.rightAscension

			// Out and back, so the coordinate ends exactly where it began. Whatever the axis did in
			// between, the motor has then delivered nothing but the sky it cancelled all along, and the
			// worm must stand exactly where simply tracking for the same time would have left it.
			mount.goTo(startRightAscension + deg(3), mount.declination)
			for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.1)
			mount.goTo(startRightAscension, mount.declination)
			for (let i = 0; i < 100 && mount.isSlewing; i++) mount.advance(0.1)

			expect(mount.isSlewing).toBeFalse()
			expect(toArcsec(normalizePI(mount.rightAscension - startRightAscension))).toBeCloseTo(0, 6)

			// Dropping the sidereal baseline from the slew rate leaves the two legs cancelling each other
			// exactly, so the worm comes back to where it started instead of where the sky took it.
			const elapsed = (mount.utcTime - startTime) / 1000
			expect(elapsed).toBeGreaterThan(3)
			expect(mount.wormPhase).toBeCloseTo((elapsed * TAU) / period, 6)
		} finally {
			mount.dispose()
		}
	})

	test('turns the worm only while the slew is actually moving', () => {
		const { client, mount } = makeMount('mount.worm.arrival', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })

			// A goto far shorter than the step: at the slowest rate the axis covers this in a tenth of a
			// second and spends the remaining nine tenths standing still.
			const travel = deg(0.15)
			mount.setSlewRate('SPEED_1')
			mount.goTo(mount.rightAscension + travel, mount.declination)
			mount.advance(1)

			expect(mount.isSlewing).toBe(false)

			// The worm turns once per period at the sidereal rate, so the phase owed is set by how far the
			// motor went, not by how long the step was. What the motor delivers is the coordinate travel
			// less the sky that turned underneath it while it was travelling.
			const slewSeconds = travel / (deg(0.5) * SLEW_SPEED_FACTOR)
			const expected = ((travel - SIDEREAL_DRIFT_RATE * slewSeconds) / SIDEREAL_DRIFT_RATE) * (TAU / period)
			expect(Math.abs(normalizePI(mount.wormPhase))).toBeCloseTo(expected, 9)
		} finally {
			mount.dispose()
		}
	})

	test('keeps the worm turning while its error is switched off', () => {
		const { client, mount } = makeMount('mount.worm.hidden', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })
			mount.setTrackingEnabled(true)

			// The worm is a piece of the mount, not a piece of the error model: with the family switched
			// off it is the error that stops being applied, while the axis goes on driving it.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { PERIODIC_ERROR: false } })
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)

			mount.advance(period / 2)
			expect(mount.wormPhase).toBeCloseTo(PI, 9)

			// Switching it back on picks the curve up where the worm has actually got to, rather than
			// where it was left standing half a revolution ago.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { PERIODIC_ERROR: true } })
			expect(mount.wormPhase).toBeCloseTo(PI, 9)
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(8 * Math.sin(PI), 6)
		} finally {
			mount.dispose()
		}
	})

	test('treats a worm that never turns as having no periodic error', () => {
		const { client, mount } = makeMount('mount.worm.noperiod', 'PERIODIC_ERROR')

		try {
			// A zero period leaves the phase frozen, so amplitudes that survived it would show up as a
			// constant displacement of the optical axis rather than as a periodic error.
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: 0, RA_AMPLITUDE_2: 10, RA_PHASE_2: 90 } })
			mount.setTrackingEnabled(true)
			mount.advance(10)

			expect(mount.wormPhase).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
			expect(mount.pointingErrorBound).toBe(0)

			// Giving it a period brings the same amplitudes back, which is what makes the period the gate
			// rather than the amplitudes being ignored outright.
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: 400 } })
			expect(toArcsec(mount.pointingErrorBound)).toBeCloseTo(10, 9)
		} finally {
			mount.dispose()
		}
	})

	test('applies the periodic error as an absolute offset of the worm phase', () => {
		const { client, mount } = makeMount('mount.boresight.periodic', 'PERIODIC_ERROR')

		try {
			const period = 400
			const amplitude = 8
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: amplitude } })
			mount.setTrackingEnabled(true)

			// A quarter of a revolution puts the sine at its positive peak.
			mount.advance(period / 4)
			const peak = mount.boresight
			expect(toArcsec(normalizePI(peak.rightAscension - mount.rightAscension))).toBeCloseTo(amplitude, 6)

			// Absolute, not incremental: evaluating twice at the same instant gives the same answer.
			expect(mount.boresight.rightAscension).toBe(peak.rightAscension)

			mount.advance(period / 2)
			const trough = mount.boresight
			expect(toArcsec(normalizePI(trough.rightAscension - mount.rightAscension))).toBeCloseTo(-amplitude, 6)
		} finally {
			mount.dispose()
		}
	})

	test('adds the higher harmonics of the worm to the boresight', () => {
		const { client, mount } = makeMount('mount.boresight.harmonics', 'PERIODIC_ERROR')

		try {
			const period = 400
			// A second harmonic phased to peak at the start of the revolution, where the fundamental is
			// crossing zero, so the two are separable by inspection.
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8, RA_AMPLITUDE_2: 3, RA_PHASE_2: 90 } })
			mount.setTrackingEnabled(true)

			const atZero = toArcsec(normalizePI(mount.boresight.rightAscension - mount.rightAscension))
			expect(atZero).toBeCloseTo(3, 6)

			// A quarter revolution puts the fundamental at its peak and the second harmonic, turning
			// twice as fast, back at its own trough.
			mount.advance(period / 4)
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.rightAscension))).toBeCloseTo(8 - 3, 6)

			// The margin a consumer sizes from has to cover both.
			expect(toArcsec(mount.pointingErrorBound)).toBeCloseTo(11, 6)
		} finally {
			mount.dispose()
		}
	})

	test('cancels the trained periodic error and leaves what the table cannot represent', () => {
		const { client, mount } = makeMount('mount.boresight.pec', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8, RA_AMPLITUDE_3: 3 } })
			mount.setTrackingEnabled(true)

			// Peak of the residual over one revolution, which is what a trained mount is judged by.
			function peakOverOneRevolution() {
				let peak = 0

				for (let i = 0; i < 64; i++) {
					mount.advance(period / 64)
					peak = Math.max(peak, Math.abs(toArcsec(normalizePI(mount.boresight.rightAscension - mount.rightAscension))))
				}

				return peak
			}

			// Untrained, the mount shows the whole curve.
			const uncorrected = peakOverOneRevolution()
			expect(uncorrected).toBeGreaterThan(6)

			// A table of four bins resolves the fundamental and nothing above it, so playback removes the
			// dominant term and the third harmonic survives.
			client.sendNumber({ device: mount.name, name: 'MOUNT_PEC', elements: { SAMPLES: 4, GAIN: 1 } })
			const partial = peakOverOneRevolution()
			expect(partial).toBeLessThan(uncorrected)
			expect(partial).toBeGreaterThan(2)

			// With enough bins to resolve every harmonic, almost nothing is left.
			client.sendNumber({ device: mount.name, name: 'MOUNT_PEC', elements: { SAMPLES: 256, GAIN: 1 } })
			expect(peakOverOneRevolution()).toBeLessThan(0.05)
		} finally {
			mount.dispose()
		}
	})

	test('spins the worm faster during a slew than while tracking', () => {
		const { client, mount } = makeMount('mount.worm.slew', 'PERIODIC_ERROR')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { ...NO_PERIODIC_ERROR, RA_PERIOD: period, RA_AMPLITUDE: 8 } })
			mount.setTrackingEnabled(true)

			mount.advance(1)
			const trackingStep = mount.wormPhase

			// A goto to the east runs the axis at the slew rate, orders of magnitude above sidereal. Kept
			// under half a revolution of the worm so the phase, which is normalized, still tells the
			// increment apart from its own wrap.
			mount.setSlewRate('SPEED_6')
			mount.goTo(mount.rightAscension + deg(0.5), mount.declination)
			mount.advance(1)
			const slewStep = normalizePI(mount.wormPhase - trackingStep)

			expect(Math.abs(slewStep)).toBeGreaterThan(Math.abs(trackingStep) * 100)
		} finally {
			mount.dispose()
		}
	})

	test('drives the boresight from the simulated clock, not the wall clock', () => {
		const { client, mount } = makeMount('mount.boresight.clock', 'ALIGNMENT')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { ...NO_ALIGNMENT, POLAR_AZIMUTH_ERROR: 1800, POLAR_ALTITUDE_ERROR: 1800 } })

			const before = mount.boresight

			// Six hours of hour angle later the polar error projects very differently.
			mount.setTime({ utc: mount.utcTime + 6 * 3600 * 1000, offset: 0 })
			const after = mount.boresight

			expect(Math.abs(normalizePI(after.rightAscension - before.rightAscension))).toBeGreaterThan(arcsec(1))
			expect(Math.abs(after.declination - before.declination)).toBeGreaterThan(arcsec(1))
		} finally {
			mount.dispose()
		}
	})

	test('sags the boresight towards the horizon and not at all at the zenith', () => {
		const { client, mount } = makeMount('mount.boresight.flexure', 'FLEXURE')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_FLEXURE', elements: { ...NO_FLEXURE, TUBE_FLEXURE: 120 } })

			// The site is at latitude -22, so a target on the meridian at that declination is at the
			// zenith and the tube hangs straight down its own axis with nothing to bend.
			mount.syncTo(mount.siderealTimeAt(mount.utcTime), deg(-22))
			const atZenith = mount.boresight
			expect(toArcsec(Math.abs(atZenith.declination - mount.mechanical.declination))).toBeCloseTo(0, 6)

			// Thirty degrees down from the zenith the droop is sin(30) of the full value, and on the
			// meridian it is entirely in declination, pushing the boresight away from the zenith.
			mount.syncTo(mount.siderealTimeAt(mount.utcTime), deg(-52))
			const offMeridian = mount.boresight
			expect(toArcsec(offMeridian.declination - mount.mechanical.declination)).toBeCloseTo(-120 * Math.sin(deg(30)), 3)

			expect(toArcsec(mount.pointingErrorBound)).toBeCloseTo(120, 6)
		} finally {
			mount.dispose()
		}
	})

	test('offsets the boresight on one side of the pier only', () => {
		const { client, mount } = makeMount('mount.boresight.pierside', 'FLEXURE')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_FLEXURE', elements: { ...NO_FLEXURE, PIER_WEST_DEC: 90 } })

			// Two hours west of the meridian, where a German mount carries the tube on the east side.
			const lst = mount.siderealTimeAt(mount.utcTime)
			mount.syncTo(normalizeAngle(lst - hour(2)), deg(-20))
			expect(mount.pierSide).toBe('EAST')
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)

			// The same target two hours east of the meridian puts it on the other side of the pier, which
			// is where the offset applies. What the pair really configures is the difference between the
			// two, and that difference is what survives a meridian flip.
			mount.syncTo(normalizeAngle(lst + hour(2)), deg(-20))
			expect(mount.pierSide).toBe('WEST')
			expect(toArcsec(mount.boresight.declination - mount.mechanical.declination)).toBeCloseTo(90, 6)
		} finally {
			mount.dispose()
		}
	})

	test('keeps the pier side a target crosses the meridian on', () => {
		const { client, mount } = makeMount('mount.boresight.transit', 'FLEXURE')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_FLEXURE', elements: { ...NO_FLEXURE, PIER_WEST_DEC: 300 } })

			// Thirty arcseconds east of the meridian, which the sky carries across in two seconds.
			const lst = mount.siderealTimeAt(mount.utcTime)
			mount.syncTo(normalizeAngle(lst + arcsec(30)), deg(20))
			mount.setTrackingEnabled(true)
			expect(mount.pierSide).toBe('WEST')

			let previous = mount.boresight.declination
			let jump = 0

			for (let i = 0; i < 40; i++) {
				mount.advance(0.1)
				const declination = mount.boresight.declination
				jump = Math.max(jump, Math.abs(declination - previous))
				previous = declination
			}

			// Nothing flipped: the mount tracked the same target through transit on the side it was already
			// on, so the pier term of the flexure model stays where it was. Predicted from the hour angle
			// instead, it vanished in one step and took the boresight five arcminutes with it.
			expect(mount.pierSide).toBe('WEST')
			expect(toArcsec(jump)).toBeLessThan(1)
			expect(toArcsec(mount.boresight.declination - mount.mechanical.declination)).toBeCloseTo(300, 6)
		} finally {
			mount.dispose()
		}
	})

	test('buffets the boresight without letting it wander off', () => {
		const { client, mount } = makeMount('mount.boresight.wind', 'WIND')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 3, CORRELATION_TIME: 4 } })
			mount.setTrackingEnabled(true)

			let peak = 0
			let reversals = 0
			let previous = 0

			for (let i = 0; i < 400; i++) {
				mount.advance(1)
				const offset = toArcsec(mount.boresight.declination - mount.mechanical.declination)
				if (i > 0 && offset > 0 !== previous > 0) reversals++
				previous = offset
				peak = Math.max(peak, Math.abs(offset))
			}

			// It moves, and it keeps changing its mind, which a static error never does.
			expect(peak).toBeGreaterThan(2)
			expect(reversals).toBeGreaterThan(5)

			// And after four hundred seconds, a hundred correlation times, it is still within a few
			// standard deviations rather than metres away. That is the whole point of the term.
			expect(peak).toBeLessThan(15)

			// The reported coordinate never sees any of it: the encoders cannot feel the wind.
			expect(mount.pointingErrorBound).toBeGreaterThan(arcsec(8))
		} finally {
			mount.dispose()
		}
	})

	test('preserves the wind deflection at the celestial pole', () => {
		const { client, mount } = makeMount('mount.boresight.wind.pole', 'WIND')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 60, CORRELATION_TIME: 30 } })
			mount.syncTo(hour(5), 0)

			const equatorMechanical = mount.mechanical
			const equatorBoresight = mount.boresight
			const expected = angularDistance(equatorMechanical.rightAscension, equatorMechanical.declination, equatorBoresight.rightAscension, equatorBoresight.declination)
			expect(toArcsec(Math.abs(normalizePI(equatorBoresight.rightAscension - equatorMechanical.rightAscension)))).toBeGreaterThan(1)

			mount.syncTo(hour(5), PIOVERTWO)
			const poleMechanical = mount.mechanical
			const poleBoresight = mount.boresight
			const actual = angularDistance(poleMechanical.rightAscension, poleMechanical.declination, poleBoresight.rightAscension, poleBoresight.declination)

			expect(actual).toBeFinite()
			expect(toArcsec(actual)).toBeCloseTo(toArcsec(expected), 6)
		} finally {
			mount.dispose()
		}
	})

	test('keeps blowing across a sync, unlike the errors a sync absorbs', () => {
		const { client, mount } = makeMount('mount.boresight.wind.sync', 'WIND')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 5, CORRELATION_TIME: 30 } })
			mount.advance(1)
			expect(mount.boresight.declination).not.toBe(mount.mechanical.declination)

			// Re-registering against the sky cannot make the air still, so unlike the rate drift and the
			// home scatter this one survives.
			mount.syncTo(hour(5), deg(20))
			expect(mount.boresight.declination).not.toBe(mount.mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('lands a little off the home position, differently every time', () => {
		const { client, mount } = makeMount('mount.home.scatter', 'MECHANICS')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { ...NO_MECHANICS, HOME_SCATTER: 30 } })
			mount.setSlewRate('SPEED_6')

			// Homes the mount and returns how far the optical axis ended up from where the controller
			// believes it parked itself, in arcseconds per axis.
			function homeAndMeasure() {
				mount.home()
				for (let i = 0; i < 200 && mount.isSlewing; i++) mount.advance(1)
				expect(mount.isSlewing).toBeFalse()
				return [toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension)), toArcsec(mount.boresight.declination - mount.mechanical.declination)] as const
			}

			const first = homeAndMeasure()
			expect(Math.abs(first[0])).toBeGreaterThan(0)
			expect(Math.abs(first[1])).toBeGreaterThan(0)

			// Not repeatable: the sensor does not trip in the same place twice.
			const second = homeAndMeasure()
			expect(second[0]).not.toBe(first[0])
			expect(second[1]).not.toBe(first[1])

			// A sync re-registers the bookkeeping, which is exactly what absorbs it.
			mount.syncTo(hour(5), deg(20))
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('homes exactly onto the home position with a perfect sensor', () => {
		const { mount } = makeMount('mount.home.repeatable')

		try {
			mount.setSlewRate('SPEED_6')
			mount.home()
			for (let i = 0; i < 200 && mount.isSlewing; i++) mount.advance(1)

			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
			expect(mount.boresight.declination).toBe(mount.mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('walks the boresight away from the reported coordinate with a tracking rate error', () => {
		const { client, mount } = makeMount('mount.rate.bias', 'TRACKING_RATE')

		try {
			// One percent fast, which is gross but keeps the drift well clear of the noise floor.
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 10000 } })
			mount.setTrackingEnabled(true)

			const reported = mount.rightAscension
			mount.advance(3600)

			// The encoders count exactly the sidereal rate they were told to, so the mount still believes
			// it is standing still on the sky. That is what makes a rate error invisible without a camera.
			expect(normalizePI(mount.rightAscension - reported)).toBeCloseTo(0, 12)

			// A drive running fast pushes the tube further west than it should, so the optical axis falls
			// behind in right ascension by the fraction of the sidereal travel it overshot.
			const expected = -SIDEREAL_DRIFT_RATE * 3600 * 0.01
			expect(mount.trackingRateOffset).toBeCloseTo(expected, 12)
			expect(normalizePI(mount.boresight.rightAscension - reported)).toBeCloseTo(expected, 12)

			// Consumers sizing a margin have to see it, since it is not bounded by any of the geometry.
			expect(mount.pointingErrorBound).toBeCloseTo(Math.abs(expected), 12)
		} finally {
			mount.dispose()
		}
	})

	test('accrues no rate drift with the drive stopped', () => {
		const { client, mount } = makeMount('mount.rate.idle', 'TRACKING_RATE')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 10000 } })

			// Tracking is off, so the motor is not turning: the sky drifts past on its own and there is no
			// commanded travel for the drive to get wrong.
			mount.advance(3600)
			expect(mount.trackingRateOffset).toBe(0)
		} finally {
			mount.dispose()
		}
	})

	test('shifts the rate error with the temperature', () => {
		const { client, mount } = makeMount('mount.rate.temperature', 'TRACKING_RATE')

		try {
			// The bias cancels the temperature term exactly at ten degrees above calibration, so the drive
			// is perfect there and runs slow beyond it.
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 1000, TEMPERATURE_COEFFICIENT: -100, TEMPERATURE: TRACKING_RATE_CALIBRATION_TEMPERATURE + 10 } })
			mount.setTrackingEnabled(true)
			mount.advance(600)
			expect(mount.trackingRateOffset).toBeCloseTo(0, 12)

			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { TEMPERATURE: TRACKING_RATE_CALIBRATION_TEMPERATURE + 20 } })
			mount.advance(600)
			expect(mount.trackingRateOffset).toBeCloseTo(SIDEREAL_DRIFT_RATE * 600 * 1000e-6, 12)
		} finally {
			mount.dispose()
		}
	})

	test('absorbs the accumulated rate drift into a sync', () => {
		const { client, mount } = makeMount('mount.rate.sync', 'TRACKING_RATE')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_TRACKING_RATE', elements: { ...NO_TRACKING_RATE, BIAS: 10000 } })
			mount.setTrackingEnabled(true)
			mount.advance(600)
			expect(mount.trackingRateOffset).not.toBe(0)

			// Re-registering against the sky is exactly what clears an unmodelled drift.
			mount.syncTo(hour(5), deg(20))
			expect(mount.trackingRateOffset).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.mechanical.rightAscension)
		} finally {
			mount.dispose()
		}
	})
})

function makeMeridianFlipMount(id: string) {
	const handler = new IndiClientHandlerSet()
	const manager = new MountManager()
	handler.add(manager)
	const client = new ClientSimulator(id, handler)
	const simulator = new MountSimulator('Mount Simulator', client)
	const mount = manager.get(client, simulator.name)!
	simulator.connect()
	simulator.setSlewRate('SPEED_7')
	return { client, handler, manager, mount, simulator }
}

function closeTo(a: number, b: number, tolerance: number) {
	return Math.abs(a - b) <= tolerance
}
