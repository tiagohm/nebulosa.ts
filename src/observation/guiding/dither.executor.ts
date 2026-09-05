import { CLIENT, type GuideOutput } from '../../devices/indi/device'
import type { GuideOutputManager } from '../../devices/indi/manager/guideoutput'
import type { DitherPulsePlan } from './dither.pulse'

// Dispatches a dither pulse plan to a guide output. This is the only layer of the direct-dither flow
// that knows about devices; the plan itself is produced by pure conversions. Durations are
// milliseconds and arrive already normalized to whole values of at least 1.

// Sends the plan's pulses to the guide output and reports whether anything was dispatched.
//
// Returns false, before issuing any command, when the signal is already aborted, when the device
// cannot pulse guide, when it has no owning client, or when the plan is empty. The client check is
// not defensive bookkeeping: GuideOutputManager.pulse resolves the client with a non-null assertion
// and would throw on a detached device, breaking this function's boolean contract.
//
// Both axes are started back to back so the resulting motion approximates the computed vector; INDI
// carries the two axes on independent properties, so the commands do not serialize. Backends unable
// to pulse both axes at once must serialize inside the backend, not here.
//
// Returning true means the commands were handed to the transport, nothing more. The manager reports
// no transport error and offers no completion signal, so this cannot promise the mount finished
// moving. For the same reason the abort signal can only prevent the dispatch: a pulse already accepted
// by the hardware cannot be cancelled without extending the manager contract and every backend with a
// proven pulse-guide abort.
//
// The guide-rate flow needs no explicit hasGuideRate check here: a device without it reports a zero
// guide rate, and the conversion already rejects a zero rate, so no plan reaches this point.
export function dispatchDitherPulses(guideOutputManager: GuideOutputManager, guideOutput: GuideOutput, plan: DitherPulsePlan, abortSignal?: AbortSignal): boolean {
	if (abortSignal?.aborted) return false
	if (!guideOutput.canPulseGuide) return false
	if (guideOutput[CLIENT] === undefined) return false

	const { rightAscension, declination } = plan
	if (rightAscension === undefined && declination === undefined) return false

	if (rightAscension !== undefined) guideOutputManager.pulse(guideOutput, rightAscension.direction, rightAscension.duration)
	if (declination !== undefined) guideOutputManager.pulse(guideOutput, declination.direction, declination.duration)

	return true
}
