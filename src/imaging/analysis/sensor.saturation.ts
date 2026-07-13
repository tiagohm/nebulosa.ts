import type { PhotonTransferPoint, SensorGain, SensorReadNoise } from './sensor.ptc'

// Saturation-capacity and dynamic-range analysis for a characterized sensor plane. Detection uses
// measured PTC behavior in acquisition order and treats digital range only as a low-confidence output
// limit. Capacity is observable charge at output saturation, not an assertion of physical full well.

// Dark-corrected output saturation estimate.
export interface SensorSaturation {
	// Dark-corrected output signal at saturation, DN.
	readonly signal: number
	// Estimated charge at output saturation, electrons.
	readonly capacity?: number
	// Acquisition-level index identifying the selected point.
	readonly index: number
	// Evidence used to select the saturation point.
	readonly method: 'unclippedLevel' | 'response' | 'variance' | 'plateau' | 'digitalRange'
	// Heuristic evidence strength from 0 to 1.
	readonly confidence: number
}

// One representation of a positive dynamic-range ratio.
export interface SensorDynamicRangeValue {
	// Linear saturation-to-noise ratio.
	readonly ratio: number
	// Base-2 stops represented by the ratio.
	readonly stops: number
	// Amplitude ratio expressed as 20*log10(ratio), decibels.
	readonly decibels: number
}

// Practical RMS and EMVA absolute-sensitivity dynamic ranges.
export interface SensorDynamicRange {
	// Saturation capacity divided by total input-referred RMS noise.
	readonly practical: SensorDynamicRangeValue
	// Saturation capacity divided by EMVA absolute sensitivity threshold.
	readonly emva: SensorDynamicRangeValue
}

// Creates a finite dynamic-range representation for a positive ratio.
function dynamicRangeValue(ratio: number): SensorDynamicRangeValue {
	return { ratio, stops: Math.log2(ratio), decibels: 20 * Math.log10(ratio) }
}

// Computes practical and EMVA dynamic range when capacity and total read noise are positive.
export function computeSensorDynamicRange(saturation: SensorSaturation, readNoise: SensorReadNoise): SensorDynamicRange | undefined {
	const capacity = saturation.capacity
	const noise = readNoise.totalElectrons
	if (!(capacity !== undefined && noise !== undefined && Number.isFinite(capacity) && Number.isFinite(noise) && capacity > 0 && noise > 0)) return undefined
	const practicalRatio = capacity / noise
	const minimumSensitivity = Math.sqrt(noise * noise + 0.25) + 0.5
	const emvaRatio = capacity / minimumSensitivity
	if (!(Number.isFinite(practicalRatio) && Number.isFinite(emvaRatio) && practicalRatio > 0 && emvaRatio > 0)) return undefined
	return { practical: dynamicRangeValue(practicalRatio), emva: dynamicRangeValue(emvaRatio) }
}

// Adds electron capacity only when the conversion gain is finite and positive.
function saturation(point: PhotonTransferPoint | undefined, signal: number, method: SensorSaturation['method'], confidence: number, gain?: SensorGain): SensorSaturation | undefined {
	if (!Number.isFinite(signal) || signal <= 0) return undefined
	const capacity = gain && Number.isFinite(gain.conversion) && gain.conversion > 0 ? signal * gain.conversion : undefined
	return { signal, capacity, index: point?.level ?? -1, method, confidence }
}

// Detects output saturation from clipping, PTC variance collapse, response plateau, or digital limit.
export function detectSensorSaturation(points: readonly PhotonTransferPoint[], gain?: SensorGain, digitalSignalLimit?: number): SensorSaturation | undefined {
	const ordered = [...points].sort((a, b) => a.level - b.level)
	for (let i = 0; i < ordered.length; i++) {
		if (ordered[i].clippedFraction <= 0) continue
		let candidate = i - 1
		while (candidate >= 0 && !ordered[candidate].valid) candidate--
		const selected = candidate >= 0 ? ordered[candidate] : ordered[i]
		const result = saturation(selected, selected.signal, 'unclippedLevel', candidate >= 0 ? 0.95 : 0.6, gain)
		if (result) return result
	}

	let peak = -1
	let peakVariance = Number.NEGATIVE_INFINITY
	for (let i = 0; i < ordered.length; i++) {
		const point = ordered[i]
		if (!point.valid) continue
		if (point.variance > peakVariance) {
			peakVariance = point.variance
			peak = i
		} else if (peak >= 1 && point.variance < peakVariance * 0.9 && point.signal >= ordered[peak].signal) {
			const selected = ordered[peak]
			const result = saturation(selected, selected.signal, 'variance', 0.75, gain)
			if (result) return result
		}
	}

	let previousIncrease = Number.POSITIVE_INFINITY
	for (let i = 1; i < ordered.length; i++) {
		const increase = ordered[i].signal - ordered[i - 1].signal
		if (increase > 0 && previousIncrease < Number.POSITIVE_INFINITY && increase < previousIncrease * 0.25) {
			const selected = ordered[i - 1]
			const result = saturation(selected, selected.signal, 'response', 0.65, gain)
			if (result) return result
		}
		if (increase > 0) previousIncrease = increase
	}

	if (ordered.length >= 3) {
		let maximumSignal = 0
		for (const point of ordered) maximumSignal = Math.max(maximumSignal, point.signal)
		const last = ordered.at(-1)!
		const previous = ordered.at(-2)!
		if (maximumSignal > 0 && Math.abs(last.signal - previous.signal) <= maximumSignal * 0.01) {
			const result = saturation(previous, previous.signal, 'plateau', 0.5, gain)
			if (result) return result
		}
	}

	return digitalSignalLimit === undefined ? undefined : saturation(undefined, digitalSignalLimit, 'digitalRange', 0.2, gain)
}
