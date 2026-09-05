import { expect, test } from 'bun:test'
import { analyzeCollimation } from '../../../../src/imaging/analysis/collimation/collimation'
import { createCollimationWorkspace } from '../../../../src/imaging/analysis/collimation/preprocess'
import type { CollimationAnalysis, CollimationAnalysisOptions, CollimationAnalysisSuccess } from '../../../../src/imaging/analysis/collimation/types'
import { generateSyntheticCollimationImage, renderSyntheticCollimationPattern, type SyntheticCollimationPattern } from '../../../../src/imaging/synthetic/collimation'
import { collimationFixture } from '../../../collimation.util'

function analyze(fixture: SyntheticCollimationPattern, options?: CollimationAnalysisOptions) {
	const image = generateSyntheticCollimationImage(fixture)
	return analyzeCollimation({ image, area: { left: 0, top: 0, right: image.metadata.width, bottom: image.metadata.height }, center: fixture.obstruction.center }, options)
}

function success(result: CollimationAnalysis): CollimationAnalysisSuccess {
	if (!result.success) throw new Error(result.reason)
	expect(JSON.stringify(result)).not.toContain('null')
	return result
}

for (let direction = 0; direction < 8; direction++)
	test(`measures the outer-to-shadow vector in direction ${direction}`, () => {
		const base = collimationFixture()
		const theta = (direction * Math.PI) / 4
		const offset = { x: 3 * Math.cos(theta), y: 3 * Math.sin(theta) }
		const fixture = { ...base, obstruction: { ...base.obstruction, center: { x: base.outer.center.x + offset.x, y: base.outer.center.y + offset.y } } }
		const result = success(analyze(fixture, { tolerance: 0.03 }))
		expect(Math.hypot(result.geometry.offset.x - offset.x, result.geometry.offset.y - offset.y)).toBeLessThan(0.2)
		expect(result.stability).toBeDefined()
		expect(result.assessment).toBe('outsideTolerance')
		expect(Math.abs(Math.atan2(Math.sin(result.geometry.direction! - theta), Math.cos(result.geometry.direction! - theta)))).toBeLessThan(Math.asin(0.2 / 3))
	})

for (const radius of [24, 48, 96])
	for (const phase of [0, 0.2, 0.5, 0.8])
		for (const sigma of [0.5, 1, 1.5])
			test(`center precision at radius ${radius}, phase ${phase}, smoothing ${sigma}`, () => {
				const size = radius <= 48 ? 160 : 288
				const center = { x: size / 2 + phase, y: size / 2 + phase * 0.7 }
				const innerRadius = radius * 0.4
				const base = collimationFixture()
				const fixture = {
					...base,
					width: size,
					height: size,
					signal: 0.6 * Math.PI * (radius ** 2 - innerRadius ** 2),
					outer: { ...base.outer, center, semiMajor: radius, semiMinor: radius },
					obstruction: { ...base.obstruction, center: { x: center.x + 1.7, y: center.y - 1.1 }, semiMajor: innerRadius, semiMinor: innerRadius },
				}
				const result = success(analyze(fixture, { smoothingSigma: sigma }))
				expect(Math.hypot(result.outer.ellipse.center.x - center.x, result.outer.ellipse.center.y - center.y)).toBeLessThan(0.1)
				expect(Math.hypot(result.obstruction.ellipse.center.x - fixture.obstruction.center.x, result.obstruction.ellipse.center.y - fixture.obstruction.center.y)).toBeLessThan(0.1)
				expect(Math.hypot(result.geometry.offset.x - 1.7, result.geometry.offset.y + 1.1)).toBeLessThan(0.2)
			})

test('keeps exact zero offset measurable with unresolved direction and optional assessments', () => {
	const base = collimationFixture()
	const fixture = { ...base, outer: { ...base.outer, center: { x: 80, y: 80 } }, obstruction: { ...base.obstruction, center: { x: 80, y: 80 } } }
	const result = success(analyze(fixture, { tolerance: 0.02 }))
	expect(result.geometry.distance).toBeLessThan(0.05)
	expect(result.geometry.direction).toBeUndefined()
	expect(result.assessment).toBe('withinTolerance')
	expect(result.diagnostics).toContain('directionUnresolved')
	expect(success(analyze(fixture)).assessment).toBeUndefined()
})

test('fits ellipses with independent orientations and centers', () => {
	const base = collimationFixture()
	const fixture = { ...base, outer: { ...base.outer, semiMajor: 60, semiMinor: 42, theta: 0.8 }, obstruction: { ...base.obstruction, semiMajor: 25, semiMinor: 18, theta: 2.2 } }
	const result = success(analyze(fixture))
	expect(result.outer.ellipse.theta).toBeCloseTo(0.8, 2)
	expect(result.obstruction.ellipse.theta).toBeCloseTo(2.2, 2)
	expect(Math.hypot(result.geometry.offset.x - 2, result.geometry.offset.y - 1)).toBeLessThan(0.2)
})

test('omits stability outside its validated sampling domain', () => {
	const base = collimationFixture()
	const fixture = { ...base, outer: { ...base.outer, semiMajor: 10, semiMinor: 10 }, obstruction: { ...base.obstruction, center: { x: base.outer.center.x + 5, y: base.outer.center.y }, semiMajor: 2, semiMinor: 2, softness: 0.2 } }
	const result = success(analyze(fixture, { smoothingSigma: 0.5, tolerance: 0.2 }))
	expect(result.geometry.offset.x).toBeCloseTo(5, 0)
	expect(result.stability).toBeUndefined()
	expect(result.geometry.direction).toBeUndefined()
	expect(result.assessment).toBe('inconclusive')
})

test('uses explicit field references while retaining off-axis geometry', () => {
	const image = generateSyntheticCollimationImage(collimationFixture())
	const input = { image, area: { left: 0, top: 0, right: 160, bottom: 160 }, field: { center: { x: 0, y: 0 }, maximumDistance: 10 } }
	const result = success(analyzeCollimation(input, { tolerance: 0.1 }))
	expect(result.quality.field).toBe('outsideReference')
	expect(result.assessment).toBe('inconclusive')
	expect(result.geometry.distance).toBeGreaterThan(2)
	input.field = { center: { x: 80, y: 80 }, maximumDistance: 5 }
	expect(success(analyzeCollimation(input, { tolerance: 0.1 })).quality.field).toBe('withinReference')
})

test('measures brightness per unit area independently of thickness and center offset', () => {
	const base = collimationFixture()
	const uniform = success(analyze({ ...base, obstruction: { ...base.obstruction, center: { x: 86.4, y: 80.2 } } }))
	expect(uniform.photometry).toBeDefined()
	expect(uniform.photometry!.relativeVariation).toBeLessThan(0.001)
	const asymmetric = success(analyze({ ...base, obstruction: { ...base.obstruction, center: base.outer.center }, harmonics: [{ order: 2, amplitude: 0.3, phase: 0.4 }] }))
	expect(asymmetric.geometry.distance).toBeLessThan(0.1)
	expect(asymmetric.photometry!.relativeVariation).toBeGreaterThan(0.2)
})

test('preserves input and previous results across ROI changes, failures and workspace reuse', () => {
	const image = generateSyntheticCollimationImage(collimationFixture())
	const workspace = createCollimationWorkspace(180, 180, { angularSamples: 720 })
	const input = { image, area: { left: 0, top: 0, right: 160, bottom: 160 } }
	const first = success(analyzeCollimation(input, { workspace }))
	const serialized = JSON.stringify(first)
	const raw = image.raw.slice()
	const shifted = success(analyzeCollimation({ image, area: { left: 7, top: 5, right: 153, bottom: 152 }, center: { x: 83, y: 83 } }, { workspace, angularSamples: 720 }))
	expect(Math.hypot(shifted.geometry.offset.x - first.geometry.offset.x, shifted.geometry.offset.y - first.geometry.offset.y)).toBeLessThan(0.1)
	expect(analyzeCollimation({ image, area: { left: 50, top: 50, right: 120, bottom: 120 } }, { workspace }).success).toBeFalse()
	expect(JSON.stringify(first)).toBe(serialized)
	expect(image.raw).toEqual(raw)
})

test('retains faint Float64 contrast above a large sloped pedestal', () => {
	const base = collimationFixture({ background: 0, signal: 1e-10 * Math.PI * (48 ** 2 - 20 ** 2) })
	const template = generateSyntheticCollimationImage(base)
	const raw = new Float64Array(template.raw.length)
	renderSyntheticCollimationPattern(raw, base)
	for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) raw[y * 160 + x] += 0.5 + x * 1e-7 - y * 2e-7
	const result = success(analyzeCollimation({ image: { ...template, raw }, area: { left: 0, top: 0, right: 160, bottom: 160 } }))
	expect(Math.hypot(result.geometry.offset.x - 2, result.geometry.offset.y - 1)).toBeLessThan(0.2)
	expect(result.quality.signal).toBeLessThan(2e-10)
})

test('accepts localized saturation away from edges and rejects erased boundaries', () => {
	const fixture = collimationFixture()
	const image = generateSyntheticCollimationImage(fixture)
	const area = { left: 0, top: 0, right: 160, bottom: 160 }
	for (let y = 77; y < 81; y++) for (let x = 112; x < 116; x++) image.raw[y * 160 + x] = 2
	const local = success(analyzeCollimation({ image, area }, { saturationLevel: 1 }))
	expect(local.quality.saturatedFraction).toBeGreaterThan(0)
	const clipped = analyze({ ...fixture, saturation: 0.2 }, { saturationLevel: 0.2 })
	expect(clipped.success).toBeFalse()
})

test('reports missing signal, low SNR, crop and ambiguous multiple rings as failures', () => {
	const base = collimationFixture()
	expect(analyze({ ...base, signal: 0 })).toMatchObject({ success: false, reason: 'patternNotFound' })
	expect(analyze({ ...base, signal: 5, noise: 0.1 })).toMatchObject({ success: false, reason: 'lowSignal' })
	const image = generateSyntheticCollimationImage(base)
	expect(analyzeCollimation({ image, area: { left: 40, top: 0, right: 160, bottom: 160 } }).success).toBeFalse()
	renderSyntheticCollimationPattern(image.raw, { ...base, outer: { ...base.outer, semiMajor: 12, semiMinor: 12 }, obstruction: { ...base.obstruction, center: base.outer.center, semiMajor: 5, semiMinor: 5 }, signal: 0.6 * Math.PI * (12 ** 2 - 5 ** 2) })
	expect(analyzeCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 } })).toMatchObject({ success: false, reason: 'ambiguousPattern' })
})

test('rejects another bright pattern inside the ROI without switching the supplied target', () => {
	const fixture = collimationFixture({ width: 260 })
	const image = generateSyntheticCollimationImage(fixture)
	renderSyntheticCollimationPattern(image.raw, { ...fixture, outer: { ...fixture.outer, center: { x: 208, y: 80 }, semiMajor: 20, semiMinor: 20 }, obstruction: { ...fixture.obstruction, center: { x: 208, y: 80 }, semiMajor: 8, semiMinor: 8 }, signal: 0.6 * Math.PI * (20 ** 2 - 8 ** 2) })
	expect(analyzeCollimation({ image, area: { left: 0, top: 0, right: 260, bottom: 160 }, center: fixture.obstruction.center })).toMatchObject({ success: false, reason: 'ambiguousPattern' })
})

test('respects a missing angular block even when point count is high', () => {
	const fixture = collimationFixture()
	const image = generateSyntheticCollimationImage(fixture)
	for (let y = 0; y < 160; y++)
		for (let x = 0; x < 160; x++) {
			const dx = x - fixture.obstruction.center.x
			const dy = y - fixture.obstruction.center.y
			if (Math.abs(Math.atan2(dy, dx)) < 0.17 * Math.PI && Math.hypot(dx, dy) < 58) image.raw[y * 160 + x] = Number.NaN
		}
	const input = { image, area: { left: 0, top: 0, right: 160, bottom: 160 }, center: fixture.obstruction.center }
	expect(analyzeCollimation(input, { minimumCoverage: 0.7 })).toMatchObject({ success: false, reason: 'insufficientCoverage' })
	// The finite smoothing/contrast support widens this missing wedge to about 97 degrees.
	const accepted = success(analyzeCollimation(input, { minimumCoverage: 0.7, maximumGap: 2 }))
	expect(accepted.outer.coverage).toBeLessThan(0.85)
	expect(accepted.outer.maximumGap).toBeGreaterThan(Math.PI / 3)
})

test('keeps blur, spider and measurable noise separate from an apparent center offset', () => {
	const result = success(analyze(collimationFixture({ seeing: 0.8, noise: 0.005, spider: { vanes: 4, width: 1, angle: 0.3, attenuation: 1 } })))
	expect(Math.hypot(result.geometry.offset.x - 2, result.geometry.offset.y - 1)).toBeLessThan(0.3)
	expect(result.quality.backgroundNoise).toBeGreaterThan(0.003)
	expect(result.quality.signalToNoise).toBeGreaterThan(60)
})

test('retains geometry when a thin annulus has insufficient interior photometric support', () => {
	const base = collimationFixture()
	const result = success(analyze({ ...base, outer: { ...base.outer, semiMajor: 32, semiMinor: 32 } }))
	expect(result.photometry).toBeUndefined()
	expect(result.diagnostics).toContain('photometryUnavailable')
	expect(result.geometry.distance).toBeGreaterThan(2)
})

test('allows a small Poisson spot and rejects a dominant unresolved core', () => {
	const fixture = collimationFixture()
	const image = generateSyntheticCollimationImage(fixture)
	for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) image.raw[y * 160 + x] += 0.4 * Math.exp(-((x - 81.4) ** 2 + (y - 81.2) ** 2) / 0.8)
	const input = { image, area: { left: 0, top: 0, right: 160, bottom: 160 }, center: fixture.obstruction.center }
	expect(analyzeCollimation(input).success).toBeTrue()
	for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) image.raw[y * 160 + x] += 10 * Math.exp(-((x - 81.4) ** 2 + (y - 81.2) ** 2) / 12)
	expect(analyzeCollimation(input).success).toBeFalse()
})

test('rejects an initial point on the bright annulus instead of finding another center', () => {
	const image = generateSyntheticCollimationImage(collimationFixture())
	expect(analyzeCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 }, center: { x: 112, y: 80 } })).toMatchObject({ success: false, reason: 'ambiguousPattern' })
})

test('keeps tolerance overlap inconclusive and does not shrink the floor with more angles', () => {
	const fixture = collimationFixture()
	const first = success(analyze(fixture, { angularSamples: 180, tolerance: Math.sqrt(5) / 48 }))
	const second = success(analyze(fixture, { angularSamples: 720, tolerance: Math.sqrt(5) / 48 }))
	expect(first.assessment).toBe('inconclusive')
	expect(second.assessment).toBe('inconclusive')
	expect(first.stability!.resolutionFloor).toBe(second.stability!.resolutionFloor)
})
