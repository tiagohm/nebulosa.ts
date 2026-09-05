import { analyzeCollimation } from '../src/imaging/analysis/collimation/collimation'
import { createCollimationWorkspace } from '../src/imaging/analysis/collimation/preprocess'
import { generateSyntheticCollimationImage } from '../src/imaging/synthetic/collimation'

const image = generateSyntheticCollimationImage({
	width: 160,
	height: 160,
	outer: { center: { x: 80, y: 80 }, semiMajor: 48, semiMinor: 48, theta: 0, softness: 0.75 },
	obstruction: { center: { x: 82, y: 81 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.75 },
	signal: 3000,
	background: 0.05,
	noise: 0.001,
	seed: 42,
})

const result = analyzeCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 }, center: { x: 82, y: 81 } }, { workspace: createCollimationWorkspace(160, 160), tolerance: 0.1 })

console.info('Synthetic image-plane geometry; the tolerance is a caller choice, not an optical collimation criterion.')
console.info(JSON.stringify(result, undefined, 2))
