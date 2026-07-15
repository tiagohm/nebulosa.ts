import { PIOVERTWO } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, type IndiClientHandler } from '../client'
import { type DefNumberVector, type DefSwitchVector, type DefTextVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
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

// Clamps a declination to [-π/2, π/2] radians.
export function clampDeclination(value: number) {
	return clamp(value, -PIOVERTWO, PIOVERTWO)
}
