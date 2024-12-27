import sys
from skyfield.toposlib import Geoid, iers2010, wgs84


def itrs():
    p = iers2010.latlon(34.78, -46.87, 122)
    xyz = p.itrs_xyz.au
    print('IERS2010: {0:.21f}, {1:.21f}, {2:.21f}'.format(xyz[0], xyz[1], xyz[2]))

    p = wgs84.latlon(34.78, -46.87, 122)
    xyz = p.itrs_xyz.au
    print('WGS84: {0:.21f}, {1:.21f}, {2:.21f}'.format(xyz[0], xyz[1], xyz[2]))


def polarRadius():
    r = iers2010.polar_radius.au
    print('IERS2010: {0:.21f}'.format(r))

    r = wgs84.polar_radius.au
    print('WGS84: {0:.21f}'.format(r))


match sys.argv[1]:
    case 'polarRadius':
        polarRadius()
    case 'itrs':
        itrs()
