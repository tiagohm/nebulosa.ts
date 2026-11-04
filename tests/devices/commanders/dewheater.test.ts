import { afterEach, expect, spyOn, test } from 'bun:test'
import { DewHeaterCommander } from '../../../src/devices/commanders/dewheater'
import { DEFAULT_DEW_HEATER, type DewHeater } from '../../../src/devices/indi/device'
import type { DeviceProvider } from '../../../src/devices/indi/manager/device'
import { DewHeaterManager } from '../../../src/devices/indi/manager/dewheater'
import type { PropertyState } from '../../../src/devices/indi/types'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'

const heater = makeHeater()
const provider: DeviceProvider<DewHeater> = { get: () => heater }
const dewHeaterManager = new DewHeaterManager(provider)
const dewHeaterCommander = new DewHeaterCommander(dewHeaterManager)
const operationCoordinator = new OperationCoordinator(new ResourceArbiter())

afterEach(() => {
	heater.connected = true
	heater.hasDewHeater = true
	heater.dutyCycle.value = 20
})

function makeHeater(): DewHeater {
	return {
		...structuredClone(DEFAULT_DEW_HEATER),
		id: 'heater-1',
		hardwareId: 'hardware-1',
		name: 'Dew Heater',
		connected: true,
		hasDewHeater: true,
		dutyCycle: { min: 10, max: 90, value: 20, step: 1 },
	}
}

// Answers a duty cycle the way the driver does: the level is applied and reported with the given state.
function echo(state: PropertyState = 'Ok', round = false) {
	return spyOn(dewHeaterManager, 'dutyCycle').mockImplementation((device, value) => {
		if (state !== 'Alert') device.dutyCycle.value = round ? Math.round(value) : value
		dewHeaterManager.updated(device, 'dutyCycle', state)
	})
}

test('clamps the duty cycle to the range published by the heater and resolves once it is reported', async () => {
	const dutyCycle = echo()

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, -5)).toMatchObject({ ok: true })
		expect(heater.dutyCycle.value).toBe(10)
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 45)).toMatchObject({ ok: true })
		expect(heater.dutyCycle.value).toBe(45)
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 120)).toMatchObject({ ok: true })
		expect(heater.dutyCycle.value).toBe(90)
		expect(dutyCycle).toHaveBeenNthCalledWith(1, heater, 10)
		expect(dutyCycle).toHaveBeenNthCalledWith(2, heater, 45)
		expect(dutyCycle).toHaveBeenNthCalledWith(3, heater, 90)
	} finally {
		dutyCycle.mockRestore()
	}
})

test('accepts a duty cycle quantized within half of the published step', async () => {
	const dutyCycle = echo('Ok', true)

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 33.4, { timeout: 50 })).toMatchObject({ ok: true })
		expect(heater.dutyCycle.value).toBe(33)
	} finally {
		dutyCycle.mockRestore()
	}
})

test('times out when the driver never reports the duty cycle', async () => {
	const dutyCycle = spyOn(dewHeaterManager, 'dutyCycle').mockImplementation(() => {})

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 60, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(dutyCycle).toHaveBeenCalledWith(heater, 60)
	} finally {
		dutyCycle.mockRestore()
	}
})

test('fails a duty cycle the driver answers with an Alert', async () => {
	const dutyCycle = echo('Alert')

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 60, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
		expect(heater.dutyCycle.value).toBe(20)
	} finally {
		dutyCycle.mockRestore()
	}
})

test('stops observing the manager once disposed', () => {
	const commander = new DewHeaterCommander(dewHeaterManager)
	const removeHandler = spyOn(dewHeaterManager, 'removeHandler')

	try {
		commander.dispose()
		commander[Symbol.dispose]()
		expect(removeHandler).toHaveBeenCalledTimes(2)
		expect(removeHandler).toHaveBeenCalledWith(commander)
	} finally {
		removeHandler.mockRestore()
	}
})

test('rejects a heater command without a dew-heater channel', async () => {
	const dutyCycle = spyOn(dewHeaterManager, 'dutyCycle').mockImplementation(() => {})
	heater.hasDewHeater = false

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 50)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(dutyCycle).not.toHaveBeenCalled()
	} finally {
		dutyCycle.mockRestore()
	}
})

test('reports a disconnected heater before dispatching a command', async () => {
	const dutyCycle = spyOn(dewHeaterManager, 'dutyCycle').mockImplementation(() => {})
	heater.connected = false

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 50)).toMatchObject(failedOperationResult('disconnected'))
		expect(dutyCycle).not.toHaveBeenCalled()
	} finally {
		dutyCycle.mockRestore()
	}
})

test('does not release the heater to a competing operation before the command completes', async () => {
	const held = operationCoordinator.start<void>(
		'hold',
		[{ key: resourceKey(heater), device: heater }],
		(context) =>
			new Promise((resolve) => {
				context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			}),
	)
	const dutyCycle = spyOn(dewHeaterManager, 'dutyCycle').mockImplementation(() => {})

	try {
		expect(await dewHeaterCommander.dutyCycle(operationCoordinator, heater, 50)).toMatchObject(failedOperationResult('busy'))
	} finally {
		dutyCycle.mockRestore()
		await held.cancel()
	}
})
