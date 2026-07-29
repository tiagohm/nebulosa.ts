import { PI } from '../../../core/constants'
import type { Point } from '../../../math/numerical/geometry'
import { grayscaleFromChannel, type Image } from '../../model/types'
import { detectStars } from '../../stars/detector'
import { analyzeBahtinov } from './bahtinov'
import type { BahtinovLocation, BahtinovLocationSource, BahtinovLocatorOptions } from './types'

// Bounded full-frame Bahtinov pattern localization. Star detections provide compact-source seeds,
// while an angular line-energy grid supplies candidates for saturated or elongated patterns.
// Every returned location has passed the regular ROI analyzer in full-image pixel coordinates.

// Default analysis ROI side in pixels.
const DEFAULT_ROI_SIZE = 256
// Default maximum candidate ROIs evaluated by the full analyzer.
const DEFAULT_MAXIMUM_CANDIDATES = 16
// Default maximum independently measured patterns returned.
const DEFAULT_MAXIMUM_PATTERNS = 4
// Number of axial orientations sampled by the inexpensive line-energy prefilter.
const LINE_ENERGY_ANGLE_COUNT = 18
// Pixel spacing between samples along each prefilter diameter.
const LINE_ENERGY_SAMPLE_STEP = 2
// Number of strongest directional responses forming the line-energy statistic.
const LINE_ENERGY_PEAK_COUNT = 3
// BT.709 weights reused by the coarse RGB sampler.
const LOCATOR_BT709_WEIGHTS = grayscaleFromChannel('BT709')

// Mutable bounded candidate assembled from star and grid evidence.
interface BahtinovLocatorCandidate extends Point {
	// Raw star evidence proportional to measured flux times SNR.
	starScore: number
	// Dimensionless angular line-energy contrast.
	lineEnergy: number
	// Whether a star detection contributed this seed.
	fromStar: boolean
	// Whether the line-energy grid contributed this seed.
	fromGrid: boolean
}

// Finds independently measurable Bahtinov patterns across a normalized mono, RGB, or CFA image.
// The search is bounded by `maximumCandidates`; returned coordinates are full-image pixels and the
// input image is never mutated.
export function locateBahtinovPatterns(image: Image, options: BahtinovLocatorOptions = {}): BahtinovLocation[] {
	validateLocatorImage(image)
	const minimumDimension = Math.min(image.metadata.width, image.metadata.height)
	const roiSize = options.roiSize ?? Math.min(DEFAULT_ROI_SIZE, minimumDimension)
	const gridStep = options.gridStep ?? Math.max(16, Math.floor(roiSize / 2))
	const maximumCandidates = options.maximumCandidates ?? DEFAULT_MAXIMUM_CANDIDATES
	const maximumPatterns = options.maximumPatterns ?? DEFAULT_MAXIMUM_PATTERNS
	const minimumCandidateDistance = options.minimumCandidateDistance ?? Math.max(4, roiSize / 3)
	const minimumLinearEnergy = options.minimumLinearEnergy ?? 0.05
	const minimumStarSignalToNoise = options.minimumStarSignalToNoise ?? 0
	validateLocatorOptions(roiSize, gridStep, maximumCandidates, maximumPatterns, minimumCandidateDistance, minimumLinearEnergy, minimumStarSignalToNoise)

	const candidates: BahtinovLocatorCandidate[] = []
	const stars = detectStars(image, { maxStars: maximumCandidates * 2, minSNR: minimumStarSignalToNoise })
	for (const star of stars) addOrMergeCandidate(candidates, star.x, star.y, star.flux * star.snr, 0, true, false, minimumCandidateDistance)

	const gridCandidates: BahtinovLocatorCandidate[] = []
	const gridCapacity = maximumCandidates * 2
	const radius = Math.max(8, Math.floor(roiSize * 0.4))
	const angularResponses = new Float64Array(LINE_ENERGY_ANGLE_COUNT)
	forEachGridCenter(image.metadata.width, image.metadata.height, roiSize, gridStep, (x, y) => {
		const lineEnergy = computeLinearEnergy(image, x, y, radius, angularResponses)
		if (lineEnergy >= minimumLinearEnergy) retainStrongestGridCandidate(gridCandidates, { x, y, starScore: 0, lineEnergy, fromStar: false, fromGrid: true }, gridCapacity)
	})
	for (const candidate of gridCandidates) addOrMergeCandidate(candidates, candidate.x, candidate.y, 0, candidate.lineEnergy, false, true, minimumCandidateDistance)

	let maximumStarScore = 0
	let maximumLineEnergy = 0
	for (const candidate of candidates) {
		if (candidate.lineEnergy <= 0) candidate.lineEnergy = computeLinearEnergy(image, candidate.x, candidate.y, radius, angularResponses)
		maximumStarScore = Math.max(maximumStarScore, candidate.starScore)
		maximumLineEnergy = Math.max(maximumLineEnergy, candidate.lineEnergy)
	}
	candidates.sort((a, b) => combinedCandidateScore(b, maximumStarScore, maximumLineEnergy) - combinedCandidateScore(a, maximumStarScore, maximumLineEnergy))

	const locations: BahtinovLocation[] = []
	const limit = Math.min(maximumCandidates, candidates.length)
	for (let i = 0; i < limit; i++) {
		const candidate = candidates[i]
		const analysis = analyzeBahtinov({ image, center: { x: candidate.x, y: candidate.y }, size: roiSize, expected: options.expected }, options.analysis)
		if (!analysis.success || hasNearbyLocation(locations, analysis.reference, minimumCandidateDistance)) continue
		const candidateScore = combinedCandidateScore(candidate, maximumStarScore, maximumLineEnergy)
		const score = Math.sqrt(candidateScore * analysis.confidence)
		locations.push({
			candidateCenter: { x: candidate.x, y: candidate.y },
			source: candidateSource(candidate),
			score,
			analysis,
		})
	}
	locations.sort((a, b) => b.score - a.score)
	if (locations.length > maximumPatterns) locations.length = maximumPatterns
	return locations
}

// Validates the image fields needed by the broad detector and direct sample access.
function validateLocatorImage(image: Image): void {
	const { width, height, channels, stride } = image.metadata
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new RangeError('Bahtinov locator image dimensions must be positive integers')
	if (channels !== 1 && channels !== 3) throw new RangeError('Bahtinov locator supports one or three image channels')
	if (!Number.isInteger(stride) || stride < width * channels || image.raw.length < stride * height) throw new RangeError('Bahtinov locator image buffer or stride is invalid')
}

// Validates finite locator limits before star detection or grid traversal.
function validateLocatorOptions(roiSize: number, gridStep: number, maximumCandidates: number, maximumPatterns: number, minimumCandidateDistance: number, minimumLinearEnergy: number, minimumStarSignalToNoise: number): void {
	if (!Number.isInteger(roiSize) || roiSize < 32) throw new RangeError('roiSize must be an integer of at least 32 pixels')
	if (!Number.isInteger(gridStep) || gridStep <= 0) throw new RangeError('gridStep must be a positive integer')
	if (!Number.isInteger(maximumCandidates) || maximumCandidates <= 0) throw new RangeError('maximumCandidates must be a positive integer')
	if (!Number.isInteger(maximumPatterns) || maximumPatterns <= 0 || maximumPatterns > maximumCandidates) throw new RangeError('maximumPatterns must be a positive integer no larger than maximumCandidates')
	if (!Number.isFinite(minimumCandidateDistance) || minimumCandidateDistance < 0) throw new RangeError('minimumCandidateDistance must be finite and non-negative')
	if (!Number.isFinite(minimumLinearEnergy) || minimumLinearEnergy < 0) throw new RangeError('minimumLinearEnergy must be finite and non-negative')
	if (!Number.isFinite(minimumStarSignalToNoise) || minimumStarSignalToNoise < 0) throw new RangeError('minimumStarSignalToNoise must be finite and non-negative')
}

// Visits a grid covering all valid ROI-center positions and always includes the image center.
function forEachGridCenter(width: number, height: number, roiSize: number, gridStep: number, visit: (x: number, y: number) => void): void {
	const half = (Math.min(roiSize, width, height) - 1) * 0.5
	const minimumX = Math.min(half, (width - 1) * 0.5)
	const maximumX = Math.max(minimumX, width - 1 - half)
	const minimumY = Math.min(half, (height - 1) * 0.5)
	const maximumY = Math.max(minimumY, height - 1 - half)
	for (let y = minimumY; y <= maximumY; y += gridStep) {
		for (let x = minimumX; x <= maximumX; x += gridStep) visit(x, y)
	}
	visit((width - 1) * 0.5, (height - 1) * 0.5)
}

// Computes contrast of the three strongest diameter orientations against the angular median.
function computeLinearEnergy(image: Image, centerX: number, centerY: number, radius: number, responses: Float64Array): number {
	for (let angleIndex = 0; angleIndex < LINE_ENERGY_ANGLE_COUNT; angleIndex++) {
		const angle = (angleIndex * PI) / LINE_ENERGY_ANGLE_COUNT
		const cosAngle = Math.cos(angle)
		const sinAngle = Math.sin(angle)
		let sum = 0
		let count = 0
		for (let offset = -radius; offset <= radius; offset += LINE_ENERGY_SAMPLE_STEP) {
			const value = sampleLocatorPlane(image, centerX + offset * cosAngle, centerY + offset * sinAngle)
			if (Number.isFinite(value)) {
				sum += value
				count++
			}
		}
		responses[angleIndex] = count > 0 ? sum / count : 0
	}
	responses.sort()
	const median = (responses[LINE_ENERGY_ANGLE_COUNT / 2 - 1] + responses[LINE_ENERGY_ANGLE_COUNT / 2]) * 0.5
	let excess = 0
	for (let i = LINE_ENERGY_ANGLE_COUNT - LINE_ENERGY_PEAK_COUNT; i < LINE_ENERGY_ANGLE_COUNT; i++) excess += Math.max(0, responses[i] - median)
	return excess / (LINE_ENERGY_PEAK_COUNT * Math.max(Math.abs(median), Number.EPSILON))
}

// Samples nearest-neighbor mono/CFA intensity or BT.709 RGB luminance for the coarse prefilter.
function sampleLocatorPlane(image: Image, x: number, y: number): number {
	const ix = Math.round(x)
	const iy = Math.round(y)
	const { width, height, channels, stride } = image.metadata
	if (ix < 0 || ix >= width || iy < 0 || iy >= height) return Number.NaN
	const index = iy * stride + ix * channels
	if (channels === 1) return image.raw[index]
	return image.raw[index] * LOCATOR_BT709_WEIGHTS.red + image.raw[index + 1] * LOCATOR_BT709_WEIGHTS.green + image.raw[index + 2] * LOCATOR_BT709_WEIGHTS.blue
}

// Retains only the strongest bounded set of line-energy grid candidates.
function retainStrongestGridCandidate(candidates: BahtinovLocatorCandidate[], candidate: BahtinovLocatorCandidate, capacity: number): void {
	let index = candidates.length
	while (index > 0 && candidates[index - 1].lineEnergy < candidate.lineEnergy) index--
	if (index >= capacity) return
	candidates.splice(index, 0, candidate)
	if (candidates.length > capacity) candidates.pop()
}

// Merges nearby seed evidence while retaining the location with the stronger individual cue.
function addOrMergeCandidate(candidates: BahtinovLocatorCandidate[], x: number, y: number, starScore: number, lineEnergy: number, fromStar: boolean, fromGrid: boolean, minimumDistance: number): void {
	const minimumDistanceSquared = minimumDistance * minimumDistance
	for (const candidate of candidates) {
		const dx = candidate.x - x
		const dy = candidate.y - y
		if (dx * dx + dy * dy > minimumDistanceSquared) continue
		if (starScore > candidate.starScore || lineEnergy > candidate.lineEnergy) {
			candidate.x = x
			candidate.y = y
		}
		candidate.starScore = Math.max(candidate.starScore, starScore)
		candidate.lineEnergy = Math.max(candidate.lineEnergy, lineEnergy)
		candidate.fromStar ||= fromStar
		candidate.fromGrid ||= fromGrid
		return
	}
	candidates.push({ x, y, starScore, lineEnergy, fromStar, fromGrid })
}

// Normalizes and combines broad compact-source and angular line evidence.
function combinedCandidateScore(candidate: BahtinovLocatorCandidate, maximumStarScore: number, maximumLineEnergy: number): number {
	const star = maximumStarScore > 0 ? candidate.starScore / maximumStarScore : 0
	const line = maximumLineEnergy > 0 ? candidate.lineEnergy / maximumLineEnergy : 0
	return Math.min(1, 0.35 * star + 0.65 * line)
}

// Converts candidate evidence flags to the stable public source discriminator.
function candidateSource(candidate: BahtinovLocatorCandidate): BahtinovLocationSource {
	return candidate.fromStar && candidate.fromGrid ? 'combined' : candidate.fromStar ? 'star' : 'lineEnergy'
}

// Rejects duplicate successful analyses by their fitted external-line intersection.
function hasNearbyLocation(locations: readonly BahtinovLocation[], reference: Readonly<Point>, minimumDistance: number): boolean {
	const minimumDistanceSquared = minimumDistance * minimumDistance
	for (const location of locations) {
		const dx = location.analysis.reference.x - reference.x
		const dy = location.analysis.reference.y - reference.y
		if (dx * dx + dy * dy <= minimumDistanceSquared) return true
	}
	return false
}
