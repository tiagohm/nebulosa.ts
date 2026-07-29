import { analyzeBahtinov } from './bahtinov'
import type { BahtinovAnalysisInput, BahtinovAnalysisOptions, BahtinovAnalysisResult, BahtinovChromaticOptions, BahtinovChromaticResult, BahtinovPlane, BahtinovWorkspace } from './types'

// Workspace-backed chromatic comparison for an already registered RGB image. Each channel runs
// through the same geometric analyzer and remains independently inspectable; offsets use signed focus
// pixels and full-image reference coordinates. CFA input is excluded because it requires a calibrated
// color reconstruction rather than the green-only detection path.

// Compares independently fitted red, green, and blue Bahtinov focus errors.
// The green channel is the signed reference. Shared options, ROI, expected mask layout, and reusable
// workspace are applied sequentially without mutating the image or retaining analyzer state.
export function compareBahtinovChromatic(input: BahtinovAnalysisInput, workspace: BahtinovWorkspace, options: BahtinovChromaticOptions = {}): BahtinovChromaticResult {
	const { channels, bayer } = input.image.metadata
	if (channels !== 3 || bayer) throw new RangeError('Bahtinov chromatic comparison requires a non-CFA RGB image')
	const red = analyzeChromaticPlane(input, workspace, options, 'RED')
	const green = analyzeChromaticPlane(input, workspace, options, 'GREEN')
	const blue = analyzeChromaticPlane(input, workspace, options, 'BLUE')
	const channelResults = { red, green, blue }
	const failedChannels: ('red' | 'green' | 'blue')[] = []
	if (!red.success) failedChannels.push('red')
	if (!green.success) failedChannels.push('green')
	if (!blue.success) failedChannels.push('blue')
	if (!red.success || !green.success || !blue.success) return { success: false, channels: channelResults, failedChannels }

	const redError = alignedFocusError(red.error, red.centralLine.normalAngle, green.centralLine.normalAngle)
	const greenError = green.error
	const blueError = alignedFocusError(blue.error, blue.centralLine.normalAngle, green.centralLine.normalAngle)
	const minimumError = Math.min(redError, greenError, blueError)
	const maximumError = Math.max(redError, greenError, blueError)
	return {
		success: true,
		channels: { red, green, blue },
		redMinusGreen: redError - greenError,
		blueMinusGreen: blueError - greenError,
		focusSpan: maximumError - minimumError,
		redReferenceOffset: { x: red.reference.x - green.reference.x, y: red.reference.y - green.reference.y },
		blueReferenceOffset: { x: blue.reference.x - green.reference.x, y: blue.reference.y - green.reference.y },
		confidence: Math.min(red.confidence, green.confidence, blue.confidence),
	}
}

// Aligns one signed focus error with the orientation of a reference axial normal.
function alignedFocusError(error: number, normalAngle: number, referenceNormalAngle: number): number {
	return Math.cos(normalAngle - referenceNormalAngle) < 0 ? -error : error
}

// Rebuilds the input union with one explicit RGB plane while preserving ROI and mask prior.
function analyzeChromaticPlane(input: BahtinovAnalysisInput, workspace: BahtinovWorkspace, options: BahtinovChromaticOptions, plane: BahtinovPlane): BahtinovAnalysisResult {
	const analysisOptions: BahtinovAnalysisOptions = { ...options, plane }
	if (input.area) return analyzeBahtinov({ image: input.image, area: input.area, center: input.center, expected: input.expected }, workspace, analysisOptions)
	return analyzeBahtinov({ image: input.image, center: input.center, size: input.size, expected: input.expected }, workspace, analysisOptions)
}
