import { localSiderealTime } from '../../../astronomy/observer/location'
import { timeUnix } from '../../../astronomy/time/time'
import { pmod } from '../../../math/numerical/math'
import { type Angle, deg } from '../../../math/units/angle'
import { meter } from '../../../math/units/distance'
import type { NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { MountSiteConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Site circuit of the simulated mount: where on Earth it stands, and the sidereal time there. Published
// in degrees and metres, the INDI way, with the longitude east in [0, 360); returned in radians and
// metres.

// Elements of GEOGRAPHIC_COORD. The longitude accepts west-negative values and publishes them
// normalized, so a site given as -45° is not clamped to 0°.
const SITE: readonly NumberBinding<keyof MountSiteConfig>[] = [
	['LAT', 'Latitude (deg)', 'latitude', -90, 90, 0.1, '%12.8f'],
	['LONG', 'Longitude (deg)', 'longitude', -360, 360, 0.1, '%12.8f'],
	['ELEV', 'Elevation (m)', 'elevation', -200, 10000, 1, '%.1f'],
]

// What a change of site is wired to on its mount.
export interface MountSiteWiring {
	// Runs before a command changes the site.
	readonly changing: () => void
	// Runs after a command changed the site, before it is published.
	readonly changed: () => void
}

// Observing site.
export class MountSite extends SimulatorComponent {
	readonly #site: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// `config` gives the initial site.
	constructor(
		bus: ComponentBus,
		config: MountSiteConfig,
		readonly wiring: MountSiteWiring,
	) {
		super(bus)
		this.#site = makeBoundNumberVector('GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, SITE, config)
		this.#normalizeLongitude()
		this.properties = [this.#site]
	}

	// Geodetic latitude, radians, positive north.
	get latitude(): Angle {
		return deg(this.#site.elements.LAT.value)
	}

	// Longitude, radians east.
	get longitude(): Angle {
		return deg(this.#site.elements.LONG.value)
	}

	// Elevation, metres.
	get elevation() {
		return meter(this.#site.elements.ELEV.value)
	}

	// Sign of the hemisphere: 1 north, the equator included, and -1 south.
	get hemisphere() {
		return this.#site.elements.LAT.value < 0 ? -1 : 1
	}

	// Local sidereal time at `utcTime`, milliseconds since the epoch, radians.
	siderealTimeAt(utcTime: number): Angle {
		return localSiderealTime(timeUnix(utcTime / 1000, true), this.longitude)
	}

	// Handles GEOGRAPHIC_COORD.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#site.name) return false

		this.wiring.changing()

		if (applyNumberVectorValues(this.#site, vector.elements)) {
			this.#normalizeLongitude()
			this.wiring.changed()
			this.bus.notify(this.#site)
		}

		return true
	}

	// Normalizes a persisted longitude, which the load writes without going through a command.
	loaded() {
		this.#normalizeLongitude()
	}

	// Brings the longitude into [0, 360).
	#normalizeLongitude() {
		this.#site.elements.LONG.value = pmod(this.#site.elements.LONG.value, 360)
	}
}
