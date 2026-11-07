import { SATURNIAN_MOONS, type SaturnianBody, type SaturnianEphemeris, type SaturnianMoon } from '../ephemeris/saturnian'
import type { Time } from '../time/time'
import { type SatellitePhenomenaOptions, type SatellitePhenomenaSystem, type SatellitePhenomenon, type SatellitePhenomenonKind, satellitePhenomena } from './satellites.phenomena'
import { SATURN_MODEL } from './saturn.rings'

// The classical phenomena of Saturn's seven major satellites against the planet, seen from the geocentre: a
// moon crossing the oblate disk (transit), its shadow crossing the sunlit disk (shadow transit), a moon
// hidden behind the disk (occultation) and a moon inside Saturn's finite-Sun shadow (eclipse). The finder
// and its contact vocabulary are the generic ones of satellites.phenomena.ts over SATURN_MODEL (IAU 1-bar
// radii and pole); see that module for the contacts, grazing events and window conventions. The rings are
// not part of the geometry: a moon or a shadow seen across the rings is reported like any other, and the
// rings' own occultations and shadows are not predicted. Because the moons orbit in the ring plane, these
// phenomena happen only within a few years of Saturn's equinoxes (Iapetus, inclined, only near some of
// them). All instants are geocentric observed times in TDB.

// Kind of classical satellite phenomenon.
export type SaturnianPhenomenonKind = SatellitePhenomenonKind

// One classical phenomenon of a major Saturnian satellite.
export type SaturnianPhenomenon = SatellitePhenomenon<SaturnianMoon>

// Options of the phenomena search: the satellites (all seven by default) and the kinds.
export type SaturnianPhenomenaOptions = SatellitePhenomenaOptions<SaturnianMoon>

// Contact window of the inner moons, in days: 6 hours, longer than half of their longest phenomena (Rhea's
// central eclipse lasts about 4.5 hours).
const INNER_CONTACT_WINDOW = 0.25

// Contact window of Titan and Iapetus, in days: 12 hours. A central transit or eclipse of Iapetus, at
// ~3.3 km/s across Saturn's ~121,000 km diameter, lasts about 10.5 hours.
const OUTER_CONTACT_WINDOW = 0.5

// The Saturnian system as the phenomena finder searches it.
const SATURNIAN_PHENOMENA: SatellitePhenomenaSystem<SaturnianBody, SaturnianMoon> = {
	model: SATURN_MODEL,
	moons: SATURNIAN_MOONS,
	contactWindow: {
		mimas: INNER_CONTACT_WINDOW,
		enceladus: INNER_CONTACT_WINDOW,
		tethys: INNER_CONTACT_WINDOW,
		dione: INNER_CONTACT_WINDOW,
		rhea: INNER_CONTACT_WINDOW,
		titan: OUTER_CONTACT_WINDOW,
		iapetus: OUTER_CONTACT_WINDOW,
	},
}

// Finds the classical phenomena of Saturn's major satellites whose conjunction (`maximum`) lies in
// [start, stop), chronologically by maximum. Every position comes from `ephemeris`; wrap a source in
// interpolatedSaturnianEphemeris for speed. A kernel-backed ephemeris propagates its SaturnianEphemerisMiss
// and the search is abandoned. See satellitePhenomena for the grid, window and tolerance conventions.
export function saturnianPhenomena(ephemeris: SaturnianEphemeris, start: Time, stop: Time, options: SaturnianPhenomenaOptions = {}): SaturnianPhenomenon[] {
	return satellitePhenomena(SATURNIAN_PHENOMENA, ephemeris, start, stop, options)
}
