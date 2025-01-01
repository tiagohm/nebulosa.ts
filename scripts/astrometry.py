import sys
from astropy.coordinates import SkyCoord, Distance, EarthLocation, AltAz, ICRS
from astropy.time import Time
import astropy.units as u
from print import print_cartesian_sky_coord, print_spherical_sky_coord, print_equatorial_sky_coord, print_speed_sky_coord


def star():
    t = Time('2020-10-07T12:00:00', format='isot', scale='tcb')
    # https://docs.astropy.org/en/stable/coordinates/apply_space_motion.html
    c = SkyCoord(ra=10.625*u.deg, dec=41.2*u.deg, distance=Distance(parallax=(10000) * u.mas), radial_velocity=10*u.km/u.s, pm_ra_cosdec=2*u.mas/u.yr, pm_dec=1*u.mas/u.yr, obstime=t, frame='icrs')
    print_cartesian_sky_coord(c)
    print_spherical_sky_coord(c)
    print_speed_sky_coord(c)

    c = c.apply_space_motion(new_obstime=Time('2021-10-07T12:00:00', format='isot', scale='tcb'))
    print_cartesian_sky_coord(c)
    print_spherical_sky_coord(c)
    print_speed_sky_coord(c)


def patrickWallace():
    t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
    site = EarthLocation(lon=9.712156 * u.deg, lat=52.385639 * u.deg, height=200 * u.m)
    c = SkyCoord(ra=353.22987757*u.deg, dec=52.27730247*u.deg, distance=Distance(parallax=(23) * u.mas), radial_velocity=25*u.km/u.s, pm_ra_cosdec=22.9*u.mas/u.yr, pm_dec=-2.1*u.mas/u.yr, obstime=Time('J2000'),  frame='icrs', location=site)
    print('##### ICRS epoch 2000 #####')
    print_cartesian_sky_coord(c)
    print_equatorial_sky_coord(c)
    print('##### BCRS #####')
    c = c.apply_space_motion(new_obstime=t)
    print_cartesian_sky_coord(c)
    print_equatorial_sky_coord(c)
    print('##### ASTROMETRIC ######')
    c = c.transform_to(AltAz(obstime=t, location=site))
    c = c.transform_to(ICRS)
    print_cartesian_sky_coord(c)
    print_equatorial_sky_coord(c)


args = sys.argv[1].split(':')

match args[0]:
    case 'star':
        star()
    case 'patrickWallace':
        patrickWallace()
