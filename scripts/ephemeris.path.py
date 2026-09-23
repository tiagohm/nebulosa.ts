# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "skyfield==1.55",
#   "jplephem==2.24",
#   "astropy==8.0.1",
#   "sgp4==2.27",
# ]
# ///
"""Frozen Skyfield/Astropy references for the ephemeris-path pipeline tests.

Run from anywhere:

    uv run scripts/ephemeris.path.py

Writes tests/astronomy/ephemeris/pipeline.reference.ts. Bun tests must not
invoke this script. Geometric SPK values use the repository kernels. Earth
rotation uses data/eopc04.1962-now.txt with the same column cuts as IersB.
"""

from __future__ import annotations

import hashlib
import math
from importlib.metadata import version
from pathlib import Path

import numpy as np
from astropy.coordinates import (
	CartesianDifferential,
	CartesianRepresentation,
	GCRS,
	ICRS,
	TEME,
	BarycentricMeanEcliptic,
	Galactic,
	ITRS,
	SkyCoord,
	get_body,
	get_body_barycentric_posvel,
	solar_system_ephemeris,
)
from astropy.table import Table
from astropy.time import Time
from astropy.utils import iers
from astropy.utils.iers import IERS
import astropy.units as u
from sgp4.api import Satrec, jday
from skyfield.api import EarthSatellite, PlanetaryConstants, load, wgs84
from skyfield.timelib import Timescale
from skyfield.vectorlib import VectorFunction

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
OUT = ROOT / 'tests' / 'astronomy' / 'ephemeris' / 'pipeline.reference.ts'

AU_M = 149597870700.0
AU_KM = AU_M / 1000.0
DAYSEC = 86400.0
C_AU_PER_DAY = 299792458.0 * DAYSEC / AU_M
SUN_RADIUS_KM = 695700.0
JUPITER_RADIUS_KM = 71492.0
SATURN_RADIUS_KM = 60268.0

ISS_L1 = '1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996'
ISS_L2 = '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611'

EPOCHS = {
	'E0': ('TDB', (2000, 1, 1, 12, 0, 0)),
	'E1': ('TDB', (2020, 1, 1, 0, 0, 0)),
	'E2': ('UTC', (2019, 12, 20, 11, 5, 0)),
	'E3': ('UTC', (2023, 8, 19, 12, 25, 28)),
	'E4': ('TDB', (1975, 6, 30, 12, 0, 0)),
	'E5': ('TDB', (2045, 7, 1, 0, 0, 0)),
}

OBSERVERS = {
	'O1': (-70.7313, -29.2563, 2400.0),
	'O2': (0.0, 0.0, 0.0),
	'O3': (30.0, 80.0, 100.0),
}

GEOMETRIC_CODES = {
	'emb': 3,
	'earthFromEmb': None,
	'moonFromEmb': None,
	'sun': 10,
	'marsBarycenter': 4,
	'jupiterBarycenter': 5,
	'saturnBarycenter': 6,
	'neptuneBarycenter': 8,
	'earth': 399,
	'moon': 301,
}


def sha256(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open('rb') as handle:
		for chunk in iter(lambda: handle.read(1 << 20), b''):
			digest.update(chunk)
	return digest.hexdigest()


def parse_eopc04(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
	mjds: list[float] = []
	xs: list[float] = []
	ys: list[float] = []
	dut1: list[float] = []
	for line in path.read_text(encoding='ascii', errors='replace').splitlines():
		if line.startswith('#') or len(line) < 62:
			continue
		try:
			epoch = float(line[16:26])
			x = float(line[26:38])
			y = float(line[38:50])
			du = float(line[50:62])
		except ValueError:
			continue
		mjds.append(epoch)
		xs.append(x)
		ys.append(y)
		dut1.append(du)
	return np.asarray(mjds), np.asarray(xs), np.asarray(ys), np.asarray(dut1)


def install_eop(mjd: np.ndarray, x: np.ndarray, y: np.ndarray, dut1: np.ndarray) -> Timescale:
	# build_timescale_arrays treats positive UT1-UTC jumps as leaps. eopc04 jumps
	# the other way, so that reconstruction shifts UT1 by seconds. Use Skyfield's
	# bundled leap dates instead: ΔT = 32.184 + (TAI-UTC) - (UT1-UTC).
	builtin = load.timescale(builtin=True)
	utc_jd = mjd + 2400000.5
	leap_index = np.searchsorted(builtin.leap_dates, utc_jd, side='right') - 1
	tai_minus_utc = np.asarray(builtin.leap_offsets, dtype=float)[leap_index]
	tt_minus_utc = 32.184 + tai_minus_utc
	daily_tt = utc_jd + tt_minus_utc / DAYSEC
	daily_delta_t = tt_minus_utc - dut1
	ts = Timescale((daily_tt, daily_delta_t), builtin.leap_dates, builtin.leap_offsets)
	dates = ts.utc(1858, 11, 17.0 + mjd)
	ts.polar_motion_table = (dates.tt, np.asarray(x, float), np.asarray(y, float))

	table = Table()
	table['MJD'] = mjd
	table['PM_x'] = x
	table['PM_y'] = y
	table['UT1_UTC'] = dut1
	table['dX_2000A'] = np.zeros(len(mjd))
	table['dY_2000A'] = np.zeros(len(mjd))
	table['PM_x'].unit = u.arcsec
	table['PM_y'].unit = u.arcsec
	table['UT1_UTC'].unit = u.s
	table['dX_2000A'].unit = u.arcsec
	table['dY_2000A'].unit = u.arcsec
	iers.conf.auto_download = False
	iers.conf.auto_max_age = None
	iers.earth_orientation_table.set(IERS(table))
	return ts


def sky_time(ts: Timescale, epoch: str):
	scale, ymd = EPOCHS[epoch]
	if scale == 'TDB':
		return ts.tdb(*ymd)
	return ts.utc(*ymd)


def astropy_time(epoch: str) -> Time:
	scale, (year, month, day, hour, minute, second) = EPOCHS[epoch]
	stamp = f'{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}'
	return Time(stamp, scale=scale.lower())


def vec(value) -> list[float]:
	array = np.asarray(value, dtype=float).reshape(-1)
	return [float(array[0]), float(array[1]), float(array[2])]


def unit(value) -> list[float]:
	array = np.asarray(value, dtype=float).reshape(3)
	return vec(array / np.linalg.norm(array))


def state_of(position, velocity) -> dict:
	return {'position': vec(position), 'velocity': vec(velocity)}


def sky_state(body, t) -> dict:
	sampled = body.at(t)
	return state_of(sampled.position.au, sampled.velocity.au_per_d)


def relative_state(target, origin, t) -> dict:
	sampled = (target - origin).at(t)
	return state_of(sampled.position.au, sampled.velocity.au_per_d)


def astropy_barycentric(name: str, epoch: str) -> dict:
	position, velocity = get_body_barycentric_posvel(name, astropy_time(epoch))
	# Astropy 8 returns the velocity as a CartesianRepresentation in km/day.
	pos_au = position.xyz.to_value(u.km) / AU_KM
	vel_au = velocity.xyz.to_value(u.km / u.day) / AU_KM
	return state_of(pos_au, vel_au)


class FixedBarycentric(VectorFunction):
	center = 0

	def __init__(self, position_au: np.ndarray, label: int) -> None:
		self.target = label
		self._xyz = np.asarray(position_au, dtype=float).reshape(3)

	def _at(self, t):
		shape = t.shape
		if len(shape) == 0:
			return self._xyz.copy(), np.zeros(3), None, None
		count = shape[0]
		position = np.repeat(self._xyz[:, None], count, axis=1)
		return position, np.zeros((3, count)), None, None


def observe_record(observer_at, target, t) -> dict:
	astrometric = observer_at.observe(target)
	light = float(np.reshape(astrometric.light_time, ()))
	emission = t.ts.tdb_jd(float(np.reshape(t.tdb, ())) - light)
	target_emission = target.at(emission)
	ra, dec, distance = astrometric.radec()
	right_ascension = float(ra.radians) % (2.0 * math.pi)
	return {
		'position': vec(astrometric.xyz.au),
		'distance': float(np.reshape(distance.au, ())),
		'lightTime': light,
		'emissionJd': float(np.reshape(emission.tdb, ())),
		'observerPosition': vec(observer_at.position.au),
		'observerVelocity': vec(observer_at.velocity.au_per_d),
		'targetEmissionPosition': vec(target_emission.position.au),
		'ra': right_ascension,
		'dec': float(dec.radians),
	}


def apparent_unit(astrometric, deflectors) -> list[float]:
	apparent = astrometric.apparent(deflectors=deflectors)
	return unit(apparent.xyz.au)


def place_offset(origin: np.ndarray, center: np.ndarray, separation: float, distance: float) -> np.ndarray:
	line = center - origin
	line = line / np.linalg.norm(line)
	perp = np.cross(line, np.array([0.0, 0.0, 1.0]))
	if np.linalg.norm(perp) < 1e-8:
		perp = np.cross(line, np.array([0.0, 1.0, 0.0]))
	perp = perp / np.linalg.norm(perp)
	direction = math.cos(separation) * line + math.sin(separation) * perp
	direction = direction / np.linalg.norm(direction)
	return origin + direction * distance


def deflection_case(earth, center_position: np.ndarray, separation: float, distance: float, t, deflectors, label: int) -> dict:
	origin = np.asarray(earth.at(t).position.au, dtype=float).reshape(3)
	target_position = place_offset(origin, center_position, separation, distance)
	target = FixedBarycentric(target_position, label)
	observed = earth.at(t).observe(target)
	bare = apparent_unit(observed, ())
	bent = apparent_unit(observed, deflectors)
	shift = float(np.arccos(np.clip(np.dot(bare, bent), -1.0, 1.0)))
	return {'target': vec(target_position), 'noDeflection': bare, 'apparent': bent, 'shiftRad': shift}


def angular_radius(distance_au: float, radius_km: float) -> float:
	return math.asin(min(0.999999, (radius_km / AU_KM) / distance_au))


def newton_light_time(observer: np.ndarray, position: np.ndarray, velocity: np.ndarray) -> dict:
	tau = float(np.linalg.norm(position - observer) / C_AU_PER_DAY)
	for _ in range(40):
		relative = position - velocity * tau - observer
		distance = float(np.linalg.norm(relative))
		residual = distance - C_AU_PER_DAY * tau
		slope = -float(np.dot(relative, velocity) / distance) - C_AU_PER_DAY
		step = residual / slope
		tau -= step
		if abs(step) < 1e-18:
			break
	emission = position - velocity * tau
	relative = emission - observer
	return {
		'observer': vec(observer),
		'observerVelocity': [0.0, 0.0, 0.0],
		'targetPosition': vec(position),
		'targetVelocity': vec(velocity),
		'lightTime': tau,
		'emissionPosition': vec(emission),
		'position': vec(relative),
	}


def geocentric_topos(latitude: float, longitude: float, height: float, t) -> dict:
	topos = wgs84.latlon(latitude_degrees=latitude, longitude_degrees=longitude, elevation_m=height)
	sampled = topos.at(t)
	return state_of(sampled.position.au, sampled.velocity.au_per_d)


def astropy_site(latitude: float, longitude: float, height: float, epoch: str) -> dict:
	from astropy.coordinates import EarthLocation

	location = EarthLocation.from_geodetic(longitude * u.deg, latitude * u.deg, height * u.m, ellipsoid='WGS84')
	position, velocity = location.get_gcrs_posvel(astropy_time(epoch))
	# Astropy 8 returns geocentric GCRS position in meters and velocity in m/s.
	pos_au = position.xyz.to_value(u.m) / AU_M
	vel_au = velocity.xyz.to_value(u.m / u.s) * DAYSEC / AU_M
	return state_of(pos_au, vel_au)


def sgp4_states(ts: Timescale, ymd: tuple[int, int, int, int, int, int]) -> dict:
	year, month, day, hour, minute, second = ymd
	satellite = Satrec.twoline2rv(ISS_L1, ISS_L2)
	jd, fraction = jday(year, month, day, hour, minute, second)
	error, position_km, velocity_km_s = satellite.sgp4(jd, fraction)
	if error != 0:
		raise RuntimeError(f'sgp4 error {error} at {ymd}')
	obstime = Time(f'{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}', scale='utc')
	teme = TEME(
		CartesianRepresentation(
			position_km[0] * u.km,
			position_km[1] * u.km,
			position_km[2] * u.km,
			differentials=CartesianDifferential(
				velocity_km_s[0] * u.km / u.s,
				velocity_km_s[1] * u.km / u.s,
				velocity_km_s[2] * u.km / u.s,
			),
		),
		obstime=obstime,
	)
	gcrs = teme.transform_to(GCRS(obstime=obstime))
	pos = gcrs.cartesian.xyz.to_value(u.km) / AU_KM
	# transform_to(GCRS) keeps the differential in km/s.
	vel = gcrs.velocity.d_xyz.to_value(u.km / u.s) * DAYSEC / AU_KM
	itrs = gcrs.transform_to(ITRS(obstime=obstime))
	itrs_pos = itrs.cartesian.xyz.to_value(u.km) / AU_KM
	itrs_vel = itrs.velocity.d_xyz.to_value(u.km / u.s) * DAYSEC / AU_KM
	sky = EarthSatellite(ISS_L1, ISS_L2, 'ISS', ts)
	sampled = sky.at(ts.utc(*ymd))
	return {
		'astropy': state_of(pos, vel),
		'astropyItrs': state_of(itrs_pos, itrs_vel),
		'skyfield': state_of(sampled.position.au, sampled.velocity.au_per_d),
	}


def frame_vectors(epoch: str) -> dict:
	# frameAt is a pure rotation. SkyCoord ICRS→CIRS/ITRS also applies stellar
	# aberration, about 13 arcsec for this vector, so those two axes come from ERFA.
	import erfa

	vector = np.array([0.8, -0.4, 0.3], dtype=float)
	vector /= np.linalg.norm(vector)
	coordinate = SkyCoord(ICRS(CartesianRepresentation(vector * u.dimensionless_unscaled)))
	when = astropy_time(epoch)
	galactic = coordinate.transform_to(Galactic())
	ecliptic = coordinate.transform_to(BarycentricMeanEcliptic(equinox='J2000'))
	tt = when.tt
	ut = when.ut1
	tt1, tt2 = float(tt.jd1), float(tt.jd2)
	ut1, ut2 = float(ut.jd1), float(ut.jd2)
	rc2i = erfa.c2i06a(tt1, tt2)
	px, py = iers.earth_orientation_table.get().pm_xy(when)
	rpom = erfa.pom00(float(px.to(u.rad).value), float(py.to(u.rad).value), float(erfa.sp00(tt1, tt2)))
	rc2t = erfa.c2teqx(erfa.pnm06a(tt1, tt2), float(erfa.gst06a(ut1, ut2, tt1, tt2)), rpom)
	return {
		'vector': vec(vector),
		'epoch': epoch,
		'galactic': unit(galactic.cartesian.xyz.value),
		'eclipticJ2000': unit(ecliptic.cartesian.xyz.value),
		'cirs': unit(rc2i @ vector),
		'itrs': unit(rc2t @ vector),
	}


def astropy_apparent(name: str, epoch: str) -> dict:
	body = get_body(name, astropy_time(epoch), ephemeris=str(DATA / 'de421.bsp'))
	cartesian = body.cartesian.xyz.to_value(u.AU)
	return {'direction': unit(cartesian), 'distance': float(np.linalg.norm(cartesian))}


def fmt(value) -> str:
	if isinstance(value, str):
		return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"
	if isinstance(value, bool):
		return 'true' if value else 'false'
	if isinstance(value, int) and not isinstance(value, bool):
		return str(value)
	if isinstance(value, float):
		if not math.isfinite(value):
			raise ValueError(f'non-finite reference {value}')
		return format(value, '.17g')
	if isinstance(value, dict):
		lines = ['{']
		for key, item in value.items():
			lines.append(f'\t{key}: {fmt(item)},')
		lines.append('}')
		return '\n'.join(lines)
	if isinstance(value, (list, tuple)):
		if value and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
			return '[' + ', '.join(fmt(item) for item in value) + ']'
		inner = ',\n'.join(fmt(item) for item in value)
		if not inner:
			return '[]'
		indented = '\n'.join('\t' + line for line in inner.splitlines())
		return '[\n' + indented + ',\n]'
	raise TypeError(type(value))


def write_ts(payload: dict) -> None:
	header = """// Frozen ephemeris-path references. Generated by scripts/ephemeris.path.py.
// Skyfield 1.55, jplephem 2.24, Astropy 8.0.1, and sgp4 2.27 read the repository
// kernels offline. Earth rotation uses data/eopc04.1962-now.txt. Do not edit by hand
// and do not refresh these numbers from a Nebulosa run.

"""
	body = 'export const PIPELINE_REFERENCE = ' + fmt(payload) + ' as const\n'
	OUT.write_text(header + body, encoding='utf-8', newline='\n')


def geometric_kernel(eph, ts: Timescale, epochs: list[str]) -> dict:
	result = {}
	for epoch in epochs:
		t = sky_time(ts, epoch)
		emb = eph[3]
		earth = eph[399]
		moon = eph[301]
		result[epoch] = {
			'emb': sky_state(emb, t),
			'earthFromEmb': relative_state(earth, emb, t),
			'moonFromEmb': relative_state(moon, emb, t),
			'sun': sky_state(eph[10], t),
			'marsBarycenter': sky_state(eph[4], t),
			'jupiterBarycenter': sky_state(eph[5], t),
			'saturnBarycenter': sky_state(eph[6], t),
			'neptuneBarycenter': sky_state(eph[8], t),
			'earth': sky_state(earth, t),
			'moon': sky_state(moon, t),
		}
	return result


def main() -> None:
	mjd, polar_x, polar_y, dut1 = parse_eopc04(DATA / 'eopc04.1962-now.txt')
	ts = install_eop(mjd, polar_x, polar_y, dut1)
	de421 = load(str(DATA / 'de421.bsp'))
	de440 = load(str(DATA / 'de440s.bsp'))
	solar_system_ephemeris.set(str(DATA / 'de421.bsp'))

	print('geometric DE421')
	geometric = {
		'de421': geometric_kernel(de421, ts, ['E0', 'E1', 'E4', 'E5']),
		'de440s': geometric_kernel(de440, ts, ['E1']),
	}

	print('astropy barycentric')
	astropy_bary = {}
	for epoch in ('E0', 'E1', 'E4', 'E5'):
		astropy_bary[epoch] = {
			'earth': astropy_barycentric('earth', epoch),
			'mars': astropy_barycentric('mars', epoch),
			'moon': astropy_barycentric('moon', epoch),
		}

	print('light time')
	observe = {}
	t1 = sky_time(ts, 'E1')
	earth = de421[399].at(t1)
	for name, code in (('moon', 301), ('sun', 10), ('mars', 4), ('jupiter', 5), ('neptune', 8)):
		observe[name] = observe_record(earth, de421[code], t1)

	print('topocentric and apparent')
	lon, lat, height = OBSERVERS['O1']
	site = de421[399] + wgs84.latlon(latitude_degrees=lat, longitude_degrees=lon, elevation_m=height)
	site_at = site.at(t1)
	topocentric = {}
	for name, code in (('moon', 301), ('mars', 4), ('jupiter', 5)):
		topocentric[name] = observe_record(site_at, de421[code], t1)

	apparent = {}
	for name, code in (('mars', 4), ('jupiter', 5), ('sun', 10)):
		astrometric = earth.observe(de421[code])
		apparent[name] = {
			'distance': float(np.reshape(astrometric.distance().au, ())),
			'lightTime': float(np.reshape(astrometric.light_time, ())),
			'directions': {
				'none': apparent_unit(astrometric, ()),
				'sun': apparent_unit(astrometric, (10,)),
				'sunJupiter': apparent_unit(astrometric, (10, 599)),
				'full': apparent_unit(astrometric, (10, 599, 699)),
				'jupiterThenSun': apparent_unit(astrometric, (599, 10)),
			},
		}
		ra, dec, _distance = astrometric.apparent(deflectors=()).radec()
		apparent[name]['ra'] = float(ra.radians) % (2.0 * math.pi)
		apparent[name]['dec'] = float(dec.radians)
		ra_a, dec_a, _ = astrometric.radec()
		apparent[name]['astrometricRa'] = float(ra_a.radians) % (2.0 * math.pi)
		apparent[name]['astrometricDec'] = float(dec_a.radians)

	print('deflection geometry')
	sun_pos = np.asarray(de421[10].at(t1).position.au, dtype=float).reshape(3)
	jupiter_pos = np.asarray(de421[5].at(t1).position.au, dtype=float).reshape(3)
	saturn_pos = np.asarray(de421[6].at(t1).position.au, dtype=float).reshape(3)
	earth_pos = np.asarray(earth.position.au, dtype=float).reshape(3)
	sun_distance = float(np.linalg.norm(sun_pos - earth_pos))
	jupiter_distance = float(np.linalg.norm(jupiter_pos - earth_pos))
	saturn_distance = float(np.linalg.norm(saturn_pos - earth_pos))
	sun_limb = angular_radius(sun_distance, SUN_RADIUS_KM)
	jupiter_limb = angular_radius(jupiter_distance, JUPITER_RADIUS_KM)
	saturn_limb = angular_radius(saturn_distance, SATURN_RADIUS_KM)
	far = 1.0e6
	deflection = {
		'solarLimb': deflection_case(de421[399], sun_pos, sun_limb, far, t1, (10,), 910001),
		'solar1deg': deflection_case(de421[399], sun_pos, math.radians(1.0), far, t1, (10,), 910002),
		'solar10deg': deflection_case(de421[399], sun_pos, math.radians(10.0), far, t1, (10,), 910003),
		'jupiterLimb': deflection_case(de421[399], jupiter_pos, jupiter_limb * 1.2, far, t1, (599,), 910004),
		'jupiterAway': deflection_case(de421[399], jupiter_pos, math.radians(1.0), far, t1, (599,), 910005),
		'saturnNear': deflection_case(de421[399], saturn_pos, saturn_limb * 1.2, far, t1, (699,), 910006),
		'saturnAway': deflection_case(de421[399], saturn_pos, math.radians(1.0), far, t1, (699,), 910007),
	}
	# Finite Mars at E1, Sun deflector only, is the conjunction-style finite target.
	mars_astrometric = earth.observe(de421[4])
	mars_bare = apparent_unit(mars_astrometric, ())
	mars_sun = apparent_unit(mars_astrometric, (10,))
	deflection['finiteMars'] = {
		'noDeflection': mars_bare,
		'apparent': mars_sun,
		'shiftRad': float(np.arccos(np.clip(float(np.dot(mars_bare, mars_sun)), -1.0, 1.0))),
	}

	print('earth sites')
	earth_site = {'astropy': {}, 'skyfield': {}}
	for epoch in ('E2', 'E3'):
		t = sky_time(ts, epoch)
		earth_site['astropy'][epoch] = {}
		earth_site['skyfield'][epoch] = {}
		for name, (longitude, latitude, elevation) in OBSERVERS.items():
			earth_site['astropy'][epoch][name] = astropy_site(latitude, longitude, elevation, epoch)
			earth_site['skyfield'][epoch][name] = geocentric_topos(latitude, longitude, elevation, t)

	print('sgp4')
	sgp4_cases = {
		'epoch': (2023, 8, 19, 12, 25, 28),
		'minus1d': (2023, 8, 18, 12, 25, 28),
		'plus1d': (2023, 8, 20, 12, 25, 28),
		'plus3h': (2023, 8, 19, 15, 25, 28),
	}
	sgp4_reference = {}
	for name, ymd in sgp4_cases.items():
		record = sgp4_states(ts, ymd)
		record['ymdhms'] = list(ymd)
		sgp4_reference[name] = record

	print('aristarchus')
	planets = PlanetaryConstants()
	planets.read_text(load(str(DATA / 'moon_080317.tf')))
	planets.read_text(load(str(DATA / 'pck00008.tpc')))
	planets.read_binary(load(str(DATA / 'moon_pa_de421_1900-2050.bpc')))
	frame = planets.build_frame_named('MOON_ME_DE421')
	aristarchus = de421[301] + planets.build_latlon_degrees(frame, latitude_degrees=26.3, longitude_degrees=-46.8)
	t2 = sky_time(ts, 'E2')
	surface = (aristarchus - de421[301]).at(t2)
	bary = aristarchus.at(t2)
	from_earth = (aristarchus - de421[399]).at(t2)
	ra, dec, distance = from_earth.radec()
	observed = aristarchus.at(t2).observe(de421[399])
	apparent_earth = observed.apparent(deflectors=(10, 599, 699))
	ra_app, dec_app, _ = apparent_earth.radec()
	aristarchus_reference = {
		'surface': state_of(surface.position.au, surface.velocity.au_per_d),
		'barycentric': state_of(bary.position.au, bary.velocity.au_per_d),
		'fromEarth': state_of(from_earth.position.au, from_earth.velocity.au_per_d),
		'distance': float(distance.au),
		'ra': float(ra.radians) % (2.0 * math.pi),
		'dec': float(dec.radians),
		'observeEarth': observe_record(aristarchus.at(t2), de421[399], t2),
		'apparentEarth': unit(apparent_earth.xyz.au),
		'apparentRa': float(ra_app.radians) % (2.0 * math.pi),
		'apparentDec': float(dec_app.radians),
	}

	print('moon observer')
	moon_at = de421[301].at(t1)
	moon_observer = {}
	for name, code in (('earth', 399), ('sun', 10), ('mars', 4)):
		moon_observer[name] = observe_record(moon_at, de421[code], t1)

	print('frames, analytic, astropy apparent')
	analytic = [
		newton_light_time(np.zeros(3), np.array([1.0, 0.2, -0.1]), np.zeros(3)),
		newton_light_time(np.array([0.1, -0.02, 0.0]), np.array([2.0, 0.3, 0.4]), np.array([0.01, 0.0, 0.0])),
		newton_light_time(np.array([0.1, -0.02, 0.0]), np.array([2.0, 0.3, 0.4]), np.array([-0.01, 0.0, 0.0])),
		newton_light_time(np.zeros(3), np.array([1.5, -0.4, 0.2]), np.array([0.0, 0.02, 0.0])),
		newton_light_time(np.array([0.02, 0.01, -0.01]), np.array([0.8, 0.6, 0.1]), np.array([0.015, -0.008, 0.004])),
	]
	for case, name in zip(analytic, ('stationary', 'receding', 'approaching', 'transverse', 'fast'), strict=True):
		case['name'] = name

	astropy_app = {}
	for name in ('mars', 'jupiter', 'moon'):
		astropy_app[name] = astropy_apparent(name, 'E1')

	payload = {
		'provenance': {
			'skyfield': version('skyfield'),
			'jplephem': version('jplephem'),
			'astropy': version('astropy'),
			'sgp4': version('sgp4'),
			'kernels': [
				{'name': 'de421.bsp', 'sha256': sha256(DATA / 'de421.bsp')},
				{'name': 'de440s.bsp', 'sha256': sha256(DATA / 'de440s.bsp')},
				{'name': 'eopc04.1962-now.txt', 'sha256': sha256(DATA / 'eopc04.1962-now.txt')},
				{'name': 'moon_pa_de421_1900-2050.bpc', 'sha256': sha256(DATA / 'moon_pa_de421_1900-2050.bpc')},
				{'name': 'moon_080317.tf', 'sha256': sha256(DATA / 'moon_080317.tf')},
				{'name': 'pck00008.tpc', 'sha256': sha256(DATA / 'pck00008.tpc')},
			],
		},
		'epochs': {name: {'scale': scale, 'ymdhms': list(ymd)} for name, (scale, ymd) in EPOCHS.items()},
		'observers': {
			name: {'longitudeDeg': lon, 'latitudeDeg': lat, 'heightM': height} for name, (lon, lat, height) in OBSERVERS.items()
		},
		'geometric': geometric,
		'astropyBarycentric': astropy_bary,
		'observe': observe,
		'topocentric': topocentric,
		'apparent': apparent,
		'deflection': deflection,
		'earthSite': earth_site,
		'sgp4': sgp4_reference,
		'aristarchus': aristarchus_reference,
		'moonObserver': moon_observer,
		# E1 is before the first eopc04 row the test loader keeps, so ITRS would clamp.
		'frames': frame_vectors('E3'),
		'analytic': analytic,
		'astropyApparent': astropy_app,
	}
	write_ts(payload)
	print(f'wrote {OUT}')


if __name__ == '__main__':
	main()
