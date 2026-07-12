import type { FocusPlaneAnalysis, FocusSurfaceCoefficients } from '../../math/numerical/surface.fit'

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
	const x = (plane.gradientX * scale.focusDisplacement) / ((width - 1) * scale.pixelSize)
	const y = (plane.gradientY * scale.focusDisplacement) / ((height - 1) * scale.pixelSize)
	return { x, y, magnitude: Math.atan(Math.hypot(x, y)) }
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

// Evaluates a common surface at four corners and returns its peak-to-peak focus variation.
export function focusSurfaceEffect(surface: FocusSurfaceCoefficients): number {
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	for (const u of [-0.5, 0.5])
		for (const v of [-0.5, 0.5]) {
			const value = surface.c + surface.ax * u + surface.ay * v + surface.qxx * u * u + surface.qxy * u * v + surface.qyy * v * v
			minimum = Math.min(minimum, value)
			maximum = Math.max(maximum, value)
		}
	return maximum - minimum
}

// Returns a finite sample median without mutating caller-owned data.
function median(values: readonly number[]): number {
	const sorted = Float64Array.from(values)
	sorted.sort()
	const middle = sorted.length >>> 1
	return sorted.length % 2 === 0 ? 0.5 * (sorted[middle - 1] + sorted[middle]) : sorted[middle]
}
