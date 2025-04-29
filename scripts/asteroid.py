from skyfield.api import load
from skyfield.data import mpc
from skyfield.constants import GM_SUN_Pitjeva_2005_km3_s2 as GM_SUN
from skyfield.keplerlib import _KeplerOrbit

with load.open('data/MPCORB.dat') as f:
    minor_planets = mpc.load_mpcorb_dataframe(f)
    minor_planets = minor_planets.set_index('designation', drop=False)

print(minor_planets.shape[0], 'minor planets loaded')

ts = load.timescale()

print('############## MPCORB ##############')

row = minor_planets.loc['(1) Ceres']
ceres = mpc.mpcorb_orbit(row, ts, GM_SUN)

print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

t = ts.tt(2025, 4, 21, 12, 0, 0)
pos = ceres.at(t)

print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])

print('############## ORBITAL ELEMENTS ##############')

a = 2.769289292143484
e = 0.07687465013145245
i = 10.59127767086216
ow = 80.3011901917491
w = 73.80896808746482
ma = 130.3159688200986
epoch = ts.tt_jd(2458849.5)

ceres = _KeplerOrbit._from_mean_anomaly(a * (1 - e * e), e, i, ow, w, ma, epoch, GM_SUN)

print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

pos = ceres.at(t)

print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])
