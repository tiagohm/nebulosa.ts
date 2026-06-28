// Client for the AstroBin equipment API v2: paginated lookups of sensors, cameras, and telescopes by
// page or id. Numeric specs are returned as strings by the API and kept as such here.

// AstroBin website / API base URL.
export const BASE_URL = 'https://www.astrobin.com/'

// API path prefix for equipment endpoints.
const EQUIPMENT_PATH = 'api/v2/equipment/'
// Sensor endpoint path.
const SENSOR_PATH = `${EQUIPMENT_PATH}sensor/`
// Camera endpoint path.
const CAMERA_PATH = `${EQUIPMENT_PATH}camera/`
// Telescope endpoint path.
const TELESCOPE_PATH = `${EQUIPMENT_PATH}telescope/`

// Sensor color type: 'M' monochrome or 'C' color.
export type SensorColor = 'M' | 'C'

// Common fields shared by all equipment records.
export interface AstrobinEquipment {
	readonly id: number
	readonly brandName: string
	readonly name: string
}

// One page of a paginated equipment listing.
export interface AstrobinPage<T extends AstrobinEquipment> {
	// Total item count across all pages.
	readonly count: number
	readonly results: T[]
	// URL of the next page, if any.
	readonly next?: string
	// URL of the previous page, if any.
	readonly previous?: string
}

// A camera record.
export interface AstrobinCamera extends AstrobinEquipment {
	readonly cooled: boolean
	// Id of the associated sensor.
	readonly sensor: number
	readonly type: string
}

// A sensor record (numeric specs are strings as returned by the API).
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
	// Ids of cameras using this sensor.
	readonly cameras: number[]
}

// A telescope record.
export interface AstrobinTelescope extends AstrobinEquipment {
	readonly type: string
	readonly aperture: string
	readonly minFocalLength: string
	readonly maxFocalLength: string
}

// Default request headers (JSON).
const DEFAULT_HEADERS: Record<string, string> = { Accept: 'application/json' }

// Parses a JSON response, returning undefined (and logging) on a failed or empty response.
async function parseResponse<T>(response: Response) {
	const text = await response.text()

	if (!response.ok || !text) {
		console.error('failed to fetch astrobin:', response.status, response.url, text)
		return undefined
	}

	return JSON.parse(text) as T
}

// Fetches one page of sensors. Performs a network request.
export async function sensors(page: number) {
	const uri = `${BASE_URL}${SENSOR_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return parseResponse<AstrobinPage<AstrobinSensor>>(response)
}

// Fetches one sensor by id.
export async function sensor(id: number) {
	const uri = `${BASE_URL}${SENSOR_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return parseResponse<AstrobinSensor>(response)
}

// Fetches one page of cameras.
export async function cameras(page: number) {
	const uri = `${BASE_URL}${CAMERA_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return parseResponse<AstrobinPage<AstrobinCamera>>(response)
}

// Fetches one camera by id.
export async function camera(id: number) {
	const uri = `${BASE_URL}${CAMERA_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return parseResponse<AstrobinCamera>(response)
}

// Fetches one page of telescopes.
export async function telescopes(page: number) {
	const uri = `${BASE_URL}${TELESCOPE_PATH}?page=${page}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return parseResponse<AstrobinPage<AstrobinTelescope>>(response)
}

// Fetches one telescope by id.
export async function telescope(id: number) {
	const uri = `${BASE_URL}${TELESCOPE_PATH}${id}`
	const response = await fetch(uri, { headers: DEFAULT_HEADERS })
	return await parseResponse<AstrobinTelescope>(response)
}
