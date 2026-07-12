import { expect, test } from 'bun:test'
import { inspectAberration } from '../../../src/imaging/analysis/aberration.single'
import type { Image } from '../../../src/imaging/model/types'
import type { StarProfile } from '../../../src/imaging/stars/profile'
import { Bitpix } from '../../../src/io/formats/fits/fits'

// Creates an empty mono image whose dimensions normalize supplied synthetic profiles.
function image(width: number = 101, height: number = 101): Image {
	return {
		raw: new Float32Array(width * height),
		header: {},
		metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, stride: width, strideInBytes: width * 4, bayer: undefined },
	}
}

// Creates a valid profile at a normalized sensor coordinate for deterministic inspection tests.
function profileAt(source: Image, u: number, v: number, hfd: number, snr: number = 30, theta: number = 0, eccentricity: number = 0.4): StarProfile {
	const { width, height } = source.metadata
	const x = (u + 0.5) * (width - 1)
	const y = (v + 0.5) * (height - 1)

	return {
		x,
		y,
		valid: true,
		flux: 1,
		snr,
		hfd,
		fwhm: hfd,
		major: hfd * 1.2,
		minor: hfd,
		eccentricity,
		elongation: 1.2,
		theta,
		background: 0,
		deviation: 0.01,
		peak: 0.5,
		quality: 1,
		model: 'moments',
		flags: [],
	}
}

// Preserves supplied profile order while applying balanced spatial quotas and discriminated reasons.
test('selects profiles spatially with per-star quota diagnostics', () => {
	const source = image()
	const profiles = [profileAt(source, -0.4, -0.4, 2, 30), profileAt(source, -0.39, -0.39, 2, 3), profileAt(source, 0.4, 0.4, 3, 30)]

	const result = inspectAberration(source, {
		profiles,
		selection: { columns: 2, rows: 2, maximumPerCell: 1, maximumTotal: 10 },
		minimumStars: 1,
		minimumStarsPerRegion: 1,
	})

	expect(result.stars).toHaveLength(profiles.length)
	expect(result.stars[0].selected).toBeTrue()
	expect(result.stars[1].selected).toBeFalse()
	expect(result.stars[1].selectionReasons).toContain('spatialQuota')
	expect(result.stars[2].selected).toBeTrue()
	expect(result.quality.selectedStarCount).toBe(2)
})

// Distributes a constrained total cap over populated cells before taking a second profile from one cell.
test('balances the global selection cap across spatial cells', () => {
	const source = image()
	const profiles = [profileAt(source, -0.4, -0.4, 2, 30), profileAt(source, -0.39, -0.39, 2, 29), profileAt(source, 0.4, 0.4, 2, 10)]

	const result = inspectAberration(source, {
		profiles,
		selection: { columns: 2, rows: 2, maximumPerCell: 2, maximumTotal: 2 },
		minimumStars: 1,
		minimumStarsPerRegion: 1,
	})

	expect(result.stars[0].selected).toBeTrue()
	expect(result.stars[1].selected).toBeFalse()
	expect(result.stars[2].selected).toBeTrue()
})

// Honors the explicit selection policy for saturated profiles while retaining their metric-level exclusion.
test('allows saturated profiles through selection only when requested', () => {
	const source = image()
	const saturated: StarProfile = { ...profileAt(source, 0, 0, 2), flags: ['saturated'] }

	const allowed = inspectAberration(source, { profiles: [saturated], selection: { rejectSaturated: false }, minimumStars: 1, minimumStarsPerRegion: 1 })
	const rejected = inspectAberration(source, { profiles: [saturated], minimumStars: 1, minimumStarsPerRegion: 1 })

	expect(allowed.stars[0].selected).toBeTrue()
	expect(allowed.stars[0].rejections).toContainEqual({ metric: 'hfd', reason: 'unavailable' })
	expect(rejected.stars[0].selected).toBeFalse()
	expect(rejected.stars[0].selectionReasons).toContain('saturated')
})

// Clips a regional scalar outlier without discarding unrelated profile identity or shape measurements.
test('rejects regional scalar outliers per metric', () => {
	const source = image()
	const profiles = [profileAt(source, -0.1, -0.1, 2), profileAt(source, 0, -0.1, 2), profileAt(source, -0.1, 0, 2), profileAt(source, 0, 0, 20)]

	const result = inspectAberration(source, {
		profiles,
		regions: { layout: 'custom', regions: [{ id: 'all', left: -0.5, top: -0.5, right: 0.5, bottom: 0.5 }] },
		minimumStars: 1,
		minimumStarsPerRegion: 1,
		sigmaClip: 3,
	})

	expect(result.stars[3].selected).toBeTrue()
	expect(result.stars[3].rejections).toContainEqual({ metric: 'hfd', reason: 'outlier' })
	expect(result.stars[3].rejections).toContainEqual({ metric: 'fwhm', reason: 'outlier' })
	expect(result.regions[0].medianHFD).toBe(2)
})

// Prevents non-finite supplied profile metrics and SNR from entering public summaries or selection.
test('rejects non-finite supplied profile measurements', () => {
	const source = image()
	const invalidHfd = { ...profileAt(source, -0.3, -0.3, 2), hfd: Number.NaN }
	const invalidSnr = { ...profileAt(source, 0.3, 0.3, 2), snr: Number.NaN }
	const result = inspectAberration(source, { profiles: [invalidHfd, invalidSnr], minimumStars: 1, minimumStarsPerRegion: 1 })

	expect(result.stars[0].rejections).toContainEqual({ metric: 'hfd', reason: 'unavailable' })
	expect(result.stars[1].selected).toBeFalse()
	expect(result.stars[1].selectionReasons).toContain('belowMinimumSNR')
	expect(result.regions.every((region) => region.medianHFD === undefined || Number.isFinite(region.medianHFD))).toBeTrue()
})

// Keeps an elongation outlier out of the uniform-shape diagnostic while preserving its orientation.
test('excludes rejected elongation from uniform diagnostics', () => {
	const source = image()
	const profiles = [profileAt(source, -0.45, -0.4, 2, 30, 0.2), profileAt(source, -0.4, -0.35, 2, 30, 0.2), { ...profileAt(source, -0.35, -0.3, 2, 30, 0.2), elongation: 10 }, profileAt(source, 0.25, -0.4, 2, 30, 0.2), profileAt(source, 0.35, -0.35, 2, 30, 0.2), profileAt(source, 0.45, -0.3, 2, 30, 0.2)]
	const result = inspectAberration(source, { profiles, minimumStars: 5, minimumStarsPerRegion: 1, sigmaClip: 3 })

	expect(result.stars[2].rejections).toContainEqual({ metric: 'elongation', reason: 'outlier' })
	expect(result.findings.some((finding) => finding.kind === 'uniformElongation')).toBeTrue()
})

// Publishes numeric regional maps and a conservative one-frame focus-gradient finding from supplied profiles.
test('inspects regions and reports a one-frame size gradient without claiming mechanical tilt', () => {
	const source = image()
	const profiles: StarProfile[] = []

	for (const v of [-0.4, 0, 0.4]) {
		for (const u of [-0.4, 0, 0.4]) {
			for (let sample = 0; sample < 3; sample++) profiles.push(profileAt(source, u, v, 3 + 2 * u, 30, 0.1))
		}
	}

	const result = inspectAberration(source, { profiles, minimumStars: 3, minimumStarsPerRegion: 1, regions: { layout: 'grid', columns: 3, rows: 3 } })

	expect(result.regions).toHaveLength(9)
	expect(result.quality.occupiedRegionCount).toBe(9)
	expect(result.vectors.length).toBeGreaterThan(0)
	expect(result.findings.some((finding) => finding.kind === 'singleFrameFocusGradient')).toBeTrue()
})
