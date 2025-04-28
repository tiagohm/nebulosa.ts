// The number π. This is the ratio of the circumference of a circle to its diameter.
export const PI = Math.PI

// The number π divided by 2.
export const PIOVERTWO = PI / 2

// The number τ. This is the ratio of the circumference of a circle to its radius.
export const TAU = PI * 2

// Reference epoch (J2000.0), Julian Date.
export const J2000 = 2451545

// Reference epoch (B1900.0), Julian Date.
export const B1900 = 2415020.3135

// Reference epoch (B1950.0), Julian Date.
export const B1950 = 2433282.4235

// Seconds per day.
export const DAYSEC = 86400

// Minutes per day.
export const DAYMIN = 1440

// Days per Julian year.
export const DAYSPERJY = 365.25

// Days per Julian century.
export const DAYSPERJC = 36525

// Days per Julian millennium.
export const DAYSPERJM = 365250

// Julian Date of Modified Julian Date zero.
export const MJD0 = 2400000.5

// Reference epoch (J2000.0), Modified Julian Date.
export const MJD2000 = 51544.5

// 1977 Jan 1.0 as MJD.
export const MJD1977 = 43144

// Length of tropical year B1900 (days).
export const DAYSPERTY = 365.242198781

// TT minus TAI (s).
export const TTMINUSTAI = 32.184

// L_G = 1 - d(TT)/d(TCG).
export const ELG = 6.969290134e-10

// L_B = 1 - d(TDB)/d(TCB).
export const ELB = 1.550519768e-8

// TDB (s) at TAI 1977/1/1.0.
export const TDB0 = -6.55e-5

// Astronomical unit (m, IAU 2012).
export const AU_M = 149597870700

// Astronomical unit (km, IAU 2012).
export const AU_KM = AU_M / 1000

// Speed of light (m/s).
export const SPEED_OF_LIGHT = 299792458

// Light time for 1 AU in s.
export const LIGHT_TIME_AU = AU_M / SPEED_OF_LIGHT

// Schwarzschild radius of the Sun (AU).
// 2 * 1.32712440041e20 / (2.99792458e8)^2 / 1.49597870700e11
export const SCHWARZSCHILD_RADIUS_OF_THE_SUN = 1.974125743363687131156424e-8

// Speed of light (AU per day).
export const SPEED_OF_LIGHT_AU_DAY = (SPEED_OF_LIGHT * DAYSEC) / AU_M

// Radians to degrees.
export const RAD2DEG = 180 / PI

// Degrees to radians.
export const DEG2RAD = PI / 180

// Arcminutes to radians.
export const AMIN2RAD = PI / 180 / 60

// Arcsecconds to radians.
export const ASEC2RAD = PI / 180 / 3600

// Milliarcsecconds to radians.
export const MILLIASEC2RAD = PI / 180 / 3600000

// Angular velocity in radians/s.
export const ANGVEL = 7.292115e-5

// Arcseconds in a full circle.
export const TURNAS = 1296000

export const OBL_J2000 = 23.43928030555555555555555555555556 * DEG2RAD //  23d 26m 21.4091s
export const COS_OBL = 0.91748213708696252157561611593023
export const SIN_OBL = 0.39777698290165069671031615737433

export const GM_SUN_PITJEVA_2005_KM3_S2 = 1.3271244004193938e11
export const GM_SUN_PITJEVA_2005 = (GM_SUN_PITJEVA_2005_KM3_S2 * DAYSEC * DAYSEC) / AU_KM / AU_KM / AU_KM // AU³/day²
export const MU_KM3_S2_TO_AU3_D2 = (DAYSEC * DAYSEC) / AU_KM / AU_KM / AU_KM
export const MU_AU3_D2_TO_KM3_S2 = (AU_KM * AU_KM * AU_KM) / (DAYSEC * DAYSEC)

// Heliocentric gravitational constant in meters^3 / second^2, from DE-405.
export const GS = 1.32712440017987e20
