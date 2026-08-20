import { AlpacaClient } from '../../../src/devices/alpaca/client'
import { AlpacaServer, type AlpacaServerOptions } from '../../../src/devices/alpaca/server'
import { type AlpacaDeviceType, AlpacaException, type AlpacaResponse } from '../../../src/devices/alpaca/types'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera, Cover, Device, DeviceProperties, Dome, FlatPanel, Focuser, Mount, Rotator, SafetyMonitor, Weather, Wheel } from '../../../src/devices/indi/device'
import { CameraManager, CoverManager, type DeviceManager, DomeManager, FlatPanelManager, FocuserManager, MountManager, RotatorManager, SafetyMonitorManager, WeatherManager, WheelManager } from '../../../src/devices/indi/manager'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { CoverSimulator } from '../../../src/devices/indi/simulator/cover'
import type { DeviceSimulator } from '../../../src/devices/indi/simulator/device'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import { FlatPanelSimulator } from '../../../src/devices/indi/simulator/flatpanel'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../../src/devices/indi/simulator/rotator'
import { SafetyMonitorSimulator } from '../../../src/devices/indi/simulator/safetymonitor'
import { WeatherSimulator } from '../../../src/devices/indi/simulator/weather'
import { WheelSimulator } from '../../../src/devices/indi/simulator/wheel'
import type { DefNumberVector } from '../../../src/devices/indi/types'
import { waitUntil } from '../../util'

// Fixtures that stand an INDI device simulator up behind its manager and expose it through the real
// embedded AlpacaServer on an ephemeral loopback port, plus the matching AlpacaClient at the far end.
//
// Driving the production server rather than a mocked fetch means the route table, the parameter parsing,
// and the unit conversions are all exercised for real, and the same fixture doubles as the target of a
// simulator to manager to server to client to manager round-trip. Every device type the simulators cover
// is registered below, so a new suite only needs the matching AlpacaTestDevice constant.

// A device type these fixtures can stand up end to end: how to build its INDI simulator and manager,
// which AlpacaServerOptions slot the manager occupies, and the Alpaca device type its routes live under.
export interface AlpacaTestDevice<D extends Device, M extends DeviceManager<D>, S extends DeviceSimulator> {
	// Alpaca device type, which is also the path segment shared by every route of the device.
	readonly type: AlpacaDeviceType
	// Name given to the simulated device unless the caller overrides it.
	readonly name: string
	readonly makeManager: () => M
	readonly makeSimulator: (name: string, client: ClientSimulator) => S
	// Puts the manager in the option slot AlpacaServer reads for this device type.
	readonly serverOptions: (manager: M) => AlpacaServerOptions
}

export const ALPACA_CAMERA: AlpacaTestDevice<Camera, CameraManager, CameraSimulator> = {
	type: 'camera',
	name: 'Camera Simulator',
	makeManager: () => new CameraManager(),
	makeSimulator: (name, client) => new CameraSimulator(name, client),
	serverOptions: (camera) => ({ camera }),
}

export const ALPACA_MOUNT: AlpacaTestDevice<Mount, MountManager, MountSimulator> = {
	type: 'telescope',
	name: 'Mount Simulator',
	makeManager: () => new MountManager(),
	makeSimulator: (name, client) => new MountSimulator(name, client),
	serverOptions: (mount) => ({ mount }),
}

export const ALPACA_FOCUSER: AlpacaTestDevice<Focuser, FocuserManager, FocuserSimulator> = {
	type: 'focuser',
	name: 'Focuser Simulator',
	makeManager: () => new FocuserManager(),
	makeSimulator: (name, client) => new FocuserSimulator(name, client),
	serverOptions: (focuser) => ({ focuser }),
}

export const ALPACA_WHEEL: AlpacaTestDevice<Wheel, WheelManager, WheelSimulator> = {
	type: 'filterwheel',
	name: 'Filter Wheel Simulator',
	makeManager: () => new WheelManager(),
	makeSimulator: (name, client) => new WheelSimulator(name, client),
	serverOptions: (wheel) => ({ wheel }),
}

export const ALPACA_ROTATOR: AlpacaTestDevice<Rotator, RotatorManager, RotatorSimulator> = {
	type: 'rotator',
	name: 'Rotator Simulator',
	makeManager: () => new RotatorManager(),
	makeSimulator: (name, client) => new RotatorSimulator(name, client),
	serverOptions: (rotator) => ({ rotator }),
}

export const ALPACA_DOME: AlpacaTestDevice<Dome, DomeManager, DomeSimulator> = {
	type: 'dome',
	name: 'Dome Simulator',
	makeManager: () => new DomeManager(),
	makeSimulator: (name, client) => new DomeSimulator(name, client),
	serverOptions: (dome) => ({ dome }),
}

// Cover and flat panel share the Alpaca covercalibrator type; a suite needing both halves passes the
// other manager through `extraOptions`.
export const ALPACA_COVER: AlpacaTestDevice<Cover, CoverManager, CoverSimulator> = {
	type: 'covercalibrator',
	name: 'Cover Simulator',
	makeManager: () => new CoverManager(),
	makeSimulator: (name, client) => new CoverSimulator(name, client),
	serverOptions: (cover) => ({ cover }),
}

export const ALPACA_FLAT_PANEL: AlpacaTestDevice<FlatPanel, FlatPanelManager, FlatPanelSimulator> = {
	type: 'covercalibrator',
	name: 'Flat Panel Simulator',
	makeManager: () => new FlatPanelManager(),
	makeSimulator: (name, client) => new FlatPanelSimulator(name, client),
	serverOptions: (flatPanel) => ({ flatPanel }),
}

// The safety monitor is transversal: it is discovered from SAFETY_STATUS rather than from a device type,
// and a parentless standalone is only allowed for an AUXILIARY driver, which is what its simulator is.
export const ALPACA_SAFETY_MONITOR: AlpacaTestDevice<SafetyMonitor, SafetyMonitorManager, SafetyMonitorSimulator> = {
	type: 'safetymonitor',
	name: 'Safety Monitor Simulator',
	makeManager: () => new SafetyMonitorManager({ get: () => undefined }),
	makeSimulator: (name, client) => new SafetyMonitorSimulator(name, client),
	serverOptions: (safetyMonitor) => ({ safetyMonitor }),
}

export const ALPACA_WEATHER: AlpacaTestDevice<Weather, WeatherManager, WeatherSimulator> = {
	type: 'observingconditions',
	name: 'Weather Simulator',
	makeManager: () => new WeatherManager(),
	makeSimulator: (name, client) => new WeatherSimulator(name, client),
	serverOptions: (weather) => ({ weather }),
}

export interface AlpacaTestServerOptions {
	// Whether the simulated device is connected before the server starts. False exercises the
	// NotConnected paths.
	connect?: boolean
	// Overrides the simulated device name.
	name?: string
	// Extra manager slots, for routes that read more than the device's own manager (a covercalibrator
	// needing both halves, a camera needing its guide output).
	extraOptions?: AlpacaServerOptions
}

export interface AlpacaTestServer<D extends Device, M extends DeviceManager<D>, S extends DeviceSimulator> extends AsyncDisposable {
	readonly manager: M
	readonly simulator: S
	// The in-process INDI client the simulator publishes through.
	readonly indiClient: ClientSimulator
	readonly device: D
	readonly server: AlpacaServer
	readonly url: string
	readonly deviceNumber: number
	// '/api/v1/<type>/<deviceNumber>', the prefix shared by every per-device route.
	readonly path: string
	// Raw INDI property view of the device, for assertions on what the driver actually published.
	readonly properties: () => DeviceProperties | undefined
	readonly get: (path: string) => Promise<AlpacaResponse<unknown>>
	readonly put: (path: string, body?: Record<string, string>) => Promise<AlpacaResponse<unknown>>
}

// Redefines WEATHER_PARAMETERS without the named INDI elements, which is how a driver withdraws a sensor.
// Clearing the typed field alone does not: the element set is what states which sensors the driver has, so
// a sensor it still declares stays implemented and reports ValueNotSet rather than 1024.
export function withdrawWeatherSensors(fixture: AlpacaWeatherServer, ...names: readonly string[]) {
	const parameters = fixture.manager.properties.get(fixture.device)!.WEATHER_PARAMETERS as DefNumberVector
	const elements = { ...parameters.elements }

	for (const name of names) delete elements[name]

	const message = { ...parameters, elements }
	fixture.manager.numberVector(fixture.indiClient, message, 'defNumberVector')
	fixture.manager.vector(fixture.indiClient, message, 'defNumberVector')
}

// Starts one simulated device behind the embedded Alpaca server on an ephemeral loopback port.
//
// Always dispose the result (`await using`), or the server's 30 s tick and its socket leak into the rest
// of the run.
export async function startAlpacaServer<D extends Device, M extends DeviceManager<D>, S extends DeviceSimulator>(kind: AlpacaTestDevice<D, M, S>, options?: AlpacaTestServerOptions): Promise<AlpacaTestServer<D, M, S>> {
	const handler = new IndiClientHandlerSet()
	const manager = kind.makeManager()
	handler.add(manager)

	const indiClient = new ClientSimulator(`${kind.type}-${Bun.randomUUIDv7()}`, handler)
	const name = options?.name ?? kind.name
	const simulator = kind.makeSimulator(name, indiClient)

	// A transversal device such as the safety monitor only materializes once its own property arrives,
	// which needs a connection, so wait on the manager rather than assuming the device already exists.
	if (options?.connect === false) {
		await waitUntil(() => manager.has(indiClient, name))
	} else {
		simulator.connect()
		await waitUntil(() => manager.get(indiClient, name)?.connected === true)
	}

	const device = manager.get(indiClient, name)!
	const server = new AlpacaServer({ ...kind.serverOptions(manager), ...options?.extraOptions })
	server.start('127.0.0.1', 0)

	const url = `http://127.0.0.1:${server.port}`
	const configured = Array.from(server.configuredDevices()).find((e) => e.DeviceType === kind.type)!

	async function get(path: string) {
		const response = await fetch(new URL(path, url))
		return (await response.json()) as AlpacaResponse<unknown>
	}

	async function put(path: string, body?: Record<string, string>) {
		const response = await fetch(new URL(path, url), { method: 'PUT', body: body && new URLSearchParams(body) })
		return (await response.json()) as AlpacaResponse<unknown>
	}

	return {
		manager,
		simulator,
		indiClient,
		device,
		server,
		url,
		deviceNumber: configured.DeviceNumber,
		path: `/api/v1/${kind.type}/${configured.DeviceNumber}`,
		properties: () => manager.properties.get(device),
		get,
		put,
		async [Symbol.asyncDispose]() {
			server.stop()
			simulator.dispose()
			indiClient[Symbol.dispose]()
			// Give Bun.serve a tick to release the port before the next fixture binds one.
			await Bun.sleep(0)
		},
	}
}

export interface AlpacaTestClient<D extends Device, M extends DeviceManager<D>> extends AsyncDisposable {
	readonly manager: M
	readonly client: AlpacaClient
	readonly device: () => D | undefined
	// Raw INDI property view of the device the client synthesized, once it exists.
	readonly properties: () => DeviceProperties | undefined
}

// Points a real AlpacaClient at `url` and feeds its synthesized INDI vectors into a second manager of the
// same type, which is the far end of the simulator to manager to server to client to manager round-trip.
export async function startAlpacaClient<D extends Device, M extends DeviceManager<D>, S extends DeviceSimulator>(url: string, kind: AlpacaTestDevice<D, M, S>): Promise<AlpacaTestClient<D, M>> {
	const handler = new IndiClientHandlerSet()
	const manager = kind.makeManager()
	handler.add(manager)

	const client = new AlpacaClient(url, { handler }, { get: () => undefined })
	await client.start()

	const device = () => Array.from(manager.list(client))[0] as D | undefined

	return {
		manager,
		client,
		device,
		properties: () => {
			const current = device()
			return current && manager.properties.get(current)
		},
		async [Symbol.asyncDispose]() {
			client.stop()
			await Bun.sleep(0)
		},
	}
}

// One scripted proxy answer: a value to wrap in the Alpaca envelope, an Alpaca error number, or a raw
// HTTP status for a transport-level fault.
export type AlpacaTestProxyResponse = { readonly value: unknown } | { readonly errorNumber: number } | { readonly status: number }

export interface AlpacaTestProxyOptions {
	// Path suffixes answered with MethodOrPropertyNotImplemented instead of being forwarded. Passing
	// '/devicestate' drives a client onto its per-property fallback.
	readonly notImplemented?: readonly string[]
	// Answers a request instead of forwarding it, so a suite can script a driver the simulator cannot
	// produce: an asymmetric capability, a value outside the server's own conventions, or a transient
	// fault. Returning undefined forwards the request unchanged.
	readonly respond?: (path: string, url: URL) => AlpacaTestProxyResponse | undefined
}

export interface AlpacaTestProxy extends AsyncDisposable {
	readonly url: string
	readonly paths: readonly string[]
	// How many requests hit a path ending in `suffix`, for proving that a capability is probed once and
	// then dropped from the polling set.
	readonly countOf: (suffix: string) => number
}

// Forwards to a running Alpaca server while recording every request, optionally faking an unimplemented
// member. Lets a suite assert what the client actually asked for, not just what it ended up holding.
export function startAlpacaProxy(target: string, options?: AlpacaTestProxyOptions): AlpacaTestProxy {
	const paths: string[] = []
	const notImplemented = options?.notImplemented ?? []

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		development: false,
		async fetch(req) {
			const url = new URL(req.url)
			paths.push(url.pathname)

			if (notImplemented.some((suffix) => url.pathname.endsWith(suffix))) {
				return Response.json({ Value: null, ClientTransactionID: 0, ServerTransactionID: 0, ErrorNumber: AlpacaException.MethodOrPropertyNotImplemented, ErrorMessage: `${url.pathname} is not implemented` })
			}

			const scripted = options?.respond?.(url.pathname, url)

			if (scripted !== undefined) {
				if ('status' in scripted) return new Response('scripted failure', { status: scripted.status })
				const errorNumber = 'errorNumber' in scripted ? scripted.errorNumber : 0
				const value = 'value' in scripted ? scripted.value : null
				return Response.json({ Value: value, ClientTransactionID: 0, ServerTransactionID: 0, ErrorNumber: errorNumber, ErrorMessage: errorNumber === 0 ? '' : 'scripted error' })
			}

			const body = req.method === 'PUT' ? await req.text() : undefined
			const headers = body === undefined ? undefined : { 'Content-Type': req.headers.get('Content-Type') ?? 'application/x-www-form-urlencoded' }
			return await fetch(new URL(`${url.pathname}${url.search}`, target), { method: req.method, headers, body })
		},
	})

	return {
		paths,
		url: `http://127.0.0.1:${server.port}`,
		countOf(suffix) {
			let total = 0
			for (const path of paths) if (path.endsWith(suffix)) total++
			return total
		},
		async [Symbol.asyncDispose]() {
			await server.stop(true)
		},
	}
}

// Concrete fixture types for the registered devices, so a suite can annotate a helper without repeating
// the three type parameters.
export type AlpacaCameraServer = AlpacaTestServer<Camera, CameraManager, CameraSimulator>
export type AlpacaMountServer = AlpacaTestServer<Mount, MountManager, MountSimulator>
export type AlpacaFocuserServer = AlpacaTestServer<Focuser, FocuserManager, FocuserSimulator>
export type AlpacaWheelServer = AlpacaTestServer<Wheel, WheelManager, WheelSimulator>
export type AlpacaRotatorServer = AlpacaTestServer<Rotator, RotatorManager, RotatorSimulator>
export type AlpacaDomeServer = AlpacaTestServer<Dome, DomeManager, DomeSimulator>
export type AlpacaCoverServer = AlpacaTestServer<Cover, CoverManager, CoverSimulator>
export type AlpacaFlatPanelServer = AlpacaTestServer<FlatPanel, FlatPanelManager, FlatPanelSimulator>
export type AlpacaSafetyMonitorServer = AlpacaTestServer<SafetyMonitor, SafetyMonitorManager, SafetyMonitorSimulator>
export type AlpacaWeatherServer = AlpacaTestServer<Weather, WeatherManager, WeatherSimulator>
export type AlpacaWeatherClient = AlpacaTestClient<Weather, WeatherManager>
