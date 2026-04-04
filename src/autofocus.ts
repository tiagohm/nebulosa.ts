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

const INVALID_HFD = 0

// Sorts measured focus points by absolute focuser position.
function FocusPointComparator(a: Point, b: Point) {
	return a.x - b.x
}

// Normalizes malformed HFD samples to the invalid-data sentinel.
function sanitizeHfd(hfd: number) {
	return Number.isFinite(hfd) && hfd > 0 ? hfd : INVALID_HFD
}

// Keeps only finite positions with positive HFD values in regression fits.
function isValidFocusPoint(point: Point) {
	return Number.isFinite(point.x) && point.y > INVALID_HFD
}

export class AutoFocus {
	#state = 0
	#initialFocusPosition = 0
	#remainingSteps = 0
	readonly #initialOffsetSteps: number
	readonly #stepSize: number
	readonly #fittingMode: AutoFocusFittingMode
	readonly #maximumFocusPoints: number
	readonly #direction: number
	readonly #focusPoints: Point[] = []
	readonly #curves: { trendLine?: TrendLineRegression; parabolic?: QuadraticRegression; hyperbolic?: HyperbolicRegression } = {}

	// Precomputes the scan geometry and stores immutable fitting options.
	constructor(readonly options: AutoFocusOptions) {
		this.#initialOffsetSteps = options.initialOffsetSteps
		this.#stepSize = options.stepSize
		this.#fittingMode = options.fittingMode
		this.#direction = options.reversed ? -1 : 1
		this.#maximumFocusPoints = this.#initialOffsetSteps * 10
	}

	// Returns the leftmost sampled focus point.
	get minimum(): Readonly<Point> | undefined {
		return this.#focusPoints[0]
	}

	// Returns the rightmost sampled focus point.
	get maximum(): Readonly<Point> | undefined {
		return this.#focusPoints[this.#focusPoints.length - 1]
	}

	// Creates a relative move step command.
	#makeRelativeStep(type: AutoFocusStepType, relative: number): AutoFocusStep {
		return { type, relative }
	}

	// Creates an absolute move or terminal step command.
	#makeAbsoluteStep(type: AutoFocusStepType, absolute: number): AutoFocusStep {
		return { type, absolute }
	}

	// Call it after each camera capture!
	add(focusPosition: number, hfd: number): AutoFocusStep {
		if (!Number.isFinite(focusPosition)) {
			console.warn('invalid focus position')
			return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
		}

		switch (this.#state) {
			// Idle
			case 0:
				this.#initialFocusPosition = focusPosition
				this.#remainingSteps = this.#initialOffsetSteps + 1
				this.#state = 1
				// Move the focuser to most distant position. After this, must capture multiple frames and compute its HFD
				return this.#makeRelativeStep('MOVE', this.#direction * this.#initialOffsetSteps * this.#stepSize)
			// Curve Fitting
			case 1:
				this.#computeRegression(focusPosition, hfd)

				// Keep moving the focuser
				if (this.#remainingSteps-- > 0) {
					return this.#makeRelativeStep('MOVE', this.#direction * -this.#stepSize)
				}

				if (this.#checkIsFocusPointsEnough()) {
					return this.#determinateFocusPoint()
				} else {
					if (this.#focusPoints.length >= this.#maximumFocusPoints) {
						// Break out when the maximum limit of focus points is reached
						console.warn('maximum number of focus points exceeded')
						return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
					}

					if (focusPosition <= 0 || (this.options.maxPosition > 0 && focusPosition >= this.options.maxPosition)) {
						// Break out when the focuser hits the min/max position. It can't continue from there.
						console.warn('position reached to min/max')
						return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
					}

					return this.#evaluateTrendline(focusPosition)
				}
			default:
				return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
		}
	}

	// Checks whether each side of the current minimum has enough valid or rejected samples.
	#checkIsFocusPointsEnough() {
		const trendLine = this.#curves.trendLine

		if (!trendLine) return false

		const { left, right, minimum } = trendLine
		return right.xPoints.length + this.#countInvalidFocusPoints(minimum.x, 1) >= this.#initialOffsetSteps && left.xPoints.length + this.#countInvalidFocusPoints(minimum.x, -1) >= this.#initialOffsetSteps
	}

	// Counts rejected measurements to one side of the current minimum.
	#countInvalidFocusPoints(minimumPosition: number, direction: -1 | 1) {
		let count = 0

		for (let i = 0; i < this.#focusPoints.length; i++) {
			const { x, y } = this.#focusPoints[i]

			if (y <= INVALID_HFD && (direction < 0 ? x < minimumPosition : x > minimumPosition)) {
				count++
			}
		}

		return count
	}

	// Extends the sampled V-curve on whichever side still needs support points.
	#evaluateTrendline(focusPosition: number): AutoFocusStep {
		const trendLine = this.#curves.trendLine

		if (!trendLine) {
			console.warn('not enough valid focus points')
			return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
		}

		const { left, right, minimum } = trendLine
		const invalidLeftFocusPoints = this.#countInvalidFocusPoints(minimum.x, -1)
		const invalidRightFocusPoints = this.#countInvalidFocusPoints(minimum.x, 1)

		if (!left.xPoints.length && !right.xPoints.length) {
			console.warn('not enough spreaded points')
			return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
		}

		// Let's keep moving in, one step at a time, until we have enough left trend points.
		// Then we can think about moving out to fill in the right trend points.
		if (left.xPoints.length < this.#initialOffsetSteps && invalidLeftFocusPoints < this.#initialOffsetSteps) {
			console.info('more data points needed to the left of the minimum')

			const firstFocusPoint = this.minimum

			if (!firstFocusPoint) {
				console.warn('minimum focus point is unavailable')
				return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
			}

			const firstX = Math.trunc(firstFocusPoint.x)

			if (focusPosition !== firstX) {
				// Move to the leftmost point - this should never be necessary since we're already there, but just in case
				return this.#makeAbsoluteStep('MOVE', firstX)
			} else {
				// More points needed to the left.
				return this.#makeRelativeStep('MOVE', this.#direction * -this.#stepSize)
			}
		} else if (right.xPoints.length < this.#initialOffsetSteps && invalidRightFocusPoints < this.#initialOffsetSteps) {
			// Now we can go to the right, if necessary.
			console.info('more data points needed to the right of the minimum')

			const lastFocusPoint = this.maximum

			if (!lastFocusPoint) {
				console.warn('maximum focus point is unavailable')
				return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
			}

			const lastX = Math.trunc(lastFocusPoint.x)

			if (focusPosition !== lastX) {
				// More points needed to the right. Let's get to the rightmost point, and keep going right one point at a time.
				return this.#makeAbsoluteStep('MOVE', lastX)
			} else {
				// More points needed to the right.
				return this.#makeRelativeStep('MOVE', this.#direction * this.#stepSize)
			}
		}

		return this.#determinateFocusPoint()
	}

	// Updates all enabled regression fits using only valid positive-HFD measurements.
	#computeRegression(focusPosition: number, hfd: number) {
		this.#focusPoints.push({ x: focusPosition, y: sanitizeHfd(hfd) })
		this.#focusPoints.sort(FocusPointComparator)

		let validCount = 0

		for (let i = 0; i < this.#focusPoints.length; i++) {
			if (isValidFocusPoint(this.#focusPoints[i])) {
				validCount++
			}
		}

		if (validCount === 0) {
			this.#curves.trendLine = undefined
			this.#curves.parabolic = undefined
			this.#curves.hyperbolic = undefined
			return
		}

		const x = new Float64Array(validCount)
		const y = new Float64Array(validCount)

		for (let i = 0, j = 0; i < this.#focusPoints.length; i++) {
			const point = this.#focusPoints[i]

			if (isValidFocusPoint(point)) {
				x[j] = point.x
				y[j++] = point.y
			}
		}

		this.#curves.trendLine = trendLineRegression(x, y, 'theil-sen')

		if (x.length >= 3) {
			if (this.#fittingMode === 'PARABOLIC' || this.#fittingMode === 'TREND_PARABOLIC') {
				this.#curves.parabolic = quadraticRegression(x, y)
			} else if (this.#fittingMode === 'HYPERBOLIC' || this.#fittingMode === 'TREND_HYPERBOLIC') {
				this.#curves.hyperbolic = hyperbolicRegression(x, y)
			}
		}
	}

	// Selects the final focus position and falls back to the original position when validation fails.
	#determinateFocusPoint(): AutoFocusStep {
		const determinedFocusPoint = this.focusPoint

		if (!determinedFocusPoint || !this.#validateCalculatedFocusPosition(determinedFocusPoint)) {
			console.warn('potentially bad auto-focus. Restoring original focus position')
			return this.#makeAbsoluteStep('FAILED', this.#initialFocusPosition)
		} else {
			return this.#makeAbsoluteStep('COMPLETED', determinedFocusPoint.x)
		}
	}

	// Rejects non-finite, non-positive, out-of-range, or low-quality fitted focus positions.
	#validateCalculatedFocusPosition(focusPoint: Readonly<Point>) {
		const minimum = this.minimum
		const maximum = this.maximum

		if (!minimum || !maximum || !Number.isFinite(focusPoint.x) || !Number.isFinite(focusPoint.y) || focusPoint.y <= 0) {
			console.warn('determined focus point is not finite and positive')
			return false
		}

		if (focusPoint.x < minimum.x || focusPoint.x > maximum.x) {
			console.warn('determined focus point position is outside of the overall measurement points of the curve')
			return false
		}

		const { rmsdThreshold = 0 } = this.options

		if (rmsdThreshold > 0) {
			const isRegressionBad = (regression: Regression) => regressionScore(regression).rmsd / focusPoint.y > rmsdThreshold

			const { trendLine, parabolic, hyperbolic } = this.#curves
			let isBad = false

			switch (this.#fittingMode) {
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

	// Returns the current trend-line regression.
	get trendLine() {
		return this.#curves.trendLine
	}

	// Returns the current parabolic regression.
	get parabolic() {
		return this.#curves.parabolic
	}

	// Returns the current hyperbolic regression.
	get hyperbolic() {
		return this.#curves.hyperbolic
	}

	// Returns the fitted best-focus point for the selected fitting mode.
	get focusPoint() {
		const { trendLine, parabolic, hyperbolic } = this.#curves

		switch (this.#fittingMode) {
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
	#offset = 0
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
						this.#lastDirection = this.#determineMovingDirection(currentPosition, overshoot)
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
