from astropy.time import Time

t = Time(1975, format='jyear', scale='tt')
print('YEAR: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))
t = Time('1975-01-01T12:00:00', format='isot', scale='tt')
print('ISOT: {0:.0f}, {1:.18f}'.format(t.tt.jd1, t.tt.jd2))
