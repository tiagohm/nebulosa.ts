import { takiToEnuMatrix } from '../../../astronomy/coordinates/frame.local'
import { localSiderealTime } from '../../../astronomy/observer/location'
import { timeUnix } from '../../../astronomy/time/time'
import { PI, RAD2DEG } from '../../../core/constants'
import { normalizePI } from '../../../math/units/angle'
import { solveDomeSlitFromMount } from '../../../observation/dome/slit'
import { createCanonicalEquatorialGeometry } from '../../../observation/mount/kinematics'
import type { Mount, PierSide } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { DomeGeometryConfig } from './dome.config'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Geometry circuit of the simulated dome: the measurements of the dome and of the mount inside it, the
// side of the pier the tube is on, and where the slit has to be for a mount to look out through it.
// Lengths are metres and azimuths degrees north through east. The driver's backlash settings live here
// too, stored only, since the simulated dome has no play for them to take up.
//
// The mount is a German equatorial mount whose axes intersect at the displaced point, with the optical
// axis offset from that point along the declination axis, towards the west of the pier with the tube on
// the west side. The slit is where that optical ray leaves a sphere of the dome's radius centred on the
// dome, which with every offset zero is the azimuth of the target itself.

// Where the side of the tube comes from: the mount's own pier side, or a fixed side.
type DomeOTASide = 'MOUNT' | 'EAST' | 'WEST'

// The measured geometry.
export class DomeGeometry extends SimulatorComponent {
	readonly #measurements: ReturnType<typeof makeNumberVector>
	readonly #otaSide = makeSwitchVector('', 'DM_OTA_SIDE', 'OTA side', MAIN_CONTROL, 'OneOfMany', 'rw', ['DM_OTA_SIDE_EAST', 'East', false], ['DM_OTA_SIDE_WEST', 'West', false], ['DM_OTA_SIDE_MOUNT', 'Mount', true])
	readonly #backlashToggle = makeSwitchVector('', 'DOME_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #backlashSteps = makeNumberVector('', 'DOME_BACKLASH_STEPS', 'Backlash steps', MAIN_CONTROL, 'rw', ['DOME_BACKLASH_VALUE', 'Steps', 0, 0, 1000, 1, '%.0f'])

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// `config` gives the measurements at power-up.
	constructor(bus: ComponentBus, config: DomeGeometryConfig) {
		super(bus)
		// oxfmt-ignore
		this.#measurements = makeNumberVector('', 'DOME_MEASUREMENTS', 'Measurements', MAIN_CONTROL, 'rw', ['DM_DOME_RADIUS', 'Radius (m)', config.radius, 0.1, 100, 0.01, '%.2f'], ['DM_SHUTTER_WIDTH', 'Shutter width (m)', config.shutterWidth, 0, 100, 0.01, '%.2f'], ['DM_NORTH_DISPLACEMENT', 'North displacement (m)', config.northDisplacement, -100, 100, 0.01, '%.2f'], ['DM_EAST_DISPLACEMENT', 'East displacement (m)', config.eastDisplacement, -100, 100, 0.01, '%.2f'], ['DM_UP_DISPLACEMENT', 'Up displacement (m)', config.upDisplacement, -100, 100, 0.01, '%.2f'], ['DM_OTA_OFFSET', 'OTA offset (m)', config.otaOffset, -100, 100, 0.01, '%.2f'])
		this.properties = [this.#measurements, this.#otaSide, this.#backlashToggle, this.#backlashSteps]
	}

	// Where the side of the tube comes from.
	get otaSide(): DomeOTASide {
		return this.#otaSide.elements.DM_OTA_SIDE_EAST.value ? 'EAST' : this.#otaSide.elements.DM_OTA_SIDE_WEST.value ? 'WEST' : 'MOUNT'
	}

	// Azimuth, degrees, the slit has to be at for `mount` to look out through it, or undefined when its
	// optical ray never leaves the dome, which a mount outside the dome would make possible.
	slitAzimuth(mount: Mount) {
		const { DM_DOME_RADIUS, DM_NORTH_DISPLACEMENT, DM_EAST_DISPLACEMENT, DM_UP_DISPLACEMENT, DM_OTA_OFFSET } = this.#measurements.elements
		const { latitude } = mount.geographicCoordinate
		const { rightAscension, declination } = mount.equatorialCoordinate
		const lst = localSiderealTime(timeUnix(mount.time.utc / 1000), mount.geographicCoordinate)
		const hourAngle = normalizePI(lst - rightAscension)
		// The Taki frame of the mount, with +y east, put at the displaced axes intersection in the dome's ENU frame.
		const geometry = createCanonicalEquatorialGeometry({
			baseToWorld: { rotation: takiToEnuMatrix(latitude), translation: [DM_EAST_DISPLACEMENT.value, DM_NORTH_DISPLACEMENT.value, DM_UP_DISPLACEMENT.value] },
			opticalOrigin: [0, -DM_OTA_OFFSET.value, 0],
		})
		// The east side reaches the same direction through the pole, which carries the offset across the pier.
		const encoders = this.#pierSide(mount) === 'EAST' ? { primary: hourAngle + PI, secondary: PI - declination } : { primary: hourAngle, secondary: declination }
		const slit = solveDomeSlitFromMount(geometry, encoders, { center: [0, 0, 0], radius: DM_DOME_RADIUS.value })
		return slit === undefined ? undefined : slit.azimuth * RAD2DEG
	}

	// Handles DOME_MEASUREMENTS and DOME_BACKLASH_STEPS.
	handleNumber(vector: NewNumberVector) {
		const property = vector.name === this.#measurements.name ? this.#measurements : vector.name === this.#backlashSteps.name ? this.#backlashSteps : undefined
		if (property === undefined) return false
		if (applyNumberVectorValues(property, vector.elements)) this.bus.notify(property)
		return true
	}

	// Handles DM_OTA_SIDE and DOME_BACKLASH_TOGGLE.
	handleSwitch(vector: NewSwitchVector) {
		const property = vector.name === this.#otaSide.name ? this.#otaSide : vector.name === this.#backlashToggle.name ? this.#backlashToggle : undefined
		if (property === undefined) return false
		if (applyExclusiveSwitchValues(property, vector.elements)) this.bus.notify(property)
		return true
	}

	// Side of the pier the tube of `mount` is on: the fixed side, or the mount's own, west at a pole.
	#pierSide(mount: Mount): PierSide {
		const side = this.otaSide
		if (side !== 'MOUNT') return side
		return mount.pierSide === 'EAST' ? 'EAST' : 'WEST'
	}
}
