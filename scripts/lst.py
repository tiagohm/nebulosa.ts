from astropy.time import Time
from astropy.coordinates import EarthLocation
import astropy.units as u
import erfa

location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')
t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
t.location = location
print('LST (apparent): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), False)))
print('LST (mean): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), False)))
print('LST (apparent, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gst06a, ("ut1", "tt"), True)))
print('LST (mean, tio): {0:.18f}'.format(t._sid_time_or_earth_rot_ang(-45 * u.deg, erfa.gmst06, ("ut1", "tt"), True)))
