import type { PositionAndVelocity } from '../coordinates/astrometry'
import { observerState } from '../coordinates/correction'
import { frameToFrame, ICRS, TEME } from '../coordinates/frame'
import { type BodySurfaceLocation, bodySurfaceState } from '../observer/body'
import type { GeographicPosition } from '../observer/location'
import { type OMM, recordFromOMM, recordFromTLE, type SatRec, sgp4, type TLE } from '../orbits/propagation/sgp4'
import { Naif } from './kernels/naif'
import type { Spk } from './kernels/spk'
import { customEphemerisEndpoint, type EphemerisEndpoint, type EphemerisPath, ephemerisPath, naifEphemerisEndpoint } from './path'

// Adapters from prepared SPK segments, SGP4 propagation, and surface geometry
// into synchronous AU/AU-day ephemeris paths in library-base ICRS/BCRS-oriented
// axes. SPK lookup and initialization remain asynchronous preparation only.

// Geocentric zero state for extracting the site offset from observerState.
const ZERO_EARTH_STATE: PositionAndVelocity = [
	[0, 0, 0],
	[0, 0, 0],
]

// Resolves and initializes an SPK segment before returning its synchronous path.
// Returns undefined when the kernel has no center-to-target segment; local
// coefficient cache misses can still perform synchronous I/O during evaluation.
export async function spkEphemerisPath(spk: Spk, center: number, target: number): Promise<EphemerisPath | undefined> {
	const segment = await spk.segment(center, target)
	return segment ? ephemerisPath(naifEphemerisEndpoint(center), naifEphemerisEndpoint(target), segment.at.bind(segment)) : undefined
}

// Converts SGP4's Earth-centered TEME AU/AU-day state into library-base axes.
// TLE/OMM elements are prepared once at construction for repeated evaluation.
// The default target is the stable NORAD catalog identifier from the source;
// callers may supply a distinct endpoint when catalog identity is unavailable.
export function sgp4EphemerisPath(source: TLE | OMM | SatRec, target?: EphemerisEndpoint): EphemerisPath {
	const record = 'satnum' in source ? source : 'EPOCH' in source ? recordFromOMM(source) : recordFromTLE(source)
	const endpoint = target ?? customEphemerisEndpoint(`norad:${record.satnum}`)
	return ephemerisPath(naifEphemerisEndpoint(Naif.EARTH), endpoint, (time) => frameToFrame(sgp4(time, record), TEME, ICRS, time))
}

// Creates an Earth-center-to-site path using observerState's ITRS-to-GCRS
// position and diurnal velocity, in AU and AU/day. The target identifies the site.
export function earthObserverEphemerisPath(location: GeographicPosition, target: EphemerisEndpoint): EphemerisPath {
	return ephemerisPath(naifEphemerisEndpoint(Naif.EARTH), target, (time) => {
		const [position, velocity] = observerState(time, ZERO_EARTH_STATE, location)
		return [
			[position[0], position[1], position[2]],
			[velocity[0], velocity[1], velocity[2]],
		]
	})
}

// Creates a body-center-to-surface-site path in library-base axes. The
// bodySurfaceState provider includes the body's rotational velocity; the caller
// supplies body center and site identities for later composition.
export function bodySurfaceEphemerisPath(body: EphemerisEndpoint, target: EphemerisEndpoint, location: BodySurfaceLocation): EphemerisPath {
	return ephemerisPath(body, target, (time) => bodySurfaceState(location, time))
}
