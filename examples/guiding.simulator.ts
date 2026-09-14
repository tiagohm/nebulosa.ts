import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { Time } from '../src/astronomy/time/time'
import { IndiClientHandlerSet } from '../src/devices/indi/client'
import type { Camera, GuideOutput, Mount } from '../src/devices/indi/device'
import { CameraManager } from '../src/devices/indi/manager/camera'
import type { DeviceProvider } from '../src/devices/indi/manager/device'
import { GuideOutputManager } from '../src/devices/indi/manager/guideoutput'
import { MountManager } from '../src/devices/indi/manager/mount'
import { CameraSimulator } from '../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../src/devices/indi/simulator/client'
import { MountSimulator } from '../src/devices/indi/simulator/mount'
import type { CatalogSource } from '../src/devices/indi/simulator/types'
import { type GuideFrameImage, GuiderClient, type GuiderEvents } from '../src/observation/guiding/client'
import type { GuideTracker } from '../src/observation/guiding/tracker'
import { nonSiderealTrackingOf } from '../src/observation/guiding/tracker.nonsidereal'

// Shared real-time INDI simulator harness for the interactive guiding examples. The simulators own
// camera exposures, mount mechanics, pulse latency, and cleanup; this module only wires their managers
// to GuiderClient and exposes deterministic fault controls through a line-oriented REPL.

// Fault switches controlled by the REPL and observed by each example's catalog provider.
export interface GuidingSimulationFailures {
	// Removes every catalog star from newly rendered frames.
	noStars: boolean
	// Causes the catalog provider to return stars whose rendered profiles are saturated.
	saturated: boolean
	// Causes the catalog provider to return candidates below the tracker quality threshold.
	lowQuality: boolean
}

// Context supplied while constructing a catalog provider. The simulated UTC clock is the same clock
// used by CameraSimulator exposures and MountSimulator motion, so moving targets can share one epoch.
export interface GuidingCatalogContext {
	readonly failures: GuidingSimulationFailures
	readonly getUtcTime: () => number
}

// Hooks specific to one example's tracker or target model.
export interface GuidingSimulationOptions {
	// Tracker injected into GuiderClient.
	readonly tracker: GuideTracker
	// Builds the named catalog source selected on the simulated camera.
	readonly catalogSource: (context: GuidingCatalogContext) => CatalogSource
	// Called after GuiderClient solves calibration, before the next guiding frame.
	readonly calibrationComplete?: (simulation: GuidingSimulation) => void
	// Called when the user invokes `flip`; non-sidereal examples use this to invalidate their transform.
	readonly calibrationFlipped?: (simulation: GuidingSimulation) => void
	// Called by `recover` after devices and scene faults have been restored.
	readonly recover?: (simulation: GuidingSimulation) => void
	// Optional conversion from camera Unix timestamps to an astronomical time model.
	readonly timeFactory?: (timestampMillis: number) => Time
	// Optional display title.
	readonly title?: string
}

// In-process device graph and GuiderClient used by one example session.
export class GuidingSimulation {
	readonly failures: GuidingSimulationFailures = { noStars: false, saturated: false, lowQuality: false }
	readonly handler: IndiClientHandlerSet
	readonly cameraManager: CameraManager
	readonly mountManager: MountManager
	readonly guideOutputManager: GuideOutputManager
	readonly simulatorClient: ClientSimulator
	readonly mountSimulator: MountSimulator
	readonly cameraSimulator: CameraSimulator
	readonly camera: Camera
	readonly mount: Mount
	readonly guideOutput: GuideOutput
	readonly client: GuiderClient
	readonly tracker: GuideTracker
	readonly #options: GuidingSimulationOptions
	#disposed = false

	// Creates and connects a mount/camera pair, then binds the camera's guide-output proxy to the client.
	constructor(options: GuidingSimulationOptions) {
		this.#options = options
		this.tracker = options.tracker
		this.handler = new IndiClientHandlerSet()
		this.cameraManager = new CameraManager()
		this.mountManager = new MountManager()
		const guideOutputProvider: DeviceProvider<GuideOutput> = {
			get: (client, name) => this.mountManager.get(client, name) ?? this.cameraManager.get(client, name),
		}
		this.guideOutputManager = new GuideOutputManager(guideOutputProvider)

		this.handler.add(this.mountManager)
		this.handler.add(this.cameraManager)
		this.handler.add(this.guideOutputManager)

		this.simulatorClient = new ClientSimulator(`guiding-example-${Date.now()}`, this.handler)
		this.mountSimulator = new MountSimulator('Guiding Mount Simulator', this.simulatorClient)
		this.cameraSimulator = new CameraSimulator('Guiding Camera Simulator', this.simulatorClient, {
			mountManager: this.mountManager,
			guideOutputManager: this.guideOutputManager,
			catalogSources: { GUIDING: options.catalogSource({ failures: this.failures, getUtcTime: () => this.mountSimulator.utcTime }) },
		})

		this.mount = this.mountManager.get(this.simulatorClient, this.mountSimulator.name)!
		this.camera = this.cameraManager.get(this.simulatorClient, this.cameraSimulator.name)!

		this.mountSimulator.connect()
		this.cameraSimulator.connect()
		this.guideOutput = this.guideOutputManager.get(this.simulatorClient, this.camera.name)!

		this.client = new GuiderClient(this.cameraManager, this.guideOutputManager, this.tracker, {
			calibrator: { clearingMoveEnabled: false, settleFramesAfterMove: 1, raPulse: 1000, decPulse: 1000, minMovePerStepPx: 0.05, minNetRaTravelPx: 0.5, minNetDecTravelPx: 0.5, maxRaNoMotionSteps: 10, maxDecNoMotionSteps: 10 },
			timeFactory: options.timeFactory,
			handler: {
				event: (_client, event) => this.#handleEvent(event),
				frame: (_client, frame) => this.#handleFrame(frame),
			},
		})

		this.cameraManager.snoop(this.camera, this.mount)
		this.#configureMount()
		this.#configureCamera()
		this.client.connect(this.camera, this.guideOutput, { focalLength: 400, pixelSize: 5.2 })
		this.simulatorClient.sendSwitch({ device: this.camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { GUIDING: true } })
	}

	// Starts passive exposure looping. Guiding remains an explicit REPL command so the first frame can
	// be inspected before calibration begins.
	start() {
		this.client.loop()
		this.#print(`${this.#options.title ?? 'guiding simulator'} started; waiting for the first frame`)
	}

	// Handles one REPL command and returns true when the caller should terminate the process.
	command(line: string): boolean {
		const [rawCommand, rawValue] = line.trim().toLowerCase().split(/\s+/, 2)
		const command = rawCommand ?? ''
		const value = rawValue === 'on' || rawValue === 'off' ? rawValue === 'on' : undefined

		switch (command) {
			case '':
				return false
			case 'help':
				this.#print('commands: status, loop, guide, stop, empty on|off, saturate on|off, low-quality on|off, flip, camera on|off, mount on|off, recover, quit')
				return false
			case 'status':
				this.#status()
				return false
			case 'loop':
				this.#print(this.client.loop() ? 'looping' : 'loop could not start')
				return false
			case 'guide':
				this.#print(this.client.guide(false, { time: 0.5, pixels: 1, timeout: 30 }) ? 'guiding requested' : 'guide request rejected')
				return false
			case 'stop':
				this.client.stopCapture()
				this.#print('capture stopped')
				return false
			case 'empty':
				if (value === undefined) this.#print(`empty ${this.failures.noStars ? 'on' : 'off'}`)
				else this.failures.noStars = value
				this.#print(`empty stars ${this.failures.noStars ? 'enabled' : 'disabled'}`)
				return false
			case 'saturate':
				if (value === undefined) this.#print(`saturation ${this.failures.saturated ? 'on' : 'off'}`)
				else this.failures.saturated = value
				this.#setCameraSaturation(this.failures.saturated)
				this.#print(`saturation ${this.failures.saturated ? 'enabled' : 'disabled'}`)
				return false
			case 'low-quality':
				if (value === undefined) this.#print(`low quality ${this.failures.lowQuality ? 'on' : 'off'}`)
				else this.failures.lowQuality = value
				this.#print(`low quality ${this.failures.lowQuality ? 'enabled' : 'disabled'}`)
				return false
			case 'flip':
				this.#print(this.client.flipCalibration() ? 'calibration flipped' : 'calibration flip rejected')
				return false
			case 'camera':
				this.#setCameraConnected(value)
				return false
			case 'mount':
				this.#setMountConnected(value)
				return false
			case 'recover':
				this.#recover()
				return false
			case 'quit':
			case 'exit':
				return true
			default:
				this.#print(`unknown command: ${command}; use help`)
				return false
		}
	}

	// Releases camera, mount, client, and simulator resources in dependency order.
	dispose() {
		if (this.#disposed) return
		this.#disposed = true
		this.client.stopCapture()
		this.client.disconnect()
		this.simulatorClient[Symbol.dispose]()
	}

	// Prints the current guider and simulator state in one compact snapshot.
	#status() {
		const pointing = this.mountSimulator.pointingState
		const calibration = this.client.getCalibrationData()
		this.#print(
			JSON.stringify(
				{
					appState: this.client.getAppState(),
					trackerState: nonSiderealTrackingOf(this.tracker.lastResult)?.state ?? 'base',
					calibration,
					cameraConnected: this.camera.connected,
					mountConnected: this.mount.connected,
					failures: this.failures,
					reported: pointing.reported,
					mechanical: pointing.mechanical,
					boresight: pointing.boresight,
					catalogSource: this.cameraSimulator.catalogSourceType,
					lockPosition: this.client.getLockPosition(),
				},
				undefined,
				2,
			),
		)
	}

	// Applies mount error families and representative physical values used by both examples.
	#configureMount() {
		this.simulatorClient.sendSwitch({ device: this.mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true, PERIODIC_ERROR: true, MECHANICS: true, GUIDING: true, SETTLING: true, FLEXURE: true, WIND: true, TRACKING_RATE: true } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 180, LATENCY_JITTER: 35, MINIMUM_PULSE: 20, QUANTIZATION: 10, GAIN_NORTH: 0.96, GAIN_SOUTH: 1.04, GAIN_EAST: 1, GAIN_WEST: 1 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'GUIDE_RATE', elements: { GUIDE_RATE_WE: 1, GUIDE_RATE_NS: 1 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_AMPLITUDE: 7.5, RA_AMPLITUDE_2: 2.5, RA_AMPLITUDE_3: 1 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_MECHANICS', elements: { BACKLASH_RA: 20, BACKLASH_DEC: 45, TAKE_UP_RATE: 0.7, STICTION_RA: 1, STICTION_DEC: 2 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 3, FREQUENCY: 2, DAMPING_RATIO: 0.25 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_FLEXURE', elements: { TUBE_FLEXURE: 20, PIER_WEST_RA: 12, PIER_WEST_DEC: 12 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_WIND', elements: { AMPLITUDE: 1.5, CORRELATION_TIME: 3 } })
		this.simulatorClient.sendNumber({ device: this.mount.name, name: 'MOUNT_TRACKING_RATE', elements: { BIAS: 35, TEMPERATURE_COEFFICIENT: 1.5, RANDOM_WALK: 0.25 } })
		this.mountSimulator.syncTo(1.2, 0.35)
		this.mountSimulator.setTrackingEnabled(true)
	}

	// Enables a stable but non-ideal synthetic detector configuration.
	#configureCamera() {
		this.simulatorClient.sendNumber({ device: this.camera.name, name: 'CCD_FRAME', elements: { X: 320, Y: 272, WIDTH: 640, HEIGHT: 480 } })
		this.simulatorClient.sendNumber({ device: this.camera.name, name: 'SIMULATOR_SCENE', elements: { SCENE_SEED: 424242, SEEING: 1.4, FLUX_MIN: 0.05, FLUX_MAX: 0.8 } })
		this.simulatorClient.sendSwitch({ device: this.camera.name, name: 'SIMULATOR_NOISE_QUALITY', elements: { HIGH_REALISM: true } })
		this.simulatorClient.sendSwitch({ device: this.camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, MOON_ENABLED: false, AMP_GLOW_ENABLED: false, OUTPUT_QUANTIZE: false } })
	}

	#setCameraSaturation(enabled: boolean) {
		this.simulatorClient.sendSwitch({ device: this.camera.name, name: 'SIMULATOR_STAR_PLOT_FLAGS', elements: { SATURATION_ENABLED: enabled } })
		this.simulatorClient.sendNumber({ device: this.camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { SATURATION_LEVEL: enabled ? 0.12 : 1 } })
	}

	#setCameraConnected(enabled: boolean | undefined) {
		if (enabled === undefined) {
			this.#print(`camera ${this.camera.connected ? 'on' : 'off'}`)
			return
		}
		if (enabled) this.cameraSimulator.connect()
		else this.cameraSimulator.disconnect()
		this.#print(`camera ${enabled ? 'connected' : 'disconnected'}`)
	}

	#setMountConnected(enabled: boolean | undefined) {
		if (enabled === undefined) {
			this.#print(`mount ${this.mount.connected ? 'on' : 'off'}`)
			return
		}
		if (enabled) this.mountSimulator.connect()
		else this.mountSimulator.disconnect()
		this.#print(`mount ${enabled ? 'connected' : 'disconnected'}`)
	}

	#recover() {
		this.failures.noStars = false
		this.failures.saturated = false
		this.failures.lowQuality = false
		this.#setCameraSaturation(false)
		if (!this.mount.connected) this.mountSimulator.connect()
		if (!this.camera.connected) this.cameraSimulator.connect()
		this.cameraManager.snoop(this.camera, this.mount)
		this.#options.recover?.(this)
		this.client.loop()
		this.client.guide(false, { time: 0.5, pixels: 1, timeout: 30 })
		this.#print('faults cleared; recovery requested')
	}

	#handleEvent(event: GuiderEvents) {
		if (event.Event === 'CalibrationComplete') this.#options.calibrationComplete?.(this)
		if (event.Event === 'CalibrationDataFlipped') this.#options.calibrationFlipped?.(this)
		const detail = JSON.stringify(event)
		this.#print(`[event] ${event.Event}${detail}`)
	}

	#handleFrame(frame: GuideFrameImage) {
		const measurement = frame.tracking.measurement
		const nonSidereal = nonSiderealTrackingOf(frame.tracking)
		this.#print(
			`[frame ${frame.frameId}] state=${frame.state} candidates=${frame.tracking.candidateCount} accepted=${frame.tracking.acceptedCount} rejected=${JSON.stringify(frame.tracking.rejectedReasons)} measurement=${measurement === undefined ? 'none' : `${measurement.x.toFixed(1)},${measurement.y.toFixed(1)}`} target=${frame.lockPosition?.map((value) => value.toFixed(1)).join(',') ?? 'none'}${nonSidereal === undefined ? '' : ` ns=${nonSidereal.state} offset=${nonSidereal.targetOffset?.map((value) => value.toFixed(3)).join(',') ?? 'none'}`}`,
		)
	}

	#print(message: string) {
		console.info(`[${new Date().toISOString()}] ${message}`)
	}
}

// Runs the shared REPL until `quit`, EOF, or Ctrl+C, then disposes the simulation.
export async function runGuidingSimulation(simulation: GuidingSimulation) {
	const terminal = createInterface({ input: stdin, output: stdout, terminal: true })

	const close = () => {
		simulation.dispose()
		terminal.close()
	}

	terminal.on('SIGINT', close)
	simulation.start()

	try {
		for await (const line of terminal) {
			if (simulation.command(line)) break
		}
	} finally {
		terminal.close()
		simulation.dispose()
	}
}
