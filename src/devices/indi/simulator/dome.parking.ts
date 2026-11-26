import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { DomeParkingConfig } from './dome.config'
import type { DomeDrive, DomeMove } from './dome.drive'
import { applyNumberVectorValues } from './util'

// Parking circuit of the simulated dome: the home and park commands, which the drive carries out, the
// parked state, and the positions and slaving threshold of DOME_PARAMS. The park azimuth is published
// twice, in DOME_PARAMS and DOME_PARK_POSITION, kept equal. Azimuths are degrees.

// Home, park and their positions.
export class DomeParking extends SimulatorComponent {
	readonly #goto = makeSwitchVector('', 'DOME_GOTO', 'Home/Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['DOME_HOME', 'Home', false], ['DOME_PARK', 'Park', false])
	readonly #park = makeSwitchVector('', 'DOME_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #parkPosition: ReturnType<typeof makeNumberVector>
	readonly #parkOption = makeSwitchVector('', 'DOME_PARK_OPTION', 'Park option', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK_CURRENT', 'Park current position', false])
	readonly #params: ReturnType<typeof makeNumberVector>

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]
	// The positions and the threshold are settings kept across sessions; the commands are not.
	readonly transient = [this.#goto, this.#park, this.#parkOption]

	// `config` gives the positions and the threshold at power-up; `drive` carries the moves out;
	// `connected` says whether the dome accepts commands.
	constructor(
		bus: ComponentBus,
		config: DomeParkingConfig,
		readonly drive: DomeDrive,
		readonly connected: () => boolean,
	) {
		super(bus)
		this.#parkPosition = makeNumberVector('', 'DOME_PARK_POSITION', 'Park position', MAIN_CONTROL, 'rw', ['PARK_AZ', 'Degrees', config.parkAzimuth, 0, 360, 0.1, '%.2f'])
		// oxfmt-ignore
		this.#params = makeNumberVector('', 'DOME_PARAMS', 'Parameters', MAIN_CONTROL, 'rw', ['HOME_POSITION', 'Home position', config.homeAzimuth, 0, 360, 0.1, '%.2f'], ['PARK_POSITION', 'Park position', config.parkAzimuth, 0, 360, 0.1, '%.2f'], ['AUTOSYNC_THRESHOLD', 'Auto-sync threshold', config.autoSyncThreshold, 0, 360, 0.1, '%.2f'])
		this.properties = [this.#goto, this.#params, this.#park, this.#parkPosition, this.#parkOption]
	}

	// Azimuth difference, degrees, within which slaving leaves the slit where it is.
	get autoSyncThreshold() {
		return this.#params.elements.AUTOSYNC_THRESHOLD.value
	}

	// Park azimuth, degrees.
	get parkAzimuth() {
		return this.#parkPosition.elements.PARK_AZ.value
	}

	// Whether the dome is parked.
	get isParked() {
		return this.#park.elements.PARK.value && this.#park.state !== 'Busy'
	}

	// Starts turning to the home azimuth.
	home() {
		if (this.connected()) this.drive.turnTo(this.#params.elements.HOME_POSITION.value, 'home')
	}

	// Starts turning to the park azimuth.
	park() {
		if (this.connected()) this.drive.turnTo(this.parkAzimuth, 'park')
	}

	// Marks the dome unparked without moving it, stopping a park in progress.
	unpark() {
		if (!this.connected()) return
		if (this.drive.move === 'park' || this.#park.state === 'Busy') this.drive.stop(false)
		this.#clearPark('Ok')

		if (this.#goto.elements.DOME_PARK.value) {
			this.#goto.elements.DOME_PARK.value = false
			this.#goto.state = 'Ok'
			this.bus.notify(this.#goto)
		}
	}

	// Stores the current azimuth as the park azimuth.
	setPark() {
		if (!this.connected()) return
		this.#setParkAzimuth(this.drive.azimuth)
		this.#parkOption.state = 'Ok'
		this.#parkOption.elements.PARK_CURRENT.value = false
		this.bus.notify(this.#parkPosition)
		this.bus.notify(this.#params)
		this.bus.notify(this.#parkOption)
	}

	// A move of `kind` started: whatever moves the dome leaves home and park, and the home and park
	// commands go Busy.
	started(kind: DomeMove) {
		this.#clearHome('Idle')
		this.#clearPark('Idle')

		if (kind === 'home' || kind === 'park') {
			this.#goto.state = 'Busy'
			this.#goto.elements.DOME_HOME.value = kind === 'home'
			this.#goto.elements.DOME_PARK.value = kind === 'park'
			this.bus.notify(this.#goto)
		}

		if (kind === 'park') {
			this.#park.state = 'Busy'
			this.#park.elements.PARK.value = true
			this.#park.elements.UNPARK.value = false
			this.bus.notify(this.#park)
		}
	}

	// A move of `kind` arrived: the dome is at home, or parked.
	arrived(kind: DomeMove) {
		if (kind === 'home') {
			this.#clearPark('Idle')
			this.#goto.state = 'Ok'
			this.#goto.elements.DOME_HOME.value = true
			this.#goto.elements.DOME_PARK.value = false
			this.bus.notify(this.#goto)
		} else if (kind === 'park') {
			this.#goto.state = 'Ok'
			this.#goto.elements.DOME_HOME.value = false
			this.#goto.elements.DOME_PARK.value = true
			this.#park.state = 'Ok'
			this.#park.elements.PARK.value = true
			this.#park.elements.UNPARK.value = false
			this.bus.notify(this.#goto)
			this.bus.notify(this.#park)
		}
	}

	// A move of `kind` stopped before arriving: a home or park in progress ends, Alert when `alert`.
	stopped(kind: DomeMove, alert: boolean) {
		const state = alert ? 'Alert' : 'Idle'
		if (kind === 'home' || this.#goto.state === 'Busy') this.#clearHome(state)
		if (kind === 'park' || this.#park.state === 'Busy') this.#clearPark(state)
	}

	// Handles DOME_PARAMS and DOME_PARK_POSITION, keeping the park azimuth equal in both.
	handleNumber(vector: NewNumberVector) {
		if (vector.name === this.#params.name) {
			if (applyNumberVectorValues(this.#params, vector.elements)) {
				this.#parkPosition.elements.PARK_AZ.value = this.#params.elements.PARK_POSITION.value
				this.bus.notify(this.#params)
				this.bus.notify(this.#parkPosition)
			}

			return true
		}

		if (vector.name === this.#parkPosition.name) {
			if (applyNumberVectorValues(this.#parkPosition, vector.elements)) {
				this.#params.elements.PARK_POSITION.value = this.parkAzimuth
				this.bus.notify(this.#parkPosition)
				this.bus.notify(this.#params)
			}

			return true
		}

		return false
	}

	// Handles DOME_GOTO, DOME_PARK and DOME_PARK_OPTION.
	handleSwitch(vector: NewSwitchVector) {
		const { elements } = vector

		switch (vector.name) {
			case this.#goto.name:
				if (elements.DOME_HOME === true) this.home()
				else if (elements.DOME_PARK === true) this.park()
				return true
			case this.#park.name:
				if (elements.PARK === true) this.park()
				else if (elements.UNPARK === true) this.unpark()
				return true
			case this.#parkOption.name:
				if (elements.PARK_CURRENT === true) this.setPark()
				return true
		}

		return false
	}

	// Writes `azimuth`, degrees, as the park azimuth of both properties.
	#setParkAzimuth(azimuth: number) {
		this.#parkPosition.elements.PARK_AZ.value = azimuth
		this.#params.elements.PARK_POSITION.value = azimuth
	}

	// Clears the home selection, publishing `state` when anything changed.
	#clearHome(state: PropertyState) {
		if (!this.#goto.elements.DOME_HOME.value && this.#goto.state === state) return
		this.#goto.elements.DOME_HOME.value = false
		this.#goto.state = state
		this.bus.notify(this.#goto)
	}

	// Clears the parked state, publishing `state` when anything changed.
	#clearPark(state: PropertyState) {
		if (!this.#park.elements.PARK.value && this.#park.state === state) return
		this.#park.elements.PARK.value = false
		this.#park.elements.UNPARK.value = true
		this.#park.state = state
		this.bus.notify(this.#park)
	}
}
