import { encodeUnsigned7 } from './numeric'

// Frequency Firmata payload encoding. Interrupt mode and sampling interval or
// debounce time are framed by the client with the frequency feature ID.

// Encodes a raw edge counter on `pin` with interrupt mode and sample interval.
export function encodeFrequencyQuery(pin: number, mode: 1 | 2 | 3 | 4 | 5, samplingMilliseconds: number): number[] {
	return [1, pin, mode, ...encodeUnsigned7(samplingMilliseconds, 2)]
}

// Encodes an edge debounce interval in microseconds for `pin`.
export function encodeFrequencyFilter(pin: number, microseconds: number): number[] {
	return [3, pin, ...encodeUnsigned7(microseconds, 5)]
}
