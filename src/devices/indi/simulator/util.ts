import { PIOVERTWO } from '../../../core/constants'
import type { ImageRawType } from '../../../imaging/model/types'
import { clamp } from '../../../math/numerical/math'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, type IndiClientHandler } from '../client'
import { type DefNumberVector, type DefSwitchVector, type DefTextVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { CAMERA_MIN_EXPOSURE } from './constants'
import type { SimulatorProperty } from './types'

// Shared property-vector updates and numerical helpers used by the device simulators.

// Emits the def* event for a property, dispatching by type. BLOB vectors are not defined this way.
export function sendDefinition(client: ClientSimulator, handler: IndiClientHandler, property: SimulatorProperty) {
	if (property.type === 'NUMBER') handleDefNumberVector(client, handler, property)
	else if (property.type === 'SWITCH') handleDefSwitchVector(client, handler, property)
	else if (property.type === 'TEXT') handleDefTextVector(client, handler, property)
	// Don't handle DefBlobVector
}

// Applies inbound text element values to a vector, returning whether anything changed.
export function applyTextVectorValues(vector: DefTextVector, elements: Record<string, string>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element) continue
		const next = elements[key]

		if (element.value !== next) {
			element.value = next
			updated = true
		}
	}

	return updated
}

// Applies inbound number element values to a vector, clamping each to its range and ignoring non-finite
// values. Returns whether anything changed.
export function applyNumberVectorValues(vector: DefNumberVector, elements: Record<string, number>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element || !Number.isFinite(elements[key])) continue
		const next = clamp(elements[key], element.min, element.max)

		if (element.value !== next) {
			element.value = next
			updated = true
		}
	}

	return updated
}

// Applies inbound switch values for an exclusive (OneOfMany) vector: turns on the selected member and
// clears the rest. Returns whether anything changed.
export function applyExclusiveSwitchValues(vector: DefSwitchVector, elements: Record<string, boolean>) {
	let updated = false

	for (const key in elements) {
		if (elements[key] === true && key in vector.elements) {
			updated = selectOnSwitch(vector, key) || updated
		}
	}

	return updated
}

// Applies inbound switch values for a non-exclusive vector, setting each member independently. Returns
// whether anything changed.
export function applyMultiSwitchValues(vector: DefSwitchVector, elements: Record<string, boolean>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element || element.value === elements[key]) continue
		element.value = elements[key]
		updated = true
	}

	return updated
}

// Normalizes a rotator angle to [0, 360) degrees.
export function wrapRotatorAngle(value: number) {
	value %= 360
	return value < 0 ? value + 360 : value
}

// Returns the shortest signed angular delta (degrees, in (-180, 180]) from current to target.
export function shortestRotatorDelta(target: number, current: number) {
	let delta = target - current

	if (delta > 180) delta -= 360
	else if (delta < -180) delta += 360

	return delta
}

// Fills a raw image buffer with a deterministic flat-field illumination (gentle vignetting plus a slight
// gradient), scaled by exposure time relative to the reference exposure. `channels` is 1 (mono) or 3 (RGB).
export function fillFlatField(raw: ImageRawType, width: number, height: number, channels: 1 | 3, exposureTime: number, referenceExposureTime: number) {
	const invWidth = width > 1 ? 2 / (width - 1) : 0
	const invHeight = height > 1 ? 2 / (height - 1) : 0
	// Scale the deterministic flat illumination against the simulator reference exposure.
	const exposureScale = exposureTime / Math.max(referenceExposureTime, CAMERA_MIN_EXPOSURE)

	for (let y = 0; y < height; y++) {
		const yc = y * invHeight - 1
		const row = y * width

		for (let x = 0; x < width; x++) {
			const xc = x * invWidth - 1
			const radius2 = xc * xc + yc * yc
			const illumination = clamp(0.72 - radius2 * 0.16 + (xc + yc) * 0.03, 0.15, 0.95) * exposureScale

			if (channels === 1) raw[row + x] = illumination
			else {
				const index = (row + x) * 3
				raw[index] = illumination * 1.02
				raw[index + 1] = illumination
				raw[index + 2] = illumination * 0.98
			}
		}
	}
}

// Clamps a declination to [-π/2, π/2] radians.
export function clampDeclination(value: number) {
	return clamp(value, -PIOVERTWO, PIOVERTWO)
}
