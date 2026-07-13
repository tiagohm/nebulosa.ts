import type { Rect } from '../../math/numerical/geometry'
import type { DigitalImage } from '../model/types'
import type { SensorFrameSet, SensorPlane } from './sensor.types'

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
	const roi = area ?? { left: 0, top: 0, right: width, bottom: height }
	if (!Number.isInteger(roi.left) || !Number.isInteger(roi.top) || !Number.isInteger(roi.right) || !Number.isInteger(roi.bottom) || roi.left < 0 || roi.top < 0 || roi.right > width || roi.bottom > height || roi.left >= roi.right || roi.top >= roi.bottom)
		throw new RangeError('spatial sensor area must be a non-empty inclusive-exclusive integer rectangle')
	return roi
}

// Returns the selected row-major CFA slot, or -1 for a mono image.
function sensorPlaneSlot(pattern: string | undefined, plane: SensorPlane | undefined): number {
	if (!pattern) {
		if (plane !== undefined && plane !== 'mono') throw new RangeError('non-CFA spatial analysis supports only the mono plane')
		return -1
	}
	if (plane === undefined || plane === 'mono') throw new RangeError('CFA spatial analysis requires an explicit color plane')
	const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
	const slot = plane === 'green2' ? pattern.indexOf(channel, pattern.indexOf(channel) + 1) : pattern.indexOf(channel)
	if (slot < 0) throw new RangeError(`sensor plane ${plane} is absent from CFA pattern ${pattern}`)
	return slot
}

// Maps an image ROI to the dense mono or CFA-plane grid used by spatial measurements.
export function resolveSensorPlaneGeometry(image: DigitalImage, area: Readonly<Rect>, plane: SensorPlane | undefined, cfaOffset: Readonly<[number, number]> | undefined): SensorPlaneGeometry {
	const slot = sensorPlaneSlot(image.metadata.bayer, plane)
	if (slot < 0) return { sourceLeft: area.left, sourceTop: area.top, step: 1, width: area.right - area.left, height: area.bottom - area.top }
	const offsetX = cfaOffset?.[0]
	const offsetY = cfaOffset?.[1]
	if (!Number.isInteger(offsetX) || !Number.isInteger(offsetY)) throw new RangeError('CFA spatial analysis requires an integer sensor origin')
	const xParity = slot & 1
	const yParity = slot >>> 1
	let sourceLeft = area.left
	let sourceTop = area.top
	if (((sourceLeft + offsetX!) & 1) !== xParity) sourceLeft++
	if (((sourceTop + offsetY!) & 1) !== yParity) sourceTop++
	const width = sourceLeft < area.right ? Math.floor((area.right - 1 - sourceLeft) / 2) + 1 : 0
	const height = sourceTop < area.bottom ? Math.floor((area.bottom - 1 - sourceTop) / 2) + 1 : 0
	if (width <= 0 || height <= 0) throw new RangeError('selected CFA plane has no samples inside the spatial ROI')
	return { sourceLeft, sourceTop, step: 2, width, height }
}

// Validates a digital mono stack against reference dimensions and CFA metadata.
export function validateSensorSpatialStack(set: SensorFrameSet, reference: DigitalImage): void {
	if (set.frames.length < 2) throw new RangeError('spatial stack requires at least two frames')
	for (const frame of set.frames) {
		if (frame.sampleScale !== 'digital') throw new TypeError('spatial analysis requires digital images')
		if (frame.metadata.width !== reference.metadata.width || frame.metadata.height !== reference.metadata.height || frame.metadata.channels !== 1 || frame.metadata.bayer !== reference.metadata.bayer) throw new RangeError('spatial stack frames must share dimensions and CFA pattern')
		if (frame.raw.length < frame.metadata.pixelCount) throw new RangeError('spatial frame buffer is smaller than declared geometry')
	}
}
