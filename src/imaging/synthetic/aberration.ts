import { PIOVERTWO } from '../../core/constants'
import { clamp } from '../../math/numerical/math'
import type { Angle } from '../../math/units/angle'

// Phenomenological optical-aberration model for synthetic camera images. Coordinates and blur sizes
// are expressed in unbinned sensor pixels; focus values are focuser steps. The evaluator writes into
// a caller-owned result so a frame can process large star catalogs without per-star allocations.

// Converts a Gaussian half-flux diameter to sigma.
const HFD_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2))
// Normalized center-to-corner distance for a centered rectangular sensor.
const SENSOR_CORNER_RADIUS = Math.SQRT1_2
// Maximum minor-to-major distortion exposed to the renderer.
const MAX_ELLIPTICITY = 0.8

// User-facing synthetic aberration parameters before frame-level values are resolved.
export interface SyntheticAberrationConfig {
	// Enables evaluation; disabled evaluation produces a neutral result.
	readonly enabled: boolean
	// Enables the sensor-fixed best-focus plane gradient.
	readonly sensorTiltEnabled: boolean
	// Enables radial displacement of the best-focus surface.
	readonly fieldCurvatureEnabled: boolean
	// Enables radial or tangential blur attributed to backfocus error.
	readonly backfocusEnabled: boolean
	// Enables the asymmetric radial coma component.
	readonly comaEnabled: boolean
	// Enables the radial or tangential astigmatic blur approximation.
	readonly astigmatismEnabled: boolean
	// Enables an off-center optical axis for radial effects.
	readonly decenterEnabled: boolean
	// Enables the field-uniform coma vector attributed to collimation.
	readonly collimationEnabled: boolean
	// Optical-axis X offset normalized to the sensor width, normally -0.5..0.5.
	readonly decenterX: number
	// Optical-axis Y offset normalized to the sensor height, normally -0.5..0.5.
	readonly decenterY: number
	// Focuser steps corresponding to a normalized defocus of one.
	readonly focusRange: number
	// Best-focus change from the sensor center to the tilt direction edge, in focuser steps.
	readonly tilt: number
	// Tilt direction in image coordinates, radians clockwise because sensor Y grows downward.
	readonly tiltAngle: Angle
	// Best-focus change from the optical axis to a centered sensor corner, in focuser steps.
	readonly curvature: number
	// Signed backfocus strength; the sign selects radial or tangential elongation.
	readonly backfocus: number
	// Additional Gaussian HFD at unit backfocus and corner radius, in unbinned pixels.
	readonly backfocusBlur: number
	// Maximum backfocus ellipticity at unit backfocus and corner radius, 0..0.8.
	readonly backfocusEllipticity: number
	// Radial coma strength at the centered sensor corner, 0..1.
	readonly coma: number
	// Signed astigmatism strength; the sign rotates the major axis by PI/2.
	readonly astigmatism: number
	// Additional astigmatic Gaussian HFD at unit strength and corner radius, in unbinned pixels.
	readonly astigmatismBlur: number
	// Astigmatism orientation offset from the local radial direction, radians.
	readonly astigmatismAngle: Angle
	// Field-uniform coma strength attributed to collimation, 0..1.
	readonly collimation: number
	// Collimation coma direction in image coordinates, radians clockwise.
	readonly collimationAngle: Angle
}

// Frame-level aberration context with switches, bounds, and trigonometry precomputed.
export interface ResolvedSyntheticAberration {
	// Whether any aberration contribution is active.
	readonly enabled: boolean
	// Whether a local best-focus surface overrides the renderer's global focus model.
	readonly focusEnabled: boolean
	// Normalized optical-axis X coordinate.
	readonly decenterX: number
	// Normalized optical-axis Y coordinate.
	readonly decenterY: number
	// Positive focus normalization range, in focuser steps.
	readonly focusRange: number
	// Signed tilt best-focus change, in focuser steps.
	readonly tilt: number
	// Cosine of the sensor tilt direction.
	readonly tiltCos: number
	// Sine of the sensor tilt direction.
	readonly tiltSin: number
	// Signed curvature best-focus change, in focuser steps.
	readonly curvature: number
	// Signed backfocus strength.
	readonly backfocus: number
	// Backfocus Gaussian HFD scale, in unbinned pixels.
	readonly backfocusBlur: number
	// Backfocus ellipticity scale, 0..0.8.
	readonly backfocusEllipticity: number
	// Radial coma strength, 0..1.
	readonly coma: number
	// Signed astigmatism strength.
	readonly astigmatism: number
	// Astigmatism Gaussian HFD scale, in unbinned pixels.
	readonly astigmatismBlur: number
	// Astigmatism orientation offset, radians.
	readonly astigmatismAngle: Angle
	// Collimation coma X component.
	readonly collimationX: number
	// Collimation coma Y component.
	readonly collimationY: number
}

// Per-star aberration in unbinned sensor coordinates.
export interface SyntheticStarAberration {
	// Normalized local defocus, clamped to 0..1.
	defocus: number
	// Local best-focus displacement from the global best focus, in focuser steps.
	focusOffset: number
	// Additive Gaussian covariance xx component, in unbinned pixel squared.
	covarianceXX: number
	// Additive Gaussian covariance xy component, in unbinned pixel squared.
	covarianceXY: number
	// Additive Gaussian covariance yy component, in unbinned pixel squared.
	covarianceYY: number
	// Normalized asymmetric coma strength, 0..1.
	coma: number
	// Coma direction in image coordinates, radians clockwise.
	comaTheta: Angle
}

// Validates and precomputes a synthetic aberration context once per rendered frame.
export function resolveSyntheticAberration(config: SyntheticAberrationConfig): ResolvedSyntheticAberration {
	const tiltAngle = finiteOr(config.tiltAngle, 0)
	const collimationAngle = finiteOr(config.collimationAngle, 0)
	const tilt = config.sensorTiltEnabled ? finiteOr(config.tilt, 0) : 0
	const curvature = config.fieldCurvatureEnabled ? finiteOr(config.curvature, 0) : 0
	const backfocus = config.backfocusEnabled ? clamp(finiteOr(config.backfocus, 0), -1, 1) : 0
	const coma = config.comaEnabled ? clamp(finiteOr(config.coma, 0), 0, 1) : 0
	const astigmatism = config.astigmatismEnabled ? clamp(finiteOr(config.astigmatism, 0), -MAX_ELLIPTICITY, MAX_ELLIPTICITY) : 0
	const collimation = config.collimationEnabled ? clamp(finiteOr(config.collimation, 0), 0, 1) : 0
	const enabled = config.enabled && (tilt !== 0 || curvature !== 0 || backfocus !== 0 || coma !== 0 || astigmatism !== 0 || collimation !== 0)

	return {
		enabled,
		focusEnabled: config.enabled && (tilt !== 0 || curvature !== 0),
		decenterX: config.decenterEnabled ? clamp(finiteOr(config.decenterX, 0), -0.5, 0.5) : 0,
		decenterY: config.decenterEnabled ? clamp(finiteOr(config.decenterY, 0), -0.5, 0.5) : 0,
		focusRange: Math.max(1, Math.abs(finiteOr(config.focusRange, 1))),
		tilt: enabled ? tilt : 0,
		tiltCos: Math.cos(tiltAngle),
		tiltSin: Math.sin(tiltAngle),
		curvature: enabled ? curvature : 0,
		backfocus: enabled ? backfocus : 0,
		backfocusBlur: Math.max(0, finiteOr(config.backfocusBlur, 0)),
		backfocusEllipticity: clamp(finiteOr(config.backfocusEllipticity, 0), 0, MAX_ELLIPTICITY),
		coma: enabled ? coma : 0,
		astigmatism: enabled ? astigmatism : 0,
		astigmatismBlur: Math.max(0, finiteOr(config.astigmatismBlur, 0)),
		astigmatismAngle: finiteOr(config.astigmatismAngle, 0),
		collimationX: enabled ? collimation * Math.cos(collimationAngle) : 0,
		collimationY: enabled ? collimation * Math.sin(collimationAngle) : 0,
	}
}

// Evaluates focus, symmetric covariance, and asymmetric coma for one sensor position.
// x/y are unbinned full-sensor pixel coordinates. The returned value aliases out.
export function evaluateSyntheticAberration(x: number, y: number, width: number, height: number, currentFocus: number, bestFocus: number, config: ResolvedSyntheticAberration, out: SyntheticStarAberration): SyntheticStarAberration {
	out.defocus = 0
	out.focusOffset = 0
	out.covarianceXX = 0
	out.covarianceXY = 0
	out.covarianceYY = 0
	out.coma = 0
	out.comaTheta = 0
	if (!config.enabled) return out

	const u = width > 1 ? clamp(x / (width - 1) - 0.5, -0.5, 0.5) : 0
	const v = height > 1 ? clamp(y / (height - 1) - 0.5, -0.5, 0.5) : 0
	const dx = u - config.decenterX
	const dy = v - config.decenterY
	const radius = Math.hypot(dx, dy)
	const rho = clamp(radius / SENSOR_CORNER_RADIUS, 0, 1.5)
	const rho2 = rho * rho
	const phi = radius > 1e-12 ? Math.atan2(dy, dx) : 0
	const tiltPosition = 2 * (u * config.tiltCos + v * config.tiltSin)
	const focusOffset = config.tilt * tiltPosition + config.curvature * rho2
	const focusError = (finiteOr(currentFocus, bestFocus) - (finiteOr(bestFocus, 0) + focusOffset)) / config.focusRange

	out.focusOffset = focusOffset
	out.defocus = clamp(Math.abs(focusError), 0, 1)

	const backfocusAmount = config.backfocus * rho2
	if (backfocusAmount !== 0 && config.backfocusBlur > 0) {
		const theta = phi + (backfocusAmount < 0 ? PIOVERTWO : 0)
		addEllipticalCovariance(out, Math.abs(backfocusAmount) * config.backfocusBlur, Math.abs(backfocusAmount) * config.backfocusEllipticity, theta)
	}

	const astigmatismAmount = config.astigmatism * rho2
	if (astigmatismAmount !== 0 && config.astigmatismBlur > 0) {
		const theta = phi + config.astigmatismAngle + (astigmatismAmount < 0 ? PIOVERTWO : 0)
		addEllipticalCovariance(out, Math.abs(astigmatismAmount) * config.astigmatismBlur, Math.abs(astigmatismAmount), theta)
	}

	const radialComa = config.coma * rho * Math.sqrt(rho)
	const comaX = radialComa * Math.cos(phi) + config.collimationX
	const comaY = radialComa * Math.sin(phi) + config.collimationY
	out.coma = clamp(Math.hypot(comaX, comaY), 0, 1)
	out.comaTheta = out.coma > 1e-6 ? Math.atan2(comaY, comaX) : 0
	return out
}

// Adds an area-preserving elliptical Gaussian blur kernel to an output covariance.
function addEllipticalCovariance(out: SyntheticStarAberration, hfd: number, ellipticity: number, theta: Angle) {
	const sigma = Math.max(0, hfd) * HFD_TO_SIGMA
	const axisRatio = 1 - clamp(ellipticity, 0, MAX_ELLIPTICITY)
	const majorVariance = (sigma * sigma) / axisRatio
	const minorVariance = sigma * sigma * axisRatio
	const cosTheta = Math.cos(theta)
	const sinTheta = Math.sin(theta)
	const cosSquared = cosTheta * cosTheta
	const sinSquared = sinTheta * sinTheta
	const covariance = (majorVariance - minorVariance) * cosTheta * sinTheta

	out.covarianceXX += majorVariance * cosSquared + minorVariance * sinSquared
	out.covarianceXY += covariance
	out.covarianceYY += majorVariance * sinSquared + minorVariance * cosSquared
}

// Returns value when finite, otherwise fallback.
function finiteOr(value: number, fallback: number) {
	return Number.isFinite(value) ? value : fallback
}
