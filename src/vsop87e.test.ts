import { expect, test } from 'bun:test'
import { Timescale, timeYMDHMS } from './time'
import { earth, jupiter, mars, mercury, neptune, saturn, sun, uranus, venus } from './vsop87e'

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

test('venus', () => {
	const [p, v] = venus(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(1.900523426439691e-1, 4)
	expect(p[1]).toBeCloseTo(6.324522248918866e-1, 4)
	expect(p[2]).toBeCloseTo(2.724715392894307e-1, 4)

	expect(v[0]).toBeCloseTo(-1.952637274678126e-2, 8)
	expect(v[1]).toBeCloseTo(4.468200319849219e-3, 8)
	expect(v[2]).toBeCloseTo(3.246291452187315e-3, 8)
})

test('earth', () => {
	const [p, v] = earth(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-4.233751009575819e-1, 4)
	expect(p[1]).toBeCloseTo(8.12440651994386e-1, 4)
	expect(p[2]).toBeCloseTo(3.523754609004759e-1, 4)

	expect(v[0]).toBeCloseTo(-1.58431514138574e-2, 8)
	expect(v[1]).toBeCloseTo(-6.762131049402481e-3, 8)
	expect(v[2]).toBeCloseTo(-2.930875581488578e-3, 8)
})

test('mars', () => {
	const [p, v] = mars(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-7.060143032790035e-1, 4)
	expect(p[1]).toBeCloseTo(1.321598085070232, 4)
	expect(p[2]).toBeCloseTo(6.253874021996311e-1, 4)

	expect(v[0]).toBeCloseTo(-1.209132974984316e-2, 8)
	expect(v[1]).toBeCloseTo(-4.522215641912777e-3, 8)
	expect(v[2]).toBeCloseTo(-1.747931988660694e-3, 8)
})

test('jupiter', () => {
	const [p, v] = jupiter(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(9.425932699140838e-1, 4)
	expect(p[1]).toBeCloseTo(4.597633804459441, 4)
	expect(p[2]).toBeCloseTo(1.947760544753772, 4)

	expect(v[0]).toBeCloseTo(-7.501238340458042e-3, 8)
	expect(v[1]).toBeCloseTo(1.550390596836247e-3, 7)
	expect(v[2]).toBeCloseTo(8.47161538590583e-4, 8)
})

test('saturn', () => {
	const [p, v] = saturn(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(9.465320219579908, 4)
	expect(p[1]).toBeCloseTo(-1.412995555528071, 4)
	expect(p[2]).toBeCloseTo(-9.913244481741533e-1, 4)

	expect(v[0]).toBeCloseTo(6.710877373100868e-4, 8)
	expect(v[1]).toBeCloseTo(5.076667252431999e-3, 7)
	expect(v[2]).toBeCloseTo(2.06801065205951e-3, 8)
})

test('uranus', () => {
	const [p, v] = uranus(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(1.105085487337878e1, 3)
	expect(p[1]).toBeCloseTo(1.482203434077305e1, 3)
	expect(p[2]).toBeCloseTo(6.335346170028346, 3)

	expect(v[0]).toBeCloseTo(-3.272891191081531e-3, 7)
	expect(v[1]).toBeCloseTo(1.852391532882198e-3, 7)
	expect(v[2]).toBeCloseTo(8.575827907426235e-4, 7)
})

test('neptune', () => {
	const [p, v] = neptune(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(2.987483007152151e1, 3)
	expect(p[1]).toBeCloseTo(-2.756767823676414e-1, 3)
	expect(p[2]).toBeCloseTo(-8.566143156794556e-1, 3)

	expect(v[0]).toBeCloseTo(4.165542016549182e-5, 7)
	expect(v[1]).toBeCloseTo(2.922854175547836e-3, 7)
	expect(v[2]).toBeCloseTo(1.195303189969087e-3, 7)
})
