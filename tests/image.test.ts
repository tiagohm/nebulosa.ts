import { describe, expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import { readImageFromPath, readImageFromSource, writeImageToFits, writeImageToXisf } from '../src/image'
import { adf, estimateBackground, estimateBackgroundUsingMode, histogram, sigmaClip } from '../src/image.computation'
// oxfmt-ignore
import { approximateArcsinhStretchParameters, arcsinhStretch, backgroundNeutralization, bayer, blur3x3, blur5x5, blur7x7, blurConvolutionKernel, brightness, calibrate, clone, contrast, convolution, convolutionKernel, curvesTransformation, debayer, edges, emboss, FFTWorkspace, fft, gamma, gaussianBlur, grayscale, horizontalFlip, invert, mean3x3, mean5x5, mean7x7, meanConvolutionKernel, multiscaleMedianTransform, psf, saturation, scnr, sharpen, stf, verticalFlip } from '../src/image.transformation'
import type { CurvesTransformationCurve, Image, MultiscaleMedianTransformOptions } from '../src/image.types'
import { bufferSink, bufferSource } from '../src/io'
import { downloadPerTag } from './download'
import { BITPIXES, CHANNELS, readImage, readImageTransformAndSave, saveImageAndCompareHash } from './image.util'

await downloadPerTag('image')

function autoStf(image: Image) {
	return stf(image, ...adf(image))
}

test('read image from fits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [image, fits] = await readImage(bitpix, channel)

			expect(image.header).toBe(fits.hdus[0].header)

			const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

			await readImageTransformAndSave((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
		}
	}
}, 15000)

test('write image to fits', async () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			buffer.fill(20)

			const [a] = await readImage(bitpix, channel)
			await writeImageToFits(a, bufferSink(buffer))
			const b = await readImageFromSource(bufferSource(buffer))

			expect(a.header).toEqual(b!.header)

			const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

			await saveImageAndCompareHash(b!, `witf-${bitpix}.${channel}`, hash)
		}
	}
}, 10000)

test('write image to xisf', async () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			buffer.fill(20)

			const [a] = await readImage(bitpix, channel)
			await writeImageToXisf(a, bufferSink(buffer))
			const b = await readImageFromSource(bufferSource(buffer))

			expect(a.header).toEqual(b!.header)

			const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'

			await saveImageAndCompareHash(b!, `witf-${bitpix}.${channel}`, hash)
		}
	}
}, 10000)

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
	const image = await readImageTransformAndSave((i) => stf(debayer(i) ?? i, 0.05), 'debayer-grbg', 'a83991af17528a13a4248add8b406a74', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
}, 5000)

test('debayer RGBG', async () => {
	const image = await readImageTransformAndSave((i) => stf(debayer(i, 'RGBG') ?? i, 0.05), 'debayer-rgbg', '7c4bda2a5155e235912660fda310c594', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
}, 5000)

test('bayer', () => {
	const color: Image = {
		header: { NAXIS: 3, NAXIS3: 3 },
		metadata: { width: 4, height: 2, channels: 3, stride: 12, pixelCount: 8, strideInBytes: 16, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		raw: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.21, 0.22, 0.23, 0.24]),
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

test('stf', () => {
	return readImageTransformAndSave((i) => stf(i, 0.005), 'stf', '82161af2eac053ad688a161d4e1fc6da')
}, 5000)

test('auto stf', () => {
	return readImageTransformAndSave((i) => stf(i, ...adf(i)), 'stf-auto', 'c89314c7f303599568199398d7312372')
}, 5000)

test('auto stf with sigma clip', () => {
	return readImageTransformAndSave((i) => stf(i, ...adf(i, { sigmaClip: sigmaClip(i) })), 'stf-auto-sigma-clip', 'eb8b02dbcd56dd364a4e0411f8e3029b')
}, 5000)

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

test('scnr', () => {
	return readImageTransformAndSave((i) => scnr(i, 'GREEN', 0.9), 'scnr', '6cb9e0f3b826d8ea0e28833f297d90f4')
}, 5000)

test('horizontal flip', () => {
	return readImageTransformAndSave((i) => horizontalFlip(i), 'flip-h', 'afd2dcd1180ef2243d86129f7a71bf77')
}, 5000)

test('vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(i), 'flip-v', '47b503f4fe6e29de54d7bd774a796ed7')
}, 5000)

test('horizontal & vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(horizontalFlip(i)), 'flip-hv', '6021cd21acad2f5e911fd5ee811222b7')
}, 5000)

test('invert', () => {
	return readImageTransformAndSave((i) => invert(i), 'invert', 'c1e30dcea46c080ecef239399ea25a29')
}, 5000)

test('grayscale', async () => {
	const image = await readImageTransformAndSave((i) => grayscale(i), 'grayscale', '53b6d9929cf3a3eb1e2bccf2bbcea544')

	expect(image.header.NAXIS).toBe(2)
	expect(image.header.NAXIS3).toBeUndefined()
	expect(image.metadata.stride).toBe(image.metadata.width)
	expect(image.metadata.channels).toBe(1)
}, 5000)

test('red grayscale', () => {
	return readImageTransformAndSave((i) => grayscale(i, 'RED'), 'grayscale-red', 'abbe5ae6e4e475b1ddee069d0f37da61')
}, 5000)

test('convolution identity', () => {
	const kernel = convolutionKernel(new Int8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3)
	return readImageTransformAndSave((i) => convolution(i, kernel), 'conv-identity', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
}, 5000)

test('convolution edges', () => {
	return readImageTransformAndSave((i) => edges(i), 'conv-edges', '94c01060591a83869c7cd376d97fb612')
}, 8000)

test('convolution emboss', () => {
	return readImageTransformAndSave((i) => emboss(i), 'conv-emboss', 'de8e5d5183b4afe5066bdab7446a155e')
}, 8000)

test('convolution sharpen', () => {
	return readImageTransformAndSave((i) => sharpen(i), 'conv-sharpen', '3b41a1fa654d360a1b02c259028be827')
}, 8000)

test('convolution mean 3x3', () => {
	return readImageTransformAndSave((i) => mean3x3(i), 'conv-mean-3', 'e978e99e47dea77f138953d84221f5ca')
}, 8000)

test('convolution mean 5x5', () => {
	return readImageTransformAndSave((i) => mean5x5(i), 'conv-mean-5', 'b6889d5c03fcc8290e0ef441bc057e8d')
}, 8000)

test('convolution mean 7x7', () => {
	return readImageTransformAndSave((i) => mean7x7(i), 'conv-mean-7', '5b8d80765c1fd2be99d26384f16089bc')
}, 8000)

test('convolution mean', () => {
	const a = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(3)), 'conv-mean-3', 'e978e99e47dea77f138953d84221f5ca')
	const b = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(5)), 'conv-mean-5', 'b6889d5c03fcc8290e0ef441bc057e8d')
	const c = readImageTransformAndSave((i) => convolution(i, meanConvolutionKernel(7)), 'conv-mean-7', '5b8d80765c1fd2be99d26384f16089bc')
	return Promise.all([a, b, c])
}, 8000)

test('convolution blur 3x3', () => {
	return readImageTransformAndSave((i) => blur3x3(i), 'conv-blur-3', 'd483c31324fcc7249450e310f19d20b4')
}, 8000)

test('convolution blur 5x5', () => {
	return readImageTransformAndSave((i) => blur5x5(i), 'conv-blur-5', '1d26004a32af3a8fcec9a7b3972d8002')
}, 8000)

test('convolution blur 7x7', () => {
	return readImageTransformAndSave((i) => blur7x7(i), 'conv-blur-7', 'db572370d0633b942e8e72398153e131')
}, 8000)

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

test('convolution gaussian blur', () => {
	return readImageTransformAndSave((i) => gaussianBlur(i), 'conv-gaussian-blur', 'fde35723b23615cbef1ece1fbaecb0e2')
}, 8000)

test.skip('convolution gaussian blur 11x11', () => {
	return readImageTransformAndSave((i) => gaussianBlur(i, { sigma: 3, size: 11 }), 'conv-gaussian-blur-11', 'b4884871f1780a44e134a52392f85bed')
}, 8000)

test('psf', () => {
	return readImageTransformAndSave((i) => psf(i), 'psf', '8958ad9f3e3888329faad7fd61e17e73')
}, 5000)

test('brightness', () => {
	return readImageTransformAndSave((i) => brightness(i, 80), 'brightness', 'b509a49b5677b98b64fd560d0e7a6d8f')
}, 5000)

test('contrast', () => {
	return readImageTransformAndSave((i) => contrast(i, 0.8125), 'contrast', '9e918ec0d7a1e96cb854aa1cd0929e79')
}, 5000)

test('saturation', () => {
	return readImageTransformAndSave((i) => saturation(i, 30), 'saturation', 'c2e2a7577b9141a36420b15019cf1449')
}, 5000)

test('gamma', () => {
	return readImageTransformAndSave((i) => gamma(i, 2.2), 'gamma', '086f10359a135f12f8cf0e7e27d52731')
}, 5000)

test.skip('median', () => {
	// return readImageAndSaveWithOptions({ median: true }, 'median', '18ab1f9f14e5776e00b3c3b7eddff13d')
}, 5000)

describe('fft', () => {
	const workspace = new FFTWorkspace(1037, 706)

	test('low-pass', () => {
		return readImageTransformAndSave((i) => autoStf(fft(i, workspace, 'lowPass', 0.015, 0.8)), 'fft-low-pass', '56a0759224001a7b3441f1393538921b')
	}, 5000)

	test('high-pass', () => {
		return readImageTransformAndSave((i) => autoStf(fft(i, workspace, 'highPass', 0.5, 0.3)), 'fft-high-pass', '16478c59f81f07e8cb82b2f4246c304a')
	}, 5000)
})

test('arcsinh stretch', () => {
	return readImageTransformAndSave((i) => arcsinhStretch(i, approximateArcsinhStretchParameters(...adf(i))), 'arcsinh', 'f2eaccfae404773ebd06f1200fb67c10')
})

test('background neutralization', () => {
	return readImageTransformAndSave((i) => autoStf(backgroundNeutralization(i, { upperLimit: 0.1 })), 'background-neutralization', '123c3c9df7ca332a67098b7eeed55981')
})

test('mmt', () => {
	const options: MultiscaleMedianTransformOptions = {
		layers: 2,
		detailLayers: [{ threshold: 2 }, { threshold: 1 }],
		residualGain: 1,
	}

	return readImageTransformAndSave((i) => autoStf(multiscaleMedianTransform(i, options)), 'mmt', 'b9bdeda38c1423468f6602451144546e')
}, 5000)

test('curves transformation - mono', () => {
	return readImageTransformAndSave((i) => autoStf(curvesTransformation(i, { curves: [{ channel: 'GRAY', x: [0.007], y: [0.08] }] })), 'ct-mono', 'f51a8f097b44ddebbedc8bea320f1c43', undefined, 1)
})

describe('curves transformation - RGB', () => {
	const scenarios: { name: string; curves: readonly CurvesTransformationCurve[]; hash: string }[] = [
		{
			name: 'gray-shadow-lift',
			curves: [{ channel: 'GRAY', x: [0.004], y: [0.08] }],
			hash: 'ed36b22d4cec83e486c2d8c50cce1712',
		},
		{
			name: 'red-boost',
			curves: [{ channel: 'RED', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: '988dc15d5063fe08095df263ac813f17',
		},
		{
			name: 'green-boost',
			curves: [{ channel: 'GREEN', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: '52950fe45e3ad347728c749d9d754690',
		},
		{
			name: 'blue-boost',
			curves: [{ channel: 'BLUE', x: [0.02, 0.55], y: [0.08, 0.72] }],
			hash: '3f8f1daad375e0e1db743708db27297d',
		},
		{
			name: 'warm-balance',
			curves: [
				{ channel: 'RED', x: [0.03, 0.45], y: [0.1, 0.6] },
				{ channel: 'BLUE', x: [0.08, 0.6], y: [0.04, 0.52] },
			],
			hash: 'bd0df21275ecf5044728d20f52ffae80',
		},
		{
			name: 'cool-balance',
			curves: [
				{ channel: 'RED', x: [0.08, 0.6], y: [0.04, 0.52] },
				{ channel: 'BLUE', x: [0.03, 0.45], y: [0.1, 0.6] },
			],
			hash: '94286951a92691c5b6b2b138ca8bbf67',
		},
	]

	for (const scenario of scenarios) {
		test(scenario.name, () => {
			return readImageTransformAndSave((i) => autoStf(curvesTransformation(i, { curves: scenario.curves })), `ct-rgb-${scenario.name}`, scenario.hash)
		})
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
		const calibrated = calibrate(clone(light!), dark, flat, bias, darkFlat)
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-full', '1e63852e5eee85471ae22f974b3393d1')
	})

	test('dark 60s', async () => {
		const calibrated = calibrate(clone(light!), dark60, flat, bias, darkFlat)
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-dark-60', 'b9f99a73a3920198ac8661a27f8c40f0')
	}, 5000)

	test('dark 15s', async () => {
		const calibrated = calibrate(clone(light!), dark15, flat, bias, darkFlat)
		await saveImageAndCompareHash(stf(calibrated, ...adf(calibrated)), 'calibrated-dark-15', '1d3b04aad4b720ec72b5eb46775c75c1')
	}, 5000)
})
