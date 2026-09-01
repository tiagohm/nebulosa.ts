import { expect, test } from 'bun:test'
import { resolveAnalysisArea, resolveImageAnalysisPlanes, resolveImagePlaneGeometry, resolveOptionalImagePlaneGeometry, validateDigitalImageLayout } from '../../../src/imaging/analysis/plane'
import type { CfaPattern, DigitalImage } from '../../../src/imaging/model/types'
import { generateSyntheticFlatImage } from '../../../src/imaging/synthetic/flat'

const CFA_PATTERNS: readonly CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']

test('validates dense digital layout while accepting excess caller capacity', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 0, signal: 1, vignetting: 0 })
	validateDigitalImageLayout({ ...image, raw: new Float64Array(8) })

	expect(() => validateDigitalImageLayout({ ...image, sampleScale: 'normalized' } as unknown as DigitalImage)).toThrow(TypeError)
	expect(() => validateDigitalImageLayout({ ...image, metadata: { ...image.metadata, pixelCount: 3 } })).toThrow('pixel count')
	expect(() => validateDigitalImageLayout({ ...image, metadata: { ...image.metadata, stride: 3 } })).toThrow('stride')
	expect(() => validateDigitalImageLayout({ ...image, raw: new Float64Array(3) })).toThrow('raw buffer')
	expect(() => validateDigitalImageLayout({ ...image, digitalRange: [10, 0] })).toThrow('storage range')
})

test('uses inclusive-exclusive areas and rejects empty or external regions', () => {
	expect(resolveAnalysisArea(undefined, 5, 4)).toEqual({ left: 0, top: 0, right: 5, bottom: 4 })
	expect(resolveAnalysisArea({ left: 1, top: 2, right: 5, bottom: 4 }, 5, 4)).toEqual({ left: 1, top: 2, right: 5, bottom: 4 })
	expect(() => resolveAnalysisArea({ left: 1, top: 1, right: 1, bottom: 2 }, 5, 4)).toThrow(RangeError)
	expect(() => resolveAnalysisArea({ left: 0, top: 0, right: 6, bottom: 4 }, 5, 4)).toThrow(RangeError)
})

test('maps mono and interleaved RGB planes to raw-buffer increments', () => {
	const mono = generateSyntheticFlatImage({ width: 3, height: 2, bias: 0, signal: 1, vignetting: 0 })
	expect(resolveImageAnalysisPlanes(mono)).toEqual(['mono'])
	expect(resolveImagePlaneGeometry(mono, { left: 1, top: 0, right: 3, bottom: 2 }, 'mono')).toMatchObject({ sourceLeft: 1, sourceTop: 0, step: 1, width: 2, height: 2, rawStart: 1, rawColumnStep: 1, rawRowStep: 3 })

	const rgb = generateSyntheticFlatImage({ width: 3, height: 2, channels: 3, bias: 0, signal: 1, vignetting: 0 })
	expect(resolveImageAnalysisPlanes(rgb)).toEqual(['red', 'green', 'blue'])
	expect(resolveImagePlaneGeometry(rgb, { left: 1, top: 1, right: 3, bottom: 2 }, 'green')).toMatchObject({ sourceLeft: 1, sourceTop: 1, step: 1, width: 2, height: 1, rawStart: 13, rawColumnStep: 3, rawRowStep: 9 })
	expect(() => resolveImagePlaneGeometry(rgb, { left: 0, top: 0, right: 3, bottom: 2 }, 'green1')).toThrow('RGB analysis')
})

test('selects both green slots and every supported local CFA pattern', () => {
	for (const bayer of CFA_PATTERNS) {
		const image = generateSyntheticFlatImage({ width: 2, height: 2, bayer, bias: 0, signal: 1, vignetting: 0 })
		expect(resolveImageAnalysisPlanes(image)).toEqual(['red', 'green1', 'green2', 'blue'])
		for (const plane of ['red', 'green1', 'green2', 'blue'] as const) {
			const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
			const first = bayer.indexOf(channel)
			const slot = plane === 'green2' ? bayer.indexOf(channel, first + 1) : first
			const geometry = resolveImagePlaneGeometry(image, { left: 0, top: 0, right: 2, bottom: 2 }, plane)
			expect([geometry.sourceLeft, geometry.sourceTop, geometry.rawStart]).toEqual([slot & 1, slot >>> 1, slot])
		}
	}
})

test('distinguishes an already local CFA pattern from one explicitly shifted once', () => {
	const local = generateSyntheticFlatImage({
		width: 2,
		height: 2,
		bayer: 'RGGB',
		bias: 0,
		signal: 100,
		vignetting: 0,
		channelResponse: [1, 0.5, 0.25],
		sensor: { width: 4, height: 4, origin: { x: 1, y: 1 } },
	})
	const area = { left: 0, top: 0, right: 2, bottom: 2 }
	expect(local.metadata.bayer).toBe('BGGR')
	expect(resolveImagePlaneGeometry(local, area, 'red')).toMatchObject({ sourceLeft: 1, sourceTop: 1, rawStart: 3, cfaPattern: 'BGGR' })

	const basePattern = { ...local, metadata: { ...local.metadata, bayer: 'RGGB' as const } }
	expect(resolveImagePlaneGeometry(basePattern, area, 'red', [1, 1])).toMatchObject({ sourceLeft: 1, sourceTop: 1, rawStart: 3, cfaPattern: 'BGGR' })
	expect(resolveImagePlaneGeometry(basePattern, area, 'red')).toMatchObject({ sourceLeft: 0, sourceTop: 0, rawStart: 0, cfaPattern: 'RGGB' })
})

test('reports an unsupported CFA tile without weakening the strict geometry resolver', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bayer: 'RGGB', bias: 0, signal: 1, vignetting: 0 })
	const oneRedPixel = { left: 0, top: 0, right: 1, bottom: 1 }
	expect(resolveOptionalImagePlaneGeometry(image, oneRedPixel, 'blue')).toBeUndefined()
	expect(() => resolveImagePlaneGeometry(image, oneRedPixel, 'blue')).toThrow('no samples')
})
