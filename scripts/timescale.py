import sys
from astropy.time import Time
from astropy.coordinates import EarthLocation
import astropy.units as u

args = sys.argv[1].split(':')
has_location = args[0].endswith('l')
scale = args[0][:-1] if has_location else args[0]

location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')
t = Time('2020-10-07T12:00:00', format='isot', scale=scale, location=location if has_location else None)

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
