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
