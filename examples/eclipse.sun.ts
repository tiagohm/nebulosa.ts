import { nearestSolarEclipse } from '../src/sun'
import { generateSolarEclipseMap } from '../src/sun.eclipse.map'
import { timeYMD } from '../src/time'

// https://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl=20270206
// https://eclipse.gsfc.nasa.gov/SEsearch/SEsearchmap.php?Ecl=20270206

const eclipse = nearestSolarEclipse(timeYMD(2027, 2, 6), true)
const map = generateSolarEclipseMap({ maximumApprox: eclipse.maximalTime })

console.info(map)
