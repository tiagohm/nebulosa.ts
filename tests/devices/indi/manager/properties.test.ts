import { expect, test } from 'bun:test'
import { DEFAULT_COVER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Cover, type FlatPanel, type Focuser, type Power, type Rotator, type Wheel } from '../../../../src/devices/indi/device'
import { CoverManager } from '../../../../src/devices/indi/manager/cover'
import { FlatPanelManager } from '../../../../src/devices/indi/manager/flatpanel'
import { FocuserManager } from '../../../../src/devices/indi/manager/focuser'
import { PowerManager } from '../../../../src/devices/indi/manager/power'
import { RotatorManager } from '../../../../src/devices/indi/manager/rotator'
import { WheelManager } from '../../../../src/devices/indi/manager/wheel'
import { client, setupDevice } from './util'

test('device managers reset deleted device-specific properties to defaults', () => {
	const wheelManager = new WheelManager()
	const wheel = setupDevice<Wheel>(structuredClone(DEFAULT_WHEEL))
	wheelManager.add(wheel)
	wheel.count = 8
	wheel.names = ['L']
	wheel.position = 3
	wheel.moving = true
	wheel.canSetNames = false
	wheelManager.delProperty(client, { device: wheel.name, name: 'FILTER_SLOT' })
	wheelManager.delProperty(client, { device: wheel.name, name: 'FILTER_NAME' })

	const focuserManager = new FocuserManager()
	const focuser = setupDevice<Focuser>(structuredClone(DEFAULT_FOCUSER))
	focuserManager.add(focuser)
	focuser.canAbsoluteMove = true
	focuser.moving = true
	focuser.position.max = 100000
	focuserManager.delProperty(client, { device: focuser.name, name: 'ABS_FOCUS_POSITION' })

	const coverManager = new CoverManager()
	const cover = setupDevice<Cover>(structuredClone(DEFAULT_COVER))
	coverManager.add(cover)
	cover.canAbort = true
	coverManager.delProperty(client, { device: cover.name, name: 'CAP_ABORT' })

	const flatPanelManager = new FlatPanelManager()
	const flatPanel = setupDevice<FlatPanel>(structuredClone(DEFAULT_FLAT_PANEL))
	flatPanelManager.add(flatPanel)
	flatPanel.enabled = true
	flatPanel.intensity.max = 255
	flatPanelManager.delProperty(client, { device: flatPanel.name, name: 'FLAT_LIGHT_CONTROL' })
	flatPanelManager.delProperty(client, { device: flatPanel.name, name: 'FLAT_LIGHT_INTENSITY' })

	const rotatorManager = new RotatorManager()
	const rotator = setupDevice<Rotator>(structuredClone(DEFAULT_ROTATOR))
	rotatorManager.add(rotator)
	rotator.canReverse = true
	rotator.reversed = true
	rotator.angle.max = 360
	rotatorManager.delProperty(client, { device: rotator.name, name: 'ROTATOR_REVERSE' })
	rotatorManager.delProperty(client, { device: rotator.name, name: 'ABS_ROTATOR_ANGLE' })

	const powerManager = new PowerManager()
	const power = setupDevice<Power>(structuredClone(DEFAULT_POWER))
	powerManager.add(power)
	power.dc = [{ type: 'dc', name: 'DC1', label: 'DC1', enabled: true, value: 1, min: 0, max: 10, step: 1 }]
	power.hasPowerCycle = true
	power.voltage.max = 20
	powerManager.delProperty(client, { device: power.name, name: 'POWER_CHANNELS' })
	powerManager.delProperty(client, { device: power.name, name: 'POWER_CYCLE_Toggle' })
	powerManager.delProperty(client, { device: power.name, name: 'POWER_SENSORS' })

	expect(wheel).toMatchObject({ count: DEFAULT_WHEEL.count, names: DEFAULT_WHEEL.names, position: DEFAULT_WHEEL.position, moving: DEFAULT_WHEEL.moving, canSetNames: DEFAULT_WHEEL.canSetNames })
	expect(focuser).toMatchObject({ canAbsoluteMove: DEFAULT_FOCUSER.canAbsoluteMove, moving: DEFAULT_FOCUSER.moving })
	expect(focuser.position).toEqual(DEFAULT_FOCUSER.position)
	expect(cover.canAbort).toBe(DEFAULT_COVER.canAbort)
	expect(flatPanel.enabled).toBe(DEFAULT_FLAT_PANEL.enabled)
	expect(flatPanel.intensity).toEqual(DEFAULT_FLAT_PANEL.intensity)
	expect(rotator).toMatchObject({ canReverse: DEFAULT_ROTATOR.canReverse, reversed: DEFAULT_ROTATOR.reversed })
	expect(rotator.angle).toEqual(DEFAULT_ROTATOR.angle)
	expect(power.dc).toEqual(DEFAULT_POWER.dc)
	expect(power.hasPowerCycle).toBe(DEFAULT_POWER.hasPowerCycle)
	expect(power.voltage).toEqual(DEFAULT_POWER.voltage)
})
