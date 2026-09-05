import { expect, test } from 'bun:test'
import { CLIENT, DEFAULT_GUIDE_OUTPUT, type GuideDirection, type GuideOutput } from '../../../src/devices/indi/device'
import type { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { dispatchDitherPulses } from '../../../src/observation/guiding/dither.executor'
import type { DitherPulsePlan } from '../../../src/observation/guiding/dither.pulse'

interface PulseRecord {
	readonly direction: GuideDirection
	readonly duration: number
}

function makeManager() {
	const pulses: PulseRecord[] = []
	const manager = {
		pulse: (_device: GuideOutput, direction: GuideDirection, duration: number) => {
			pulses.push({ direction, duration })
		},
	}
	return { manager: manager as unknown as GuideOutputManager, pulses }
}

function makeGuideOutput(overrides: Partial<GuideOutput> = {}, attached = true): GuideOutput {
	const output = structuredClone(DEFAULT_GUIDE_OUTPUT)
	output.id = 'guide-1'
	output.name = 'Mount'
	output.connected = true
	output.canPulseGuide = true
	Object.assign(output, overrides)
	if (attached) Object.assign(output, { [CLIENT]: {} })
	return output
}

const PLAN: DitherPulsePlan = { rightAscension: { direction: 'WEST', duration: 250 }, declination: { direction: 'SOUTH', duration: 125 } }

test('translates both axes into INDI guide directions', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput(), PLAN)).toBe(true)
	expect(pulses).toEqual([
		{ direction: 'WEST', duration: 250 },
		{ direction: 'SOUTH', duration: 125 },
	])
})

test('translates the remaining direction names', () => {
	const { manager, pulses } = makeManager()
	const plan: DitherPulsePlan = { rightAscension: { direction: 'EAST', duration: 1 }, declination: { direction: 'NORTH', duration: 2 } }

	dispatchDitherPulses(manager, makeGuideOutput(), plan)

	expect(pulses).toEqual([
		{ direction: 'EAST', duration: 1 },
		{ direction: 'NORTH', duration: 2 },
	])
})

test('dispatches a single axis when the other is absent', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput(), { declination: { direction: 'NORTH', duration: 40 } })).toBe(true)
	expect(pulses).toEqual([{ direction: 'NORTH', duration: 40 }])
})

test('does nothing for an empty plan', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput(), {})).toBe(false)
	expect(pulses).toBeEmpty()
})

test('does nothing when the signal is already aborted', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput(), PLAN, AbortSignal.abort())).toBe(false)
	expect(pulses).toBeEmpty()
})

test('dispatches while the signal is not aborted', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput(), PLAN, new AbortController().signal)).toBe(true)
	expect(pulses).toHaveLength(2)
})

test('does nothing when the device cannot pulse guide', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput({ canPulseGuide: false }), PLAN)).toBe(false)
	expect(pulses).toBeEmpty()
})

test('does nothing when the device has no owning client', () => {
	const { manager, pulses } = makeManager()

	expect(dispatchDitherPulses(manager, makeGuideOutput({}, false), PLAN)).toBe(false)
	expect(pulses).toBeEmpty()
})
