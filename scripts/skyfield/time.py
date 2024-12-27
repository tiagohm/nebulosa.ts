import sys
from skyfield.api import load

ts = load.timescale()
t = ts.utc(2020, 10, 7, 12, 0, 0)


def meanObliquity():
    print('{0:.18f}'.format(t._mean_obliquity_radians))


def nutation():
    angles = t._nutation_angles_radians
    print('{0:.18f}, {1:.18f}'.format(angles[0], angles[1]))


def precession():
    m = t.precession_matrix()
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


def precessionNutation():
    m = t.M
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


def equationOfOrigins():
    m = t.C
    print('{0:.18f}, {1:.18f}, {2:.18f}, {3:.18f}, {4:.18f}, {5:.18f}, {6:.18f}, {7:.18f}, {8:.18f}'.format(m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2], m[2, 0], m[2, 1], m[2, 2]))


match sys.argv[1]:
    case 'meanObliquity':
        meanObliquity()
    case 'nutation':
        nutation()
    case 'precession':
        precession()
    case 'precessionNutation':
        precessionNutation()
    case 'equationOfOrigins':
        equationOfOrigins()
