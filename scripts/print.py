from astropy.coordinates import SkyCoord
import astropy.units as u


def print_matrix(m):
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


def print_cartesian_sky_coord(c: SkyCoord):
    print('X: {0:.18f} Y: {1:.18f}, Z: {2:.18f}'.format(c.cartesian.x.to(u.au), c.cartesian.y.to(u.au), c.cartesian.z.to(u.au)))


def print_spherical_sky_coord(c: SkyCoord):
    print('X: {0:.18f} Y: {1:.18f}, Z: {2:.18f}'.format(c.spherical.lon.to(u.rad), c.spherical.lat.to(u.rad), c.spherical.distance.to(u.au)))
