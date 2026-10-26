import { describe, expect, test } from 'bun:test'
import type { GuidingCalibrationDiagnostics } from '../../../../src/observation/guiding/calibrator'
import type { GuidingEvent } from '../../../../src/observation/guiding/events'
import type { GuideDiagnostics } from '../../../../src/observation/guiding/guider'
import { declinationGuideModeOf, lockShiftOf, phd2AppStateOf, phd2DeclinationGuideModeOf, phd2EventsOf, phd2LockShiftParamsOf } from '../../../../src/observation/guiding/phd2/events'

const AT = 1_700_000_000_000

function names(event: GuidingEvent) {
	return phd2EventsOf(event).map((each) => each.Event)
}

describe('envelope', () => {
	test('stamps every translated event with the native instant in seconds, an empty host and instance 1', () => {
		for (const event of phd2EventsOf({ type: 'settingChanged', timestamp: AT, setting: 'exposure', value: 2000 })) {
			expect(event).toMatchObject({ Timestamp: AT / 1000, Host: '', Inst: 1 })
		}
	})
})

describe('translation', () => {
	test('greets a connection with Version, the app state and a configuration change', () => {
		const events = phd2EventsOf({ type: 'connected', timestamp: AT, state: 'stopped' })
		expect(events.map((event) => event.Event)).toEqual(['Version', 'AppState', 'ConfigurationChange'])
		expect(events[1]).toMatchObject({ State: 'Stopped' })
	})

	test('sends no PHD2 event for a state change or the guiding assistant', () => {
		expect(phd2EventsOf({ type: 'stateChanged', timestamp: AT, state: 'guiding', previous: 'calibrating' })).toEqual([])
		expect(phd2EventsOf({ type: 'assistantStarted', timestamp: AT, result: {} as never })).toEqual([])
		expect(phd2EventsOf({ type: 'assistantFailed', timestamp: AT, result: {} as never })).toEqual([])
	})

	test('follows a setting change with a configuration change, in PHD2 names and values', () => {
		expect(phd2EventsOf({ type: 'settingChanged', timestamp: AT, setting: 'decGuideMode', value: 'south-only' })).toMatchObject([{ Event: 'GuideParamChange', Name: 'DecGuideMode', Value: 'South' }, { Event: 'ConfigurationChange' }])
		expect(phd2EventsOf({ type: 'settingChanged', timestamp: AT, setting: 'lockShift', value: { enabled: true, rate: [1, 2], unit: 'arcsecPerHour', axes: 'raDec' } })[0]).toMatchObject({ Name: 'LockShiftParams', Value: { enabled: true, rate: [1, 2], units: 'arcsec/hr', axes: 'RA/Dec' } })
		expect(names({ type: 'calibrationFlipped', timestamp: AT, guideOutput: 'Mount' })).toEqual(['CalibrationDataFlipped', 'ConfigurationChange'])
		expect(names({ type: 'calibrationCleared', timestamp: AT })).toEqual(['ConfigurationChange'])
		expect(names({ type: 'disconnected', timestamp: AT })).toEqual(['ConfigurationChange'])
	})

	test('reports a selected target as a star selection and a lock position', () => {
		expect(phd2EventsOf({ type: 'targetSelected', timestamp: AT, x: 10, y: 20 })).toMatchObject([
			{ Event: 'StarSelected', X: 10, Y: 20 },
			{ Event: 'LockPositionSet', X: 10, Y: 20 },
		])
	})

	test('raises an alert alongside a calibration failure', () => {
		const failure = { code: 'no_usable_star', phase: 'raForwardMeasure', message: 'the star did not move' } as const
		expect(phd2EventsOf({ type: 'calibrationFailed', timestamp: AT, guideOutput: 'Mount', failure })).toMatchObject([
			{ Event: 'CalibrationFailed', Reason: 'the star did not move' },
			{ Event: 'Alert', Msg: 'Calibration failed: the star did not move', Type: 'error' },
		])
	})

	test('reports calibration progress with the distance of its phase and the offset from the start', () => {
		const diagnostics = {
			phase: 'decForwardMeasure',
			startX: 100,
			startY: 50,
			currentX: 103,
			currentY: 54,
			raSteps: 4,
			decSteps: 2,
			clearingSteps: 1,
			decReturnSteps: 0,
			clearingDistancePx: 1,
			raNetDistancePx: 12,
			decNetDistancePx: 5,
			pendingPulse: { ra: { duration: 0 }, dec: { direction: 'NORTH', duration: 500 } },
		} as unknown as GuidingCalibrationDiagnostics
		expect(phd2EventsOf({ type: 'calibrationStep', timestamp: AT, guideOutput: 'Mount', diagnostics })[0]).toMatchObject({ Event: 'Calibrating', Mount: 'Mount', dir: 'north', dist: 5, dx: 3, dy: 4, pos: [103, 54], step: 7, State: 'decForwardMeasure' })
		// The DEC return reports the distance left to the calibration origin and counts its steps.
		const returning = { ...diagnostics, phase: 'decReturnMeasure', decReturnSteps: 2, pendingPulse: { ra: { duration: 0 }, dec: { direction: 'SOUTH', duration: 300 } } } as GuidingCalibrationDiagnostics
		expect(phd2EventsOf({ type: 'calibrationStep', timestamp: AT, guideOutput: 'Mount', diagnostics: returning })[0]).toMatchObject({ dir: 'south', dist: 1, step: 9, State: 'decReturnMeasure' })
	})

	test('gives a guide step PHD2 default directions and the limit flags only when limited', () => {
		const step = {
			type: 'guideStep',
			timestamp: AT,
			frameId: 7,
			guidingTime: 12.5,
			guideOutput: 'Mount',
			dx: 0.5,
			dy: -0.25,
			raDistance: 0.4,
			decDistance: -0.3,
			raGuideDistance: 0.35,
			decGuideDistance: 0,
			ra: { direction: 'EAST', requested: 120.4, duration: 120, limited: false },
			dec: { requested: 0, duration: 0, limited: false },
			mass: 1000,
			snr: 25,
			hfd: 2.5,
			averageDistance: 0.6,
			diagnostics: {} as GuideDiagnostics,
		} as const satisfies GuidingEvent
		const [plain] = phd2EventsOf(step)
		expect(plain).toMatchObject({ Event: 'GuideStep', Frame: 7, Time: 12.5, RADirection: 'East', RADuration: 120, DECDirection: 'North', DECDuration: 0, RADistanceRaw: 0.4, AvgDist: 0.6, ErrorCode: 0 })
		expect(plain).not.toHaveProperty('RALimited')
		expect(plain).not.toHaveProperty('DecLimited')

		const [limited] = phd2EventsOf({ ...step, dec: { direction: 'SOUTH', requested: 3000, duration: 2500, limited: true } })
		expect(limited).toMatchObject({ DECDirection: 'South', DecLimited: true })
		expect(limited).not.toHaveProperty('RALimited')
	})

	test('maps settle results to PHD2 statuses', () => {
		expect(phd2EventsOf({ type: 'settleDone', timestamp: AT, succeeded: true, totalFrames: 3, droppedFrames: 0 })).toMatchObject([{ Event: 'SettleDone', Status: 0, TotalFrames: 3, DroppedFrames: 0 }])
		expect(phd2EventsOf({ type: 'settleDone', timestamp: AT, succeeded: false, totalFrames: 9, droppedFrames: 2, error: 'settle timeout' })).toMatchObject([{ Event: 'SettleDone', Status: 1, Error: 'settle timeout' }])
	})

	test('joins the controller notes of a lost star into its status', () => {
		expect(phd2EventsOf({ type: 'starLost', timestamp: AT, frameId: 3, guidingTime: 1, mass: 0, snr: 0, hfd: 0, averageDistance: 0.2, notes: ['bad_frame', 'lost'] })).toMatchObject([{ Event: 'StarLost', Frame: 3, ErrorCode: 1, Status: 'bad_frame,lost', AvgDist: 0.2 }])
	})
})

describe('conversions', () => {
	test('round-trip the declination guide modes and lock-shift parameters', () => {
		for (const mode of ['auto', 'north-only', 'south-only', 'off'] as const) expect(declinationGuideModeOf(phd2DeclinationGuideModeOf(mode))).toBe(mode)
		const shift = { enabled: false, rate: [3, -4], unit: 'pixelsPerHour', axes: 'xy' } as const
		expect(lockShiftOf(phd2LockShiftParamsOf(shift))).toEqual(shift)
		expect(phd2AppStateOf('lostLock')).toBe('LostLock')
	})
})
