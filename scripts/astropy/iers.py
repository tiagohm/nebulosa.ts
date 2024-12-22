from astropy.time import Time
from astropy.utils import iers

# https://docs.astropy.org/en/stable/utils/iers.html
# https://docs.astropy.org/en/stable/api/astropy.utils.iers.IERS.html

iers.conf.auto_download = False
iers.conf.iers_degraded_accuracy = 'warn'

t = Time('2020-10-07T12:34:56', format='isot', scale='utc')

iers_a = iers.IERS_A.open('data/finals2000A.txt')
dut1 = iers_a.ut1_utc(t)
xy = iers_a.pm_xy(t)
print('IERSA: DUT1: {0}, PM: {1} {2}'.format(dut1, xy[0], xy[1]))

iers_b = iers.IERS_B.open('data/eopc04.1962-now.txt')
dut1 = iers_b.ut1_utc(t)
xy = iers_b.pm_xy(t)
print('IERSB: DUT1: {0}, PM: {1} {2}'.format(dut1, xy[0], xy[1]))
