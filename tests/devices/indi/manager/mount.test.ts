import { describe, expect, test } from 'bun:test'
import { CLIENT, DEFAULT_MOUNT } from '../../../../src/devices/indi/device'
import { MountManager } from '../../../../src/devices/indi/manager/mount'
import type { DefNumberVector, DefSwitchVector } from '../../../../src/devices/indi/types'
import { client, createRecordingClient, defNumber, defSwitch, setupDevice } from './util'

const { recordingClient, numberCommands, switchCommands, commands } = createRecordingClient()

test('resets deleted INDI properties to defaults', () => {
	const manager = new MountManager()
	const device = setupDevice(structuredClone(DEFAULT_MOUNT))

	manager.add(device)

	device.slewRates = [{ name: '4x', label: '4x' }]
	device.slewRate = '4x'
	device.trackModes = ['SIDEREAL', 'SOLAR']
	device.trackMode = 'SOLAR'
	device.pierSide = 'WEST'
	device.hasPierSide = true
	device.canPark = true
	device.parking = true
	device.parked = true
	device.equatorialCoordinate.rightAscension = 1
	device.time.utc = 1

	manager.delProperty(client, { device: device.name, name: 'TELESCOPE_SLEW_RATE' })
	manager.delProperty(client, { device: device.name, name: 'TELESCOPE_TRACK_MODE' })
	manager.delProperty(client, { device: device.name, name: 'TELESCOPE_PIER_SIDE' })
	manager.delProperty(client, { device: device.name, name: 'TELESCOPE_PARK' })
	manager.delProperty(client, { device: device.name, name: 'EQUATORIAL_EOD_COORD' })
	manager.delProperty(client, { device: device.name, name: 'TIME_UTC' })

	expect(device.slewRates).toEqual(DEFAULT_MOUNT.slewRates)
	expect(device.slewRate).toBeUndefined()
	expect(device.trackModes).toEqual(DEFAULT_MOUNT.trackModes)
	expect(device.trackMode === DEFAULT_MOUNT.trackMode).toBeTrue()
	expect(device.pierSide === DEFAULT_MOUNT.pierSide).toBeTrue()
	expect(device.hasPierSide).toBe(DEFAULT_MOUNT.hasPierSide)
	expect(device.canPark).toBe(DEFAULT_MOUNT.canPark)
	expect(device.parking).toBe(DEFAULT_MOUNT.parking)
	expect(device.parked).toBe(DEFAULT_MOUNT.parked)
	expect(device.equatorialCoordinate).toEqual(DEFAULT_MOUNT.equatorialCoordinate)
	expect(device.time).toEqual(DEFAULT_MOUNT.time)
})

describe('INDI alignment', () => {
	function setupMount(manager: MountManager) {
		const mount = structuredClone(DEFAULT_MOUNT)
		mount.id = Bun.randomUUIDv7()
		mount.name = 'Mount'
		Object.defineProperty(mount, CLIENT, { value: recordingClient })
		manager.add(mount)
		numberCommands.length = 0
		switchCommands.length = 0
		commands.length = 0
		return mount
	}

	function activeVector(device: string, value: boolean, permission: DefSwitchVector['permission'] = 'rw'): DefSwitchVector {
		return { device, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', permission, rule: 'AtMostOne', state: 'Ok', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': defSwitch('ALIGNMENT SUBSYSTEM ACTIVE', value, 'Alignment Subsystem Active') } }
	}

	function pluginsVector(device: string, selected: string, permission: DefSwitchVector['permission'] = 'rw'): DefSwitchVector {
		return {
			device,
			name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS',
			permission,
			rule: 'OneOfMany',
			state: 'Ok',
			elements: {
				INBUILT_MATH_PLUGIN: defSwitch('INBUILT_MATH_PLUGIN', selected === 'INBUILT_MATH_PLUGIN', 'Inbuilt Math Plugin'),
				'Nearest Math Plugin': defSwitch('Nearest Math Plugin', selected === 'Nearest Math Plugin', 'Nearest'),
				'SVD Math Plugin': defSwitch('SVD Math Plugin', selected === 'SVD Math Plugin', 'SVD'),
				'Custom Plugin': defSwitch('Custom Plugin', selected === 'Custom Plugin'),
			},
		}
	}

	function sizeVector(device: string, value: number): DefNumberVector {
		return { device, name: 'ALIGNMENT_POINTSET_SIZE', permission: 'ro', state: 'Ok', elements: { ALIGNMENT_POINTSET_SIZE: defNumber('ALIGNMENT_POINTSET_SIZE', value, 0, 100000) } }
	}

	function setSizeVector(device: string, value: number) {
		return { device, name: 'ALIGNMENT_POINTSET_SIZE', state: 'Ok', elements: { ALIGNMENT_POINTSET_SIZE: { name: 'ALIGNMENT_POINTSET_SIZE', value } } } as const
	}

	function pointerVector(device: string, permission: DefNumberVector['permission'] = 'rw'): DefNumberVector {
		return { device, name: 'ALIGNMENT_POINTSET_CURRENT_ENTRY', permission, state: 'Ok', elements: { ALIGNMENT_POINTSET_CURRENT_ENTRY: defNumber('ALIGNMENT_POINTSET_CURRENT_ENTRY', 0, 0, 100000) } }
	}

	function actionVector(device: string, permission: DefSwitchVector['permission'] = 'rw'): DefSwitchVector {
		return {
			device,
			name: 'ALIGNMENT_POINTSET_ACTION',
			permission,
			rule: 'OneOfMany',
			state: 'Ok',
			elements: {
				APPEND: defSwitch('APPEND', true),
				DELETE: defSwitch('DELETE', false),
				CLEAR: defSwitch('CLEAR', false),
				'LOAD DATABASE': defSwitch('LOAD DATABASE', false),
				'SAVE DATABASE': defSwitch('SAVE DATABASE', false),
			},
		}
	}

	function commitVector(device: string, permission: DefSwitchVector['permission'] = 'rw'): DefSwitchVector {
		return { device, name: 'ALIGNMENT_POINTSET_COMMIT', permission, rule: 'AtMostOne', state: 'Ok', elements: { ALIGNMENT_POINTSET_COMMIT: defSwitch('ALIGNMENT_POINTSET_COMMIT', false) } }
	}

	function initialiseVector(device: string, permission: DefSwitchVector['permission'] = 'rw'): DefSwitchVector {
		return { device, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', permission, rule: 'AtMostOne', state: 'Ok', elements: { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: defSwitch('ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', false) } }
	}

	function setupAlignment(manager: MountManager, size = 0) {
		const mount = setupMount(manager)

		manager.numberVector(recordingClient, sizeVector(mount.name, size), 'defNumberVector')
		manager.numberVector(recordingClient, pointerVector(mount.name), 'defNumberVector')
		manager.switchVector(recordingClient, actionVector(mount.name), 'defSwitchVector')
		manager.switchVector(recordingClient, commitVector(mount.name), 'defSwitchVector')
		manager.switchVector(recordingClient, activeVector(mount.name, true), 'defSwitchVector')
		manager.switchVector(recordingClient, pluginsVector(mount.name, 'INBUILT_MATH_PLUGIN'), 'defSwitchVector')
		manager.switchVector(recordingClient, initialiseVector(mount.name), 'defSwitchVector')

		numberCommands.length = 0
		switchCommands.length = 0
		commands.length = 0

		return mount
	}

	test('defaults to an unavailable subsystem', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		expect(mount.alignment).toEqual(DEFAULT_MOUNT.alignment)
		expect(mount.alignment).not.toBe(DEFAULT_MOUNT.alignment)

		manager.alignmentActive(mount, true)
		manager.alignmentPlugin(mount, 'INBUILT_MATH_PLUGIN')
		manager.alignmentInitialize(mount)
		manager.alignmentClear(mount)
		manager.alignmentSave(mount)
		manager.alignmentLoad(mount)
		manager.alignmentDeleteLastPoint(mount)

		expect(commands).toBeEmpty()
	})

	test('tracks availability and the active switch', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)
		const updates: string[] = []
		manager.addHandler({ added: () => {}, removed: () => {}, updated: (_, property) => updates.push(property) })

		manager.switchVector(recordingClient, activeVector(mount.name, false), 'defSwitchVector')

		expect(mount.alignment.available).toBeTrue()
		expect(mount.alignment.active).toBeFalse()
		expect(updates).toEqual(['alignment'])

		manager.switchVector(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', state: 'Ok', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': { name: 'ALIGNMENT SUBSYSTEM ACTIVE', value: true } } }, 'setSwitchVector')
		expect(mount.alignment.active).toBeTrue()

		manager.switchVector(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', state: 'Ok', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': { name: 'ALIGNMENT SUBSYSTEM ACTIVE', value: false } } }, 'setSwitchVector')
		expect(mount.alignment.active).toBeFalse()
	})

	test('never lets the any-switch-on fallback override an explicit off', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		manager.switchVector(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', permission: 'rw', rule: 'AtMostOne', state: 'Ok', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': defSwitch('ALIGNMENT SUBSYSTEM ACTIVE', false), SOMETHING_ELSE: defSwitch('SOMETHING_ELSE', true) } }, 'defSwitchVector')

		expect(mount.alignment.available).toBeTrue()
		expect(mount.alignment.active).toBeFalse()

		manager.switchVector(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', permission: 'rw', rule: 'AtMostOne', state: 'Ok', elements: { RENAMED: defSwitch('RENAMED', true) } }, 'defSwitchVector')
		expect(mount.alignment.active).toBeTrue()
	})

	test('commands the active switch through the element the driver defined', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		manager.switchVector(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', permission: 'rw', rule: 'AtMostOne', state: 'Ok', elements: { RENAMED: defSwitch('RENAMED', false) } }, 'defSwitchVector')
		manager.alignmentActive(mount, true)

		expect(switchCommands).toEqual([{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', elements: { RENAMED: true } }])

		// The INDI member wins over any other advertised element.
		manager.switchVector(recordingClient, activeVector(mount.name, false), 'defSwitchVector')
		switchCommands.length = 0
		manager.alignmentActive(mount, true)

		expect(switchCommands).toEqual([{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': true } }])

		// A deletion drops the remembered name along with the capability.
		manager.delProperty(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE' })
		switchCommands.length = 0
		manager.alignmentActive(mount, true)

		expect(switchCommands).toBeEmpty()
	})

	test('reflects the advertised math plugins and the selected one', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		manager.switchVector(recordingClient, pluginsVector(mount.name, 'SVD Math Plugin'), 'defSwitchVector')

		expect(mount.alignment.plugins).toEqual([
			{ name: 'INBUILT_MATH_PLUGIN', label: 'Inbuilt Math Plugin' },
			{ name: 'Nearest Math Plugin', label: 'Nearest' },
			{ name: 'SVD Math Plugin', label: 'SVD' },
			{ name: 'Custom Plugin', label: 'Custom Plugin' },
		])
		expect(mount.alignment.plugin).toBe('SVD Math Plugin')

		manager.switchVector(
			recordingClient,
			{
				device: mount.name,
				name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS',
				state: 'Ok',
				elements: {
					INBUILT_MATH_PLUGIN: { name: 'INBUILT_MATH_PLUGIN', value: false },
					'Nearest Math Plugin': { name: 'Nearest Math Plugin', value: true },
					'SVD Math Plugin': { name: 'SVD Math Plugin', value: false },
					'Custom Plugin': { name: 'Custom Plugin', value: false },
				},
			},
			'setSwitchVector',
		)

		expect(mount.alignment.plugin).toBe('Nearest Math Plugin')
		expect(mount.alignment.plugins).toHaveLength(4)

		manager.switchVector(
			recordingClient,
			{
				device: mount.name,
				name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS',
				state: 'Ok',
				elements: {
					INBUILT_MATH_PLUGIN: { name: 'INBUILT_MATH_PLUGIN', value: false },
					'Nearest Math Plugin': { name: 'Nearest Math Plugin', value: false },
					'SVD Math Plugin': { name: 'SVD Math Plugin', value: false },
					'Custom Plugin': { name: 'Custom Plugin', value: false },
				},
			},
			'setSwitchVector',
		)

		expect(mount.alignment.plugin).toBeUndefined()
	})

	test('normalizes the point count and accepts it before the subsystem is announced', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		manager.numberVector(recordingClient, sizeVector(mount.name, 3), 'defNumberVector')

		expect(mount.alignment.available).toBeFalse()
		expect(mount.alignment.pointCount).toBe(3)

		manager.numberVector(recordingClient, setSizeVector(mount.name, 2.9), 'setNumberVector')
		expect(mount.alignment.pointCount).toBe(2)

		manager.numberVector(recordingClient, setSizeVector(mount.name, -1), 'setNumberVector')
		expect(mount.alignment.pointCount).toBe(0)

		manager.numberVector(recordingClient, setSizeVector(mount.name, 4), 'setNumberVector')
		manager.numberVector(recordingClient, setSizeVector(mount.name, Number.NaN), 'setNumberVector')
		expect(mount.alignment.pointCount).toBe(4)
	})

	test('commands active, plugin and initialize without touching local state', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager)

		manager.alignmentActive(mount, false)
		manager.alignmentPlugin(mount, { name: 'SVD Math Plugin', label: 'SVD' })
		manager.alignmentPlugin(mount, 'Custom Plugin')
		manager.alignmentPlugin(mount, 'Unknown Plugin')
		manager.alignmentInitialize(mount)

		expect(switchCommands).toEqual([
			{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', elements: { 'ALIGNMENT SUBSYSTEM ACTIVE': false } },
			{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS', elements: { 'SVD Math Plugin': true } },
			{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS', elements: { 'Custom Plugin': true } },
			{ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', elements: { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true } },
		])

		expect(mount.alignment.active).toBeTrue()
		expect(mount.alignment.plugin).toBe('INBUILT_MATH_PLUGIN')
	})

	test('deletes a point in pointer/action/commit/initialize order', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 3)

		manager.alignmentDeletePoint(mount, 1)

		expect(commands).toEqual([
			['number', 'ALIGNMENT_POINTSET_CURRENT_ENTRY', { ALIGNMENT_POINTSET_CURRENT_ENTRY: 1 }],
			['switch', 'ALIGNMENT_POINTSET_ACTION', { DELETE: true }],
			['switch', 'ALIGNMENT_POINTSET_COMMIT', { ALIGNMENT_POINTSET_COMMIT: true }],
			['switch', 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true }],
		])

		expect(mount.alignment.pointCount).toBe(3)
	})

	test('rejects out-of-range and non-integer delete indices', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 3)

		manager.alignmentDeletePoint(mount, -1)
		manager.alignmentDeletePoint(mount, 3)
		manager.alignmentDeletePoint(mount, 1.5)
		manager.alignmentDeletePoint(mount, Number.NaN)

		expect(commands).toBeEmpty()

		manager.numberVector(recordingClient, setSizeVector(mount.name, 0), 'setNumberVector')
		manager.alignmentDeletePoint(mount, 0)

		expect(commands).toBeEmpty()
	})

	test('deletes the last point by index', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 0)

		manager.alignmentDeleteLastPoint(mount)
		expect(commands).toBeEmpty()

		manager.numberVector(recordingClient, setSizeVector(mount.name, 1), 'setNumberVector')
		manager.alignmentDeleteLastPoint(mount)
		expect(numberCommands).toEqual([{ device: mount.name, name: 'ALIGNMENT_POINTSET_CURRENT_ENTRY', elements: { ALIGNMENT_POINTSET_CURRENT_ENTRY: 0 } }])

		numberCommands.length = 0
		manager.numberVector(recordingClient, setSizeVector(mount.name, 4), 'setNumberVector')
		manager.alignmentDeleteLastPoint(mount)
		expect(numberCommands).toEqual([{ device: mount.name, name: 'ALIGNMENT_POINTSET_CURRENT_ENTRY', elements: { ALIGNMENT_POINTSET_CURRENT_ENTRY: 3 } }])
	})

	test('clears, saves and loads the database', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 2)

		manager.alignmentClear(mount)

		expect(commands).toEqual([
			['switch', 'ALIGNMENT_POINTSET_ACTION', { CLEAR: true }],
			['switch', 'ALIGNMENT_POINTSET_COMMIT', { ALIGNMENT_POINTSET_COMMIT: true }],
			['switch', 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true }],
		])
		expect(mount.alignment.pointCount).toBe(2)

		commands.length = 0
		manager.alignmentSave(mount)

		expect(commands).toEqual([
			['switch', 'ALIGNMENT_POINTSET_ACTION', { 'SAVE DATABASE': true }],
			['switch', 'ALIGNMENT_POINTSET_COMMIT', { ALIGNMENT_POINTSET_COMMIT: true }],
		])

		commands.length = 0
		manager.alignmentLoad(mount)

		expect(commands).toEqual([
			['switch', 'ALIGNMENT_POINTSET_ACTION', { 'LOAD DATABASE': true }],
			['switch', 'ALIGNMENT_POINTSET_COMMIT', { ALIGNMENT_POINTSET_COMMIT: true }],
			['switch', 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true }],
		])
	})

	test('resets the alignment state on property deletion', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 3)

		expect(mount.alignment.available).toBeTrue()
		expect(mount.alignment.active).toBeTrue()
		expect(mount.alignment.plugin).toBe('INBUILT_MATH_PLUGIN')
		expect(mount.alignment.pointCount).toBe(3)

		manager.delProperty(recordingClient, { device: mount.name, name: 'ALIGNMENT_POINTSET_SIZE' })
		expect(mount.alignment.pointCount).toBe(0)

		manager.delProperty(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS' })
		expect(mount.alignment.plugins).toBeEmpty()
		expect(mount.alignment.plugin).toBeUndefined()

		manager.delProperty(recordingClient, { device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE' })
		expect(mount.alignment.available).toBeFalse()
		expect(mount.alignment.active).toBeFalse()

		manager.delProperty(recordingClient, { device: mount.name, name: 'ALIGNMENT_POINTSET_ACTION' })
		commands.length = 0

		manager.alignmentClear(mount)
		expect(commands).toBeEmpty()
	})

	test('restores the alignment defaults on a full deletion', () => {
		const manager = new MountManager()
		const mount = setupAlignment(manager, 3)

		manager.delProperty(recordingClient, { device: mount.name })

		expect(mount.alignment).toEqual(DEFAULT_MOUNT.alignment)
		expect(manager.has(recordingClient, mount.name)).toBeFalse()
	})

	test('keeps the raw alignment properties in the property cache', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)
		const plugins = pluginsVector(mount.name, 'SVD Math Plugin')

		manager.vector(recordingClient, plugins, 'defSwitchVector')
		manager.switchVector(recordingClient, plugins, 'defSwitchVector')

		const properties = manager.properties.get(mount)

		expect(properties?.ALIGNMENT_SUBSYSTEM_MATH_PLUGINS).toBe(plugins as never)
		expect(properties?.ALIGNMENT_SUBSYSTEM_MATH_PLUGINS.elements['SVD Math Plugin'].value).toBeTrue()
		expect(mount.alignment.plugin).toBe('SVD Math Plugin')
	})

	test('leaves the existing mount commands unaffected', () => {
		const manager = new MountManager()
		const mount = setupMount(manager)

		manager.switchVector(recordingClient, { device: mount.name, name: 'TELESCOPE_PARK', permission: 'rw', rule: 'OneOfMany', state: 'Ok', elements: { PARK: defSwitch('PARK', false), UNPARK: defSwitch('UNPARK', true) } }, 'defSwitchVector')
		manager.switchVector(recordingClient, { device: mount.name, name: 'TELESCOPE_SLEW_RATE', permission: 'rw', rule: 'OneOfMany', state: 'Ok', elements: { SLEW_MAX: defSwitch('SLEW_MAX', true, 'Max') } }, 'defSwitchVector')
		switchCommands.length = 0

		manager.park(mount)
		manager.slewRate(mount, 'SLEW_MAX')

		expect(switchCommands).toEqual([
			{ device: mount.name, name: 'TELESCOPE_PARK', elements: { PARK: true } },
			{ device: mount.name, name: 'TELESCOPE_SLEW_RATE', elements: { SLEW_MAX: true } },
		])
		expect(mount.alignment.available).toBeFalse()
	})
})
