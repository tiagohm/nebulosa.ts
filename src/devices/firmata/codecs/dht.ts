import type { DhtModel } from '../types'
import { encodeUnsigned7 } from './numeric'

// DHT Firmata payload encoding. The client supplies the feature ID and frames the
// result as SysEx; the sampling period is transmitted in milliseconds.

// Encodes DHT11 or DHT22 attachment with a blocking flag and sample interval.
export function encodeDhtAttach(pin: number, model: DhtModel, samplingMilliseconds: number, blocking: boolean): number[] {
	return [model === 'dht11' ? 1 : 2, pin, blocking ? 1 : 0, ...encodeUnsigned7(samplingMilliseconds, 2)]
}
