import { hourAngle } from '../../astronomy/events/hourangle'
import { localSiderealTime } from '../../astronomy/observer/location'
import { timeUnix } from '../../astronomy/time/time'
import { SIDEREAL_DRIFT_RATE } from '../../core/constants'
import type { CameraCommander } from '../../devices/commanders/camera'
import type { CoverCommander } from '../../devices/commanders/cover'
import type { DomeCommander } from '../../devices/commanders/dome'
import type { FlatPanelCommander } from '../../devices/commanders/flatpanel'
import type { MountCommander } from '../../devices/commanders/mount'
import type { Camera, Cover, Dome, Mount, PierSide, Thermometer, TrackMode } from '../../devices/indi/device'
import type { DeviceHandler, DeviceManager } from '../../devices/indi/manager/device'
import { type FailedOperationResult, failedOperationResult, type OperationResult, successfulOperationResult } from '../../devices/orchestration/operation'
import { abortReason } from '../../devices/orchestration/operation.wait'
import type { Angle } from '../../math/units/angle'
import type { SequencerContext, SequencerShutdownTask, SequencerTask, SequencerTaskPolicy, SequencerTaskResult } from './runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerClock, type SequencerConfiguration, type SequencerCoolingConfiguration, type SequencerMeridianFlipConfiguration, type SequencerShutdownConfiguration, type SequencerShutdownStepPolicy } from './sequencer'

// Equipment lifecycle tasks of the Sequencer: the startup (camera cooling with its optional thermal stabilization,
// dome or roof opening, cover opening, mount unpark, tracking mode), the shutdown (tracking off, cover closing, mount
// park, dome or roof closing, flat panel off, camera warming) and the pre-capture `ensureTracking`, the only rule that
// turns a stopped tracking back on during a session. Every task commands through the commanders, inside the root of
// its task, and checks the physical state first: a device already where the task would leave it is answered without
// commanding anything (section 31.2), so a restart, a partial startup, a repeated stop or a shutdown after a critical
// protection never duplicates a command.
//
// The startup never turns tracking on (section 18): `ensureTracking` does it in the pre-capture, after the meridian
// decision of its safe point (section 20.0), and only after the SIDEREAL track mode was observed whenever there is a
// target or a meridian flip (section 5.2). With a meridian flip, a mount on its pre-flip side whose physical hour angle
// reached the graceful deadline `latestAt − protectionMargin × SIDEREAL_DRIFT_RATE` keeps tracking off.
//
// Conventions: angles in radians, hour angles in (−π, π], temperatures in °C, configured durations in seconds turned
// into milliseconds only at the clock or a commander. The thermal stability window is measured in the monotonic domain
// of the session clock; the physical hour angle uses its wall instant as UTC. Nothing here allocates per frame beyond
// the task results; the thermal wait allocates one abort signal per temperature sample.

// Commanders of the lifecycle tasks; a task whose commander is absent fails with a 'configuration' failure without
// commanding anything (the preflight reports it before the reservation).
export interface SequencerLifecycleServices {
	// Cooler and setpoint of the primary camera.
	readonly cameraCommander?: CameraCommander
	// Publishes the sensor temperature of the camera (the camera manager never notifies it), read by the thermal
	// stability wait; required with `cooling.waitForTemperature`.
	readonly thermometerManager?: DeviceManager<Thermometer>
	// Unpark, park, tracking and track mode of the mount.
	readonly mountCommander?: MountCommander
	// Opening and closing of the cover.
	readonly coverCommander?: CoverCommander
	// Shutter, park and slaving of the dome or roof.
	readonly domeCommander?: DomeCommander
	// Light of the flat panel.
	readonly flatPanelCommander?: FlatPanelCommander
}

// Subscribes to the changes that may move a temperature sample (temperature, connection, removal) and returns the
// unsubscription. The listener reads the device itself.
export type SequencerTemperatureUpdates = (listener: VoidFunction) => VoidFunction

// What `ensureTracking` may do with a stopped tracking, from the meridian rule of section 20.0:
// - enable: turn tracking on (no meridian flip, post-flip side observed, or physical hour angle before the deadline);
// - defer: target not acquired yet in the meridian zone: only the track mode, the acquisition decides after its slew;
// - blocked: pre-flip side past the graceful deadline with the target acquired (or no target): tracking stays off;
// - unobserved: the mount publishes no site or no position, so the deadline cannot be computed: tracking stays off.
export type SequencerTrackingDecision = 'enable' | 'defer' | 'blocked' | 'unobserved'

// Graceful meridian deadline `latestAt − protectionMargin × SIDEREAL_DRIFT_RATE`, as an hour angle in radians: from it
// on a pre-flip mount must not track. `protectionMargin` defaults to `DEFAULT_SEQUENCER_MERIDIAN_FLIP`.
export function meridianGracefulDeadline(flip: Pick<SequencerMeridianFlipConfiguration, 'latestAt' | 'protectionMargin'>): Angle {
	return flip.latestAt - (flip.protectionMargin ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.protectionMargin) * SIDEREAL_DRIFT_RATE
}

// Physical hour angle of the mount at the wall instant `wallNow` (Unix ms, UTC), in radians in (−π, π]: the local
// apparent sidereal time at the published longitude minus the published equinox-of-date right ascension. It measures
// mechanical risk, never the target. Undefined while the mount has not published its site or its position in the
// current connection.
export function sequencerMountHourAngle(mount: Pick<Mount, 'hasGeographicCoordinate' | 'hasEquatorialCoordinate' | 'geographicCoordinate' | 'equatorialCoordinate'>, wallNow: number): Angle | undefined {
	if (!mount.hasGeographicCoordinate || !mount.hasEquatorialCoordinate) return undefined
	const lst = localSiderealTime(timeUnix(wallNow / 1000), mount.geographicCoordinate.longitude)
	return hourAngle(lst, mount.equatorialCoordinate.rightAscension)
}

// Meridian rule of `ensureTracking` for a stopped tracking (section 20.0): without an enabled meridian flip tracking
// may always go on; with one, only on the observed post-flip side or with the physical `hourAngle` (radians, (−π, π],
// compared linearly as the flip engine does) before the graceful deadline. Past it, a session still waiting for its
// target acquisition defers the tracking to the acquisition; otherwise tracking stays off. Pure.
export function sequencerTrackingDecision(flip: SequencerMeridianFlipConfiguration | undefined, pierSide: PierSide, hourAngle: Angle | undefined, awaitingAcquisition: boolean): SequencerTrackingDecision {
	if (flip?.enabled !== true || pierSide === flip.afterFlipPierSide) return 'enable'
	if (hourAngle === undefined) return 'unobserved'
	if (hourAngle < meridianGracefulDeadline(flip)) return 'enable'
	return awaitingAcquisition ? 'defer' : 'blocked'
}

// Track mode the startup configures: the configured one, or SIDEREAL when there is a target or an enabled meridian
// flip (the structural validation refuses any other mode in that case); undefined leaves the track mode untouched.
export function sequencerStartupTrackMode(configuration: Pick<SequencerConfiguration, 'startup' | 'target' | 'meridianFlip'>): TrackMode | undefined {
	return configuration.startup.mount?.trackMode ?? (configuration.target !== undefined || configuration.meridianFlip?.enabled === true ? 'SIDEREAL' : undefined)
}

// Start of the current stable run of a temperature sample received at the monotonic instant `now` (ms): unchanged
// while the sample stays within `tolerance` °C of `setpoint`, `now` when the run starts with it, undefined when the
// sample is out of tolerance (or not a number), which restarts the count. Shared with the thermal guard of DARK frames.
export function thermalStableSince(stableSince: number | undefined, temperature: number, cooling: Pick<SequencerCoolingConfiguration, 'setpoint' | 'tolerance'>, now: number) {
	return Math.abs(temperature - cooling.setpoint) <= cooling.tolerance ? (stableSince ?? now) : undefined
}

// Waits until the sensor temperature of `camera` stayed within `cooling.tolerance` of `cooling.setpoint` continuously
// for `cooling.stableFor` seconds, measured on the monotonic clock at the reception of each sample; a sample out of
// tolerance restarts the count. Event-driven: each update reads `camera.temperature`, and the only timer is a
// `clock.delay` to the end of the stability window or to the timeout. Resolves ok once stable, 'timeout' after
// `cooling.timeout` seconds (monotonic), 'disconnected' when the camera disconnects, or the reason of `signal` when it
// aborts. Leaves no subscription or pending delay behind.
export async function waitForStableTemperature(camera: Pick<Camera, 'name' | 'connected' | 'temperature'>, updates: SequencerTemperatureUpdates, cooling: SequencerCoolingConfiguration, clock: SequencerClock, signal: AbortSignal): Promise<OperationResult<void>> {
	const stableFor = cooling.stableFor * 1000
	const deadline = clock.monotonicNow() + cooling.timeout * 1000
	let stableSince: number | undefined
	let wake: AbortController | undefined

	const sample = () => {
		if (camera.connected) stableSince = thermalStableSince(stableSince, camera.temperature, cooling, clock.monotonicNow())
		wake?.abort()
	}

	const unsubscribe = updates(sample)

	try {
		sample()

		while (true) {
			if (signal.aborted) return failedOperationResult(abortReason(signal))
			if (!camera.connected) return failedOperationResult('disconnected')

			const now = clock.monotonicNow()
			if (stableSince !== undefined && now - stableSince >= stableFor) return successfulOperationResult(undefined)

			const remaining = deadline - now
			if (!(remaining > 0)) return failedOperationResult('timeout', `${camera.name} did not stay within ${cooling.tolerance} °C of ${cooling.setpoint} °C for ${cooling.stableFor} s in ${cooling.timeout} s`)

			// A new sample aborts the wait so the window is evaluated again; the root signal ends it at the top.
			wake = new AbortController()
			await clock.delay(stableSince === undefined ? remaining : Math.min(remaining, stableSince + stableFor - now), AbortSignal.any([signal, wake.signal]))
			wake = undefined
		}
	} finally {
		unsubscribe()
	}
}

// Temperature updates of `camera`: its sensor temperature as the thermometer manager publishes it (on the camera
// itself, the parent of its thermometer view), and its connection changes and removal as the camera manager does.
// The thermometer manager rounds the temperature to whole °C, so a tolerance below 0.5 °C only accepts the reading
// equal to a whole setpoint.
export function cameraTemperatureUpdates(cameraManager: DeviceManager<Camera>, thermometerManager: DeviceManager<Thermometer>, camera: Camera): SequencerTemperatureUpdates {
	return (listener) => {
		const thermometer: DeviceHandler<Thermometer> = {
			added: () => {},
			updated: (device, property) => {
				if (device === camera && property === 'temperature') listener()
			},
			removed: () => {},
		}

		const connection: DeviceHandler<Camera> = {
			added: () => {},
			updated: (device, property) => {
				if (device === camera && property === 'connected') listener()
			},
			removed: (device) => {
				if (device === camera) listener()
			},
		}

		thermometerManager.addHandler(thermometer)
		cameraManager.addHandler(connection)

		return () => {
			thermometerManager.removeHandler(thermometer)
			cameraManager.removeHandler(connection)
		}
	}
}

// Startup task `coolCamera` (section 18.1): switches the cooler on when the camera controls it and it is off, sends
// `cooling.setpoint`, and with `cooling.waitForTemperature` waits for the thermal stability on the session clock
// (`waitForStableTemperature`), cancellable by the root of the task. The commander only sends the setpoint; it never
// waits for the sensor. Not gated by safety.
export function coolCameraTask(services: SequencerLifecycleServices, cooling: SequencerCoolingConfiguration): SequencerTask {
	return {
		id: 'coolCamera',
		shouldRun: () => true,
		run: async (context) => {
			const { cameraCommander, thermometerManager } = services
			const { camera } = context.devices
			if (cameraCommander === undefined) return missing('camera commander')
			if (cooling.waitForTemperature && thermometerManager === undefined) return missing('thermometer manager')
			if (!camera.connected) return failed(failedOperationResult('disconnected'))
			if (!camera.canSetTemperature) return configurationFailure(`camera ${camera.name} cannot set its temperature`)

			if (camera.hasCoolerControl && !camera.cooler) {
				const cooler = await cameraCommander.cooler(context.scope, camera, true)
				if (!cooler.ok) return failed(cooler)
			}

			const setpoint = await cameraCommander.temperature(context.scope, camera, cooling.setpoint)
			if (!setpoint.ok) return failed(setpoint)
			if (!cooling.waitForTemperature) return DONE

			return taskResult(await waitForStableTemperature(camera, cameraTemperatureUpdates(cameraCommander.cameraManager, thermometerManager!, camera), cooling, context.clock, context.signal))
		},
	}
}

// Startup task `openDome`: unparks a parked dome or roof, then opens its shutter. It runs only while the dome is not
// open, after a safety gate.
export function openDomeTask(services: SequencerLifecycleServices): SequencerTask {
	return {
		id: 'openDome',
		shouldRun: ({ devices: { dome } }) => dome === undefined || !isDomeOpen(dome),
		run: async (context) => {
			const { domeCommander } = services
			const { dome } = context.devices
			if (dome === undefined) return missing('dome')
			if (domeCommander === undefined) return missing('dome commander')

			if (dome.parked || dome.parking) {
				const unparked = await domeCommander.unpark(context.scope, dome)
				if (!unparked.ok) return failed(unparked)
			}

			if (dome.hasShutter && dome.shutterState !== 'OPEN') return taskResult(await domeCommander.openShutter(context.scope, dome))
			return DONE
		},
	}
}

// Startup task `openCover`: opens (unparks) the cover. It runs only while the cover is not open, after a safety gate.
export function openCoverTask(services: SequencerLifecycleServices): SequencerTask {
	return {
		id: 'openCover',
		shouldRun: ({ devices: { cover } }) => cover === undefined || !isParkableAt(cover, false),
		run: async (context) => {
			const { coverCommander } = services
			const { cover } = context.devices
			if (cover === undefined) return missing('cover')
			if (coverCommander === undefined) return missing('cover commander')
			return taskResult(await coverCommander.unpark(context.scope, cover))
		},
	}
}

// Startup task `unparkMount`: unparks the mount and never turns tracking on. It runs only while the mount is parked,
// after a safety gate.
export function unparkMountTask(services: SequencerLifecycleServices): SequencerTask {
	return {
		id: 'unparkMount',
		shouldRun: ({ devices: { mount } }) => mount === undefined || !isParkableAt(mount, false),
		run: async (context) => {
			const { mountCommander } = services
			const { mount } = context.devices
			if (mount === undefined) return missing('mount')
			if (mountCommander === undefined) return missing('mount commander')
			return taskResult(await mountCommander.unpark(context.scope, mount))
		},
	}
}

// Startup task `configureTracking`: selects `mode` and succeeds only once the mount reports it (a mode ignored,
// refused or in Alert fails the task). It never turns tracking on. A mount without published track modes counts as
// SIDEREAL and fails any other mode. It runs only while the mount reports another mode. Not gated by safety.
export function configureTrackingTask(services: SequencerLifecycleServices, mode: TrackMode): SequencerTask {
	return {
		id: 'configureTracking',
		shouldRun: ({ devices: { mount } }) => mount === undefined || !hasTrackMode(mount, mode),
		run: async (context) => {
			const { mountCommander } = services
			const { mount } = context.devices
			if (mount === undefined) return missing('mount')
			if (mountCommander === undefined) return missing('mount commander')
			return await selectTrackMode(context, mountCommander, mount, mode)
		},
	}
}

// Pre-capture task `ensureTracking` (section 20.0), right after the meridian flip of the safe point: runs `reconcileTracking`
// for every frame while the session has a target or an enabled meridian flip. Its failure applies the meridian flip
// policy when the flip is enabled (default `DEFAULT_SEQUENCER_MERIDIAN_FLIP.onFailure`), otherwise the pointing policy
// with its retry, otherwise it fails the session.
export function ensureTrackingTask(services: SequencerLifecycleServices, configuration: Pick<SequencerConfiguration, 'pointing' | 'meridianFlip'>): SequencerTask {
	const { pointing, meridianFlip } = configuration
	const policy: SequencerTaskPolicy =
		meridianFlip?.enabled === true ? { onFailure: meridianFlip.onFailure ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.onFailure } : pointing !== undefined ? (pointing.retry === undefined ? { onFailure: pointing.onFailure } : { retry: pointing.retry, onFailure: pointing.onFailure }) : { onFailure: 'fail' }

	return {
		id: 'ensureTracking',
		shouldRun: ({ configuration, devices }) => devices.mount !== undefined && (configuration.target !== undefined || configuration.meridianFlip?.enabled === true),
		run: async (context) => {
			const { mountCommander } = services
			if (mountCommander === undefined) return missing('mount commander')
			return await reconcileTracking(context, mountCommander)
		},
		policy,
	}
}

// Tracking reconciliation of section 20.0, shared by `ensureTracking` and the target acquisition after each slew. On a
// connected, unparked mount: the SIDEREAL track mode is selected and observed first (target or meridian flip; a mount
// without published track modes counts as SIDEREAL), and only then tracking goes on as `sequencerTrackingDecision`
// allows, observed by the commander. A tracking mount with the SIDEREAL mode is answered without any command. A
// deferred tracking emits `trackingDeferred` and succeeds with tracking off; a blocked or unobserved one fails with
// tracking off, so no exposure starts. Reads the physical hour angle with the wall instant of the session clock.
export async function reconcileTracking(context: SequencerContext, mountCommander: MountCommander): Promise<SequencerTaskResult> {
	const { configuration, devices, state, clock } = context
	const { mount } = devices
	if (mount === undefined) return missing('mount')
	if (!mount.connected) return failed(failedOperationResult('disconnected'))
	if (mount.parked || mount.parking) return failed(failedOperationResult('unexpectedState', `mount ${mount.name} is parked`))

	const mode = await selectTrackMode(context, mountCommander, mount, 'SIDEREAL')
	if (!mode.ok || mount.tracking) return mode

	const hourAngle = sequencerMountHourAngle(mount, clock.wallNow())
	const decision = sequencerTrackingDecision(configuration.meridianFlip, mount.pierSide, hourAngle, configuration.target !== undefined && !state.targetAcquired)

	switch (decision) {
		case 'enable':
			return taskResult(await mountCommander.setTracking(context.scope, mount, true))
		case 'defer':
			context.emit({ type: 'trackingDeferred', reason: 'meridianZone', mountHourAngle: hourAngle! })
			return DONE
		case 'blocked':
			return failed(failedOperationResult('unexpectedState', `mount ${mount.name} is on its pre-flip side past the graceful meridian deadline; tracking stays off`))
		case 'unobserved':
			return failed(failedOperationResult('unexpectedState', `mount ${mount.name} publishes no site or position; tracking stays off`))
	}
}

// Shutdown task `stopTracking`: turns tracking off and succeeds once the mount reports it off, bounded by the hard
// protection `trackingTimeout` with a meridian flip and by `shutdown.stepTimeout` otherwise. Without a mount it is a
// no-op (section 31); it runs only while the mount tracks.
export function stopTrackingTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'stopTracking',
		shouldRun: ({ devices: { mount } }) => mount !== undefined && (!mount.connected || mount.tracking),
		run: async (context) => {
			const { mountCommander } = services
			const { mount } = context.devices
			if (mountCommander === undefined) return missing('mount commander')
			const { meridianFlip, shutdown } = context.configuration
			const timeout = meridianFlip?.enabled === true ? (meridianFlip.hardProtection?.trackingTimeout ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.hardProtection.trackingTimeout) : shutdown.stepTimeout
			return taskResult(await mountCommander.setTracking(context.scope, mount!, false, { timeout: timeout * 1000 }))
		},
		policy,
	}
}

// Shutdown task `closeCover`: closes (parks) the cover within `shutdown.stepTimeout`. It runs only while the cover is
// not closed.
export function closeCoverTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'closeCover',
		shouldRun: ({ devices: { cover } }) => cover === undefined || !isParkableAt(cover, true),
		run: async (context) => {
			const { coverCommander } = services
			const { cover } = context.devices
			if (cover === undefined) return missing('cover')
			if (coverCommander === undefined) return missing('cover commander')
			return taskResult(await coverCommander.park(context.scope, cover, { timeout: stepTimeout(context) }))
		},
		policy,
	}
}

// Shutdown task `parkMount`: parks the mount within `shutdown.stepTimeout`. It runs only while the mount is not parked.
export function parkMountTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'parkMount',
		shouldRun: ({ devices: { mount } }) => mount === undefined || !isParkableAt(mount, true),
		run: async (context) => {
			const { mountCommander } = services
			const { mount } = context.devices
			if (mount === undefined) return missing('mount')
			if (mountCommander === undefined) return missing('mount commander')
			return taskResult(await mountCommander.park(context.scope, mount, { timeout: stepTimeout(context) }))
		},
		policy,
	}
}

// Shutdown task `closeOrParkDome`: closes the shutter of the dome or roof, then parks it when it can park (turning
// driver slaving off first, which a park refuses), each command within `shutdown.stepTimeout`. Both are attempted;
// the first failure is reported. It runs only while the dome is not closed and parked.
export function closeOrParkDomeTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'closeOrParkDome',
		shouldRun: ({ devices: { dome } }) => dome === undefined || !isDomeClosed(dome),
		run: async (context) => {
			const { domeCommander } = services
			const { dome } = context.devices
			if (dome === undefined) return missing('dome')
			if (domeCommander === undefined) return missing('dome commander')

			const timeout = stepTimeout(context)
			let failure: FailedOperationResult | undefined

			if (dome.hasShutter && dome.shutterState !== 'CLOSED') {
				const closed = await domeCommander.closeShutter(context.scope, dome, { timeout })
				if (!closed.ok) failure = closed
			}

			if (dome.canPark && (!dome.parked || dome.parking)) {
				const unslaved = dome.slaved && dome.canSlave ? await domeCommander.slave(context.scope, dome, false, { timeout }) : successfulOperationResult(undefined)
				const parked = unslaved.ok ? await domeCommander.park(context.scope, dome, { timeout }) : unslaved
				if (!parked.ok) failure ??= parked
			}

			return failure === undefined ? DONE : failed(failure)
		},
		policy,
	}
}

// Shutdown task `turnOffFlatPanel`: turns the flat panel light off. It runs only while the light is on.
export function turnOffFlatPanelTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'turnOffFlatPanel',
		shouldRun: ({ devices: { flatPanel } }) => flatPanel === undefined || !flatPanel.connected || flatPanel.enabled,
		run: async (context) => {
			const { flatPanelCommander } = services
			const { flatPanel } = context.devices
			if (flatPanel === undefined) return missing('flat panel')
			if (flatPanelCommander === undefined) return missing('flat panel commander')
			return taskResult(await flatPanelCommander.disable(context.scope, flatPanel))
		},
		policy,
	}
}

// Shutdown task `warmCamera`: switches the cooler of the primary camera off, letting the sensor warm at its natural
// rate; the setpoint is left as it was. It runs only while a controllable cooler is on.
export function warmCameraTask(services: SequencerLifecycleServices, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'warmCamera',
		shouldRun: ({ devices: { camera } }) => !camera.connected || (camera.hasCoolerControl && camera.cooler),
		run: async (context) => {
			const { cameraCommander } = services
			if (cameraCommander === undefined) return missing('camera commander')
			return taskResult(await cameraCommander.cooler(context.scope, context.devices.camera, false))
		},
		policy,
	}
}

// Lifecycle tasks of the startup in their fixed order (section 42), only the configured ones: cooling, dome, cover,
// mount unpark and track mode. The safety gates before the openings and the guiding quiescence are not part of it.
export function sequencerStartupLifecycleTasks(configuration: Pick<SequencerConfiguration, 'startup' | 'target' | 'meridianFlip'>, services: SequencerLifecycleServices): SequencerTask[] {
	const { cooling, dome, cover, mount } = configuration.startup
	const mode = sequencerStartupTrackMode(configuration)
	const tasks: SequencerTask[] = []

	if (cooling !== undefined) tasks.push(coolCameraTask(services, cooling))
	if (dome?.open === true) tasks.push(openDomeTask(services))
	if (cover?.open === true) tasks.push(openCoverTask(services))
	if (mount?.unpark === true) tasks.push(unparkMountTask(services))
	if (mode !== undefined) tasks.push(configureTrackingTask(services, mode))

	return tasks
}

// Lifecycle steps of the shutdown in their fixed physical order (section 31), only the configured ones, each with its
// configured policy: tracking off, cover, mount park, dome or roof, flat panel, camera warming. The guiding pause and
// stop around the tracking off are not part of it.
export function sequencerShutdownLifecycleTasks(shutdown: SequencerShutdownConfiguration, services: SequencerLifecycleServices): SequencerShutdownTask[] {
	const { stopTracking, closeCover, parkMount, closeOrParkDome, turnOffFlatPanel, warmCamera } = shutdown
	const tasks: SequencerShutdownTask[] = []

	if (stopTracking !== undefined) tasks.push(stopTrackingTask(services, stopTracking))
	if (closeCover !== undefined) tasks.push(closeCoverTask(services, closeCover))
	if (parkMount !== undefined) tasks.push(parkMountTask(services, parkMount))
	if (closeOrParkDome !== undefined) tasks.push(closeOrParkDomeTask(services, closeOrParkDome))
	if (turnOffFlatPanel !== undefined) tasks.push(turnOffFlatPanelTask(services, turnOffFlatPanel))
	if (warmCamera !== undefined) tasks.push(warmCameraTask(services, warmCamera))

	return tasks
}

const DONE: SequencerTaskResult = { ok: true }

// Selects `mode` on the mount unless it already reports it; observed by the commander. A mount without published
// track modes counts as SIDEREAL; any other mode it cannot select is a configuration failure.
async function selectTrackMode(context: SequencerContext, mountCommander: MountCommander, mount: Mount, mode: TrackMode): Promise<SequencerTaskResult> {
	if (hasTrackMode(mount, mode)) return DONE
	if (!mount.trackModes.includes(mode)) return configurationFailure(`mount ${mount.name} cannot track at ${mode}`)
	return taskResult(await mountCommander.setTrackMode(context.scope, mount, mode))
}

// Whether a connected mount reports `mode`; one without published track modes reports only SIDEREAL.
function hasTrackMode(mount: Mount, mode: TrackMode) {
	return mount.connected && (mount.trackModes.length === 0 ? mode === 'SIDEREAL' : mount.trackMode === mode)
}

// Whether a connected parkable device stands still parked (`parked`) or unparked.
function isParkableAt(device: Mount | Cover, parked: boolean) {
	return device.connected && !device.parking && device.parked === parked
}

// Whether a connected dome or roof stands unparked with its shutter (if any) open.
function isDomeOpen(dome: Dome) {
	return dome.connected && !dome.parked && !dome.parking && (!dome.hasShutter || dome.shutterState === 'OPEN')
}

// Whether a connected dome or roof stands with its shutter (if any) closed and parked (if it can park).
function isDomeClosed(dome: Dome) {
	return dome.connected && !dome.parking && (!dome.hasShutter || dome.shutterState === 'CLOSED') && (!dome.canPark || dome.parked)
}

// Timeout of each command of a shutdown step, in ms.
function stepTimeout(context: SequencerContext) {
	return context.configuration.shutdown.stepTimeout * 1000
}

// Task result of a commander result.
function taskResult(result: OperationResult<unknown>): SequencerTaskResult {
	return result.ok ? DONE : failed(result)
}

// Operation failure of a failed commander result.
function failed(result: FailedOperationResult): SequencerTaskResult {
	return { ok: false, failure: result.error === undefined ? { kind: 'operation', reason: result.reason } : { kind: 'operation', reason: result.reason, detail: result.error } }
}

// Configuration failure of a task that cannot run with the given devices or services.
function configurationFailure(detail: string): SequencerTaskResult {
	return { ok: false, failure: { kind: 'configuration', detail } }
}

// Configuration failure of a missing device or commander.
function missing(what: string) {
	return configurationFailure(`no ${what} for the task`)
}
