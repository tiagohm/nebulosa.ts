// Focuser backlash compensation using either accumulated absolute offsets or overshoot-and-return
// moves. All positions and compensation values are focuser steps; returned arrays contain absolute
// target positions in execution order.

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

// Translates a desired focuser target into the move(s) needed to absorb mechanical backlash, using
// either an accumulated absolute offset or an overshoot-then-return pair, depending on the mode.
export class BacklashCompensator {
	// Accumulated absolute-mode position offset, in steps.
	#offset = 0
	// Direction of the last applied move, used to detect reversals.
	#lastDirection: OvershootDirection = 'NONE'

	// Stores backlash parameters and the focuser travel limit.
	constructor(
		readonly compensation: BacklashCompensation,
		readonly maxPosition: number,
	) {}

	// Computes one direct move or an overshoot pair to reach the target position.
	compute(targetPosition: number, currentPosition: number): readonly number[] {
		let newPosition = targetPosition

		switch (this.compensation.mode) {
			case 'ABSOLUTE': {
				const adjustedTargetPosition = targetPosition + this.#offset

				if (adjustedTargetPosition < 0) {
					this.#offset = 0
					newPosition = 0
				} else if (adjustedTargetPosition > this.maxPosition) {
					this.#offset = 0
					newPosition = this.maxPosition
				} else {
					const backlashCompensation = this.#calculateAbsoluteBacklashCompensation(currentPosition, adjustedTargetPosition)
					this.#offset += backlashCompensation
					newPosition = Math.max(0, Math.min(adjustedTargetPosition + backlashCompensation, this.maxPosition))
				}

				break
			}
			case 'OVERSHOOT': {
				const backlashCompensation = this.#calculateOvershootBacklashCompensation(currentPosition, targetPosition)

				if (backlashCompensation !== 0) {
					const overshoot = targetPosition + backlashCompensation

					if (overshoot >= 0 && overshoot <= this.maxPosition) {
						// The final approach is overshoot -> target, and that is the direction
						// that must be remembered for the next backlash decision.
						this.#lastDirection = this.#determineMovingDirection(overshoot, newPosition)
						return [overshoot, newPosition]
					}
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
