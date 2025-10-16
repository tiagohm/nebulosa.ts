import type { Angle } from './angle'
import { TAU } from './constants'

// Base: Functions and other definitions useful with multiple packages.
// https://github.com/commenthol/astronomia/blob/master/src/base.js

// K is the Gaussian gravitational constant.
export const K = 0.01720209895

// Computes the illuminated fraction of a body's disk.
export function illuminated(i: Angle) {
	// (41.1) p. 283, also (48.1) p. 345.
	return (1 + Math.cos(i)) * 0.5
}

// Computes position angle of the midpoint of an illuminated limb.
export function limb(bra: Angle, bdec: Angle, sra: Angle, sdec: Angle): Angle {
	// Mentioned in ch 41, p. 283.  Formula (48.5) p. 346
	const sδ = Math.sin(bdec)
	const cδ = Math.cos(bdec)
	const sδ0 = Math.sin(sdec)
	const cδ0 = Math.cos(sdec)
	const sa0a = Math.sin(sra - bra)
	const ca0a = Math.cos(sra - bra)
	const x = Math.atan2(cδ0 * sa0a, sδ0 * cδ - cδ0 * sδ * ca0a)
	return x >= 0 ? x : x + TAU
}

// Evaluates a polynomial with coefficients c at x. The constant term is c[0].
export function horner(x: number, ...c: number[]) {
	let i = c.length - 1
	let y = c[i]

	while (i-- > 0) {
		y = y * x + c[i]
	}

	return y
}
