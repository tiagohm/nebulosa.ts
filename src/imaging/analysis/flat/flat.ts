import { exposureTimeKeyword } from '../../../io/formats/fits/util'
import type { Rect } from '../../../math/numerical/geometry'
import type { DigitalImage } from '../../model/types'
import { resolveAnalysisArea, resolveImageAnalysisPlanes, resolveLocalCfaPattern, validateDigitalImageLayout } from '../plane'
import { analyzeFlatSpatial } from './spatial'
import { measureFlatRegion, resolveFlatClippingLimits, type FlatRegionMeasurement } from './statistics'
import type { FlatAnalysis, FlatAnalysisInput, FlatAnalysisOptions, FlatAssessment, FlatCheck, FlatClipping, FlatDiagnostic, FlatDiagnosticCode, FlatFrame, FlatImageContext, FlatPlane, FlatPlaneAnalysis, FlatReference, FlatSampleStatistics, FlatTarget } from './types'

// Single-frame digital flat analysis facade. It measures target levels, clipping, optional in-line
// pedestal correction, robust spatial structure, and transparent configured checks. Full-resolution
// selected-plane maps are allocated only when explicitly requested.

// Absolute exposure tolerance used in addition to the relative dark-flat match tolerance, seconds.
const FLAT_REFERENCE_EXPOSURE_ABSOLUTE_TOLERANCE = 1e-9

// Relative exposure tolerance for matching a dark-flat master to its flat.
const FLAT_REFERENCE_EXPOSURE_RELATIVE_TOLERANCE = 1e-6

// Every physical plane accepted by the flat-analysis contracts.
const FLAT_PLANES: ReadonlySet<FlatPlane> = new Set(['mono', 'red', 'green', 'green1', 'green2', 'blue'])

// Operating-point fields resolved from explicit metadata first and FITS headers second.
interface ResolvedAcquisitionMetadata {
	// Camera gain setting in device-native units.
	readonly gain?: number
	// Camera offset setting in device-native units.
	readonly offset?: number
	// Camera-specific readout-mode identifier.
	readonly readoutMode?: string
	// Horizontal and vertical hardware binning factors.
	readonly binning?: readonly [number, number]
	// Sensor-space ROI origin in unbinned pixels.
	readonly sensorOrigin?: readonly [number, number]
	// Camera identifier.
	readonly camera?: string
	// Effective ADC or output bit depth.
	readonly bitDepth?: number
}

// Fully resolved and validated single-frame analysis context.
interface ResolvedFlatAnalysisInput {
	// Inclusive-exclusive full analysis area.
	readonly area: Readonly<Rect>
	// Inclusive-exclusive signal and target area.
	readonly targetArea: Readonly<Rect>
	// Physical planes in caller-requested or canonical order.
	readonly planes: readonly FlatPlane[]
	// Explicit or FITS-derived CFA offset for the flat image.
	readonly cfaOffset?: readonly [number, number]
	// Explicit or FITS-derived CFA offset for the optional reference.
	readonly referenceCfaOffset?: readonly [number, number]
	// Whether missing reference metadata prevents complete compatibility proof.
	readonly referenceMetadataUnknown: boolean
}

// Analyzes one already captured digital flat without mutating input images or caller buffers.
export function analyzeFlat(input: FlatAnalysisInput, options: Partial<FlatAnalysisOptions> = {}): FlatAnalysis {
	const resolved = resolveFlatAnalysisInput(input, options)
	const image = input.frame.image
	const reference = input.reference?.image
	const clippingLimits = resolveFlatClippingLimits(image, options.effectiveClip)
	const diagnostics: FlatDiagnostic[] = []
	const planeAnalyses: FlatPlaneAnalysis[] = []
	const fullMeasurements: FlatRegionMeasurement[] = []

	if (!reference) diagnostics.push({ severity: 'info', code: 'pedestalNotRemoved', message: 'No bias or dark-flat reference was supplied; signal and spatial measurements retain the observed pedestal.' })
	if (resolved.referenceMetadataUnknown) diagnostics.push({ severity: 'warning', code: 'referenceMetadataUnknown', message: 'Known reference metadata is compatible, but missing acquisition fields prevent a complete compatibility proof.' })
	if (!options.criteria?.targets || Object.keys(options.criteria.targets).length === 0) diagnostics.push({ severity: 'info', code: 'targetUnavailable', message: 'No per-plane target interval was configured.' })
	if (clippingLimits.lower?.source !== 'effective' || clippingLimits.upper?.source !== 'effective') diagnostics.push({ severity: 'warning', code: 'effectiveClipUnknown', message: 'At least one effective clipping limit is unknown; storage-range absence cannot prove the sensor is unclipped.' })

	for (const plane of resolved.planes) {
		const targetMeasurement = measureFlatRegion({
			image,
			cfaOffset: resolved.cfaOffset,
			reference,
			referenceCfaOffset: resolved.referenceCfaOffset,
			mask: input.mask,
			area: resolved.targetArea,
			plane,
			clippingLimits,
		})
		const fullMeasurement = sameRect(resolved.area, resolved.targetArea)
			? targetMeasurement
			: measureFlatRegion({
					image,
					cfaOffset: resolved.cfaOffset,
					reference,
					referenceCfaOffset: resolved.referenceCfaOffset,
					mask: input.mask,
					area: resolved.area,
					plane,
					clippingLimits,
				})
		fullMeasurements.push(fullMeasurement)

		const target = evaluateTarget(options.criteria?.targets?.[plane], targetMeasurement.observed, targetMeasurement.corrected)
		appendPlaneDiagnostics(diagnostics, plane, targetMeasurement, fullMeasurement, target, options.criteria?.targets?.[plane])
		const spatial = analyzeFlatSpatial({
			image,
			cfaOffset: resolved.cfaOffset,
			reference,
			referenceCfaOffset: resolved.referenceCfaOffset,
			mask: input.mask,
			area: resolved.area,
			plane,
			options,
			clippingLimits,
			fullMeasurement,
		})
		diagnostics.push(...spatial.diagnostics)
		planeAnalyses.push({
			plane,
			observed: targetMeasurement.observed,
			corrected: targetMeasurement.corrected,
			clipping: fullMeasurement.clipping,
			target,
			spatial: spatial.analysis,
		})
	}

	const assessment = assessFlat(planeAnalyses, fullMeasurements, options)
	return {
		frameId: input.frame.id,
		area: resolved.area,
		targetArea: resolved.targetArea,
		planes: planeAnalyses,
		assessment: { ...assessment, reasons: assessmentReasons(assessment, diagnostics, options) },
		diagnostics,
	}
}

// Resolves and validates layout, regions, plane selection, options, mask, and optional reference.
function resolveFlatAnalysisInput(input: FlatAnalysisInput, options: Partial<FlatAnalysisOptions>): ResolvedFlatAnalysisInput {
	const image = input.frame.image
	validateDigitalImageLayout(image)
	validateFlatFrameMetadata(input.frame)
	if (input.mask !== undefined && input.mask.length !== image.metadata.pixelCount) throw new RangeError('flat mask length must equal the image pixel count')

	const area = resolveAnalysisArea(options.area, image.metadata.width, image.metadata.height)
	const targetArea = resolveAnalysisArea(options.targetArea ?? area, image.metadata.width, image.metadata.height)
	if (targetArea.left < area.left || targetArea.top < area.top || targetArea.right > area.right || targetArea.bottom > area.bottom) throw new RangeError('flat target area must be contained inside the analysis area')

	validateFlatOptions(options, image.digitalRange)
	const supported = resolveImageAnalysisPlanes(image) as readonly FlatPlane[]
	const planes = options.planes ? Array.from(options.planes) : Array.from(supported)
	if (planes.length === 0) throw new RangeError('flat analysis requires at least one plane')
	const unique = new Set<FlatPlane>()
	for (const plane of planes) {
		if (!supported.includes(plane)) throw new RangeError(`flat plane ${plane} is incompatible with the image layout`)
		if (unique.has(plane)) throw new RangeError(`flat plane ${plane} is duplicated`)
		unique.add(plane)
	}
	validateTargets(options, unique)

	const cfaOffset = resolveContextCfaOffset(input.frame)
	resolveLocalCfaPattern(image, cfaOffset)
	let referenceCfaOffset: readonly [number, number] | undefined
	let referenceMetadataUnknown = false
	if (input.reference) {
		referenceCfaOffset = resolveContextCfaOffset(input.reference)
		referenceMetadataUnknown = validateFlatReference(input.frame, cfaOffset, input.reference, referenceCfaOffset)
	}

	return { area, targetArea, planes, cfaOffset, referenceCfaOffset, referenceMetadataUnknown }
}

// Validates option values whose nonsensical combinations would otherwise yield plausible results.
function validateFlatOptions(options: Partial<FlatAnalysisOptions>, storageRange: readonly [number, number] | undefined): void {
	if (options.rejectionSigma !== undefined && (!Number.isFinite(options.rejectionSigma) || options.rejectionSigma <= 0)) throw new RangeError('flat rejection sigma must be finite and positive')
	if (options.maps !== undefined && options.maps !== 'none' && options.maps !== 'illumination' && options.maps !== 'residual' && options.maps !== 'all') throw new RangeError('unsupported flat map selection')
	if (options.tile && (!Number.isInteger(options.tile.width) || options.tile.width <= 0 || !Number.isInteger(options.tile.height) || options.tile.height <= 0)) throw new RangeError('flat tile dimensions must be positive integers')

	const effective = options.effectiveClip
	if (effective) {
		if (effective.lower === undefined && effective.upper === undefined) throw new RangeError('effective clipping limits must contain at least one side')
		if (effective.lower !== undefined && !Number.isFinite(effective.lower)) throw new RangeError('effective lower clipping limit must be finite')
		if (effective.upper !== undefined && !Number.isFinite(effective.upper)) throw new RangeError('effective upper clipping limit must be finite')
		if (effective.lower !== undefined && effective.upper !== undefined && effective.lower >= effective.upper) throw new RangeError('effective clipping limits must be ordered')
		if (storageRange && effective.lower !== undefined && (effective.lower < storageRange[0] || effective.lower >= storageRange[1])) throw new RangeError('effective lower clipping limit must lie inside the storage range')
		if (storageRange && effective.upper !== undefined && (effective.upper <= storageRange[0] || effective.upper > storageRange[1])) throw new RangeError('effective upper clipping limit must lie inside the storage range')
	}

	for (const [name, value] of [
		['maximum clipped fraction', options.criteria?.maximumClippedFraction],
		['maximum non-finite fraction', options.criteria?.maximumNonFiniteFraction],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new RangeError(`${name} must be finite and in [0, 1]`)
	}
}

// Validates configured targets and prevents silent targets for unselected or physically absent planes.
function validateTargets(options: Partial<FlatAnalysisOptions>, selected: ReadonlySet<FlatPlane>): void {
	if (!options.criteria?.targets) return
	for (const [key, target] of Object.entries(options.criteria.targets)) {
		if (!FLAT_PLANES.has(key as FlatPlane) || !selected.has(key as FlatPlane)) throw new RangeError(`flat target plane ${key} is not selected by this analysis`)
		if (!target || (target.levelMode !== 'observed' && target.levelMode !== 'corrected')) throw new RangeError(`flat target for ${key} must select observed or corrected levels`)
		const [minimum, maximum] = target.range
		if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) throw new RangeError(`flat target range for ${key} must contain ordered finite levels`)
		if (target.levelMode === 'observed') {
			if (options.effectiveClip?.lower !== undefined && minimum <= options.effectiveClip.lower) throw new RangeError(`flat observed target for ${key} must remain above the effective lower clip`)
			if (options.effectiveClip?.upper !== undefined && maximum >= options.effectiveClip.upper) throw new RangeError(`flat observed target for ${key} must remain below the effective upper clip`)
		}
	}
}

// Validates explicit frame metadata used by reference and later sequence comparisons.
function validateFlatFrameMetadata(frame: FlatFrame): void {
	if (frame.exposure !== undefined && (!Number.isFinite(frame.exposure) || frame.exposure <= 0)) throw new RangeError('flat exposure must be finite and positive')
	if (frame.timestamp !== undefined && !Number.isFinite(frame.timestamp)) throw new RangeError('flat timestamp must be finite Unix milliseconds')
	if (frame.illumination?.brightness !== undefined && !Number.isFinite(frame.illumination.brightness)) throw new RangeError('flat illumination brightness must be finite')
	resolveAcquisitionMetadata(frame)
}

// Validates a reference against geometry, local CFA phase, affine DN scale, acquisition, and exposure.
function validateFlatReference(frame: FlatFrame, frameCfaOffset: readonly [number, number] | undefined, reference: FlatReference, referenceCfaOffset: readonly [number, number] | undefined): boolean {
	if (reference.kind !== 'bias' && reference.kind !== 'darkFlat') throw new TypeError('flat reference kind must be bias or darkFlat')
	validateDigitalImageLayout(reference.image)
	const image = frame.image
	const master = reference.image
	if (master.metadata.width !== image.metadata.width || master.metadata.height !== image.metadata.height || master.metadata.channels !== image.metadata.channels) throw new RangeError('flat reference geometry and channels must match the flat')
	const framePattern = resolveLocalCfaPattern(image, frameCfaOffset)
	const referencePattern = resolveLocalCfaPattern(master, referenceCfaOffset)
	if (framePattern !== referencePattern) throw new RangeError('flat reference local CFA pattern must match the flat')

	let metadataUnknown = hasIncompleteHeaderCfaOffset(frame) || hasIncompleteHeaderCfaOffset(reference)
	if (image.digitalRange && master.digitalRange) {
		if (image.digitalRange[0] !== master.digitalRange[0] || image.digitalRange[1] !== master.digitalRange[1]) throw new RangeError('flat reference digital range must match the flat when both are known')
	} else metadataUnknown = true
	if (image.quantizationStep !== undefined && master.quantizationStep !== undefined) {
		if (image.quantizationStep !== master.quantizationStep) throw new RangeError('flat reference quantization step must match the flat when both are known')
	} else metadataUnknown = true

	const frameMetadata = resolveAcquisitionMetadata(frame)
	const referenceMetadata = resolveAcquisitionMetadata(reference)
	for (const key of ['gain', 'offset', 'readoutMode', 'binning'] as const) {
		const flatValue = frameMetadata[key]
		const referenceValue = referenceMetadata[key]
		if (flatValue === undefined || referenceValue === undefined) metadataUnknown = true
		else if (!sameMetadataValue(flatValue, referenceValue)) throw new RangeError(`flat reference ${key} must match the flat`)
	}
	for (const key of ['sensorOrigin', 'camera', 'bitDepth'] as const) {
		const flatValue = frameMetadata[key]
		const referenceValue = referenceMetadata[key]
		if (flatValue !== undefined && referenceValue !== undefined && !sameMetadataValue(flatValue, referenceValue)) throw new RangeError(`flat reference ${key} must match the flat when both are known`)
	}

	if (reference.kind === 'darkFlat') {
		if (!Number.isFinite(reference.exposure) || reference.exposure <= 0) throw new RangeError('dark-flat reference exposure must be finite and positive')
		const flatExposure = resolveFrameExposure(frame)
		if (flatExposure === undefined) throw new RangeError('dark-flat subtraction requires a resolved flat exposure')
		const tolerance = Math.max(FLAT_REFERENCE_EXPOSURE_ABSOLUTE_TOLERANCE, Math.max(flatExposure, reference.exposure) * FLAT_REFERENCE_EXPOSURE_RELATIVE_TOLERANCE)
		if (Math.abs(flatExposure - reference.exposure) > tolerance) throw new RangeError('dark-flat reference exposure must match the flat without scaling')
	}

	return metadataUnknown
}

// Resolves explicit acquisition metadata first and then known FITS keywords, validating explicit fields.
function resolveAcquisitionMetadata(context: FlatImageContext): ResolvedAcquisitionMetadata {
	const point = context.operatingPoint
	const header = context.image.header
	if (point?.gain !== undefined && !Number.isFinite(point.gain)) throw new RangeError('flat operating-point gain must be finite')
	if (point?.offset !== undefined && !Number.isFinite(point.offset)) throw new RangeError('flat operating-point offset must be finite')
	if (point?.bitDepth !== undefined && (!Number.isInteger(point.bitDepth) || point.bitDepth <= 0)) throw new RangeError('flat operating-point bit depth must be a positive integer')
	if (point?.temperature !== undefined && !Number.isFinite(point.temperature)) throw new RangeError('flat operating-point temperature must be finite')
	if (point?.binning && (!Number.isInteger(point.binning[0]) || point.binning[0] <= 0 || !Number.isInteger(point.binning[1]) || point.binning[1] <= 0)) throw new RangeError('flat operating-point binning must contain positive integers')
	if (point?.sensorOrigin && (!Number.isInteger(point.sensorOrigin[0]) || point.sensorOrigin[0] < 0 || !Number.isInteger(point.sensorOrigin[1]) || point.sensorOrigin[1] < 0)) throw new RangeError('flat operating-point sensor origin must contain non-negative integers')
	if (point?.size && (!Number.isInteger(point.size.width) || point.size.width <= 0 || !Number.isInteger(point.size.height) || point.size.height <= 0 || point.size.width !== context.image.metadata.width || point.size.height !== context.image.metadata.height))
		throw new RangeError('flat operating-point size must match the image dimensions')

	return {
		gain: point?.gain ?? finiteHeaderNumber(header.GAIN),
		offset: point?.offset ?? finiteHeaderNumber(header.OFFSET),
		readoutMode: point?.readoutMode ?? headerString(header.READOUTM),
		binning: point?.binning ?? headerIntegerPair(header.XBINNING, header.YBINNING, true),
		sensorOrigin: point?.sensorOrigin ?? headerIntegerPair(header.XORGSUBF, header.YORGSUBF, false),
		camera: point?.camera,
		bitDepth: point?.bitDepth,
	}
}

// Resolves a caller-provided CFA offset or a complete integer XBAYROFF/YBAYROFF header pair.
function resolveContextCfaOffset(context: FlatImageContext): readonly [number, number] | undefined {
	if (context.cfaOffset !== undefined) return context.cfaOffset
	return headerIntegerPair(context.image.header.XBAYROFF, context.image.header.YBAYROFF, false)
}

// Reports incomplete or malformed FITS Bayer-offset metadata that cannot prove local phase.
function hasIncompleteHeaderCfaOffset(context: FlatImageContext): boolean {
	if (context.cfaOffset !== undefined || context.image.metadata.bayer === undefined) return false
	const x = context.image.header.XBAYROFF
	const y = context.image.header.YBAYROFF
	return (x !== undefined || y !== undefined) && headerIntegerPair(x, y, false) === undefined
}

// Resolves explicit or FITS exposure metadata, returning undefined when neither is finite and positive.
function resolveFrameExposure(frame: FlatFrame): number | undefined {
	const exposure = frame.exposure ?? exposureTimeKeyword(frame.image.header, undefined)
	return exposure !== undefined && Number.isFinite(exposure) && exposure > 0 ? exposure : undefined
}

// Narrows one FITS value to a finite scalar number.
function finiteHeaderNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Narrows one FITS value to a non-empty string.
function headerString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Resolves a complete integer FITS pair, optionally requiring both values to be positive.
function headerIntegerPair(first: unknown, second: unknown, positive: boolean): readonly [number, number] | undefined {
	if (typeof first !== 'number' || typeof second !== 'number' || !Number.isInteger(first) || !Number.isInteger(second)) return undefined
	if (positive ? first <= 0 || second <= 0 : first < 0 || second < 0) return undefined
	return [first, second]
}

// Compares scalar or two-element acquisition metadata without coercion.
function sameMetadataValue(first: number | string | readonly [number, number], second: number | string | readonly [number, number]): boolean {
	return Array.isArray(first) && Array.isArray(second) ? first[0] === second[0] && first[1] === second[1] : first === second
}

// Evaluates one configured target against the robust median on its requested basis.
function evaluateTarget(target: FlatTarget | undefined, observed: FlatSampleStatistics, corrected: FlatSampleStatistics | undefined): FlatCheck {
	if (!target) return { status: 'unknown' }
	const statistics = target.levelMode === 'observed' ? observed : corrected
	const value = statistics?.median
	if (value === undefined) return { status: 'unknown', basis: target.levelMode, limits: target.range }
	return {
		status: value < target.range[0] || value > target.range[1] ? 'fail' : 'pass',
		basis: target.levelMode,
		value,
		limits: target.range,
	}
}

// Adds per-plane data-quality, clipping, and target diagnostics without changing policy implicitly.
function appendPlaneDiagnostics(diagnostics: FlatDiagnostic[], plane: FlatPlane, targetMeasurement: FlatRegionMeasurement, fullMeasurement: FlatRegionMeasurement, targetCheck: FlatCheck, target: FlatTarget | undefined): void {
	const full = fullMeasurement.observed
	const denominator = full.count + full.nonFinite
	if (full.nonFinite > 0 && denominator > 0) diagnostics.push({ severity: 'warning', code: 'nonFiniteSamples', message: 'Non-finite observed samples were excluded from flat reductions.', plane, value: full.nonFinite / denominator })
	if (targetMeasurement.observed.count === 0) diagnostics.push({ severity: 'error', code: 'insufficientSamples', message: 'No finite, non-masked target-area samples were available for this plane.', plane })

	for (const side of [fullMeasurement.clipping.lower, fullMeasurement.clipping.upper]) {
		if (side?.status !== 'present') continue
		diagnostics.push({
			severity: 'warning',
			code: side.source === 'effective' ? 'effectiveClipping' : 'storageClipping',
			message: side.source === 'effective' ? 'Observed samples touch or cross an effective clipping limit.' : 'Observed samples touch or cross a representable storage endpoint.',
			plane,
			value: side.fraction,
			limit: side.limit,
		})
	}

	if (!target) return
	if (targetCheck.status === 'unknown') diagnostics.push({ severity: 'warning', code: 'targetUnavailable', message: target.levelMode === 'corrected' && !targetMeasurement.corrected ? 'The corrected target cannot be evaluated without a reference.' : 'The configured target has no finite robust level.', plane })
	else if (targetCheck.status === 'fail') {
		const below = targetCheck.value! < target.range[0]
		diagnostics.push({
			severity: 'warning',
			code: below ? 'targetBelowRange' : 'targetAboveRange',
			message: below ? 'The robust plane level is below its configured target interval.' : 'The robust plane level is above its configured target interval.',
			plane,
			value: targetCheck.value,
			limit: below ? target.range[0] : target.range[1],
		})
	}
}

// Derives aggregate target, clipping, finite-sample checks, and the transparent verdict.
function assessFlat(planes: readonly FlatPlaneAnalysis[], fullMeasurements: readonly FlatRegionMeasurement[], options: Partial<FlatAnalysisOptions>): FlatAssessment {
	const configuredTargets = planes.filter((plane) => options.criteria?.targets?.[plane.plane] !== undefined).map((plane) => plane.target)
	const target = aggregateChecks(configuredTargets)
	const clipping = assessClipping(
		planes.flatMap((plane, index) => [fullMeasurements[index].clipping, ...plane.spatial.tiles.map((tile) => tile.clipping)]),
		options.criteria?.maximumClippedFraction,
	)
	const finiteSamples = assessFiniteSamples(
		planes.flatMap((plane, index) => [fullMeasurements[index].observed, ...plane.spatial.tiles.map((tile) => tile.observed)]),
		options.criteria?.maximumNonFiniteFraction,
	)
	const required: FlatCheck[] = []
	if (configuredTargets.length > 0) required.push(target)
	if (options.criteria?.maximumClippedFraction !== undefined) required.push(clipping)
	if (options.criteria?.maximumNonFiniteFraction !== undefined) required.push(finiteSamples)
	const verdict = required.some((check) => check.status === 'fail') ? 'rejected' : required.length === 0 || required.some((check) => check.status === 'unknown') ? 'inconclusive' : 'accepted'
	return { verdict, target, clipping, finiteSamples, reasons: [] }
}

// Aggregates checks without allowing an unknown plane to pass or one failing plane to be hidden.
function aggregateChecks(checks: readonly FlatCheck[]): FlatCheck {
	if (checks.length === 0) return { status: 'unknown' }
	const status = checks.some((check) => check.status === 'fail') ? 'fail' : checks.every((check) => check.status === 'pass') ? 'pass' : 'unknown'
	const firstBasis = checks[0].basis
	return checks.every((check) => check.basis === firstBasis) ? { status, basis: firstBasis } : { status }
}

// Evaluates the worst observed clipping fraction while requiring effective evidence for a passing check.
function assessClipping(clipping: readonly FlatClipping[], maximum: number | undefined): FlatCheck {
	if (maximum === undefined) return { status: 'unknown' }
	let worst = 0
	let effectiveEvidence = false
	for (const measurement of clipping) {
		for (const side of [measurement.lower, measurement.upper]) {
			if (!side) continue
			if (side.fraction > worst) worst = side.fraction
			if (side.source === 'effective' && side.status !== 'unknown') effectiveEvidence = true
		}
	}
	return { status: worst > maximum ? 'fail' : effectiveEvidence ? 'pass' : 'unknown', value: worst, limits: [0, maximum] }
}

// Evaluates the worst non-finite fraction and preserves unknown support for wholly masked planes.
function assessFiniteSamples(statistics: readonly FlatSampleStatistics[], maximum: number | undefined): FlatCheck {
	if (maximum === undefined) return { status: 'unknown' }
	let worst = 0
	let unsupported = false
	for (const summary of statistics) {
		const denominator = summary.count + summary.nonFinite
		if (summary.count === 0) unsupported = true
		if (denominator > 0) worst = Math.max(worst, summary.nonFinite / denominator)
	}
	return { status: worst > maximum ? 'fail' : unsupported ? 'unknown' : 'pass', value: worst, limits: [0, maximum] }
}

// Selects unique diagnostic codes that explain failed or unknown required checks.
function assessmentReasons(assessment: FlatAssessment, diagnostics: readonly FlatDiagnostic[], options: Partial<FlatAnalysisOptions>): FlatDiagnosticCode[] {
	const relevant = new Set<FlatDiagnosticCode>()
	for (const diagnostic of diagnostics) {
		if (options.criteria?.targets && assessment.target.status !== 'pass' && (diagnostic.code === 'targetUnavailable' || diagnostic.code === 'targetBelowRange' || diagnostic.code === 'targetAboveRange' || diagnostic.code === 'insufficientSamples')) relevant.add(diagnostic.code)
		if (options.criteria?.maximumClippedFraction !== undefined && assessment.clipping.status !== 'pass' && (diagnostic.code === 'effectiveClipUnknown' || diagnostic.code === 'effectiveClipping' || diagnostic.code === 'storageClipping')) relevant.add(diagnostic.code)
		if (options.criteria?.maximumNonFiniteFraction !== undefined && assessment.finiteSamples.status !== 'pass' && (diagnostic.code === 'nonFiniteSamples' || diagnostic.code === 'insufficientSamples')) relevant.add(diagnostic.code)
	}
	return Array.from(relevant)
}

// Reports exact equality for two validated inclusive-exclusive rectangles.
function sameRect(first: Readonly<Rect>, second: Readonly<Rect>): boolean {
	return first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom
}
