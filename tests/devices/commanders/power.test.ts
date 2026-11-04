import { expect, spyOn, test } from 'bun:test'
import { PowerCommander } from '../../../src/devices/commanders/power'
import { type Client, DeviceInterfaceType, type Power, type PowerChannelType } from '../../../src/devices/indi/device'
import { PowerManager } from '../../../src/devices/indi/manager/power'
import type { DefNumberVector, DefSwitchVector, OneNumber, OneSwitch, PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'
import { client as baseClient, defNumber, defSwitch, driverInfo } from '../indi/manager/util'

// How the fake driver answers a command: echoes it, ignores it, or refuses it with an Alert that keeps the
// previous values. Drivers echo numbers rounded to the step they publish, which `step` reproduces.
type Reply = 'echo' | 'none' | 'alert'

// Vector names of each channel type, as the INDI power interface defines them.
const SWITCH_VECTORS: Readonly<Record<string, PowerChannelType>> = { POWER_CHANNELS: 'dc', DEW_CHANNELS: 'dew', VARIABLE_CHANNELS: 'variableVoltage', USB_PORTS: 'usb', AUTO_DEW_CONTROL: 'autoDew' }
const NUMBER_VECTORS: Readonly<Record<string, PowerChannelType>> = { DEW_DUTY_CYCLES: 'dew', VARIABLE_VOLTAGES: 'variableVoltage' }

function setup() {
	const manager = new PowerManager()
	const arbiter = new ResourceArbiter()
	const coordinator = new OperationCoordinator(arbiter)
	const lifecycle = new DeviceLifecycle(arbiter, coordinator)
	lifecycle.observe(manager)
	const commander = new PowerCommander(manager)
	const state = { reply: 'echo' as Reply }

	// Answers with the whole vector, as drivers do: the manager maps the elements of a channel list by position.
	function answer(name: string, kind: 'switch' | 'number', elements: Record<string, number | boolean>) {
		if (state.reply === 'none') return

		const type = kind === 'switch' ? SWITCH_VECTORS[name] : NUMBER_VECTORS[name]
		const alert = state.reply === 'alert'
		const vectorState: PropertyState = alert ? 'Alert' : 'Ok'

		if (kind === 'switch') {
			const values: Record<string, OneSwitch> = {}
			for (const channel of power[type]) values[channel.name] = { name: channel.name, value: !alert && channel.name in elements ? (elements[channel.name] as boolean) : channel.enabled }
			manager.switchVector(fake, { device: power.name, name, state: vectorState, elements: values }, 'setSwitchVector')
		} else {
			const values: Record<string, OneNumber> = {}
			for (const channel of power[type]) values[channel.name] = { name: channel.name, value: !alert && channel.name in elements ? Math.round((elements[channel.name] as number) / channel.step) * channel.step : channel.value }
			manager.numberVector(fake, { device: power.name, name, state: vectorState, elements: values }, 'setNumberVector')
		}
	}

	const fake: Client = {
		...baseClient,
		id: 'power',
		sendSwitch: (vector) => {
			if (vector.name === 'CONNECTION') manager.switchVector(fake, connection(vector.elements.CONNECT === true), 'setSwitchVector')
			else answer(vector.name, 'switch', vector.elements)
		},
		sendNumber: (vector) => answer(vector.name, 'number', vector.elements),
	}

	function connection(connected: boolean): DefSwitchVector {
		return { device: 'Power', name: 'CONNECTION', state: 'Ok', permission: 'rw', rule: 'OneOfMany', elements: { CONNECT: defSwitch('CONNECT', connected), DISCONNECT: defSwitch('DISCONNECT', !connected) } }
	}

	function switches(name: string, ...channels: [string, boolean][]): DefSwitchVector {
		return { device: 'Power', name, state: 'Ok', permission: 'rw', rule: 'AnyOfMany', elements: Object.fromEntries(channels.map(([n, v]) => [n, defSwitch(n, v)])) }
	}

	function numbers(name: string, min: number, max: number, step: number, ...channels: [string, number][]): DefNumberVector {
		return { device: 'Power', name, state: 'Ok', permission: 'rw', elements: Object.fromEntries(channels.map(([n, v]) => [n, defNumber(n, v, min, max, step)])) }
	}

	manager.textVector(fake, driverInfo('Power', DeviceInterfaceType.POWER), 'defTextVector')
	const power: Power = manager.get(fake, 'Power')!
	manager.switchVector(fake, connection(true), 'defSwitchVector')
	manager.switchVector(fake, switches('POWER_CHANNELS', ['POWER_CHANNEL_1', false], ['POWER_CHANNEL_2', true]), 'defSwitchVector')
	manager.switchVector(fake, switches('DEW_CHANNELS', ['DEW_CHANNEL_1', false]), 'defSwitchVector')
	manager.numberVector(fake, numbers('DEW_DUTY_CYCLES', 0, 100, 1, ['DEW_CHANNEL_1', 0]), 'defNumberVector')
	manager.switchVector(fake, switches('VARIABLE_CHANNELS', ['VARIABLE_CHANNEL_1', false]), 'defSwitchVector')
	manager.numberVector(fake, numbers('VARIABLE_VOLTAGES', 3, 12, 0.5, ['VARIABLE_CHANNEL_1', 5]), 'defNumberVector')

	const dispose = () => {
		commander.dispose()
		lifecycle.dispose()
	}

	return { manager, arbiter, coordinator, commander, power, state, dispose }
}

test('switches an output on and off and resolves once the driver reports it', async () => {
	const { coordinator, commander, power, arbiter, dispose } = setup()

	try {
		await waitUntil(() => arbiter.availability(resourceKey(power)) === 'available')
		const [channel] = power.dc

		expect(await commander.toggle(coordinator, power, channel, true)).toMatchObject({ ok: true })
		expect(power.dc[0].enabled).toBeTrue()
		expect(power.dc[1].enabled).toBeTrue()

		expect(await commander.toggle(coordinator, power, channel, false)).toMatchObject({ ok: true })
		expect(power.dc[0].enabled).toBeFalse()
		expect(power.dc[1].enabled).toBeTrue()

		expect(await commander.toggle(coordinator, power, power.variableVoltage[0], true)).toMatchObject({ ok: true })
		expect(power.variableVoltage[0].enabled).toBeTrue()
	} finally {
		dispose()
	}
})

test('addresses a channel by type and name, not by the object kept by the caller', async () => {
	const { manager, coordinator, commander, power, dispose } = setup()
	const toggle = spyOn(manager, 'toggle')

	try {
		const stale = { ...power.dc[1] }
		expect(await commander.toggle(coordinator, power, stale, false)).toMatchObject({ ok: true })
		expect(toggle).toHaveBeenCalledWith(power, power.dc[1], false)
		expect(power.dc[1].enabled).toBeFalse()
	} finally {
		toggle.mockRestore()
		dispose()
	}
})

test('clamps the voltage and the duty cycle and accepts a value quantized to the step', async () => {
	const { manager, coordinator, commander, power, dispose } = setup()
	const voltage = spyOn(manager, 'voltage')
	const dutyCycle = spyOn(manager, 'dutyCycle')

	try {
		const [variable] = power.variableVoltage
		const [dew] = power.dew

		expect(await commander.voltage(coordinator, power, variable, 20)).toMatchObject({ ok: true })
		expect(power.variableVoltage[0].value).toBe(12)
		expect(await commander.voltage(coordinator, power, variable, 7.6)).toMatchObject({ ok: true })
		expect(power.variableVoltage[0].value).toBe(7.5)
		expect(await commander.dutyCycle(coordinator, power, dew, -10)).toMatchObject({ ok: true })
		expect(power.dew[0].value).toBe(0)
		expect(await commander.dutyCycle(coordinator, power, dew, 42)).toMatchObject({ ok: true })
		expect(power.dew[0].value).toBe(42)

		expect(voltage).toHaveBeenNthCalledWith(1, power, power.variableVoltage[0], 12)
		expect(voltage).toHaveBeenNthCalledWith(2, power, power.variableVoltage[0], 7.6)
		expect(dutyCycle).toHaveBeenNthCalledWith(1, power, power.dew[0], 0)
		expect(dutyCycle).toHaveBeenNthCalledWith(2, power, power.dew[0], 42)
	} finally {
		voltage.mockRestore()
		dutyCycle.mockRestore()
		dispose()
	}
})

test('refuses a numeric command on a channel of another type or on a channel the box does not publish', async () => {
	const { manager, coordinator, commander, power, dispose } = setup()
	const voltage = spyOn(manager, 'voltage')
	const dutyCycle = spyOn(manager, 'dutyCycle')
	const toggle = spyOn(manager, 'toggle')

	try {
		expect(await commander.voltage(coordinator, power, power.dew[0], 5)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(await commander.dutyCycle(coordinator, power, power.dc[0], 50)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(await commander.toggle(coordinator, power, { ...power.dc[0], name: 'POWER_CHANNEL_9' }, true)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(await commander.voltage(coordinator, power, { ...power.variableVoltage[0], name: 'VARIABLE_CHANNEL_9' }, 5)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(voltage).not.toHaveBeenCalled()
		expect(dutyCycle).not.toHaveBeenCalled()
		expect(toggle).not.toHaveBeenCalled()
	} finally {
		voltage.mockRestore()
		dutyCycle.mockRestore()
		toggle.mockRestore()
		dispose()
	}
})

test('fails a command the driver answers with an Alert', async () => {
	const { coordinator, commander, power, state, dispose } = setup()

	try {
		state.reply = 'alert'
		expect(await commander.toggle(coordinator, power, power.dc[0], true, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
		expect(await commander.dutyCycle(coordinator, power, power.dew[0], 50, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
		expect(power.dc[0].enabled).toBeFalse()
		expect(power.dew[0].value).toBe(0)
	} finally {
		dispose()
	}
})

test('times out when the driver never reports the commanded state and releases the box', async () => {
	const { coordinator, commander, power, state, arbiter, dispose } = setup()

	try {
		state.reply = 'none'
		expect(await commander.toggle(coordinator, power, power.dc[0], true, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(await commander.voltage(coordinator, power, power.variableVoltage[0], 9, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(arbiter.availability(resourceKey(power))).toBe('available')
	} finally {
		dispose()
	}
})

test('resolves at once when the channel already stands in the commanded state', async () => {
	const { coordinator, commander, power, state, dispose } = setup()

	try {
		state.reply = 'none'
		expect(await commander.toggle(coordinator, power, power.dc[1], true, { timeout: 30 })).toMatchObject({ ok: true })
		expect(await commander.voltage(coordinator, power, power.variableVoltage[0], 5, { timeout: 30 })).toMatchObject({ ok: true })
	} finally {
		dispose()
	}
})

test('fails a pending command when the box disconnects', async () => {
	const { manager, coordinator, commander, power, state, dispose } = setup()

	try {
		state.reply = 'none'
		const command = commander.toggle(coordinator, power, power.dc[0], true, { timeout: 1000 })
		await Bun.sleep(10)
		manager.disconnect(power)
		expect((await command).ok).toBeFalse()
	} finally {
		dispose()
	}
})

test('reports a disconnected box before dispatching a command', async () => {
	const { manager, commander, power, dispose } = setup()
	const toggle = spyOn(manager, 'toggle')

	try {
		manager.disconnect(power)
		expect(power.connected).toBeFalse()
		const isolatedArbiter = new ResourceArbiter()
		isolatedArbiter.markAvailable({ key: resourceKey(power), device: power })
		const isolatedCoordinator = new OperationCoordinator(isolatedArbiter)
		expect(await commander.toggle(isolatedCoordinator, power, power.dc[0], true)).toMatchObject(failedOperationResult('disconnected'))
		expect(await commander.dutyCycle(isolatedCoordinator, power, power.dew[0], 10)).toMatchObject(failedOperationResult('disconnected'))
		expect(toggle).not.toHaveBeenCalled()
	} finally {
		toggle.mockRestore()
		dispose()
	}
})

test('refuses a command while another operation owns the box', async () => {
	const { manager, coordinator, commander, power, arbiter, dispose } = setup()
	const toggle = spyOn(manager, 'toggle')

	try {
		const held = coordinator.start<void>(
			'hold',
			[{ key: resourceKey(power), device: power }],
			(context) =>
				new Promise((resolve) => {
					context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
				}),
		)

		expect(await commander.toggle(coordinator, power, power.dc[0], true)).toMatchObject(failedOperationResult('busy'))
		expect(toggle).not.toHaveBeenCalled()
		await held.cancel()
		expect(arbiter.availability(resourceKey(power))).toBe('available')
	} finally {
		toggle.mockRestore()
		dispose()
	}
})

test('stops observing the manager once disposed', () => {
	const manager = new PowerManager()
	const commander = new PowerCommander(manager)
	const removeHandler = spyOn(manager, 'removeHandler')

	try {
		commander.dispose()
		commander[Symbol.dispose]()
		expect(removeHandler).toHaveBeenCalledTimes(2)
		expect(removeHandler).toHaveBeenCalledWith(commander)
	} finally {
		removeHandler.mockRestore()
	}
})
