from astropy.time import Time

t = Time('2020-10-07T12:00:00', format='isot', scale='utc')
print('ERA: {0:.18f}'.format(t.earth_rotation_angle('tio')))
