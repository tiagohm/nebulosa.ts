import sys
from astropy.time import Time
from astropy.utils import iers
from astropy.coordinates import EarthLocation
import astropy.units as u
import erfa

iers.conf.auto_download = False

iers_b = iers.IERS_B.open('data/eopc04.1962-now.txt')
iers.earth_orientation_table.set(iers_b)

default_location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')
default_time = Time('2020-10-07T12:00:00', format='isot', scale='utc')


def time(scale: str, hasLocation: bool):
    t = Time('2020-10-07T12:00:00', format='isot', scale=scale, location=default_location if hasLocation else None)
    print('expect(ut1(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.UT1, false))'.format(t.ut1.jd1, t.ut1.jd2))
    print('expect(utc(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.UTC, false))'.format(t.utc.jd1, t.utc.jd2))
    print('expect(tai(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TAI, false))'.format(t.tai.jd1, t.tai.jd2))
    print('expect(tt(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TT, false))'.format(t.tt.jd1, t.tt.jd2))
    print('expect(tcg(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TCG, false))'.format(t.tcg.jd1, t.tcg.jd2))
    print('expect(tdb(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TDB, false))'.format(t.tdb.jd1, t.tdb.jd2))
    print('expect(tcb(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TCB, false))'.format(t.tcb.jd1, t.tcb.jd2))

    if hasLocation != None:
        x, y, z = default_location.to_geocentric()
        print('X: {0:.18f} Y: {1:.18f} Z: {2:.18f}'.format(x, y, z))


def gast():
    print('GAST: {0:.18f}'.format(default_time.sidereal_time('apparent', 'tio')))


def gmst():
    print('GMST: {0:.18f}'.format(default_time.sidereal_time('mean', 'tio')))


def era():
    print('ERA: {0:.18f}'.format(default_time.earth_rotation_angle('tio')))


def lst():
    default_time.location = default_location
    print('LST (apparent): {0:.18f}'.format(default_time._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), False)))
    print('LST (mean): {0:.18f}'.format(default_time._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), False)))
    print('LST (apparent, tio): {0:.18f}'.format(default_time._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), True)))
    print('LST (mean, tio): {0:.18f}'.format(default_time._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), True)))


match sys.argv[1]:
    case 'ut1' | 'utc' | 'tai' | 'tt' | 'tcg' | 'tdb' | 'tcb':
        time(sys.argv[1], False)
    case 'ut1l' | 'utcl' | 'tail' | 'ttl' | 'tcgl' | 'tdbl' | 'tcbl':
        time(sys.argv[1][0:-1], True)
    case 'gast':
        gast()
    case 'gmst':
        gmst()
    case 'era':
        era()
    case 'lst':
        lst()
