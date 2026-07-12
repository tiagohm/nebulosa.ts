import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { detectStarProfiles, measureStarProfile, measureStarProfiles } from '../../../src/imaging/stars/profile'
import { Bitpix } from '../../../src/io/formats/fits/fits'

// Creates a normalized mono image suitable for deterministic star-profile measurements.
function image(width: number, height: number, background: number = 0.05): Image {
	const raw = new Float32Array(width * height).fill(background)

	return {
		raw,
		header: {},
		metadata: {
			width,
			height,
			channels: 1,
			pixelCount: width * height,
			pixelSizeInBytes: 4,
			bitpix: Bitpix.FLOAT,
			stride: width,
			strideInBytes: width * 4,
			bayer: undefined,
		},
	}
}

// Adds an elliptical Gaussian with principal-axis sigmas expressed in pixels.
function addGaussian(image: Image, x: number, y: number, majorSigma: number, minorSigma: number, theta: number, amplitude: number): void {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const cosTheta = Math.cos(theta)
	const sinTheta = Math.sin(theta)
	const majorVariance = majorSigma * majorSigma
	const minorVariance = minorSigma * minorSigma

	for (let py = 0; py < height; py++) {
		const dy = py - y
		const row = py * stride

		for (let px = 0; px < width; px++) {
			const dx = px - x
			const major = dx * cosTheta + dy * sinTheta
			const minor = -dx * sinTheta + dy * cosTheta
			raw[row + px] += amplitude * Math.exp(-0.5 * ((major * major) / majorVariance + (minor * minor) / minorVariance))
		}
	}
}

// Adds a single elliptical Moffat component evaluated at pixel centers.
function addMoffat(image: Image, x: number, y: number, alphaMajor: number, alphaMinor: number, theta: number, beta: number, amplitude: number): void {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const cosTheta = Math.cos(theta)
	const sinTheta = Math.sin(theta)
	const inverseMajor2 = 1 / (alphaMajor * alphaMajor)
	const inverseMinor2 = 1 / (alphaMinor * alphaMinor)

	for (let py = 0; py < height; py++) {
		const dy = py - y
		const row = py * stride
		for (let px = 0; px < width; px++) {
			const dx = px - x
			const major = dx * cosTheta + dy * sinTheta
			const minor = -dx * sinTheta + dy * cosTheta
			raw[row + px] += amplitude / (1 + major * major * inverseMajor2 + minor * minor * inverseMinor2) ** beta
		}
	}
}

// Measures a round Gaussian profile through the adaptive curve-of-growth path.
test('measures a round Gaussian with refined centroid and HFD', () => {
	const sigma = 2
	const expectedFwhm = 2 * Math.sqrt(2 * Math.LN2) * sigma
	const source = image(65, 65)
	addGaussian(source, 32.25, 31.75, sigma, sigma, 0, 0.6)

	const profile = measureStarProfile(source, { x: 32, y: 32 }, { initialRadius: 4, maximumRadius: 16, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.x).toBeCloseTo(32.25, 1)
	expect(profile.y).toBeCloseTo(31.75, 1)
	expect(profile.hfd).toBeCloseTo(expectedFwhm, 1)
	expect(profile.fwhm).toBeCloseTo(expectedFwhm, 1)
	expect(profile.theta).toBeUndefined()
	expect(profile.flags).not.toContain('nonFinite')
})

// Recovers principal Gaussian-equivalent axes and axial orientation from an elliptical profile.
test('measures an elliptical Gaussian principal shape', () => {
	const majorSigma = 3
	const minorSigma = 1.5
	const theta = Math.PI / 4
	const scale = 2 * Math.sqrt(2 * Math.LN2)
	const source = image(81, 81)
	addGaussian(source, 40.2, 39.8, majorSigma, minorSigma, theta, 0.6)

	const profile = measureStarProfile(source, { x: 40, y: 40 }, { initialRadius: 4, maximumRadius: 24, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.major).toBeCloseTo(scale * majorSigma, 1)
	expect(profile.minor).toBeCloseTo(scale * minorSigma, 1)
	expect(profile.eccentricity).toBeCloseTo(Math.sqrt(0.75), 1)
	expect(profile.elongation).toBeCloseTo(2, 1)
	expect(profile.theta).toBeCloseTo(theta, 1)
})

// Recovers a single elliptical Moffat component with subpixel center and analytic shape parameters.
test('fits an elliptical Moffat profile at pixel centers', () => {
	const source = image(81, 81)
	const centerX = 40.3
	const centerY = 39.7
	const alphaMajor = 3.2
	const alphaMinor = 1.8
	const theta = 0.65
	const beta = 2.4
	addMoffat(source, centerX, centerY, alphaMajor, alphaMinor, theta, beta, 0.65)

	const profile = measureStarProfile(source, { x: 40, y: 40 }, { model: 'moffat', initialRadius: 5, maximumRadius: 20, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.model).toBe('moffat')
	expect(profile.flags).not.toContain('poorFit')
	expect(profile.moffat?.success).toBeTrue()
	if (!profile.moffat?.success) return
	expect(profile.x).toBeCloseTo(centerX, 2)
	expect(profile.y).toBeCloseTo(centerY, 2)
	expect(profile.moffat.alphaMajor).toBeCloseTo(alphaMajor, 2)
	expect(profile.moffat.alphaMinor).toBeCloseTo(alphaMinor, 2)
	expect(profile.moffat.beta).toBeCloseTo(beta, 2)
	expect(profile.theta).toBeCloseTo(theta, 2)
	expect(profile.moffat.rms).toBeLessThan(1e-5)
})

// Falls back to the valid moment profile when one Moffat component cannot represent a blend.
test('falls back to moments when a requested Moffat fit is poor', () => {
	const source = image(65, 65)
	addGaussian(source, 29, 32, 1.5, 1.5, 0, 0.6)
	addGaussian(source, 35, 32, 1.5, 1.5, 0, 0.45)

	const moments = measureStarProfile(source, { x: 29, y: 32 }, { initialRadius: 4, maximumRadius: 16, minSNR: 0 })
	const profile = measureStarProfile(source, { x: 29, y: 32 }, { model: 'moffat', initialRadius: 4, maximumRadius: 16, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.model).toBe('moments')
	expect(profile.flags).toContain('blended')
	expect(profile.flags).toContain('poorFit')
	expect(profile.moffat?.success).toBeFalse()
	expect(profile.x).toBe(moments.x)
	expect(profile.y).toBe(moments.y)
	expect(profile.fwhm).toBe(moments.fwhm)
	expect(profile.quality).toBeCloseTo(0.375)
})

// Reuses the fixed solver workspace without leaking parameters between batch entries.
test('fits independent Moffat profiles in input order', () => {
	const source = image(97, 65)
	addMoffat(source, 24.2, 31.8, 2.6, 2.6, 0, 2.2, 0.6)
	addMoffat(source, 72.25, 32.3, 3.1, 1.7, Math.PI - 0.2, 3.1, 0.55)

	const profiles = measureStarProfiles(
		source,
		[
			{ x: 24, y: 32 },
			{ x: 72, y: 32 },
		],
		{ model: 'moffat', initialRadius: 5, maximumRadius: 18, minSNR: 0 },
	)

	expect(profiles.map((profile) => profile.sourceIndex)).toEqual([0, 1])
	expect(profiles.every((profile) => profile.model === 'moffat' && profile.moffat?.success)).toBeTrue()
	expect(profiles[0].theta).toBeUndefined()
	const firstFit = profiles[0].moffat
	const secondFit = profiles[1].moffat
	if (!firstFit?.success || !secondFit?.success) return
	expect(firstFit.beta).toBeCloseTo(2.2, 2)
	expect(profiles[1].theta).toBeCloseTo(Math.PI - 0.2, 2)
	expect(secondFit.beta).toBeCloseTo(3.1, 2)
})

// Preserves axial orientation near the 0/PI wrap without flipping the principal axis.
test('normalizes elliptical orientation near PI', () => {
	const theta = Math.PI - 0.08
	const source = image(81, 81)
	addGaussian(source, 40, 40, 3, 1.5, theta, 0.6)
	const profile = measureStarProfile(source, { x: 40, y: 40 }, { initialRadius: 4, maximumRadius: 24, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.theta).toBeDefined()
	expect(profile.theta).toBeGreaterThan(0)
	expect(profile.theta).toBeLessThan(Math.PI)
	expect(profile.theta).toBeCloseTo(theta, 1)
})

// Uses the annular median and MAD path without biasing a centered star on a smooth background gradient.
test('measures a star over an inclined background', () => {
	const source = image(65, 65, 0)

	for (let y = 0; y < 65; y++) {
		for (let x = 0; x < 65; x++) source.raw[y * 65 + x] = 0.03 + x * 0.0005 + y * 0.00025
	}

	addGaussian(source, 32, 32, 2, 2, 0, 0.6)
	const profile = measureStarProfile(source, { x: 32, y: 32 }, { initialRadius: 4, maximumRadius: 16, minSNR: 0 })

	expect(profile.valid).toBeTrue()
	expect(profile.background).toBeCloseTo(0.054, 2)
	expect(profile.fwhm).toBeCloseTo(2 * Math.sqrt(2 * Math.LN2) * 2, 0)
})

// Preserves input order and reports invalid candidates without emitting non-finite public measurements.
test('preserves batch identity and discriminates non-finite candidates', () => {
	const source = image(33, 33)
	addGaussian(source, 16, 16, 1.5, 1.5, 0, 0.6)

	const profiles = measureStarProfiles(
		source,
		[
			{ x: 16, y: 16 },
			{ x: Number.NaN, y: 0 },
		],
		{ minSNR: 0 },
	)

	expect(profiles).toHaveLength(2)
	expect(profiles[0].sourceIndex).toBe(0)
	expect(profiles[0].valid).toBeTrue()
	expect(profiles[1].sourceIndex).toBe(1)
	expect(profiles[1].valid).toBeFalse()
	expect(profiles[1].flags).toEqual(['nonFinite'])
	expect(profiles[1].x).toBe(0)
	expect(profiles[1].y).toBe(0)
})

// Reuses the fast candidate detector before measuring profiles without changing detector output contracts.
test('detects and profiles a candidate through the combined API', () => {
	const source = image(65, 65)
	addGaussian(source, 32, 32, 1.5, 1.5, 0, 0.8)

	const profiles = detectStarProfiles(source, { maxStars: 1 }, { minSNR: 0 })

	expect(profiles).toHaveLength(1)
	expect(profiles[0].sourceIndex).toBe(0)
	expect(profiles[0].valid).toBeTrue()
	expect(profiles[0].hfd).toBeGreaterThan(0)
})

// Propagates the optional model through the detector-backed entry point used by the inspector.
test('detects and fits a Moffat candidate through the combined API', () => {
	const source = image(65, 65)
	addMoffat(source, 32.2, 31.8, 2.8, 1.9, 0.4, 2.6, 0.75)

	const profiles = detectStarProfiles(source, { maxStars: 1 }, { model: 'moffat', initialRadius: 5, maximumRadius: 18, minSNR: 0 })

	expect(profiles).toHaveLength(1)
	expect(profiles[0].model).toBe('moffat')
	expect(profiles[0].moffat?.success).toBeTrue()
})

// Flags saturation and a resolved secondary maximum without changing the input image.
test('flags saturated and blended profiles', () => {
	const saturated = image(65, 65)
	addGaussian(saturated, 32, 32, 2, 2, 0, 0.9)
	const saturatedProfile = measureStarProfile(saturated, { x: 32, y: 32 }, { minSNR: 0, saturationLevel: 0.8 })

	expect(saturatedProfile.valid).toBeFalse()
	expect(saturatedProfile.flags).toContain('saturated')

	const blended = image(65, 65)
	addGaussian(blended, 29, 32, 1.5, 1.5, 0, 0.6)
	addGaussian(blended, 35, 32, 1.5, 1.5, 0, 0.45)
	const blendedProfile = measureStarProfile(blended, { x: 29, y: 32 }, { initialRadius: 4, maximumRadius: 16, minSNR: 0 })

	expect(blendedProfile.flags).toContain('blended')
})

// Marks a profile close to the sensor boundary while keeping valid finite measurements available.
test('marks a near-border profile', () => {
	const source = image(65, 65)
	addGaussian(source, 5, 32, 1.5, 1.5, 0, 0.6)

	const profile = measureStarProfile(source, { x: 5, y: 32 }, { initialRadius: 4, maximumRadius: 12, minSNR: 0, borderMargin: 6 })

	expect(profile.flags).toContain('nearBorder')
	expect(Number.isFinite(profile.hfd)).toBeTrue()
})

// Distinguishes an ROI truncated by the sensor boundary from a merely nearby warning.
test('flags a star profile clipped by the sensor boundary', () => {
	const source = image(33, 33)
	addGaussian(source, 1.5, 16, 3, 2, 0, 0.6)
	const profile = measureStarProfile(source, { x: 2, y: 16 }, { initialRadius: 5, maximumRadius: 16, minSNR: 0 })

	expect(profile.flags).toContain('clipped')
	expect(profile.valid).toBeFalse()
})

// Returns a discriminated low-signal result without leaking non-finite physical metrics.
test('rejects a flat low-signal candidate', () => {
	const profile = measureStarProfile(image(33, 33), { x: 16, y: 16 })

	expect(profile.valid).toBeFalse()
	expect(profile.flags).toContain('lowSignal')
	expect(profile.hfd).toBeUndefined()
	expect(profile.fwhm).toBeUndefined()
})
