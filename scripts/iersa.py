from astropy.time import Time
from astropy.utils import iers

iers.conf.auto_download = False
iers.conf.iers_degraded_accuracy = 'warn'

t = Time('2003-08-26T00:37:38.973810', format='isot', scale='utc')
a = iers.IERS_A.open('data/finals2000A.txt')
dut1 = a.ut1_utc(t)
xy = a.pm_xy(t)
print('IERSA: DUT1: {0}, PM: {1} {2}'.format(dut1, xy[0], xy[1]))
