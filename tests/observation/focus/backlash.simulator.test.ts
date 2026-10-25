import { afterAll, describe, expect, test } from 'bun:test'
import { FocuserCommander } from '../../../src/devices/commanders/focuser'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Focuser } from '../../../src/devices/indi/device'
import { FocuserManager } from '../../../src/devices/indi/manager/focuser'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { OperationCoordinator } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { type BacklashCompensation, BacklashCompensator } from '../../../src/observation/focus/backlash'
import { backlashCompensationFromCalibration, type BacklashCalibrationResult } from '../../../src/observation/focus/backlash.calibration'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'

// The compensator over the simulated mechanics: with a play of 120 steps and the overshoot a calibration recommends for
// it (180 steps, 1.5 times the play), every return to the same position ends at the same optical position, while
// uncompensated returns from both sides do not. The play is symmetric because the simulator consumes backlashIn and
// backlashOut independently, so unequal amounts shift the optical position by their difference on every IN/OUT cycle.

const SKIP = isTimeConsumingTestSkipped()

// Requested positions, in steps: returns to 50000 from above and below, some by less than the play.
const TRAJECTORY = [50500, 50000, 49600, 50000, 50050, 50000, 49950, 50000, 50300, 50000]

describe.skipIf(SKIP)('backlash compensation over the focuser simulator', () => {
	const focuserManager = new FocuserManager()
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const commander = new FocuserCommander(focuserManager)
	const handler = new IndiClientHandlerSet([focuserManager])
	const client = new ClientSimulator('Backlash Client', handler)

	afterAll(() => {
		commander.dispose()
		client[Symbol.dispose]()
	})

	// Effective positions of the simulator each time the trajectory arrives at 50000, in steps.
	async function returns(name: string, compensation: BacklashCompensation) {
		using simulator = new FocuserSimulator(name, client, { backlashIn: 120, backlashOut: 120 })
		const focuser: Focuser = focuserManager.get(client, name)!
		focuserManager.connect(focuser)
		await waitUntil(() => focuser.connected && focuser.canAbsoluteMove)

		const compensator = new BacklashCompensator(compensation)
		const effective: number[] = []

		for (const target of TRAJECTORY) {
			for (const position of compensator.compute(target, focuser.position.value)) {
				expect(await commander.moveTo(coordinator, focuser, position)).toMatchObject({ ok: true })
			}

			if (target === 50000) effective.push(simulator.effectivePosition)
		}

		focuserManager.disconnect(focuser)
		return effective
	}

	test('overshoot with a final approach repeats the optical position within one step', async () => {
		const calibration = { recommendedOvershoot: 180 } as BacklashCalibrationResult

		for (const finalApproachDirection of ['OUT', 'IN'] as const) {
			const effective = await returns(`Focuser ${finalApproachDirection}`, backlashCompensationFromCalibration(calibration, { mode: 'OVERSHOOT', finalApproachDirection }))
			expect(Math.max(...effective) - Math.min(...effective)).toBeLessThanOrEqual(1)
		}
	}, 30000)

	test('uncompensated returns from both sides land at different optical positions', async () => {
		const effective = await returns('Focuser NONE', { mode: 'NONE', backlashIn: 0, backlashOut: 0 })
		expect(Math.max(...effective) - Math.min(...effective)).toBeGreaterThan(1)
	}, 30000)
})
