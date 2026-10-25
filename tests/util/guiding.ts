import type { Image } from '../../src/imaging/model/types'
import type { GuideImageDecoder } from '../../src/observation/guiding/client'
import { type GuideStar, type GuideStarDetector, StarTracker, type StarTrackerConfigOverrides } from '../../src/observation/guiding/tracker.star'

// Image-free guide-frame fixtures for StarTracker and GuiderClient tests. A fixture image carries
// zero pixels plus the analytic detections of the stars it represents, and a fixture BLOB maps back
// to its image, so tests exercise decoding and detection seams without rendering, FITS encoding,
// decoding, or running the star detector. Coordinates are full-frame pixels, top-left origin.

// Star centre in pixels with an optional integrated flux in normalized full-scale units.
export type FixtureStar = readonly [number, number] | readonly [number, number, number]

// Integrated flux used when a fixture star omits it, in normalized full-scale units.
export const FIXTURE_STAR_FLUX = 10

// Peak per unit flux of a plotted HFD 3 px star on the normalized scale, measured from the real
// detector on plotStar profiles (flux 10 peaks at ~0.95).
const PEAK_PER_FLUX = 0.0948

// Detections attached to each fixture image.
const detections = new WeakMap<Image, readonly GuideStar[]>()
// Fixture image represented by each fixture BLOB.
const blobs = new WeakMap<Buffer, Image>()
// Zero pixels shared by every fixture image of the same size.
const pixels = new Map<number, Float32Array>()

// Models what the detector reports for a noise-free plotted star of HFD 3 px: SNR grows with the
// square root of the flux, and the peak clips at full scale for bright stars.
export function fixtureGuideStar(x: number, y: number, flux: number = FIXTURE_STAR_FLUX): GuideStar {
	return { x, y, flux, snr: Math.sqrt(flux), hfd: 3, fwhm: 3, peak: Math.min(1, flux * PEAK_PER_FLUX) }
}

// Builds a mono image whose detections are the stars with centres inside the frame, ordered by
// decreasing flux like the detector. Pixels default to shared zeros; pass `raw` (width x height
// samples) only when a test inspects pixel values.
export function fixtureGuideImage(width: number, height: number, stars: readonly FixtureStar[] = [], raw?: Float32Array): Image {
	const pixelCount = width * height
	raw ??= pixels.get(pixelCount)
	if (raw === undefined) pixels.set(pixelCount, (raw = new Float32Array(pixelCount)))

	const image: Image = {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: width, NAXIS2: height },
		metadata: { width, height, channels: 1, pixelCount, pixelSizeInBytes: 4, strideInBytes: width * 4, stride: width, bitpix: -32, bayer: undefined },
		raw,
	}

	const visible = stars.filter(([x, y]) => x >= 0 && x < width && y >= 0 && y < height).map(([x, y, flux]) => fixtureGuideStar(x, y, flux))
	visible.sort((a, b) => b.flux - a.flux)
	detections.set(image, visible)
	return image
}

// Returns the detections attached to a fixture image, or none for any other image.
export const fixtureStarDetector: GuideStarDetector = (image) => detections.get(image) ?? []

// Wraps a fixture image into a small BLOB token that fixtureImageDecoder resolves back to it.
export function fixtureGuideBlob(image: Image): Buffer {
	const blob = Buffer.from('fixture')
	blobs.set(blob, image)
	return blob
}

// Resolves a fixture BLOB to its image and any other payload to undefined, i.e. a decode failure.
export const fixtureImageDecoder: GuideImageDecoder = (data) => Promise.resolve(blobs.get(data))

// Builds a StarTracker that reads the detections attached to fixture images.
export function fixtureStarTracker(config: StarTrackerConfigOverrides = {}) {
	return new StarTracker({ ...config, detector: fixtureStarDetector })
}
