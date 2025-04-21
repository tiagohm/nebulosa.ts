import { expect, test } from 'bun:test'
import { toKilometer } from '../src/distance'
import { moonELPMPP02 } from '../src/elpmpp02'
import { Timescale, time } from '../src/time'
import { toKilometerPerSecond } from '../src/velocity'

test('moon', () => {
	const t = time(2460787, 0, Timescale.TDB)
	const [p, v] = moonELPMPP02(t)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ -> Moon, Geocentric, Start=2025-Apr-21 12:00:00.0000 TDB, x-y axes
	expect(toKilometer(p[0])).toBeCloseTo(2.277022952914551e5, 0)
	expect(toKilometer(p[1])).toBeCloseTo(-2.716040172219414e5, 0)
	expect(toKilometer(p[2])).toBeCloseTo(-1.468436314218936e5, 0)

	expect(toKilometerPerSecond(v[0])).toBeCloseTo(7.795201165478988e-1, 6)
	expect(toKilometerPerSecond(v[1])).toBeCloseTo(5.763328053344962e-1, 6)
	expect(toKilometerPerSecond(v[2])).toBeCloseTo(3.195746490772242e-1, 6)
})
