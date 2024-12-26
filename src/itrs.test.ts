import { expect, test } from 'bun:test'
import { deg } from './angle'
import { meter, toMeter } from './distance'
import { itrs } from './itrs'
import { GeoId, location } from './location'

test('IERS2010', () => {
	const p = location(deg(-45), deg(-23), meter(890), GeoId.IERS2010)
	const [x, y, z] = itrs(p)
	expect(toMeter(x)).toBeCloseTo(4154201.0724025597, 7)
	expect(toMeter(y)).toBeCloseTo(-4154201.072402559, 7)
	expect(toMeter(z)).toBeCloseTo(-2477066.8839821406, 7)
})

test('WGS84', () => {
	const p = location(deg(-45), deg(-23), meter(890), GeoId.WGS84)
	const [x, y, z] = itrs(p)
	expect(toMeter(x)).toBeCloseTo(4154201.32717891177162528, 7)
	expect(toMeter(y)).toBeCloseTo(-4154201.327178914099931717, 7)
	expect(toMeter(z)).toBeCloseTo(-2477067.080795707646757364, 7)
})
