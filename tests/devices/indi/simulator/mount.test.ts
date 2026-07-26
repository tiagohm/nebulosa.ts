import { describe, expect, test } from 'bun:test'
import { PI, PIOVERTWO, TAU } from '../../../../src/core/constants'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { GuideOutputManager, MountManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { SIDEREAL_DRIFT_RATE } from '../../../../src/devices/indi/simulator/constants'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { TRACKING_RATE_CALIBRATION_TEMPERATURE } from '../../../../src/devices/indi/simulator/mount.tracking'
import { arcsec, deg, hour, normalizeAngle, normalizePI, toArcsec } from '../../../../src/math/units/angle'
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

		const guideOutput = guideOutputManager.get(client, mount.name)
		expect(guideOutput).toBeDefined()
		expect(guideOutput!.type).toBe('guideOutput')
		expect(guideOutput!.id).not.toBe(mount.id)
		expect(guideOutput!.parentId).toBe(mount.id)
		expect(mount.parentId).toBeUndefined()
		expect(JSON.stringify(guideOutput)).toContain('parentId')
	}, 3000)
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

			expect(mount.mechanical.rightAscension).toBeCloseTo(mechanical.rightAscension, 12)
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

	test('rings down only over the part of the step that followed the stop', () => {
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

	test('lands on a second target commanded while the first is still ringing', () => {
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
			// axis went, not by how long the step was.
			const expected = (travel / SIDEREAL_DRIFT_RATE) * (TAU / period)
			expect(Math.abs(normalizePI(mount.wormPhase))).toBeCloseTo(expected, 9)
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

function closeTo(a: number, b: number, tolerance: number) {
	return Math.abs(a - b) <= tolerance
}
