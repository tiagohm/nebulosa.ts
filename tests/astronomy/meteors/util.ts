import type { MeteorActivityProfile, MeteorExponentialActivityProfile, MeteorSolarLongitudeInterval, MeteorShowerSolution, MeteorVisualObservation } from '../../../src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'
import { kilometer, meter } from '../../../src/math/units/distance'
import { kilometerPerSecond } from '../../../src/math/units/velocity'

// Shared deterministic epochs, observer, normalized solutions, activity profiles and external-reference tolerances for meteor tests.

export const REFERENCE_UTC = timeYMDHMS(2024, 1, 4, 0, 0, 0, Timescale.UTC)
export const REFERENCE_TDB = timeYMDHMS(2024, 1, 4, 0, 0, 0, Timescale.TDB)
export const OBSERVER = geodeticLocation(deg(-46.633), deg(-23.55), meter(760), Ellipsoid.WGS84)

export const TEST_INTERVAL = { start: deg(90), end: deg(110) } satisfies MeteorSolarLongitudeInterval
export const WRAPPED_INTERVAL = { start: deg(350), end: deg(20) } satisfies MeteorSolarLongitudeInterval

export const BASE_SOLUTION = {
	activity: { kind: 'annual', source: 'annual' },
	activityInterval: TEST_INTERVAL,
	referenceSolarLongitude: deg(100),
	rightAscension: deg(180),
	declination: deg(-20),
	geocentricSpeed: kilometerPerSecond(20),
} satisfies MeteorShowerSolution

export const SOLAR_DRIFT_SOLUTION = {
	...BASE_SOLUTION,
	rightAscension: deg(359),
	declination: deg(10),
	radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 2, declinationRate: 1 },
} satisfies MeteorShowerSolution

export const DAILY_DRIFT_SOLUTION = {
	...BASE_SOLUTION,
	referenceSolarLongitude: deg(282.76828982389947),
	rightAscension: deg(359),
	declination: deg(10),
	radiantDrift: { basis: 'day', rightAscensionRate: deg(1), declinationRate: deg(-0.25) },
} satisfies MeteorShowerSolution

export const MISSING_RADIANT_SOLUTION = {
	...BASE_SOLUTION,
	rightAscension: undefined,
	declination: undefined,
} satisfies MeteorShowerSolution

export const YEAR_SPECIFIC_SOLUTION = {
	...BASE_SOLUTION,
	activity: { kind: 'yearSpecific', source: '2024', year: 2024 },
} satisfies MeteorShowerSolution

export const EXPONENTIAL_PROFILE = {
	type: 'exponential',
	support: TEST_INTERVAL,
	solarLongitude: deg(100),
	zhr: 120,
	slopeBefore: 0.1,
	slopeAfter: 0.2,
} satisfies MeteorActivityProfile

export const WRAPPED_EXPONENTIAL_PROFILE = {
	type: 'exponential',
	support: WRAPPED_INTERVAL,
	solarLongitude: 0,
	zhr: 100,
	slopeBefore: 1,
	slopeAfter: 2,
} satisfies MeteorActivityProfile

export const SAMPLED_PROFILE = {
	type: 'sampled',
	support: WRAPPED_INTERVAL,
	samples: [
		{ solarLongitude: deg(350), zhr: 10 },
		{ solarLongitude: 0, zhr: 20 },
		{ solarLongitude: deg(10), zhr: 10 },
	],
} satisfies MeteorActivityProfile

const MULTI_PEAK_COMPONENTS = [
	{ type: 'exponential', support: { start: deg(0), end: deg(20) }, solarLongitude: deg(10), zhr: 100, slopeBefore: 0.1, slopeAfter: 0.1 },
	{ type: 'exponential', support: { start: deg(180), end: deg(200) }, solarLongitude: deg(190), zhr: 100, slopeBefore: 0.1, slopeAfter: 0.1 },
] satisfies readonly MeteorExponentialActivityProfile[]

export const MULTI_PEAK_PROFILE = { type: 'multiPeak', components: MULTI_PEAK_COMPONENTS } satisfies MeteorActivityProfile

export const PLANNER_MULTI_PROFILE = {
	type: 'sampled',
	support: { start: deg(97.7), end: deg(97.9) },
	samples: [
		{ solarLongitude: deg(97.7), zhr: 10 },
		{ solarLongitude: deg(97.74), zhr: 10 },
		{ solarLongitude: deg(97.75), zhr: 0 },
		{ solarLongitude: deg(97.79), zhr: 0 },
		{ solarLongitude: deg(97.8), zhr: 100 },
		{ solarLongitude: deg(97.9), zhr: 100 },
	],
} satisfies MeteorActivityProfile

export const VISUAL_OBSERVATION = {
	count: 10,
	effectiveTime: 2,
	limitingMagnitude: 5.5,
	populationIndex: 2,
	obstructionCorrection: 1.2,
	radiantAltitude: deg(30),
} satisfies MeteorVisualObservation

// Horizons DE441 Earth/Sun state at 2024-01-04 00:00 TDB, AU and AU/day, in ecliptic J2000.
export const HORIZONS_EARTH_STATE = {
	position: [-0.2173060082909991, 0.958997219502, -0.00005246747953194278],
	velocity: [-0.017060344787803, -0.003860577837095653, 0.0000009119949265348414],
} as const

// Astropy 8.0.1 geometric FK5/AltAz reference at the shared epoch and observer, pressure=0 hPa.
export const ASTROPY_RADIANT_OF_DATE = { rightAscension: deg(100.28656627834519), declination: deg(-20.025980568151283) } as const
export const ASTROPY_HORIZONTAL = { azimuth: deg(252.92105880185406), altitude: deg(11.319247361493826) } as const

export const TOLERANCE = {
	externalAngle: deg(0.01),
	externalState: 5e-7,
	time: 1e-8,
} as const

export const ZERO_WIDTH_INTERVAL = { start: deg(25), end: deg(25) } satisfies MeteorSolarLongitudeInterval
export const ENTRY_ALTITUDE = kilometer(100)
export const METEOR_SPEED = kilometerPerSecond(20)
export const SITE_EPOCH = timeYMDHMS(2026, 6, 29, 21, 0, 0, Timescale.UTC)
export const SITE_EPOCH_END = timeYMDHMS(2026, 6, 29, 23, 0, 0, Timescale.UTC)
export const PLANNER_START = timeYMDHMS(2026, 6, 29, 20, 30, 0, Timescale.UTC)
export const PLANNER_END = timeYMDHMS(2026, 6, 29, 22, 30, 0, Timescale.UTC)
