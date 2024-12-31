import sys
from astropy.time import Time
from astropy.coordinates.earth_orientation import precession_matrix_Capitaine
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.coordinates.builtin_frames import FK5, ICRS
from print import print_matrix, print_cartesian_sky_coord


def capitaine():
    a = Time('2014-10-07T12:00:00', format='isot', scale='tt')
    b = Time('2020-10-07T12:00:00', format='isot', scale='tt')
    m = precession_matrix_Capitaine(a, b)
    print_matrix(m)


def icrs():
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=ICRS())
    print_cartesian_sky_coord(c)


def fk5():
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=FK5(equinox='J2000'))
    print_cartesian_sky_coord(c)


def fk5_1975_2000():
    e = Time('1975-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=FK5(equinox=e))
    print_cartesian_sky_coord(c.transform_to(FK5(equinox='J2000')))


def fk5_2000_1975():
    e = Time('1975-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=FK5(equinox='J2000'))
    print_cartesian_sky_coord(c.transform_to(FK5(equinox=e)))


def icrs_fk5(year: str):
    e = Time(f'{year}-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=ICRS())
    print_cartesian_sky_coord(c.transform_to(FK5(equinox=e)))


def fk5_icrs(year: str):
    e = Time(f'{year}-01-01T12:00:00', format='isot', scale='tt')
    c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame=FK5(equinox=e))
    print_cartesian_sky_coord(c.transform_to(ICRS()))


args = sys.argv[1].split(':')

match args[0]:
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
