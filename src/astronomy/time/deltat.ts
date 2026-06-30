import { spline } from '../../math/numerical/spline'

// Delta T (TT - UT1) models in seconds as a function of decimal calendar year. Combines the Espenak-Meeus
// 2006 piecewise polynomials, the Stephenson-Morrison long-term parabolas, and the S15 cubic-spline fit;
// `deltaT` selects the most reliable model per era. Used to relate Terrestrial Time to Universal Time.

// Computes Delta T (TT - UT1) in seconds from the Espenak and Meeus 2006 polynomial expressions.
// The piecewise fit spans roughly -1999 to +3000; beyond +2150 and before -500 it reduces to the
// long-term parabola, so the function stays finite and monotonic for any year.
// https://eclipse.gsfc.nasa.gov/SEhelp/deltatpoly2004.html
//   year: decimal calendar year, for example 2024.5 for the middle of 2024.
export function deltaTByEspenakMeeus2006(year: number) {
	if (year < -500) {
		const u = (year - 1820) / 100
		return -20 + 32 * u * u
	} else if (year < 500) {
		const u = year / 100
		return 10583.6 + u * (-1014.41 + u * (33.78311 + u * (-5.952053 + u * (-0.1798452 + u * (0.022174192 + u * 0.0090316521)))))
	} else if (year < 1600) {
		const u = (year - 1000) / 100
		return 1574.2 + u * (-556.01 + u * (71.23472 + u * (0.319781 + u * (-0.8503463 + u * (-0.005050998 + u * 0.0083572073)))))
	} else if (year < 1700) {
		const t = year - 1600
		return 120 + t * (-0.9808 + t * (-0.01532 + t / 7129))
	} else if (year < 1800) {
		const t = year - 1700
		return 8.83 + t * (0.1603 + t * (-0.0059285 + t * (0.00013336 + t * (-1 / 1174000))))
	} else if (year < 1860) {
		const t = year - 1800
		return 13.72 + t * (-0.332447 + t * (0.0068612 + t * (0.0041116 + t * (-0.00037436 + t * (0.0000121272 + t * (-0.0000001699 + t * 0.000000000875))))))
	} else if (year < 1900) {
		const t = year - 1860
		return 7.62 + t * (0.5737 + t * (-0.251754 + t * (0.01680668 + t * (-0.0004473624 + t / 233174))))
	} else if (year < 1920) {
		const t = year - 1900
		return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 + t * -0.000197)))
	} else if (year < 1941) {
		const t = year - 1920
		return 21.2 + t * (0.84493 + t * (-0.0761 + t * 0.0020936))
	} else if (year < 1961) {
		const t = year - 1950
		return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547))
	} else if (year < 1986) {
		const t = year - 1975
		return 45.45 + t * (1.067 + t * (-1 / 260 + t * (-1 / 718)))
	} else if (year < 2005) {
		const t = year - 2000
		return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599))))
	} else if (year < 2050) {
		const t = year - 2000
		return 62.92 + t * (0.32217 + t * 0.005589)
	} else if (year < 2150) {
		const u = (year - 1820) / 100
		return -20 + 32 * u * u - 0.5628 * (2150 - year)
	} else {
		const u = (year - 1820) / 100
		return -20 + 32 * u * u
	}
}

// Evaluates the Stephenson and Morrison 2004 parabola outside the historical fit interval.
export const parabolaOfStephensonMorrison2004 = spline(1820, 1920, [0, 32, 0, -20])

// https://doi.org/10.1098/rspa.2020.0776
// Evaluates the Stephenson, Morrison and Hohenkerk 2016 parabola outside the spline interval.
export const parabolaOfStephensonMorrisonHohenkerk2016 = spline(1825, 1925, [0, 31.4, 0, -10])

// S15 spline tables (Stephenson, Morrison & Hohenkerk 2016): per-segment lower/upper year bounds and the
// cubic coefficients A, B, C, D evaluated as A·t³ + B·t² + C·t + D over each normalized segment.
const S15_LOWER = [
	-720, -100, 400, 1000, 1150, 1300, 1500, 1600, 1650, 1720, 1800, 1810, 1820, 1830, 1840, 1850, 1855, 1860, 1865, 1870, 1875, 1880, 1885, 1890, 1895, 1900, 1905, 1910, 1915, 1920, 1925, 1930, 1935, 1940, 1945, 1950, 1953, 1956, 1959, 1962, 1965, 1968, 1971, 1974, 1977, 1980, 1983, 1986, 1989, 1992, 1995, 1998, 2001,
	2004, 2007, 2010, 2013, 2016,
] as const
const S15_UPPER = [
	-100, 400, 1000, 1150, 1300, 1500, 1600, 1650, 1720, 1800, 1810, 1820, 1830, 1840, 1850, 1855, 1860, 1865, 1870, 1875, 1880, 1885, 1890, 1895, 1900, 1905, 1910, 1915, 1920, 1925, 1930, 1935, 1940, 1945, 1950, 1953, 1956, 1959, 1962, 1965, 1968, 1971, 1974, 1977, 1980, 1983, 1986, 1989, 1992, 1995, 1998, 2001, 2004,
	2007, 2010, 2013, 2016, 2019,
] as const
const S15_A = [
	409.16, -503.433, 1085.087, -25.346, -24.641, -29.414, 16.197, 3.018, -2.127, -37.939, 1.918, -3.812, 3.25, -0.096, -0.539, -0.883, 1.558, -2.477, 2.72, -0.914, -0.039, 0.563, -1.438, 1.871, -0.232, -1.257, 0.72, -0.825, 0.262, 0.008, 0.127, 0.142, 0.702, -1.106, 0.614, -0.277, 0.631, -0.799, 0.507, 0.199, -0.414,
	0.202, -0.229, 0.172, -0.192, 0.081, -0.165, 0.448, -0.276, 0.11, -0.313, 0.109, 0.199, -0.017, -0.084, 0.128, -0.095, -0.139,
] as const
const S15_B = [
	776.247, 1303.151, -298.291, 184.811, 108.771, 61.953, -6.572, 10.505, 38.333, 41.731, -1.126, 4.629, -6.806, 2.944, 2.658, 0.261, -2.389, 2.284, -5.148, 3.011, 0.269, 0.152, 1.842, -2.474, 3.138, 2.443, -1.329, 0.831, -1.643, -0.856, -0.831, -0.449, -0.022, 2.086, -1.232, 0.22, -0.61, 1.282, -1.115, 0.406, 1.002,
	-0.242, 0.364, -0.323, 0.193, -0.384, -0.14, -0.637, 0.708, -0.121, 0.21, -0.729, -0.402, 0.194, 0.144, -0.109, 0.277, -0.007,
] as const
const S15_C = [
	-9999.586, -5822.27, -5671.519, -753.21, -459.628, -421.345, -192.841, -78.697, -68.089, 2.507, -3.481, 0.021, -2.157, -6.018, -0.416, 1.642, -0.486, -0.591, -3.456, -5.593, -2.314, -1.893, 0.101, -0.531, 0.134, 5.715, 6.828, 6.33, 5.518, 3.02, 1.333, 0.052, -0.419, 1.645, 2.499, 1.127, 0.737, 1.409, 1.577, 0.868,
	2.275, 3.035, 3.157, 3.199, 3.069, 2.878, 2.354, 1.577, 1.648, 2.235, 2.324, 1.804, 0.674, 0.466, 0.804, 0.839, 1.007, 1.277,
] as const
const S15_D = [
	20371.848, 11557.668, 6535.116, 1650.393, 1056.647, 681.149, 292.343, 109.127, 43.952, 12.068, 18.367, 15.678, 16.516, 10.804, 7.634, 9.338, 10.357, 9.04, 8.255, 2.371, -1.126, -3.21, -4.388, -3.884, -5.017, -1.977, 4.923, 11.142, 17.479, 21.617, 23.789, 24.418, 24.164, 24.426, 27.05, 28.932, 30.002, 30.76, 32.652,
	33.621, 35.093, 37.956, 40.951, 44.244, 47.291, 50.361, 52.936, 54.984, 56.373, 58.453, 60.678, 62.898, 64.083, 64.553, 65.197, 66.061, 66.92, 68.109,
] as const

const S15_LAST_INDEX = S15_LOWER.length - 1

// First and last decimal years covered by the tabulated S15 spline segments.
const S15_MIN_YEAR = S15_LOWER[0]
const S15_MAX_YEAR = S15_UPPER[S15_LAST_INDEX]

// Precomputed cubic spline for every S15 segment, evaluated as A*t^3 + B*t^2 + C*t + D over each
// normalized segment interval. Building them once at module load avoids per-call allocation.
const S15_SPLINES = S15_LOWER.map((lower, i) => spline(lower, S15_UPPER[i], [S15_A[i], S15_B[i], S15_C[i], S15_D[i]]))

// Finds the segment whose lower bound is the greatest tabulated year not exceeding `year`, using a
// binary search over the ascending S15_LOWER bounds. Years before the first or after the last
// segment clamp to the nearest segment (edge-cubic extrapolation).
function s15SegmentIndex(year: number) {
	let lo = 0
	let hi = S15_LAST_INDEX

	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1
		if (S15_LOWER[mid] <= year) lo = mid
		else hi = mid - 1
	}

	return lo
}

// Selects the precomputed S15 cubic spline segment that contains the requested decimal year.
export function s15(year: number) {
	return S15_SPLINES[s15SegmentIndex(year)]
}

// Best-estimate Delta T (TT - UT1) in seconds for any decimal calendar year. Picks the most reliable
// model per regime instead of a single all-purpose fit:
//   - year < -720:          Stephenson, Morrison and Hohenkerk 2016 long-term parabola, which is built
//                           to join the spline at its lower edge (continuous to ~38 s on a ~20000 s value).
//   - -720 <= year <= 2019: the S15 cubic spline, the modern authoritative fit to historical eclipse
//                           records and recent observations (more accurate than Espenak-Meeus for the
//                           last few decades, where Espenak-Meeus drifts ~1-1.5 s high).
//   - year > 2019:          the Espenak and Meeus 2006 expressions, which extrapolate the recent trend
//                           forward and blend into a long-term parabola beyond +2150. The S15 edge cubic
//                           is deliberately not extrapolated here because it diverges within a few years.
// A small (~1.8 s) step exists at the +2019 boundary, reflecting the switch from observation-constrained
// data to forward prediction. The result is finite and continuous-enough for any input year.
//   year: decimal calendar year, for example 2024.5 for the middle of 2024.
export function deltaT(year: number) {
	if (year < S15_MIN_YEAR) return parabolaOfStephensonMorrisonHohenkerk2016.compute(year)
	if (year > S15_MAX_YEAR) return deltaTByEspenakMeeus2006(year)
	return s15(year).compute(year)
}
