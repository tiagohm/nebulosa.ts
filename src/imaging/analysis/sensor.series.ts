import type { SensorCharacterization } from './sensor.characterization'
import type { SensorOperatingPoint, SensorPlane } from './sensor.types'

// Comparison of characterized operating points and conservative interpolation of the configured
// camera setting where measured system gain reaches one DN per electron.

// Operating-point bracket and interpolated configured gain for unity system gain.
export interface SensorOperatingPointEstimate {
	// Interpolated device gain setting where system gain is one DN per electron.
	readonly configuredGain: number
	// Lower configured-gain endpoint; equals upper for an exact measured point.
	readonly lower: SensorOperatingPoint
	// Upper configured-gain endpoint; equals lower for an exact measured point.
	readonly upper: SensorOperatingPoint
}

// Stable diagnostic codes for series compatibility and interpolation limitations.
export type SensorSeriesDiagnosticCode = 'insufficientProfiles' | 'incompatibleProfiles' | 'invalidConfiguredGain' | 'ambiguousPlane' | 'missingPlaneGain' | 'nonMonotonicGainSeries' | 'regimeChangeDetected' | 'unityGainNotBracketed'

// One diagnostic explaining why series comparison or unity interpolation was limited.
export interface SensorSeriesDiagnostic {
	// Severity of the limitation.
	readonly severity: 'warning' | 'error'
	// Stable programmatic diagnostic code.
	readonly code: SensorSeriesDiagnosticCode
	// Human-readable explanation with no parsing contract.
	readonly message: string
}

// Compatible profiles sorted by configured gain, with an optional conservative unity estimate.
export interface SensorProfileSeries {
	// Characterizations sorted by finite configured gain when possible.
	readonly profiles: readonly SensorCharacterization[]
	// Unity-gain interpolation only when compatible monotonic points bracket one DN per electron.
	readonly unityGain?: SensorOperatingPointEstimate
	// Explicit compatibility and interpolation limitations.
	readonly diagnostics: readonly SensorSeriesDiagnostic[]
}

// Options controlling plane selection and compatibility/regime tolerances.
export interface SensorSeriesOptions {
	// Mono or CFA plane whose measured system-gain curve is compared.
	readonly plane?: SensorPlane
	// Maximum temperature difference considered compatible, degrees Celsius.
	readonly temperatureTolerance?: number
	// Maximum adjacent slope ratio allowed across the interpolation interval.
	readonly regimeSlopeRatio?: number
}

// Compares optional scalar settings exactly, treating two absent values as compatible.
function sameScalar<T>(first: T | undefined, second: T | undefined): boolean {
	return first === second
}

// Compares optional two-element numeric tuples exactly.
function samePair(first: readonly [number, number] | undefined, second: readonly [number, number] | undefined): boolean {
	return first === undefined ? second === undefined : second !== undefined && first[0] === second[0] && first[1] === second[1]
}

// Compares optional ROI sizes exactly.
function sameSize(first: SensorOperatingPoint['size'], second: SensorOperatingPoint['size']): boolean {
	return first === undefined ? second === undefined : second !== undefined && first.width === second.width && first.height === second.height
}

// Reports whether two operating points differ in any acquisition field other than configured gain.
function compatibleOperatingPoints(first: SensorOperatingPoint, second: SensorOperatingPoint): boolean {
	return (
		sameScalar(first.camera, second.camera) &&
		sameScalar(first.offset, second.offset) &&
		(first.temperature === undefined) === (second.temperature === undefined) &&
		sameScalar(first.readoutMode, second.readoutMode) &&
		sameScalar(first.bitDepth, second.bitDepth) &&
		samePair(first.binning, second.binning) &&
		samePair(first.sensorOrigin, second.sensorOrigin) &&
		sameSize(first.size, second.size)
	)
}

// Resolves an unambiguous plane shared by every profile.
function resolveSeriesPlane(profiles: readonly SensorCharacterization[], requested: SensorPlane | undefined): SensorPlane | undefined {
	if (requested !== undefined) return requested
	if (profiles.length === 0) return undefined
	if (profiles.every((profile) => profile.planes.some((plane) => plane.plane === 'mono'))) return 'mono'
	if (profiles[0].planes.length !== 1) return undefined
	const plane = profiles[0].planes[0].plane
	return profiles.every((profile) => profile.planes.length === 1 && profile.planes[0].plane === plane) ? plane : undefined
}

// Returns the measured system gain for one plane when finite and positive.
function systemGain(profile: SensorCharacterization, plane: SensorPlane): number | undefined {
	const value = profile.planes.find((candidate) => candidate.plane === plane)?.gain?.system
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

// Reports a slope discontinuity adjacent to the proposed crossing interval.
function crossesRegime(gains: readonly number[], systems: readonly number[], interval: number, maximumRatio: number): boolean {
	const crossingSlope = Math.abs((systems[interval + 1] - systems[interval]) / (gains[interval + 1] - gains[interval]))
	for (const neighbor of [interval - 1, interval + 1]) {
		if (neighbor < 0 || neighbor >= gains.length - 1) continue
		const neighborSlope = Math.abs((systems[neighbor + 1] - systems[neighbor]) / (gains[neighbor + 1] - gains[neighbor]))
		const smaller = Math.min(crossingSlope, neighborSlope)
		const larger = Math.max(crossingSlope, neighborSlope)
		if (smaller === 0 || larger / smaller > maximumRatio) return true
	}
	return false
}

// Builds a compatible gain series and interpolates unity gain only inside one monotonic regime.
export function characterizeSensorSeries(profiles: readonly SensorCharacterization[], options: Partial<SensorSeriesOptions> = {}): SensorProfileSeries {
	const diagnostics: SensorSeriesDiagnostic[] = []
	if (profiles.length === 0) return { profiles: [], diagnostics: [{ severity: 'error', code: 'insufficientProfiles', message: 'At least one characterized operating point is required.' }] }
	const temperatureTolerance = options.temperatureTolerance ?? 0.5
	const regimeSlopeRatio = options.regimeSlopeRatio ?? 5
	if (!Number.isFinite(temperatureTolerance) || temperatureTolerance < 0) throw new RangeError('series temperature tolerance must be finite and non-negative')
	if (!Number.isFinite(regimeSlopeRatio) || regimeSlopeRatio <= 1) throw new RangeError('series regime slope ratio must be finite and greater than one')
	const gains = profiles.map((profile) => profile.operatingPoint.gain)
	if (gains.some((gain) => gain === undefined || !Number.isFinite(gain))) {
		diagnostics.push({ severity: 'error', code: 'invalidConfiguredGain', message: 'Every series profile requires a finite configured gain.' })
		return { profiles: [...profiles], diagnostics }
	}
	const ordered = profiles.toSorted((first, second) => first.operatingPoint.gain! - second.operatingPoint.gain!)
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i - 1].operatingPoint.gain === ordered[i].operatingPoint.gain) {
			diagnostics.push({ severity: 'error', code: 'invalidConfiguredGain', message: 'Configured gain values must be unique to define an ordered curve.' })
			return { profiles: ordered, diagnostics }
		}
	}
	const reference = ordered[0].operatingPoint
	let minimumTemperature = Number.POSITIVE_INFINITY
	let maximumTemperature = Number.NEGATIVE_INFINITY
	for (const profile of ordered) {
		const temperature = profile.operatingPoint.temperature
		if (temperature !== undefined) {
			minimumTemperature = Math.min(minimumTemperature, temperature)
			maximumTemperature = Math.max(maximumTemperature, temperature)
		}
	}
	const temperatureCompatible = minimumTemperature === Number.POSITIVE_INFINITY || (Number.isFinite(minimumTemperature) && Number.isFinite(maximumTemperature) && maximumTemperature - minimumTemperature <= temperatureTolerance)
	if (!temperatureCompatible || ordered.some((profile) => !compatibleOperatingPoints(reference, profile.operatingPoint))) {
		diagnostics.push({ severity: 'error', code: 'incompatibleProfiles', message: 'Profiles differ in camera, offset, temperature, readout mode, bit depth, binning, or ROI.' })
		return { profiles: ordered, diagnostics }
	}
	const plane = resolveSeriesPlane(ordered, options.plane)
	if (plane === undefined) {
		diagnostics.push({ severity: 'error', code: 'ambiguousPlane', message: 'A common mono plane or explicit CFA plane is required for gain-series comparison.' })
		return { profiles: ordered, diagnostics }
	}
	const systems = ordered.map((profile) => systemGain(profile, plane))
	if (systems.some((gain) => gain === undefined)) {
		diagnostics.push({ severity: 'error', code: 'missingPlaneGain', message: `Every profile requires a valid measured gain for plane ${plane}.` })
		return { profiles: ordered, diagnostics }
	}
	const configured = ordered.map((profile) => profile.operatingPoint.gain!)
	const measured = systems as number[]
	let direction = 0
	for (let i = 1; i < measured.length; i++) {
		const delta = measured[i] - measured[i - 1]
		if (delta === 0 || (direction !== 0 && Math.sign(delta) !== direction)) {
			diagnostics.push({ severity: 'error', code: 'nonMonotonicGainSeries', message: 'Measured system gain must be strictly monotonic with configured gain.' })
			return { profiles: ordered, diagnostics }
		}
		direction = Math.sign(delta)
	}
	for (let i = 0; i < measured.length; i++) {
		if (measured[i] === 1) return { profiles: ordered, unityGain: { configuredGain: configured[i], lower: ordered[i].operatingPoint, upper: ordered[i].operatingPoint }, diagnostics }
	}
	let interval = -1
	for (let i = 0; i < measured.length - 1; i++) {
		if ((measured[i] < 1 && measured[i + 1] > 1) || (measured[i] > 1 && measured[i + 1] < 1)) {
			interval = i
			break
		}
	}
	if (interval < 0) {
		diagnostics.push({ severity: 'warning', code: 'unityGainNotBracketed', message: 'Measured points do not bracket one DN per electron; unity gain was not extrapolated.' })
		return { profiles: ordered, diagnostics }
	}
	if (crossesRegime(configured, measured, interval, regimeSlopeRatio)) {
		diagnostics.push({ severity: 'warning', code: 'regimeChangeDetected', message: 'Adjacent gain-curve slopes indicate a regime change across the unity bracket.' })
		return { profiles: ordered, diagnostics }
	}
	const fraction = (1 - measured[interval]) / (measured[interval + 1] - measured[interval])
	const configuredGain = configured[interval] + fraction * (configured[interval + 1] - configured[interval])
	return { profiles: ordered, unityGain: { configuredGain, lower: ordered[interval].operatingPoint, upper: ordered[interval + 1].operatingPoint }, diagnostics }
}
