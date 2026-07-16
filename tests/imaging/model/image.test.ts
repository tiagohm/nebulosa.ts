import { describe, expect, test } from 'bun:test'
import { Jpeg } from '../../../src/bindings/imaging/libturbojpeg'
import { readImageFromJpeg, readImageFromPath, readImageFromSource, writeImageToFits, writeImageToXisf } from '../../../src/imaging/model/image'
import { approximateArcsinhStretchParameters, arcsinhStretch } from '../../../src/imaging/processing/arcsinh'
import { clone } from '../../../src/imaging/processing/arithmetic'
import { calibrate } from '../../../src/imaging/processing/calibration'
import { adf, estimateBackground, estimateBackgroundUsingMode, histogram, sigmaClip } from '../../../src/imaging/processing/computation'
import { Bitpix } from '../../../src/io/formats/fits/fits'
// oxfmt-ignore
import { blur3x3, blur5x5, blur7x7, blurConvolutionKernel, convolution, convolutionKernel, edges, emboss, gaussianBlur, mean3x3, mean5x5, mean7x7, meanConvolutionKernel, sharpen } from '../../../src/imaging/processing/convolution'
import type { Image } from '../../../src/imaging/model/types'
import { curvesTransformation, type CurvesTransformationCurve } from '../../../src/imaging/processing/curves'
import { bayer, debayer } from '../../../src/imaging/processing/debayer'
import { fft, FFTWorkspace } from '../../../src/imaging/processing/fft'
import { grayscale, horizontalFlip, invert, verticalFlip } from '../../../src/imaging/processing/geometry'
import { multiscaleMedianTransform, type MultiscaleMedianTransformOptions } from '../../../src/imaging/processing/mmt'
import { backgroundNeutralization } from '../../../src/imaging/processing/neutralization'
import { psf } from '../../../src/imaging/processing/psf'
import { scnr } from '../../../src/imaging/processing/scnr'
import { stf } from '../../../src/imaging/processing/stf'
import { brightness, contrast, gamma, saturation } from '../../../src/imaging/processing/tone'
import { bufferSink, bufferSource } from '../../../src/io/io'
import { downloadPerTag } from '../../download'
import { BITPIXES, CHANNELS, readImage, readImageTransformAndSave, saveImageAndCompareHash } from '../util'

await downloadPerTag('image')

function autoStf(image: Image) {
	return stf(image, ...adf(image))
}

test('reads a color JPEG as luminance when no pixel format is given', () => {
	// Build a small color JPEG with distinct per-channel content.
	const width = 8
	const height = 8
	const rgb = new Uint8Array(width * height * 3)
	for (let i = 0, p = 0; i < width * height; i++) {
		rgb[p++] = (i * 7) & 0xff
		rgb[p++] = (i * 13) & 0xff
		rgb[p++] = (i * 29) & 0xff
	}

	const jpeg = new Jpeg().compress(rgb, width, height, 'RGB', 100, '4:4:4')!

	const noFormat = readImageFromJpeg(jpeg)!
	const gray = readImageFromJpeg(jpeg, undefined, 'GRAY')!

	// The default path must produce the same single-channel luminance image as an explicit GRAY decode.
	expect(noFormat.metadata.channels).toBe(1)
	expect(noFormat.raw.length).toBe(width * height)
	for (let i = 0; i < gray.raw.length; i++) {
		expect(noFormat.raw[i]).toBeCloseTo(gray.raw[i], 6)
	}
})

test('reads a JPEG into an explicit 64-bit raw buffer', () => {
	const width = 4
	const height = 4
	const gray = new Uint8Array(width * height)
	for (let i = 0; i < gray.length; i++) gray[i] = i * 16
	const jpeg = new Jpeg().compress(gray, width, height, 'GRAY', 100, 'GRAY')!

	const image = readImageFromJpeg(jpeg, 64)!

	expect(image.raw).toBeInstanceOf(Float64Array)
	expect(image.raw.length).toBe(width * height)
	expect(image.metadata).toMatchObject({ width, height, channels: 1, pixelCount: width * height, bitpix: 8 })
	for (const value of image.raw) {
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThanOrEqual(1)
	}
})

describe('read image from fits', () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			test(`bitpix=${bitpix}, channel=${channel}`, async () => {
				const [image, fits] = await readImage(bitpix, channel)

				expect(image.header).toBe(fits.hdus[0].header)

				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

				await readImageTransformAndSave((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
			})
		}
	}
})

describe('write image to fits', () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			test(`bitpix=${bitpix}, channel=${channel}`, async () => {
				buffer.fill(20)

				const [a] = await readImage(bitpix, channel)
				await writeImageToFits(a, bufferSink(buffer))
				const b = await readImageFromSource(bufferSource(buffer))

				expect(a.header).toEqual(b!.header)

				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

				await saveImageAndCompareHash(b!, `witf-${bitpix}.${channel}`, hash)
			})
		}
	}
})

describe('write image to xisf', () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			test(`bitpix=${bitpix}, channel=${channel}`, async () => {
				buffer.fill(20)

				const [a] = await readImage(bitpix, channel)
				await writeImageToXisf(a, bufferSink(buffer))
				const b = await readImageFromSource(bufferSource(buffer))

				expect(a.header).toEqual(b!.header)

				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

				await saveImageAndCompareHash(b!, `witf-${bitpix}.${channel}`, hash)
			})
		}
	}
})

test('histogram on red channel', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const h = histogram(image, { channel: 'RED' })

	expect(h.count[0]).toBe(732122)
	expect(h.mean).toBeCloseTo(0.0015438, 4)
	expect(h.median).toBeCloseTo(0.0008765, 7)
	expect(h.variance).toBeCloseTo(0.0001608, 7)
	expect(h.standardDeviation).toBeCloseTo(0.0126788, 7)
})

test('histogram on green channel', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const h = histogram(image, { channel: 'GREEN' })

	expect(h.count[0]).toBe(732122)
	expect(h.mean).toBeCloseTo(0.0016607, 4)
	expect(h.median).toBeCloseTo(0.0006596, 7)
	expect(h.variance).toBeCloseTo(0.0002826, 7)
	expect(h.standardDeviation).toBeCloseTo(0.0168121, 7)
})

test('histogram on blue channel', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const h = histogram(image, { channel: 'BLUE' })

	expect(h.count[0]).toBe(732122)
	expect(h.mean).toBeCloseTo(0.0014478, 4)
	expect(h.median).toBeCloseTo(0.000672, 7)
	expect(h.variance).toBeCloseTo(0.0002182, 7)
	expect(h.standardDeviation).toBeCloseTo(0.0147732, 7)
})

test('histogram with roi', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const h = histogram(image, { channel: 'RED', area: { left: 450, top: 400, right: 705, bottom: 655 }, bits: 20 })

	expect(h.count[0]).toBe(65536)
	expect(h.mean).toBeCloseTo(0.0043881, 4)
	expect(h.median).toBeCloseTo(0.0024723, 6)
	expect(h.variance).toBeCloseTo(0.0007618, 7)
	expect(h.standardDeviation).toBeCloseTo(0.0276011, 6)
	expect(h.minimum[0]).toBeCloseTo(0.0003971, 6)
	expect(h.maximum[0]).toBeCloseTo(1, 5)
})

test('histogram with transform', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const h = histogram(image, { transform: (p, i) => (i % 2 === 0 ? p : p - 0.001), bits: 20 })

	expect(h.count[0]).toBe(732122)
	expect(h.mean).toBeCloseTo(0.00121, 4)
	expect(h.median).toBeCloseTo(0.0002311, 6)
	expect(h.variance).toBeCloseTo(0.0002447, 7)
	expect(h.standardDeviation).toBeCloseTo(0.0156441, 6)
})

test('debayer', async () => {
	const image = await readImageTransformAndSave((i) => stf(debayer(i) ?? i, 0.05), 'debayer-grbg', 'c03d37c612fd1a4c20bfd5036260aeb0', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
}, 5000)

test('debayer RGBG', async () => {
	const image = await readImageTransformAndSave((i) => stf(debayer(i, 'RGBG') ?? i, 0.05), 'debayer-rgbg', '5e17e6927f823695d26df4758ca870ae', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
}, 5000)

test('bayer', () => {
	const color: Image = {
		header: { NAXIS: 3, NAXIS3: 3 },
		metadata: { width: 4, height: 2, channels: 3, stride: 12, pixelCount: 8, strideInBytes: 16, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		raw: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.21, 0.22, 0.23, 0.24]),
	}

	const image = bayer(color, 'RGGB')

	expect(image).toBeDefined()
	expect(image!.header.NAXIS).toBe(2)
	expect(image!.header.NAXIS3).toBeUndefined()
	expect(image!.header.BAYERPAT).toBe('RGGB')
	expect(image!.metadata.channels).toBe(1)
	expect(image!.metadata.stride).toBe(image!.metadata.width)
	expect(image!.metadata.bayer).toBe('RGGB')
	expect(image!.raw).toEqual(new Float32Array([0.1, 0.5, 0.7, 0.11, 0.14, 0.18, 0.2, 0.24]))
})

test('clone produces an independent pixel buffer', () => {
	const image: Image = {
		header: { NAXIS: 2 },
		metadata: { width: 2, height: 2, channels: 1, stride: 2, pixelCount: 4, strideInBytes: 8, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		raw: new Float32Array([0.1, 0.2, 0.3, 0.4]),
	}

	const copy = clone(image)

	expect(copy.raw).not.toBe(image.raw)
	expect(copy.raw).toEqual(image.raw)

	// Mutating the clone must not affect the original.
	copy.raw[0] = 0.9
	expect(image.raw[0]).toBeCloseTo(0.1, 8)
})

test('stf', () => readImageTransformAndSave((i) => stf(i, 0.005), 'stf', '0d4c72c8140e27f9823bd5cdd36f9108'), 5000)

test('auto stf', () => readImageTransformAndSave((i) => stf(i, ...adf(i)), 'stf-auto', 'f317ee55154ecb95770fad5df319855b'), 5000)

test('auto stf with sigma clip', () => readImageTransformAndSave((i) => stf(i, ...adf(i, { sigmaClip: sigmaClip(i) })), 'stf-auto-sigma-clip', '64a59c2a47af748ee17106dec7d65e6f'), 5000)

test('sigma clip excludes rejected pixels from the iteration statistics', () => {
	// Continuous background plus a bright tail: rejection is marginal, so a biased
	// dispersion (e.g. counting rejected pixels at bin 0) changes which pixels survive.
	const w = 300
	const h = 300
	const n = w * h
	const raw = new Float32Array(n)
	let seed = 999
	const u = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
	const gauss = () => {
		let x = 0
		for (let k = 0; k < 12; k++) x += u()
		return x - 6
	}
	for (let i = 0; i < n; i++) {
		let v = 0.45 + gauss() * 0.08
		if (u() < 0.12) v += u() * 0.5
		raw[i] = Math.max(0, Math.min(1, v))
	}

	const image = { raw, metadata: { width: w, height: h, channels: 1, stride: w, pixelCount: n } } as Parameters<typeof sigmaClip>[0]
	const options = { centerMethod: 'mean', dispersionMethod: 'std', sigmaLower: 2, sigmaUpper: 2, maxIterations: 8, tolerance: 0 } as const

	// Brute-force reference: exact mean/std over surviving pixels, iterated to convergence.
	const reference = new Uint8Array(n)
	for (let it = 0; it < options.maxIterations; it++) {
		let sum = 0
		let c = 0
		for (let i = 0; i < n; i++)
			if (!reference[i]) {
				sum += raw[i]
				c++
			}
		const mean = sum / c
		let variance = 0
		for (let i = 0; i < n; i++)
			if (!reference[i]) {
				const d = raw[i] - mean
				variance += d * d
			}
		const std = Math.sqrt(variance / c)
		const lower = mean - options.sigmaLower * std
		const upper = mean + options.sigmaUpper * std
		let count = 0
		for (let i = 0; i < n; i++)
			if (!reference[i] && (raw[i] < lower || raw[i] > upper)) {
				reference[i] = 1
				count++
			}
		if (count === 0) break
	}

	const mask = sigmaClip(image, options)
	let rejected = 0
	for (let i = 0; i < n; i++) {
		expect(!!mask[i]).toBe(!!reference[i])
		if (mask[i]) rejected++
	}
	expect(rejected).toBeGreaterThan(n * 0.1)
})

test('adf honors explicit zero options', () => {
	const image = {
		header: {},
		metadata: { width: 1, height: 1, channels: 1, stride: 1, pixelCount: 1, strideInBytes: 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		raw: new Float32Array([0.25]),
	}
	const median = histogram(image).median

	const [midtone, shadow, highlight] = adf(image, { meanBackground: 0, clippingPoint: 0 })

	expect(midtone).toBeCloseTo(0, 8)
	expect(shadow).toBeCloseTo(median, 8)
	expect(highlight).toBeCloseTo(1, 8)
})

test('scnr', () => readImageTransformAndSave((i) => scnr(i, 'GREEN', 0.9), 'scnr', '6cb9e0f3b826d8ea0e28833f297d90f4'), 5000)

test('horizontal flip', () => readImageTransformAndSave((i) => horizontalFlip(i), 'flip-h', 'afd2dcd1180ef2243d86129f7a71bf77'), 5000)

test('vertical flip', () => readImageTransformAndSave((i) => verticalFlip(i), 'flip-v', '47b503f4fe6e29de54d7bd774a796ed7'), 5000)

test('horizontal & vertical flip', () => readImageTransformAndSave((i) => verticalFlip(horizontalFlip(i)), 'flip-hv', '6021cd21acad2f5e911fd5ee811222b7'), 5000)

test('invert', () => readImageTransformAndSave((i) => invert(i), 'invert', 'c1e30dcea46c080ecef239399ea25a29'), 5000)

test('grayscale', async () => {
	const image = await readImageTransformAndSave((i) => grayscale(i), 'grayscale', '53b6d9929cf3a3eb1e2bccf2bbcea544')

	expect(image.header.NAXIS).toBe(2)
	expect(image.header.NAXIS3).toBeUndefined()
	expect(image.metadata.stride).toBe(image.metadata.width)
	expect(image.metadata.channels).toBe(1)
}, 5000)

test('red grayscale', () => readImageTransformAndSave((i) => grayscale(i, 'RED'), 'grayscale-red', 'abbe5ae6e4e475b1ddee069d0f37da61'), 5000)

test('convolution identity', () => {
	const kernel = convolutionKernel(new Int8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3)
	return readImageTransformAndSave((i) => convolution(i, kernel), 'conv-identity', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
}, 5000)

test('convolution edges', () => readImageTransformAndSave((i) => edges(i), 'conv-edges', '94c01060591a83869c7cd376d97fb612'), 8000)

test('convolution emboss', () => readImageTransformAndSave((i) => emboss(i), 'conv-emboss', 'de8e5d5183b4afe5066bdab7446a155e'), 8000)

test('convolution sharpen', () => readImageTransformAndSave((i) => sharpen(i), 'conv-sharpen', '3b41a1fa654d360a1b02c259028be827'), 8000)

test('convolution mean 3x3', () => readImageTransformAndSave((i) => mean3x3(i), 'conv-mean-3', 'e978e99e47dea77f138953d84221f5ca'), 8000)

test('convolution mean 5x5', () => readImageTransformAndSave((i) => mean5x5(i), 'conv-mean-5', 'b6889d5c03fcc8290e0ef441bc057e8d'), 8000)

test('convolution mean 7x7', () => readImageTransformAndSave((i) => mean7x7(i), 'conv-mean-7', '5b8d80765c1fd2be99d26384f16089bc'), 8000)

test('convolution mean', () => {
	const a = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(3)), 'conv-mean-3', 'e978e99e47dea77f138953d84221f5ca')
	const b = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(5)), 'conv-mean-5', 'b6889d5c03fcc8290e0ef441bc057e8d')
	const c = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(7)), 'conv-mean-7', '5b8d80765c1fd2be99d26384f16089bc')
	return Promise.all([a, b, c])
}, 8000)

test('convolution blur 3x3', () => readImageTransformAndSave((i) => blur3x3(i), 'conv-blur-3', 'd483c31324fcc7249450e310f19d20b4'), 8000)

test('convolution blur 5x5', () => readImageTransformAndSave((i) => blur5x5(i), 'conv-blur-5', '1d26004a32af3a8fcec9a7b3972d8002'), 8000)

test('convolution blur 7x7', () => readImageTransformAndSave((i) => blur7x7(i), 'conv-blur-7', 'db572370d0633b942e8e72398153e131'), 8000)

test('convolution blur', () => {
	const a = readImageTransformAndSave((i) => convolution(i, blurConvolutionKernel(3)), 'conv-blur-3', 'd483c31324fcc7249450e310f19d20b4')
	const b = readImageTransformAndSave((i) => convolution(i, blurConvolutionKernel(5)), 'conv-blur-5', '1d26004a32af3a8fcec9a7b3972d8002')
	const c = readImageTransformAndSave((i) => convolution(i, blurConvolutionKernel(7)), 'conv-blur-7', 'db572370d0633b942e8e72398153e131')
	return Promise.all([a, b, c])
}, 8000)

test('blur convolution kernel divisor', () => {
	expect(blurConvolutionKernel(9).divisor).toBe(625)
	expect(blurConvolutionKernel(11).divisor).toBe(1296)
})

test('convolution gaussian blur', () => readImageTransformAndSave((i) => gaussianBlur(i), 'conv-gaussian-blur', 'fde35723b23615cbef1ece1fbaecb0e2'), 8000)

test('psf', () => readImageTransformAndSave((i) => psf(i), 'psf', '8958ad9f3e3888329faad7fd61e17e73'), 5000)

test('brightness', () => readImageTransformAndSave((i) => brightness(i, 80), 'brightness', 'b509a49b5677b98b64fd560d0e7a6d8f'), 5000)

test('contrast', () => readImageTransformAndSave((i) => contrast(i, 0.8125), 'contrast', '9e918ec0d7a1e96cb854aa1cd0929e79'), 5000)

test('saturation', () => readImageTransformAndSave((i) => saturation(i, 30), 'saturation', 'c2e2a7577b9141a36420b15019cf1449'), 5000)

test('gamma', () => readImageTransformAndSave((i) => gamma(i, 2.2), 'gamma', '086f10359a135f12f8cf0e7e27d52731'), 5000)

describe('fft', () => {
	const workspace = new FFTWorkspace(1037, 706)

	test('low-pass', () => readImageTransformAndSave((i) => autoStf(fft(i, workspace, 'lowPass', 0.015, 0.8)), 'fft-low-pass', 'a73e40cb9a87bb3ebf5cc004cc55c27b'), 5000)

	test('high-pass', () => readImageTransformAndSave((i) => autoStf(fft(i, workspace, 'highPass', 0.5, 0.3)), 'fft-high-pass', '3ec4f47c7e52a4a6b36374bd3dd199c9'), 5000)
})

test('arcsinh stretch', () => readImageTransformAndSave((i) => arcsinhStretch(i, approximateArcsinhStretchParameters(...adf(i))), 'arcsinh', 'f2eaccfae404773ebd06f1200fb67c10'))

test('background neutralization', () => readImageTransformAndSave((i) => autoStf(backgroundNeutralization(i, { upperLimit: 0.1 })), 'background-neutralization', 'e7fb3b8cd06488553d031996c2ec93db'))

test('mmt', () => {
	const options: MultiscaleMedianTransformOptions = {
		layers: 2,
		detailLayers: [{ threshold: 2 }, { threshold: 1 }],
		residualGain: 1,
	}

	return readImageTransformAndSave((i) => autoStf(multiscaleMedianTransform(i, options)), 'mmt', '75f6a6dc50e4890dbc7b8916a87c3974')
}, 5000)

test('curves transformation - mono', () => readImageTransformAndSave((i) => autoStf(curvesTransformation(i, { curves: [{ channel: 'GRAY', x: [0.007], y: [0.08] }] })), 'ct-mono', 'fe537a6ce1dbf5fc7c2396c587aa61e6', undefined, 1))

describe('curves transformation - RGB', () => {
	const scenarios: { name: string; curves: readonly CurvesTransformationCurve[]; hash: string }[] = [
		{
			name: 'gray-shadow-lift',
			curves: [{ channel: 'GRAY', x: [0.004], y: [0.08] }],
			hash: 'cc87850276cff3c3f00fb3b3190801a7',
		},
		{
			name: 'red-boost',
			curves: [{ channel: 'RED', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: '3974aa724436833b4039d0ca9e1eb7c3',
		},
		{
			name: 'green-boost',
			curves: [{ channel: 'GREEN', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: '55123614f28e33666da27a5435ba2882',
		},
		{
			name: 'blue-boost',
			curves: [{ channel: 'BLUE', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: 'd0a8192b878b4b6a1bad658f1aa468a7',
		},
		{
			name: 'warm-balance',
			curves: [
				{ channel: 'RED', x: [0.03, 0.45], y: [0.1, 0.6] },
				{ channel: 'BLUE', x: [0.08, 0.6], y: [0.04, 0.52] },
			],
			hash: 'df54941778d5c98af3576b60fe99d87f',
		},
		{
			name: 'cool-balance',
			curves: [
				{ channel: 'RED', x: [0.08, 0.6], y: [0.04, 0.52] },
				{ channel: 'BLUE', x: [0.03, 0.45], y: [0.1, 0.6] },
			],
			hash: '56ec6c491b4feac3b964817c5d5b5316',
		},
	]

	for (const scenario of scenarios) {
		test(scenario.name, () => readImageTransformAndSave((i) => autoStf(curvesTransformation(i, { curves: scenario.curves })), `ct-rgb-${scenario.name}`, scenario.hash))
	}
})

test('estimate background', async () => {
	const light = await readImageFromPath('data/LIGHT.fit')
	expect(estimateBackground(light!)).toBeCloseTo(0.109, 3)
})

test('estimate background using mode', async () => {
	const light = await readImageFromPath('data/LIGHT.fit')
	expect(estimateBackgroundUsingMode(light!)).toBeCloseTo(0.109, 3)
})

describe('calibrate', async () => {
	const light = await readImageFromPath('data/LIGHT.fit')
	const dark = await readImageFromPath('data/DARK.30.fit')
	const dark15 = await readImageFromPath('data/DARK.15.fit')
	const dark60 = await readImageFromPath('data/DARK.60.fit')
	const flat = await readImageFromPath('data/FLAT.fit')
	const bias = await readImageFromPath('data/BIAS.fit')
	const darkFlat = await readImageFromPath('data/DARKFLAT.fit')

	test('full', async () => {
		const calibrated = calibrate(clone(light!), { dark, flat, bias, darkFlat })
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-full', '5ec5a07ca2bdcf4d7e66bc2d120bf520')
	})

	test('dark 60s', async () => {
		const calibrated = calibrate(clone(light!), { dark: dark60, flat, bias, darkFlat })
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-dark-60', '539f2b3e0c5afb37dc04ce0e0bded4c1')
	}, 5000)

	test('dark 15s', async () => {
		const calibrated = calibrate(clone(light!), { dark: dark15, flat, bias, darkFlat })
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-dark-15', 'b72aa07a6c3269a10b72e363acd8cac0')
	}, 5000)
})
