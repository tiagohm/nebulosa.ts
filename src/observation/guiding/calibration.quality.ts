import { DEG2RAD } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { GuidingCalibrationAxisSolution, GuidingCalibrationResult } from './calibrator'

// Quality assessment of a completed guiding calibration, as PHD2's calibration sanity check: findings that a calibration
// is usable but questionable (few steps, short travel, scattered steps, reverse steps, axes far from perpendicular, a large
// DEC backlash, a DEC return that fell short) and an overall grade. A calibrator rejects what it cannot use; these are
// warnings that never forbid using a solution. The assessment reads only the solution and its review, so it works in
// pixels and milliseconds and needs no image scale. Pure; allocates the returned assessment.

// Version of the assessment rules and DEFAULT_GUIDING_CALIBRATION_QUALITY, raised when a rule or a default changes so a
// stored assessment can be told apart from a fresh one.
export const GUIDING_CALIBRATION_QUALITY_VERSION = 1

// Overall grade of a calibration: no finding, only warnings, or at least one critical finding.
export type GuidingCalibrationQuality = 'good' | 'warning' | 'poor'

// Severity of a finding: a warning that the solution may guide less well, or a critical one that it likely guides badly.
export type GuidingCalibrationFindingSeverity = 'warning' | 'critical'

// Kind of a finding.
export type GuidingCalibrationFindingCode = 'fewSteps' | 'shortTravel' | 'highResidual' | 'reverseSteps' | 'orthogonalityError' | 'largeBacklash' | 'decReturnShort'

// One finding with the measured value and the limit it crossed, in the unit the code states.
export interface GuidingCalibrationFinding {
	// Kind of the finding.
	readonly code: GuidingCalibrationFindingCode
	// Its severity.
	readonly severity: GuidingCalibrationFindingSeverity
	// Axis it is about, absent for a finding about both (orthogonality, the DEC return).
	readonly axis?: 'ra' | 'dec'
	// Measured value: steps for fewSteps and reverseSteps, pixels for shortTravel, a fraction of the mean step for highResidual,
	// radians for orthogonalityError, milliseconds for largeBacklash, absent for decReturnShort.
	readonly value?: number
	// The limit the value crossed, in the same unit.
	readonly limit?: number
}

// Assessment of one calibration.
export interface GuidingCalibrationAssessment {
	// Rules version, GUIDING_CALIBRATION_QUALITY_VERSION when assessed.
	readonly version: number
	// Overall grade: poor with any critical finding, warning with only warnings, else good.
	readonly quality: GuidingCalibrationQuality
	// Findings in a fixed order: RA before DEC, then by code.
	readonly findings: readonly GuidingCalibrationFinding[]
}

// Limits of the assessment.
export interface GuidingCalibrationQualityThresholds {
	// Fewest fitted steps per axis below which the fit is a warning (PHD2 asks for about 8); >= 1.
	readonly minSteps: number
	// Shortest fitted travel per axis below which the fit is a warning, in pixels (PHD2 aims at about 25 px); > 0.
	readonly minTravelPx: number
	// RMS of the step displacements across the axis, as a fraction of the mean step along it, above which the fit is a
	// warning; > 0.
	readonly maxResidualFraction: number
	// The same fraction above which the fit is critical; > maxResidualFraction.
	readonly criticalResidualFraction: number
	// Deviation of the measured axes from perpendicular above which the solution is a warning, in radians (PHD2 warns
	// above 10°); > 0.
	readonly maxOrthogonalityError: Angle
	// The same deviation above which it is critical, in radians; > maxOrthogonalityError.
	readonly criticalOrthogonalityError: Angle
	// DEC backlash measured before any DEC motion above which it is a warning, in milliseconds; > 0.
	readonly maxBacklash: number
}

// Default limits, PHD2-like: 4 steps, 15 px, a residual of 30% (critical 60%) of the mean step, 10° (critical 30°) from
// perpendicular, and 3 s of DEC backlash.
export const DEFAULT_GUIDING_CALIBRATION_QUALITY: Readonly<GuidingCalibrationQualityThresholds> = {
	minSteps: 4,
	minTravelPx: 15,
	maxResidualFraction: 0.3,
	criticalResidualFraction: 0.6,
	maxOrthogonalityError: 10 * DEG2RAD,
	criticalOrthogonalityError: 30 * DEG2RAD,
	maxBacklash: 3000,
}

// Assesses a completed calibration against the thresholds. The RA axis and the measured DEC axis (before any orthogonal
// assumption) are judged from their fitted steps; the orthogonality error from the review.
export function assessGuidingCalibration(calibration: GuidingCalibrationResult, thresholds: GuidingCalibrationQualityThresholds = DEFAULT_GUIDING_CALIBRATION_QUALITY): GuidingCalibrationAssessment {
	const findings: GuidingCalibrationFinding[] = []
	const { review } = calibration

	assessAxis('ra', calibration.ra, review.raSamples.length, thresholds, findings)
	assessAxis('dec', review.measuredDec, review.decSamples.length, thresholds, findings)

	if (review.orthogonalityError > thresholds.maxOrthogonalityError) {
		const severity = review.orthogonalityError > thresholds.criticalOrthogonalityError ? 'critical' : 'warning'
		findings.push({ code: 'orthogonalityError', severity, value: review.orthogonalityError, limit: severity === 'critical' ? thresholds.criticalOrthogonalityError : thresholds.maxOrthogonalityError })
	}

	if (calibration.backlash > thresholds.maxBacklash) findings.push({ code: 'largeBacklash', severity: 'warning', axis: 'dec', value: calibration.backlash, limit: thresholds.maxBacklash })
	if (calibration.warnings.includes('dec_return_short')) findings.push({ code: 'decReturnShort', severity: 'warning' })

	const quality = findings.some((finding) => finding.severity === 'critical') ? 'poor' : findings.length > 0 ? 'warning' : 'good'
	return { version: GUIDING_CALIBRATION_QUALITY_VERSION, quality, findings }
}

// Appends the findings about one fitted axis: its step count, its travel, the scatter of its steps across it, and its
// reverse steps.
function assessAxis(axis: 'ra' | 'dec', solution: GuidingCalibrationAxisSolution, steps: number, thresholds: GuidingCalibrationQualityThresholds, findings: GuidingCalibrationFinding[]) {
	if (steps < thresholds.minSteps) findings.push({ code: 'fewSteps', severity: 'warning', axis, value: steps, limit: thresholds.minSteps })
	if (solution.totalTravelPx < thresholds.minTravelPx) findings.push({ code: 'shortTravel', severity: 'warning', axis, value: solution.totalTravelPx, limit: thresholds.minTravelPx })

	const residual = (solution.rmsOrthogonalResidualPx * steps) / solution.totalTravelPx

	if (residual > thresholds.maxResidualFraction) {
		const severity = residual > thresholds.criticalResidualFraction ? 'critical' : 'warning'
		findings.push({ code: 'highResidual', severity, axis, value: residual, limit: severity === 'critical' ? thresholds.criticalResidualFraction : thresholds.maxResidualFraction })
	}

	if (solution.negativeProjectionCount > 0) findings.push({ code: 'reverseSteps', severity: 'warning', axis, value: solution.negativeProjectionCount, limit: 0 })
}
