import sys
from astropy.time import Time
from astropy.coordinates import EarthLocation
from astropy.coordinates.earth_orientation import precession_matrix_Capitaine
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.coordinates.builtin_frames import FK5

location = EarthLocation.from_geodetic('-45d', '-23d', 890 * u.m, 'WGS84')
time = Time('2020-10-07T12:00:00', format='isot', scale='utc')
time.location = location
c = SkyCoord(ra=10.625*u.degree, dec=41.2*u.degree, frame='icrs')


def print_coordinates(c: SkyCoord):
    print('X: {0:.18f} Y: {1:.18f}, Z: {2:.18f}'.format(c.cartesian.x, c.cartesian.y, c.cartesian.z))
    print('RA: {0:.18f} DEC: {1:.18f}'.format(c.ra.hour, c.dec.radian))


def capitaine():
    a = Time('2014-10-07T12:00:00', format='isot', scale='tt')
    b = Time('2020-10-07T12:00:00', format='isot', scale='tt')
    m = precession_matrix_Capitaine(a, b)
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


def fk5():
    print_coordinates(c.transform_to(FK5()))


def fk5_1975():
    t = Time('1975', format='jyear', scale='tt')
    print_coordinates(c.transform_to(FK5(equinox=t)))


match sys.argv[1]:
    case 'capitaine':
        capitaine()
    case 'fk5':
        fk5()
    case 'fk5_1975':
        fk5_1975()
