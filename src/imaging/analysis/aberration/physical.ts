import { medianBySelectionOf } from '../../../math/numerical/statistics'
import type { FocusPlaneAnalysis, FocusSurfaceCoefficients } from '../../../math/numerical/surface.fit'
import type { Angle } from '../../../math/units/angle'

// Physical conversions and calibrated focus-field corrections for completed aberration scans.

// Consistent physical scales supplied by the caller for optional physical interpretation.
export interface AberrationPhysicalScale {
	// Effective sensor distance per scan pixel in the caller's physical length unit, including binning/subsampling.
	readonly pixelSize?: number
	// Signed focal-plane displacement per focuser-position unit in the same physical length unit; non-zero for tilt.
	readonly focusDisplacement?: number
	// Optical focal ratio for diffraction CFZ calculations.
	readonly focalRatio?: number
	// Reference wavelength in the same physical length unit.
	readonly wavelength?: number
}

// Physical small-angle tilt derived from normalized-sensor focus-plane gradients.
export interface PhysicalTiltAnalysis {
	// Right-handed tilt around the sensor X axis in radians.
	readonly x: number
	// Right-handed tilt around the sensor Y axis in radians.
	readonly y: number
	// Combined plane tilt in radians.
	readonly magnitude: number
}

// Linear best-focus coefficient uncertainty on normalized sensor coordinates, increasing rightward/downward.
export interface FocusGradientUncertainty {
	// Standard uncertainty of the X gradient in focuser-position units per normalized sensor width.
	readonly x: number
	// Standard uncertainty of the Y gradient in focuser-position units per normalized sensor height.
	readonly y: number
	// Covariance of X/Y gradients in squared focuser-position units.
	readonly covarianceXY: number
}

// Physical tilt of the best-focus surface relative to the sensor; does not identify a mechanical cause.
export interface PhysicalSensorTiltEstimate extends PhysicalTiltAnalysis {
	// Standard uncertainty of rotation around sensor X in radians, absent without gradient covariance.
	readonly uncertaintyX?: Angle
	// Standard uncertainty of rotation around sensor Y in radians, absent without gradient covariance.
	readonly uncertaintyY?: Angle
	// Covariance of the X/Y rotations in radians squared, absent without gradient covariance.
	readonly covarianceXY?: number
	// First-order magnitude uncertainty in radians, omitted without covariance or near zero slope.
	readonly uncertaintyMagnitude?: Angle
}

// Principal physical focal-surface curvatures and finite radii under the small-slope approximation.
export interface PhysicalCurvatureAnalysis {
	// Larger principal physical curvature in inverse caller length units.
	readonly principalX: number
	// Smaller principal physical curvature in inverse caller length units.
	readonly principalY: number
	// Reciprocal radius of `principalX`, omitted near zero curvature.
	readonly radiusX?: number
	// Reciprocal radius of `principalY`, omitted near zero curvature.
	readonly radiusY?: number
}

// Center-to-edge best-focus offset measured from supported regional curves.
export interface FocusFieldOffset {
	// Peripheral best focus minus central best focus in focuser-position units.
	readonly centerToEdge: number
	// Robust central estimate in focuser-position units.
	readonly center: number
	// Robust peripheral estimate in focuser-position units.
	readonly edge: number
	// Bounded support confidence.
	readonly confidence: number
}

// Calibrated response of center-to-edge offset to added optical spacing.
export interface BackfocusCalibration {
	// Offset change per physical spacing change.
	readonly response: number
}

// Calibrated spacing correction using the calibration sign convention.
export interface BackfocusCorrection {
	// Physical spacing correction in the calibration unit.
	readonly correction: number
}

// Supported critical-focus-zone conventions.
export type CriticalFocusCriterion = 'diffraction' | 'callerProvided'

// Options for an explicit critical-focus-zone semi-amplitude.
export interface CriticalFocusOptions {
	// Diffraction convention or explicit caller-provided tolerance.
	readonly criterion?: CriticalFocusCriterion
	// Required focal ratio for the diffraction convention.
	readonly focalRatio?: number
	// Required wavelength for the diffraction convention in the caller's physical unit.
	readonly wavelength?: number
	// Required semi-amplitude for the caller-provided convention.
	readonly tolerance?: number
}

// Critical-focus-zone semi-amplitude in the caller's chosen physical unit.
export interface CriticalFocusResult {
	// Permitted displacement on one side of best focus.
	readonly tolerance: number
	// Convention used to calculate the tolerance.
	readonly criterion: CriticalFocusCriterion
}

// Computes physical small-angle tilt from a normalized-sensor focus plane and explicit scale.
export function analyzePhysicalTilt(plane: FocusPlaneAnalysis, width: number, height: number, scale: Required<Pick<AberrationPhysicalScale, 'pixelSize' | 'focusDisplacement'>>): PhysicalTiltAnalysis {
	if (!Number.isInteger(width) || !Number.isInteger(height) || !(width > 1) || !(height > 1) || !(scale.pixelSize > 0) || !Number.isFinite(scale.pixelSize) || !Number.isFinite(scale.focusDisplacement) || scale.focusDisplacement === 0)
		throw new RangeError('finite sensor dimensions, pixel size, and non-zero focus displacement are required')
	const slopeX = (plane.gradientX * scale.focusDisplacement) / ((width - 1) * scale.pixelSize)
	const slopeY = (plane.gradientY * scale.focusDisplacement) / ((height - 1) * scale.pixelSize)
	return { x: Math.atan(slopeY), y: Math.atan(-slopeX), magnitude: Math.atan(Math.hypot(slopeX, slopeY)) }
}

// Converts a scan plane and optional positive-semidefinite gradient covariance into physical angles and standard uncertainties.
// Width/height are pixel counts > 1; physical spans are (count - 1) * effective pixelSize, matching normalized coordinates.
// Scale uses one length unit and signed focus displacement; invalid scale throws as in analyzePhysicalTilt.
// Uses the analytic atan Jacobian with exact calibration; calibration uncertainty is not included. Allocates a fresh result.
// Magnitude uncertainty is omitted for slope norm <= sqrt(machine epsilon), where the direction is numerically unresolved.
export function estimatePhysicalSensorTilt(plane: FocusPlaneAnalysis, width: number, height: number, scale: Required<Pick<AberrationPhysicalScale, 'pixelSize' | 'focusDisplacement'>>, uncertainty?: FocusGradientUncertainty): PhysicalSensorTiltEstimate {
	const physical = analyzePhysicalTilt(plane, width, height, scale)
	if (uncertainty === undefined) return physical
	const factorX = scale.focusDisplacement / ((width - 1) * scale.pixelSize)
	const factorY = scale.focusDisplacement / ((height - 1) * scale.pixelSize)
	const slopeX = plane.gradientX * factorX
	const slopeY = plane.gradientY * factorY
	const derivativeX = factorY / (1 + slopeY * slopeY)
	const derivativeY = -factorX / (1 + slopeX * slopeX)
	const magnitude = Math.hypot(slopeX, slopeY)
	let uncertaintyMagnitude: Angle | undefined
	if (magnitude > Math.sqrt(Number.EPSILON)) {
		const derivativeAX = ((slopeX / magnitude) * factorX) / (1 + magnitude * magnitude)
		const derivativeAY = ((slopeY / magnitude) * factorY) / (1 + magnitude * magnitude)
		const variance = (derivativeAX * uncertainty.x) ** 2 + (derivativeAY * uncertainty.y) ** 2 + 2 * derivativeAX * derivativeAY * uncertainty.covarianceXY
		uncertaintyMagnitude = Math.sqrt(Math.max(0, variance))
	}
	return {
		...physical,
		uncertaintyX: Math.abs(derivativeX) * uncertainty.y,
		uncertaintyY: Math.abs(derivativeY) * uncertainty.x,
		covarianceXY: derivativeX * derivativeY * uncertainty.covarianceXY,
		uncertaintyMagnitude,
	}
}

// Converts normalized quadratic coefficients into physical principal curvatures and approximate radii.
export function analyzePhysicalCurvature(surface: FocusSurfaceCoefficients, width: number, height: number, scale: Required<Pick<AberrationPhysicalScale, 'pixelSize' | 'focusDisplacement'>>): PhysicalCurvatureAnalysis {
	if (!Number.isInteger(width) || !Number.isInteger(height) || !(width > 1) || !(height > 1) || !(scale.pixelSize > 0) || !Number.isFinite(scale.pixelSize) || !Number.isFinite(scale.focusDisplacement) || scale.focusDisplacement === 0)
		throw new RangeError('finite sensor dimensions, pixel size, and non-zero focus displacement are required')
	if (!finiteSurface(surface)) throw new RangeError('focus surface coefficients must be finite')
	const sensorWidth = (width - 1) * scale.pixelSize
	const sensorHeight = (height - 1) * scale.pixelSize
	const hxx = (2 * surface.qxx * scale.focusDisplacement) / (sensorWidth * sensorWidth)
	const hxy = (surface.qxy * scale.focusDisplacement) / (sensorWidth * sensorHeight)
	const hyy = (2 * surface.qyy * scale.focusDisplacement) / (sensorHeight * sensorHeight)
	const mean = 0.5 * (hxx + hyy)
	const spread = Math.hypot(0.5 * (hxx - hyy), hxy)
	const principalX = mean + spread
	const principalY = mean - spread
	const threshold = Number.EPSILON * Math.max(1, Math.abs(principalX), Math.abs(principalY))
	return { principalX, principalY, radiusX: Math.abs(principalX) > threshold ? 1 / principalX : undefined, radiusY: Math.abs(principalY) > threshold ? 1 / principalY : undefined }
}

// Estimates center-to-edge focus offset from finite best-focus samples and normalized radii.
export function measureFocusFieldOffset(samples: readonly { readonly u: number; readonly v: number; readonly bestFocus?: number; readonly confidence: number }[]): FocusFieldOffset | undefined {
	const center: number[] = []
	const edge: number[] = []
	let confidence = 0
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		if (sample.bestFocus === undefined || !Number.isFinite(sample.bestFocus)) continue
		const radius = Math.hypot(sample.u, sample.v)
		if (radius <= 0.2) center.push(sample.bestFocus)
		else if (radius >= 0.45) edge.push(sample.bestFocus)
		else continue
		if (Number.isFinite(sample.confidence)) confidence += Math.max(0, Math.min(1, sample.confidence))
	}
	if (center.length === 0 || edge.length === 0) return undefined
	const centerValue = medianBySelectionOf(center)
	const edgeValue = medianBySelectionOf(edge)
	return { centerToEdge: edgeValue - centerValue, center: centerValue, edge: edgeValue, confidence: Math.min(1, confidence / samples.length) }
}

// Tests whether all common focus-surface coefficients are finite before physical conversion.
function finiteSurface(surface: FocusSurfaceCoefficients): boolean {
	return Number.isFinite(surface.c) && Number.isFinite(surface.ax) && Number.isFinite(surface.ay) && Number.isFinite(surface.qxx) && Number.isFinite(surface.qxy) && Number.isFinite(surface.qyy)
}

// Converts a measured field offset into a calibrated spacing correction.
export function estimateBackfocusCorrection(offset: FocusFieldOffset, calibration: BackfocusCalibration): BackfocusCorrection {
	if (!Number.isFinite(offset.centerToEdge) || !Number.isFinite(calibration.response) || calibration.response === 0) throw new RangeError('finite non-zero calibration response is required')
	return { correction: -offset.centerToEdge / calibration.response }
}

// Returns the documented critical-focus-zone semi-amplitude in one consistent physical unit.
export function criticalFocusZone(options: CriticalFocusOptions): CriticalFocusResult {
	const criterion = options.criterion ?? 'diffraction'
	if (criterion === 'callerProvided') {
		const tolerance = options.tolerance
		if (!(tolerance !== undefined && tolerance > 0) || !Number.isFinite(tolerance)) throw new RangeError('a finite positive caller-provided tolerance is required')
		return { tolerance, criterion }
	}
	const focalRatio = options.focalRatio
	const wavelength = options.wavelength
	if (!(focalRatio !== undefined && focalRatio > 0) || !(wavelength !== undefined && wavelength > 0) || !Number.isFinite(focalRatio) || !Number.isFinite(wavelength)) throw new RangeError('finite positive focal ratio and wavelength are required')
	return { tolerance: wavelength * focalRatio * focalRatio, criterion }
}
