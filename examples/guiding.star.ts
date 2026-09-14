import type { CatalogSource, CatalogSourceStar } from '../src/devices/indi/simulator/types'
import { normalizeAngle } from '../src/math/units/angle'
import { StarTracker } from '../src/observation/guiding/tracker.star'
import { GuidingSimulation, runGuidingSimulation, type GuidingCatalogContext } from './guiding.simulator'

// Fixed star field used by the interactive stellar-guiding simulator. Coordinates are generated
// around the requested camera center so the synthetic mount error can move stars across the frame.
function starCatalog({ failures }: GuidingCatalogContext): CatalogSource {
	return (rightAscension, declination, _radius) => {
		if (failures.noStars) return []

		const quality = failures.lowQuality ? { snr: 0.5, flux: 0.02 } : { snr: 120, flux: 300 }
		const cosDeclination = Math.max(0.2, Math.abs(Math.cos(declination)))
		const offsets: readonly [number, number, number][] = [
			[0, 0, quality.flux],
			[0.0008, 0.00035, 80],
			[-0.0009, -0.00045, 60],
			[0.0012, -0.00075, 40],
		]

		return offsets.map(([east, north, flux], index): CatalogSourceStar => ({
			rightAscension: normalizeAngle(rightAscension + east / cosDeclination),
			declination: declination + north,
			hfd: 2,
			snr: index === 0 ? quality.snr : quality.snr * 0.7,
			flux: index === 0 ? quality.flux : flux,
		}))
	}
}

const simulation = new GuidingSimulation({
	title: 'star guiding simulator',
	tracker: new StarTracker(),
	catalogSource: starCatalog,
})

await runGuidingSimulation(simulation)
