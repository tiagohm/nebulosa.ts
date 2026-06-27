import { expect, test } from 'bun:test'
import { itrs } from '../../../src/astronomy/coordinates/itrs'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { deg } from '../../../src/math/units/angle'
import { meter, toMeter } from '../../../src/math/units/distance'

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

test('caches the ITRS vector on the location', () => {
	const p = geodeticLocation(deg(10), deg(20), meter(0), Ellipsoid.WGS84)
	const first = itrs(p)
	const second = itrs(p)
	expect(second).toBe(first)
	expect(p.itrs).toBe(first)
})

test('places equatorial prime-meridian point on the +x axis', () => {
	const p = geodeticLocation(deg(0), deg(0), meter(0), Ellipsoid.WGS84)
	const [x, y, z] = itrs(p)
	// WGS84 equatorial radius is 6378137 m.
	expect(toMeter(x)).toBeCloseTo(6378137, 3)
	expect(toMeter(y)).toBeCloseTo(0, 6)
	expect(toMeter(z)).toBeCloseTo(0, 6)
})

test('adds elevation along the local geodetic normal', () => {
	const p = geodeticLocation(deg(0), deg(0), meter(1000), Ellipsoid.WGS84)
	const [x, y, z] = itrs(p)

	expect(toMeter(x)).toBeCloseTo(6379137, 3)
	expect(toMeter(y)).toBeCloseTo(0, 6)
	expect(toMeter(z)).toBeCloseTo(0, 6)
})

test('places the north pole on the +z axis below the equatorial radius', () => {
	const p = geodeticLocation(deg(0), deg(90), meter(0), Ellipsoid.WGS84)
	const [x, y, z] = itrs(p)
	expect(toMeter(x)).toBeCloseTo(0, 6)
	expect(toMeter(y)).toBeCloseTo(0, 6)
	// Polar semi-minor axis is shorter than the equatorial radius due to flattening.
	expect(toMeter(z)).toBeGreaterThan(6356000)
	expect(toMeter(z)).toBeLessThan(6378137)
})
