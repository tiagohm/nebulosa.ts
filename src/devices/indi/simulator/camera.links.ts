import { type Time, timeNow, timeUnix } from '../../../astronomy/time/time'
import type { Angle } from '../../../math/units/angle'
import type { PierSide } from '../device'
import type { FocuserManager } from '../manager/focuser'
import type { MountManager } from '../manager/mount'
import type { RotatorManager } from '../manager/rotator'
import type { WheelManager } from '../manager/wheel'
import type { ClientSimulator } from './client'
import { FocuserSimulator } from './focuser'
import { MountSimulator } from './mount'

// Device links of the simulated camera: the mount, focuser, rotator and filter wheel it snoops, and
// what it reads from them when an exposure opens and closes. A simulated device is reached through its
// simulator, which knows more than its INDI properties carry; a real one only through what it reports.
// Angles are radians unless stated, instants milliseconds.

// A mount that can say where its optical axis pointed, which is what an exposure integrates over.
export interface BoresightSource {
	// Present instant of the mount's clock, milliseconds.
	readonly utcTime: number
	// Position angle of the tube's up direction at the boresight, radians east of north in the
	// equatorial frame of date.
	readonly tubeOrientation: Angle
	// Writes `count` boresight right ascension and declination pairs, evenly spaced over
	// `[startTime, endTime]` milliseconds, into `out` and returns how many were written.
	readonly sampleBoresightTrajectory: (startTime: number, endTime: number, count: number, out: Float64Array) => number
}

// What the frame header says about the mount an exposure was taken through, copied when the shutter
// opened so that a mount swapped, disconnected or moved while it is open cannot relabel the frame.
export interface ExposureMountMetadata {
	// Device name of the mount.
	readonly name: string
	// Site latitude, positive north, and longitude, positive east.
	readonly latitude: Angle
	readonly longitude: Angle
	// Side of the pier, 'NEITHER' when the mount does not report one.
	readonly pierSide: PierSide
}

// Where an exposure looked, fixed when the shutter opened.
export interface ExposurePointing {
	// Instant the exposure began, milliseconds on the mount's simulated clock, or on the camera's
	// clock without a simulated mount.
	readonly startTime: number
	// Coordinate the mount reported, equatorial frame of date, or undefined without a mount.
	readonly center?: readonly [Angle, Angle]
	// Epoch of that coordinate, used for every conversion into J2000.
	readonly time: Time
	// Simulated mount whose recorded boresight the exposure integrates, if any.
	readonly source?: BoresightSource
	// Position angle of the tube's up direction, radians east of north in the frame of date; zero,
	// north up, without a simulated mount.
	readonly orientation: Angle
	// Header metadata of the mount, if any.
	readonly mount?: ExposureMountMetadata
}

// What the accessories read when the shutter closed.
export interface ExposureAccessories {
	// Optical focus position, steps: the effective position of a simulated focuser, backlash
	// included, or the reported one of a real focuser.
	readonly focusPosition?: number
	// Reported focuser position and range, steps.
	readonly focuserPosition?: number
	readonly maxFocuserPosition?: number
	// Focuser thermometer reading, °C.
	readonly focuserTemperature?: number
	// Rotator angle, degrees.
	readonly rotatorAngle?: number
	// Name of the selected filter.
	readonly filter?: string
}

// Names of the snooped devices, as ACTIVE_DEVICES holds them.
export interface CameraSnoopedDevices {
	readonly telescope: string
	readonly focuser: string
	readonly wheel: string
	readonly rotator: string
}

// Managers the camera finds its snooped devices through.
export interface CameraLinkManagers {
	readonly mountManager?: MountManager
	readonly focuserManager?: FocuserManager
	readonly rotatorManager?: RotatorManager
	readonly wheelManager?: WheelManager
}

// Resolves the snooped devices of a camera and reads them for an exposure.
export class CameraLinks {
	// `client` holds the simulators, `snooped` reads the current device names and `managers` resolves
	// them; `now` is the camera's clock, milliseconds.
	constructor(
		readonly client: ClientSimulator,
		readonly snooped: () => CameraSnoopedDevices,
		readonly managers: CameraLinkManagers,
		readonly now: () => number,
	) {}

	// Snooped mount, when connected.
	get mount() {
		const mount = this.managers.mountManager?.get(this.client, this.snooped().telescope)
		return mount?.connected ? mount : undefined
	}

	// Simulator behind the snooped mount, when it is one. The snooped properties carry only the
	// reported coordinate; the boresight, the orientation and the simulated clock live on the simulator.
	get mountSimulator() {
		const mount = this.mount
		if (mount === undefined) return undefined
		const simulator = this.client.get(mount.name)
		return simulator instanceof MountSimulator ? simulator : undefined
	}

	// Snooped focuser, when connected.
	get focuser() {
		const focuser = this.managers.focuserManager?.get(this.client, this.snooped().focuser)
		return focuser?.connected ? focuser : undefined
	}

	// Snooped rotator, when connected.
	get rotator() {
		const rotator = this.managers.rotatorManager?.get(this.client, this.snooped().rotator)
		return rotator?.connected ? rotator : undefined
	}

	// Snooped filter wheel, when connected.
	get wheel() {
		const wheel = this.managers.wheelManager?.get(this.client, this.snooped().wheel)
		return wheel?.connected ? wheel : undefined
	}

	// Reads where the mount points as the shutter opens.
	//
	// Taken from the simulator when there is one rather than from the snooped properties, which are
	// refreshed on the notification cadence and lag it. The epoch is the mount's own clock, since a
	// simulator set to another date reports coordinates of that date.
	pointing(): ExposurePointing {
		const mount = this.mount
		const now = this.now()

		if (mount === undefined) return { startTime: now, time: timeUnix(now / 1000, true), orientation: 0 }

		const metadata = mountMetadata(mount.name, mount.geographicCoordinate, mount.pierSide)
		const simulator = this.client.get(mount.name)

		if (simulator instanceof MountSimulator) {
			const startTime = simulator.utcTime
			return { startTime, center: [simulator.rightAscension, simulator.declination], time: timeUnix(startTime / 1000, true), source: simulator, orientation: simulator.tubeOrientation, mount: metadata }
		}

		const { rightAscension, declination } = mount.equatorialCoordinate
		return { startTime: now, center: [rightAscension, declination], time: timeNow(true), orientation: 0, mount: metadata }
	}

	// Reads the accessories as the shutter closes.
	accessories(): ExposureAccessories {
		const focuser = this.focuser
		const rotator = this.rotator
		const wheel = this.wheel
		const focuserSimulator = focuser !== undefined ? this.client.get(focuser.name) : undefined

		return {
			focusPosition: focuserSimulator instanceof FocuserSimulator ? focuserSimulator.effectivePosition : focuser?.position.value,
			focuserPosition: focuser?.position.value,
			maxFocuserPosition: focuser?.position.max || undefined,
			focuserTemperature: focuser?.hasThermometer ? focuser.temperature : undefined,
			rotatorAngle: rotator?.angle.value,
			filter: wheel !== undefined ? wheel.names[wheel.position] : undefined,
		}
	}
}

// Copies the header metadata of a mount out of its device.
function mountMetadata(name: string, site: { readonly latitude: Angle; readonly longitude: Angle }, pierSide: PierSide): ExposureMountMetadata {
	return { name, latitude: site.latitude, longitude: site.longitude, pierSide }
}
