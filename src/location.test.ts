import { expect, test } from 'bun:test'
import { deg } from './angle'
import { meter } from './distance'
import { GeoId, itrs, location, polarRadius } from './location'

test('polarRadius', () => {
	expect(polarRadius(GeoId.IERS2010)).toBeCloseTo(0.000042492261609253282, 20)
	expect(polarRadius(GeoId.WGS84)).toBeCloseTo(0.000042492264659253469, 20)
})

test('itrs', () => {
	const p = location(-deg(46.87), deg(34.78), meter(122))
	expect(itrs(p, GeoId.IERS2010)).toEqual([0.000023967086896531528, -0.000025584922885478519, 0.000024184279862241743])
	expect(itrs(p, GeoId.WGS84)).toEqual([0.000023967088329219064, -0.000025584924414875909, 0.000024184281746294139])
})
