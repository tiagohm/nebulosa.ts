export const BASE_URL = 'https://www.astrobin.com/'

const EQUIPMENT_PATH = 'api/v2/equipment/'
const SENSOR_PATH = `${EQUIPMENT_PATH}sensor/`
const CAMERA_PATH = `${EQUIPMENT_PATH}camera/`
const TELESCOPE_PATH = `${EQUIPMENT_PATH}telescope/`

export type SensorColor = 'M' | 'C'

export interface AstrobinEquipment {
	readonly id: number
	readonly brandName: string
	readonly name: string
}

export interface AstrobinPage<T extends AstrobinEquipment> {
	readonly count: number
	readonly results: T[]
	readonly next?: string
	readonly previous?: string
}

export interface AstrobinCamera extends AstrobinEquipment {
	readonly cooled: boolean
	readonly sensor: number
	readonly type: string
}

export interface AstrobinSensor extends AstrobinEquipment {
	readonly quantumEfficiency: string
	readonly pixelSize: string
	readonly pixelWidth: number
	readonly pixelHeight: number
	readonly readNoise: string
	readonly fullWellCapacity: string
	readonly frameRate: number
	readonly adc: number
	readonly colorOrMono: SensorColor
	readonly cameras: number[]
}

export interface AstrobinTelescope extends AstrobinEquipment {
	readonly type: string
	readonly aperture: string
	readonly minFocalLength: string
	readonly maxFocalLength: string
}

const DEFAULT_HEADERS: Record<string, string> = { Accept: 'application/json' }

export async function sensors(page: number) {
	const uri = `${BASE_URL}${SENSOR_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinPage<AstrobinSensor>
}

export async function sensor(id: number) {
	const uri = `${BASE_URL}${SENSOR_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinSensor
}

export async function cameras(page: number) {
	const uri = `${BASE_URL}${CAMERA_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinPage<AstrobinCamera>
}

export async function camera(id: number) {
	const uri = `${BASE_URL}${CAMERA_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinCamera
}

export async function telescopes(page: number) {
	const uri = `${BASE_URL}${TELESCOPE_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinPage<AstrobinTelescope>
}

export async function telescope(id: number) {
	const uri = `${BASE_URL}${TELESCOPE_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return (await response.json()) as AstrobinTelescope
}
