import { expect, test } from 'bun:test'
import { Timescale, timeYMDHMS } from './time'
import { mercury, sun } from './vsop87e'

const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

test('sun', () => {
	const [p, v] = sun(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-5.627216085710264e-3, 4)
	expect(p[1]).toBeCloseTo(-4.623288853793163e-3, 4)
	expect(p[2]).toBeCloseTo(-1.810648864024488e-3, 4)

	expect(v[0]).toBeCloseTo(7.20756826549653e-6, 8)
	expect(v[1]).toBeCloseTo(-3.150637865956372e-6, 8)
	expect(v[2]).toBeCloseTo(-1.496489706499541e-6, 8)
})

test('mercury', () => {
	const [p, v] = mercury(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-1.959982881850366e-1, 4)
	expect(p[1]).toBeCloseTo(-3.859788284043806e-1, 4)
	expect(p[2]).toBeCloseTo(-1.8580075689658e-1, 4)

	expect(v[0]).toBeCloseTo(2.000248138888697e-2, 8)
	expect(v[1]).toBeCloseTo(-8.274960901706343e-3, 8)
	expect(v[2]).toBeCloseTo(-6.492683743807411e-3, 8)
})
