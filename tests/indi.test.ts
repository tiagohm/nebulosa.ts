import { describe, expect, onTestFinished, test } from 'bun:test'
import { type DefSwitchVector, IndiClient, type IndiClientHandler, type PropertyState } from '../src/indi'
import { type Camera, CameraManager, type DeviceHandler, type DeviceProperty, type DevicePropertyHandler, DevicePropertyManager, type GuideOutput, GuideOutputManager, type Mount, MountManager, type Thermometer, ThermometerManager } from '../src/indi.manager'
import { SimpleXmlParser } from '../src/xml'

const text = await Bun.file('data/indi.log').text()
const parser = new SimpleXmlParser()
const tags = parser.parse(text)

expect(tags).toHaveLength(85)

describe('parseXml', () => {
	test('defSwitchVector', () => {
		const node = tags.find((e) => e.name === 'defSwitchVector' && e.attributes.name === 'CONNECTION')!

		expect(node.name).toBe('defSwitchVector')
		expect(node.attributes.device).toBe('CCD Simulator')
		expect(node.attributes.name).toBe('CONNECTION')
		expect(node.attributes.label).toBe('Connection')
		expect(node.attributes.group).toBe('Main Control')
		expect(node.attributes.state).toBe('Idle')
		expect(node.attributes.perm).toBe('rw')
		expect(node.attributes.rule).toBe('OneOfMany')
		expect(node.attributes.timeout).toBe('60')
		expect(node.attributes.timestamp).toBe('2025-03-11T12:43:02')
		expect(node.text).toBeEmpty()
		expect(node.children).toHaveLength(2)
		expect(node.children[0].name).toBe('defSwitch')
		expect(node.children[0].attributes.name).toBe('CONNECT')
		expect(node.children[0].attributes.label).toBe('Connect')
		expect(node.children[0].text).toBe('Off')
		expect(node.children[1].name).toBe('defSwitch')
		expect(node.children[1].attributes.name).toBe('DISCONNECT')
		expect(node.children[1].attributes.label).toBe('Disconnect')
		expect(node.children[1].text).toBe('On')
	})

	test('defTextVector', () => {
		const node = tags.find((e) => e.name === 'defTextVector' && e.attributes.name === 'DRIVER_INFO')!

		expect(node.name).toBe('defTextVector')
		expect(node.attributes.device).toBe('CCD Simulator')
		expect(node.attributes.name).toBe('DRIVER_INFO')
		expect(node.attributes.label).toBe('Driver Info')
		expect(node.attributes.group).toBe('General Info')
		expect(node.attributes.state).toBe('Idle')
		expect(node.attributes.perm).toBe('ro')
		expect(node.attributes.rule).toBeUndefined()
		expect(node.attributes.timeout).toBe('60')
		expect(node.attributes.timestamp).toBe('2025-03-11T12:43:02')
		expect(node.text).toBeEmpty()
		expect(node.children).toHaveLength(4)
		expect(node.children[0].name).toBe('defText')
		expect(node.children[0].attributes.name).toBe('DRIVER_NAME')
		expect(node.children[0].attributes.label).toBe('Name')
		expect(node.children[0].text).toBe('CCD Simulator')
		expect(node.children[1].name).toBe('defText')
		expect(node.children[1].attributes.name).toBe('DRIVER_EXEC')
		expect(node.children[1].attributes.label).toBe('Exec')
		expect(node.children[1].text).toBe('indi_simulator_ccd')
		expect(node.children[2].name).toBe('defText')
		expect(node.children[2].attributes.name).toBe('DRIVER_VERSION')
		expect(node.children[2].attributes.label).toBe('Version')
		expect(node.children[2].text).toBe('1.0')
		expect(node.children[3].name).toBe('defText')
		expect(node.children[3].attributes.name).toBe('DRIVER_INTERFACE')
		expect(node.children[3].attributes.label).toBe('Interface')
		expect(node.children[3].text).toBe('22')
	})

	test('defNumberVector', () => {
		const node = tags.find((e) => e.name === 'defNumberVector' && e.attributes.name === 'SIMULATOR_SETTINGS')!

		expect(node.name).toBe('defNumberVector')
		expect(node.attributes.device).toBe('CCD Simulator')
		expect(node.attributes.name).toBe('SIMULATOR_SETTINGS')
		expect(node.attributes.label).toBe('Settings')
		expect(node.attributes.group).toBe('Simulator Config')
		expect(node.attributes.state).toBe('Idle')
		expect(node.attributes.perm).toBe('rw')
		expect(node.attributes.rule).toBeUndefined()
		expect(node.attributes.timeout).toBe('60')
		expect(node.attributes.timestamp).toBe('2025-03-11T12:43:02')
		expect(node.text).toBeEmpty()
		expect(node.children).toHaveLength(16)
		expect(node.children[0].name).toBe('defNumber')
		expect(node.children[0].attributes.name).toBe('SIM_XRES')
		expect(node.children[0].attributes.label).toBe('CCD X resolution')
		expect(node.children[0].attributes.format).toBe('%4.0f')
		expect(node.children[0].attributes.min).toBe('512')
		expect(node.children[0].attributes.max).toBe('8192')
		expect(node.children[0].attributes.step).toBe('512')
		expect(node.children[0].text).toBe('1280')
		expect(node.children[15].name).toBe('defNumber')
		expect(node.children[15].attributes.name).toBe('SIM_ROTATION')
		expect(node.children[15].attributes.label).toBe('CCD Rotation')
		expect(node.children[15].attributes.format).toBe('%.2f')
		expect(node.children[15].attributes.min).toBe('0')
		expect(node.children[15].attributes.max).toBe('360')
		expect(node.children[15].attributes.step).toBe('10')
		expect(node.children[15].text).toBe('0')
	})

	test('defBLOBVector', () => {
		const node = tags.find((e) => e.name === 'defBLOBVector' && e.attributes.name === 'CCD1')!

		expect(node.name).toBe('defBLOBVector')
		expect(node.attributes.device).toBe('CCD Simulator')
		expect(node.attributes.name).toBe('CCD1')
		expect(node.attributes.label).toBe('Image Data')
		expect(node.attributes.group).toBe('Image Info')
		expect(node.attributes.state).toBe('Idle')
		expect(node.attributes.perm).toBe('ro')
		expect(node.attributes.rule).toBeUndefined()
		expect(node.attributes.timeout).toBe('60')
		expect(node.attributes.timestamp).toBe('2025-03-11T12:43:07')
		expect(node.text).toBeEmpty()
		expect(node.children).toHaveLength(1)
		expect(node.children[0].name).toBe('defBLOB')
		expect(node.children[0].attributes.name).toBe('CCD1')
		expect(node.children[0].attributes.label).toBe('Image')
		expect(node.children[0].text).toBeEmpty()
	})
})

describe('parse', () => {
	const client = new IndiClient()

	test('defSwitchVector', () => {
		const node = tags.find((e) => e.name === 'defSwitchVector' && e.attributes.name === 'CONNECTION')!
		const vector = client.parseDefVector(node) as DefSwitchVector

		expect(vector.device).toBe('CCD Simulator')
		expect(vector.name).toBe('CONNECTION')
		expect(vector.label).toBe('Connection')
		expect(vector.group).toBe('Main Control')
		expect(vector.message).toBeUndefined()
		expect(vector.permission).toBe('rw')
		expect(vector.rule).toBe('OneOfMany')
		expect(vector.state).toBe('Idle')
		expect(vector.timeout).toBe(60)
		expect(vector.timestamp).toBe('2025-03-11T12:43:02')
		expect(vector.elements.CONNECT.name).toBe('CONNECT')
		expect(vector.elements.CONNECT.label).toBe('Connect')
		expect(vector.elements.CONNECT.value).toBe(false)
		expect(vector.elements.DISCONNECT.name).toBe('DISCONNECT')
		expect(vector.elements.DISCONNECT.label).toBe('Disconnect')
		expect(vector.elements.DISCONNECT.value).toBe(true)
	})
})

describe.serial.skip('manager', () => {
	test('camera', async () => {
		let frame = ''
		let cameraAdded = false
		let cameraRemoved = false
		let guideOutputAdded = false
		let guideOutputRemoved = false
		let thermometerAdded = false
		let thermometerRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_ccd'])

		const cameraDeviceHandler: DeviceHandler<Camera> = {
			added: (client: IndiClient, device: Camera) => {
				cameraAdded = true
			},
			updated: (client: IndiClient, device: Camera, property: keyof Camera, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Camera) => {
				cameraRemoved = true
			},
			blobReceived: (client, device, data) => {
				frame = data
			},
		}

		const guideOutputDeviceHandler: DeviceHandler<GuideOutput> = {
			added: (client: IndiClient, device: GuideOutput) => {
				guideOutputAdded = true
			},
			updated: (client: IndiClient, device: GuideOutput, property: keyof GuideOutput, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: GuideOutput) => {
				guideOutputRemoved = true
			},
		}

		const thermometerDeviceHandler: DeviceHandler<Thermometer> = {
			added: (client: IndiClient, device: Thermometer) => {
				thermometerAdded = true
			},
			updated: (client: IndiClient, device: Thermometer, property: keyof Thermometer, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Thermometer) => {
				thermometerRemoved = true
			},
		}

		const devicePropertyHandler: DevicePropertyHandler = {
			added: (device: string, property: DeviceProperty) => {},
			updated: (device: string, property: DeviceProperty) => {},
			removed: (device: string, property: DeviceProperty) => {},
		}

		const deviceProperty = new DevicePropertyManager(devicePropertyHandler)
		const camera = new CameraManager(deviceProperty, cameraDeviceHandler)
		const guideOutput = new GuideOutputManager(camera, guideOutputDeviceHandler)
		const thermometer = new ThermometerManager(camera, thermometerDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				camera.textVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				camera.numberVector(client, message, tag)
				guideOutput.numberVector(client, message, tag)
				thermometer.numberVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				camera.switchVector(client, message, tag)
			},
			blobVector: (client, message, tag) => {
				camera.blobVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				camera.delProperty(client, message)
				guideOutput.delProperty(client, message)
				thermometer.delProperty(client, message)
			},
			close: (client, server) => {
				camera.close(client, server)
				guideOutput.close(client, server)
				thermometer.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			process.kill()
		})

		await client.connect('localhost')
		await Bun.sleep(1000)

		expect(cameraAdded).toBeTrue()

		expect(camera).toHaveLength(1)

		const simulator = camera.get('CCD Simulator')!
		camera.connect(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.connected).toBeTrue()
		expect(guideOutput).toHaveLength(1)
		expect(thermometer).toHaveLength(1)
		expect(thermometerAdded).toBeTrue()
		expect(guideOutputAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		camera.enableBlob(client, simulator)
		camera.startExposure(client, simulator, 1)

		await Bun.sleep(2000)

		expect(frame).not.toBeEmpty()

		client.close()

		await Bun.sleep(1000)

		expect(camera).toBeEmpty()
		expect(guideOutput).toBeEmpty()
		expect(thermometer).toBeEmpty()
		expect(cameraRemoved).toBeTrue()
		expect(thermometerRemoved).toBeTrue()
		expect(guideOutputRemoved).toBeTrue()
	}, 10000)

	test('mount', async () => {
		let mountAdded = false
		let mountRemoved = false
		let guideOutputAdded = false
		let guideOutputRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_telescope'])

		const mountDeviceHandler: DeviceHandler<Mount> = {
			added: (client: IndiClient, device: Mount) => {
				mountAdded = true
			},
			updated: (client: IndiClient, device: Mount, property: keyof Mount, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Mount) => {
				mountRemoved = true
			},
		}

		const guideOutputDeviceHandler: DeviceHandler<GuideOutput> = {
			added: (client: IndiClient, device: GuideOutput) => {
				guideOutputAdded = true
			},
			updated: (client: IndiClient, device: GuideOutput, property: keyof GuideOutput, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: GuideOutput) => {
				guideOutputRemoved = true
			},
		}

		const devicePropertyHandler: DevicePropertyHandler = {
			added: (device: string, property: DeviceProperty) => {},
			updated: (device: string, property: DeviceProperty) => {},
			removed: (device: string, property: DeviceProperty) => {},
		}

		const deviceProperty = new DevicePropertyManager(devicePropertyHandler)
		const mount = new MountManager(mountDeviceHandler)
		const guideOutput = new GuideOutputManager(mount, guideOutputDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				mount.textVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				mount.numberVector(client, message, tag)
				guideOutput.numberVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				mount.switchVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				mount.delProperty(client, message)
				guideOutput.delProperty(client, message)
			},
			close: (client, server) => {
				mount.close(client, server)
				guideOutput.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			process.kill()
		})

		await client.connect('localhost')
		await Bun.sleep(1000)

		expect(mountAdded).toBeTrue()
		expect(mount).toHaveLength(1)

		const simulator = mount.get('Telescope Simulator')!
		mount.connect(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.connected).toBeTrue()
		expect(guideOutput).toHaveLength(1)
		expect(guideOutputAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		client.close()

		await Bun.sleep(1000)

		expect(mount).toBeEmpty()
		expect(guideOutput).toBeEmpty()
		expect(mountRemoved).toBeTrue()
		expect(guideOutputRemoved).toBeTrue()
	}, 10000)
})
