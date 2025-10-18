import type { Angle } from './angle'
import type { PositionAndVelocity } from './astrometry'
import { TAU } from './constants'
import type { Distance } from './distance'
import { type NumberArray, pmod } from './math'

// https://github.com/Stellarium/stellarium/blob/v25.3/src/core/planetsephems/elliptic_to_rectangular.c
// https://ftp.imcce.fr/pub/ephem/satel/

// Given the orbital elements at some time t0 calculate the
// rectangular coordinates at time (t0+dt).

// mu = G*(m1+m2) = gravitational constant of the two body problem
// a = semi major axis
// n = mean motion = TAU/(orbit period)

// elem[0] = irrelevant (either a (called by ellipticToRectangularA()) or n (called by ellipticToRectangularN())
// elem[1] = L
// elem[2] = K=e*cos(Omega+omega)
// elem[3] = H=e*sin(Omega+omega)
// elem[4] = Q=sin(i/2)*cos(Omega)
// elem[5] = P=sin(i/2)*sin(Omega)

// Omega = longitude of ascending node
// omega = argument of pericenter
// L = mean longitude = Omega + omega + M
// M = mean anomaly
// i = inclination
// e = eccentricity
export function ellipticToRectangular(a: Distance, n: Angle, elem: Readonly<NumberArray>, dt: number, o?: PositionAndVelocity): PositionAndVelocity {
	const L = pmod(elem[1] + n * dt, TAU)
	// solve Keplers equation
	//    x = L - elem[2]*sin(x) + elem[3]*cos(x)
	//  not by trivially iterating
	//    x[0] = L
	//    x[j + 1] = L - elem[2]*sin(x[j]) + elem[3]*cos(x[j])
	//  but instead by Newton approximation:
	//    0 = f(x) = x - L - elem[2]*sin(x) + elem[3]*cos(x)
	//    f'(x) = 1 - elem[2]*cos(x) - elem[3]*sin(x)
	//    x[0] = L or whatever, perhaps first step of trivial iteration
	//    x[j + 1] = x[j] - f(x[j])/f'(x[j])
	let LE = L - elem[2] * Math.sin(L) + elem[3] * Math.cos(L)

	while (true) {
		const cLE = Math.cos(LE)
		const sLE = Math.sin(LE)

		// for eccentricity < 1 we have denominator > 0
		const dLE = (L - LE + elem[2] * sLE - elem[3] * cLE) / (1 - elem[2] * cLE - elem[3] * sLE)

		LE += dLE

		if (Math.abs(dLE) <= 1e-14) break
	}

	const cLE = Math.cos(LE)
	const sLE = Math.sin(LE)

	const dlf = -elem[2] * sLE + elem[3] * cLE
	const phi = Math.sqrt(1 - elem[2] * elem[2] - elem[3] * elem[3])
	const psi = 1 / (1 + phi)

	const x1 = a * (cLE - elem[2] - psi * dlf * elem[3])
	const y1 = a * (sLE - elem[3] + psi * dlf * elem[2])

	const elem_4q = elem[4] * elem[4] // Q²
	const elem_5q = elem[5] * elem[5] // P²
	const dwho = 2 * Math.sqrt(1 - elem_4q - elem_5q)
	const rtp = 1 - elem_5q - elem_5q
	const rtq = 1 - elem_4q - elem_4q
	const rdg = 2 * elem[5] * elem[4]

	const p = o?.[0] ?? [0, 0, 0]
	const v = o?.[1] ?? [0, 0, 0]

	p[0] = x1 * rtp + y1 * rdg
	p[1] = x1 * rdg + y1 * rtq
	p[2] = (-x1 * elem[5] + y1 * elem[4]) * dwho

	const rsam1 = -elem[2] * cLE - elem[3] * sLE
	const h = (a * n) / (1 + rsam1)
	const vx1 = h * (-sLE - psi * rsam1 * elem[3])
	const vy1 = h * (cLE + psi * rsam1 * elem[2])

	v[0] = vx1 * rtp + vy1 * rdg
	v[1] = vx1 * rdg + vy1 * rtq
	v[2] = (-vx1 * elem[5] + vy1 * elem[4]) * dwho

	return o ?? [p, v]
}

export function ellipticToRectangularN(mu: number, elem: Readonly<NumberArray>, dt: number, o?: PositionAndVelocity) {
	const n = elem[0]
	const a = Math.cbrt(mu / (n * n))
	return ellipticToRectangular(a, n, elem, dt, o)
}

export function ellipticToRectangularA(mu: number, elem: Readonly<NumberArray>, dt: number, o?: PositionAndVelocity) {
	const a = elem[0]
	const n = Math.sqrt(mu / (a * a * a)) // mean motion
	return ellipticToRectangular(a, n, elem, dt, o)
}
