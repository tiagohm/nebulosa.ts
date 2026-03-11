import { DAYMIN, TAU } from '../constants'

export const MU = 398600.8 // in km3 / s2
export const earthRadius = 6378.135 // in km
export const XKE = 60 / Math.sqrt((earthRadius * earthRadius * earthRadius) / MU)
export const vkmpersec = (earthRadius * XKE) / 60
export const tumin = 1 / XKE
export const J2 = 0.001082616
export const J3 = -0.00000253881
export const J4 = -0.00000165597
export const J3OJ2 = J3 / J2
export const X2O3 = 2 / 3
export const XPDOTP = DAYMIN / TAU // 229.1831180523293
