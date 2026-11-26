import type { ComponentBus } from '../../src/devices/indi/simulator/component'
import type { SimulatorProperty } from '../../src/devices/indi/simulator/types'

// Component bus with a manual clock that records every property a circuit publishes.
export class TestBus implements ComponentBus {
	readonly published: SimulatorProperty[] = []
	time: number

	constructor(time: number = 0) {
		this.time = time
	}

	readonly notify = (property: SimulatorProperty) => {
		this.published.push(property)
	}

	readonly now = () => this.time

	// Names of the published properties, in order, and forgets them.
	take() {
		const names = this.published.map((e) => e.name)
		this.published.length = 0
		return names
	}
}
