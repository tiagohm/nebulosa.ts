import { angularDistance } from '../../../astronomy/coordinates/coordinate'
import { Gnomonic } from '../../../astronomy/projections/projection'
import type { Point } from '../../../math/numerical/geometry'
import { mulberry32 } from '../../../math/numerical/random'
import { type Angle, deg } from '../../../math/units/angle'
import { findOnSwitch, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { CameraSceneConfig } from './camera.config'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { CatalogSource, CatalogSourceStar, CatalogSourceType } from './types'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Sky circuit of the simulated camera: the stars in front of the telescope. They come either from a
// catalog source or from a seeded random field, and in both cases have fixed J2000 coordinates, so the
// field moves on the sensor exactly as the mount moves on the sky. Angles are radians; the random
// field's density is per square unbinned pixel.

// Scene parameters, SIMULATOR_SCENE.
const SCENE: readonly NumberBinding<'seed' | 'starDensity' | 'seeing' | 'hfdMin' | 'hfdMax' | 'fluxMin' | 'fluxMax'>[] = [
	['SCENE_SEED', 'Seed', 'seed', 0, 0xffffffff, 1, '%.0f'],
	['STAR_DENSITY', 'Star Density', 'starDensity', 0, 0.01, 0.0001, '%.6f'],
	['SEEING', 'Seeing (px)', 'seeing', 0, 20, 0.1, '%.2f'],
	['HFD_MIN', 'HFD Min (px)', 'hfdMin', 0.35, 10, 0.1, '%.2f'],
	['HFD_MAX', 'HFD Max (px)', 'hfdMax', 0.35, 20, 0.1, '%.2f'],
	['FLUX_MIN', 'Flux Min', 'fluxMin', 0, 10, 0.001, '%.4f'],
	['FLUX_MAX', 'Flux Max', 'fluxMax', 0, 100, 0.01, '%.4f'],
]

// Side of a tile of the random field, pixels of its tangent plane. Each tile is drawn from its own
// seed, so the field covering a larger cone only adds tiles and never moves the stars already drawn.
const RANDOM_TILE_SIZE = 256

// Farthest a cone may lie from the anchor of the random field before the field is re-anchored on it,
// radians. Beyond this the gnomonic plane the tiles live in is too distorted to stand for the sky.
const RANDOM_ANCHOR_REACH = deg(20)

// Factor by which a catalog query widens the cone a frame needs, so the frames that follow, displaced
// by guiding, drift or a dither, are served from the same query.
const CATALOG_QUERY_SLACK = 1.25

// Stars of the last catalog query and the cone it covered.
interface CatalogQuery {
	// Catalog source the stars came from.
	readonly type: CatalogSourceType
	// Centre and radius of the cone queried, J2000 radians.
	readonly center: readonly [Angle, Angle]
	readonly radius: Angle
	readonly stars: readonly CatalogSourceStar[]
}

// Draws the stars of tile (`column`, `row`) of a random field anchored at `anchor`, J2000 radians, with
// `pixelScale` radians per pixel. Positions are uniform in the tile of the anchor's tangent plane, and
// the same scene, tile and scale always give the same stars.
//
// Brightness follows a steep power law, so most stars are faint and few are bright, and the
// signal-to-noise ratio and half-flux diameter of each are drawn with it.
export function randomStarTile(scene: CameraSceneConfig, anchor: readonly [Angle, Angle], pixelScale: Angle, column: number, row: number): CatalogSourceStar[] {
	const random = mulberry32((scene.seed ^ Math.imul(column, 0x9e3779b1) ^ Math.imul(row, 0x85ebca77)) >>> 0)
	const count = Math.trunc(RANDOM_TILE_SIZE * RANDOM_TILE_SIZE * scene.starDensity)
	const maxHfd = Math.max(scene.hfdMin, scene.hfdMax)
	const maxFlux = Math.max(scene.fluxMin, scene.fluxMax)
	const projection = new Gnomonic(anchor[0], anchor[1])
	const point: Point = { x: 0, y: 0 }
	const stars: CatalogSourceStar[] = []

	for (let i = 0; i < count; i++) {
		const brightness = 1 - random()
		const x = (column + random()) * RANDOM_TILE_SIZE * pixelScale
		const y = (row + random()) * RANDOM_TILE_SIZE * pixelScale
		const hfd = scene.hfdMin + (maxHfd - scene.hfdMin) * random()
		const colorIndex = -0.25 + random() * 1.9
		if (projection.unproject(x, y, point) === undefined) continue
		stars.push({ rightAscension: point.x, declination: point.y, flux: scene.fluxMin + (maxFlux - scene.fluxMin) * brightness ** 6, hfd, snr: 12 + brightness * 180, colorIndex })
	}

	return stars
}

// Star source of the camera: catalog or random field, cached across frames.
export class CameraSky extends SimulatorComponent {
	readonly #scene: ReturnType<typeof makeBoundNumberVector>
	readonly #source = makeSwitchVector('', 'SIMULATOR_CATALOG_SOURCE', 'Catalog Source', SIMULATION, 'OneOfMany', 'rw', ['RANDOM', 'Random', true])

	readonly properties: readonly (ReturnType<typeof makeBoundNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// Random field: its anchor, the scale and scene it was drawn for, and its tiles by "column:row".
	#anchor?: readonly [Angle, Angle]
	#anchorScale = 0
	#tiles = new Map<string, readonly CatalogSourceStar[]>()
	// Last catalog query.
	#query?: CatalogQuery

	// `config` gives the initial scene and source; `sources` are the catalog sources by name, of which
	// those present become selectable besides 'RANDOM'.
	constructor(
		bus: ComponentBus,
		config: CameraSceneConfig,
		readonly sources: Readonly<Record<string, CatalogSource | undefined | null>> = {},
	) {
		super(bus)
		this.#scene = makeBoundNumberVector('SIMULATOR_SCENE', 'Scene', SIMULATION, SCENE, config)
		this.properties = [this.#scene, this.#source]

		for (const name in sources) {
			if (sources[name]) this.#source.elements[name] = { name, label: name, value: false }
		}

		applyExclusiveSwitchValues(this.#source, { [this.sources[config.catalogSource] ? config.catalogSource : 'RANDOM']: true })
	}

	// Selected star source.
	get catalogSourceType(): CatalogSourceType {
		return findOnSwitch(this.#source)[0]
	}

	// Current scene parameters.
	snapshot(): CameraSceneConfig {
		return { ...readBoundNumberVector(this.#scene, SCENE), catalogSource: this.catalogSourceType }
	}

	// Stars that may fall inside the cone of `radius` around `center`, J2000 radians, for a sensor of
	// `pixelScale` radians per pixel. May return stars outside the cone; the caller projects and clips. A
	// catalog is consulted only when `pointed`: a cone with no real pointing behind it, such as that of a
	// camera without a mount, is not a place on the sky, so it gets the random field.
	//
	// A catalog source is queried again only when the cone leaves the one last queried. Network-backed
	// sources are allowed, so the query is widened by CATALOG_QUERY_SLACK and the stars it returned are
	// never modified.
	async stars(center: readonly [Angle, Angle], radius: Angle, pixelScale: Angle, pointed: boolean = true): Promise<readonly CatalogSourceStar[]> {
		const type = this.catalogSourceType
		const source = this.sources[type]
		if (type === 'RANDOM' || !source || !pointed) return this.#randomStars(center, radius, pixelScale)

		const query = this.#query
		if (query !== undefined && query.type === type && angularDistance(query.center[0], query.center[1], center[0], center[1]) + radius <= query.radius) return query.stars

		const queryRadius = radius * CATALOG_QUERY_SLACK
		const stars = await source(center[0], center[1], queryRadius)
		this.#query = { type, center, radius: queryRadius, stars }
		return stars
	}

	// Handles SIMULATOR_SCENE; any change discards the random field.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#scene.name) return false

		if (applyNumberVectorValues(this.#scene, vector.elements)) {
			this.#discardRandomField()
			this.bus.notify(this.#scene)
		}

		return true
	}

	// Handles SIMULATOR_CATALOG_SOURCE.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#source.name) return false
		if (applyExclusiveSwitchValues(this.#source, vector.elements)) this.bus.notify(this.#source)
		return true
	}

	// Discards the random field, whose scene may have been replaced by persisted values.
	loaded() {
		this.#discardRandomField()
	}

	// Forgets the anchor and the tiles of the random field.
	#discardRandomField() {
		this.#anchor = undefined
		this.#tiles.clear()
	}

	// Random-field stars of the tiles covering the cone, drawing the missing tiles and forgetting those
	// no longer covered, which bounds the cache to one frame's worth. Re-anchors the field on the cone
	// when it is the first, the scale changed or the cone is out of reach.
	#randomStars(center: readonly [Angle, Angle], radius: Angle, pixelScale: Angle) {
		if (this.#anchor === undefined || this.#anchorScale !== pixelScale || angularDistance(this.#anchor[0], this.#anchor[1], center[0], center[1]) + radius > RANDOM_ANCHOR_REACH) {
			this.#discardRandomField()
			this.#anchor = center
			this.#anchorScale = pixelScale
		}

		const anchor = this.#anchor
		const point = new Gnomonic(anchor[0], anchor[1]).project(center[0], center[1], { x: 0, y: 0 }) ?? { x: 0, y: 0 }
		// Half side of the square of tiles to cover, pixels of the anchor's plane. Widened by the
		// gnomonic scale at the cone, which grows as 1/cos² of the distance from the anchor.
		const distance = angularDistance(anchor[0], anchor[1], center[0], center[1])
		const half = Math.tan(radius) / pixelScale / Math.cos(distance) ** 2
		const firstColumn = Math.floor((point.x / pixelScale - half) / RANDOM_TILE_SIZE)
		const lastColumn = Math.floor((point.x / pixelScale + half) / RANDOM_TILE_SIZE)
		const firstRow = Math.floor((point.y / pixelScale - half) / RANDOM_TILE_SIZE)
		const lastRow = Math.floor((point.y / pixelScale + half) / RANDOM_TILE_SIZE)
		const scene = this.snapshot()
		const tiles = new Map<string, readonly CatalogSourceStar[]>()
		const stars: CatalogSourceStar[] = []

		for (let row = firstRow; row <= lastRow; row++) {
			for (let column = firstColumn; column <= lastColumn; column++) {
				const key = `${column}:${row}`
				const tile = this.#tiles.get(key) ?? randomStarTile(scene, anchor, pixelScale, column, row)
				tiles.set(key, tile)
				for (const star of tile) stars.push(star)
			}
		}

		this.#tiles = tiles
		return stars
	}
}
