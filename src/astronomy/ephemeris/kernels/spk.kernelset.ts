import type { MutVec3 } from '../../../math/linear-algebra/vec3'
import type { PositionAndVelocity } from '../../coordinates/astrometry'
import type { Time } from '../../time/time'
import type { Daf } from './daf'
import { makeSpkSegment, type SpkSegment, spkSeconds } from './spk'
import type { SpkSegmentDescriptor, SpkUnsupportedReason } from './spk.inspect'

// Multi-file SPK resolution. Combines the segments of several SPK files, loaded in a caller-defined
// order, into one immutable set that answers the barycentric state of a NAIF body at an epoch by
// chaining segments from the body through its centers down to the solar-system barycenter (NAIF 0).
// Segment selection follows the NAIF SPK precedence rules: for a body at an epoch, the segment taken is
// the covering one latest in load order, files after files and, within a file, later segments after
// earlier ones, whatever its center. A selected segment the readers cannot evaluate makes the body
// unavailable at that epoch instead of falling back to a lower-precedence segment, so the result never
// differs from what the NAIF toolkit would select. Positions are AU and velocities AU/day in the J2000
// (ICRS) axes; epochs of any time scale are converted to TDB.

// NAIF code of the solar-system barycenter, the root of every chain.
const SOLAR_SYSTEM_BARYCENTER = 0
// Longest center chain followed before it is declared cyclic. Real chains have at most four links
// (barycenter, planet system, planet, satellite or spacecraft).
const MAXIMUM_CHAIN_LENGTH = 16

// One SPK file of a kernel set: its identifier, its parsed DAF, and its inspected segment descriptors,
// whose `index` refers to `daf.summaries`.
export interface SpkKernelEntry {
	// Caller identifier of the file, reported in results.
	readonly id: string
	// Parsed DAF of the file. Its source must stay open and support synchronous reads while the set is used.
	readonly daf: Daf
	// Segment descriptors of the file, in file order, as listed by inspectSpk.
	readonly segments: readonly SpkSegmentDescriptor[]
}

// Why a body state cannot be resolved at an epoch:
// - missing: no segment of any file has the body as target;
// - coverage: segments exist but none covers the epoch, in a gap or outside their spans;
// - dataType or frame: the selected segment is not evaluable;
// - cycle: the center chain does not reach the barycenter within MAXIMUM_CHAIN_LENGTH links.
export type SpkMissReason = 'missing' | 'coverage' | 'cycle' | SpkUnsupportedReason

// A resolved barycentric state.
export interface SpkResolvedState {
	readonly ok: true
	// Barycentric position (AU) and velocity (AU/day) in J2000 axes, owned by the caller.
	readonly state: PositionAndVelocity
	// Identifiers of the files whose segments formed the chain, from the body to the barycenter, without repetition.
	readonly kernels: readonly string[]
}

// An unresolved state: the reason and the body of the chain where resolution stopped, which is the
// requested body or one of its centers.
export interface SpkMiss {
	readonly ok: false
	// Why resolution stopped.
	readonly reason: SpkMissReason
	// NAIF code of the body whose segment was missing, uncovered, or unsupported.
	readonly body: number
}

// Outcome of resolving a state.
export type SpkStateResult = SpkResolvedState | SpkMiss

// An immutable set of SPK files prepared for synchronous evaluation.
export interface SpkKernelSet {
	// Identifiers of the files in load order, lowest precedence first.
	readonly kernels: readonly string[]
	// NAIF codes of every body that is the target of at least one segment, evaluable or not.
	readonly bodies: ReadonlySet<number>
	// Resolves the barycentric state of `body` at `time` (any time scale). Synchronous: segment records
	// not yet cached are read from the DAF sources with synchronous reads.
	readonly stateAt: (body: number, time: Time) => SpkStateResult
}

// One candidate segment for a body: its file, its descriptor, and its reader when evaluable.
interface Candidate {
	// Identifier of the file.
	readonly kernel: string
	// Descriptor of the segment.
	readonly descriptor: SpkSegmentDescriptor
	// Initialized reader, absent for an unsupported segment.
	readonly segment?: SpkSegment
}

// Prepares a kernel set from `entries` in load order, lowest precedence first (the NAIF toolkit gives
// precedence to the file loaded last). Instantiates and initializes the reader of every supported
// segment, reading one file at a time because the segments of one file share its DAF source cursor.
// Rejects when a file cannot be read; the caller owns and closes the sources.
export async function prepareSpkKernelSet(entries: readonly SpkKernelEntry[]): Promise<SpkKernelSet> {
	const candidates = new Map<number, Candidate[]>()

	for (const entry of entries) {
		for (const descriptor of entry.segments) {
			const segment = descriptor.supported ? makeSpkSegment(entry.daf.summaries[descriptor.index], entry.daf) : undefined
			await segment?.initialize()
			let list = candidates.get(descriptor.target)

			if (!list) {
				list = []
				candidates.set(descriptor.target, list)
			}

			list.push({ kernel: entry.id, descriptor, segment })
		}
	}

	// Highest precedence first, so selection stops at the first covering candidate.
	for (const list of candidates.values()) list.reverse()

	return { kernels: entries.map((e) => e.id), bodies: new Set(candidates.keys()), stateAt: (body, time) => resolveState(candidates, body, time) }
}

// Resolves the barycentric state of `body` by following the selected segment of each body of the chain.
function resolveState(candidates: ReadonlyMap<number, readonly Candidate[]>, body: number, time: Time): SpkStateResult {
	const seconds = spkSeconds(time)
	const position: MutVec3 = [0, 0, 0]
	const velocity: MutVec3 = [0, 0, 0]
	const kernels: string[] = []

	for (let link = 0; body !== SOLAR_SYSTEM_BARYCENTER; link++) {
		if (link >= MAXIMUM_CHAIN_LENGTH) return { ok: false, reason: 'cycle', body }

		const list = candidates.get(body)
		if (!list) return { ok: false, reason: 'missing', body }

		const selected = list.find((e) => seconds >= e.descriptor.start && seconds <= e.descriptor.end)
		if (!selected) return { ok: false, reason: 'coverage', body }
		if (!selected.segment) return { ok: false, reason: selected.descriptor.reason!, body }

		const [p, v] = selected.segment.at(time)
		position[0] += p[0]
		position[1] += p[1]
		position[2] += p[2]
		velocity[0] += v[0]
		velocity[1] += v[1]
		velocity[2] += v[2]

		if (!kernels.includes(selected.kernel)) kernels.push(selected.kernel)

		body = selected.descriptor.center
	}

	return { ok: true, state: [position, velocity], kernels }
}
