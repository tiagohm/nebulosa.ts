import { PI } from '../../../../src/core/constants'
import type { CfaPattern, Image } from '../../../../src/imaging/model/types'
import type { SyntheticCollimationPattern } from '../../../../src/imaging/synthetic/collimation'
import type { EllipseGeometry } from '../../../../src/math/numerical/ellipse.geometry'

export interface IntegratedAnnulus {
	readonly width: number
	readonly height: number
	readonly outer: EllipseGeometry
	readonly inner: EllipseGeometry
	readonly precision?: 32 | 64
	readonly bayer?: CfaPattern
	readonly subdivisions?: number
	readonly deformation?: number
}

// Independent box integration of a binary pupil on 8x8 subpixels, using analytic quadratic
// membership rather than the production synthetic renderer's logistic radial edge occupancy.
// Optional cos(3*angle) displacement applies the same radial perturbation to both boundaries.
export function integratedAnnulus(options: IntegratedAnnulus): Image {
	const { width, height, outer, inner } = options
	const precision = options.precision ?? 64
	const raw = precision === 64 ? new Float64Array(width * height) : new Float32Array(width * height)
	const n = options.subdivisions ?? 8
	const oc = Math.cos(outer.theta)
	const os = Math.sin(outer.theta)
	const ic = Math.cos(inner.theta)
	const is = Math.sin(inner.theta)
	const left = Math.max(0, Math.floor(outer.center.x - outer.semiMajor - 2))
	const right = Math.min(width, Math.ceil(outer.center.x + outer.semiMajor + 2))
	const top = Math.max(0, Math.floor(outer.center.y - outer.semiMajor - 2))
	const bottom = Math.min(height, Math.ceil(outer.center.y + outer.semiMajor + 2))

	raw.fill(0.1)

	for (let y = top; y < bottom; y++)
		for (let x = left; x < right; x++) {
			let illuminated = 0

			for (let sy = 0; sy < n; sy++) {
				for (let sx = 0; sx < n; sx++) {
					let px = x - 0.5 + (sx + 0.5) / n
					let py = y - 0.5 + (sy + 0.5) / n

					if (options.deformation) {
						const dx = px - outer.center.x
						const dy = py - outer.center.y
						const angle = Math.atan2(dy, dx)
						const displacement = options.deformation * Math.cos(3 * angle)
						px -= displacement * Math.cos(angle)
						py -= displacement * Math.sin(angle)
					}

					const ox = px - outer.center.x
					const oy = py - outer.center.y
					const ix = px - inner.center.x
					const iy = py - inner.center.y
					const inOuter = ((ox * oc + oy * os) / outer.semiMajor) ** 2 + ((oy * oc - ox * os) / outer.semiMinor) ** 2 <= 1
					const inInner = ((ix * ic + iy * is) / inner.semiMajor) ** 2 + ((iy * ic - ix * is) / inner.semiMinor) ** 2 <= 1
					if (inOuter && !inInner) illuminated++
				}
			}

			raw[y * width + x] += (0.6 * illuminated) / (n * n)
		}

	return { header: {}, metadata: { width, height, stride: width, pixelCount: width * height, channels: 1, strideInBytes: (width * precision) / 8, pixelSizeInBytes: precision / 8, bitpix: precision === 64 ? -64 : -32, bayer: options.bayer }, raw }
}

export function collimationFixture(overrides: Partial<SyntheticCollimationPattern> = {}): SyntheticCollimationPattern {
	return {
		width: 160,
		height: 160,
		outer: { center: { x: 79.4, y: 80.2 }, semiMajor: 48, semiMinor: 48, theta: 0, softness: 0.75 },
		obstruction: { center: { x: 81.4, y: 81.2 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.75 },
		signal: 0.6 * PI * (48 ** 2 - 20 ** 2),
		background: 0.05,
		noise: 0,
		seed: 7121,
		...overrides,
	}
}
