import type { Point, Rect } from '../../../math/numerical/geometry'
import type { BahtinovAnalysisSuccess, BahtinovLine } from './types'

// Render-independent Bahtinov overlay geometry. The helper maps one successful analysis to fresh
// image-coordinate lines, circles, and anchors without reading pixels or applying display transforms.

// Stable role of one detected diffraction spike in an overlay.
export type BahtinovOverlaySpikeRole = 'central' | 'external0' | 'external1'

// Stable semantic role of one overlay circle.
export type BahtinovOverlayCircleRole = 'focusRegion' | 'reference' | 'centralProjection'

// Visual radii used while deriving image-coordinate overlay primitives.
export interface BahtinovOverlayOptions {
	// Shared radius of the two focus-error circles, in image pixels.
	readonly errorCircleRadius?: number
	// Radius of the focus-region guide, in image pixels.
	readonly focusRegionRadius?: number
}

// One detected spike segment with a stable semantic role.
export interface BahtinovOverlaySpike {
	// Central or deterministic external-line role.
	readonly role: BahtinovOverlaySpikeRole
	// Full-image segment clipped to the analyzed ROI pixel-center domain.
	readonly segment: readonly [Readonly<Point>, Readonly<Point>]
}

// One image-coordinate circle used by the Bahtinov overlay.
export interface BahtinovOverlayCircle {
	// Semantic meaning of the circle center.
	readonly role: BahtinovOverlayCircleRole
	// Circle center in full-image pixel coordinates.
	readonly center: Readonly<Point>
	// Positive radius in image pixels.
	readonly radius: number
}

// Complete render-independent geometry corresponding to the relevant APT Bahtinov Aid overlay.
export interface BahtinovOverlayGeometry {
	// Copied half-open full-image ROI used by the analysis.
	readonly area: Readonly<Rect>
	// Circular guide centered on the external-line intersection.
	readonly focusRegionCircle: BahtinovOverlayCircle
	// Central and two external detected spike segments.
	readonly spikes: readonly [BahtinovOverlaySpike, BahtinovOverlaySpike, BahtinovOverlaySpike]
	// Copied intersection of the two external lines.
	readonly reference: Readonly<Point>
	// Orthogonal projection of `reference` onto the central line.
	readonly centralProjection: Readonly<Point>
	// Directed error segment from the central projection to the external intersection.
	readonly errorSegment: readonly [Readonly<Point>, Readonly<Point>]
	// Equal-radius circles centered on `reference` and `centralProjection`.
	readonly errorCircles: readonly [BahtinovOverlayCircle, BahtinovOverlayCircle]
}

// Derives fresh image-coordinate overlay primitives from one successful analysis.
// Radii are image pixels and never scale the measured error. The result shares no mutable point,
// segment, or ROI object with `analysis`; image and debug buffers are neither read nor copied.
export function createBahtinovOverlayGeometry(analysis: BahtinovAnalysisSuccess, options: BahtinovOverlayOptions = {}): BahtinovOverlayGeometry {
	validateAnalysisGeometry(analysis)

	const area = { left: analysis.area.left, top: analysis.area.top, right: analysis.area.right, bottom: analysis.area.bottom }
	const reference = copyPoint(analysis.reference)
	const normalX = Math.cos(analysis.centralLine.normalAngle)
	const normalY = Math.sin(analysis.centralLine.normalAngle)
	const centralProjection = {
		x: reference.x - analysis.error * normalX,
		y: reference.y - analysis.error * normalY,
	}
	const expectedAbsoluteError = Math.abs(analysis.error)
	const errorConsistencyTolerance = Math.max(1e-9, expectedAbsoluteError * 1e-12)
	if (Math.abs(expectedAbsoluteError - analysis.absoluteError) > errorConsistencyTolerance) throw new RangeError('Bahtinov absoluteError is inconsistent with error')

	const errorCircleRadius = options.errorCircleRadius ?? defaultErrorCircleRadius(analysis.centralLine, analysis.externalLines[0], analysis.externalLines[1])
	validatePositiveRadius(errorCircleRadius, 'errorCircleRadius')

	const width = area.right - area.left
	const height = area.bottom - area.top
	const defaultFocusRegionRadius = Math.min(width - 1, height - 1) * 0.5
	const focusRegionRadius = options.focusRegionRadius ?? defaultFocusRegionRadius
	validatePositiveRadius(focusRegionRadius, 'focusRegionRadius')
	if (focusRegionRadius > Math.hypot(width - 1, height - 1)) throw new RangeError('focusRegionRadius must not exceed the ROI diagonal')

	const referenceCircleCenter = copyPoint(reference)
	const projectionCircleCenter = copyPoint(centralProjection)
	return {
		area,
		focusRegionCircle: {
			role: 'focusRegion',
			center: copyPoint(reference),
			radius: focusRegionRadius,
		},
		spikes: [
			{ role: 'central', segment: copySegment(analysis.centralLine.segment) },
			{ role: 'external0', segment: copySegment(analysis.externalLines[0].segment) },
			{ role: 'external1', segment: copySegment(analysis.externalLines[1].segment) },
		],
		reference,
		centralProjection,
		errorSegment: [copyPoint(centralProjection), copyPoint(reference)],
		errorCircles: [
			{ role: 'reference', center: referenceCircleCenter, radius: errorCircleRadius },
			{ role: 'centralProjection', center: projectionCircleCenter, radius: errorCircleRadius },
		],
	}
}

// Selects a scale-aware visual radius from three finite positive line widths.
function defaultErrorCircleRadius(central: BahtinovLine, externalFirst: BahtinovLine, externalSecond: BahtinovLine): number {
	const first = finitePositiveOrZero(central.fwhm)
	const second = finitePositiveOrZero(externalFirst.fwhm)
	const third = finitePositiveOrZero(externalSecond.fwhm)

	if (first === 0 && second === 0 && third === 0) return 2
	if (first === 0) return Math.max(2, Math.min(second, third))
	if (second === 0) return Math.max(2, Math.min(first, third))
	if (third === 0) return Math.max(2, Math.min(first, second))
	return Math.max(2, first + second + third - Math.min(first, second, third) - Math.max(first, second, third))
}

// Converts an unusable fitted width to the zero sentinel used by the three-value median.
function finitePositiveOrZero(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0
}

// Validates all analysis geometry consumed by the overlay.
function validateAnalysisGeometry(analysis: BahtinovAnalysisSuccess): void {
	const { area } = analysis
	if (!Number.isInteger(area.left) || !Number.isInteger(area.top) || !Number.isInteger(area.right) || !Number.isInteger(area.bottom) || area.right - area.left < 2 || area.bottom - area.top < 2) {
		throw new RangeError('Bahtinov overlay area must contain at least a 2 x 2 pixel-center domain')
	}
	validatePoint(analysis.reference, 'reference')
	validateLine(analysis.centralLine, 'centralLine')
	validateLine(analysis.externalLines[0], 'externalLines[0]')
	validateLine(analysis.externalLines[1], 'externalLines[1]')
	if (!Number.isFinite(analysis.error) || !Number.isFinite(analysis.absoluteError) || analysis.absoluteError < 0) throw new RangeError('Bahtinov focus error must be finite')
}

// Validates one finite line and its finite visible segment.
function validateLine(line: BahtinovLine, name: string): void {
	if (!Number.isFinite(line.normalAngle) || !Number.isFinite(line.distance)) throw new RangeError(`${name} parameters must be finite`)
	validatePoint(line.segment[0], `${name}.segment[0]`)
	validatePoint(line.segment[1], `${name}.segment[1]`)
}

// Validates a finite image-coordinate point.
function validatePoint(point: Readonly<Point>, name: string): void {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError(`${name} must be finite`)
}

// Validates one strictly positive finite visual radius.
function validatePositiveRadius(radius: number, name: string): void {
	if (!Number.isFinite(radius) || radius <= 0) throw new RangeError(`${name} must be finite and positive`)
}

// Copies one image-coordinate point.
function copyPoint(point: Readonly<Point>): Point {
	return { x: point.x, y: point.y }
}

// Copies both endpoints of one image-coordinate segment.
function copySegment(segment: readonly [Readonly<Point>, Readonly<Point>]): readonly [Readonly<Point>, Readonly<Point>] {
	return [copyPoint(segment[0]), copyPoint(segment[1])]
}
