import { expect, test } from 'bun:test'
import { normalizeAngle, toDeg } from '../src/angle'
import { cirs, equatorial } from '../src/astrometry'
import { toKilometer } from '../src/distance'
import { moon } from '../src/elpmpp02'
import { Timescale, time } from '../src/time'
import { plusVec } from '../src/vector'
import { toKilometerPerSecond } from '../src/velocity'
import { earth } from '../src/vsop87e'

const t = time(2460787, 0, Timescale.TDB)

test('geocentric moon', () => {
	const [p, v] = moon(t)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ -> Moon, Geocentric, Start=2025-Apr-21 12:00:00.0000 TDB, x-y axes
	expect(toKilometer(p[0])).toBeCloseTo(2.277022952914551e5, 0)
	expect(toKilometer(p[1])).toBeCloseTo(-2.716040172219414e5, 0)
	expect(toKilometer(p[2])).toBeCloseTo(-1.468436314218936e5, 0)

	expect(toKilometerPerSecond(v[0])).toBeCloseTo(7.795201165478988e-1, 6)
	expect(toKilometerPerSecond(v[1])).toBeCloseTo(5.763328053344962e-1, 6)
	expect(toKilometerPerSecond(v[2])).toBeCloseTo(3.195746490772242e-1, 6)
})

test('barycentric moon', () => {
	const a = earth(t)
	const b = moon(t)

	const p = plusVec(a[0], b[0])
	const v = plusVec(a[1], b[1])

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ -> Solar System Barycenter -> Moon, Start=2025-Apr-21 12:00:00.0000 TDB, x-y axes
	expect(toKilometer(p[0])).toBeCloseTo(-1.289981444523174e8, -4) // ~1000 km
	expect(toKilometer(p[1])).toBeCloseTo(-7.262535593206646e7, -4)
	expect(toKilometer(p[2])).toBeCloseTo(-3.14827849844187e7, -4)

	expect(toKilometerPerSecond(v[0])).toBeCloseTo(1.576750706886595e1, 5)
	expect(toKilometerPerSecond(v[1])).toBeCloseTo(-2.289427596080699e1, 5)
	expect(toKilometerPerSecond(v[2])).toBeCloseTo(-9.855697816042639, 5)

	const [ra, dec] = equatorial(cirs(p, t, a))
	expect(toDeg(normalizeAngle(ra))).toBeCloseTo(309.98653, 0)
	expect(toDeg(dec)).toBeCloseTo(-22.50197, 0)
})
