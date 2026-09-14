import type { EquatorialCoordinate } from '../src/astronomy/coordinates/coordinate'
import { Timescale, timeSubtract, timeUnix, type Time } from '../src/astronomy/time/time'
import type { CatalogSource, CatalogSourceStar } from '../src/devices/indi/simulator/types'
import { normalizeAngle } from '../src/math/units/angle'
import { calibratedNonSiderealTransform, NonSiderealTracker, type NonSiderealEphemeris } from '../src/observation/guiding/tracker.nonsidereal'
import { StarTracker } from '../src/observation/guiding/tracker.star'
import { GuidingSimulation, runGuidingSimulation, type GuidingCatalogContext } from './guiding.simulator'

const INITIAL_RIGHT_ASCENSION = 1.2
const INITIAL_DECLINATION = 0.35
const EAST_RATE = 1.8e-6
const NORTH_RATE = -7e-7

interface MovingTarget {
	readonly ephemeris: NonSiderealEphemeris
	readonly catalogSource: (context: GuidingCatalogContext) => CatalogSource
}

// Shared sky trajectory for the ephemeris and rendered camera catalog. Rates are radians per
// second; the catalog follows the mount clock so every frame images the same moving target.
function movingTarget(): MovingTarget {
	let epoch: Time | undefined
	let baseRightAscension = INITIAL_RIGHT_ASCENSION
	let baseDeclination = INITIAL_DECLINATION
	let baseInitialized = false

	const position = (time: Time, out: EquatorialCoordinate) => {
		const reference = epoch ?? time
		const seconds = timeSubtract(time, reference, Timescale.UTC) * 86400
		out.rightAscension = normalizeAngle(baseRightAscension + EAST_RATE * seconds)
		out.declination = baseDeclination + NORTH_RATE * seconds
		return out
	}

	return {
		ephemeris: { position },
		catalogSource: ({ failures, getUtcTime }) => {
			epoch = timeUnix(getUtcTime() / 1000, true)
			return (rightAscension, declination, _radius) => {
				if (failures.noStars) return []
				if (!baseInitialized) {
					baseRightAscension = rightAscension
					baseDeclination = declination
					baseInitialized = true
				}

				const now = timeUnix(getUtcTime() / 1000, true)
				const target: EquatorialCoordinate = { rightAscension: 0, declination: 0 }
				position(now, target)
				const quality = failures.lowQuality ? { snr: 0.5, flux: 0.02 } : { snr: 120, flux: 300 }
				const cosDeclination = Math.max(0.2, Math.abs(Math.cos(declination)))
				const stars: readonly [EquatorialCoordinate, number, number][] = [
					[target, quality.snr, quality.flux],
					[{ rightAscension: normalizeAngle(rightAscension + 0.0008 / cosDeclination), declination: declination + 0.00035 }, 84, 80],
					[{ rightAscension: normalizeAngle(rightAscension - 0.0009 / cosDeclination), declination: declination - 0.00045 }, 76, 60],
					[{ rightAscension: normalizeAngle(rightAscension + 0.0012 / cosDeclination), declination: declination - 0.00075 }, 68, 40],
				]

				return stars.map(([coordinate, snr, flux], index): CatalogSourceStar => ({
					rightAscension: coordinate.rightAscension,
					declination: coordinate.declination,
					hfd: 2,
					snr: index === 0 ? quality.snr : snr,
					flux: index === 0 ? quality.flux : flux,
				}))
			}
		},
	}
}

function transformFromCalibration(simulation: GuidingSimulation) {
	const calibration = simulation.client.getCalibrationData()
	return calibratedNonSiderealTransform({
		pixelScaleArcsecPerPixel: simulation.client.getPixelScale(),
		calibration: {
			rightAscension: { unitX: Math.cos(calibration.xAngle), unitY: Math.sin(calibration.xAngle) },
			declination: { unitX: Math.cos(calibration.yAngle), unitY: Math.sin(calibration.yAngle) },
		},
		orientation: {
			axisFromEastNorth: [calibration.xParity === '+' ? -1 : 1, 0, 0, calibration.yParity === '+' ? 1 : -1],
		},
	})
}

const trajectory = movingTarget()
const tracker = new NonSiderealTracker(new StarTracker())
tracker.arm(trajectory.ephemeris, {
	offsetToImage: ([east, north]) => [east * 1e6, north * 1e6],
})

const simulation = new GuidingSimulation({
	title: 'non-sidereal guiding simulator',
	tracker,
	timeFactory: (timestampMillis) => timeUnix(timestampMillis / 1000, true),
	catalogSource: trajectory.catalogSource,
	calibrationComplete: (current) => tracker.onCalibrationChanged(transformFromCalibration(current)),
	calibrationFlipped: () => tracker.onCalibrationChanged(),
	recover: (current) => tracker.onCalibrationChanged(transformFromCalibration(current)),
})

await runGuidingSimulation(simulation)
