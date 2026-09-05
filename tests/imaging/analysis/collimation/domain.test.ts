import { afterAll, expect, test } from 'bun:test'
import { analyzeCollimation } from '../../../../src/imaging/analysis/collimation/collimation'
import { createCollimationWorkspace } from '../../../../src/imaging/analysis/collimation/preprocess'
import { fitEllipse } from '../../../../src/math/numerical/ellipse.fit'
import { integratedAnnulus } from './util'

let maximumCenterError = 0
let maximumVectorError = 0

for (const radius of [24, 60, 100]) {
	for (const phase of [0, 0.25, 0.5, 0.75]) {
		for (const ratio of [1, 1.5]) {
			test(`independent pixel integration: R=${radius}, phase=${phase}, aspect=${ratio}`, () => {
				const size = radius < 100 ? 192 : 288
				const outer = { center: { x: size / 2 + phase, y: size / 2 + 0.7 * phase }, semiMajor: radius, semiMinor: radius / ratio, theta: 0.63 }
				const inner = { center: { x: outer.center.x + 1.3, y: outer.center.y - 0.9 }, semiMajor: Math.max(9, radius * 0.4), semiMinor: Math.max(8, (radius * 0.4) / 1.3), theta: 2.1 }
				const image = integratedAnnulus({ width: size, height: size, outer, inner })
				const result = analyzeCollimation({ image, area: { left: 0, top: 0, right: size, bottom: size }, center: inner.center })
				if (!result.success) throw new Error(result.reason)
				const centerError = Math.max(Math.hypot(result.outer.ellipse.center.x - outer.center.x, result.outer.ellipse.center.y - outer.center.y), Math.hypot(result.obstruction.ellipse.center.x - inner.center.x, result.obstruction.ellipse.center.y - inner.center.y))
				const vectorError = Math.hypot(result.geometry.offset.x - 1.3, result.geometry.offset.y + 0.9)
				maximumCenterError = Math.max(maximumCenterError, centerError)
				maximumVectorError = Math.max(maximumVectorError, vectorError)
				expect(centerError).toBeLessThan(0.1)
				expect(vectorError).toBeLessThan(0.2)
			})
		}
	}
}

for (const precision of [32, 64] as const) {
	for (const phase of [0, 0.25, 0.5, 0.75]) {
		test(`independent CFA integration preserves step and precision ${precision} at phase ${phase}`, () => {
			const outer = { center: { x: 128 + phase, y: 128 + 0.6 * phase }, semiMajor: 80, semiMinor: 70, theta: 0.4 }
			const inner = { center: { x: outer.center.x + 4.1, y: outer.center.y - 2.9 }, semiMajor: 30, semiMinor: 25, theta: 1.8 }
			const image = integratedAnnulus({ width: 256, height: 256, outer, inner, precision, bayer: 'GRBG' })
			for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (x % 2 !== 0 || y % 2 !== 0) image.raw[y * 256 + x] = Number.NaN
			const result = analyzeCollimation({ image, area: { left: 1, top: 1, right: 255, bottom: 255 } })
			if (!result.success) throw new Error(result.reason)
			expect(Math.hypot(result.geometry.offset.x - 4.1, result.geometry.offset.y + 2.9)).toBeLessThan(0.4)
			expect(result.stability?.resolutionFloor).toBe(0.4)
		})
	}
}

test('paired deletion preserves cancellation of correlated center perturbations', () => {
	const outer = { center: { x: 96, y: 96 }, semiMajor: 60, semiMinor: 60, theta: 0 }
	const inner = { center: outer.center, semiMajor: 28, semiMinor: 28, theta: 0 }
	const image = integratedAnnulus({ width: 192, height: 192, outer, inner, deformation: 0.35 })
	const workspace = createCollimationWorkspace(192, 192, { precision: 64 })
	const result = analyzeCollimation({ image, area: { left: 0, top: 0, right: 192, bottom: 192 } }, { workspace })
	if (!result.success) throw new Error(result.reason)
	expect(result.stability).toBeDefined()
	const weights = workspace.outerWeight.slice()
	weights.fill(0, 0, 30)
	const deleted = fitEllipse(workspace.outerX, workspace.outerY, weights)!
	const centerChange = Math.hypot(deleted.ellipse.center.x - result.outer.ellipse.center.x, deleted.ellipse.center.y - result.outer.ellipse.center.y)
	// Summing separate center spreads would lose the common perturbation's cancellation.
	expect(centerChange).toBeGreaterThan(0.04)
	expect(result.stability!.offsetSpread).toBeLessThan(centerChange * 0.6)
	expect(result.geometry.direction).toBeUndefined()
})

afterAll(() => {
	console.info('Independent collimation raster maxima (plane pixels):', { maximumCenterError, maximumVectorError })
})
