import { clamp } from '../../math/numerical/math'
import type { FlatPanel } from '../indi/device'
import type { FlatPanelManager } from '../indi/manager/flatpanel'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a flat panel.
// Nothing here moves, so no command waits for the device: the driver applies the light state and the
// intensity immediately. They acquire the panel all the same, because a flat sequence exposing against a
// commanded brightness would be silently invalidated by anyone changing it underneath.

// Owns every mutation of a flat panel.
// Each command opens its own nested scope holding the panel, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the panel it already owns.
export class FlatPanelCommander {
	// Keeps the manager the commands are dispatched through.
	constructor(readonly flatPanelManager: FlatPanelManager) {}

	// Turns the light on.
	async enable(scope: OperationScope, panel: FlatPanel): Promise<OperationResult<void>> {
		return await this.#mutate(scope, 'flatPanelEnable', panel, () => this.flatPanelManager.enable(panel))
	}

	// Turns the light off.
	async disable(scope: OperationScope, panel: FlatPanel): Promise<OperationResult<void>> {
		return await this.#mutate(scope, 'flatPanelDisable', panel, () => this.flatPanelManager.disable(panel))
	}

	// Turns the light on when it is off and off when it is on, as last reported by the driver.
	async toggle(scope: OperationScope, panel: FlatPanel): Promise<OperationResult<void>> {
		return await this.#mutate(scope, 'flatPanelToggle', panel, () => this.flatPanelManager.toggle(panel))
	}

	// Sets the brightness, in the driver's own intensity units, resolved against the limits it published.
	async intensity(scope: OperationScope, panel: FlatPanel, value: number): Promise<OperationResult<void>> {
		return await this.#mutate(scope, 'flatPanelIntensity', panel, () => this.flatPanelManager.intensity(panel, clamp(value, panel.intensity.min, panel.intensity.max)))
	}

	// Acquires the panel and dispatches one command that takes effect immediately.
	async #mutate(scope: OperationScope, kind: string, panel: FlatPanel, command: VoidFunction): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(panel), device: panel }], () => {
			if (!panel.connected) return failedOperationResult('disconnected')

			command()

			return successfulOperationResult(undefined)
		}).result
	}
}
