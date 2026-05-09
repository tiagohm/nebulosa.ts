import { nearestSolarEclipse } from '../src/sun'
import { generateSolarEclipseMap } from '../src/sun.eclipse.map'
import { timeYMD } from '../src/time'

const eclipse = nearestSolarEclipse(timeYMD(2027, 2, 6), true)
const map = generateSolarEclipseMap({ maximumApprox: eclipse.maximalTime })

console.info(map)
