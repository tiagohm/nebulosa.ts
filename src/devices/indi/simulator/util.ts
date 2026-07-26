import { Gnomonic } from '../../../astronomy/projections/projection'
import { PIOVERTWO, TAU } from '../../../core/constants'
import type { Point } from '../../../math/numerical/geometry'
import { clamp } from '../../../math/numerical/math'
import type { Angle } from '../../../math/units/angle'
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

// Displacement, in pixels, that a pointing error introduces in a field rendered around a nominal
// centre.
//
// The synthetic scene is built around the nominal (reported) direction, so moving the optical axis to
// `boresight` moves every star on the sensor by the same amount. That amount is obtained by projecting
// the nominal direction in a gnomonic projection centred on the boresight: the result is where the
// nominal centre now lands relative to the sensor centre, and the field shifts by the negative of it.
//
// Deriving the displacement through the same projection the catalog path uses keeps the sign and the
// cos(declination) factor consistent by construction rather than by hand. A positive displacement of
// the boresight in either right ascension or declination shifts the field towards positive x and y.
//
// This is a rigid translation of the whole field, so it reproduces a true re-projection only to first
// order: the residual is the differential gnomonic distortion between the two centres, below 0.02
// pixels for a 20 pixel boresight offset at 150 pixels off-axis, and it grows with both the field
// radius and the size of the error. That is far below the seeing disc for any realistic pointing
// error, and it buys a stable catalog cache that a moving projection centre would defeat.
//
// All angles are radians and `pixelScale` is radians per pixel. Writes into `o` and returns whether
// any displacement applies; `o` is left untouched when it does not, which happens for a zero error, a
// degenerate pixel scale, or a boresight outside the projection domain.
export function pointingOffsetInPixels(rightAscension: Angle, declination: Angle, boresightRightAscension: Angle, boresightDeclination: Angle, pixelScale: Angle, o: Point) {
	if (!(pixelScale > 0)) return false
	if (boresightRightAscension === rightAscension && boresightDeclination === declination) return false
	if (new Gnomonic(boresightRightAscension, boresightDeclination).project(rightAscension, declination, o) === undefined) return false
	o.x = -o.x / pixelScale
	o.y = -o.y / pixelScale
	return true
}
