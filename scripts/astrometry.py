import sys
from astropy.coordinates import SkyCoord, Distance
from astropy.time import Time
import astropy.units as u
from print import print_cartesian_sky_coord, print_spherical_sky_coord


def star():
    t = Time('2020-10-07T12:00:00', format='isot', scale='tcb')
    # https://docs.astropy.org/en/stable/coordinates/apply_space_motion.html
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, distance=Distance(parallax=(10000) * u.mas), radial_velocity=10*u.km/u.s, pm_ra_cosdec=2*u.mas/u.yr, pm_dec=1*u.mas/u.yr, obstime=t, frame='icrs')
    print_cartesian_sky_coord(c)
    print_spherical_sky_coord(c)

    c = c.apply_space_motion(new_obstime=Time('2021-10-07T12:00:00', format='isot', scale='tcb'))
    print_cartesian_sky_coord(c)
    print_spherical_sky_coord(c)


args = sys.argv[1].split(':')

match args[0]:
    case 'star':
        star()
