import { PI, TAU } from '../../core/constants'
import { brentMinimize } from '../../math/numerical/optimization'
import { pchip } from '../../math/numerical/spline'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { timeShift, timeSubtract, type Time } from '../time/time'
import { meteorSolarLongitude } from './solar'
import type { MeteorActivityProfile, MeteorExponentialActivityProfile, MeteorSampledActivityProfile, MeteorSolarLongitudeInterval } from './types'

// Meteor activity profiles and visual-rate mathematics. Catalog support intervals only decide where
// a shower is active; ZHR profiles are explicit caller-supplied data. Solar-longitude coordinates are
// unwrapped locally within each circular support and all exponential slopes use degrees as published.

// Tests whether a solar longitude lies in a forward circular interval. Undefined support means that
// the catalog did not publish a window, so the result is undefined rather than false.
export function isMeteorShowerActive(interval: MeteorSolarLongitudeInterval | undefined, solarLongitude: Angle): boolean | undefined {
	if (interval === undefined) return undefined
	const width = meteorSolarLongitudeForwardDelta(interval.start, interval.end)
	if (width === 0) return false
	return meteorSolarLongitudeForwardDelta(interval.start, solarLongitude) <= width
}

// Returns progress through a known interval, in [0, 1]. Undefined means that the activity window
// itself is absent; an equal start/end is deliberately not a full circular interval.
export function meteorActivityPhase(interval: MeteorSolarLongitudeInterval | undefined, solarLongitude: Angle): number | undefined {
	if (interval === undefined) return undefined
	const width = meteorSolarLongitudeForwardDelta(interval.start, interval.end)
	if (width === 0) return undefined
	return Math.min(1, meteorSolarLongitudeForwardDelta(interval.start, solarLongitude) / width)
}

// Evaluates a supplied activity profile in ZHR (meteors per hour), returning zero outside its support.
export function meteorActivityZhr(profile: MeteorActivityProfile, solarLongitude: Angle): number {
	if (profile.type === 'exponential') return exponentialZhr(profile, solarLongitude)
	if (profile.type === 'sampled') return sampledZhr(profile, solarLongitude)
	let total = 0
	for (const component of profile.components) total += exponentialZhr(component, solarLongitude)
	return total
}

// Alias emphasizing that this is a profile evaluator rather than a catalog period.
export const meteorZhrAtSolarLongitude = meteorActivityZhr
export const meteorZhr = meteorActivityZhr
export const evaluateMeteorActivity = meteorActivityZhr

// Finds the longitude of the maximum of a profile. Multi-peak profiles are optimized as a sum and
// therefore may peak away from every individual component maximum.
export function meteorActivityMaximumSolarLongitude(profile: MeteorActivityProfile): Angle | undefined {
	if (profile.type === 'exponential') return isMeteorShowerActive(profile.support, profile.solarLongitude) ? normalizeAngle(profile.solarLongitude) : undefined
	if (profile.type === 'sampled') {
		let best: { longitude: Angle; value: number } | undefined
		for (const sample of profile.samples) {
			if (best === undefined || sample.zhr > best.value) best = { longitude: sample.solarLongitude, value: sample.zhr }
		}
		return best?.longitude
	}

	const candidates: number[] = []
	for (const component of profile.components) {
		candidates.push(normalizeAngle(component.solarLongitude), normalizeAngle(component.support.start), normalizeAngle(component.support.end))
	}
	if (candidates.length === 0) return undefined
	const grid = 1440
	let bestLongitude = candidates[0]
	let bestValue = meteorActivityZhr(profile, bestLongitude)
	for (let i = 0; i < grid; i++) {
		const longitude = (i * TAU) / grid
		const value = meteorActivityZhr(profile, longitude)
		if (value > bestValue) {
			bestValue = value
			bestLongitude = longitude
		}
	}
	const step = TAU / grid
	for (const candidate of [...candidates, bestLongitude]) {
		const result = brentMinimize((x) => -meteorActivityZhr(profile, normalizeAngle(x)), candidate - step, candidate + step)
		if (-result.value > bestValue) {
			bestValue = -result.value
			bestLongitude = normalizeAngle(result.minimum)
		}
	}
	return bestLongitude
}

// Returns all circular intervals where a profile is at least the selected fraction of its own peak.
// Disconnected intervals are retained separately, which is important for overlapping multi-peak profiles.
export function meteorActivityIntervalsAboveFraction(profile: MeteorActivityProfile, fraction: number, options: { readonly samples?: number } = {}): readonly MeteorSolarLongitudeInterval[] {
	if (!(fraction >= 0) || fraction > 1) return []
	const maximum = meteorActivityMaximumSolarLongitude(profile)
	if (maximum === undefined) return []
	const peak = meteorActivityZhr(profile, maximum)
	if (!(peak > 0)) return []
	const count = Math.max(32, Math.trunc(options.samples ?? 1440))
	const threshold = peak * fraction
	const active = new Uint8Array(count)
	for (let i = 0; i < count; i++) active[i] = meteorActivityZhr(profile, (i * TAU) / count) >= threshold ? 1 : 0

	const transitions: { readonly longitude: Angle; readonly entering: boolean }[] = []
	const step = TAU / count
	for (let i = 0; i < count; i++) {
		const previous = active[(i + count - 1) % count]
		if (previous !== active[i]) {
			const boundary = refineActivityBoundary(profile, threshold, (i - 1) * step, i * step)
			transitions.push({ longitude: boundary, entering: active[i] === 1 })
		}
	}
	if (transitions.length === 0) return active[0] ? [{ start: 0, end: 0 }] : []
	const intervals: MeteorSolarLongitudeInterval[] = []
	for (let i = 0; i < transitions.length; i++) {
		if (!transitions[i].entering) continue
		for (let offset = 1; offset <= transitions.length; offset++) {
			const end = transitions[(i + offset) % transitions.length]
			if (end.entering) continue
			intervals.push({ start: transitions[i].longitude, end: end.longitude })
			break
		}
	}
	return intervals
}

// Returns the profile maximum longitude under a concise API name.
export const meteorActivityMaximum = meteorActivityMaximumSolarLongitude

// Returns all profile intervals above a selected fraction of peak activity.
export const meteorActivityWidth = meteorActivityIntervalsAboveFraction

// Evaluates an exponential activity component. The side slopes are per degree of solar longitude,
// so the radian displacement is converted exactly once before the base-10 decay is applied.
export function meteorExponentialZhr(profile: MeteorExponentialActivityProfile, solarLongitude: Angle): number {
	return exponentialZhr(profile, solarLongitude)
}

// Integrates ZHR over a time interval and returns meteors per ideal observer-hour (ZHR·h). The solar
// longitude is recomputed at each sample unless a caller supplies a shared provider in options.
export function integrateMeteorZhr(profile: MeteorActivityProfile, start: Time, end: Time, options: MeteorIntegrationOptions = {}): number {
	const duration = timeSubtract(end, start)
	if (!(duration > 0)) return 0
	const step = options.step ?? 1 / 24
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor ZHR integration step must be finite and positive')
	const count = Math.max(1, Math.ceil(duration / step))
	const h = duration / count
	const longitudeAt = options.solarLongitude ?? meteorSolarLongitude
	// Simpson's rule is used only when an even number of panels is available; otherwise trapezoids
	// preserve the requested endpoint and remain deterministic for arbitrary short windows.
	if (count % 2 === 0) {
		let total = 0
		for (let i = 0; i <= count; i++) {
			const coefficient = i === 0 || i === count ? 1 : i % 2 === 0 ? 2 : 4
			total += coefficient * meteorActivityZhr(profile, longitudeAt(timeShift(start, i * h)))
		}
		return ((total * h) / 3) * 24
	}
	let trapezoid = 0
	let previous = meteorActivityZhr(profile, longitudeAt(start))
	for (let i = 1; i <= count; i++) {
		const current = meteorActivityZhr(profile, longitudeAt(timeShift(start, i * h)))
		trapezoid += (previous + current) * h * 0.5
		previous = current
	}
	return trapezoid * 24
}

// Options controlling time integration. `solarLongitude` can point at a context-backed value in a
// batch planner, avoiding a second ephemeris evaluation at the same instant.
export interface MeteorIntegrationOptions {
	// Integration panel width in days.
	readonly step?: number
	// Shared solar-longitude provider.
	readonly solarLongitude?: (time: Time) => Angle
}

// Converts an exponential profile to a sampled function using its forward support coordinate.
function exponentialZhr(profile: MeteorExponentialActivityProfile, solarLongitude: Angle): number {
	const offset = meteorSolarLongitudeForwardDelta(profile.support.start, solarLongitude)
	const width = meteorSolarLongitudeForwardDelta(profile.support.start, profile.support.end)
	if (width === 0 || offset > width) return 0
	const maximumOffset = meteorSolarLongitudeForwardDelta(profile.support.start, profile.solarLongitude)
	const deltaDegrees = (Math.abs(offset - maximumOffset) * 180) / PI
	const slope = offset <= maximumOffset ? profile.slopeBefore : profile.slopeAfter
	return profile.zhr * 10 ** (-slope * deltaDegrees)
}

function sampledZhr(profile: MeteorSampledActivityProfile, solarLongitude: Angle): number {
	const offset = meteorSolarLongitudeForwardDelta(profile.support.start, solarLongitude)
	const width = meteorSolarLongitudeForwardDelta(profile.support.start, profile.support.end)
	if (width === 0 || offset > width || profile.samples.length === 0) return 0
	if (profile.samples.length === 1) return offset === meteorSolarLongitudeForwardDelta(profile.support.start, profile.samples[0].solarLongitude) ? profile.samples[0].zhr : 0
	const x = new Float64Array(profile.samples.length)
	const y = new Float64Array(profile.samples.length)
	for (let i = 0; i < profile.samples.length; i++) {
		x[i] = meteorSolarLongitudeForwardDelta(profile.support.start, profile.samples[i].solarLongitude)
		y[i] = profile.samples[i].zhr
		if (i > 0 && !(x[i] > x[i - 1])) throw new Error('meteor activity samples must be strictly increasing within support')
	}
	if (offset < x.at(0)! || offset > x.at(-1)!) return 0
	return pchip(x, y, { outOfRange: 'throw' }).compute(offset)
}

// Refines a sampled activity threshold crossing in its unwrapped local longitude coordinate. At a
// support edge the profile can jump from zero to a positive value, so the bracket fallback returns
// the edge rather than pretending that a root exists inside the discontinuity.
function refineActivityBoundary(profile: MeteorActivityProfile, threshold: number, left: number, right: number): Angle {
	let a = left
	let b = right
	let fa = meteorActivityZhr(profile, normalizeAngle(a)) - threshold
	let fb = meteorActivityZhr(profile, normalizeAngle(b)) - threshold
	if (fa === 0) return normalizeAngle(a)
	if (fb === 0) return normalizeAngle(b)
	if (!((fa < 0 && fb > 0) || (fa > 0 && fb < 0))) return normalizeAngle(fa < 0 ? b : a)
	for (let iteration = 0; iteration < 60; iteration++) {
		const middle = (a + b) * 0.5
		const fm = meteorActivityZhr(profile, normalizeAngle(middle)) - threshold
		if (fm === 0 || b - a <= 1e-12) return normalizeAngle(middle)
		if ((fa < 0 && fm > 0) || (fa > 0 && fm < 0)) {
			b = middle
			fb = fm
		} else {
			a = middle
			fa = fm
		}
	}
	return normalizeAngle((a + b) * 0.5)
}

// Computes a forward circular longitude offset in [0, 2π).
export function meteorSolarLongitudeForwardDelta(start: Angle, end: Angle): Angle {
	return normalizeAngle(end - start)
}
