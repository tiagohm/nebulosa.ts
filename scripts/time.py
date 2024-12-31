import sys
from astropy.time import Time
from astropy.utils import iers
from astropy.coordinates import EarthLocation
import astropy.units as u
import erfa

iers.conf.auto_download = False

iers_b = iers.IERS_B.open('data/eopc04.1962-now.txt')
iers.earth_orientation_table.set(iers_b)

location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')


def julian():
    t = Time(1975, format='jyear', scale='tt')
    print('YEAR: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))
    t = Time('1975-01-01T12:00:00', format='isot', scale='tt')
    print('ISOT: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))


def time(scale: str, hasLocation: bool):
    t = Time('2020-10-07T12:00:00', format='isot', scale=scale, location=location if hasLocation else None)
    print('UT1: {0:.0f}, {1:.18f}'.format(t.ut1.jd1, t.ut1.jd2))
    print('UTC: {0:.0f}, {1:.18f}'.format(t.utc.jd1, t.utc.jd2))
    print('TAI: {0:.0f}, {1:.18f}'.format(t.tai.jd1, t.tai.jd2))
    print('TT: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))
    print('TCG: {0:.0f}, {1:.18f}'.format(t.tcg.jd1, t.tcg.jd2))
    print('TDB: {0:.0f}, {1:.18f}'.format(t.tdb.jd1, t.tdb.jd2))
    print('TCB: {0:.0f}, {1:.18f}'.format(t.tcb.jd1, t.tcb.jd2))

    if hasLocation:
        x, y, z = location.to_geocentric()
        print('LOCATION: {0:.18f}, {1:.18f}, {2:.18f}'.format(x, y, z))


def gast():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GAST: {0:.18f}'.format(t.sidereal_time('apparent', 'tio')))


def gmst():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GMST: {0:.18f}'.format(t.sidereal_time('mean', 'tio')))


def era():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('ERA: {0:.18f}'.format(t.earth_rotation_angle('tio')))


def lst():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    t.location = location
    print('LST (apparent): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), False)))
    print('LST (mean): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), False)))
    print('LST (apparent, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), True)))
    print('LST (mean, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), True)))


args = sys.argv[1].split(':')

match args[0]:
    case 'julian':
        julian()
    case 'ut1' | 'utc' | 'tai' | 'tt' | 'tcg' | 'tdb' | 'tcb':
        time(args[0], len(args) >= 2 and args[1] == 'l')
    case 'gast':
        gast()
    case 'gmst':
        gmst()
    case 'era':
        era()
    case 'lst':
        lst()
