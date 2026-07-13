import type { Rect } from '../../math/numerical/geometry'
import { measureSensorLinearity, type SensorLinearity } from './sensor.linearity'
import { characterizeSensorTemporal, type PhotonTransferPoint, type SensorBias, type SensorGain, type SensorReadNoise } from './sensor.ptc'
import { computeSensorDynamicRange, detectSensorSaturation, type SensorDynamicRange, type SensorSaturation } from './sensor.saturation'
import { DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS, type SensorCharacterizationInput, type SensorCharacterizationOptions, type SensorFrameSet, type SensorOperatingPoint, type SensorPlane } from './sensor.types'

// Public orchestration for one sensor operating point. It validates structural acquisition contracts,
// characterizes each mono/CFA plane independently, and converts recoverable failures into explicit
// diagnostics. Temporal analysis is synchronous, allocation-bounded per level, and never mutates frames.

// Diagnostic severity and stable machine-readable code.
export type SensorDiagnosticCode =
	| 'insufficientBiasFrames'
	| 'insufficientFlatLevels'
	| 'insufficientDarkLevels'
	| 'mixedDimensions'
	| 'mixedCfaPattern'
	| 'unknownCfaOrigin'
	| 'mixedOperatingPoint'
	| 'temperatureDrift'
	| 'unstableIllumination'
	| 'nonMonotonicResponse'
	| 'saturationNotFound'
	| 'poorGainFit'
	| 'practicalPtcNonlinearity'
	| 'ptcModelNotLinear'
	| 'poorLinearityFit'
	| 'negativeCorrectedVariance'
	| 'sourceGradientDetected'
	| 'tooManySaturatedPixels'
	| 'darkCurrentMismatch'
	| 'quantizationCorrectionUnavailable'
	| 'invalidQuantumEfficiency'
	| 'spatialBuffersRequired'
	| 'insufficientValidPixels'

// One acquisition or measurement diagnostic.
export interface SensorDiagnostic {
	// Information, warning, or result-invalidating error.
	readonly severity: 'info' | 'warning' | 'error'
	// Stable programmatic diagnostic code.
	readonly code: SensorDiagnosticCode
	// Human-readable explanation with no parsing contract.
	readonly message: string
	// Affected mono/CFA plane when applicable.
	readonly plane?: SensorPlane
	// Zero-based acquisition level when applicable.
	readonly level?: number
}

// Validated acquisition geometry and dataset counts.
export interface SensorAcquisitionReport {
	// Frame width in output pixels.
	readonly width: number
	// Frame height in output pixels.
	readonly height: number
	// Inclusive-exclusive measurement ROI.
	readonly roi: Readonly<Rect>
	// Number of supplied bias frames.
	readonly biasFrames: number
	// Number of supplied flat levels.
	readonly flatLevels: number
	// Number of supplied dark levels.
	readonly darkLevels: number
	// Minimum and maximum recorded temperatures, degrees Celsius.
	readonly temperatures: Readonly<[number, number]> | undefined
}

// Temporal characterization for one mono or CFA plane.
export interface SensorPlaneCharacterization {
	// Plane represented by this result.
	readonly plane: SensorPlane
	// Bias pedestal and drift.
	readonly bias: SensorBias
	// Conversion/system gain when the PTC fit is valid.
	readonly gain?: SensorGain
	// Temporal read noise in DN and optionally electrons.
	readonly readNoise: SensorReadNoise
	// Observable output saturation capacity.
	readonly saturation?: SensorSaturation
	// Practical and EMVA dynamic-range definitions.
	readonly dynamicRange?: SensorDynamicRange
	// Relative or photon-calibrated response linearity.
	readonly linearity?: SensorLinearity
	// Dark-corrected photon-transfer points.
	readonly photonTransfer: readonly PhotonTransferPoint[]
	// DN per incident photon when radiometrically calibrated.
	readonly responsivity?: number
	// Electrons per incident photon when physically valid.
	readonly quantumEfficiency?: number
}

// Complete characterization of one operating point.
export interface SensorCharacterization {
	// Camera configuration represented by the result.
	readonly operatingPoint: SensorOperatingPoint
	// Independent mono or CFA-plane results.
	readonly planes: readonly SensorPlaneCharacterization[]
	// Validated acquisition geometry and counts.
	readonly acquisition: SensorAcquisitionReport
	// Explicit limitations, warnings, and errors.
	readonly diagnostics: readonly SensorDiagnostic[]
}

// Returns all frame sets used by structural validation.
function frameSets(input: SensorCharacterizationInput): readonly SensorFrameSet[] {
	const sets: SensorFrameSet[] = [input.bias]
	for (const flat of input.flats) {
		sets.push(flat)
		if (flat.darkFrames) sets.push({ ...flat, frames: flat.darkFrames })
	}
	if (input.darks) for (const dark of input.darks) sets.push(dark)
	if (input.spatial) sets.push(input.spatial.dark, input.spatial.flat)
	return sets
}

// Resolves and validates the inclusive-exclusive analysis ROI.
function resolveArea(area: Readonly<Rect> | undefined, width: number, height: number): Readonly<Rect> {
	const roi = area ?? { left: 0, top: 0, right: width, bottom: height }
	if (!Number.isInteger(roi.left) || !Number.isInteger(roi.top) || !Number.isInteger(roi.right) || !Number.isInteger(roi.bottom) || roi.left < 0 || roi.top < 0 || roi.right > width || roi.bottom > height || roi.left >= roi.right || roi.top >= roi.bottom) {
		throw new RangeError('sensor characterization area must be a non-empty inclusive-exclusive integer rectangle')
	}
	return roi
}

// Collects the finite temperature span declared by frame sets and their operating points.
function temperatureRange(sets: readonly SensorFrameSet[]): Readonly<[number, number]> | undefined {
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	for (const set of sets) {
		const temperature = set.temperature ?? set.operatingPoint?.temperature
		if (temperature !== undefined && Number.isFinite(temperature)) {
			minimum = Math.min(minimum, temperature)
			maximum = Math.max(maximum, temperature)
		}
	}
	return minimum <= maximum ? [minimum, maximum] : undefined
}

// Reports whether supplied operating-point fields contradict expected fields.
function operatingPointDiffers(expected: SensorOperatingPoint, actual: SensorOperatingPoint): boolean {
	const scalarKeys = ['gain', 'offset', 'temperature', 'readoutMode', 'bitDepth', 'camera'] as const
	for (const key of scalarKeys) if (expected[key] !== undefined && actual[key] !== undefined && expected[key] !== actual[key]) return true
	if (expected.binning && actual.binning && (expected.binning[0] !== actual.binning[0] || expected.binning[1] !== actual.binning[1])) return true
	if (expected.sensorOrigin && actual.sensorOrigin && (expected.sensorOrigin[0] !== actual.sensorOrigin[0] || expected.sensorOrigin[1] !== actual.sensorOrigin[1])) return true
	if (expected.size !== undefined && actual.size !== undefined && (expected.size.width !== actual.size.width || expected.size.height !== actual.size.height)) return true
	return false
}

// Resolves CFA phase from explicit sensor origin or image-local Bayer offset keywords.
function cfaOffset(input: SensorCharacterizationInput): Readonly<[number, number]> | undefined {
	const origin = input.operatingPoint.sensorOrigin
	if (origin && Number.isInteger(origin[0]) && Number.isInteger(origin[1])) return origin
	const header = input.bias.frames[0].header
	const x = header.XBAYROFF
	const y = header.YBAYROFF
	return typeof x === 'number' && typeof y === 'number' && Number.isInteger(x) && Number.isInteger(y) ? [x, y] : undefined
}

// Adds high-level fit and acquisition diagnostics for one plane.
function diagnosePlane(result: SensorPlaneCharacterization, diagnostics: SensorDiagnostic[]): void {
	const plane = result.plane
	if (!result.gain) diagnostics.push({ severity: 'error', code: 'poorGainFit', message: 'Fewer than two valid PTC points or a non-positive gain slope prevented conversion-gain estimation.', plane })
	else {
		if (!Number.isFinite(result.gain.fit.r2) || result.gain.fit.r2 < 0.98) diagnostics.push({ severity: 'warning', code: 'poorGainFit', message: 'The weighted PTC gain fit has r² below 0.98.', plane })
		const fittedSpan = result.gain.system * (result.gain.range[1] - result.gain.range[0])
		if (fittedSpan > 0 && result.gain.fit.rmsd / fittedSpan > 0.03) diagnostics.push({ severity: 'warning', code: 'practicalPtcNonlinearity', message: 'PTC residual RMS exceeds the practical 3% fitted-span threshold; this is not the EMVA spline test.', plane })
	}
	if (!result.saturation) diagnostics.push({ severity: 'warning', code: 'saturationNotFound', message: 'No measured clipping, response compression, variance collapse, plateau, or digital limit established saturation.', plane })
	if (!result.linearity) diagnostics.push({ severity: 'warning', code: 'poorLinearityFit', message: 'Fewer than two compatible positive-stimulus levels were available for linearity.', plane })
	else if (result.linearity.error > 0.01) diagnostics.push({ severity: 'warning', code: 'poorLinearityFit', message: 'Mean absolute relative linearity error exceeds 1%.', plane })
	if (result.readNoise.sensorElectrons === undefined) diagnostics.push({ severity: 'info', code: 'quantizationCorrectionUnavailable', message: 'Electronic read noise could not be separated from quantization.', plane })
	if (result.responsivity !== undefined && result.quantumEfficiency === undefined) diagnostics.push({ severity: 'error', code: 'invalidQuantumEfficiency', message: 'Photon responsivity and system gain imply quantum efficiency outside 0..1.', plane })

	const ordered = [...result.photonTransfer].sort((a, b) => a.level - b.level)
	let maximum = 0
	for (const point of ordered) maximum = Math.max(maximum, point.signal)
	for (let i = 0; i < ordered.length; i++) {
		const point = ordered[i]
		if (point.variance <= 0) diagnostics.push({ severity: 'warning', code: 'negativeCorrectedVariance', message: 'Dark correction produced non-positive temporal variance.', plane, level: point.level })
		if (point.clippedFraction > 0.01) diagnostics.push({ severity: 'warning', code: 'tooManySaturatedPixels', message: 'More than 1% of valid samples reached the known digital clip.', plane, level: point.level })
		if (i > 0 && ordered[i - 1].signal - point.signal > maximum * 0.01) diagnostics.push({ severity: 'warning', code: 'nonMonotonicResponse', message: 'Dark-corrected response decreases by more than 1% of the observed range.', plane, level: point.level })
	}
}

// Characterizes all requested planes for a single validated sensor operating point.
export function characterizeSensor(input: SensorCharacterizationInput, options: Partial<SensorCharacterizationOptions> = {}): SensorCharacterization {
	const diagnostics: SensorDiagnostic[] = []
	const sets = frameSets(input)
	const first = input.bias.frames?.[0]
	if (!first || input.bias.frames.length < 2) {
		return {
			operatingPoint: input.operatingPoint,
			planes: [],
			acquisition: { width: 0, height: 0, roi: { left: 0, top: 0, right: 0, bottom: 0 }, biasFrames: input.bias.frames?.length ?? 0, flatLevels: input.flats.length, darkLevels: input.darks?.length ?? 0, temperatures: temperatureRange(sets) },
			diagnostics: [{ severity: 'error', code: 'insufficientBiasFrames', message: 'At least two bias frames are required.' }],
		}
	}

	const { width, height, bayer, channels } = first.metadata
	let roi: Readonly<Rect>
	try {
		roi = resolveArea(options.area, width, height)
	} catch (error) {
		return {
			operatingPoint: input.operatingPoint,
			planes: [],
			acquisition: { width, height, roi: { left: 0, top: 0, right: width, bottom: height }, biasFrames: input.bias.frames.length, flatLevels: input.flats.length, darkLevels: input.darks?.length ?? 0, temperatures: temperatureRange(sets) },
			diagnostics: [{ severity: 'error', code: 'insufficientValidPixels', message: error instanceof Error ? error.message : 'Invalid sensor analysis area.' }],
		}
	}

	let structuralError = false
	for (const set of sets) {
		if (!Number.isFinite(set.exposure) || set.exposure < 0) {
			diagnostics.push({ severity: 'error', code: 'mixedOperatingPoint', message: 'Every frame set exposure must be finite and non-negative.' })
			structuralError = true
		}
		if (set.operatingPoint && operatingPointDiffers(input.operatingPoint, set.operatingPoint)) {
			diagnostics.push({ severity: 'error', code: 'mixedOperatingPoint', message: 'A frame set contradicts the expected sensor operating point.' })
			structuralError = true
		}
		for (const frame of set.frames) {
			if (frame.metadata.width !== width || frame.metadata.height !== height || frame.metadata.channels !== channels) {
				diagnostics.push({ severity: 'error', code: 'mixedDimensions', message: 'All sensor frames must have identical dimensions and channel counts.' })
				structuralError = true
			}
			if (frame.metadata.bayer !== bayer) {
				diagnostics.push({ severity: 'error', code: 'mixedCfaPattern', message: 'All sensor frames must have the same CFA pattern.' })
				structuralError = true
			}
		}
	}

	if (input.flats.length < 9) diagnostics.push({ severity: input.flats.length < 2 ? 'error' : 'warning', code: 'insufficientFlatLevels', message: 'At least nine flat levels are recommended for production gain and linearity fits.' })
	const temperatures = temperatureRange(sets)
	const tolerance = options.temperatureTolerance ?? DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS.temperatureTolerance
	if (temperatures && temperatures[1] - temperatures[0] > tolerance) diagnostics.push({ severity: 'warning', code: 'temperatureDrift', message: `Recorded temperature span exceeds ${tolerance} °C.` })

	const offset = bayer ? cfaOffset(input) : undefined
	if (bayer && (!offset || channels !== 1 || (input.operatingPoint.binning && (input.operatingPoint.binning[0] !== 1 || input.operatingPoint.binning[1] !== 1)))) {
		diagnostics.push({ severity: 'error', code: 'unknownCfaOrigin', message: 'CFA analysis requires an integer sensor origin and unbinned single-channel mosaic.' })
		structuralError = true
	}
	const acquisition: SensorAcquisitionReport = { width, height, roi, biasFrames: input.bias.frames.length, flatLevels: input.flats.length, darkLevels: input.darks?.length ?? 0, temperatures }
	if (structuralError) return { operatingPoint: input.operatingPoint, planes: [], acquisition, diagnostics }

	const planes = options.planes ?? (bayer ? (['red', 'green1', 'green2', 'blue'] as const) : (['mono'] as const))
	const results: SensorPlaneCharacterization[] = []
	for (const plane of planes) {
		try {
			const temporal = characterizeSensorTemporal(input.bias, input.flats, { area: roi, plane, cfaOffset: offset, digitalClip: options.digitalClip, gainRange: options.gainRange })
			const digitalMaximum = options.digitalClip ?? first.digitalRange?.[1]
			const digitalSignalLimit = digitalMaximum !== undefined ? digitalMaximum - temporal.bias.mean : undefined
			const saturation = detectSensorSaturation(temporal.photonTransfer, temporal.gain, digitalSignalLimit)
			const linearityAnalysis = measureSensorLinearity(temporal.photonTransfer, input.flats, saturation, temporal.gain, options.linearityRange)
			const photonTransfer = temporal.photonTransfer.map((point) => ({ ...point, saturationFraction: saturation ? point.signal / saturation.signal : undefined }))
			const result: SensorPlaneCharacterization = {
				plane,
				bias: temporal.bias,
				gain: temporal.gain,
				readNoise: temporal.readNoise,
				saturation,
				dynamicRange: saturation ? computeSensorDynamicRange(saturation, temporal.readNoise) : undefined,
				linearity: linearityAnalysis.linearity,
				photonTransfer,
				responsivity: linearityAnalysis.responsivity,
				quantumEfficiency: linearityAnalysis.quantumEfficiency,
			}
			results.push(result)
			diagnosePlane(result, diagnostics)
		} catch (error) {
			diagnostics.push({ severity: 'error', code: 'insufficientValidPixels', message: error instanceof Error ? error.message : 'Sensor-plane analysis failed.', plane })
		}
	}

	return { operatingPoint: input.operatingPoint, planes: results, acquisition, diagnostics }
}
