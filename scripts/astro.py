import sys

import astropy.units as u
import erfa
from astropy.coordinates import Distance, EarthLocation, SkyCoord
from astropy.coordinates.builtin_frames import CIRS, FK5, GCRS, ICRS, AltAz, HADec
from astropy.coordinates.earth_orientation import precession_matrix_Capitaine
from astropy.time import Time
from astropy.utils import iers

iers.conf.auto_download = False
iers.conf.iers_degraded_accuracy = 'warn'


def era():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('ERA: {0:.18f}'.format(t.earth_rotation_angle('tio')))


def gast():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GAST: {0:.18f}'.format(t.sidereal_time('apparent', 'tio')))


def gmst():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GAST: {0:.18f}'.format(t.sidereal_time('mean', 'tio')))


def iersa():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    a = iers.IERS_A.open('data/finals2000A.txt')
    dut1 = a.ut1_utc(t)
    xy = a.pm_xy(t)
    print('IERSA: DUT1: {0:.18f}, PM: {1:.18f} {2:.18f}'.format(dut1, xy[0], xy[1]))


def iersb():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    a = iers.IERS_B.open('data/eopc04.1962-now.txt')
    dut1 = a.ut1_utc(t)
    xy = a.pm_xy(t)
    print('IERSB: DUT1: {0:.18f}, PM: {1:.18f} {2:.18f}'.format(dut1, xy[0], xy[1]))


def jyear():
    t = Time(1975, format='jyear', scale='tt')
    print('YEAR: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))


def lst():
    location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc', location=location)
    print('LST (apparent): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ('ut1', 'tt'), False)))
    print('LST (mean): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ('ut1', 'tt'), False)))
    print('LST (apparent, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ('ut1', 'tt'), True)))
    print('LST (mean, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ('ut1', 'tt'), True)))


def capitaine():
    a = Time('2014-10-07T12:00:00', format='isot', scale='tt')
    b = Time('2020-10-07T12:00:00', format='isot', scale='tt')
    m = precession_matrix_Capitaine(a, b)
    print_matrix(m)


def icrs():
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=ICRS())
    print_cartesian_sky_coord(c)


def fk5():
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=FK5(equinox='J2000'))
    print_cartesian_sky_coord(c)


def fk5_1975_2000():
    e = Time('1975-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=FK5(equinox=e))
    print_cartesian_sky_coord(c.transform_to(FK5(equinox='J2000')))


def fk5_2000_1975():
    e = Time('1975-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=FK5(equinox='J2000'))
    print_cartesian_sky_coord(c.transform_to(FK5(equinox=e)))


def icrs_fk5(year: str):
    e = Time(f'{year}-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=ICRS())
    print_cartesian_sky_coord(c.transform_to(FK5(equinox=e)))


def fk5_icrs(year: str):
    e = Time(f'{year}-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625 * u.deg, dec=41.2 * u.deg, distance=Distance(1 * u.au), frame=FK5(equinox=e))
    print_cartesian_sky_coord(c.transform_to(ICRS()))


def timescale(scale: str):
    has_location = scale.endswith('l')
    scale = scale[:-1] if has_location else scale

    location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84') if has_location else None
    t = Time('2020-10-07T12:00:00', format='isot', scale=scale, location=location)

    print('UT1: {0:.0f}, {1:.18f}'.format(t.ut1.jd1, t.ut1.jd2))
    print('UTC: {0:.0f}, {1:.18f}'.format(t.utc.jd1, t.utc.jd2))
    print('TAI: {0:.0f}, {1:.18f}'.format(t.tai.jd1, t.tai.jd2))
    print('TT: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))
    print('TCG: {0:.0f}, {1:.18f}'.format(t.tcg.jd1, t.tcg.jd2))
    print('TDB: {0:.0f}, {1:.18f}'.format(t.tdb.jd1, t.tdb.jd2))
    print('TCB: {0:.0f}, {1:.18f}'.format(t.tcb.jd1, t.tcb.jd2))

    if has_location:
        x, y, z = location.to_geocentric()
        print('LOCATION: {0:.18f}, {1:.18f}, {2:.18f}'.format(x, y, z))


def icrs_star():
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    print_sky_coord(c)


def bcrs_star():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.apply_space_motion(new_obstime=t)
    print_sky_coord(c)


def gcrs_star():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.transform_to(GCRS(obstime=t))
    print_sky_coord(c)


def cirs_star():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.transform_to(CIRS(obstime=t))
    print_sky_coord(c)


def altaz_star():
    location = EarthLocation.from_geodetic('9.712156d', '52.385639d', 200 * u.m, 'WGS84')
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.transform_to(AltAz(obstime=t, location=location))
    print_sky_coord(c)


def observed_altaz_star():
    location = EarthLocation.from_geodetic('9.712156d', '52.385639d', 200 * u.m, 'WGS84')
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.transform_to(AltAz(obstime=t, location=location, pressure=1013.25 * u.mbar, temperature=15 * u.deg_C, relative_humidity=0, obswl=0.55 * u.micron))
    print_sky_coord(c)


def hadec_star():
    location = EarthLocation.from_geodetic('9.712156d', '52.385639d', 200 * u.m, 'WGS84')
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    c = SkyCoord(ra=353.22987757 * u.deg, dec=52.27730247 * u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25 * u.km / u.s, pm_ra_cosdec=22.9 * u.mas / u.yr, pm_dec=-2.1 * u.mas / u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
    c = c.transform_to(HADec(obstime=t, location=location))
    print_sky_coord(c)


# UTILS


def print_matrix(m):
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


def print_cartesian_sky_coord(c: SkyCoord):
    print('CX: {0:.18f} CY: {1:.18f}, CZ: {2:.18f}'.format(c.cartesian.x.to(u.au), c.cartesian.y.to(u.au), c.cartesian.z.to(u.au)))


def print_spherical_sky_coord(c: SkyCoord):
    print('SX: {0:.18f} SY: {1:.18f}, SZ: {2:.18f}'.format(c.spherical.lon.to(u.rad), c.spherical.lat.to(u.rad), c.spherical.distance.to(u.au)))


def print_equatorial_sky_coord(c: SkyCoord):
    print('RA: {0:.18f} DE: {1:.18f}'.format(c.spherical.lon.to(u.deg), c.spherical.lat.to(u.deg)))


def print_speed_sky_coord(c: SkyCoord):
    s = c.cartesian.differentials['s'].get_d_xyz().to(u.au / u.d)
    print('VX: {0:.18f} VY: {1:.18f}, VZ: {2:.18f}'.format(s[0], s[1], s[2]))


def print_sky_coord(c: SkyCoord):
    print_cartesian_sky_coord(c)
    print_spherical_sky_coord(c)
    print_equatorial_sky_coord(c)
    print_speed_sky_coord(c)


# MAIN


args = sys.argv[1].split(':')

match args[0]:
    case 'era':
        era()
    case 'gast':
        gast()
    case 'gmst':
        gmst()
    case 'iersa':
        iersa()
    case 'iersb':
        iersb()
    case 'jyear':
        jyear()
    case 'lst':
        lst()
    case 'capitaine':
        capitaine()
    case 'icrs':
        icrs()
    case 'fk5':
        fk5()
    case 'fk5_1975_2000':
        fk5_1975_2000()
    case 'fk5_2000_1975':
        fk5_2000_1975()
    case 'icrs_fk5':
        icrs_fk5(args[1])
    case 'fk5_icrs':
        fk5_icrs(args[1])
    case 'timescale':
        timescale(args[1])
    case 'icrs_star':
        icrs_star()
    case 'bcrs_star':
        bcrs_star()
    case 'gcrs_star':
        gcrs_star()
    case 'cirs_star':
        cirs_star()
    case 'altaz_star':
        altaz_star()
    case 'observed_altaz_star':
        observed_altaz_star()
    case 'hadec_star':
        hadec_star()
