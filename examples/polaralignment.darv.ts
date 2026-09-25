import type { Image } from '../src/imaging/model/types'
import { renderSyntheticStreak } from '../src/imaging/synthetic/streak'
import { arcsec, deg, toArcmin } from '../src/math/units/angle'
import { COARSE_DARV_EXPOSURE_PRESET, estimateDarvExposure } from '../src/observation/alignment/polaralignment.darv'
import { analyzeDarvImage } from '../src/observation/alignment/polaralignment.darv.analysis'
import { solveDarvPolarError } from '../src/observation/alignment/polaralignment.darv.solve'
import { DarvMatrixTransform } from '../src/observation/alignment/polaralignment.darv.transform'
import { convertPolarAlignmentAltitudeError } from '../src/observation/alignment/polaralignment.util'

// Run with bun run examples/polaralignment.darv.ts. This offline example renders two exposures;
// real applications supply captured Image objects, actual timing and the current sky transform.
// DarvWcsTransform accepts a current FITS-header provider; DarvCalibrationTransform accepts the
// current image-to-axis guiding matrix and signed radians per calibrated axis unit.
const latitude = deg(-30)
const plan = estimateDarvExposure({ focalLength: 2000, pixelSize: 2, latitude, hourAngle: 0, declination: 0, mode: 'azimuth', preset: COARSE_DARV_EXPOSURE_PRESET })
console.info('Suggested capture timing (seconds)', { leg: plan.recommendedLegTime, total: plan.recommendedExposure })

// The following synthetic captures have their own actual timing. The planner never replaces it.
const exposure = 200
const legDuration = 100
const scale = arcsec(0.2)
const transform = new DarvMatrixTransform([scale, 0, 0, scale])
const observations = []

for (const [hourAngle, separation] of [
	[0, -50],
	[deg(90), 50],
]) {
	const width = 256
	const height = 192
	const image: Image = { raw: new Float32Array(width * height).fill(0.1), header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
	const start = { x: 40, y: 96 }
	const turn = { x: 210, y: start.y + separation / 2 }
	const end = { x: start.x, y: start.y + separation }
	renderSyntheticStreak(image, { start, end: turn, width: 2, intensity: 0.4 })
	renderSyntheticStreak(image, { start: turn, end, width: 2, intensity: 0.4 })

	const result = analyzeDarvImage({
		image,
		exposure,
		legDuration,
		firstDirection: 'west', // Commanded mount slew; the star moves east in the image's sky plane.
		starts: [start], // Capture metadata or a previous frame identifies which outer endpoint is first.
		transform,
		geometry: { latitude, hourAngle, mode: hourAngle === 0 ? 'azimuth' : 'altitude' },
		detection: { maxWidth: 6 },
	})

	if (result.drift === undefined) {
		console.info('Inconclusive exposure', result.diagnostics)
		continue
	}
	console.info('Measured drift (arcsec/s)', result.drift / arcsec(1), 'component', result.component)
	observations.push({ drift: result.drift, latitude, hourAngle })
}

const solution = solveDarvPolarError(observations)
if (solution.status === 'ok') {
	const displayedAltitudeError = convertPolarAlignmentAltitudeError(solution.altitudeError, latitude)
	console.info('Polar errors (arcmin)', { azimuth: toArcmin(solution.azimuthError), altitude: toArcmin(solution.altitudeError), displayedAltitude: toArcmin(displayedAltitudeError), conditionNumber: solution.conditionNumber })
} else console.info('Joint solution inconclusive', solution.reason)

// The solver remains geometric. displayedAltitude uses the default three-point atmosphere;
// pass explicit from/to refraction parameters (or false for geometric) to convert either way.
// Equal-time images without a start marker retain unsigned drift and directionUnresolved. A merged
// retrace returns an unresolvedSeparation upper limit; neither result authorizes a signed adjustment.
