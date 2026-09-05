import type { Rect } from '../../../math/numerical/geometry'
import type { DigitalImage } from '../../model/types'
import { resolveAnalysisArea, resolveImagePlaneGeometry, validateDigitalImageLayout } from '../plane'
import type { SensorFrameSet, SensorPlane } from './types'

// Shared ROI and CFA-plane geometry for spatial sensor measurements. Coordinates use the source
// image origin, while returned dimensions describe the dense selected-plane grid.

// Selected plane-grid geometry mapped back to source image coordinates.
export interface SensorPlaneGeometry {
	// First selected source x coordinate.
	readonly sourceLeft: number
	// First selected source y coordinate.
	readonly sourceTop: number
	// Source-coordinate step between plane samples.
	readonly step: number
	// Plane-grid width.
	readonly width: number
	// Plane-grid height.
	readonly height: number
}

// Resolves and validates an inclusive-exclusive image ROI.
export function resolveSensorArea(area: Readonly<Rect> | undefined, width: number, height: number): Readonly<Rect> {
	return resolveAnalysisArea(area, width, height)
}

// Maps an image ROI to the dense mono or CFA-plane grid used by spatial measurements.
export function resolveSensorPlaneGeometry(image: DigitalImage, area: Readonly<Rect>, plane: SensorPlane | undefined, cfaOffset: readonly [number, number] | undefined): SensorPlaneGeometry {
	return resolveImagePlaneGeometry(image, area, plane ?? 'mono', cfaOffset)
}

// Validates a digital mono stack against reference dimensions and CFA metadata.
export function validateSensorSpatialStack(set: SensorFrameSet, reference: DigitalImage) {
	if (set.frames.length < 2) throw new RangeError('spatial stack requires at least two frames')
	for (const frame of set.frames) {
		validateDigitalImageLayout(frame)
		if (frame.metadata.width !== reference.metadata.width || frame.metadata.height !== reference.metadata.height || frame.metadata.channels !== 1 || frame.metadata.bayer !== reference.metadata.bayer) throw new RangeError('spatial stack frames must share dimensions and CFA pattern')
	}
}
