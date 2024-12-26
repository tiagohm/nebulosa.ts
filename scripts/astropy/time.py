import sys
from astropy.time import Time
from astropy.utils import iers
from astropy.coordinates import EarthLocation
import astropy.units as u

iers.conf.auto_download = False

iers_b = iers.IERS_B.open('data/eopc04.1962-now.txt')
iers.earth_orientation_table.set(iers_b)

def time(scale: str, hasLocation: bool):
    location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84') if hasLocation else None
    t = Time('2020-10-07T12:00:00', format='isot', scale=scale, location=location)
    print('expect(ut1(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.UT1, false))'.format(t.ut1.jd1, t.ut1.jd2))
    print('expect(utc(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.UTC, false))'.format(t.utc.jd1, t.utc.jd2))
    print('expect(tai(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TAI, false))'.format(t.tai.jd1, t.tai.jd2))
    print('expect(tt(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TT, false))'.format(t.tt.jd1, t.tt.jd2))
    print('expect(tcg(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TCG, false))'.format(t.tcg.jd1, t.tcg.jd2))
    print('expect(tdb(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TDB, false))'.format(t.tdb.jd1, t.tdb.jd2))
    print('expect(tcb(t)).toMatchTime(time({0:.0f}, {1:.18f}, Timescale.TCB, false))'.format(t.tcb.jd1, t.tcb.jd2))

    if location != None:
        x, y, z = location.to_geocentric()
        print('X: {0:.18f} Y: {1:.18f} Z: {2:.18f}'.format(x, y, z))

def gast():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GAST: {0:.18f}'.format(t.sidereal_time('apparent', 'tio')))

def gmst():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('GMST: {0:.18f}'.format(t.sidereal_time('mean', 'tio')))

def era():
    t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
    print('ERA: {0:.18f}'.format(t.earth_rotation_angle('tio')))

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
