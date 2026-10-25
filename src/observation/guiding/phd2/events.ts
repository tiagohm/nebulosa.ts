import type { GuidingCalibrationDiagnostics } from '../calibrator'
import type { GuiderLockShift, GuiderSettingChange, GuiderState, GuidingEvent } from '../events'
import type { AxisPulse, DeclinationGuideMode } from '../guider'
// oxfmt-ignore
import { PHD2_MSG_VERSION, PHD2_OVERLAP_SUPPORT, PHD2_SUBVER, PHD2_VERSION, type PHD2AppState, type PHD2DeclinationGuideMode, type PHD2EventMap, type PHD2Events, type PHD2GuideDirection, type PHD2LockShiftParams } from './types'

// Translation of the native events of the local guider (`GuidingEvent`) into the PHD2 events the PHD2 event-monitoring
// protocol defines, at the PHD2 boundary only. Each native event becomes zero or more PHD2 events in emission order,
// with the PHD2 envelope (`Timestamp` in Unix seconds, an empty `Host`, `Inst` 1). The translation is stateless: every
// field comes from the native event. Guiding assistant events have no PHD2 counterpart and translate to nothing.

// Translates one native guider event into the PHD2 events PHD2 would emit for it, in order.
export function phd2EventsOf(event: GuidingEvent): PHD2Events[] {
	const at = event.timestamp

	switch (event.type) {
		case 'connected':
			// PHD2 greets a newly connected client with Version followed by the current AppState.
			return [phd2Event('Version', at, { PHDVersion: PHD2_VERSION, PHDSubver: PHD2_SUBVER, MsgVersion: PHD2_MSG_VERSION, OverlapSupport: PHD2_OVERLAP_SUPPORT }), phd2Event('AppState', at, { State: phd2AppStateOf(event.state) }), phd2Event('ConfigurationChange', at, {})]
		case 'disconnected':
		case 'calibrationCleared':
			return [phd2Event('ConfigurationChange', at, {})]
		case 'stateChanged':
			// PHD2 sends AppState only when a client connects; later transitions are tracked through the
			// individual lifecycle events. https://github.com/OpenPHDGuiding/phd2/wiki/EventMonitoring#appstate
			return []
		case 'settingChanged':
			return [phd2Event('GuideParamChange', at, phd2GuideParamOf(event)), phd2Event('ConfigurationChange', at, {})]
		case 'targetSelected':
			return [phd2Event('StarSelected', at, { X: event.x, Y: event.y }), phd2Event('LockPositionSet', at, { X: event.x, Y: event.y })]
		case 'lockPositionSet':
			return [phd2Event('LockPositionSet', at, { X: event.x, Y: event.y })]
		case 'lockLost':
			return [phd2Event('LockPositionLost', at, {})]
		case 'starLost':
			return [phd2Event('StarLost', at, { Frame: event.frameId, Time: event.guidingTime, StarMass: event.mass, SNR: event.snr, AvgDist: event.averageDistance, ErrorCode: 1, Status: event.notes.join(',') })]
		case 'lockShiftLimitReached':
			return [phd2Event('LockPositionShiftLimitReached', at, {})]
		case 'loopingFrame':
			return [phd2Event('LoopingExposures', at, { Frame: event.frameId, StarMass: event.mass, SNR: event.snr, HFD: event.hfd })]
		case 'calibrationStarted':
			return [phd2Event('StartCalibration', at, { Mount: event.guideOutput })]
		case 'calibrationStep':
			return [phd2Event('Calibrating', at, phd2CalibratingOf(event.guideOutput, event.diagnostics))]
		case 'calibrationCompleted':
			return [phd2Event('CalibrationComplete', at, { Mount: event.guideOutput })]
		case 'calibrationFailed':
			// PHD2 raises a user-facing alert alongside the failure so clients without a calibration UI still
			// surface the reason.
			return [phd2Event('CalibrationFailed', at, { Reason: event.failure.message }), phd2Event('Alert', at, { Msg: `Calibration failed: ${event.failure.message}`, Type: 'error' })]
		case 'calibrationFlipped':
			return [phd2Event('CalibrationDataFlipped', at, { Mount: event.guideOutput }), phd2Event('ConfigurationChange', at, {})]
		case 'guidingStarted':
			return [phd2Event('StartGuiding', at, {})]
		case 'guidingStopped':
			return [phd2Event('GuidingStopped', at, {})]
		case 'loopingStopped':
			return [phd2Event('LoopingExposuresStopped', at, {})]
		case 'guideStep': {
			const step = phd2Event('GuideStep', at, {
				Frame: event.frameId,
				Time: event.guidingTime,
				Mount: event.guideOutput,
				dx: event.dx,
				dy: event.dy,
				RADistanceRaw: event.raDistance,
				DECDistanceRaw: event.decDistance,
				RADistanceGuide: event.raGuideDistance,
				DECDistanceGuide: event.decGuideDistance,
				RADuration: event.ra.duration,
				// PHD2 directions are mandatory, so no-pulse frames fall back to west/north defaults.
				RADirection: phd2GuideDirectionOf(event.ra.direction, 'West'),
				DECDuration: event.dec.duration,
				DECDirection: phd2GuideDirectionOf(event.dec.direction, 'North'),
				StarMass: event.mass,
				SNR: event.snr,
				HFD: event.hfd,
				AvgDist: event.averageDistance,
				ErrorCode: 0,
			})

			// PHD2 includes the limit flags only when the pulse was clipped, so they stay absent otherwise.
			if (!event.ra.limited && !event.dec.limited) return [step]
			return [{ ...step, ...(event.ra.limited && { RALimited: true }), ...(event.dec.limited && { DecLimited: true }) }]
		}
		case 'settleStarted':
			return [phd2Event('SettleBegin', at, {})]
		case 'settling':
			return [phd2Event('Settling', at, { Distance: event.distance, Time: event.timeInRange, SettleTime: event.settleTime, StarLocked: event.starLocked })]
		case 'settleDone':
			return [phd2Event('SettleDone', at, { Status: event.succeeded ? 0 : 1, TotalFrames: event.totalFrames, DroppedFrames: event.droppedFrames, Error: event.error })]
		case 'dithered':
			return [phd2Event('GuidingDithered', at, { dx: event.dx, dy: event.dy })]
		case 'paused':
			return [phd2Event('Paused', at, {})]
		case 'resumed':
			return [phd2Event('Resumed', at, {})]
		case 'alert':
			return [phd2Event('Alert', at, { Msg: event.message, Type: event.severity })]
		case 'assistantStarted':
		case 'assistantUpdated':
		case 'assistantCompleted':
		case 'assistantFailed':
			return []
	}
}

// PHD2 name of each guider state.
const PHD2_APP_STATE: Readonly<Record<GuiderState, PHD2AppState>> = {
	stopped: 'Stopped',
	looping: 'Looping',
	selected: 'Selected',
	calibrating: 'Calibrating',
	guiding: 'Guiding',
	lostLock: 'LostLock',
	paused: 'Paused',
}

// Returns the PHD2 app state of a guider state.
export function phd2AppStateOf(state: GuiderState): PHD2AppState {
	return PHD2_APP_STATE[state]
}

// Returns the PHD2 declination guide mode of a local one.
export function phd2DeclinationGuideModeOf(mode: DeclinationGuideMode): PHD2DeclinationGuideMode {
	return mode === 'off' ? 'Off' : mode === 'north-only' ? 'North' : mode === 'south-only' ? 'South' : 'Auto'
}

// Returns the local declination guide mode of a PHD2 one.
export function declinationGuideModeOf(mode: PHD2DeclinationGuideMode): DeclinationGuideMode {
	return mode === 'Off' ? 'off' : mode === 'North' ? 'north-only' : mode === 'South' ? 'south-only' : 'auto'
}

// Returns the PHD2 lock-shift parameters of a lock shift.
export function phd2LockShiftParamsOf(shift: GuiderLockShift): PHD2LockShiftParams {
	return { enabled: shift.enabled, rate: shift.rate, units: shift.unit === 'arcsecPerHour' ? 'arcsec/hr' : 'pixels/hr', axes: shift.axes === 'raDec' ? 'RA/Dec' : 'X/Y' }
}

// Returns the lock shift of PHD2 lock-shift parameters.
export function lockShiftOf(params: PHD2LockShiftParams): GuiderLockShift {
	return { enabled: params.enabled, rate: params.rate, unit: params.units === 'arcsec/hr' ? 'arcsecPerHour' : 'pixelsPerHour', axes: params.axes === 'RA/Dec' ? 'raDec' : 'xy' }
}

// Builds one PHD2 event of type `Event` emitted at `timestamp` (Unix milliseconds) with the PHD2 envelope.
function phd2Event<T extends keyof PHD2EventMap>(Event: T, timestamp: number, data: Omit<PHD2EventMap[T], 'Event' | 'Timestamp' | 'Host' | 'Inst'>) {
	// The local guider is not a network PHD2 server, so Host is empty and Inst is the 1-based instance number.
	return { ...data, Event, Timestamp: timestamp / 1000, Host: '', Inst: 1 } as PHD2EventMap[T]
}

// PHD2 `GuideParamChange` payload of a setting change.
function phd2GuideParamOf(change: GuiderSettingChange) {
	switch (change.setting) {
		case 'exposure':
			return { Name: 'Exposure', Value: change.value }
		case 'decGuideMode':
			return { Name: 'DecGuideMode', Value: phd2DeclinationGuideModeOf(change.value) }
		case 'guideOutputEnabled':
			return { Name: 'GuideOutputEnabled', Value: change.value }
		case 'ditherMode':
			return { Name: 'DitherMode', Value: change.value }
		case 'stickyLockPosition':
			return { Name: 'StickyLockPosition', Value: change.value }
		case 'lockShiftEnabled':
			return { Name: 'LockShiftEnabled', Value: change.value }
		case 'lockShift':
			return { Name: 'LockShiftParams', Value: phd2LockShiftParamsOf(change.value) }
	}
}

// PHD2 `Calibrating` payload of one calibration step: the pulse direction of the step, the distance of its phase and
// the offset from the calibration start, in pixels.
function phd2CalibratingOf(guideOutput: string, diagnostics: GuidingCalibrationDiagnostics) {
	const x = diagnostics.currentX ?? diagnostics.startX ?? 0
	const y = diagnostics.currentY ?? diagnostics.startY ?? 0
	const pendingPulse = diagnostics.pendingPulse?.ra.direction ?? diagnostics.pendingPulse?.dec.direction

	return {
		Mount: guideOutput,
		// An empty direction when the current calibration frame is only a measurement frame.
		dir: pendingPulse?.toLowerCase() ?? '',
		dist: calibrationDistanceOf(diagnostics),
		dx: x - (diagnostics.startX ?? x),
		dy: y - (diagnostics.startY ?? y),
		// PHD2's `pos` shape is not modeled locally, so the measured image coordinates are reported.
		pos: [x, y] as const,
		step: diagnostics.raSteps + diagnostics.decSteps + diagnostics.clearingSteps,
		State: diagnostics.phase,
	}
}

// Distance, in pixels, travelled in the axis phase the calibrator is in.
function calibrationDistanceOf(diagnostics: GuidingCalibrationDiagnostics) {
	if (diagnostics.phase === 'raClearPulse' || diagnostics.phase === 'raClearMeasure') return diagnostics.clearingDistancePx
	if (diagnostics.phase === 'decForwardPulse' || diagnostics.phase === 'decBacklashClearing' || diagnostics.phase === 'decForwardMeasure' || diagnostics.phase === 'decForwardComplete') return diagnostics.decNetDistancePx
	return diagnostics.raNetDistancePx
}

// Converts a local pulse direction to PHD2 casing, with a mandatory default for an axis without a pulse.
function phd2GuideDirectionOf(direction: AxisPulse['direction'], fallback: PHD2GuideDirection): PHD2GuideDirection {
	return direction === 'EAST' ? 'East' : direction === 'NORTH' ? 'North' : direction === 'SOUTH' ? 'South' : direction === 'WEST' ? 'West' : fallback
}
