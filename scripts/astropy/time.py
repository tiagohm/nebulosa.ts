from astropy.time import Time
from astropy.utils import iers

iers.conf.auto_download = False

iers_b = iers.IERS_B.open('data/eopc04.1962-now.txt')
iers.earth_orientation_table.set(iers_b)

def time(scale):
    t = Time('2020-10-07T12:00:00', format='isot', scale=scale)
    print('expect(ut1(time)).toMatchTime([{0}, {1:.18f}, Timescale.UT1])'.format(t.ut1.jd1, t.ut1.jd2))
    print('expect(utc(time)).toMatchTime([{0}, {1:.18f}, Timescale.UTC])'.format(t.utc.jd1, t.utc.jd2))
    print('expect(tai(time)).toMatchTime([{0}, {1:.18f}, Timescale.TAI])'.format(t.tai.jd1, t.tai.jd2))
    print('expect(tt(time)).toMatchTime([{0}, {1:.18f}, Timescale.TT])'.format(t.tt.jd1, t.tt.jd2))
    print('expect(tcg(time)).toMatchTime([{0}, {1:.18f}, Timescale.TCG])'.format(t.tcg.jd1, t.tcg.jd2))
    print('expect(tdb(time)).toMatchTime([{0}, {1:.18f}, Timescale.TDB])'.format(t.tdb.jd1, t.tdb.jd2))
    print('expect(tcb(time)).toMatchTime([{0}, {1:.18f}, Timescale.TCB])'.format(t.tcb.jd1, t.tcb.jd2))

time('utc')
