import { evaluateFocusSurface, type FocusPlaneAnalysis, type FocusSurfaceCoefficients } from '../../math/numerical/surface.fit'

// Physical conversions and calibrated focus-field corrections for completed aberration scans.

// Consistent physical scales supplied by the caller for optional physical interpretation.
export interface AberrationPhysicalScale {
	// Sensor distance per pixel in the caller's physical length unit.
	readonly pixelSize?: number
	// Effective focal-plane displacement per focuser-position unit in the same physical length unit.
	readonly focusDisplacement?: number
	// Optical focal ratio for diffraction CFZ calculations.
	readonly focalRatio?: number
	// Reference wavelength in the same physical length unit.
	readonly wavelength?: number
}

// Physical small-angle tilt derived from normalized-sensor focus-plane gradients.
export interface PhysicalTiltAnalysis {
	// Tilt around the sensor X axis in radians.
	readonly x: number
	// Tilt around the sensor Y axis in radians.
	readonly y: number
	// Combined plane tilt in radians.
	readonly magnitude: number
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
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 1 || height <= 1 || !(scale.pixelSize > 0) || !Number.isFinite(scale.pixelSize) || !Number.isFinite(scale.focusDisplacement) || scale.focusDisplacement === 0)
		throw new RangeError('finite sensor dimensions, pixel size, and non-zero focus displacement are required')
	const slopeX = (plane.gradientX * scale.focusDisplacement) / ((width - 1) * scale.pixelSize)
	const slopeY = (plane.gradientY * scale.focusDisplacement) / ((height - 1) * scale.pixelSize)
	return { x: Math.atan(slopeX), y: Math.atan(slopeY), magnitude: Math.atan(Math.hypot(slopeX, slopeY)) }
}

// Converts normalized quadratic coefficients into physical principal curvatures and approximate radii.
export function analyzePhysicalCurvature(surface: FocusSurfaceCoefficients, width: number, height: number, scale: Required<Pick<AberrationPhysicalScale, 'pixelSize' | 'focusDisplacement'>>): PhysicalCurvatureAnalysis {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 1 || height <= 1 || !(scale.pixelSize > 0) || !Number.isFinite(scale.pixelSize) || !Number.isFinite(scale.focusDisplacement) || scale.focusDisplacement === 0)
		throw new RangeError('finite sensor dimensions, pixel size, and non-zero focus displacement are required')
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
		confidence += sample.confidence
	}
	if (center.length === 0 || edge.length === 0) return undefined
	const centerValue = median(center)
	const edgeValue = median(edge)
	return { centerToEdge: edgeValue - centerValue, center: centerValue, edge: edgeValue, confidence: Math.min(1, confidence / samples.length) }
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

// Evaluates all interior and boundary extremum candidates over the normalized sensor rectangle.
export function focusSurfaceEffect(surface: FocusSurfaceCoefficients): number {
	const candidates: { readonly u: number; readonly v: number }[] = [
		{ u: 0, v: 0 },
		{ u: -0.5, v: -0.5 },
		{ u: 0.5, v: -0.5 },
		{ u: -0.5, v: 0.5 },
		{ u: 0.5, v: 0.5 },
	]
	for (const u of [-0.5, 0.5]) addBoundaryCandidate(candidates, u, -(surface.ay + surface.qxy * u) / (2 * surface.qyy))
	for (const v of [-0.5, 0.5]) addBoundaryCandidate(candidates, -(surface.ax + surface.qxy * v) / (2 * surface.qxx), v)
	const determinant = 4 * surface.qxx * surface.qyy - surface.qxy * surface.qxy
	if (Math.abs(determinant) > Number.EPSILON) {
		const u = (-2 * surface.qyy * surface.ax + surface.qxy * surface.ay) / determinant
		const v = (surface.qxy * surface.ax - 2 * surface.qxx * surface.ay) / determinant
		addBoundaryCandidate(candidates, u, v)
	}
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	for (let i = 0; i < candidates.length; i++) {
		const value = evaluateFocusSurface(surface, candidates[i].u, candidates[i].v)
		minimum = Math.min(minimum, value)
		maximum = Math.max(maximum, value)
	}
	return maximum - minimum
}

// Adds a finite extremum candidate only when it lies on or inside the normalized sensor.
function addBoundaryCandidate(candidates: { u: number; v: number }[], u: number, v: number): void {
	if (Number.isFinite(u) && Number.isFinite(v) && u >= -0.5 && u <= 0.5 && v >= -0.5 && v <= 0.5) candidates.push({ u, v })
}

// Returns a finite sample median without mutating caller-owned data.
function median(values: readonly number[]): number {
	const sorted = Float64Array.from(values)
	sorted.sort()
	const middle = sorted.length >>> 1
	return sorted.length % 2 === 0 ? 0.5 * (sorted[middle - 1] + sorted[middle]) : sorted[middle]
}
