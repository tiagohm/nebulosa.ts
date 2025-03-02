import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { meter, toMeter } from '../src/distance'
import { itrs } from '../src/itrs'
import { Ellipsoid, geodeticLocation } from '../src/location'

test('IERS2010', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890), Ellipsoid.IERS2010)
	const [x, y, z] = itrs(p)
	expect(toMeter(x)).toBeCloseTo(4154201.0724025597, 9)
	expect(toMeter(y)).toBeCloseTo(-4154201.072402559, 9)
	expect(toMeter(z)).toBeCloseTo(-2477066.8839821406, 9)
})

test('WGS84', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890), Ellipsoid.WGS84)
	const [x, y, z] = itrs(p)
	expect(toMeter(x)).toBeCloseTo(4154201.32717891177162528, 8)
	expect(toMeter(y)).toBeCloseTo(-4154201.327178914099931717, 8)
	expect(toMeter(z)).toBeCloseTo(-2477067.080795707646757364, 8)
})
