import { describe, expect, onTestFinished, test } from 'bun:test'
import { type DefSwitchVector, IndiClient, type IndiClientHandler, type PropertyState } from '../src/indi'
// biome-ignore format: too long!
import { type Camera, CameraManager, type Cover, CoverManager, type DeviceHandler, DevicePropertyManager, type FlatPanel, FlatPanelManager, type Focuser, FocuserManager, type GuideOutput, GuideOutputManager, type Mount, MountManager, type Thermometer, ThermometerManager, type Wheel, WheelManager } from '../src/indi.manager'
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

const noIndiServer = process.platform !== 'linux' || Bun.spawnSync(['which', 'indiserver']).stdout.byteLength === 0

describe.serial.skipIf(noIndiServer)('manager', () => {
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

		const deviceProperty = new DevicePropertyManager()
		const camera = new CameraManager()
		camera.addHandler(cameraDeviceHandler)
		const guideOutput = new GuideOutputManager(camera)
		guideOutput.addHandler(guideOutputDeviceHandler)
		const thermometer = new ThermometerManager(camera)
		thermometer.addHandler(thermometerDeviceHandler)

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
		expect(simulator.canAbort).toBeTrue()
		expect(simulator.canSubFrame).toBeTrue()
		expect(simulator.canBin).toBeTrue()
		expect(simulator.hasCooler).toBeTrue()
		expect(simulator.canSetTemperature).toBeTrue()
		expect(simulator.hasThermometer).toBeTrue()
		expect(simulator.canPulseGuide).toBeTrue()
		expect(simulator.hasCoolerControl).toBeTrue()
		expect(simulator.exposure.min).toBe(0.01)
		expect(simulator.exposure.max).toBe(3600)
		expect(simulator.frame.width).toBe(1280)
		expect(simulator.frame.height).toBe(1024)
		expect(simulator.frame.maxX).toBe(1279)
		expect(simulator.frame.maxY).toBe(1023)
		expect(simulator.frame.maxWidth).toBe(1280)
		expect(simulator.frame.maxHeight).toBe(1024)
		expect(simulator.gain.value).toBe(90)
		expect(simulator.gain.max).toBe(300)
		expect(simulator.offset.max).toBe(6000)
		expect(simulator.bin.x).toBe(1)
		expect(simulator.bin.y).toBe(1)
		expect(simulator.bin.maxX).toBe(4)
		expect(simulator.bin.maxY).toBe(4)
		expect(simulator.pixelSize.x).toBeCloseTo(5.2, 1)
		expect(simulator.pixelSize.y).toBeCloseTo(5.2, 1)
		expect(simulator.frameFormats).toEqual(['INDI_MONO'])
		expect(guideOutput).toHaveLength(1)
		expect(thermometer).toHaveLength(1)
		expect(thermometerAdded).toBeTrue()
		expect(guideOutputAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		camera.enableBlob(client, simulator)
		camera.gain(client, simulator, 60)
		camera.offset(client, simulator, 10)
		camera.startExposure(client, simulator, 1)

		await Bun.sleep(2000)

		expect(frame).not.toBeEmpty()
		expect(simulator.gain.value).toBe(60)
		expect(simulator.offset.value).toBe(10)

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

		const deviceProperty = new DevicePropertyManager()
		const mount = new MountManager()
		mount.addHandler(mountDeviceHandler)
		const guideOutput = new GuideOutputManager(mount)
		guideOutput.addHandler(guideOutputDeviceHandler)

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
		expect(simulator.canSync).toBeTrue()
		expect(simulator.canGoTo).toBeTrue()
		expect(simulator.canAbort).toBeTrue()
		expect(simulator.canHome).toBeTrue()
		expect(simulator.canPark).toBeTrue()
		expect(simulator.canPulseGuide).toBeTrue()
		expect(simulator.trackModes).toEqual(['SIDEREAL', 'SOLAR', 'LUNAR', 'CUSTOM'])
		expect(simulator.slewRates).toHaveLength(4)
		expect(simulator.slewRate).toBe('3x')
		expect(simulator.pierSide).toBe('EAST')
		expect(simulator.geographicCoordinate.latitude).not.toBe(0)
		expect(simulator.geographicCoordinate.longitude).not.toBe(0)
		expect(simulator.geographicCoordinate.elevation).not.toBe(0)
		expect(simulator.time.utc).not.toBe(0)
		expect(simulator.equatorialCoordinate.rightAscension).not.toBe(0)
		expect(simulator.equatorialCoordinate.declination).not.toBe(0)
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

	const FILTER_SLOTS_1 = ['Red', 'Green', 'Blue', 'H_Alpha', 'SII', 'OIII', 'LPR', 'Luminance']
	const FILTER_SLOTS_2 = ['Luminance', 'Red', 'Green', 'Blue', 'Ha', 'SII', 'OIII', 'Dark']

	test('wheel', async () => {
		let wheelAdded = false
		let wheelRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_wheel'])

		const wheelDeviceHandler: DeviceHandler<Wheel> = {
			added: (client: IndiClient, device: Wheel) => {
				wheelAdded = true
			},
			updated: (client: IndiClient, device: Wheel, property: keyof Wheel, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Wheel) => {
				wheelRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const wheel = new WheelManager()
		wheel.addHandler(wheelDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				wheel.textVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				wheel.numberVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				wheel.switchVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				wheel.delProperty(client, message)
			},
			close: (client, server) => {
				wheel.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			process.kill()
		})

		await client.connect('localhost')
		await Bun.sleep(1000)

		expect(wheelAdded).toBeTrue()
		expect(wheel).toHaveLength(1)

		const simulator = wheel.get('Filter Simulator')!
		wheel.connect(client, simulator)

		await Bun.sleep(1000)

		let actual: string[] = FILTER_SLOTS_1
		let expected: string[] = FILTER_SLOTS_2

		if (simulator.slots[0] !== actual[0]) {
			actual = FILTER_SLOTS_2
			expected = FILTER_SLOTS_1
		}

		expect(simulator.connected).toBeTrue()
		expect(simulator.slots).toHaveLength(8)
		expect(simulator.slots).toEqual(actual)
		expect(simulator.position).toBe(0)
		expect(deviceProperty).not.toBeEmpty()

		wheel.moveTo(client, simulator, 7)
		wheel.slots(client, simulator, expected)

		await Bun.sleep(2000)

		expect(simulator.position).toBe(7)
		expect(simulator.slots).toEqual(expected)

		client.close()

		await Bun.sleep(1000)

		expect(wheel).toBeEmpty()
		expect(wheelRemoved).toBeTrue()
	}, 10000)

	test('focuser', async () => {
		let focuserAdded = false
		let focuserRemoved = false
		let thermometerAdded = false
		let thermometerRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_focus'])

		const focuserDeviceHandler: DeviceHandler<Focuser> = {
			added: (client: IndiClient, device: Focuser) => {
				focuserAdded = true
			},
			updated: (client: IndiClient, device: Focuser, property: keyof Focuser, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Focuser) => {
				focuserRemoved = true
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

		const deviceProperty = new DevicePropertyManager()
		const focuser = new FocuserManager()
		focuser.addHandler(focuserDeviceHandler)
		const thermometer = new ThermometerManager(focuser)
		thermometer.addHandler(thermometerDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				focuser.textVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				focuser.numberVector(client, message, tag)
				thermometer.numberVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				focuser.switchVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				focuser.delProperty(client, message)
				thermometer.delProperty(client, message)
			},
			close: (client, server) => {
				focuser.close(client, server)
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

		expect(focuserAdded).toBeTrue()
		expect(focuser).toHaveLength(1)

		const simulator = focuser.get('Focuser Simulator')!
		focuser.connect(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.connected).toBeTrue()
		// expect(simulator.canAbort).toBeTrue()
		expect(simulator.hasThermometer).toBeTrue()
		expect(simulator.canAbsoluteMove).toBeTrue()
		// expect(simulator.canReverse).toBeTrue()
		// expect(simulator.canSync).toBeTrue()
		expect(simulator.position.max).toEqual(100000)
		expect(simulator.position.value).toEqual(50000)
		expect(thermometer).toHaveLength(1)
		expect(thermometerAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		focuser.moveTo(client, simulator, 60000)

		await Bun.sleep(2000)

		expect(simulator.position.value).toBe(60000)

		client.close()

		await Bun.sleep(1000)

		expect(focuser).toBeEmpty()
		expect(thermometer).toBeEmpty()
		expect(focuserRemoved).toBeTrue()
		expect(thermometerRemoved).toBeTrue()
	}, 10000)

	test('cover', async () => {
		let coverAdded = false
		let coverRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_dustcover'])

		const coverDeviceHandler: DeviceHandler<Cover> = {
			added: (client: IndiClient, device: Cover) => {
				coverAdded = true
			},
			updated: (client: IndiClient, device: Cover, property: keyof Cover, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: Cover) => {
				coverRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const cover = new CoverManager()
		cover.addHandler(coverDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				cover.textVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				cover.switchVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				cover.delProperty(client, message)
			},
			close: (client, server) => {
				cover.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			process.kill()
		})

		await client.connect('localhost')
		await Bun.sleep(1000)

		expect(coverAdded).toBeTrue()
		expect(cover).toHaveLength(1)

		const simulator = cover.get('Dust Cover Simulator')!
		cover.connect(client, simulator)

		await Bun.sleep(1000)

		const isParked = simulator.parked

		expect(simulator.connected).toBeTrue()
		expect(simulator.pwm.max).toBe(100)
		expect(simulator.pwm.value).toBe(0)
		expect(deviceProperty).not.toBeEmpty()

		isParked ? cover.unpark(client, simulator) : cover.park(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.parked).toBe(!isParked)

		isParked ? cover.park(client, simulator) : cover.unpark(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.parked).toBe(isParked)

		client.close()

		await Bun.sleep(1000)

		expect(cover).toBeEmpty()
		expect(coverRemoved).toBeTrue()
	}, 10000)

	test('flat panel', async () => {
		let flatPanelAdded = false
		let flatPanelRemoved = false

		const process = Bun.spawn(['indiserver', 'indi_simulator_lightpanel'])

		const platPanelDeviceHandler: DeviceHandler<FlatPanel> = {
			added: (client: IndiClient, device: FlatPanel) => {
				flatPanelAdded = true
			},
			updated: (client: IndiClient, device: FlatPanel, property: keyof FlatPanel, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (client: IndiClient, device: FlatPanel) => {
				flatPanelRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const flatPanel = new FlatPanelManager()
		flatPanel.addHandler(platPanelDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				flatPanel.textVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				flatPanel.switchVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				flatPanel.numberVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				flatPanel.delProperty(client, message)
			},
			close: (client, server) => {
				flatPanel.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			process.kill()
		})

		await client.connect('localhost')
		await Bun.sleep(1000)

		expect(flatPanelAdded).toBeTrue()
		expect(flatPanel).toHaveLength(1)

		const simulator = flatPanel.get('Light Panel Simulator')!
		flatPanel.connect(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.connected).toBeTrue()
		expect(simulator.intensity.max).toBe(255)
		expect(simulator.intensity.value).toBe(0)
		expect(deviceProperty).not.toBeEmpty()

		flatPanel.enable(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.enabled).toBeTrue()

		flatPanel.intensity(client, simulator, 99)
		flatPanel.disable(client, simulator)

		await Bun.sleep(1000)

		expect(simulator.intensity.value).toBe(99)
		expect(simulator.enabled).toBeFalse()

		client.close()

		await Bun.sleep(1000)

		expect(flatPanel).toBeEmpty()
		expect(flatPanelRemoved).toBeTrue()
	}, 10000)
})
