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

    with load.open('../data/MPCORB.dat') as f:
        minor_planets = mpc.load_mpcorb_dataframe(f)
        minor_planets = minor_planets.set_index('designation', drop=False)

    print(minor_planets.shape[0], 'minor planets loaded')

    row = minor_planets.loc['(1) Ceres']
    ceres = mpc.mpcorb_orbit(row, ts, GM_SUN)

    print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
    print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

    pos = ceres.at(t)

    print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
    print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])


def meanAnomaly():
    print('\n############## FROM ELEMENTS USING MEAN ANOMALY ##############')

    a = 2.769289292143484
    e = 0.07687465013145245
    i = 10.59127767086216
    ow = 80.3011901917491
    w = 73.80896808746482
    ma = 130.3159688200986
    epoch = ts.tt_jd(2458849, 0.5)

    ceres = _KeplerOrbit._from_mean_anomaly(a * (1 - e * e), e, i, ow, w, ma, epoch, GM_SUN)
    ceres._rotation = inertial_frames['ECLIPJ2000'].T

    print(ceres.position_at_epoch.au[0], ceres.position_at_epoch.au[1], ceres.position_at_epoch.au[2])
    print(ceres.velocity_at_epoch.au_per_d[0], ceres.velocity_at_epoch.au_per_d[1], ceres.velocity_at_epoch.au_per_d[2])

    pos = ceres.at(t)

    print(pos.position.au[0], pos.position.au[1], pos.position.au[2])
    print(pos.velocity.au_per_d[0], pos.velocity.au_per_d[1], pos.velocity.au_per_d[2])


def osculatingElements():
    print('\n############## PRINTING OSCULATING ELEMENTS ##############')

    # JPL Horizons, Sun (body center) [500@10] -> 4 Vesta (A807 FA), 2025-Apr-21 12:00:00.0000 TDB, x-y axes
    position = Distance(array([-1.703174722970520e00, -1.333843040283118e00, -3.086709149679688e-01]))
    velocity = Velocity(array([7.882762615954012e-03, -8.079478592200335e-03, -4.254433056153772e-03]))
    epoch = ts.tdb_jd(2460787.0)
    vesta = _KeplerOrbit(position, velocity, epoch, GM_SUM_AU_D)
    oe = vesta.elements_at_epoch
    print('apoapsis_distance', oe.apoapsis_distance.au)
    print('argument_of_latitude', oe.argument_of_latitude.radians)
    print('argument_of_periapsis', oe.argument_of_periapsis.radians)
    print('eccentric_anomaly', oe.eccentric_anomaly.radians)
    print('hvec', oe._h_vec[0], oe._h_vec[1], oe._h_vec[2])
    print('nvec', oe._n_vec[0], oe._n_vec[1], oe._n_vec[2])
    print('eccentricity_vector', oe._e_vec[0], oe._e_vec[1], oe._e_vec[2])
    print('eccentricity', oe.eccentricity)
    print('inclination', oe.inclination.radians)
    print('longitude_of_ascending_node', oe.longitude_of_ascending_node.radians)
    print('longitude_of_periapsis', oe.longitude_of_periapsis.radians)
    print('mean_anomaly', oe.mean_anomaly.radians)
    print('mean_longitude', oe.mean_longitude.radians)
    print('mean_motion_per_day', oe.mean_motion_per_day.radians)
    print('periapsis_distance', oe.periapsis_distance.au)
    print('periapsis_time', oe.periapsis_time.tdb)
    print('period_in_days', oe.period_in_days)
    print('semi_latus_rectum', oe.semi_latus_rectum.au)
    print('semi_major_axis', oe.semi_major_axis.au)
    print('semi_minor_axis', oe.semi_minor_axis.au)
    print('true_anomaly', oe.true_anomaly.radians)
    print('true_longitude', oe.true_longitude.radians)


mpcorb()
meanAnomaly()
osculatingElements()
