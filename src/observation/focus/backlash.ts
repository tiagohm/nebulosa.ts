// Focuser backlash compensation using either accumulated absolute offsets or overshoot-and-return
// moves. All positions and compensation values are focuser steps; returned arrays contain absolute
// target positions in execution order. Positions are never clamped: the caller checks every returned
// position against the travel of the focuser before commanding any of them.

// Backlash handling: none, absolute offset accumulation, or overshoot-and-return.
export type BacklashCompensationMode = 'NONE' | 'ABSOLUTE' | 'OVERSHOOT'

// Last focuser travel direction used for backlash decisions; NONE before any move.
export type OvershootDirection = 'NONE' | 'IN' | 'OUT'

// Mechanical backlash parameters for a focuser.
export interface BacklashCompensation {
	// Active compensation strategy.
	mode: BacklashCompensationMode
	// Backlash absorbed when reversing into the IN direction, in steps.
	backlashIn: number
	// Backlash absorbed when reversing into the OUT direction, in steps.
	backlashOut: number
}

// Memory of a compensator between two computations.
export interface BacklashCompensatorState {
	// Accumulated absolute-mode offset, in steps: the commanded position minus the requested one.
	readonly offset: number
	// Direction of the last computed move.
	readonly lastDirection: OvershootDirection
}

// State of a compensator before its first move.
const INITIAL_STATE: BacklashCompensatorState = { offset: 0, lastDirection: 'NONE' }

// Translates a desired focuser target into the move(s) needed to absorb mechanical backlash, using
// either an accumulated absolute offset or an overshoot-then-return pair, depending on the mode.
export class BacklashCompensator {
	// Accumulated absolute-mode position offset, in steps.
	#offset = 0
	// Direction of the last applied move, used to detect reversals.
	#lastDirection: OvershootDirection = 'NONE'

	// Stores backlash parameters.
	constructor(readonly compensation: BacklashCompensation) {}

	// Memory of the compensator, to restore it after a computed plan that was not executed.
	get state(): BacklashCompensatorState {
		return { offset: this.#offset, lastDirection: this.#lastDirection }
	}

	// Replaces the memory of the compensator, by default with the one before any move: no offset and
	// no known direction, for a focuser whose position was redefined or can no longer be trusted.
	reset(state: BacklashCompensatorState = INITIAL_STATE) {
		this.#offset = state.offset
		this.#lastDirection = state.lastDirection
	}

	// Computes one direct move or an overshoot pair to reach the target position. The memory is updated
	// as if the returned positions were executed.
	compute(targetPosition: number, currentPosition: number): readonly number[] {
		let newPosition = targetPosition

		switch (this.compensation.mode) {
			case 'ABSOLUTE': {
				const adjustedTargetPosition = targetPosition + this.#offset
				const backlashCompensation = this.#calculateAbsoluteBacklashCompensation(currentPosition, adjustedTargetPosition)
				newPosition = adjustedTargetPosition + backlashCompensation
				this.#offset += backlashCompensation
				break
			}
			case 'OVERSHOOT': {
				const backlashCompensation = this.#calculateOvershootBacklashCompensation(currentPosition, targetPosition)

				if (backlashCompensation !== 0) {
					const overshoot = targetPosition + backlashCompensation
					// The final approach is overshoot -> target, and that is the direction
					// that must be remembered for the next backlash decision.
					this.#lastDirection = this.#determineMovingDirection(overshoot, newPosition)
					return [overshoot, newPosition]
				}

				break
			}
		}

		this.#lastDirection = this.#determineMovingDirection(currentPosition, newPosition)

		return [newPosition]
	}

	// Infers the latest move direction and preserves it across no-op absolute moves.
	#determineMovingDirection(prevPosition: number, newPosition: number): OvershootDirection {
		return newPosition > prevPosition ? 'OUT' : newPosition < prevPosition ? 'IN' : this.#lastDirection
	}

	// Updates absolute backlash offset only when the requested move reverses direction.
	#calculateAbsoluteBacklashCompensation(lastPosition: number, newPosition: number) {
		const direction = this.#determineMovingDirection(lastPosition, newPosition)
		const { backlashIn, backlashOut } = this.compensation
		return direction === 'IN' && this.#lastDirection === 'OUT' ? -backlashIn : direction === 'OUT' && this.#lastDirection === 'IN' ? backlashOut : 0
	}

	// Computes overshoot compensation only when a move is actually requested.
	#calculateOvershootBacklashCompensation(lastPosition: number, newPosition: number) {
		if (newPosition === lastPosition) return 0

		const direction = this.#determineMovingDirection(lastPosition, newPosition)
		const { backlashIn, backlashOut } = this.compensation
		return direction === 'IN' && backlashIn !== 0 ? -backlashIn : direction === 'OUT' && backlashOut !== 0 ? backlashOut : 0
	}
}
