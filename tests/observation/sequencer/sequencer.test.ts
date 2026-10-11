import { describe, expect, test } from 'bun:test'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import { deg, hour } from '../../../src/math/units/angle'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerCameraCapture, type SequencerConfiguration, type SequencerConfigurationDiagnostic, SYSTEM_SEQUENCER_CLOCK, validateSequencerConfiguration } from '../../../src/observation/sequencer/sequencer'

const LIGHT: SequencerCameraCapture = { exposureTime: 120, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 100, offset: 10, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }

// Every feature configured, including scheduled and triggered groups.
function fullConfiguration(): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'm42',
		revision: 3,
		name: 'M42 LRGB',
		target: { frame: 'J2000', rightAscension: hour(5.588), declination: deg(-5.39), name: 'M42' },
		capture: {
			order: 'weightedRoundRobin',
			groups: [
				{
					kind: 'scheduled',
					id: 'L',
					enabled: true,
					filter: { kind: 'name', name: 'L' },
					capture: LIGHT,
					count: 20,
					weight: 2,
					discard: { criteria: { quality: true, guidingInterruption: true, unsafeDuringExposure: true }, maxDiscardsPerSlot: 2, onExhausted: 'skipSlot', maxConsecutiveDiscards: 5, onConsecutiveExhausted: 'pause', artifact: 'moveToRejected' },
				},
				{ kind: 'scheduled', id: 'R', enabled: true, filter: { kind: 'slot', slot: 1 }, capture: LIGHT, count: 10, weight: 1 },
				{
					kind: 'triggered',
					id: 'dark',
					enabled: true,
					capture: DARK,
					trigger: { kind: 'afterFrames', frames: 5, sourceGroups: ['L'] },
					batchSize: 1,
					maxFrames: 10,
					inherit: 'triggeringFrame',
					opticalPath: { kind: 'cover' },
					discard: { criteria: { quality: true, guidingInterruption: false, unsafeDuringExposure: false }, maxDiscardsPerSlot: 0, onExhausted: 'keepLast', artifact: 'keepInPlace' },
				},
				{ kind: 'triggered', id: 'bias', enabled: false, capture: { ...DARK, frameType: 'BIAS' }, trigger: { kind: 'sessionStart' }, batchSize: 5, maxFrames: 5, inherit: 'none', opticalPath: { kind: 'filter', filter: { kind: 'name', name: 'Dark' } } },
				{ kind: 'triggered', id: 'end', enabled: true, capture: DARK, trigger: { kind: 'sessionEnd', onStop: true }, batchSize: 3, maxFrames: 3, inherit: 'none', opticalPath: { kind: 'none' } },
				{ kind: 'triggered', id: 'thermal', enabled: true, capture: DARK, trigger: { kind: 'temperatureChange', delta: 2 }, batchSize: 2, maxFrames: 6, inherit: 'none', opticalPath: { kind: 'none' } },
			],
			retry: { maxAttempts: 3, delay: 5, backoff: 2, maximumDelay: 30, retryOn: ['timeout', 'commandFailed'] },
			onFailure: 'skipFrame',
			cameraRecovery: { timeout: 300, onTimeout: 'pause' },
			focusOffsets: { reference: 'L', offsets: { R: 100, G: -50 } },
			quality: { timeout: 30 },
		},
		startup: { cooling: { setpoint: -10, tolerance: 0.5, stableFor: 60, timeout: 900, waitForTemperature: true }, dome: { open: true }, cover: { open: true }, mount: { unpark: true, trackMode: 'SIDEREAL' }, onFailure: 'stop' },
		shutdown: { stepTimeout: 60, totalTimeout: 600, stopTracking: 'required', stopGuiding: 'bestEffort', closeCover: 'required', parkMount: 'required', closeOrParkDome: 'required', turnOffFlatPanel: 'bestEffort', warmCamera: 'bestEffort' },
		pointing: { settle: 2, centering: { tolerance: deg(1 / 60), maximumAttempts: 5, settle: 1, syncMount: true, capture: { ...LIGHT, exposureTime: 5 }, solveTimeout: 60 }, recenter: { afterFrames: 10, interval: 1800 }, onFailure: 'fail' },
		rotator: { angle: deg(90), tolerance: deg(0.5), settle: 1, onFailure: 'pause' },
		autofocus: {
			algorithm: { initialOffsetSteps: 4, stepSize: 100, fittingMode: 'TREND_HYPERBOLIC', reversed: false },
			capture: { ...LIGHT, exposureTime: 3 },
			filter: { kind: 'name', name: 'L' },
			triggers: { onStart: true, afterResume: true, afterFlip: true, onFilterChange: false, afterFrames: 30, interval: 3600, temperatureDelta: 1.5 },
			measureTimeout: 30,
			onFailure: 'skip',
		},
		guiding: { settle: { pixels: 1.5, time: 10, timeout: 60 }, pauseTimeout: 10, maxRecoveries: 2, recalibrate: false, flipCalibration: true, onFailure: 'pause' },
		dither: { afterFrames: 3, amount: { unit: 'guidePixel', value: 5 }, raOnly: false, settle: { kind: 'guided', pixels: 1.5, time: 10, timeout: 60 }, onFailure: 'skip' },
		meridianFlip: { enabled: true, prepareAt: deg(-2), flipAt: 0, latestAt: deg(5), beforeFlipPierSide: 'EAST', afterFlipPierSide: 'WEST' },
		safety: { unsafeAction: 'shutdownImmediately', onUnsafeAtStartup: 'wait', unknownIsUnsafe: true },
		execution: { compensation: { timeout: 60 } },
	}
}

// The smallest valid configuration: camera only, nothing to capture.
function minimalConfiguration(): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'empty',
		revision: 0,
		name: '',
		capture: { order: 'sequential', groups: [], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'fail' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
	}
}

// Applies `mutate` to a JSON copy of the full configuration and returns the diagnostics.
function diagnosticsOf(mutate: (configuration: any) => void, base: () => SequencerConfiguration = fullConfiguration): readonly SequencerConfigurationDiagnostic[] {
	const configuration = JSON.parse(JSON.stringify(base()))
	mutate(configuration)
	const validation = validateSequencerConfiguration(configuration)
	return validation.ok ? [] : validation.diagnostics
}

// Expects exactly one diagnostic at `path`.
function expectDiagnostic(mutate: (configuration: any) => void, path: string, base?: () => SequencerConfiguration) {
	const diagnostics = diagnosticsOf(mutate, base)
	expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([path])
}

describe('validation', () => {
	test('round-trips a valid configuration through JSON and returns the input itself', () => {
		for (const configuration of [fullConfiguration(), minimalConfiguration()]) {
			const parsed = JSON.parse(JSON.stringify(configuration))
			const validation = validateSequencerConfiguration(parsed)
			expect(validation).toEqual({ ok: true, configuration })
			expect(validation.ok && validation.configuration).toBe(parsed)
		}
	})

	test('accepts a disabled meridian flip without the cross-feature rules', () => {
		expect(
			diagnosticsOf((c) => {
				c.meridianFlip.enabled = false
				delete c.shutdown.stopTracking
				c.startup.mount.trackMode = 'LUNAR'
				delete c.target
				delete c.pointing
			}),
		).toEqual([])
	})

	test('rejects what is not a configuration object', () => {
		for (const input of [undefined, null, 1, 'x', []]) {
			expect(validateSequencerConfiguration(input)).toEqual({ ok: false, diagnostics: [{ path: '', message: 'must be an object' }] })
		}
	})

	test('reports the path of every missing required section', () => {
		const diagnostics = diagnosticsOf((c) => {
			delete c.capture
			delete c.startup
			delete c.shutdown
			delete c.execution
		}, minimalConfiguration)

		expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual(['capture', 'startup', 'shutdown', 'execution'])
	})

	test('identity', () => {
		expectDiagnostic((c) => (c.schemaVersion = 2), 'schemaVersion')
		expectDiagnostic((c) => (c.id = ''), 'id')
		expectDiagnostic((c) => (c.revision = -1), 'revision')
		expectDiagnostic((c) => (c.revision = 1.5), 'revision')
		expectDiagnostic((c) => (c.name = 3), 'name')
	})

	test('target is a fixed J2000 coordinate in range', () => {
		expectDiagnostic((c) => (c.target.frame = 'JNOW'), 'target.frame')
		expectDiagnostic((c) => (c.target.rightAscension = 2 * Math.PI), 'target.rightAscension')
		expectDiagnostic((c) => (c.target.rightAscension = -0.1), 'target.rightAscension')
		expectDiagnostic((c) => (c.target.declination = Math.PI), 'target.declination')
		expectDiagnostic((c) => (c.target.declination = null), 'target.declination')
		expectDiagnostic((c) => (c.target.name = 1), 'target.name')
	})

	test('group ids are unique portable path segments', () => {
		expectDiagnostic((c) => (c.capture.groups[1].id = 'L'), 'capture.groups[1].id')
		expectDiagnostic((c) => (c.capture.groups[1].id = 'a/b'), 'capture.groups[1].id')
		expectDiagnostic((c) => (c.capture.groups[1].id = '..'), 'capture.groups[1].id')
		expectDiagnostic((c) => (c.capture.groups[1].id = ''), 'capture.groups[1].id')
		expectDiagnostic((c) => (c.capture.groups[1].kind = 'loop'), 'capture.groups[1].kind')
	})

	test('scheduled counts and weights', () => {
		expectDiagnostic((c) => (c.capture.groups[0].count = -1), 'capture.groups[0].count')
		expectDiagnostic((c) => (c.capture.groups[0].count = 2.5), 'capture.groups[0].count')
		expectDiagnostic((c) => delete c.capture.groups[1].weight, 'capture.groups[1].weight')
		expectDiagnostic((c) => (c.capture.groups[1].weight = 0), 'capture.groups[1].weight')
		expectDiagnostic((c) => (c.capture.groups[1].weight = Number.POSITIVE_INFINITY), 'capture.groups[1].weight')

		// A weight is optional outside weightedRoundRobin, but still positive when given.
		expect(
			diagnosticsOf((c) => {
				c.capture.order = 'roundRobin'
				delete c.capture.groups[1].weight
			}),
		).toEqual([])
		expectDiagnostic((c) => {
			c.capture.order = 'roundRobin'
			c.capture.groups[1].weight = -1
		}, 'capture.groups[1].weight')
	})

	test('exposure is positive and finite and the camera fields are typed', () => {
		expectDiagnostic((c) => (c.capture.groups[0].capture.exposureTime = 0), 'capture.groups[0].capture.exposureTime')
		expectDiagnostic((c) => (c.capture.groups[0].capture.exposureTime = Number.NaN), 'capture.groups[0].capture.exposureTime')
		expectDiagnostic((c) => (c.capture.groups[0].capture.exposureTimeUnit = 'hour'), 'capture.groups[0].capture.exposureTimeUnit')
		expectDiagnostic((c) => (c.capture.groups[0].capture.frameType = 'light'), 'capture.groups[0].capture.frameType')
		expectDiagnostic((c) => (c.capture.groups[0].capture.binX = 0), 'capture.groups[0].capture.binX')
		expectDiagnostic((c) => (c.capture.groups[0].capture.subframe = 'no'), 'capture.groups[0].capture.subframe')
		expectDiagnostic((c) => (c.pointing.centering.capture.gain = '1'), 'pointing.centering.capture.gain')
	})

	test('discard budgets and actions', () => {
		expectDiagnostic((c) => (c.capture.groups[0].discard.maxDiscardsPerSlot = -1), 'capture.groups[0].discard.maxDiscardsPerSlot')
		expectDiagnostic((c) => (c.capture.groups[0].discard.maxConsecutiveDiscards = 1.5), 'capture.groups[0].discard.maxConsecutiveDiscards')
		expectDiagnostic((c) => delete c.capture.groups[0].discard.onConsecutiveExhausted, 'capture.groups[0].discard.onConsecutiveExhausted')
		expectDiagnostic((c) => (c.capture.groups[0].discard.onExhausted = 'retry'), 'capture.groups[0].discard.onExhausted')
		expectDiagnostic((c) => (c.capture.groups[0].discard.artifact = 'move'), 'capture.groups[0].discard.artifact')
		expectDiagnostic((c) => (c.capture.groups[0].discard.criteria.quality = 1), 'capture.groups[0].discard.criteria.quality')
	})

	test('triggered groups take only the quality criterion and only darks or biases', () => {
		expectDiagnostic((c) => (c.capture.groups[2].discard.criteria.guidingInterruption = true), 'capture.groups[2].discard.criteria.guidingInterruption')
		expectDiagnostic((c) => (c.capture.groups[2].discard.criteria.unsafeDuringExposure = true), 'capture.groups[2].discard.criteria.unsafeDuringExposure')
		expectDiagnostic((c) => (c.capture.groups[2].capture.frameType = 'LIGHT'), 'capture.groups[2].capture.frameType')
		expectDiagnostic((c) => (c.capture.groups[2].capture.frameType = 'FLAT'), 'capture.groups[2].capture.frameType')
	})

	test('triggered batches, ceilings, inheritance and optical path', () => {
		expectDiagnostic((c) => (c.capture.groups[2].batchSize = 0), 'capture.groups[2].batchSize')
		expectDiagnostic((c) => (c.capture.groups[2].maxFrames = 0), 'capture.groups[2].maxFrames')
		expectDiagnostic((c) => (c.capture.groups[4].maxFrames = 2), 'capture.groups[4].maxFrames')
		expectDiagnostic((c) => (c.capture.groups[2].inherit = 'light'), 'capture.groups[2].inherit')
		expectDiagnostic((c) => (c.capture.groups[3].inherit = 'triggeringFrame'), 'capture.groups[3].inherit')
		expectDiagnostic((c) => (c.capture.groups[2].opticalPath = { kind: 'flatPanel' }), 'capture.groups[2].opticalPath.kind')
		expectDiagnostic((c) => (c.capture.groups[3].opticalPath.filter = { kind: 'slot', slot: -1 }), 'capture.groups[3].opticalPath.filter.slot')
		expectDiagnostic((c) => (c.capture.groups[3].opticalPath.filter = { kind: 'name', name: '' }), 'capture.groups[3].opticalPath.filter.name')
	})

	test('triggers reference existing scheduled groups', () => {
		expectDiagnostic((c) => (c.capture.groups[2].trigger.frames = 0), 'capture.groups[2].trigger.frames')
		expectDiagnostic((c) => (c.capture.groups[2].trigger.sourceGroups = ['X']), 'capture.groups[2].trigger.sourceGroups[0]')
		expectDiagnostic((c) => (c.capture.groups[2].trigger.sourceGroups = ['L', 'dark']), 'capture.groups[2].trigger.sourceGroups[1]')
		expectDiagnostic((c) => (c.capture.groups[5].trigger.delta = 0), 'capture.groups[5].trigger.delta')
		expectDiagnostic((c) => (c.capture.groups[4].trigger.onStop = undefined), 'capture.groups[4].trigger.onStop')
		expectDiagnostic((c) => (c.capture.groups[4].trigger = { kind: 'everyHour' }), 'capture.groups[4].trigger.kind')
	})

	test('retry policy is bounded', () => {
		expectDiagnostic((c) => (c.capture.retry.maxAttempts = 0), 'capture.retry.maxAttempts')
		expectDiagnostic((c) => (c.capture.retry.delay = -1), 'capture.retry.delay')
		expectDiagnostic((c) => (c.capture.retry.backoff = 0.5), 'capture.retry.backoff')
		expectDiagnostic((c) => (c.capture.retry.maximumDelay = 1), 'capture.retry.maximumDelay')
		expectDiagnostic((c) => (c.capture.retry.retryOn = ['timeout', 'unsafe']), 'capture.retry.retryOn[1]')
		expectDiagnostic((c) => (c.capture.onFailure = 'skip'), 'capture.onFailure')
		expectDiagnostic((c) => (c.startup.retry = { ...c.capture.retry, maxAttempts: Number.MAX_SAFE_INTEGER + 1 }), 'startup.retry.maxAttempts')
	})

	test('capture recovery and quality timeouts', () => {
		expectDiagnostic((c) => (c.capture.cameraRecovery.timeout = 0), 'capture.cameraRecovery.timeout')
		expectDiagnostic((c) => (c.capture.cameraRecovery.pollInterval = Number.POSITIVE_INFINITY), 'capture.cameraRecovery.pollInterval')
		expectDiagnostic((c) => delete c.capture.cameraRecovery.onTimeout, 'capture.cameraRecovery.onTimeout')
		expectDiagnostic((c) => (c.capture.quality.timeout = 0), 'capture.quality.timeout')
		expectDiagnostic((c) => (c.capture.quality.abortGrace = -1), 'capture.quality.abortGrace')
	})

	test('focus offsets are integer steps with a zero reference and cover light and autofocus filters', () => {
		expectDiagnostic((c) => (c.capture.focusOffsets.reference = ''), 'capture.focusOffsets.reference')
		expectDiagnostic((c) => (c.capture.focusOffsets.offsets.R = 10.5), 'capture.focusOffsets.offsets.R')
		expectDiagnostic((c) => (c.capture.focusOffsets.offsets.L = 5), 'capture.focusOffsets.offsets.L')
		expect(diagnosticsOf((c) => (c.capture.focusOffsets.offsets.L = 0))).toEqual([])

		// A LIGHT filter named without a known offset; a slot reference is resolved by the preflight.
		expectDiagnostic((c) => (c.capture.groups[0].filter = { kind: 'name', name: 'Ha' }), 'capture.groups[0].filter.name')
		expectDiagnostic((c) => (c.autofocus.filter = { kind: 'name', name: 'Dark' }), 'autofocus.filter.name')
		expect(diagnosticsOf((c) => (c.capture.groups[0].filter = { kind: 'slot', slot: 6 }))).toEqual([])
		// Calibration groups never move the focuser.
		expect(diagnosticsOf((c) => (c.capture.groups[3].filter = { kind: 'name', name: 'Dark' }))).toEqual([])
	})

	test('startup', () => {
		expectDiagnostic((c) => (c.startup.cooling.tolerance = 0), 'startup.cooling.tolerance')
		expectDiagnostic((c) => (c.startup.cooling.stableFor = -1), 'startup.cooling.stableFor')
		expectDiagnostic((c) => (c.startup.cooling.setpoint = Number.NaN), 'startup.cooling.setpoint')
		expectDiagnostic((c) => (c.startup.dome.open = 'yes'), 'startup.dome.open')
		expectDiagnostic((c) => (c.startup.mount.trackMode = 'FAST'), 'startup.mount.trackMode')
		expectDiagnostic((c) => (c.startup.onFailure = 'skip'), 'startup.onFailure')
	})

	test('a target or a meridian flip requires a SIDEREAL startup track mode', () => {
		expectDiagnostic((c) => (c.startup.mount.trackMode = 'LUNAR'), 'startup.mount.trackMode')
		expectDiagnostic((c) => {
			delete c.target
			delete c.pointing
			c.startup.mount.trackMode = 'KING'
		}, 'startup.mount.trackMode')
		expectDiagnostic((c) => {
			c.meridianFlip.enabled = false
			c.startup.mount.trackMode = 'SOLAR'
		}, 'startup.mount.trackMode')
		expect(diagnosticsOf((c) => delete c.startup.mount.trackMode)).toEqual([])
	})

	test('shutdown', () => {
		expectDiagnostic((c) => (c.shutdown.stepTimeout = 0), 'shutdown.stepTimeout')
		expectDiagnostic((c) => (c.shutdown.totalTimeout = Number.POSITIVE_INFINITY), 'shutdown.totalTimeout')
		expectDiagnostic((c) => (c.shutdown.parkMount = 'always'), 'shutdown.parkMount')
		expectDiagnostic((c) => delete c.shutdown.stopTracking, 'shutdown.stopTracking')
	})

	test('pointing requires a target and bounded centering', () => {
		expectDiagnostic((c) => delete c.target, 'pointing')
		expectDiagnostic((c) => (c.pointing.settle = -1), 'pointing.settle')
		expectDiagnostic((c) => (c.pointing.centering.tolerance = 0), 'pointing.centering.tolerance')
		expectDiagnostic((c) => (c.pointing.centering.maximumAttempts = 0), 'pointing.centering.maximumAttempts')
		expectDiagnostic((c) => (c.pointing.centering.solveTimeout = 0), 'pointing.centering.solveTimeout')
		expectDiagnostic((c) => (c.pointing.centering.auxiliary = 'archive'), 'pointing.centering.auxiliary')
		expectDiagnostic((c) => (c.pointing.recenter.afterFrames = 0), 'pointing.recenter.afterFrames')
		expectDiagnostic((c) => (c.pointing.onFailure = 'skip'), 'pointing.onFailure')
	})

	test('rotator, autofocus, guiding and dither', () => {
		expectDiagnostic((c) => (c.rotator.angle = 2 * Math.PI), 'rotator.angle')
		expectDiagnostic((c) => (c.rotator.tolerance = 0), 'rotator.tolerance')
		expectDiagnostic((c) => (c.autofocus.algorithm.stepSize = 0), 'autofocus.algorithm.stepSize')
		expectDiagnostic((c) => (c.autofocus.algorithm.fittingMode = 'CUBIC'), 'autofocus.algorithm.fittingMode')
		expectDiagnostic((c) => (c.autofocus.triggers.afterFrames = 0), 'autofocus.triggers.afterFrames')
		expectDiagnostic((c) => (c.autofocus.triggers.onStart = 1), 'autofocus.triggers.onStart')
		expectDiagnostic((c) => (c.autofocus.measureTimeout = 0), 'autofocus.measureTimeout')
		expectDiagnostic((c) => (c.guiding.settle.pixels = 0), 'guiding.settle.pixels')
		expectDiagnostic((c) => (c.guiding.pauseTimeout = 0), 'guiding.pauseTimeout')
		expectDiagnostic((c) => (c.guiding.maxRecoveries = -1), 'guiding.maxRecoveries')
		expectDiagnostic((c) => (c.dither.afterFrames = 0), 'dither.afterFrames')
		expectDiagnostic((c) => (c.dither.amount = { unit: 'arcsec', value: 1 }), 'dither.amount.unit')
		expectDiagnostic((c) => (c.dither.amount.value = 0), 'dither.amount.value')
		expectDiagnostic((c) => (c.dither.settle = { kind: 'mechanical', time: -1 }), 'dither.settle.time')
		expectDiagnostic((c) => (c.dither.settle = { kind: 'none' }), 'dither.settle.kind')
	})

	test('meridian flip thresholds are ordered hour angles in (-PI, PI]', () => {
		expectDiagnostic((c) => (c.meridianFlip.prepareAt = deg(1)), 'meridianFlip.prepareAt')
		expectDiagnostic((c) => (c.meridianFlip.flipAt = deg(5)), 'meridianFlip.flipAt')
		expectDiagnostic((c) => (c.meridianFlip.prepareAt = -Math.PI), 'meridianFlip.prepareAt')
		expectDiagnostic((c) => (c.meridianFlip.latestAt = deg(181)), 'meridianFlip.latestAt')
		expectDiagnostic((c) => (c.meridianFlip.flipAt = 'now'), 'meridianFlip.flipAt')
	})

	test('meridian flip pier sides are EAST or WEST and distinct', () => {
		expectDiagnostic((c) => (c.meridianFlip.afterFlipPierSide = 'EAST'), 'meridianFlip.afterFlipPierSide')
		expectDiagnostic((c) => (c.meridianFlip.beforeFlipPierSide = 'NEITHER'), 'meridianFlip.beforeFlipPierSide')
		expectDiagnostic((c) => delete c.meridianFlip.afterFlipPierSide, 'meridianFlip.afterFlipPierSide')
	})

	test('meridian flip timings', () => {
		expectDiagnostic((c) => (c.meridianFlip.pierSideTimeout = 0), 'meridianFlip.pierSideTimeout')
		expectDiagnostic((c) => (c.meridianFlip.maxRetries = -1), 'meridianFlip.maxRetries')
		expectDiagnostic((c) => (c.meridianFlip.exposureMargin = -1), 'meridianFlip.exposureMargin')
		expectDiagnostic((c) => (c.meridianFlip.supervisionInterval = 0), 'meridianFlip.supervisionInterval')
		expectDiagnostic((c) => (c.meridianFlip.flipTimeout = Number.NaN), 'meridianFlip.flipTimeout')
		expectDiagnostic((c) => (c.meridianFlip.hardProtection = { trackingTimeout: 0 }), 'meridianFlip.hardProtection.trackingTimeout')
		expectDiagnostic((c) => (c.meridianFlip.whilePaused = 'park'), 'meridianFlip.whilePaused')
		expectDiagnostic((c) => (c.meridianFlip.onFailure = 'skip'), 'meridianFlip.onFailure')
	})

	test('meridian flip window keeps the protection deadlines after the flip is due', () => {
		const margin = DEFAULT_SEQUENCER_MERIDIAN_FLIP.protectionMargin * SIDEREAL_DRIFT_RATE

		// Inclusive: flipAt exactly at latestAt − protectionMargin × rate is accepted.
		expect(diagnosticsOf((c) => (c.meridianFlip.flipAt = c.meridianFlip.latestAt - margin))).toEqual([])
		expectDiagnostic((c) => (c.meridianFlip.flipAt = c.meridianFlip.latestAt - margin + 1e-9), 'meridianFlip.latestAt')
		// A longer margin narrows the window.
		expectDiagnostic((c) => (c.meridianFlip.protectionMargin = 1300), 'meridianFlip.latestAt')
		expectDiagnostic((c) => (c.meridianFlip.protectionMargin = 0), 'meridianFlip.protectionMargin')
	})

	test('safety and execution', () => {
		expectDiagnostic((c) => (c.safety.unsafeAction = 'ignore'), 'safety.unsafeAction')
		expectDiagnostic((c) => (c.safety.onUnsafeAtStartup = 'pause'), 'safety.onUnsafeAtStartup')
		expectDiagnostic((c) => (c.safety.unknownIsUnsafe = 'no'), 'safety.unknownIsUnsafe')
		expectDiagnostic((c) => (c.execution.compensation.timeout = 0), 'execution.compensation.timeout')
	})

	test('collects every diagnostic instead of stopping at the first', () => {
		const diagnostics = diagnosticsOf((c) => {
			c.revision = -1
			c.capture.groups[0].count = -1
			c.meridianFlip.latestAt = deg(-10)
			c.safety.unknownIsUnsafe = 0
		})

		expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual(['revision', 'capture.groups[0].count', 'meridianFlip.flipAt', 'safety.unknownIsUnsafe'])
	})
})

test('system clock reads both domains and waits on the monotonic one', async () => {
	const wall = Date.now()
	const monotonic = performance.now()
	expect(SYSTEM_SEQUENCER_CLOCK.wallNow()).toBeGreaterThanOrEqual(wall)
	expect(SYSTEM_SEQUENCER_CLOCK.monotonicNow()).toBeGreaterThanOrEqual(monotonic)

	const controller = new AbortController()
	const waited = SYSTEM_SEQUENCER_CLOCK.delay(60_000, controller.signal)
	controller.abort()
	expect(await waited).toMatchObject({ ok: false, reason: 'aborted' })

	const start = performance.now()
	expect(await SYSTEM_SEQUENCER_CLOCK.delay(5, new AbortController().signal)).toEqual({ ok: true, value: undefined })
	expect(performance.now() - start).toBeGreaterThanOrEqual(4)
})
