import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated dome, one section per circuit. A simulator is built from
// DEFAULT_DOME_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults are
// never mutated. Azimuths are degrees north through east in [0, 360) and lengths metres, the INDI way.

// Azimuth drive.
export interface DomeDriveConfig {
	// Rotation speed at power-up, RPM, within [minimumSpeed, maximumSpeed].
	readonly speed: number
	// Slowest and fastest speeds the controller accepts, RPM, positive.
	readonly minimumSpeed: number
	readonly maximumSpeed: number
	// Azimuth at power-up, degrees.
	readonly azimuth: number
}

// Home and park positions and the slaving threshold, the parameters of DOME_PARAMS.
export interface DomeParkingConfig {
	// Azimuth of the home sensor, degrees.
	readonly homeAzimuth: number
	// Azimuth the dome parks at, degrees.
	readonly parkAzimuth: number
	// Azimuth difference, degrees, within which slaving leaves the slit where it is, non-negative.
	readonly autoSyncThreshold: number
}

// Shutter.
export interface DomeShutterConfig {
	// Time the shutter takes to open or close, milliseconds, positive.
	readonly moveTime: number
}

// Geometry of the dome and of the mount inside it, the measurements of DOME_MEASUREMENTS.
export interface DomeGeometryConfig {
	// Radius of the dome, metres, positive.
	readonly radius: number
	// Width of the shutter opening, metres, non-negative.
	readonly shutterWidth: number
	// Position of the mount's axes intersection relative to the dome centre, metres: towards north,
	// east and up.
	readonly northDisplacement: number
	readonly eastDisplacement: number
	readonly upDisplacement: number
	// Distance from the axes intersection to the optical axis along the declination axis, metres.
	readonly otaOffset: number
}

// Full configuration of a simulated dome.
export interface DomeSimulatorConfig {
	readonly drive: DomeDriveConfig
	readonly parking: DomeParkingConfig
	readonly shutter: DomeShutterConfig
	readonly geometry: DomeGeometryConfig
}

// Partial override of a dome configuration, merged section by section into the defaults.
export type DomeSimulatorConfigOverride = DeepPartial<DomeSimulatorConfig>

// Defaults of every simulated dome: a 3 m dome turning at 6 RPM, homing at north and parking at south,
// with the mount at its centre.
export const DEFAULT_DOME_SIMULATOR_CONFIG: DomeSimulatorConfig = {
	drive: { speed: 6, minimumSpeed: 0.1, maximumSpeed: 12, azimuth: 0 },
	parking: { homeAzimuth: 0, parkAzimuth: 180, autoSyncThreshold: 1 },
	shutter: { moveTime: 1500 },
	geometry: { radius: 3, shutterWidth: 1, northDisplacement: 0, eastDisplacement: 0, upDisplacement: 0, otaOffset: 0 },
}

// Builds the configuration of a dome from the defaults and an optional override.
export function domeSimulatorConfig(override?: DomeSimulatorConfigOverride, base: DomeSimulatorConfig = DEFAULT_DOME_SIMULATOR_CONFIG): DomeSimulatorConfig {
	return mergeConfig(base, override)
}
