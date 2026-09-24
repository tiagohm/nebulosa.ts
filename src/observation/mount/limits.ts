import { TAU } from '../../core/constants'
import { type Angle, normalizeAngle } from '../../math/units/angle'

// Pure checks of an hour angle, declination, altitude, and azimuth against configured mount limits.
// Nothing here commands a mount. Hour angle, declination, and altitude are linear: a cable-wrap limit
// may extend past ±π, and the supplied hour angle is then the unwrapped angle the mount is holding.
// Azimuth is circular by default, so a window that crosses north is expressed by a minimum greater
// than the maximum after normalization. Set azimuthWrap to `linear` for an unwrapped azimuth cable.

// Closed numeric range. The first entry is the minimum and the second is the maximum, in radians.
export type AxisRange = readonly [min: number, max: number]

// Axes to test. Omitted axes are not limits and are not violations.
export interface MountLimitPosition {
	// Unwrapped hour angle in radians when the limit is a cable wrap. Positive west is the usual sign.
	readonly hourAngle?: Angle
	// Declination in radians.
	readonly declination?: Angle
	// Geometric altitude in radians.
	readonly altitude?: Angle
	// Azimuth in radians, north through east.
	readonly azimuth?: Angle
}

// Limits applied to the axes that are present. An omitted limit is not tested.
export interface MountLimits {
	// Linear hour-angle cable wrap, in radians.
	readonly hourAngle?: AxisRange
	// Linear declination range, in radians.
	readonly declination?: AxisRange
	// Linear altitude range, in radians.
	readonly altitude?: AxisRange
	// Azimuth range, in radians. Circular unless azimuthWrap is `linear`.
	readonly azimuth?: AxisRange
	// `circular` wraps a window whose minimum sits above its maximum across north. `linear` compares
	// the raw azimuth, for an unwrapped cable. Defaults to circular.
	readonly azimuthWrap?: 'circular' | 'linear'
}

// One axis that fell outside its range.
export interface MountLimitViolation {
	// Axis that failed.
	readonly axis: 'hourAngle' | 'declination' | 'altitude' | 'azimuth'
	// Supplied axis value, in radians.
	readonly value: number
	// Configured minimum, in radians.
	readonly minimum: number
	// Configured maximum, in radians.
	readonly maximum: number
}

// Result of one limit check.
export interface MountLimitResult {
	// True when every supplied axis that has a limit lies inside that limit.
	readonly accepted: boolean
	// Every failing axis, in hour-angle, declination, altitude, azimuth order.
	readonly violations: readonly MountLimitViolation[]
}

// Linear closed interval. NaN fails the comparison and is therefore outside.
function insideLinear(value: number, range: AxisRange) {
	return value >= range[0] && value <= range[1]
}

// Circular closed interval on [0, 2π). A minimum above the maximum crosses zero.
function insideCircular(value: number, range: AxisRange) {
	if (Math.abs(range[1] - range[0]) >= TAU) return true
	const probe = normalizeAngle(value)
	const minimum = normalizeAngle(range[0])
	const maximum = normalizeAngle(range[1])
	if (minimum <= maximum) return probe >= minimum && probe <= maximum
	return probe >= minimum || probe <= maximum
}

const MOUNT_LINEAR_AXES = ['hourAngle', 'declination', 'altitude'] as const

// Checks a mount position against hour-angle, declination, altitude, and azimuth limits.
// Parameters: position supplies the axes that are known. limits supplies the ranges. An axis with no
// limit, and a limit whose axis was not supplied, are skipped. Returns whether every tested axis is
// inside its range, and the list of violations. With no overlapping axis and limit, the position is
// accepted.
export function evaluateMountLimits(position: MountLimitPosition, limits: MountLimits): MountLimitResult {
	const violations: MountLimitViolation[] = []

	for (let i = 0; i < MOUNT_LINEAR_AXES.length; i++) {
		const axis = MOUNT_LINEAR_AXES[i]
		if (axis === undefined) continue
		const range = limits[axis]
		const value = position[axis]
		if (range === undefined || value === undefined || insideLinear(value, range)) continue
		violations.push({ axis, value, minimum: range[0], maximum: range[1] })
	}

	if (limits.azimuth !== undefined && position.azimuth !== undefined) {
		const inside = limits.azimuthWrap === 'linear' ? insideLinear(position.azimuth, limits.azimuth) : insideCircular(position.azimuth, limits.azimuth)
		if (!inside) violations.push({ axis: 'azimuth', value: position.azimuth, minimum: limits.azimuth[0], maximum: limits.azimuth[1] })
	}

	return { accepted: violations.length === 0, violations }
}
