// The number π. This is the ratio of the circumference of a circle to its diameter.
export const PI = Math.PI

// The number π divided by 2.
export const PIOVERTWO = PI / 2

// The number τ. This is the ratio of the circumference of a circle to its radius.
export const TAU = PI * 2

// Reference epoch (J2000.0), Julian Date.
export const J2000 = 2451545.0

// Reference epoch (B1950.0), Julian Date.
export const B1950 = 2433282.4235

// Seconds per day.
export const DAYSEC = 86400.0

// Minutes per day.
export const DAYMIN = 1440.0

// Days per Julian year.
export const DAYSPERJY = 365.25

// Days per Julian century.
export const DAYSPERJC = 36525.0

// Days per Julian millennium.
export const DAYSPERJM = 365250.0

// Julian Date of Modified Julian Date zero.
export const MJD0 = 2400000.5

// Reference epoch (J2000.0), Modified Julian Date.
export const MJD2000 = 51544.5

// 1977 Jan 1.0 as MJD.
export const MJD1977 = 43144.0

// Length of tropical year B1900 (days).
export const DTY = 365.242198781

// TT minus TAI (s).
export const TTMINUSTAI = 32.184

// L_G = 1 - d(TT)/d(TCG).
export const ELG = 6.969290134e-10

// L_B = 1 - d(TDB)/d(TCB).
export const ELB = 1.550519768e-8

// TDB (s) at TAI 1977/1/1.0.
export const TDB0 = -6.55e-5

// Astronomical unit (m, IAU 2012).
export const AU_M = 149597870700.0

// Astronomical unit (km, IAU 2012).
export const AU_KM = AU_M / 1000.0

// Speed of light (m/s).
export const SPEED_OF_LIGHT = 299792458.0

// Light time for 1 AU in s.
export const LIGHT_TIME_AU = AU_M / SPEED_OF_LIGHT

// Schwarzschild radius of the Sun (AU).
export const SCHWARZSCHILD_RADIUS_OF_THE_SUN = 1.97412574336e-8

// Speed of light (AU per day).
export const SPEED_OF_LIGHT_AU_DAY = (SPEED_OF_LIGHT * DAYSEC) / AU_M
