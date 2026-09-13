import { expect, test } from 'bun:test'
import { DEFAULT_COVER } from '../../../../src/devices/indi/device'
import { CoverManager } from '../../../../src/devices/indi/manager/cover'
import { DewHeaterManager } from '../../../../src/devices/indi/manager/dewheater'
import type { DefNumberVector } from '../../../../src/devices/indi/types'
import { createRecordingClient, setupDevice } from './util'

test('sends duty-cycle commands for a cover and its dew-heater proxy', () => {
	const { recordingClient, numberCommands } = createRecordingClient()
	const coverManager = new CoverManager()
	const cover = setupDevice(structuredClone(DEFAULT_COVER), recordingClient)
	coverManager.add(cover)

	const manager = new DewHeaterManager(coverManager)
	const heater: DefNumberVector = {
		device: cover.name,
		name: 'Heater',
		permission: 'rw',
		state: 'Ok',
		elements: {
			Heater: { name: 'Heater', format: '%g', min: 0, max: 150, step: 1, value: 50 },
		},
	}
	manager.numberVector(recordingClient, heater, 'defNumberVector')

	const dewHeater = manager.get(recordingClient, cover.name)
	expect(dewHeater).toBeDefined()

	manager.dutyCycle(cover, 75)
	manager.dutyCycle(dewHeater!, 100)

	expect(numberCommands).toEqual([
		{ device: cover.name, name: 'Heater', elements: { Heater: 75 } },
		{ device: cover.name, name: 'Heater', elements: { Heater: 100 } },
	])

	manager.delProperty(recordingClient, { device: cover.name, name: 'Heater' })
	manager.dutyCycle(cover, 25)
	manager.dutyCycle(dewHeater!, 25)

	expect(numberCommands).toHaveLength(2)
})
