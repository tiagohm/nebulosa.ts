import { observedToCirs } from '../../../astronomy/coordinates/astrometry'
import { eclipticToEquatorial, equatorialFromJ2000, galacticToEquatorial } from '../../../astronomy/coordinates/coordinate'
import type { GeographicCoordinate } from '../../../astronomy/observer/location'
import { formatTemporal, parseTemporal } from '../../../astronomy/time/temporal'
import { type Time, timeNow } from '../../../astronomy/time/time'
import { TAU } from '../../../core/constants'
import { type Angle, deg, hour, normalizeAngle, normalizePI, parseAngle, toDeg, toHour } from '../../../math/units/angle'
import { meter, toMeter } from '../../../math/units/distance'
import { CLIENT, type Client, DEFAULT_MOUNT, DeviceInterfaceType, type GPS, type Mount, type MountTargetCoordinate, type NameAndLabel, type TrackMode } from '../device'
import { findOnSwitch, type DefNumberVector, type DefSwitch, type DefSwitchVector, type DefTextVector, type DelProperty, type SetNumberVector, type SetSwitchVector, type SetTextVector } from '../types'
import { DeviceManager, handleNumberValue, handleParkable, handleSwitchValue, handleTextValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/inditelescope.cpp

// ALIGNMENT_POINTSET_ACTION members supported by the manager. The vector is OneOfMany and the driver
// keeps the last selection, so every commit must be preceded by its own action.
type AlignmentPointSetAction = 'DELETE' | 'CLEAR' | 'LOAD DATABASE' | 'SAVE DATABASE'

// Element name of the ALIGNMENT_SUBSYSTEM_ACTIVE switch. INDI declares it with spaces, unlike every
// other alignment element, so it must be spelled exactly like this.
const ALIGNMENT_SUBSYSTEM_ACTIVE = 'ALIGNMENT SUBSYSTEM ACTIVE'

// Manager for mounts/telescopes. Command methods slew/sync/goto (converting target frames to the mount's
// equatorial frame), track, park/home, move axes, and pulse-guide; property handling maps coordinate,
// tracking, pier-side, site/time, and capability vectors onto the Mount state. Angles are radians.
// The INDI Alignment Subsystem is exposed as administrative commands over Mount.alignment.
export class MountManager extends DeviceManager<Mount> {
	// Tracks the driver's actual element name for the alignment subsystem's active switch. The read path
	// tolerates a driver that renamed it, so the write path must target the name really defined instead of
	// the INDI constant, which such a driver would ignore.
	readonly #alignmentActiveElements = new WeakMap<Mount, string>()

	tracking(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_STATE', elements: { [enable ? 'TRACK_ON' : 'TRACK_OFF']: true } })
	}

	park(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { PARK: true } })
		}
	}

	unpark(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { UNPARK: true } })
		}
	}

	setPark(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canSetPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK_OPTION', elements: { PARK_CURRENT: true } })
		}
	}

	stop(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canAbort) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	home(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { GO: true } })
		}
	}

	findHome(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canFindHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { FIND: true } })
		}
	}

	setHome(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canSetHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { SET: true } })
		}
	}

	equatorialCoordinate(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		client.sendNumber({ device: mount.name, name: 'EQUATORIAL_EOD_COORD', elements: { RA: toHour(normalizeAngle(rightAscension)), DEC: toDeg(declination) } })
	}

	geographicCoordinate(mount: Mount, { latitude, longitude, elevation }: GeographicCoordinate, client = mount[CLIENT]!) {
		longitude = longitude < 0 ? longitude + TAU : longitude
		client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: toDeg(latitude), LONG: toDeg(longitude), ELEV: toMeter(elevation) } })
	}

	time(mount: Mount, time: GPS['time'], client = mount[CLIENT]!) {
		const UTC = formatTemporal(time.utc, 'YYYY-MM-DDTHH:mm:ss')
		const OFFSET = (time.offset / 60).toString()
		client.sendText({ device: mount.name, name: 'TIME_UTC', elements: { UTC, OFFSET } })
	}

	syncTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canSync) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { SYNC: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	goTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canGoTo) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { SLEW: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	flipTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canFlip) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { FLIP: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	moveTo(mount: Mount, mode: 'goto' | 'flip' | 'sync', req: MountTargetCoordinate<string | Angle>, client = mount[CLIENT]!, time?: Time) {
		const { type } = req
		const { x, y } = req[type]!
		const equatorial: [number, number] = [typeof x === 'string' ? parseAngle(x, type === 'JNOW' || type === 'J2000' ? true : undefined)! : x, typeof y === 'string' ? parseAngle(y)! : y]

		if (type === 'J2000') {
			Object.assign(equatorial, equatorialFromJ2000(...equatorial))
		} else if (type === 'ALTAZ') {
			Object.assign(equatorial, observedToCirs(...equatorial, time ?? timeNow(true), undefined, mount.geographicCoordinate))
		} else if (type === 'ECLIPTIC') {
			Object.assign(equatorial, eclipticToEquatorial(...equatorial, time ?? timeNow(true)))
		} else if (type === 'GALACTIC') {
			Object.assign(equatorial, equatorialFromJ2000(...galacticToEquatorial(...equatorial)))
		}

		if (mode === 'goto') this.goTo(mount, ...equatorial, client)
		else if (mode === 'flip') this.flipTo(mount, ...equatorial, client)
		else if (mode === 'sync') this.syncTo(mount, ...equatorial, client)
	}

	trackMode(mount: Mount, mode: TrackMode, client = mount[CLIENT]!) {
		if (mount.canTracking) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_MODE', elements: { [`TRACK_${mode}`]: true } })
		}
	}

	slewRate(mount: Mount, rate: NameAndLabel | string, client = mount[CLIENT]!) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_SLEW_RATE', elements: { [typeof rate === 'string' ? rate : rate.name]: true } })
	}

	moveNorth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false } })
		}
	}

	moveSouth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: false } })
		}
	}

	moveWest(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false } })
		}
	}

	moveEast(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: false } })
		}
	}

	// Enables or disables the INDI Alignment Subsystem. No-op when the mount does not expose it or the
	// switch is read-only. Targets the element name the driver actually defined, so a driver that renamed
	// the INDI member — the same case the read path tolerates — is commanded instead of silently ignoring
	// an unknown member. The local `alignment.active` is not changed optimistically: it only follows the
	// driver's own set vector, since the driver may refuse the change.
	alignmentActive(mount: Mount, active: boolean, client = mount[CLIENT]!) {
		if (mount.alignment.available) {
			const element = this.#alignmentActiveElements.get(mount) ?? ALIGNMENT_SUBSYSTEM_ACTIVE
			client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', elements: { [element]: active } })
		}
	}

	// Selects one of the math plugins advertised in `alignment.plugins`. Accepts the element itself or its
	// name. No-op for an unknown plugin, or when the vector is absent/read-only. The driver initialises the
	// newly loaded plugin with the current database, so no explicit initialize is issued here; a driver
	// that refuses the plugin reverts to its inbuilt one, which is why `alignment.plugin` is not set
	// optimistically.
	alignmentPlugin(mount: Mount, plugin: NameAndLabel | string, client = mount[CLIENT]!) {
		if (!mount.alignment.available) return

		const name = typeof plugin === 'string' ? plugin : plugin.name
		const { plugins } = mount.alignment

		for (let i = 0; i < plugins.length; i++) {
			if (plugins[i].name === name) {
				client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS', elements: { [name]: true } })
				return
			}
		}
	}

	// Re-initialises the current math plugin against the current alignment database. No-op when the mount
	// does not expose the subsystem or the momentary switch is absent/read-only. Used as the best-effort
	// tail of every database-mutating sequence, where its absence must not undo the action already sent.
	alignmentInitialize(mount: Mount, client = mount[CLIENT]!) {
		if (mount.alignment.available) {
			client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', elements: { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true } })
		}
	}

	// Deletes the alignment point at `index` (0-based) and re-initialises the math plugin. No-op when the
	// index is not an integer within [0, pointCount), when the subsystem is unavailable, or when any of the
	// pointer/action/commit properties is absent or read-only. The bounds check is required: an index past
	// the end makes the driver delete a different entry or leave its pointer displaced, producing a
	// plausible-looking but wrong database. `pointCount` is not decremented locally; it follows the
	// driver's ALIGNMENT_POINTSET_SIZE.
	alignmentDeletePoint(mount: Mount, index: number, client = mount[CLIENT]!) {
		if (!Number.isInteger(index) || index < 0 || index >= mount.alignment.pointCount) return
		this.#alignmentAction(mount, 'DELETE', true, client, index)
	}

	// Deletes the last alignment point, if any. This is the primitive an application can use to undo a
	// mistaken SYNC, but only after confirming that the SYNC actually appended a point: not every driver
	// routes SYNC through the alignment database.
	alignmentDeleteLastPoint(mount: Mount, client = mount[CLIENT]!) {
		const { pointCount } = mount.alignment
		if (pointCount > 0) this.alignmentDeletePoint(mount, pointCount - 1, client)
	}

	// Deletes every alignment point and re-initialises the math plugin. `pointCount` is not zeroed locally.
	alignmentClear(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'CLEAR', true, client)
	}

	// Persists the in-memory alignment database to the driver's local storage. The math plugin is not
	// re-initialised because the in-memory database did not change.
	alignmentSave(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'SAVE DATABASE', false, client)
	}

	// Reloads the alignment database from the driver's local storage and re-initialises the math plugin.
	// The explicit initialize is idempotent and keeps the outcome deterministic across driver versions that
	// may or may not re-initialise on their own. The point count is not assumed to be preserved; it follows
	// the driver's ALIGNMENT_POINTSET_SIZE.
	alignmentLoad(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'LOAD DATABASE', true, client)
	}

	// Sends one pointset action followed by its commit, optionally preceded by the entry pointer and
	// followed by a math plugin re-initialisation. Every gate is evaluated before the first send, so the
	// sequence is all-or-nothing: sending the pointer before knowing the action is writable would leave the
	// driver's current entry displaced with no matching operation. `index` is assumed already validated by
	// the caller.
	#alignmentAction(mount: Mount, action: AlignmentPointSetAction, reinitialize: boolean, client: Client, index?: number) {
		if (!mount.alignment.available) return

		if (index !== undefined) {
			client.sendNumber({ device: mount.name, name: 'ALIGNMENT_POINTSET_CURRENT_ENTRY', elements: { ALIGNMENT_POINTSET_CURRENT_ENTRY: index } })
		}

		client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_POINTSET_ACTION', elements: { [action]: true } })
		client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_POINTSET_COMMIT', elements: { ALIGNMENT_POINTSET_COMMIT: true } })

		if (reinitialize) this.alignmentInitialize(mount, client)
	}

	// Applies mount switch vectors: slew rate, track mode/state, pier side, park/park-option, abort, home,
	// slew-vs-sync mode, axis motion, and the alignment subsystem's active/math-plugin switches.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		const { elements } = message

		switch (message.name) {
			case 'ALIGNMENT_SUBSYSTEM_ACTIVE': {
				const { alignment } = device
				let updated = tag[0] === 'd' && handleSwitchValue(alignment, 'available', true, message.state)

				// Only a definition carries the driver's element names. The vector is AtMostOne with a single
				// member, so a renamed member is the first (and only) key.
				if (tag[0] === 'd') {
					const defined = ALIGNMENT_SUBSYSTEM_ACTIVE in elements ? ALIGNMENT_SUBSYSTEM_ACTIVE : Object.keys(elements)[0]
					if (defined !== undefined) this.#alignmentActiveElements.set(device, defined)
				}

				// The known element wins whenever it is present: an explicit Off must never be overridden by
				// the any-switch-on fallback, which only covers a driver that renamed the element.
				const element = elements[ALIGNMENT_SUBSYSTEM_ACTIVE]
				const active = element !== undefined ? element.value === true : findOnSwitch(message).length > 0

				updated = handleSwitchValue(alignment, 'active', active, message.state) || updated

				if (updated) this.updated(device, 'alignment', message.state)

				return
			}
			case 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS': {
				const { alignment } = device
				let updated = false

				if (tag[0] === 'd') {
					const plugins: NameAndLabel[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						plugins.push({ name: element.name, label: element.label ?? element.name })
					}

					alignment.plugins = plugins
					updated = true
				}

				// The vector is OneOfMany and INDI always echoes every member, so "none on" really means no
				// plugin is selected. Assigned directly because handleTextValue cannot clear a field.
				const plugin = findOnSwitch(message)[0]

				if (alignment.plugin !== plugin) {
					alignment.plugin = plugin
					updated = true
				}

				if (updated || message.state === 'Alert') this.updated(device, 'alignment', message.state)

				return
			}
			case 'TELESCOPE_SLEW_RATE':
				if (tag[0] === 'd') {
					const rates: NameAndLabel[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						rates.push({ name: element.name, label: element.label! })
					}

					if (rates.length > 0) {
						device.slewRates = rates
						this.updated(device, 'slewRates', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]

					if (element.value) {
						if (device.slewRate !== element.name) {
							device.slewRate = element.name
							this.updated(device, 'slewRate', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_MODE':
				if (tag[0] === 'd') {
					const modes: TrackMode[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						modes.push(element.name.replace('TRACK_', '') as TrackMode)
					}

					if (modes.length > 0) {
						device.trackModes = modes
						this.updated(device, 'trackModes', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]

					if (element.value) {
						const trackMode = element.name.replace('TRACK_', '') as TrackMode

						if (device.trackMode !== trackMode) {
							device.trackMode = trackMode
							this.updated(device, 'trackMode', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_STATE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canTracking', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'canTracking', message.state)
					}
				}

				if (handleSwitchValue(device, 'tracking', elements.TRACK_ON?.value)) {
					this.updated(device, 'tracking', message.state)
				}

				return
			case 'TELESCOPE_PIER_SIDE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasPierSide', true)) {
						this.updated(device, 'hasPierSide', message.state)

						if (handleSwitchValue(device, 'canSetPierSide', (message as DefSwitchVector).permission !== 'ro')) {
							this.updated(device, 'canSetPierSide', message.state)
						}
					}
				}

				if (handleTextValue(device, 'pierSide', elements.PIER_WEST?.value === true ? 'WEST' : message.elements.PIER_EAST?.value === true ? 'EAST' : 'NEITHER')) {
					this.updated(device, 'pierSide', message.state)
				}

				return
			case 'TELESCOPE_PARK':
				handleParkable(this, device, message, tag)
				return
			case 'TELESCOPE_PARK_OPTION':
				if (tag[0] === 'd' && 'PARK_CURRENT' in elements) {
					if (handleSwitchValue(device, 'canSetPark', true)) {
						this.updated(device, 'canSetPark', message.state)
					}
				}

				return
			case 'TELESCOPE_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'TELESCOPE_HOME':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canHome', 'GO' in elements)) {
						this.updated(device, 'canHome', message.state)
					}

					if (handleSwitchValue(device, 'canFindHome', 'FIND' in elements)) {
						this.updated(device, 'canFindHome', message.state)
					}

					if (handleSwitchValue(device, 'canSetHome', 'SET' in elements)) {
						this.updated(device, 'canSetHome', message.state)
					}
				}

				if (elements.GO || elements.FIND) {
					if (handleSwitchValue(device, 'homing', message.state === 'Busy')) {
						this.updated(device, 'homing', message.state)
					}
				}

				return
			case 'ON_COORD_SET':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', 'SYNC' in elements)) {
						this.updated(device, 'canSync', message.state)
					}

					if (handleSwitchValue(device, 'canGoTo', 'SLEW' in elements)) {
						this.updated(device, 'canGoTo', message.state)
					}

					if (handleSwitchValue(device, 'canFlip', 'FLIP' in elements)) {
						this.updated(device, 'canFlip', message.state)
					}
				}

				return
			case 'TELESCOPE_MOTION_NS':
			case 'TELESCOPE_MOTION_WE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canMove', true)) {
						this.updated(device, 'canMove', message.state)
					}
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy' || findOnSwitch(message)[0] !== undefined)) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Applies mount number vectors: the equatorial (JNOW) coordinate and slewing state, the site geographic
	// coordinate, and the alignment point count.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'ALIGNMENT_POINTSET_SIZE': {
				const value = message.elements.ALIGNMENT_POINTSET_SIZE?.value

				// Protocol decoding boundary: Infinity would survive the clamp and leak into the public
				// state, and a NaN sample must be ignored rather than reset a known count to zero.
				if (value !== undefined && Number.isFinite(value)) {
					if (handleNumberValue(device.alignment, 'pointCount', value, message.state, alignmentPointCount)) {
						this.updated(device, 'alignment', message.state)
					}
				}

				return
			}
			case 'EQUATORIAL_EOD_COORD': {
				if (handleSwitchValue(device, 'slewing', message.state === 'Busy')) {
					this.updated(device, 'slewing', message.state)
				}

				const { equatorialCoordinate } = device

				let updated = handleNumberValue(equatorialCoordinate, 'rightAscension', message.elements.RA?.value, undefined, hour)
				updated = handleNumberValue(equatorialCoordinate, 'declination', message.elements.DEC?.value, undefined, deg) || updated

				if (updated) {
					this.updated(device, 'equatorialCoordinate', message.state)
				}

				return
			}
			case 'GEOGRAPHIC_COORD': {
				const { geographicCoordinate } = device

				let updated = handleNumberValue(geographicCoordinate, 'longitude', message.elements.LONG?.value, undefined, (value) => normalizePI(deg(value)))
				updated = handleNumberValue(geographicCoordinate, 'latitude', message.elements.LAT?.value, undefined, deg) || updated
				updated = handleNumberValue(geographicCoordinate, 'elevation', message.elements.ELEV?.value, undefined, meter) || updated

				if (updated) {
					this.updated(device, 'geographicCoordinate', message.state)
				}
			}
		}
	}

	// Creates/updates the mount from DRIVER_INFO and applies its UTC time/offset text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.TELESCOPE)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'TIME_UTC': {
				if (message.elements.UTC?.value) {
					const utc = parseTemporal(message.elements.UTC.value, 'YYYY-MM-DDTHH:mm:ss')
					const offset = parseUTCOffset(message.elements.OFFSET.value)

					let updated = handleNumberValue(device.time, 'utc', utc)
					updated = handleNumberValue(device.time, 'offset', offset) || updated

					if (updated) {
						this.updated(device, 'time', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full) this.clearWritableProperty(device)
		else this.removeWritableProperty(device, name)

		if (full || name === 'ALIGNMENT_SUBSYSTEM_ACTIVE') this.#alignmentActiveElements.delete(device)

		if (full) {
			resetDeviceValue(this, device, 'alignment', DEFAULT_MOUNT.alignment)
		} else {
			// Partial resets cannot go through resetDeviceValue, which only replaces top-level device fields.
			const { alignment } = device
			let updated = false

			if (name === 'ALIGNMENT_SUBSYSTEM_ACTIVE') {
				updated = handleSwitchValue(alignment, 'available', false) || updated
				updated = handleSwitchValue(alignment, 'active', false) || updated
			}
			if (name === 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS') {
				if (alignment.plugins.length > 0) {
					alignment.plugins = DEFAULT_MOUNT.alignment.plugins
					updated = true
				}
				if (alignment.plugin !== undefined) {
					alignment.plugin = undefined
					updated = true
				}
			}
			if (name === 'ALIGNMENT_POINTSET_SIZE') {
				updated = handleNumberValue(alignment, 'pointCount', DEFAULT_MOUNT.alignment.pointCount) || updated
			}

			if (updated) this.updated(device, 'alignment')
		}

		if (full || name === 'TELESCOPE_SLEW_RATE') {
			resetDeviceValue(this, device, 'slewRates', DEFAULT_MOUNT.slewRates)
			resetDeviceValue(this, device, 'slewRate', undefined)
		}
		if (full || name === 'TELESCOPE_TRACK_MODE') {
			resetDeviceValue(this, device, 'trackModes', DEFAULT_MOUNT.trackModes)
			resetDeviceValue(this, device, 'trackMode', DEFAULT_MOUNT.trackMode)
		}
		if (full || name === 'TELESCOPE_TRACK_STATE') {
			resetDeviceValue(this, device, 'canTracking', DEFAULT_MOUNT.canTracking)
			resetDeviceValue(this, device, 'tracking', DEFAULT_MOUNT.tracking)
		}
		if (full || name === 'TELESCOPE_PIER_SIDE') {
			resetDeviceValue(this, device, 'hasPierSide', DEFAULT_MOUNT.hasPierSide)
			resetDeviceValue(this, device, 'canSetPierSide', DEFAULT_MOUNT.canSetPierSide)
			resetDeviceValue(this, device, 'pierSide', DEFAULT_MOUNT.pierSide)
		}
		if (full || name === 'TELESCOPE_PARK') {
			resetDeviceValue(this, device, 'canPark', DEFAULT_MOUNT.canPark)
			resetDeviceValue(this, device, 'parking', DEFAULT_MOUNT.parking)
			resetDeviceValue(this, device, 'parked', DEFAULT_MOUNT.parked)
		}
		if (full || name === 'TELESCOPE_PARK_OPTION') {
			resetDeviceValue(this, device, 'canSetPark', DEFAULT_MOUNT.canSetPark)
		}
		if (full || name === 'TELESCOPE_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_MOUNT.canAbort)
		}
		if (full || name === 'TELESCOPE_HOME') {
			resetDeviceValue(this, device, 'canHome', DEFAULT_MOUNT.canHome)
			resetDeviceValue(this, device, 'canFindHome', DEFAULT_MOUNT.canFindHome)
			resetDeviceValue(this, device, 'canSetHome', DEFAULT_MOUNT.canSetHome)
			resetDeviceValue(this, device, 'homing', DEFAULT_MOUNT.homing)
		}
		if (full || name === 'ON_COORD_SET') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_MOUNT.canSync)
			resetDeviceValue(this, device, 'canGoTo', DEFAULT_MOUNT.canGoTo)
			resetDeviceValue(this, device, 'canFlip', DEFAULT_MOUNT.canFlip)
		}
		if (full || name === 'TELESCOPE_MOTION_NS' || name === 'TELESCOPE_MOTION_WE') {
			resetDeviceValue(this, device, 'moving', DEFAULT_MOUNT.moving)
			resetDeviceValue(this, device, 'canMove', DEFAULT_MOUNT.canMove)
		}
		if (full || name === 'EQUATORIAL_EOD_COORD') {
			resetDeviceValue(this, device, 'slewing', DEFAULT_MOUNT.slewing)
			resetDeviceValue(this, device, 'equatorialCoordinate', DEFAULT_MOUNT.equatorialCoordinate)
		}
		if (full || name === 'GEOGRAPHIC_COORD') {
			resetDeviceValue(this, device, 'geographicCoordinate', DEFAULT_MOUNT.geographicCoordinate)
		}
		if (full || name === 'TIME_UTC') {
			resetDeviceValue(this, device, 'time', DEFAULT_MOUNT.time)
		}

		super.delProperty(client, message)
	}
}

// Normalizes ALIGNMENT_POINTSET_SIZE into a non-negative integer count. The property is declared as a
// float by INDI, so a driver may report a fractional or (after a failed commit) negative value.
function alignmentPointCount(value: number) {
	return value > 0 ? Math.trunc(value) : 0
}

// Parses an INDI UTC offset string ("HH" or "HH:MM") into minutes.
function parseUTCOffset(text: string) {
	const parts = text.split(':')
	const hour = +parts[0] * 60
	const minute = parts.length >= 2 ? +parts[1] : 0
	return hour + minute
}
