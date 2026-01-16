import { midPoint, type Point } from './geometry'
import { type HyperbolicRegression, hyperbolicRegression, type QuadraticRegression, quadraticRegression, type Regression, regressionScore, type TrendLineRegression, trendLineRegression } from './regression'

export type AutoFocusFittingMode = 'TRENDLINES' | 'PARABOLIC' | 'TREND_PARABOLIC' | 'HYPERBOLIC' | 'TREND_HYPERBOLIC'

export type BacklashCompensationMode = 'NONE' | 'ABSOLUTE' | 'OVERSHOOT'

export type OvershootDirection = 'NONE' | 'IN' | 'OUT'

export type AutoFocusStepType = 'MOVE' | 'FAILED' | 'COMPLETED'

export interface BacklashCompensation {
	mode: BacklashCompensationMode
	backlashIn: number
	backlashOut: number
}

export interface AutoFocusStep {
	type: AutoFocusStepType
	relative?: number
	absolute?: number
}

export interface AutoFocusOptions {
	initialOffsetSteps: number
	stepSize: number
	fittingMode: AutoFocusFittingMode
	rmsdThreshold?: number
	reversed: boolean
	maxPosition: number
}

const FocusPointComparator = (a: Point, b: Point) => a.x - b.x

export class AutoFocus {
	private state = 0
	private initialFocusPosition = 0
	private remainingSteps = 0
	private readonly initialOffsetSteps: number
	private readonly stepSize: number
	private readonly fittingMode: AutoFocusFittingMode
	private readonly maximumFocusPoints: number
	private readonly direction: number
	private readonly focusPoints: Point[] = []
	private readonly curves: { trendLine?: TrendLineRegression; parabolic?: QuadraticRegression; hyperbolic?: HyperbolicRegression } = {}

	constructor(readonly options: AutoFocusOptions) {
		this.initialOffsetSteps = options.initialOffsetSteps
		this.stepSize = options.stepSize
		this.fittingMode = options.fittingMode
		this.direction = options.reversed ? -1 : 1
		this.maximumFocusPoints = this.initialOffsetSteps * 10
	}

	get minimum() {
		return this.focusPoints[0]
	}

	get maximum() {
		return this.focusPoints[this.focusPoints.length - 1]
	}

	private makeRelativeStep(type: AutoFocusStepType, relative: number): AutoFocusStep {
		return { type, relative }
	}

	private makeAbsoluteStep(type: AutoFocusStepType, absolute: number): AutoFocusStep {
		return { type, absolute }
	}

	// Call it after each camera capture!
	add(focusPosition: number, hfd: number): AutoFocusStep {
		switch (this.state) {
			// Idle
			case 0:
				this.initialFocusPosition = focusPosition
				this.remainingSteps = this.initialOffsetSteps + 1
				this.state = 1
				// Move the focuser to most distant position. After this, must capture multiple frames and compute its HFD
				return this.makeRelativeStep('MOVE', this.direction * this.initialOffsetSteps * this.stepSize)
			// Curve Fitting
			case 1:
				this.computeRegression(focusPosition, hfd)

				// Keep moving the focuser
				if (this.remainingSteps-- > 0) {
					return this.makeRelativeStep('MOVE', this.direction * -this.stepSize)
				}

				if (this.checkIsFocusPointsEnough()) {
					return this.determinateFocusPoint()
				} else {
					if (this.focusPoints.length >= this.maximumFocusPoints) {
						// Break out when the maximum limit of focus points is reached
						console.warn('maximum number of focus points exceeded')
						return this.makeAbsoluteStep('FAILED', this.initialFocusPosition)
					}

					if (focusPosition <= 0 || (this.options.maxPosition > 0 && focusPosition >= this.options.maxPosition)) {
						// Break out when the focuser hits the min/max position. It can't continue from there.
						console.warn('position reached to min/max')
						return this.makeAbsoluteStep('FAILED', this.initialFocusPosition)
					}

					return this.evaluateTrendline(focusPosition)
				}
			default:
				return this.makeAbsoluteStep('FAILED', this.initialFocusPosition)
		}
	}

	private checkIsFocusPointsEnough() {
		if (!this.curves.trendLine) return false
		const { left, right, minimum } = this.curves.trendLine
		return right.xPoints.length + this.focusPoints.filter((e) => e.x > minimum.x && e.y === 0).length >= this.initialOffsetSteps && left.xPoints.length + this.focusPoints.filter((e) => e.x < minimum.x && e.y === 0).length >= this.initialOffsetSteps
	}

	private evaluateTrendline(focusPosition: number): AutoFocusStep {
		const { left, right, minimum } = this.curves.trendLine!

		if (!left.xPoints.length && !right.xPoints.length) {
			console.warn('not enought spreaded points')
			return this.makeAbsoluteStep('FAILED', this.initialFocusPosition)
		}

		// Let's keep moving in, one step at a time, until we have enough left trend points.
		// Then we can think about moving out to fill in the right trend points.
		if (left.xPoints.length < this.initialOffsetSteps && this.focusPoints.filter((e) => e.x < minimum.x && e.y === 0).length < this.initialOffsetSteps) {
			console.info('more data points needed to the left of the minimum')

			const firstX = Math.trunc(this.minimum.x)

			if (focusPosition !== firstX) {
				// Move to the leftmost point - this should never be necessary since we're already there, but just in case
				return this.makeAbsoluteStep('MOVE', firstX)
			} else {
				// More points needed to the left.
				return this.makeRelativeStep('MOVE', this.direction * -this.stepSize)
			}
		} else if (right.xPoints.length < this.initialOffsetSteps && this.focusPoints.filter((e) => e.x > minimum.x && e.y === 0).length < this.initialOffsetSteps) {
			// Now we can go to the right, if necessary.
			console.info('more data points needed to the right of the minimum')

			const lastX = Math.trunc(this.maximum.x)

			if (focusPosition !== lastX) {
				// More points needed to the right. Let's get to the rightmost point, and keep going right one point at a time.
				return this.makeAbsoluteStep('MOVE', lastX)
			} else {
				// More points needed to the right.
				return this.makeRelativeStep('MOVE', this.direction * this.stepSize)
			}
		}

		return this.determinateFocusPoint()
	}

	private computeRegression(focusPosition: number, hfd: number) {
		this.focusPoints.push({ x: focusPosition, y: hfd })
		this.focusPoints.sort(FocusPointComparator)

		const x = this.focusPoints.map((e) => e.x)
		const y = this.focusPoints.map((e) => e.y)

		this.curves.trendLine = trendLineRegression(x, y, 'theil-sen')

		if (x.length >= 3) {
			if (this.fittingMode === 'PARABOLIC' || this.fittingMode === 'TREND_PARABOLIC') {
				this.curves.parabolic = quadraticRegression(x, y)
			} else if (this.fittingMode === 'HYPERBOLIC' || this.fittingMode === 'TREND_HYPERBOLIC') {
				this.curves.hyperbolic = hyperbolicRegression(x, y)
			}
		}
	}

	private determinateFocusPoint(): AutoFocusStep {
		const determinedFocusPoint = this.focusPoint

		if (!determinedFocusPoint || !this.validateCalculatedFocusPosition(determinedFocusPoint)) {
			console.warn('potentially bad auto-focus. Restoring original focus position')
			return this.makeAbsoluteStep('FAILED', this.initialFocusPosition)
		} else {
			return this.makeAbsoluteStep('COMPLETED', determinedFocusPoint.x)
		}
	}

	private validateCalculatedFocusPosition(focusPoint: Readonly<Point>) {
		if (focusPoint.x < this.minimum.x || focusPoint.x > this.maximum.x) {
			console.warn('determined focus point position is outside of the overall measurement points of the curve')
			return false
		}

		const { rmsdThreshold = 0 } = this.options

		if (rmsdThreshold > 0) {
			const isRegressionBad = (regression: Regression) => regressionScore(regression).rmsd / focusPoint.y > rmsdThreshold

			const { trendLine, parabolic, hyperbolic } = this.curves
			let isBad = false

			switch (this.fittingMode) {
				case 'TRENDLINES':
					isBad = !trendLine || isRegressionBad(trendLine.left) || isRegressionBad(trendLine.right)
					break
				case 'PARABOLIC':
					isBad = !parabolic || isRegressionBad(parabolic)
					break
				case 'TREND_PARABOLIC':
					isBad = !parabolic || !trendLine || isRegressionBad(parabolic) || isRegressionBad(trendLine.left) || isRegressionBad(trendLine.right)
					break
				case 'HYPERBOLIC':
					isBad = !hyperbolic || isRegressionBad(hyperbolic)
					break
				case 'TREND_HYPERBOLIC':
					isBad = !hyperbolic || !trendLine || isRegressionBad(hyperbolic) || isRegressionBad(trendLine.left) || isRegressionBad(trendLine.right)
					break
			}

			if (isBad) {
				console.warn('coefficient of determination is below threshold')
				return false
			}
		}

		return true
	}

	get trendLine() {
		return this.curves.trendLine
	}

	get parabolic() {
		return this.curves.parabolic
	}

	get hyperbolic() {
		return this.curves.hyperbolic
	}

	get focusPoint() {
		const { trendLine, parabolic, hyperbolic } = this.curves

		switch (this.fittingMode) {
			case 'TRENDLINES':
				return trendLine?.intersection
			case 'PARABOLIC':
				return parabolic?.minimum
			case 'TREND_PARABOLIC':
				return parabolic?.minimum && trendLine?.intersection && midPoint(parabolic.minimum, trendLine.intersection)
			case 'HYPERBOLIC':
				return hyperbolic?.minimum
			case 'TREND_HYPERBOLIC':
				return hyperbolic?.minimum && trendLine?.intersection && midPoint(hyperbolic.minimum, trendLine.intersection)
			default:
				return undefined
		}
	}
}

export class BacklashCompensator {
	private offset = 0
	private lastDirection: OvershootDirection = 'NONE'

	constructor(
		readonly compensation: BacklashCompensation,
		readonly maxPosition: number,
	) {}

	compute(targetPosition: number, currentPosition: number): readonly number[] {
		let newPosition = targetPosition

		switch (this.compensation.mode) {
			case 'ABSOLUTE': {
				const adjustedTargetPosition = targetPosition + this.offset

				if (adjustedTargetPosition < 0) {
					this.offset = 0
					newPosition = 0
				} else if (adjustedTargetPosition > this.maxPosition) {
					this.offset = 0
					newPosition = this.maxPosition
				} else {
					const backlashCompensation = this.calculateAbsoluteBacklashCompensation(currentPosition, adjustedTargetPosition)
					this.offset += backlashCompensation
					newPosition = Math.max(0, Math.min(adjustedTargetPosition + backlashCompensation, this.maxPosition))
				}

				break
			}
			case 'OVERSHOOT': {
				const backlashCompensation = this.calculateOvershootBacklashCompensation(currentPosition, targetPosition)

				if (backlashCompensation !== 0) {
					const overshoot = targetPosition + backlashCompensation

					if (overshoot >= 0 && overshoot <= this.maxPosition) {
						this.lastDirection = this.determineMovingDirection(currentPosition, overshoot)
						this.lastDirection = this.determineMovingDirection(overshoot, newPosition)
						return [overshoot, newPosition]
					}
				}

				break
			}
		}

		this.lastDirection = this.determineMovingDirection(currentPosition, newPosition)

		return [newPosition]
	}

	private determineMovingDirection(prevPosition: number, newPosition: number): OvershootDirection {
		return newPosition > prevPosition ? 'OUT' : newPosition < prevPosition ? 'IN' : this.lastDirection
	}

	private calculateAbsoluteBacklashCompensation(lastPosition: number, newPosition: number) {
		const direction = this.determineMovingDirection(lastPosition, newPosition)
		const { backlashIn, backlashOut } = this.compensation
		return direction === 'IN' && this.lastDirection === 'OUT' ? -backlashIn : direction === 'OUT' && this.lastDirection === 'IN' ? backlashOut : 0
	}

	private calculateOvershootBacklashCompensation(lastPosition: number, newPosition: number): number {
		const direction = this.determineMovingDirection(lastPosition, newPosition)
		const { backlashIn, backlashOut } = this.compensation
		return direction === 'IN' && backlashIn !== 0 ? -backlashIn : direction === 'OUT' && backlashOut !== 0 ? backlashOut : 0
	}
}
