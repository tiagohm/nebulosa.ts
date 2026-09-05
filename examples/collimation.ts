import { analyzeCollimation } from '../src/imaging/analysis/collimation/collimation'
import { createCollimationWorkspace } from '../src/imaging/analysis/collimation/preprocess'
import { summarizeCollimationSequence } from '../src/imaging/analysis/collimation/sequence'
import type { CollimationAnalysis } from '../src/imaging/analysis/collimation/types'
import { generateSyntheticCollimationImage } from '../src/imaging/synthetic/collimation'

const workspace = createCollimationWorkspace(160, 160)
const frames: CollimationAnalysis[] = []

for (let frame = 0; frame < 5; frame++) {
	const image = generateSyntheticCollimationImage({
		width: 160,
		height: 160,
		outer: { center: { x: 80, y: 80 }, semiMajor: 48, semiMinor: 48, theta: 0, softness: 0.75 },
		obstruction: { center: { x: 82, y: 81 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.75 },
		signal: 3000,
		background: 0.05,
		noise: 0.001,
		seed: 42 + frame,
	})
	frames.push(analyzeCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 }, center: { x: 82, y: 81 } }, { workspace, tolerance: 0.1 }))
}

console.info('Synthetic image-plane geometry; the tolerance is a caller choice, not an optical collimation criterion.')
console.info(JSON.stringify(frames[0], undefined, 2))
console.info('Sequence tolerance compares temporal vector dispersion normalized by the median outer radius.')
console.info(JSON.stringify(summarizeCollimationSequence(frames, { tolerance: 0.01 }), undefined, 2))
