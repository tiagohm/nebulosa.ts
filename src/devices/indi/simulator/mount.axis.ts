import type { Angle } from '../../../math/units/angle'
import type { AxisDirection } from './types'

// Mechanical transmission of a single mount axis: the backlash and stick-slip friction that sit
// between what the motor is commanded to do and what the axis actually does. All angles are radians
// and all rates radians per second. The state is a flat mutable record advanced in place on every
// simulation step, so stepping allocates nothing.

// Mechanical imperfections of one axis. Every field defaults to zero meaning a perfect transmission,
// in which case the axis follows the motor exactly.
export interface MechanicalAxisConfig {
	// Total slack of the transmission, radians. On a direction reversal the motor must run through all
	// of it before the axis starts moving again.
	readonly backlash: Angle
	// Fraction of the motor travel that goes into closing the slack, in (0, 1]. At 1 the slack closes
	// as fast as the motor turns; lower values stretch the reversal out over more motor travel. Values
	// outside the range are clamped, since 0 would never close the gap at all.
	readonly takeUpRate: number
	// Motor travel that must accumulate before a stationary axis breaks free, radians. Models static
	// friction: pulses shorter than this produce no motion at all, and several of them add up until
	// the axis suddenly releases.
	readonly staticThreshold: Angle
}

// A transmission with no imperfections, in which the axis follows the motor exactly.
export const IDENTITY_MECHANICAL_AXIS_CONFIG: MechanicalAxisConfig = {
	backlash: 0,
	takeUpRate: 1,
	staticThreshold: 0,
}

// Live state of one axis transmission. Mutated in place by `advanceMechanicalAxis`.
export interface MechanicalAxisState {
	// Slack still to be taken up in the current direction of load, radians in [0, backlash].
	backlashRemaining: Angle
	// Direction the transmission is currently loaded in; 0 when it has never been loaded.
	loadDirection: AxisDirection
	// Motor travel accumulated while the axis is stuck, radians. Signed, and cleared when it releases.
	pendingCommand: Angle
	// Whether the axis is currently in motion. Once moving, kinetic friction takes over and the axis
	// follows the motor smoothly; static friction only has to be overcome from rest.
	moving: boolean
}

// Creates the state of an axis at rest with its transmission unloaded.
export function mechanicalAxisState(): MechanicalAxisState {
	return { backlashRemaining: 0, loadDirection: 0, pendingCommand: 0, moving: false }
}

// Puts an axis back to rest without changing its slack, as when motion is aborted. The transmission
// stays loaded in the direction it was last driven, so resuming in that direction is immediate while
// reversing still costs the full backlash.
export function resetMechanicalAxisMotion(state: MechanicalAxisState) {
	state.pendingCommand = 0
	state.moving = false
}

// Returns an axis to a perfect transmission: no slack open, no flank loaded, nothing stuck.
//
// Unlike `resetMechanicalAxisMotion`, which stops the axis but keeps it loaded where it was, this
// discards the slack as well. Used when the transmission stops being simulated at all, where leaving
// the state behind would let a later re-enable resume from slack taken up under a mount that no
// longer had any.
export function clearMechanicalAxis(state: MechanicalAxisState) {
	state.backlashRemaining = 0
	state.loadDirection = 0
	state.pendingCommand = 0
	state.moving = false
}

// Records `travel` radians of motion the axis made in `direction` under direct drive, without moving
// it here.
//
// Used by motion that drives the axes directly rather than through the transmission, such as a slew,
// so that the state is left consistent for whatever follows. A reversal opens the slack on the other
// flank as usual, and any travel at all then closes it completely: `travel` is what the axis itself
// moved, not what the motor turned, and an axis cannot move through a gap that is still open. However
// short the goto, the gears were engaged on that flank by the end of it.
//
// Subtracting the travel instead left a goto shorter than the backlash owing most of it, so the
// tracking or guiding that resumed in the very direction the slew had just run stalled taking up slack
// that the slew itself had already closed.
//
// A zero travel therefore records the flank alone, which is a reversal with nothing to show for it,
// while any real travel leaves the state a real mount is left in after a goto: immediate in that
// direction, costing the full backlash to reverse.
export function driveMechanicalAxis(state: MechanicalAxisState, direction: AxisDirection, travel: Angle, config: MechanicalAxisConfig) {
	if (direction === 0) return

	if (state.loadDirection !== 0 && state.loadDirection !== direction) {
		state.backlashRemaining = config.backlash
	}

	state.loadDirection = direction
	if (travel !== 0 && state.backlashRemaining > 0) state.backlashRemaining = 0
}

// Reconciles the live state of an axis with a configuration that has just changed, in place.
//
// The slack still to be taken up cannot exceed the slack the transmission now has. Reducing the
// backlash while a reversal is only partly worked through would otherwise leave the axis grinding
// against a gap that no longer exists, and switching the family off and back on would bring the old
// gap back with it, both while the property reported a smaller one.
export function reconcileMechanicalAxis(state: MechanicalAxisState, config: MechanicalAxisConfig) {
	if (state.backlashRemaining > config.backlash) state.backlashRemaining = config.backlash
}

// Advances one axis by `dtSeconds` under a motor running at `motorRate`, and returns the angle the
// axis actually moved, radians, signed in the same sense as the rate.
//
// The order matters and follows the physical chain. A reversal first reloads the slack; the motor
// then spends part of its travel closing that slack, and only what is left reaches the axis; that
// remainder finally has to overcome static friction if the axis is at rest.
//
// A zero rate leaves the axis where it is and lets it come to rest, so that friction has to be
// overcome again on the next command, but keeps the slack loaded in its current direction.
export function advanceMechanicalAxis(state: MechanicalAxisState, motorRate: number, dtSeconds: number, config: MechanicalAxisConfig) {
	const commanded = motorRate * dtSeconds

	if (commanded === 0 || dtSeconds <= 0) {
		// The axis comes to rest, so static friction has to be overcome again before it moves. What has
		// already been commanded against that friction stays wound up: that is what lets a series of
		// pulses too small to move the axis on their own add up until it releases, which is the whole
		// point of the model and is not undone by the gaps between them. A reversal still discards it,
		// since the load moves to the other flank.
		state.moving = false
		return 0
	}

	const direction: AxisDirection = commanded > 0 ? 1 : -1

	// Reversing under load opens the slack again on the other flank of the gear.
	if (state.loadDirection !== 0 && state.loadDirection !== direction) {
		state.backlashRemaining = config.backlash
		state.moving = false
		state.pendingCommand = 0
	}

	state.loadDirection = direction

	let travel = Math.abs(commanded)

	if (state.backlashRemaining > 0 && config.backlash > 0) {
		// Clamped because a non-positive take-up rate would leave the gap permanently open.
		const takeUpRate = config.takeUpRate > 0 ? Math.min(config.takeUpRate, 1) : 1
		const closed = Math.min(travel * takeUpRate, state.backlashRemaining)
		state.backlashRemaining -= closed
		travel -= closed / takeUpRate
		if (travel <= 0) return 0
	}

	if (!state.moving && config.staticThreshold > 0) {
		state.pendingCommand += direction * travel

		if (Math.abs(state.pendingCommand) < config.staticThreshold) return 0

		// Breaks free and delivers everything that had built up, which is the abrupt start of motion
		// that follows a series of pulses too small to move the axis on their own.
		const released = state.pendingCommand
		state.pendingCommand = 0
		state.moving = true
		return released
	}

	state.moving = true

	return direction * travel
}
