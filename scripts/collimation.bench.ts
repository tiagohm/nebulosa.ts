import { cpus } from 'os'
import { analyzeCollimation } from '../src/imaging/analysis/collimation/collimation'
import { extractCollimationEdges, initializeCollimationRadii } from '../src/imaging/analysis/collimation/edge'
import { createCollimationWorkspace, prepareCollimation } from '../src/imaging/analysis/collimation/preprocess'
import { ROBUST_SAMPLE_CAPACITY } from '../src/imaging/analysis/robust'
import { generateSyntheticCollimationImage, renderSyntheticCollimationPattern, type SyntheticCollimationPattern } from '../src/imaging/synthetic/collimation'
import { fitEllipse } from '../src/math/numerical/ellipse.fit'

// Isolated synchronous stage timings after one warm-up, with five reused-workspace samples.
// The paired-fit timing isolates 24 solver calls; total analysis also includes support/quality,
// background refinement, recentering and photometry, so these columns must not be added together.
function measure(operation: () => unknown) {
	operation()
	const elapsed = new Float64Array(5)
	for (let i = 0; i < elapsed.length; i++) {
		const start = performance.now()
		operation()
		elapsed[i] = performance.now() - start
	}
	elapsed.sort()
	return Math.round(elapsed[2] * 100) / 100
}

console.info({ runtime: Bun.version, platform: process.platform, cpu: cpus()[0]?.model, angularSamples: 360, iterations: 5 })

for (const size of [256, 512, 1024])
	for (const cfa of [false, true]) {
		const radius = cfa ? Math.min(180, size * 0.35) : Math.min(90, size * 0.3)
		const pattern: SyntheticCollimationPattern = {
			width: size,
			height: size,
			bayer: cfa ? 'RGGB' : undefined,
			outer: { center: { x: size / 2 + 0.3, y: size / 2 + 0.1 }, semiMajor: radius, semiMinor: radius, theta: 0, softness: cfa ? 1.5 : 0.75 },
			obstruction: { center: { x: size / 2 + 3.3, y: size / 2 + 1.1 }, semiMajor: radius * 0.4, semiMinor: radius * 0.4, theta: 0, softness: cfa ? 1.5 : 0.75 },
			signal: 0.6 * Math.PI * radius * radius * 0.84,
			background: 0.05,
			noise: 0,
		}
		const generated = generateSyntheticCollimationImage(pattern)
		const raw = cfa ? new Float64Array(size * size) : generated.raw
		if (cfa) {
			renderSyntheticCollimationPattern(raw, pattern)
			for (let i = 0; i < raw.length; i++) raw[i] += pattern.background
		}
		const input = { image: { ...generated, raw }, area: { left: 0, top: 0, right: size, bottom: size }, center: pattern.obstruction.center }
		const workspace = createCollimationWorkspace(size, size, { precision: cfa ? 64 : 32 })
		const options = { workspace }
		const totalMs = measure(() => {
			const result = analyzeCollimation(input, options)
			if (!result.success || !result.stability) throw new Error(`benchmark case has no supported stability: ${JSON.stringify(result)}`)
		})
		const preprocessMs = measure(() => prepareCollimation(input, options))
		const prepared = prepareCollimation(input, options)
		if (!prepared.success) throw new Error(prepared.reason)
		const edgesMs = measure(() => {
			const initialized = initializeCollimationRadii(prepared)
			return extractCollimationEdges(prepared, prepared.center, initialized.signal)
		})
		const fitsMs = measure(() => {
			if (!fitEllipse(workspace.innerX, workspace.innerY, workspace.innerWeight) || !fitEllipse(workspace.outerX, workspace.outerY, workspace.outerWeight)) throw new Error('benchmark boundary fit failed')
		})
		const innerWeights = new Float64Array(360)
		const outerWeights = new Float64Array(360)
		const pairedFitsMs = measure(() => {
			for (let block = 0; block < 12; block++) {
				for (let i = 0; i < 360; i++) {
					innerWeights[i] = Math.floor(i / 30) === block ? 0 : workspace.innerWeight[i]
					outerWeights[i] = Math.floor(i / 30) === block ? 0 : workspace.outerWeight[i]
				}
				if (!fitEllipse(workspace.innerX, workspace.innerY, innerWeights) || !fitEllipse(workspace.outerX, workspace.outerY, outerWeights)) throw new Error('benchmark paired fit failed')
			}
		})
		let bytes = 8 * Math.min(size * size, ROBUST_SAMPLE_CAPACITY)
		for (const value of Object.values(workspace)) if (ArrayBuffer.isView(value)) bytes += value.byteLength
		console.info({ roi: `${size}x${size}`, plane: cfa ? 'CFA green1' : 'mono', precision: cfa ? 64 : 32, workspaceMiB: Math.round((bytes / 1048576) * 100) / 100, preprocessMs, edgesMs, fitsMs, pairedFitsMs, totalMs })
	}
