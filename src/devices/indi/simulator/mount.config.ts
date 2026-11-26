import type { DeepPartial } from '../../../core/types'
import type { TrackMode } from '../device'
import { mergeConfig } from './component'
import { GUIDE_JITTER_SEED } from './constants'
import { TRACKING_RATE_CALIBRATION_TEMPERATURE } from './mount.tracking'

// Configuration of the simulated mount, one section per circuit. Every section holds the initial values
// of the properties its circuit publishes. A simulator is built from DEFAULT_MOUNT_SIMULATOR_CONFIG
// merged with the partial override its options carry; the defaults are never mutated.

// Observing site.
export interface MountSiteConfig {
	// Geodetic latitude, degrees, positive north, within [-90, 90].
	readonly latitude: number
	// Longitude, degrees east, any value; published within [0, 360).
	readonly longitude: number
	// Elevation above the ellipsoid, metres.
	readonly elevation: number
}

// Drive settings a client changes.
export interface MountDriveConfig {
	// Initial slew-rate preset, one of the SLEW_RATES names.
	readonly slewRate: string
	// Initial tracking mode.
	readonly trackMode: TrackMode
	// Guide rates as fractions of the sidereal rate, within [0, MAX_GUIDE_RATE].
	readonly guideRateRightAscension: number
	readonly guideRateDeclination: number
}

// Meridian policy of the controller.
export interface MountMeridianConfig {
	// Whether the controller flips by itself.
	readonly automaticFlip: boolean
	// Hour angle past the upper meridian at which the automatic flip starts, degrees, within [-90, 90].
	readonly flipHourAngle: number
	// Hour angle past the upper meridian the tube may reach on its current side, degrees within
	// [0, 90]: a goto stays on that side up to it and tracking stops beyond it.
	readonly limit: number
}

// Error families simulated from the start.
export interface MountErrorFeaturesConfig {
	readonly alignment: boolean
	readonly periodicError: boolean
	readonly mechanics: boolean
	readonly guiding: boolean
	readonly settling: boolean
	readonly flexure: boolean
	readonly wind: boolean
	readonly trackingRate: boolean
}

// Geometric imperfections, arcseconds. The polar errors follow the visible pole of the site: a positive
// altitude error puts the axis above it and a positive azimuth error east of it, in either hemisphere.
export interface MountAlignmentConfig {
	readonly polarAzimuthError: number
	readonly polarAltitudeError: number
	readonly coneError: number
	readonly axisNonOrthogonality: number
	readonly rightAscensionIndexError: number
	readonly declinationIndexError: number
}

// Periodic error of the right-ascension worm and its trained correction.
export interface MountPeriodicErrorConfig {
	// Worm period at the sidereal rate, seconds; zero disables the term.
	readonly period: number
	// Semi-amplitudes, arcseconds, and phases, degrees, of the first three harmonics.
	readonly amplitude: number
	readonly phase: number
	readonly amplitude2: number
	readonly phase2: number
	readonly amplitude3: number
	readonly phase3: number
	// Length of the recorded correction table and how much of the error it captured, within [0, 1].
	readonly pecSamples: number
	readonly pecGain: number
}

// Transmission between motor and axis, arcseconds, and home sensor repeatability.
export interface MountMechanicsConfig {
	readonly backlashRightAscension: number
	readonly backlashDeclination: number
	// Fraction of the commanded rate that takes up backlash, within (0, 1].
	readonly takeUpRate: number
	readonly stictionRightAscension: number
	readonly stictionDeclination: number
	readonly homeScatter: number
}

// Fidelity of the guide-pulse path: latency and jitter, minimum pulse and quantization in
// milliseconds, and per-direction gains relative to the guide rate.
export interface MountGuidingConfig {
	readonly latency: number
	readonly latencyJitter: number
	readonly minimumPulse: number
	readonly quantization: number
	readonly gainNorth: number
	readonly gainSouth: number
	readonly gainEast: number
	readonly gainWest: number
}

// Elastic response after an abrupt stop: overshoot at full slew speed in arcseconds, natural
// frequency in hertz and damping ratio.
export interface MountSettlingConfig {
	readonly overshoot: number
	readonly frequency: number
	readonly dampingRatio: number
}

// Gravity: droop of the tube at the horizon and the offset of the west side of the pier, arcseconds.
export interface MountFlexureConfig {
	readonly tubeFlexure: number
	readonly pierWestRightAscension: number
	readonly pierWestDeclination: number
}

// Wind buffeting: amplitude in arcseconds and correlation time in seconds.
export interface MountWindConfig {
	readonly amplitude: number
	readonly correlationTime: number
}

// Tracking-rate error: bias in ppm, temperature coefficient in ppm/°C, drive temperature in °C and
// random walk in ppm/√s.
export interface MountTrackingRateConfig {
	readonly bias: number
	readonly temperatureCoefficient: number
	readonly temperature: number
	readonly randomWalk: number
}

// Full configuration of a simulated mount.
export interface MountSimulatorConfig {
	// Seed of the random sources: each circuit draws from its own generator derived from it.
	readonly seed: number
	readonly site: MountSiteConfig
	readonly drive: MountDriveConfig
	readonly meridian: MountMeridianConfig
	readonly errors: MountErrorFeaturesConfig
	readonly alignment: MountAlignmentConfig
	readonly periodicError: MountPeriodicErrorConfig
	readonly mechanics: MountMechanicsConfig
	readonly guiding: MountGuidingConfig
	readonly settling: MountSettlingConfig
	readonly flexure: MountFlexureConfig
	readonly wind: MountWindConfig
	readonly trackingRate: MountTrackingRateConfig
}

// Partial override of a mount configuration, merged section by section into the defaults.
export type MountSimulatorConfigOverride = DeepPartial<MountSimulatorConfig>

// Defaults of every simulated mount: a perfect mount at latitude and longitude zero whose error
// families, when switched on, behave like a typical amateur German equatorial mount.
export const DEFAULT_MOUNT_SIMULATOR_CONFIG: MountSimulatorConfig = {
	seed: GUIDE_JITTER_SEED,
	site: { latitude: 0, longitude: 0, elevation: 0 },
	drive: { slewRate: 'SPEED_2', trackMode: 'SIDEREAL', guideRateRightAscension: 0.5, guideRateDeclination: 0.5 },
	meridian: { automaticFlip: false, flipHourAngle: 0, limit: 0 },
	errors: { alignment: false, periodicError: false, mechanics: false, guiding: false, settling: false, flexure: false, wind: false, trackingRate: false },
	alignment: { polarAzimuthError: 120, polarAltitudeError: 120, coneError: 60, axisNonOrthogonality: 30, rightAscensionIndexError: 120, declinationIndexError: 120 },
	periodicError: { period: 480, amplitude: 7.5, phase: 0, amplitude2: 2.5, phase2: 60, amplitude3: 1, phase3: 210, pecSamples: 0, pecGain: 1 },
	mechanics: { backlashRightAscension: 30, backlashDeclination: 60, takeUpRate: 0.7, stictionRightAscension: 1, stictionDeclination: 2, homeScatter: 20 },
	guiding: { latency: 250, latencyJitter: 50, minimumPulse: 20, quantization: 10, gainNorth: 0.95, gainSouth: 1.05, gainEast: 1, gainWest: 1 },
	settling: { overshoot: 3, frequency: 2, dampingRatio: 0.2 },
	flexure: { tubeFlexure: 30, pierWestRightAscension: 20, pierWestDeclination: 20 },
	wind: { amplitude: 1.5, correlationTime: 3 },
	trackingRate: { bias: 50, temperatureCoefficient: 2, temperature: TRACKING_RATE_CALIBRATION_TEMPERATURE, randomWalk: 0.5 },
}

// Builds the configuration of a mount from the defaults and an optional override.
export function mountSimulatorConfig(override?: MountSimulatorConfigOverride, base: MountSimulatorConfig = DEFAULT_MOUNT_SIMULATOR_CONFIG): MountSimulatorConfig {
	return mergeConfig(base, override)
}

// Seed of the generator of one circuit, derived from the mount seed so circuits draw independently.
export function circuitSeed(seed: number, circuit: number) {
	return (seed ^ Math.imul(circuit + 1, 0x9e3779b1)) >>> 0
}
