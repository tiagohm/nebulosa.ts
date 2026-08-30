import { CLIENT, type Client, DEFAULT_SAFETY_MONITOR, type Device, DeviceInterfaceType, isInterfaceType, isSafetyMonitor, isSubDevice, type SafetyMonitor, type SubDevice } from '../device'
import type { DefLightVector, DefSwitchVector, DefTextVector, DelProperty, SetLightVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, type DeviceProvider, makeDevice, makeDeviceId, proxyDevice } from './device'

// Cached discovery vectors used when a safety property arrives before driver identity or connection.
interface PendingSafetyMonitor {
	// Latest driver metadata used to classify INDI standalone devices and populate identity.
	driverInfo?: DefTextVector | SetTextVector
	// Latest connection vector used to seed standalone connection state.
	connection?: DefSwitchVector | SetSwitchVector
	// Latest safety vector used to seed the fail-closed domain state.
	safetyStatus?: DefLightVector | SetLightVector
}

// Manager for the transversal INDI SAFETY_STATUS light property. Known primary devices are exposed through
// a safety-monitor proxy; a native INDI standalone is created only for an AUXILIARY driver.
export class SafetyMonitorManager extends DeviceManager<SafetyMonitor> {
	// Discovery state is isolated by client and released when that client closes.
	readonly #pendingByClient = new WeakMap<Client, Map<string, PendingSafetyMonitor>>()

	// Parent provider must cover the primary device managers and must not resolve this manager itself.
	constructor(readonly provider: DeviceProvider<Device>) {
		super()
	}

	// Returns the cached discovery state for one physical device, creating it when requested.
	#pending(client: Client, name: string, create: boolean = true) {
		let devices = this.#pendingByClient.get(client)

		if (devices === undefined) {
			if (!create) return undefined
			devices = new Map()
			this.#pendingByClient.set(client, devices)
		}

		let pending = devices.get(name)

		if (pending === undefined && create) {
			pending = {}
			devices.set(name, pending)
		}

		return pending
	}

	// Whether the cached driver identity authorizes a parentless standalone for this backend.
	#canCreateStandalone(client: Client, pending: PendingSafetyMonitor) {
		if (client.type === 'ALPACA') return true
		const value = pending.driverInfo?.elements.DRIVER_INTERFACE?.value
		return value !== undefined && isInterfaceType(+value, DeviceInterfaceType.AUXILIARY)
	}

	// Creates a proxy or authorized standalone, or migrates a standalone when its primary parent appears.
	// TODO: SafetyMonitorManager.#materialize() exige que SAFETY_STATUS já tenha sido recebido.
	// Porém, tanto o driver INDI quanto AlpacaSafetyMonitor publicam essa propriedade somente depois da conexão.
	// Assim, o dispositivo não entra no manager, e o consumidor não consegue obter o dispositivo para chamar connect() — um ciclo impossível.
	// A documentação do driver confirma que SAFETY_STATUS é definido em updateProperties() apenas quando conectado.
	// Solução: criar um Auxiliary e AuxiliaryManager e fazer a conexão dele em vez do SafetyMonitor (pois não existe ainda no SafetyMonitorManager)
	#materialize(client: Client, name: string) {
		const parent = this.provider.get(client, name)
		let device = this.get(client, name)

		if (device !== undefined && parent !== undefined && device.parentId === undefined) {
			this.remove(device)
			device = undefined
		}

		if (device !== undefined) return device

		const pending = this.#pending(client, name)!
		if (pending.safetyStatus === undefined) return undefined

		const state = pending.safetyStatus?.state

		if (parent !== undefined) {
			const id = makeDeviceId(client, 'safetyMonitor', parent.name)
			device = proxyDevice(parent, id, 'safetyMonitor') as SubDevice<SafetyMonitor, Device>
			device.safe = state === 'Ok'
			this.add(device, client)
			return device
		}

		if (!this.#canCreateStandalone(client, pending)) return undefined

		const standalone = makeDevice(DEFAULT_SAFETY_MONITOR, client, name, pending.driverInfo?.elements)
		standalone.connected = pending.connection?.elements.CONNECT?.value === true
		standalone.safe = state === 'Ok'
		this.add(standalone, client)
		return standalone
	}

	// Caches driver identity, materializes pending devices, and refreshes standalone driver metadata.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name !== 'DRIVER_INFO') return

		this.#pending(client, message.device)!.driverInfo = message
		this.#materialize(client, message.device)
	}

	// Caches and applies the common CONNECTION switch after a safety device can be materialized.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		if (message.name !== 'CONNECTION') return

		this.#pending(client, message.device)!.connection = message
		const device = this.#materialize(client, message.device)

		if (device !== undefined) {
			super.switchVector(client, message, tag)
		}
	}

	// Applies the aggregate SAFETY_STATUS state; omitted set-vector states preserve the previous value.
	lightVector(client: Client, message: DefLightVector | SetLightVector, tag: string) {
		if (message.name !== 'SAFETY_STATUS') return

		this.#pending(client, message.device)!.safetyStatus = message
		const device = this.#materialize(client, message.device)

		if (device === undefined) return

		if (message.state !== undefined) {
			const safe = message.state === 'Ok'

			if (device.safe !== safe) {
				device.safe = safe
				this.updated(device, 'safe', message.state)

				if (isSubDevice<SafetyMonitor>(device) && isSafetyMonitor(device.parent)) {
					this.updated(device.parent, 'safe', message.state)
				}
			}
		}
	}

	// Removes a safety capability fail-closed while retaining driver metadata for a later redefinition.
	delProperty(client: Client, message: DelProperty) {
		if (message.name && message.name !== 'SAFETY_STATUS') {
			super.delProperty(client, message)
			return
		}

		const device = this.get(client, message.device)

		if (device !== undefined) {
			device.safe = false
			this.updated(device, 'safe', 'Idle')

			if (isSubDevice<SafetyMonitor>(device) && isSafetyMonitor(device.parent)) {
				this.updated(device.parent, 'safe', 'Idle')
			}

			super.delProperty(client, message.name ? { ...message, name: undefined } : message)
		}

		const devices = this.#pendingByClient.get(client)

		if (message.name) {
			const pending = devices?.get(message.device)
			if (pending !== undefined) pending.safetyStatus = undefined
		} else {
			devices?.delete(message.device)
		}
	}

	// Drops all managed devices, raw properties, and discovery vectors belonging to a closed client.
	close(client: Client, server: boolean) {
		super.close(client, server)
		this.#pendingByClient.delete(client)
	}
}
