import type { StepperConfig } from '../types'
import { encodeStepperPosition } from './numeric'

// AccelStepper and MultiStepper payload codecs. Positions use the firmware's
// five-byte signed sign-magnitude format and preserve configured motor order.

// Encodes the motor interface, required pins and optional enable/inversion fields.
export function encodeStepperConfig(options: StepperConfig): number[] {
	const wireCount = options.interface === 'driver' ? 1 : options.interface === 'twoWire' ? 2 : options.interface === 'threeWire' ? 3 : 4
	const control = (wireCount << 4) | ((options.stepType ?? 0) << 1) | (options.enablePin === undefined ? 0 : 1)
	const payload = [0, options.device, control, options.pin1, options.pin2]
	if (options.interface === 'threeWire' || options.interface === 'fourWire') payload.push(options.pin3)
	if (options.interface === 'fourWire') payload.push(options.pin4)
	if (options.enablePin !== undefined) payload.push(options.enablePin)
	if (options.invertPins !== undefined) payload.push(options.invertPins)
	return payload
}

// Appends one to ten motor IDs in 0-9 to MultiStepper group 0-4.
export function encodeMultiStepperConfig(group: number, devices: readonly number[]): number[] {
	const size = devices.length
	// Keep host commands within the firmware's five groups and ten motor slots.
	if (!(Number.isInteger(group) && group >= 0 && group < 5 && size > 0 && size <= 10 && devices.every((device) => Number.isInteger(device) && device >= 0 && device < 10))) throw new RangeError('MultiStepper requires group 0-4 and 1-10 motor IDs in 0-9')
	return [0x20, group, ...devices]
}

// Encodes absolute targets in the group's configured motor order, in steps.
export function encodeMultiStepperMoveTo(group: number, positions: readonly number[]): number[] {
	const payload = [0x21, group]
	for (const position of positions) payload.push(...encodeStepperPosition(position))
	return payload
}

// Encodes an immediate stop for MultiStepper group 0-4.
export function encodeMultiStepperStop(group: number): number[] {
	if (!(Number.isInteger(group) && group >= 0 && group < 5)) throw new RangeError('MultiStepper group must be 0-4')
	return [0x23, group]
}
