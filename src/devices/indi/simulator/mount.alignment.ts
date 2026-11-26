import { type EquatorialPointingModel, IDENTITY_EQUATORIAL_POINTING_MODEL, polarAxisRotation } from '../../../astronomy/coordinates/pointing'
import { ASEC2RAD } from '../../../core/constants'
import { type Mat3, matIdentity, type MutMat3 } from '../../../math/linear-algebra/mat3'
import type { Angle } from '../../../math/units/angle'
import type { NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountAlignmentConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Alignment circuit of the simulated mount: the six basic TPoint terms. The polar-axis misalignment,
// cone and non-perpendicularity are optical geometry, moving the boresight away from where the axes
// point; the index errors are encoder zero offsets, changing only what the controller reports. All
// configured values are arcseconds; everything returned is radians.
//
// The polar knobs follow the visible pole of the site, as an operator adjusting the mount sees it: a
// positive altitude error puts the axis above that pole and a positive azimuth error east of it, in
// either hemisphere. polarAxisRotation counts both at the north end of the axis, so in the south they
// enter with their signs reversed.

// Terms of MOUNT_ALIGNMENT, arcseconds. The polar range spans ten degrees, far beyond any usable
// alignment, so gross misalignment can be exercised.
const ALIGNMENT: readonly NumberBinding<keyof MountAlignmentConfig>[] = [
	['POLAR_AZIMUTH_ERROR', 'Polar Azimuth Error (arcsec)', 'polarAzimuthError', -36000, 36000, 0.1, '%.3f'],
	['POLAR_ALTITUDE_ERROR', 'Polar Altitude Error (arcsec)', 'polarAltitudeError', -36000, 36000, 0.1, '%.3f'],
	['CONE_ERROR', 'Cone Error (arcsec)', 'coneError', -3600, 3600, 0.1, '%.3f'],
	['AXIS_NON_ORTHOGONALITY', 'Axis Non-orthogonality (arcsec)', 'axisNonOrthogonality', -3600, 3600, 0.1, '%.3f'],
	['RA_INDEX_ERROR', 'RA Index Error (arcsec)', 'rightAscensionIndexError', -3600, 3600, 0.1, '%.3f'],
	['DEC_INDEX_ERROR', 'DEC Index Error (arcsec)', 'declinationIndexError', -3600, 3600, 0.1, '%.3f'],
]

// Geometric imperfections of the mount.
export class MountAlignment extends SimulatorComponent {
	readonly #alignment: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// Whether the alignment family is simulated; set by the device from SIMULATOR_ERROR_FEATURES.
	enabled = false

	// Polar rotation and the knobs, arcseconds, and latitude, radians, it was built for. NaN marks it
	// as never built.
	readonly #rotation: { azimuth: number; altitude: number; latitude: Angle; readonly matrix: MutMat3 } = { azimuth: Number.NaN, altitude: Number.NaN, latitude: Number.NaN, matrix: matIdentity() }

	// `config` gives the initial terms; `changed` runs after a command changed them.
	constructor(
		bus: ComponentBus,
		config: MountAlignmentConfig,
		readonly changed: () => void,
	) {
		super(bus)
		this.#alignment = makeBoundNumberVector('MOUNT_ALIGNMENT', 'Alignment', SIMULATION, ALIGNMENT, config)
		this.properties = [this.#alignment]
	}

	// First-order model of the cone error and the non-perpendicularity of the axes, the identity model
	// when neither applies so callers can skip it by reference. The polar misalignment is applied
	// exactly by `polarRotation` instead, because its first-order terms are singular at the pole.
	get pointingModel(): EquatorialPointingModel {
		if (!this.enabled) return IDENTITY_EQUATORIAL_POINTING_MODEL
		const { CONE_ERROR, AXIS_NON_ORTHOGONALITY } = this.#alignment.elements
		if (CONE_ERROR.value === 0 && AXIS_NON_ORTHOGONALITY.value === 0) return IDENTITY_EQUATORIAL_POINTING_MODEL
		return { ...IDENTITY_EQUATORIAL_POINTING_MODEL, coneError: CONE_ERROR.value * ASEC2RAD, axisNonPerpendicularity: AXIS_NON_ORTHOGONALITY.value * ASEC2RAD }
	}

	// Rotation of the mount's frame by the polar misalignment at `latitude`, radians, or undefined when
	// the axis is aligned or the family is off. Cached for its knobs and latitude, since the boresight
	// is evaluated on every tick.
	polarRotation(latitude: Angle): Mat3 | undefined {
		if (!this.enabled) return undefined

		const { POLAR_AZIMUTH_ERROR, POLAR_ALTITUDE_ERROR } = this.#alignment.elements
		if (POLAR_AZIMUTH_ERROR.value === 0 && POLAR_ALTITUDE_ERROR.value === 0) return undefined

		const cache = this.#rotation

		if (cache.azimuth !== POLAR_AZIMUTH_ERROR.value || cache.altitude !== POLAR_ALTITUDE_ERROR.value || cache.latitude !== latitude) {
			// The knobs act on the visible pole; the rotation counts at the north end of the axis.
			const hemisphere = latitude < 0 ? -1 : 1
			polarAxisRotation(hemisphere * POLAR_AZIMUTH_ERROR.value * ASEC2RAD, hemisphere * POLAR_ALTITUDE_ERROR.value * ASEC2RAD, latitude, cache.matrix)
			cache.azimuth = POLAR_AZIMUTH_ERROR.value
			cache.altitude = POLAR_ALTITUDE_ERROR.value
			cache.latitude = latitude
		}

		return cache.matrix
	}

	// Encoder zero offsets added to the mechanical orientation to obtain what the controller reports,
	// radians; zero while the family is off.
	get rightAscensionIndexError(): Angle {
		return this.enabled ? this.#alignment.elements.RA_INDEX_ERROR.value * ASEC2RAD : 0
	}

	get declinationIndexError(): Angle {
		return this.enabled ? this.#alignment.elements.DEC_INDEX_ERROR.value * ASEC2RAD : 0
	}

	// Handles MOUNT_ALIGNMENT.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#alignment.name) return false

		if (applyNumberVectorValues(this.#alignment, vector.elements)) {
			this.changed()
			this.bus.notify(this.#alignment)
		}

		return true
	}
}
