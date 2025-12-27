from skyfield.api import load
from skyfield.data import mpc
from skyfield.constants import GM_SUN_Pitjeva_2005_km3_s2 as GM_SUN
from skyfield.keplerlib import _KeplerOrbit
from skyfield.data.spice import inertial_frames
from skyfield.units import Distance, Velocity
from skyfield.constants import AU_KM, DAY_S
from numpy import array

GM_SUM_AU_D = GM_SUN * DAY_S * DAY_S / AU_KM / AU_KM / AU_KM

ts = load.timescale()
t = ts.tt(2025, 4, 21, 12, 0, 0)


def mpcorb():
    print('############## FROM MPCORB ##############')

    with load.open('../data/CometEls.txt') as f:
        comets = mpc.load_comets_dataframe(f)
        comets = comets.sort_values('reference').groupby('designation', as_index=False).last().set_index('designation', drop=False)

    print(comets.shape[0], 'comets loaded')

    row = comets.loc['1P/Halley']
    ceres = mpc.comet_orbit(row, ts, GM_SUN)

    print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
    print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

    pos = ceres.at(t)

    print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
    print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])


def periapsis():
    print('\n############## FROM ELEMENTS USING PERIAPSIS ##############')

    a = 17.93003431157555
    e = 0.9679221169240834
    i = 162.1951462980701
    ow = 59.07198712310091
    w = 112.2128395742619
    epoch = ts.tt_jd(2439907, 0.5)

    ceres = _KeplerOrbit._from_periapsis(a * (1 - e * e), e, i, ow, w, epoch, GM_SUN)
    ceres._rotation = inertial_frames['ECLIPJ2000'].T

    print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
    print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

    pos = ceres.at(t)

    print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
    print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])


mpcorb()
periapsis()
