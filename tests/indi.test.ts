import { describe, expect, onTestFinished, test } from 'bun:test'
import { IndiClient, type IndiClientHandler } from '../src/indi.client'
import type { Camera, Cover, FlatPanel, Focuser, GuideOutput, Mount, Power, Rotator, Thermometer, Wheel } from '../src/indi.device'
import { CameraManager, CoverManager, type DeviceHandler, DevicePropertyManager, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, PowerManager, RotatorManager, ThermometerManager, WheelManager } from '../src/indi.manager'
import type { DefSwitchVector, DefTextVector, PropertyState } from '../src/indi.types'
// oxfmt-ignore
import { SimpleXmlParser } from '../src/xml'
import { downloadPerTag } from './download'

await downloadPerTag('indi')

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
		expect(vector.elements.CONNECT.value).toBeFalse()
		expect(vector.elements.DISCONNECT.name).toBe('DISCONNECT')
		expect(vector.elements.DISCONNECT.label).toBe('Disconnect')
		expect(vector.elements.DISCONNECT.value).toBeTrue()
	})

	test('keeps element names that collide with object prototype keys', () => {
		const vector = client.parseDefVector({
			name: 'defTextVector',
			attributes: { device: 'Device', name: 'PROTOTYPE_TEST', state: 'Ok', perm: 'rw' },
			children: [{ name: 'defText', attributes: { name: '__proto__' }, children: [], text: 'safe' }],
			text: '',
		}) as DefTextVector

		expect(Object.getPrototypeOf(vector.elements)).toBeNull()
		expect(Object.hasOwn(vector.elements, '__proto__')).toBeTrue()
		expect(vector.elements.__proto__.value).toBe('safe')
	})
})

describe('write', () => {
	test('escapes XML attributes and text in outbound commands', async () => {
		const payload = await captureClientWrites('</newTextVector>', (client) => {
			client.sendText({
				device: 'Device & "A"',
				name: 'ACTIVE<DEVICES>',
				elements: { ACTIVE_TELESCOPE: 'Mount & <main> "east"' },
			})
		})

		expect(payload).toContain('<newTextVector device="Device &amp; &quot;A&quot;" name="ACTIVE&lt;DEVICES&gt;"><oneText name="ACTIVE_TELESCOPE">Mount &amp; &lt;main&gt; "east"</oneText></newTextVector>')
		expect(payload).not.toContain('timestamp=""')
	})

	test('writes complete XML commands in one escaped payload', async () => {
		const payload = await captureClientWrites('</enableBLOB>', (client) => {
			client.getProperties({ device: 'CCD & "A"', name: 'PROP<1>' })
			client.enableBlob({ device: 'CCD & "A"', name: 'CCD>1', value: 'Also' })
		})

		expect(payload).toContain('<getProperties version="1.7"></getProperties>')
		expect(payload).toContain('<getProperties version="1.7" device="CCD &amp; &quot;A&quot;" name="PROP&lt;1&gt;"></getProperties>')
		expect(payload).toContain('<enableBLOB device="CCD &amp; &quot;A&quot;" name="CCD&gt;1">Also</enableBLOB>')
	})
})

async function captureClientWrites(endMarker: string, write: (client: IndiClient) => void | Promise<void>) {
	let payload = ''

	const server = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data: (_, data) => {
				payload += data.toString()
			},
		},
	})

	const client = new IndiClient()

	try {
		await client.connect('127.0.0.1', server.port)
		await write(client)
		await waitUntil(() => payload.includes(endMarker), 1000, 10)
		return payload
	} finally {
		client.close()
		server.stop(true)
	}
}

async function waitUntil(predicate: () => boolean, timeout: number, step: number) {
	while (!predicate()) {
		if (timeout <= 0) throw new Error('timeout waiting for condition')
		await Bun.sleep(step)
		timeout -= step
	}
}

async function isIndiRunning(port: number = 7624) {
	if (process.platform === 'win32') {
		return (await Bun.$`netstat -ano | findstr :${port}`.quiet().text()).includes('LISTENING')
	} else if (process.platform === 'linux') {
		return (await Bun.$`lsof -i :${port}`.quiet().text()).includes('LISTEN')
	} else {
		return false
	}
}

const INDI_HOST: string = 'localhost'
const SKIP = Bun.env.RUN_SKIPPED_TESTS !== 'true' || !(await isIndiRunning())

// indiserver indi_simulator_ccd indi_simulator_telescope indi_simulator_focus indi_simulator_wheel indi_simulator_dustcover indi_simulator_lightpanel indi_simulator_rotator
describe.skipIf(SKIP)('manager', () => {
	test('camera', async () => {
		let frame: string | Buffer = ''
		let cameraAdded = false
		let cameraRemoved = false
		let guideOutputAdded = false
		let guideOutputRemoved = false
		let thermometerAdded = false
		let thermometerRemoved = false

		const cameraDeviceHandler: DeviceHandler<Camera> = {
			added: (device: Camera) => {
				cameraAdded = true
			},
			updated: (device: Camera, property: keyof Camera, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Camera) => {
				cameraRemoved = true
			},
			blobReceived: (device, data) => {
				frame = data
			},
		}

		const guideOutputDeviceHandler: DeviceHandler<GuideOutput> = {
			added: (device: GuideOutput) => {
				guideOutputAdded = true
			},
			updated: (device: GuideOutput, property: keyof GuideOutput, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: GuideOutput) => {
				guideOutputRemoved = true
			},
		}

		const thermometerDeviceHandler: DeviceHandler<Thermometer> = {
			added: (device: Thermometer) => {
				thermometerAdded = true
			},
			updated: (device: Thermometer, property: keyof Thermometer, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Thermometer) => {
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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		expect(cameraAdded).toBeTrue()
		expect(camera).toHaveLength(1)

		const device = camera.get(client, 'CCD Simulator')!
		camera.connect(device)

		onTestFinished(() => {
			camera.disconnect(device)
		})

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(device.canAbort).toBeTrue()
		expect(device.canSubFrame).toBeTrue()
		expect(device.canBin).toBeTrue()
		expect(device.hasCooler).toBeTrue()
		expect(device.canSetTemperature).toBeTrue()
		expect(device.hasThermometer).toBeTrue()
		expect(device.canPulseGuide).toBeTrue()
		expect(device.hasCoolerControl).toBeTrue()
		expect(device.exposure.min).toBe(0.01)
		expect(device.exposure.max).toBe(3600)
		expect(device.frame.width.value).toBe(1280)
		expect(device.frame.height.value).toBe(1024)
		expect(device.frame.x.max).toBe(1279)
		expect(device.frame.y.max).toBe(1023)
		expect(device.frame.width.max).toBe(1280)
		expect(device.frame.height.max).toBe(1024)
		// expect(device.gain.value).toBe(90)
		expect(device.gain.max).toBe(300)
		expect(device.offset.max).toBe(6000)
		expect(device.bin.x.value).toBe(1)
		expect(device.bin.y.value).toBe(1)
		expect(device.bin.x.max).toBe(4)
		expect(device.bin.y.max).toBe(4)
		expect(device.pixelSize.x).toBeCloseTo(5.2, 1)
		expect(device.pixelSize.y).toBeCloseTo(5.2, 1)
		expect(device.frameFormats[0].name).toEqual('INDI_MONO')
		expect(guideOutput).toHaveLength(1)
		expect(thermometer).toHaveLength(1)
		expect(thermometerAdded).toBeTrue()
		expect(guideOutputAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		camera.enableBlob(device)
		camera.gain(device, 60)
		camera.offset(device, 10)
		camera.startExposure(device, 1)

		await Bun.sleep(500)

		expect(device.exposuring).toBeTrue()

		await Bun.sleep(1000)

		expect(frame).not.toBeEmpty()
		expect(device.gain.value).toBe(60)
		expect(device.offset.value).toBe(10)
		expect(device.exposuring).toBeFalse()

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

		const mountDeviceHandler: DeviceHandler<Mount> = {
			added: (device: Mount) => {
				mountAdded = true
			},
			updated: (device: Mount, property: keyof Mount, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Mount) => {
				mountRemoved = true
			},
		}

		const guideOutputDeviceHandler: DeviceHandler<GuideOutput> = {
			added: (device: GuideOutput) => {
				guideOutputAdded = true
			},
			updated: (device: GuideOutput, property: keyof GuideOutput, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: GuideOutput) => {
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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		expect(mountAdded).toBeTrue()
		expect(mount).toHaveLength(1)

		const device = mount.get(client, 'Telescope Simulator')!
		mount.connect(device)

		onTestFinished(() => {
			mount.disconnect(device)
		})

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(device.canSync).toBeTrue()
		expect(device.canGoTo).toBeTrue()
		expect(device.canAbort).toBeTrue()
		expect(device.canHome).toBeTrue()
		expect(device.canPark).toBeTrue()
		expect(device.canPulseGuide).toBeTrue()
		expect(device.trackModes).toEqual(['SIDEREAL', 'SOLAR', 'LUNAR', 'CUSTOM'])
		expect(device.slewRates).toHaveLength(4)
		expect(device.slewRate).toBe('3x')
		expect(['EAST', 'WEST']).toContain(device.pierSide)
		// expect(device.geographicCoordinate.latitude).not.toBe(0)
		// expect(device.geographicCoordinate.longitude).not.toBe(0)
		// expect(device.geographicCoordinate.elevation).not.toBe(0)
		expect(device.time.utc).not.toBe(0)
		// expect(device.equatorialCoordinate.rightAscension).not.toBe(0)
		// expect(device.equatorialCoordinate.declination).not.toBe(0)
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

	test('wheel', async () => {
		let wheelAdded = false
		let wheelRemoved = false

		const wheelDeviceHandler: DeviceHandler<Wheel> = {
			added: (device: Wheel) => {
				wheelAdded = true
			},
			updated: (device: Wheel, property: keyof Wheel, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Wheel) => {
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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		expect(wheelAdded).toBeTrue()
		expect(wheel.length).toBeGreaterThanOrEqual(1)

		const device = wheel.get(client, 'Filter Simulator')!
		wheel.connect(device)

		onTestFinished(() => {
			wheel.disconnect(device)
		})

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(device.count).toBe(8)
		expect(device.position).toBe(0)
		expect(deviceProperty).not.toBeEmpty()

		wheel.moveTo(device, 7)

		await Bun.sleep(2000)

		expect(device.position).toBe(7)

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

		const focuserDeviceHandler: DeviceHandler<Focuser> = {
			added: (device: Focuser) => {
				focuserAdded = true
			},
			updated: (device: Focuser, property: keyof Focuser, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Focuser) => {
				focuserRemoved = true
			},
		}

		const thermometerDeviceHandler: DeviceHandler<Thermometer> = {
			added: (device: Thermometer) => {
				thermometerAdded = true
			},
			updated: (device: Thermometer, property: keyof Thermometer, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Thermometer) => {
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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		onTestFinished(() => {
			focuser.disconnect(device)
		})

		expect(focuserAdded).toBeTrue()
		expect(focuser).toHaveLength(1)

		const device = focuser.get(client, 'Focuser Simulator')!
		focuser.connect(device)

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		// expect(simulator.canAbort).toBeTrue()
		expect(device.hasThermometer).toBeTrue()
		expect(device.canAbsoluteMove).toBeTrue()
		// expect(simulator.canReverse).toBeTrue()
		// expect(simulator.canSync).toBeTrue()
		expect(device.position.max).toEqual(100000)
		expect(device.position.value).toEqual(50000)
		expect(thermometer).toHaveLength(1)
		expect(thermometerAdded).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		focuser.moveTo(device, 60000)

		await Bun.sleep(2000)

		expect(device.position.value).toBe(60000)

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

		const coverDeviceHandler: DeviceHandler<Cover> = {
			added: (device: Cover) => {
				coverAdded = true
			},
			updated: (device: Cover, property: keyof Cover, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Cover) => {
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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		onTestFinished(() => {
			cover.disconnect(device)
		})

		expect(coverAdded).toBeTrue()
		expect(cover).toHaveLength(1)

		const device = cover.get(client, 'Dust Cover Simulator')!
		cover.connect(device)

		await Bun.sleep(1000)

		const isParked = device.parked

		expect(device.connected).toBeTrue()
		expect(device.hasDewHeater).toBeFalse()
		expect(deviceProperty).not.toBeEmpty()

		isParked ? cover.unpark(device) : cover.park(device)

		await Bun.sleep(1000)

		expect(device.parked).toBe(!isParked)

		isParked ? cover.park(device) : cover.unpark(device)

		await Bun.sleep(1000)

		expect(device.parked).toBe(isParked)

		client.close()

		await Bun.sleep(1000)

		expect(cover).toBeEmpty()
		expect(coverRemoved).toBeTrue()
	}, 10000)

	test('flat panel', async () => {
		let flatPanelAdded = false
		let flatPanelRemoved = false

		const flatPanelDeviceHandler: DeviceHandler<FlatPanel> = {
			added: (device: FlatPanel) => {
				flatPanelAdded = true
			},
			updated: (device: FlatPanel, property: keyof FlatPanel, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: FlatPanel) => {
				flatPanelRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const flatPanel = new FlatPanelManager()
		flatPanel.addHandler(flatPanelDeviceHandler)

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

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		onTestFinished(() => {
			flatPanel.disconnect(device)
		})

		expect(flatPanelAdded).toBeTrue()
		expect(flatPanel).toHaveLength(1)

		const device = flatPanel.get(client, 'Light Panel Simulator')!
		flatPanel.connect(device)

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(device.intensity.max).toBe(255)
		expect(device.intensity.value).toBe(0)
		expect(deviceProperty).not.toBeEmpty()

		flatPanel.enable(device)

		await Bun.sleep(1000)

		expect(device.enabled).toBeTrue()

		flatPanel.intensity(device, 99)
		flatPanel.disable(device)

		await Bun.sleep(1000)

		expect(device.intensity.value).toBe(99)
		expect(device.enabled).toBeFalse()

		client.close()

		await Bun.sleep(1000)

		expect(flatPanel).toBeEmpty()
		expect(flatPanelRemoved).toBeTrue()
	}, 10000)

	test.skip('power', async () => {
		let powerAdded = false
		let powerRemoved = false

		const powerDeviceHandler: DeviceHandler<Power> = {
			added: (device: Power) => {
				powerAdded = true
			},
			updated: (device: Power, property: keyof Power, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Power) => {
				powerRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const power = new PowerManager()
		power.addHandler(powerDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				power.textVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				power.switchVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				power.numberVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				power.delProperty(client, message)
			},
			close: (client, server) => {
				power.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		onTestFinished(() => {
			power.disconnect(device)
		})

		expect(powerAdded).toBeTrue()
		expect(power).toHaveLength(1)

		const device = power.get(client, 'SVBONY PowerBox')!
		// power.simulation(client, device, true)
		power.connect(device)

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(deviceProperty).not.toBeEmpty()

		// device.dc.forEach((e) => power.toggle(client, device, e, true))
		// device.dew.forEach((e) => power.toggle(client, device, e, true))
		// device.autoDew.forEach((e) => power.toggle(client, device, e, true))
		// device.variableVoltage.forEach((e) => power.toggle(client, device, e, true))
		// device.usb.forEach((e) => power.toggle(client, device, e, true))

		// await Bun.sleep(1000)

		// device.dc.forEach((e) => expect(e.enabled).toBeTrue())
		// device.dew.forEach((e) => expect(e.enabled).toBeTrue())
		// device.autoDew.forEach((e) => expect(e.enabled).toBeTrue())
		// device.variableVoltage.forEach((e) => expect(e.enabled).toBeTrue())
		// device.usb.forEach((e) => expect(e.enabled).toBeTrue())

		// device.dc.forEach((e) => power.toggle(client, device, e, false))
		// device.dew.forEach((e) => power.toggle(client, device, e, false))
		// device.autoDew.forEach((e) => power.toggle(client, device, e, false))
		// device.variableVoltage.forEach((e) => power.toggle(client, device, e, false))
		// device.usb.forEach((e) => power.toggle(client, device, e, false))

		// await Bun.sleep(1000)

		// device.dc.forEach((e) => expect(e.enabled).toBeFalse())
		// device.dew.forEach((e) => expect(e.enabled).toBeFalse())
		// device.autoDew.forEach((e) => expect(e.enabled).toBeFalse())
		// device.variableVoltage.forEach((e) => expect(e.enabled).toBeFalse())
		// device.usb.forEach((e) => expect(e.enabled).toBeFalse())

		client.close()

		await Bun.sleep(1000)

		expect(power).toBeEmpty()
		expect(powerRemoved).toBeTrue()
	}, 10000)

	test('rotator', async () => {
		let rotatorAdded = false
		let rotatorRemoved = false

		const rotatorDeviceHandler: DeviceHandler<Rotator> = {
			added: (device: Rotator) => {
				rotatorAdded = true
			},
			updated: (device: Rotator, property: keyof Rotator, state?: PropertyState) => {
				console.info(property, JSON.stringify(device[property]))
			},
			removed: (device: Rotator) => {
				rotatorRemoved = true
			},
		}

		const deviceProperty = new DevicePropertyManager()
		const rotator = new RotatorManager()
		rotator.addHandler(rotatorDeviceHandler)

		const handler: IndiClientHandler = {
			textVector: (client, message, tag) => {
				rotator.textVector(client, message, tag)
			},
			numberVector: (client, message, tag) => {
				rotator.numberVector(client, message, tag)
			},
			switchVector: (client, message, tag) => {
				rotator.switchVector(client, message, tag)
			},
			vector: (client, message, tag) => {
				deviceProperty.vector(client, message, tag)
			},
			delProperty: (client, message) => {
				deviceProperty.delProperty(client, message)
				rotator.delProperty(client, message)
			},
			close: (client, server) => {
				rotator.close(client, server)
			},
		}

		await Bun.sleep(1000)

		const client = new IndiClient({ handler })

		onTestFinished(() => {
			rotator.disconnect(device)
		})

		await client.connect(INDI_HOST)
		await Bun.sleep(1000)

		expect(rotatorAdded).toBeTrue()
		expect(rotator).toHaveLength(1)

		const device = rotator.get(client, 'Rotator Simulator')!
		rotator.connect(device)

		await Bun.sleep(1000)

		expect(device.connected).toBeTrue()
		expect(device.canAbort).toBeTrue()
		expect(device.canHome).toBeFalse()
		expect(device.canReverse).toBeTrue()
		expect(device.canSync).toBeTrue()
		expect(device.angle.value).toBe(0)
		expect(device.angle.min).toBe(0)
		expect(device.angle.max).toBe(360)
		expect(deviceProperty).not.toBeEmpty()

		rotator.moveTo(device, 5)

		await Bun.sleep(2000)

		expect(device.angle.value).toBe(5)

		client.close()

		await Bun.sleep(1000)

		expect(rotator).toBeEmpty()
		expect(rotatorRemoved).toBeTrue()
	}, 10000)
})
