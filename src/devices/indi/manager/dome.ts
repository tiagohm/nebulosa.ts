import { type Angle, deg, normalizeAngle, toDeg } from '../../../math/units/angle'
import { CLIENT, type Client, DEFAULT_DOME, DeviceInterfaceType, type Dome, type DomeDirection, type DomeOTASide, type DomeShutterState } from '../device'
import { findOnSwitch, type DefNumber, type DefNumberVector, type DefSwitchVector, type DefTextVector, type DelProperty, type OneNumber, type PropertyState, type SetNumberVector, type SetSwitchVector, type SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// Alternate INDI property names used for dome home and park actions.
type DomeParkProperties = {
	park?: 'DOME_PARK' | 'DOME_GOTO'
	hasHome?: boolean
}

// Element names used by a dome driver's autosync switch vector.
type DomeSlavingProperties = readonly [enabled: string, disabled: string]

// INDI dome manager: maps heterogeneous dome properties into the shared dome model and sends commands
// in INDI units. Angles are converted between model radians and property degrees at this boundary.
export class DomeManager extends DeviceManager<Dome> {
	// Tracks park aliases for each dome without adding backend details to the model.
	readonly #parkProperties = new WeakMap<Dome, DomeParkProperties>()
	// Tracks the driver's actual element names for enabling and disabling slaving.
	readonly #slavingProperties = new WeakMap<Dome, DomeSlavingProperties>()

	// Slews to an absolute azimuth in radians, normalized to [0, TAU).
	moveTo(dome: Dome, azimuth: Angle, client = dome[CLIENT]!) {
		if (dome.canSetAzimuth && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'ABS_DOME_POSITION', elements: { DOME_ABSOLUTE_POSITION: toDeg(normalizeAngle(azimuth)) } })
		}
	}

	// Slews to an absolute altitude in radians when the driver exposes the optional altitude vector.
	moveToAltitude(dome: Dome, altitude: Angle, client = dome[CLIENT]!) {
		if (dome.canSetAltitude && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'DOME_ALTITUDE', elements: { DOME_ALTITUDE_VALUE: toDeg(altitude) } })
		}
	}

	// Moves the dome by a signed relative azimuth in radians without normalizing the delta.
	moveBy(dome: Dome, delta: Angle, client = dome[CLIENT]!) {
		if (dome.canRelativeMove && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'REL_DOME_POSITION', elements: { DOME_RELATIVE_POSITION: toDeg(delta) } })
		}
	}

	// Starts or stops continuous clockwise/counter-clockwise dome motion.
	move(dome: Dome, direction: DomeDirection, enabled: boolean, client = dome[CLIENT]!) {
		if (dome.canMove && !dome.slaved) {
			client.sendSwitch({ device: dome.name, name: 'DOME_MOTION', elements: { [direction === 'CLOCKWISE' ? 'DOME_CW' : 'DOME_CCW']: enabled } })
		}
	}

	// Sets the dome rotation speed in RPM when the driver exposes a writable speed property.
	speed(dome: Dome, value: number, client = dome[CLIENT]!) {
		if (dome.canSetSpeed) {
			client.sendNumber({ device: dome.name, name: 'DOME_SPEED', elements: { DOME_SPEED_VALUE: value } })
		}
	}

	// Synchronizes the dome's reported azimuth in radians without starting a move.
	syncTo(dome: Dome, azimuth: Angle, client = dome[CLIENT]!) {
		if (dome.canSync && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'DOME_SYNC', elements: { DOME_SYNC_VALUE: toDeg(normalizeAngle(azimuth)) } })
		}
	}

	// Starts a move to the configured home position.
	home(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canFindHome) {
			client.sendSwitch({ device: dome.name, name: 'DOME_GOTO', elements: { DOME_HOME: true } })
		}
	}

	// Starts a move to the configured park position using the driver's advertised park property.
	park(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canPark && !dome.slaved) {
			const name = this.#parkProperties.get(dome)?.park ?? 'DOME_PARK'
			client.sendSwitch({ device: dome.name, name, elements: { [name === 'DOME_PARK' ? 'PARK' : 'DOME_PARK']: true } })
		}
	}

	// Unparks only when the driver exposes an explicit writable UNPARK element.
	unpark(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canUnpark) {
			client.sendSwitch({ device: dome.name, name: 'DOME_PARK', elements: { UNPARK: true } })
		}
	}

	// Stores the current azimuth as the park position using the driver's preferred compatible mechanism.
	setPark(dome: Dome, client = dome[CLIENT]!) {
		if (!dome.canSetPark) return

		const azimuth = toDeg(normalizeAngle(dome.azimuth.value))

		if (this.hasWritableProperty(dome, 'DOME_PARK_OPTION')) {
			client.sendSwitch({ device: dome.name, name: 'DOME_PARK_OPTION', elements: { PARK_CURRENT: true } })
		} else if (this.hasWritableProperty(dome, 'DOME_PARK_POSITION')) {
			client.sendNumber({ device: dome.name, name: 'DOME_PARK_POSITION', elements: { PARK_AZ: azimuth } })
		} else if (this.hasWritableProperty(dome, 'DOME_PARAMS')) {
			client.sendNumber({ device: dome.name, name: 'DOME_PARAMS', elements: { PARK_POSITION: azimuth } })
		}
	}

	// Starts an asynchronous shutter opening operation.
	openShutter(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canSetShutter) {
			client.sendSwitch({ device: dome.name, name: 'DOME_SHUTTER', elements: { SHUTTER_OPEN: true } })
		}
	}

	// Starts an asynchronous shutter closing operation.
	closeShutter(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canSetShutter) {
			client.sendSwitch({ device: dome.name, name: 'DOME_SHUTTER', elements: { SHUTTER_CLOSE: true } })
		}
	}

	// Enables or disables driver-side slaving.
	slave(dome: Dome, enabled: boolean, client = dome[CLIENT]!) {
		const properties = this.#slavingProperties.get(dome)
		if (dome.canSlave && properties) {
			client.sendSwitch({ device: dome.name, name: 'DOME_AUTOSYNC', elements: { [enabled ? properties[0] : properties[1]]: true } })
		}
	}

	// Aborts any motion supported by the dome driver.
	stop(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canAbort) {
			client.sendSwitch({ device: dome.name, name: 'DOME_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	// Enables or disables controller backlash compensation.
	backlash(dome: Dome, enabled: boolean, client = dome[CLIENT]!) {
		if (dome.hasBacklash) {
			client.sendSwitch({ device: dome.name, name: 'DOME_BACKLASH_TOGGLE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Sets controller backlash in raw driver steps.
	backlashSteps(dome: Dome, steps: number, client = dome[CLIENT]!) {
		if (dome.hasBacklash) {
			client.sendNumber({ device: dome.name, name: 'DOME_BACKLASH_STEPS', elements: { DOME_BACKLASH_VALUE: steps } })
		}
	}

	// Applies dome switch vectors: motion, abort, shutter, home/park, slaving, backlash, and OTA side.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		super.switchVector(client, message, tag)

		const definition = tag[0] === 'd' ? (message as DefSwitchVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(dome, message.name)
			else this.removeWritableProperty(dome, message.name)
		}

		switch (message.name) {
			case 'DOME_MOTION': {
				if (definition && handleSwitchValue(dome, 'canMove', definition.permission !== 'ro')) this.updated(dome, 'canMove', message.state)

				const selected = findOnSwitch(message).find((name) => name === 'DOME_CW' || name === 'DOME_CCW')
				const direction: DomeDirection | undefined = selected === 'DOME_CW' ? 'CLOCKWISE' : selected === 'DOME_CCW' ? 'COUNTER_CLOCKWISE' : undefined

				if (dome.direction !== direction || message.state === 'Alert') {
					dome.direction = direction
					this.updated(dome, 'direction', message.state)
				}

				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_ABORT_MOTION':
				if (definition && handleSwitchValue(dome, 'canAbort', definition.permission !== 'ro')) this.updated(dome, 'canAbort', message.state)
				return
			case 'DOME_SHUTTER': {
				if (definition && handleSwitchValue(dome, 'hasShutter', true)) this.updated(dome, 'hasShutter', message.state)
				if (definition && handleSwitchValue(dome, 'canSetShutter', definition.permission !== 'ro')) this.updated(dome, 'canSetShutter', message.state)

				const shutterState = domeShutterState(message)
				if (dome.shutterState !== shutterState || message.state === 'Alert') {
					dome.shutterState = shutterState
					this.updated(dome, 'shutterState', message.state)
				}

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_GOTO': {
				const hasHome = message.elements.DOME_HOME !== undefined
				const hasPark = message.elements.DOME_PARK !== undefined

				if (definition) {
					const parkProperties = this.#parkProperties.get(dome) ?? {}
					parkProperties.hasHome = hasHome
					if (hasPark && parkProperties.park === undefined) parkProperties.park = 'DOME_GOTO'
					this.#parkProperties.set(dome, parkProperties)
				}

				if (definition && handleSwitchValue(dome, 'canFindHome', hasHome && definition.permission !== 'ro')) this.updated(dome, 'canFindHome', message.state)
				if (definition && hasPark && handleSwitchValue(dome, 'canPark', definition.permission !== 'ro')) this.updated(dome, 'canPark', message.state)

				const home = message.elements.DOME_HOME?.value === true
				const parked = message.elements.DOME_PARK?.value === true
				const completed = message.state !== 'Busy' && message.state !== 'Alert'
				if (handleSwitchValue(dome, 'homing', home && message.state === 'Busy')) this.updated(dome, 'homing', message.state)
				if (handleSwitchValue(dome, 'atHome', home && completed)) this.updated(dome, 'atHome', message.state)

				if (hasPark) {
					if (handleSwitchValue(dome, 'parking', parked && message.state === 'Busy')) this.updated(dome, 'parking', message.state)
					if (handleSwitchValue(dome, 'parked', parked && completed)) this.updated(dome, 'parked', message.state)
				}

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_PARK': {
				const hasPark = message.elements.PARK !== undefined
				const hasUnpark = message.elements.UNPARK !== undefined

				if (definition) {
					this.#parkProperties.set(dome, { park: 'DOME_PARK', hasHome: this.#parkProperties.get(dome)?.hasHome })
				}

				if (definition && handleSwitchValue(dome, 'canPark', hasPark && definition.permission !== 'ro')) this.updated(dome, 'canPark', message.state)
				if (definition && handleSwitchValue(dome, 'canUnpark', hasUnpark && definition.permission !== 'ro')) this.updated(dome, 'canUnpark', message.state)

				const parked = message.elements.PARK?.value === true
				const completed = message.state !== 'Busy' && message.state !== 'Alert'
				if (handleSwitchValue(dome, 'parking', parked && message.state === 'Busy')) this.updated(dome, 'parking', message.state)
				if (handleSwitchValue(dome, 'parked', parked && completed)) this.updated(dome, 'parked', message.state)

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_AUTOSYNC': {
				if (definition) {
					const enabled = message.elements.INDI_ENABLED !== undefined ? 'INDI_ENABLED' : message.elements.ENABLE !== undefined ? 'ENABLE' : undefined
					const disabled = message.elements.INDI_DISABLED !== undefined ? 'INDI_DISABLED' : message.elements.DISABLE !== undefined ? 'DISABLE' : undefined

					if (enabled !== undefined && disabled !== undefined) this.#slavingProperties.set(dome, [enabled, disabled])
					else this.#slavingProperties.delete(dome)

					if (handleSwitchValue(dome, 'canSlave', enabled !== undefined && disabled !== undefined && definition.permission !== 'ro')) this.updated(dome, 'canSlave', message.state)
				}

				const enabled = this.#slavingProperties.get(dome)?.[0]
				const slaved = enabled === undefined ? (message.elements.INDI_ENABLED?.value ?? message.elements.ENABLE?.value) : message.elements[enabled]?.value
				if (slaved !== undefined && handleSwitchValue(dome, 'slaved', slaved)) this.updated(dome, 'slaved', message.state)
				return
			}
			case 'DOME_PARK_OPTION':
				if (definition && handleSwitchValue(dome, 'canSetPark', message.elements.PARK_CURRENT !== undefined && definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				return
			case 'DOME_BACKLASH_TOGGLE':
				if (definition && handleSwitchValue(dome, 'hasBacklash', definition.permission !== 'ro')) this.updated(dome, 'hasBacklash', message.state)
				if (handleSwitchValue(dome, 'backlashEnabled', message.elements.INDI_ENABLED?.value ?? message.elements.ENABLE?.value)) this.updated(dome, 'backlashEnabled', message.state)
				return
			case 'DM_OTA_SIDE': {
				const side = domeOTASide(message)
				if (dome.measurements.otaSide !== side || message.state === 'Alert') {
					dome.measurements.otaSide = side
					this.updated(dome, 'measurements', message.state)
				}
			}
		}
	}

	// Applies dome number vectors, converting angular values from degrees into model radians.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		const definition = tag[0] === 'd' ? (message as DefNumberVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(dome, message.name)
			else this.removeWritableProperty(dome, message.name)
		}

		switch (message.name) {
			case 'ABS_DOME_POSITION':
				if (definition && handleSwitchValue(dome, 'canSetAzimuth', definition.permission !== 'ro')) this.updated(dome, 'canSetAzimuth', message.state)
				if (handleMinMaxValue(dome.azimuth, domeAngleNumber(message.elements.DOME_ABSOLUTE_POSITION), tag)) this.updated(dome, 'azimuth', message.state)
				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			case 'REL_DOME_POSITION':
				if (definition && handleSwitchValue(dome, 'canRelativeMove', definition.permission !== 'ro')) this.updated(dome, 'canRelativeMove', message.state)
				return
			case 'DOME_SPEED':
				if (definition && handleSwitchValue(dome, 'canSetSpeed', definition.permission !== 'ro')) this.updated(dome, 'canSetSpeed', message.state)
				if (handleMinMaxValue(dome.speed, message.elements.DOME_SPEED_VALUE, tag)) this.updated(dome, 'speed', message.state)
				return
			case 'DOME_SYNC':
				if (definition && handleSwitchValue(dome, 'canSync', definition.permission !== 'ro')) this.updated(dome, 'canSync', message.state)
				return
			case 'DOME_ALTITUDE':
				if (definition && handleSwitchValue(dome, 'canSetAltitude', definition.permission !== 'ro')) this.updated(dome, 'canSetAltitude', message.state)
				if (handleMinMaxValue(dome.altitude, domeAngleNumber(message.elements.DOME_ALTITUDE_VALUE), tag)) this.updated(dome, 'altitude', message.state)
				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			case 'DOME_PARK_POSITION':
				if (definition && message.elements.PARK_AZ && handleSwitchValue(dome, 'canSetPark', definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				if (handleMinMaxValue(dome.parkPosition, domeAngleNumber(message.elements.PARK_AZ), tag)) this.updated(dome, 'parkPosition', message.state)
				return
			case 'DOME_PARAMS': {
				const home = message.elements.HOME_POSITION
				const park = message.elements.PARK_POSITION
				const threshold = message.elements.AUTOSYNC_THRESHOLD

				if (definition && park && handleSwitchValue(dome, 'canSetPark', definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				if (handleMinMaxValue(dome.homePosition, domeAngleNumber(home), tag)) this.updated(dome, 'homePosition', message.state)
				if (handleMinMaxValue(dome.parkPosition, domeAngleNumber(park), tag)) this.updated(dome, 'parkPosition', message.state)
				if (handleMinMaxValue(dome.autoSyncThreshold, domeAngleNumber(threshold), tag)) this.updated(dome, 'autoSyncThreshold', message.state)
				return
			}
			case 'DOME_BACKLASH_STEPS':
				if (handleMinMaxValue(dome.backlash, message.elements.DOME_BACKLASH_VALUE, tag)) this.updated(dome, 'backlash', message.state)
				return
			case 'DOME_MEASUREMENTS': {
				const fields: readonly [keyof Omit<Dome['measurements'], 'otaSide'>, string][] = [
					['radius', 'DOME_RADIUS'],
					['shutterWidth', 'DOME_SHUTTER_WIDTH'],
					['northDisplacement', 'DOME_NORTH_DISPLACEMENT'],
					['eastDisplacement', 'DOME_EAST_DISPLACEMENT'],
					['upDisplacement', 'DOME_UP_DISPLACEMENT'],
					['otaOffset', 'DOME_OTA_OFFSET'],
				]
				let updated = false

				for (const [field, elementName] of fields) {
					const element = message.elements[elementName]
					if (element !== undefined && dome.measurements[field] !== element.value) {
						dome.measurements[field] = element.value
						updated = true
					}
				}

				if (definition && handleSwitchValue(dome, 'hasMeasurements', true)) updated = true
				if (updated || message.state === 'Alert') this.updated(dome, 'measurements', message.state)
			}
		}
	}

	// Creates or updates a dome when its DRIVER_INFO advertises the DOME interface.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') this.handleDriverInfo(client, message, DeviceInterfaceType.DOME)
	}

	// Resets dome fields affected by a deleted INDI property and removes the device on full deletion.
	delProperty(client: Client, message: DelProperty) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		const name = message.name
		const full = !name

		if (full) {
			this.#parkProperties.delete(dome)
			this.#slavingProperties.delete(dome)
			this.clearWritableProperty(dome)
		} else {
			this.removeWritableProperty(dome, name)

			const parkProperties = this.#parkProperties.get(dome)
			if (name === 'DOME_PARK' && parkProperties?.park === 'DOME_PARK') parkProperties.park = undefined
			if (name === 'DOME_GOTO' && parkProperties?.park === 'DOME_GOTO') parkProperties.park = undefined
			if (name === 'DOME_GOTO' && parkProperties) parkProperties.hasHome = false
			if (name === 'DOME_AUTOSYNC') this.#slavingProperties.delete(dome)
		}

		if (full || name === 'DOME_MOTION') {
			resetDeviceValue(this, dome, 'canMove', DEFAULT_DOME.canMove)
			resetDeviceValue(this, dome, 'moving', DEFAULT_DOME.moving)
			resetDeviceValue(this, dome, 'direction', DEFAULT_DOME.direction)
		}
		if (full || name === 'REL_DOME_POSITION') resetDeviceValue(this, dome, 'canRelativeMove', DEFAULT_DOME.canRelativeMove)
		if (full || name === 'ABS_DOME_POSITION') {
			resetDeviceValue(this, dome, 'canSetAzimuth', DEFAULT_DOME.canSetAzimuth)
			resetDeviceValue(this, dome, 'azimuth', DEFAULT_DOME.azimuth)
			resetDeviceValue(this, dome, 'moving', DEFAULT_DOME.moving)
		}
		if (full || name === 'DOME_SPEED') {
			resetDeviceValue(this, dome, 'canSetSpeed', DEFAULT_DOME.canSetSpeed)
			resetDeviceValue(this, dome, 'speed', DEFAULT_DOME.speed)
		}
		if (full || name === 'DOME_ABORT_MOTION') resetDeviceValue(this, dome, 'canAbort', DEFAULT_DOME.canAbort)
		if (full || name === 'DOME_SHUTTER') {
			resetDeviceValue(this, dome, 'hasShutter', DEFAULT_DOME.hasShutter)
			resetDeviceValue(this, dome, 'canSetShutter', DEFAULT_DOME.canSetShutter)
			resetDeviceValue(this, dome, 'shutterState', DEFAULT_DOME.shutterState)
		}
		if (full || name === 'DOME_GOTO') {
			resetDeviceValue(this, dome, 'canFindHome', DEFAULT_DOME.canFindHome)
			resetDeviceValue(this, dome, 'homing', DEFAULT_DOME.homing)
			resetDeviceValue(this, dome, 'atHome', DEFAULT_DOME.atHome)
			if (this.#parkProperties.get(dome)?.park === undefined) {
				resetDeviceValue(this, dome, 'canPark', DEFAULT_DOME.canPark)
				resetDeviceValue(this, dome, 'parking', DEFAULT_DOME.parking)
				resetDeviceValue(this, dome, 'parked', DEFAULT_DOME.parked)
			}
		}
		if (full || name === 'DOME_PARK') {
			resetDeviceValue(this, dome, 'canUnpark', DEFAULT_DOME.canUnpark)
			if (this.#parkProperties.get(dome)?.park !== 'DOME_GOTO') {
				resetDeviceValue(this, dome, 'canPark', DEFAULT_DOME.canPark)
				resetDeviceValue(this, dome, 'parking', DEFAULT_DOME.parking)
				resetDeviceValue(this, dome, 'parked', DEFAULT_DOME.parked)
			}
		}
		if (full || name === 'DOME_PARK_OPTION' || name === 'DOME_PARK_POSITION' || name === 'DOME_PARAMS') resetDeviceValue(this, dome, 'canSetPark', DEFAULT_DOME.canSetPark)
		if (full || name === 'DOME_PARK_POSITION' || name === 'DOME_PARAMS') resetDeviceValue(this, dome, 'parkPosition', DEFAULT_DOME.parkPosition)
		if (full || name === 'DOME_PARAMS') {
			resetDeviceValue(this, dome, 'homePosition', DEFAULT_DOME.homePosition)
			resetDeviceValue(this, dome, 'autoSyncThreshold', DEFAULT_DOME.autoSyncThreshold)
		}
		if (full || name === 'DOME_SYNC') resetDeviceValue(this, dome, 'canSync', DEFAULT_DOME.canSync)
		if (full || name === 'DOME_ALTITUDE') {
			resetDeviceValue(this, dome, 'canSetAltitude', DEFAULT_DOME.canSetAltitude)
			resetDeviceValue(this, dome, 'altitude', DEFAULT_DOME.altitude)
		}
		if (full || name === 'DOME_AUTOSYNC') {
			resetDeviceValue(this, dome, 'canSlave', DEFAULT_DOME.canSlave)
			resetDeviceValue(this, dome, 'slaved', DEFAULT_DOME.slaved)
		}
		if (full || name === 'DOME_BACKLASH_TOGGLE') {
			resetDeviceValue(this, dome, 'hasBacklash', DEFAULT_DOME.hasBacklash)
			resetDeviceValue(this, dome, 'backlashEnabled', DEFAULT_DOME.backlashEnabled)
		}
		if (full || name === 'DOME_BACKLASH_STEPS') resetDeviceValue(this, dome, 'backlash', DEFAULT_DOME.backlash)
		if (full || name === 'DOME_MEASUREMENTS') {
			resetDeviceValue(this, dome, 'hasMeasurements', DEFAULT_DOME.hasMeasurements)
			resetDeviceValue(this, dome, 'measurements', DEFAULT_DOME.measurements)
		}
		if (full || name === 'DM_OTA_SIDE') {
			resetDeviceValue(this, dome, 'measurements', { ...dome.measurements, otaSide: DEFAULT_DOME.measurements.otaSide })
		}

		updateDomeSlewing(this, dome)
		super.delProperty(client, message)
	}
}

// Converts an INDI angular number from degrees to radians, including its optional range metadata.
function domeAngleNumber(element: DefNumber | OneNumber | undefined): DefNumber | OneNumber | undefined {
	if (element === undefined) return

	if ('format' in element) {
		return { ...element, min: deg(element.min), max: deg(element.max), step: deg(element.step), value: deg(element.value) }
	}

	return {
		...element,
		min: element.min === undefined ? undefined : deg(element.min),
		max: element.max === undefined ? undefined : deg(element.max),
		step: element.step === undefined ? undefined : deg(element.step),
		value: deg(element.value),
	}
}

// Derives the shared shutter state from the selected INDI shutter command and property state.
function domeShutterState(message: DefSwitchVector | SetSwitchVector): DomeShutterState {
	if (message.state === 'Alert') return 'ERROR'

	const selected = findOnSwitch(message)
	const opening = selected.some((name) => name.endsWith('OPEN'))
	const closing = selected.some((name) => name.endsWith('CLOSE'))

	if (opening) return message.state === 'Busy' ? 'OPENING' : 'OPEN'
	if (closing) return message.state === 'Busy' ? 'CLOSING' : 'CLOSED'
	return 'UNKNOWN'
}

// Converts the driver's selected OTA-side switch into the normalized shared measurement value.
function domeOTASide(message: DefSwitchVector | SetSwitchVector): DomeOTASide {
	const selected = findOnSwitch(message)

	if (selected.some((name) => name.endsWith('EAST'))) return 'EAST'
	if (selected.some((name) => name.endsWith('WEST'))) return 'WEST'
	return 'UNKNOWN'
}

// Recomputes the aggregate rotational/home/park motion flag after a related property update.
function updateDomeSlewing(manager: DeviceManager<Dome>, dome: Dome, state?: PropertyState) {
	const slewing = dome.moving || dome.homing || dome.parking

	if (handleSwitchValue(dome, 'slewing', slewing, state)) manager.updated(dome, 'slewing', state)
}
