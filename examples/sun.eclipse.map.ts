import { deg } from '../src/angle'
import { TAU, PIOVERTWO } from '../src/constants'
import { PlateCarree } from '../src/projection'
import { nearestSolarEclipse } from '../src/sun'
import { type SolarEclipseMapSvgPaths, type SolarEclipseMapPoints, computeSunMoonPositionAt, type SolarEclipseMapGeometryOptions, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, solarEclipseMapToSvgPaths } from '../src/sun.eclipse'
import { timeYMD, timeToDate, type Time } from '../src/time'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'

function makeSvg(paths: SolarEclipseMapSvgPaths, width: number, height: number) {
	function marker(point: SolarEclipseMapPoints[keyof SolarEclipseMapPoints], label: string, color: string) {
		return point ? `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="${color}" /><text x="${(point.x + 5).toFixed(2)}" y="${(point.y - 5).toFixed(2)}">${label}</text>` : ''
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<style>
.ocean { fill: #103099; }
.totality { fill: rgba(250, 250, 250, 0.3); stroke: none; }
.umbra { fill: none; stroke: #CCC; stroke-width: 1; }
.center { fill: none; stroke: #000; stroke-width: 1; }
.penumbra { fill: none; stroke: #11c0cc; stroke-width: 0.8; }
.riseset { fill: none; stroke: orange; stroke-width: 0.8; }
text { font: 14px sans-serif; fill: #fff; }
</style>
<rect class="ocean" x="0" y="0" width="${width}" height="${height}" />
<path class="penumbra" d="${paths.penumbraNorth}" />
<path class="penumbra" d="${paths.penumbraSouth}" />
<path class="riseset" d="${paths.riseSetCurves}" />
<path class="totality" d="${paths.totalityPath}" />
<path class="umbra" d="${paths.umbraNorth}" />
<path class="umbra" d="${paths.umbraSouth}" />
<path class="center" d="${paths.centerLine}" />
${marker(paths.points.P1, 'P1', '#11c0cc')}
${marker(paths.points.P4, 'P4', '#11c0cc')}
${marker(paths.points.P2, 'P2', '#11c0cc')}
${marker(paths.points.P3, 'P3', '#11c0cc')}
${marker(paths.points.U1, 'U1', '#11cc9d')}
${marker(paths.points.U4, 'U4', '#11cc9d')}
${marker(paths.points.U2, 'U2', '#11cc9d')}
${marker(paths.points.U3, 'U3', '#11cc9d')}
${marker(paths.points.C1, 'C1', '#cc0000')}
${marker(paths.points.C2, 'C2', '#cc0000')}
${marker(paths.points.Max, 'Max', '#e8a000')}
</svg>`
}

let solarEclipse = nearestSolarEclipse(timeYMD(2000, 1, 1), true)
let date = timeToDate(solarEclipse.maximalTime)

const getSunMoonPosition = (time: Time) => computeSunMoonPositionAt(time, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
const options: SolarEclipseMapGeometryOptions = { longitudeStep: deg(0.5), maxAngularStep: deg(0.5), includeRiseSetCurves: true, includePolygons: true, riseSetStep: 600 }

const WIDTH = 2520.631
const HEIGHT = 1260.315

const projection = new PlateCarree(0, {
	// Longitude spans 2*PI across the full width, so one radian maps to width / TAU pixels.
	scale: WIDTH / TAU,
	falseEasting: WIDTH / 2,
	falseNorthing: HEIGHT / 2,
	yAxisDirection: 'southUp',
	centralMeridian: 0,
	longitudeWrapMode: 'pi',
	// Allow the full latitude range up to the poles; the default caps at the Web Mercator limit.
	maxLatitude: PIOVERTWO,
})

while (date[0] <= 2025) {
	const eclipse = solarEclipse
	const { maximalTime } = eclipse
	const id = `${date[0]}-${date[1]}-${date[2]}`

	const pbe = computePolynomialBesselianElements(maximalTime, getSunMoonPosition)
	const geo = computeSolarEclipseMapGeometry(eclipse, pbe, options)
	const paths = solarEclipseMapToSvgPaths(geo, projection)
	const svg = makeSvg(paths, WIDTH, HEIGHT)
	await Bun.write(`data/solar-eclipse-${id}.svg`, svg)

	solarEclipse = nearestSolarEclipse(maximalTime, true)
	date = timeToDate(solarEclipse.maximalTime)
}
