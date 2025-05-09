from astropy.coordinates import SkyCoord, Distance
from astropy.time import Time
import astropy.units as u
from print import print_cartesian_sky_coord, print_equatorial_sky_coord, print_spherical_sky_coord, print_speed_sky_coord

c = SkyCoord(ra=353.22987757*u.deg, dec=52.27730247*u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25*u.km/u.s, pm_ra_cosdec=22.9*u.mas/u.yr, pm_dec=-2.1*u.mas/u.yr, obstime=Time('j2000', scale='tcb'), frame='icrs')
print_cartesian_sky_coord(c)
print_spherical_sky_coord(c)
print_equatorial_sky_coord(c)
print_speed_sky_coord(c)
