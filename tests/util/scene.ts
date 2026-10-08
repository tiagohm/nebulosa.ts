import { TAU } from '../../src/core/constants'
import type { CfaPattern, Image } from '../../src/imaging/model/types'
import { mulberry32 } from '../../src/math/numerical/random'

// Deterministic synthetic Solar-System scenes for registration, limb and tracker tests. Scenes are
// continuous functions of image coordinates (pixel centers at integers, +X right, +Y down), so rigid
// motion is applied analytically instead of by resampling.

export type Scene = (x: number, y: number) => number

// Rigid image motion: a reference point p appears at R(rotation)·(p - center) + center + [dx, dy].
export interface SceneMotion {
	readonly dx: number
	readonly dy: number
	readonly rotation?: number
	readonly centerX?: number
	readonly centerY?: number
}

export interface RenderOptions {
	readonly motion?: SceneMotion
	// Local displacement field added in current-image coordinates before sampling (seeing).
	readonly warp?: (x: number, y: number) => readonly [number, number]
	readonly gain?: number
	readonly offset?: number
	// Additional illumination gradient per pixel along X and Y.
	readonly gradient?: readonly [number, number]
	readonly noise?: number
	readonly seed?: number
	readonly precision?: 32 | 64
	// RGB channel gains for a three-channel image.
	readonly rgb?: readonly [number, number, number]
	// Non-debayered CFA pattern with per-color gains [R, G, B].
	readonly cfa?: { readonly pattern: CfaPattern; readonly gains: readonly [number, number, number] }
	// Pixels whose value is replaced by NaN.
	readonly invalid?: (x: number, y: number) => boolean
	// Values at or above this level are clipped to it.
	readonly clip?: number
}

interface Blob {
	readonly x: number
	readonly y: number
	readonly amplitude: number
	readonly inverseTwoSigma2: number
	readonly reach: number
}

// Multiscale Gaussian bump texture (crater/plage-like) with bucketed evaluation.
export function textureScene(seed: number, width: number, height: number, count: number = 220, minSigma: number = 1.6, maxSigma: number = 7): Scene {
	const random = mulberry32(seed)
	const blobs: Blob[] = []
	const margin = 64

	for (let i = 0; i < count; i++) {
		const sigma = minSigma + (maxSigma - minSigma) * random() ** 2
		blobs.push({ x: -margin + random() * (width + 2 * margin), y: -margin + random() * (height + 2 * margin), amplitude: (random() < 0.5 ? -1 : 1) * (0.4 + random()), inverseTwoSigma2: 1 / (2 * sigma * sigma), reach: 4 * sigma })
	}

	const cell = 16
	const columns = Math.ceil((width + 2 * margin) / cell) + 1
	const rows = Math.ceil((height + 2 * margin) / cell) + 1
	const buckets: Blob[][] = Array.from({ length: columns * rows }, () => [])

	for (const blob of blobs) {
		const x0 = Math.max(0, Math.floor((blob.x - blob.reach + margin) / cell))
		const x1 = Math.min(columns - 1, Math.floor((blob.x + blob.reach + margin) / cell))
		const y0 = Math.max(0, Math.floor((blob.y - blob.reach + margin) / cell))
		const y1 = Math.min(rows - 1, Math.floor((blob.y + blob.reach + margin) / cell))
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) buckets[y * columns + x].push(blob)
	}

	return (x, y) => {
		const bx = Math.floor((x + margin) / cell)
		const by = Math.floor((y + margin) / cell)
		if (bx < 0 || by < 0 || bx >= columns || by >= rows) return 0
		let sum = 0

		for (const blob of buckets[by * columns + bx]) {
			const dx = x - blob.x
			const dy = y - blob.y
			const d2 = dx * dx + dy * dy
			if (d2 < blob.reach * blob.reach) sum += blob.amplitude * Math.exp(-d2 * blob.inverseTwoSigma2)
		}

		return sum
	}
}

export interface DiskOptions {
	readonly x: number
	readonly y: number
	readonly radius: number
	// Minor/major axis ratio; 1 is a circle.
	readonly axisRatio?: number
	// Major-axis angle in radians.
	readonly theta?: number
	readonly brightness?: number
	readonly background?: number
	// Linear limb-darkening coefficient u in I = 1 - u(1 - μ).
	readonly limbDarkening?: number
	// Gaussian edge softening, in pixels.
	readonly edgeSigma?: number
	// Interior texture added with this amplitude, relative to brightness.
	readonly texture?: Scene
	readonly textureAmplitude?: number
	// Illuminated fraction direction: points with (p - center)·[cos, sin] < -terminator·radius are dark.
	readonly terminator?: { readonly angle: number; readonly offset: number }
	// Bright ring ellipse (Saturn-like): semi-major/minor radius in pixels and brightness.
	readonly ring?: { readonly inner: number; readonly outer: number; readonly axisRatio: number; readonly brightness: number }
}

// Error-function approximation (Abramowitz-Stegun 7.1.26) for soft disk edges.
function erf(x: number) {
	const sign = x < 0 ? -1 : 1
	const a = Math.abs(x)
	const t = 1 / (1 + 0.3275911 * a)
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
	return sign * y
}

// Uniform or limb-darkened textured (elliptical) disk on a flat background.
export function diskScene(options: DiskOptions): Scene {
	const { x: cx, y: cy, radius } = options
	const ratio = options.axisRatio ?? 1
	const theta = options.theta ?? 0
	const cos = Math.cos(theta)
	const sin = Math.sin(theta)
	const brightness = options.brightness ?? 1
	const background = options.background ?? 0
	const u = options.limbDarkening ?? 0
	const edge = options.edgeSigma ?? 0.7
	const textureAmplitude = options.textureAmplitude ?? 0

	return (x, y) => {
		const dx = x - cx
		const dy = y - cy
		const a = dx * cos + dy * sin
		const b = (-dx * sin + dy * cos) / ratio
		const r = Math.hypot(a, b)
		const inside = 0.5 * (1 - erf((r - radius) / (Math.SQRT2 * edge)))
		const mu = Math.sqrt(Math.max(0, 1 - Math.min(1, r / radius) ** 2))
		let value = brightness * (1 - u * (1 - mu))
		if (options.texture !== undefined) value *= 1 + textureAmplitude * options.texture(x, y)

		if (options.terminator !== undefined) {
			const projection = dx * Math.cos(options.terminator.angle) + dy * Math.sin(options.terminator.angle)
			value *= 0.5 * (1 + erf((projection + options.terminator.offset * radius) / (Math.SQRT2 * 1.5)))
		}

		let result = background + inside * value

		if (options.ring !== undefined) {
			const ra = a
			const rb = (-dx * sin + dy * cos) / options.ring.axisRatio
			const rr = Math.hypot(ra, rb)
			if (rr >= options.ring.inner && rr <= options.ring.outer && !(r < radius && rb < 0)) result += options.ring.brightness
		}

		return result
	}
}

// Sum of scenes.
export function addScenes(...scenes: readonly Scene[]): Scene {
	return (x, y) => {
		let sum = 0
		for (const scene of scenes) sum += scene(x, y)
		return sum
	}
}

// Isolated Gaussian bumps at explicit positions (spots, prominences, moons).
export function spotsScene(spots: readonly (readonly [number, number, number, number])[]): Scene {
	return (x, y) => {
		let sum = 0

		for (const [sx, sy, sigma, amplitude] of spots) {
			const d2 = (x - sx) ** 2 + (y - sy) ** 2
			if (d2 < 16 * sigma * sigma) sum += amplitude * Math.exp(-d2 / (2 * sigma * sigma))
		}

		return sum
	}
}

// Applies motion to a reference point.
export function moveScenePoint(motion: SceneMotion, x: number, y: number): [number, number] {
	const rotation = motion.rotation ?? 0
	const cx = motion.centerX ?? 0
	const cy = motion.centerY ?? 0
	const cos = Math.cos(rotation)
	const sin = Math.sin(rotation)
	const px = x - cx
	const py = y - cy
	return [cos * px - sin * py + cx + motion.dx, sin * px + cos * py + cy + motion.dy]
}

// Renders a scene into a normalized guide Image. Channel gains and CFA colors multiply the scene.
export function renderScene(width: number, height: number, scene: Scene, options: RenderOptions = {}): Image {
	const channels = options.rgb !== undefined ? 3 : 1
	const raw = options.precision === 64 ? new Float64Array(width * height * channels) : new Float32Array(width * height * channels)
	const motion = options.motion
	const rotation = motion?.rotation ?? 0
	const cos = Math.cos(rotation)
	const sin = Math.sin(rotation)
	const cx = motion?.centerX ?? 0
	const cy = motion?.centerY ?? 0
	const gain = options.gain ?? 1
	const offset = options.offset ?? 0
	const random = mulberry32(options.seed ?? 1)
	const noise = options.noise ?? 0
	const pattern = options.cfa?.pattern

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sx = x
			let sy = y

			if (options.warp !== undefined) {
				const [wx, wy] = options.warp(x, y)
				sx -= wx
				sy -= wy
			}

			if (motion !== undefined) {
				const qx = sx - cx - motion.dx
				const qy = sy - cy - motion.dy
				sx = cos * qx + sin * qy + cx
				sy = -sin * qx + cos * qy + cy
			}

			const base = scene(sx, sy) * gain + offset + (options.gradient === undefined ? 0 : options.gradient[0] * x + options.gradient[1] * y)
			const invalid = options.invalid?.(x, y) === true

			for (let c = 0; c < channels; c++) {
				let value = base

				if (options.rgb !== undefined) value *= options.rgb[c]
				else if (pattern !== undefined && options.cfa !== undefined) {
					const color = pattern[(y & 1) * 2 + (x & 1)]
					value *= options.cfa.gains[color === 'R' ? 0 : color === 'G' ? 1 : 2]
				}

				if (noise > 0) {
					const u1 = Math.max(1e-12, random())
					const u2 = random()
					value += noise * Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2)
				}

				if (options.clip !== undefined) value = Math.min(options.clip, value)
				raw[(y * width + x) * channels + c] = invalid ? Number.NaN : value
			}
		}
	}

	const pixelSizeInBytes = options.precision === 64 ? 8 : 4

	return {
		header: {},
		raw,
		metadata: { width, height, channels, pixelCount: width * height, pixelSizeInBytes, stride: width * channels, strideInBytes: width * channels * pixelSizeInBytes, bitpix: options.precision === 64 ? -64 : -32, bayer: pattern },
	}
}

// Low-amplitude sinusoidal seeing deformation field.
export function seeingWarp(amplitude: number, wavelength: number, phase: number = 0): (x: number, y: number) => readonly [number, number] {
	const k = TAU / wavelength
	return (x, y) => [amplitude * Math.sin(k * y + phase), amplitude * Math.cos(k * x + 0.7 * phase)]
}
