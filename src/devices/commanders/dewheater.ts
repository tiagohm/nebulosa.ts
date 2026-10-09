import { clamp } from '../../math/numerical/math'
import type { DewHeater } from '../indi/device'
import type { DewHeaterManager } from '../indi/manager/dewheater'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a dew heater.
// Nothing here moves, so the command does not wait for the device: the driver applies the PWM level
// immediately. It acquires the heater all the same, and a heater provided by a camera or a cover is
// arbitrated under the key of that device, so raising the duty cycle competes with the exposure or the
// cover motion it would otherwise disturb.

// Owns every mutation of a dew heater.
// The command opens its own nested scope holding the device behind the heater, so a direct endpoint runs it
// as a whole operation tree while a composite feature, passing its own context, inherits what it owns.
export class DewHeaterCommander {
	// Keeps the manager the commands are dispatched through.
	constructor(readonly dewHeaterManager: DewHeaterManager) {}

	// Sets the heating duty cycle, in the driver's own PWM units, resolved against the limits it published.
	async dutyCycle(scope: OperationScope, heater: DewHeater, value: number): Promise<OperationResult<void>> {
		return await scope.start<void>('dewHeaterDutyCycle', [{ key: resourceKey(heater), device: heater }], () => {
			if (!heater.connected) return failedOperationResult('disconnected')
			if (!heater.hasDewHeater) return failedOperationResult('unexpectedState', `device ${heater.name} has no dew heater`)

			this.dewHeaterManager.dutyCycle(heater, clamp(value, heater.dutyCycle.min, heater.dutyCycle.max))

			return successfulOperationResult(undefined)
		}).result
	}
}
