import { expect, test } from 'bun:test'
import { collimationCoverage, collimationRayRadius, extractCollimationEdges, initializeCollimationRadii, sampleCollimationPlane } from '../../../../src/imaging/analysis/collimation/edge'
import { prepareCollimation } from '../../../../src/imaging/analysis/collimation/preprocess'
import { generateSyntheticCollimationImage } from '../../../../src/imaging/synthetic/collimation'
import { fitEllipse } from '../../../../src/math/numerical/ellipse.fit'
import { collimationFixture } from '../../../collimation.util'

test('extracts subpixel gradient pairs and fits independent boundaries', () => {
	const fixture = collimationFixture()
	const image = generateSyntheticCollimationImage(fixture)
	const prepared = prepareCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 } })
	if (!prepared.success) throw new Error(prepared.reason)
	const initialization = initializeCollimationRadii(prepared)
	expect(initialization.reason).toBeUndefined()
	const edges = extractCollimationEdges(prepared, prepared.center, initialization.signal)
	expect(edges.pairedCount).toBeGreaterThan(350)
	const w = prepared.workspace
	const inner = fitEllipse(w.innerX, w.innerY, w.innerWeight)
	const outer = fitEllipse(w.outerX, w.outerY, w.outerWeight)
	expect(inner).toBeDefined()
	expect(outer).toBeDefined()
	if (!inner || !outer) return
	expect(Math.hypot(inner.ellipse.center.x - fixture.obstruction.center.x, inner.ellipse.center.y - fixture.obstruction.center.y)).toBeLessThan(0.1)
	expect(Math.hypot(outer.ellipse.center.x - fixture.outer.center.x, outer.ellipse.center.y - fixture.outer.center.y)).toBeLessThan(0.1)
})

test('coverage respects circular gaps and density', () => {
	for (const n of [120, 360, 720]) {
		const weights = new Float64Array(n).fill(1)
		for (let i = 0; i < n / 10; i++) {
			weights[i] = 0
			weights[n - 1 - i] = 0
		}
		expect(collimationCoverage(weights, n).coverage).toBeCloseTo(0.8, 14)
		expect(collimationCoverage(weights, n).maximumGap).toBeCloseTo(0.4 * Math.PI, 14)
		weights.fill(0)
		expect(collimationCoverage(weights, n).maximumGap).toBeCloseTo(2 * Math.PI, 14)
	}
})

test('bilinear interpolation cannot renormalize an invalid contributing neighbor', () => {
	const image = generateSyntheticCollimationImage(collimationFixture())
	image.raw[50 * 160 + 50] = Number.NaN
	const prepared = prepareCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 } }, { smoothingSigma: 0 })
	if (!prepared.success) throw new Error(prepared.reason)
	expect(Number.isNaN(sampleCollimationPlane(prepared, 49.9, 50))).toBeTrue()
	expect(Number.isFinite(sampleCollimationPlane(prepared, 49, 50))).toBeTrue()
})

test('a shadow origin measures containment when the outer center is outside the shadow', () => {
	const outer = { center: { x: 0, y: 0 }, semiMajor: 10, semiMinor: 10, theta: 0 }
	const inner = { center: { x: 5, y: 0 }, semiMajor: 2, semiMinor: 2, theta: 0 }
	expect(collimationRayRadius(outer, inner.center, 1, 0)).toBeCloseTo(5, 14)
	expect(collimationRayRadius(outer, inner.center, -1, 0)).toBeCloseTo(15, 14)
	expect(collimationRayRadius(inner, outer.center, 1, 0)).toBeUndefined()
})
