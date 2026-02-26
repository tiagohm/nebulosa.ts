import type { Ellipsoid, EllipsoidParameters } from './location'

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

// Sidereal seconds per day.
export const SIDEREAL_DAYSEC = 86164.0905

// 1 sidereal second
export const ONE_SECOND = 1 / DAYSEC

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

// Period that takes the Moon to return to a similar position among the stars, in days.
export const MOON_SIDEREAL_DAYS = 27.321661

// Period between two same successive lunar phases, in days.
export const MOON_SYNODIC_DAYS = 29.53058867

// The time that elapses between two passages of the Moon at its perigee/apogee, in days.
// Librations in longitude have same periodicity too.
export const MOON_ANOMALISTIC_DAYS = 27.55455

// The period in which the Moon returns to the same node of its orbit, in days.
// Librations in latitude have same periodicity too.
export const MOON_DRACONIC_DAYS = 27.2122204

// Length of saros cycle, in days.
export const SAROS = 6585.3211

// Average apparent daily motion of the Moon, among the stars, in radians per day.
export const MOON_AVERAGE_DAILY_MOTION = TAU / MOON_SIDEREAL_DAYS

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

// 1 parsec in AU.
export const ONE_PARSEC = 206264.806245480309552772371736702884

// 1000 parsecs in AU.
export const ONE_KILOPARSEC = 1000 * ONE_PARSEC

// 1000000 parsecs in AU.
export const ONE_MEGAPARSEC = 1000000 * ONE_PARSEC

// 1000000000 parsecs in AU.
export const ONE_GIGAPARSEC = 1000000000 * ONE_PARSEC

// 1 ATM.
export const ONE_ATM = 1013.25

// Sidereal rate in arcseconds per mean solar second.
export const SIDEREAL_RATE = 1296000 / SIDEREAL_DAYSEC // 360° = 1296000 arcseconds

// Earth's angular velocity in radians per day.
export const ANGVEL_PER_DAY = DAYSEC * ANGVEL
export const EARTH_ANGULAR_VELOCITY_VECTOR = [0, 0, ANGVEL_PER_DAY] as const
export const EARTH_ANGULAR_VELOCITY_MATRIX = [0, ANGVEL_PER_DAY, 0, -ANGVEL_PER_DAY, 0, 0, 0, 0, 0] as const

// Obliquity of the Ecliptic at J2000.0.
export const OBL_J2000 = (23 + 26 / 60 + 21.41146 / 3600) * DEG2RAD

// Cosine of obliquity of the Ecliptic at J2000.
export const COS_OBL_J2000 = 0.917482132728603919223615

// Sine of obliquity of the Ecliptic at J2000.
export const SIN_OBL_J2000 = 0.397776992954309036773996

export const GM_SUN_PITJEVA_2005_KM3_S2 = 1.3271244004193938e11
export const GM_SUN_PITJEVA_2005 = (GM_SUN_PITJEVA_2005_KM3_S2 * DAYSEC * DAYSEC) / AU_KM / AU_KM / AU_KM // AU³/day²
export const MU_KM3_S2_TO_AU3_D2 = (DAYSEC * DAYSEC) / AU_KM / AU_KM / AU_KM
export const MU_AU3_D2_TO_KM3_S2 = (AU_KM * AU_KM * AU_KM) / (DAYSEC * DAYSEC)

// Heliocentric gravitational constant in meters^3 / second^2, from DE-405.
export const GS = 1.32712440017987e20

export const ICRS_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const
export const MEAN_EQUATOR_AND_EQUINOX_AT_B1950_MATRIX = [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.011178938137770135, 0.9999375133499887, -2.715792625851078e-5, -0.0048590038153592712, -2.7162594714247048e-5, 0.9999881946023742] as const
export const ECLIPTIC_B9150_MATRIX = [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.012189277138214926, 0.91736881787898283, 0.39785157220522011, -9.9405009203520217e-6, -0.3978812427417045, 0.91743692784599817] as const
export const ECLIPTIC_J2000_MATRIX = [1, 0, 0, 0, COS_OBL_J2000, SIN_OBL_J2000, 0, -SIN_OBL_J2000, COS_OBL_J2000] as const
export const FK4_MATRIX = [0.9999256809514446605, 0.011181371756303229, 0.0048589607363144413, -0.011181372206268162, 0.999937486137318374, -0.000027073328547607, -0.0048589597008613673, -0.0000272585320447865, 0.9999881948141177111] as const
export const FK5_MATRIX = [0.9999999999999928638, -0.0000001110223329741, -0.000000044118044981, 0.0000001110223372305, 0.9999999999999891831, 0.0000000964779225408, 0.0000000441180342698, -0.0000000964779274389, 0.9999999999999943728] as const
export const GALACTIC_MATRIX = [-0.0548756577126196781, -0.8734370519557791298, -0.4838350736164183803, 0.4941094371971076412, -0.4448297212220537635, 0.7469821839845094133, -0.8676661375571625615, -0.1980763372750705946, 0.4559838136911523476] as const
export const SUPERGALACTIC_MATRIX = [0.3750155557060191496, 0.3413588718572082374, 0.8618801851666388868, -0.8983204377254853439, -0.0957271002509969235, 0.4287851600069993011, 0.2288749093788964371, -0.9350456902643365859, 0.2707504994914917474] as const

export const GRS80_RADIUS = 6378137 / AU_M
export const GRS80_FLATTENING = 1 / 298.257222101

export const WGS72_RADIUS = 6378135 / AU_M
export const WGS72_FLATTENING = 1 / 298.26

export const WGS84_RADIUS = 6378137 / AU_M
export const WGS84_FLATTENING = 1 / 298.257223563

export const IERS2010_RADIUS = 6378136.6 / AU_M
export const IERS2010_FLATTENING = 1 / 298.25642

export const ELLIPSOID_PARAMETERS: Readonly<Record<Ellipsoid, EllipsoidParameters>> = {
	0: {
		radius: GRS80_RADIUS,
		flattening: GRS80_FLATTENING,
	},
	1: {
		radius: WGS72_RADIUS,
		flattening: WGS72_FLATTENING,
	},
	2: {
		radius: WGS84_RADIUS,
		flattening: WGS84_FLATTENING,
	},
	3: {
		radius: IERS2010_RADIUS,
		flattening: IERS2010_FLATTENING,
	},
}
