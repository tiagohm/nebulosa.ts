import { SIDEREAL_DRIFT_RATE, TAU } from '../../core/constants'
import { type Angle, normalizePI } from '../../math/units/angle'

// Hour angle of a fixed-right-ascension target and the time it spends inside an hour-angle window.
// The hour angle is local sidereal time minus right ascension, normalized to (−π, π], positive west
// of the meridian. It advances at the sidereal rate; the target's own motion is not included. Times
// are SI seconds. A search longer than 100_000 sidereal days is rejected before the result array is
// allocated.

// One continuous stretch of seconds, measured from the epoch of the supplied hour angle, during which
// the target's signed hour angle lies in the requested interval.
export interface HourAngleWindow {
	// First second of the stretch, inclusive.
	readonly startSeconds: number
	// Last second of the stretch.
	readonly endSeconds: number
}

// Largest number of sidereal turns searched. Beyond this the window list would be an accidental
// allocation rather than an observing sequence.
const MAX_HOUR_ANGLE_TURNS = 100_000
// Gap below which two successive stretches are joined. A full-turn interval meets itself at ±π.
const WINDOW_JOIN_SECONDS = 1e-6

// Signed hour angle of a target.
// Parameters: localSiderealTime and rightAscension are radians. Returns LST − RA in (−π, π],
// positive west of the meridian.
export function hourAngle(localSiderealTime: Angle, rightAscension: Angle): Angle {
	return normalizePI(localSiderealTime - rightAscension)
}

// Seconds until the target next stands on the meridian.
// Parameters: hourAngleRadians is a signed hour angle in radians; it is normalized to (−π, π] first.
// Returns a non-negative duration in SI seconds. Zero means the target is on the meridian now. A
// target already west of the meridian waits until the following transit.
export function timeUntilMeridian(hourAngleRadians: Angle): number {
	const signed = normalizePI(hourAngleRadians)
	if (signed === 0) return 0
	return (signed < 0 ? -signed : TAU - signed) / SIDEREAL_DRIFT_RATE
}

// Joins stretches that meet at a branch cut into one interval.
function joinWindows(windows: HourAngleWindow[]) {
	const joined: HourAngleWindow[] = []

	for (let i = 0; i < windows.length; i++) {
		const window = windows[i]
		if (window === undefined) continue
		const previous = joined.at(-1)
		if (previous !== undefined && window.startSeconds <= previous.endSeconds + WINDOW_JOIN_SECONDS) joined[joined.length - 1] = { startSeconds: previous.startSeconds, endSeconds: Math.max(previous.endSeconds, window.endSeconds) }
		else joined.push(window)
	}

	return joined
}

// Future intervals during which the signed hour angle stays inside [minimum, maximum].
// Parameters: hourAngleRadians is the hour angle at seconds zero. minimum and maximum are signed
// bounds in radians. When minimum <= maximum the allowed set is that ordinary interval. When
// minimum > maximum the interval crosses the ±π cut (for example from +170° through 12h to −170°).
// durationSeconds is how far ahead to look. Returns the stretches inside the duration, joined where
// a cut would otherwise split one visit. An empty duration or a zero-length bound returns no
// windows. A non-finite or non-positive duration returns none; a duration covering more than
// 100_000 sidereal days is rejected.
export function hourAngleWindows(hourAngleRadians: Angle, minimum: Angle, maximum: Angle, durationSeconds: number): readonly HourAngleWindow[] {
	if (!Number.isFinite(durationSeconds) || !(durationSeconds > 0) || !(maximum !== minimum)) return []
	const turns = (durationSeconds * SIDEREAL_DRIFT_RATE) / TAU
	if (turns > MAX_HOUR_ANGLE_TURNS) throw new RangeError('hour-angle window is too long')

	const start = normalizePI(hourAngleRadians)
	const wrapping = minimum > maximum
	const firstTurn = Math.floor(start / TAU) - 2
	const lastTurn = Math.floor((start + SIDEREAL_DRIFT_RATE * durationSeconds) / TAU) + 2
	const windows: HourAngleWindow[] = []

	for (let turn = firstTurn; turn <= lastTurn; turn++) {
		const enterAngle = minimum + TAU * turn
		const exitAngle = wrapping ? maximum + TAU * (turn + 1) : maximum + TAU * turn
		const enter = (enterAngle - start) / SIDEREAL_DRIFT_RATE
		const exit = (exitAngle - start) / SIDEREAL_DRIFT_RATE
		const clippedEnter = Math.max(0, enter)
		const clippedExit = Math.min(durationSeconds, exit)
		if (clippedExit > clippedEnter) windows.push({ startSeconds: clippedEnter, endSeconds: clippedExit })
	}

	return joinWindows(windows)
}
