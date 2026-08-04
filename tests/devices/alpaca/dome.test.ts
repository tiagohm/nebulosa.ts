import { expect, test } from 'bun:test'
import { AlpacaClient } from '../../../src/devices/alpaca/client'
import { AlpacaServer } from '../../../src/devices/alpaca/server'
import { AlpacaException } from '../../../src/devices/alpaca/types'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Client, Device, DeviceType } from '../../../src/devices/indi/device'
import { DomeManager, type DeviceProvider } from '../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import { deg } from '../../../src/math/units/angle'
import { waitUntil } from '../../util'

interface AlpacaResponse {
	readonly ErrorNumber: number
	readonly Value: unknown
}

test('bridges a local INDI dome through Alpaca and back', async () => {
	const indiHandlers = new IndiClientHandlerSet()
	const indiDomeManager = new DomeManager()
	indiHandlers.add(indiDomeManager)
	const indiClient = new ClientSimulator('dome.server', indiHandlers)
	const simulator = new DomeSimulator('Local Dome', indiClient)
	const indiDome = indiDomeManager.get(indiClient, simulator.name)!
	let server: AlpacaServer | undefined
	let alpacaClient: AlpacaClient | undefined

	try {
		indiDomeManager.connect(indiDome)
		await waitUntil(() => indiDome.connected)

		server = new AlpacaServer({ dome: indiDomeManager })
		server.start('127.0.0.1', 0)
		const base = `http://127.0.0.1:${server.port}`
		const configured = (await (await fetch(`${base}/management/v1/configureddevices`)).json()) as {
			readonly Value: readonly [{ readonly DeviceName: string; readonly DeviceNumber: number; readonly DeviceType: string }]
		}

		expect(configured.Value).toHaveLength(1)
		expect(configured.Value[0].DeviceType).toBe('dome')

		const alpacaHandlers = new IndiClientHandlerSet()
		const alpacaDomeManager = new DomeManager()
		alpacaHandlers.add(alpacaDomeManager)
		const provider: DeviceProvider<Device> = {
			get: (client: Client | string | undefined, name: string, type?: DeviceType) => (type === 'dome' ? alpacaDomeManager.get(client, name) : undefined),
		}

		alpacaClient = new AlpacaClient(base, { handler: alpacaHandlers, poolingInterval: 1000 }, provider)
		expect(await alpacaClient.start()).toBeTrue()
		await waitUntil(() => alpacaDomeManager.has(alpacaClient, simulator.name), 8000)

		const alpacaDome = alpacaDomeManager.get(alpacaClient, simulator.name)!
		alpacaDomeManager.connect(alpacaDome)
		await waitUntil(() => alpacaDome.connected, 8000)
		await waitUntil(() => alpacaDome.canSetAzimuth && alpacaDome.canFindHome && alpacaDome.canPark && alpacaDome.canSetShutter && alpacaDome.canSync, 8000)

		expect(alpacaDome.canUnpark).toBeFalse()
		expect(alpacaDome.azimuth.value).toBeCloseTo((indiDome.azimuth.value * Math.PI) / 180, 6)

		const state = (await (await fetch(`${base}/api/v1/dome/${configured.Value[0].DeviceNumber}/devicestate`)).json()) as AlpacaResponse & { readonly Value: readonly { readonly Name: string; readonly Value: unknown }[] }
		expect(state.ErrorNumber).toBe(0)
		expect(state.Value.map((item) => item.Name)).toEqual(['AtHome', 'AtPark', 'Azimuth', 'ShutterStatus', 'Slewing', 'TimeStamp'])

		const invalidAzimuth = await put(`${base}/api/v1/dome/${configured.Value[0].DeviceNumber}/slewtoazimuth`, { Azimuth: '361' })
		expect(invalidAzimuth.ErrorNumber).toBe(AlpacaException.InvalidValue)

		alpacaDomeManager.moveTo(alpacaDome, deg(90))
		await waitUntil(() => alpacaDome.moving, 8000)
		await waitUntil(() => !indiDome.moving, 8000)
		await waitUntil(() => !alpacaDome.moving, 8000)
		expect(indiDome.azimuth.value).toBeCloseTo(deg(90), 6)

		alpacaDomeManager.syncTo(alpacaDome, deg(100))
		await waitUntil(() => Math.abs(indiDome.azimuth.value - deg(100)) < 1e-8)
		await waitUntil(() => Math.abs(alpacaDome.azimuth.value - deg(100)) < 1e-4, 4000)

		alpacaDomeManager.home(alpacaDome)
		await waitUntil(() => indiDome.homing, 8000)
		await waitUntil(() => alpacaDome.slewing, 8000)
		await waitUntil(() => alpacaDome.atHome, 8000)

		alpacaDomeManager.park(alpacaDome)
		await waitUntil(() => indiDome.parking, 8000)
		await waitUntil(() => alpacaDome.slewing, 8000)
		await waitUntil(() => alpacaDome.parked, 8000)
		alpacaDomeManager.setPark(alpacaDome)

		alpacaDomeManager.openShutter(alpacaDome)
		await waitUntil(() => indiDome.shutterState === 'OPENING', 4000)
		await waitUntil(() => alpacaDome.shutterState === 'OPEN', 8000)
		alpacaDomeManager.closeShutter(alpacaDome)
		await waitUntil(() => alpacaDome.shutterState === 'CLOSED', 8000)

		alpacaDomeManager.slave(alpacaDome, true)
		await waitUntil(() => alpacaDome.slaved, 4000)
		const slaved = await put(`${base}/api/v1/dome/${configured.Value[0].DeviceNumber}/slewtoazimuth`, { Azimuth: '20' })
		expect(slaved.ErrorNumber).toBe(AlpacaException.Slaved)

		alpacaDomeManager.stop(alpacaDome)
		await waitUntil(() => !alpacaDome.slaved, 4000)
		alpacaDomeManager.moveTo(alpacaDome, deg(0))
		await waitUntil(() => alpacaDome.moving, 8000)
		alpacaDomeManager.stop(alpacaDome)
		await waitUntil(() => !alpacaDome.moving, 4000)

		indiDomeManager.disconnect(indiDome)
		await waitUntil(() => !indiDome.connected)
		const disconnected = (await (await fetch(`${base}/api/v1/dome/${configured.Value[0].DeviceNumber}/azimuth`)).json()) as AlpacaResponse
		expect(disconnected.ErrorNumber).toBe(AlpacaException.NotConnected)
	} finally {
		alpacaClient?.stop()
		server?.stop()
		simulator.dispose()
	}
}, 45000)

async function put(url: string, values: Record<string, string>): Promise<AlpacaResponse> {
	const response = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(values),
	})

	return (await response.json()) as AlpacaResponse
}
