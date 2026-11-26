import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType, type DomeDirection } from '../device'
import type { MountManager } from '../manager/mount'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import type { SimulatorComponent } from './component'
import { type DomeSimulatorConfig, type DomeSimulatorConfigOverride, domeSimulatorConfig } from './dome.config'
import { DomeDrive } from './dome.drive'
import { DomeGeometry } from './dome.geometry'
import { DomeParking } from './dome.parking'
import { DomeShutter } from './dome.shutter'
import { DomeSlaving } from './dome.slaving'

// Simulated dome: a board with the azimuth drive, home and park, the shutter, the measured geometry
// and, with a mount manager, the slaving that keeps the slit in front of the snooped mount. Azimuths are
// INDI degrees; DomeManager converts them to the shared radian model.

// Options of a simulated dome.
export interface DomeSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_DOME_SIMULATOR_CONFIG.
	readonly config?: DomeSimulatorConfigOverride
	// Resolves the mount named by ACTIVE_TELESCOPE for slaving; without it the dome has no autosync.
	readonly mountManager?: MountManager
}

// Simulated dome whose azimuth and shutter move over time, observable through INDI vectors.
export class DomeSimulator extends BoardSimulator {
	readonly type = 'dome'

	// Configuration the dome was built with.
	readonly configuration: DomeSimulatorConfig

	readonly #drive: DomeDrive
	readonly #parking: DomeParking
	readonly #shutter: DomeShutter
	readonly #geometry: DomeGeometry
	readonly #slaving?: DomeSlaving

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DomeSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.DOME, 'dome.simulator', options?.now)
		const config = domeSimulatorConfig(options?.config)
		const connected = () => this.isConnected
		this.configuration = config
		this.#drive = new DomeDrive(this.bus, config.drive, {
			connected,
			started: (kind) => this.#parking.started(kind),
			arrived: (kind) => this.#parking.arrived(kind),
			stopped: (kind, alert) => this.#parking.stopped(kind, alert),
			abort: () => this.stop(),
		})
		this.#parking = new DomeParking(this.bus, config.parking, this.#drive, connected)
		this.#shutter = new DomeShutter(this.bus, config.shutter, connected)
		this.#geometry = new DomeGeometry(this.bus, config.geometry)

		const components: SimulatorComponent[] = []

		if (options?.mountManager) {
			this.#slaving = new DomeSlaving(this.bus, () => this.activeMount, this.#geometry, this.#parking, this.#drive)
			// Slaving retargets the drive before it turns, as in a step of a real controller.
			components.push(this.#slaving)
		}

		components.push(this.#drive, this.#parking, this.#shutter, this.#geometry)
		this.install(...components)
	}

	// Azimuth, degrees in [0, 360).
	get azimuth() {
		return this.#drive.azimuth
	}

	// Position the running shutter transition goes to, if any.
	get shutterTarget() {
		return this.#shutter.target
	}

	// Connected mount named by ACTIVE_TELESCOPE, when the dome has a mount manager.
	get activeMount() {
		const mount = this.options?.mountManager?.get(this.client, this.snoopDevices.elements.ACTIVE_TELESCOPE.value)
		return mount?.connected ? mount : undefined
	}

	// Whether the azimuth or the shutter moves.
	get isMoving() {
		return this.#drive.move !== undefined || this.#shutter.target !== undefined
	}

	// Whether slaving is on.
	get isSlaved() {
		return this.#slaving?.enabled ?? false
	}

	// Azimuth, degrees, the slit has to be at for the snooped mount, if any.
	get slavedAzimuth() {
		const mount = this.activeMount
		return mount === undefined ? undefined : this.#geometry.slitAzimuth(mount)
	}

	// Starts turning to `azimuth`, degrees, the short way round.
	moveTo(azimuth: number) {
		this.#drive.turnTo(azimuth)
	}

	// Starts turning by `delta`, degrees, signed.
	moveBy(delta: number) {
		this.#drive.turnBy(delta)
	}

	// Starts turning towards `direction` until stopped.
	moveContinuously(direction: DomeDirection) {
		this.#drive.turn(direction)
	}

	// Rewrites the azimuth without moving.
	syncTo(azimuth: number) {
		this.#drive.syncTo(azimuth)
	}

	// Starts turning to the home azimuth.
	home() {
		this.#parking.home()
	}

	// Starts turning to the park azimuth.
	park() {
		this.#parking.park()
	}

	// Marks the dome unparked without moving it.
	unpark() {
		this.#parking.unpark()
	}

	// Stores the current azimuth as the park azimuth.
	setPark() {
		this.#parking.setPark()
	}

	// Starts opening the shutter.
	openShutter() {
		this.#shutter.open()
	}

	// Starts closing the shutter.
	closeShutter() {
		this.#shutter.close()
	}

	// Stops the azimuth and the shutter and turns slaving off; a stop that interrupted anything publishes
	// the abort, Ok for an operator's abort (`alert`).
	stop(alert: boolean = true) {
		const moving = this.#drive.stop(alert)
		const shutterMoving = this.#shutter.stop(alert)
		this.#slaving?.disable()
		if (moving || shutterMoving) this.#drive.publishAbort(alert)
	}
}
