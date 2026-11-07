import { GALILEAN_MOONS, type GalileanMoon, type JovianEphemeris } from '../ephemeris/jovian'
import type { Time } from '../time/time'
import { JUPITER_MODEL } from './jupiter.geometry'
import { type SatellitePhenomenaOptions, type SatellitePhenomenaSystem, type SatellitePhenomenon, type SatellitePhenomenonKind, satellitePhenomena } from './satellites.phenomena'

// The classical phenomena of the Galilean satellites against Jupiter, seen from the geocentre: a moon
// crossing the disk (transit), its shadow crossing the disk (shadow transit), a moon hidden behind the
// disk (occultation) and a moon inside Jupiter's shadow (eclipse). The finder and its contact vocabulary
// are the generic ones of satellites.phenomena.ts over JUPITER_MODEL; see that module for the contacts,
// grazing events and window conventions. All instants are geocentric observed times in TDB.

// Kind of classical satellite phenomenon.
export type JovianPhenomenonKind = SatellitePhenomenonKind

// One classical phenomenon of a Galilean satellite.
export type JovianPhenomenon = SatellitePhenomenon<GalileanMoon>

// Options of the phenomena search: the satellites (all four by default) and the kinds.
export type JovianPhenomenaOptions = SatellitePhenomenaOptions<GalileanMoon>

// Longest walk in days from a conjunction to find each side's first outside sample: 6 hours, longer than
// the half-duration of any Galilean phenomenon (a Callisto eclipse lasts at most ~4.7 hours).
const CONTACT_WINDOW = 0.25

// The Galilean system as the phenomena finder searches it.
const GALILEAN_PHENOMENA: SatellitePhenomenaSystem<'sun' | 'earth' | 'jupiter' | GalileanMoon, GalileanMoon> = {
	model: JUPITER_MODEL,
	moons: GALILEAN_MOONS,
	contactWindow: { io: CONTACT_WINDOW, europa: CONTACT_WINDOW, ganymede: CONTACT_WINDOW, callisto: CONTACT_WINDOW },
}

// Finds the classical phenomena of the Galilean satellites whose conjunction (`maximum`) lies in
// [start, stop), chronologically by maximum. Every position comes from `ephemeris`; wrap a source in
// interpolatedJovianEphemeris for speed. A kernel-backed ephemeris propagates its JovianEphemerisMiss and
// the search is abandoned. See satellitePhenomena for the grid, window and tolerance conventions.
export function jovianPhenomena(ephemeris: JovianEphemeris, start: Time, stop: Time, options: JovianPhenomenaOptions = {}): JovianPhenomenon[] {
	return satellitePhenomena(GALILEAN_PHENOMENA, ephemeris, start, stop, options)
}
