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
// earlier ones, whatever its center. A caller may prefer one file for a body: where a segment of that
// file for the body covers the epoch, it is taken ahead of the load order, and elsewhere the load order
// applies, so a preference never opens a gap. A selected segment the readers cannot evaluate makes the
// body unavailable at that epoch instead of falling back to a lower-precedence segment, so without
// preferences the result never differs from what the NAIF toolkit would select. The set also reports
// how it selects: the chain of segments behind a state, the candidates of a body in selection order,
// and the effective coverage of a body, which tells where each segment is selected and which ones are
// never used. Positions are AU and velocities AU/day in the J2000 (ICRS) axes; epochs of any time scale
// are converted to TDB, and coverage bounds are TDB seconds past J2000.

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

// Options of a kernel set.
export interface SpkKernelSetOptions {
	// Preferred file of a body, by NAIF code and file identifier: where a segment of that file for the body covers an
	// epoch, it is selected ahead of the load order. A preference for a file that is not in the set, or that has no
	// segment for the body, changes nothing.
	readonly preferences?: ReadonlyMap<number, string>
}

// One segment of a body in a kernel set: its file, its descriptor, and whether it is taken ahead of the load order
// because its file is the preferred one of the body.
export interface SpkCandidate {
	// Identifier of the file.
	readonly kernel: string
	// Descriptor of the segment; `index` refers to the summaries of the file.
	readonly descriptor: SpkSegmentDescriptor
	// Whether its file is the preferred one of the body.
	readonly preferred: boolean
}

// One link of a resolved chain: the segment selected for `body` at the epoch, relative to `center`.
export interface SpkChainLink {
	// NAIF code of the target of the segment.
	readonly body: number
	// NAIF code of the center of the segment, the body of the next link.
	readonly center: number
	// Identifier of the file of the segment.
	readonly kernel: string
	// Index of the segment in the summaries of its file.
	readonly segment: number
	// Whether it was selected because its file is the preferred one of the body.
	readonly preferred: boolean
}

// A resolved barycentric state.
export interface SpkResolvedState {
	readonly ok: true
	// Barycentric position (AU) and velocity (AU/day) in J2000 axes, owned by the caller.
	readonly state: PositionAndVelocity
	// Identifiers of the files whose segments formed the chain, from the body to the barycenter, without repetition.
	readonly kernels: readonly string[]
	// Segments that formed the chain, from the body to the barycenter; empty for the barycenter itself.
	readonly chain: readonly SpkChainLink[]
}

// An unresolved state: the reason and the body of the chain where resolution stopped, which is the
// requested body or one of its centers.
export interface SpkMiss {
	readonly ok: false
	// Why resolution stopped.
	readonly reason: SpkMissReason
	// NAIF code of the body whose segment was missing, uncovered, or unsupported.
	readonly body: number
	// For an unsupported selected segment (dataType or frame), its file and its index in the summaries of the file.
	readonly kernel?: string
	readonly segment?: number
}

// Outcome of resolving a state.
export type SpkStateResult = SpkResolvedState | SpkMiss

// A state of one segment relative to its own center.
export interface SpkSegmentState {
	readonly ok: true
	// Position (AU) and velocity (AU/day) of the target relative to the center of the segment, in J2000 axes, owned by
	// the caller.
	readonly state: PositionAndVelocity
	// NAIF codes of the target and the center of the segment.
	readonly target: number
	readonly center: number
}

// Why one segment cannot be evaluated at an epoch: no such file or segment (missing), an epoch outside its coverage,
// or a data type or frame the readers cannot evaluate.
export interface SpkSegmentMiss {
	readonly ok: false
	readonly reason: 'missing' | 'coverage' | SpkUnsupportedReason
}

// Outcome of evaluating one segment.
export type SpkSegmentStateResult = SpkSegmentState | SpkSegmentMiss

// One interval of the effective coverage of a body: from `start` to `end`, TDB seconds past J2000, the segment
// selected for the body is `segment` of `kernel`. At an instant shared by two adjacent intervals, the segment of
// higher precedence is selected, as at any instant two segments cover.
export interface SpkCoverageInterval {
	// Bounds, in TDB seconds past J2000, inclusive; `end` is never before `start`.
	readonly start: number
	readonly end: number
	// Identifier of the file of the selected segment.
	readonly kernel: string
	// Index of the selected segment in the summaries of its file.
	readonly segment: number
	// Whether it is selected because its file is the preferred one of the body.
	readonly preferred: boolean
	// Whether the readers can evaluate it; an unsupported selected segment makes the body unavailable there.
	readonly supported: boolean
}

// An immutable set of SPK files prepared for synchronous evaluation.
export interface SpkKernelSet {
	// Identifiers of the files in load order, lowest precedence first.
	readonly kernels: readonly string[]
	// NAIF codes of every body that is the target of at least one segment, evaluable or not.
	readonly bodies: ReadonlySet<number>
	// Resolves the barycentric state of `body` at `time` (any time scale). Synchronous: segment records
	// not yet cached are read from the DAF sources with synchronous reads.
	readonly stateAt: (body: number, time: Time) => SpkStateResult
	// Preferred file of each body with a preference that applies, by NAIF code.
	readonly preferences: ReadonlyMap<number, string>
	// Segments of `body` in selection order: the segments of its preferred file first, then every other in load order,
	// the highest precedence first. Empty for a body no file has. A new array on each call.
	readonly candidates: (body: number) => SpkCandidate[]
	// Effective coverage of `body`: the disjoint intervals, by increasing time, where some segment of the body covers the
	// epoch, each with the segment selected there; adjacent intervals with the same segment are merged. A candidate in
	// no interval is never selected. Empty for a body no file has. Says nothing of the centers of the body.
	readonly coverage: (body: number) => SpkCoverageInterval[]
	// Evaluates the segment `segment` (its index in the summaries of the file) of the file `kernel` at `time`, relative
	// to its own center, whatever segment the selection would take. Synchronous, like stateAt.
	readonly segmentStateAt: (kernel: string, segment: number, time: Time) => SpkSegmentStateResult
}

// One candidate segment for a body: its file, its descriptor, whether its file is preferred, and its reader when evaluable.
interface Candidate extends SpkCandidate {
	// Initialized reader, absent for an unsupported segment.
	readonly segment?: SpkSegment
}

// Prepares a kernel set from `entries` in load order, lowest precedence first (the NAIF toolkit gives
// precedence to the file loaded last), with the preferred file of some bodies in `options`. Instantiates
// and initializes the reader of every supported segment, reading one file at a time because the
// segments of one file share its DAF source cursor. Rejects when a file cannot be read; the caller owns
// and closes the sources.
export async function prepareSpkKernelSet(entries: readonly SpkKernelEntry[], options?: SpkKernelSetOptions): Promise<SpkKernelSet> {
	const candidates = new Map<number, Candidate[]>()
	const segments = new Map<string, Candidate>()
	const preferences = new Map<number, string>()

	for (const entry of entries) {
		for (const descriptor of entry.segments) {
			const segment = descriptor.supported ? makeSpkSegment(entry.daf.summaries[descriptor.index], entry.daf) : undefined
			await segment?.initialize()
			let list = candidates.get(descriptor.target)

			if (!list) {
				list = []
				candidates.set(descriptor.target, list)
			}

			const preferred = options?.preferences?.get(descriptor.target) === entry.id
			const candidate: Candidate = { kernel: entry.id, descriptor, preferred, segment }
			list.push(candidate)
			segments.set(segmentKey(entry.id, descriptor.index), candidate)
			if (preferred) preferences.set(descriptor.target, entry.id)
		}
	}

	// Highest precedence first, so selection stops at the first covering candidate; the segments of the preferred file
	// of a body come before every other, keeping their own order. The sort is stable.
	for (const list of candidates.values()) {
		list.reverse()
		list.sort((a, b) => Number(b.preferred) - Number(a.preferred))
	}

	return {
		kernels: entries.map((e) => e.id),
		bodies: new Set(candidates.keys()),
		preferences,
		stateAt: (body, time) => resolveState(candidates, body, time),
		candidates: (body) => (candidates.get(body) ?? []).map(({ kernel, descriptor, preferred }) => ({ kernel, descriptor, preferred })),
		coverage: (body) => effectiveCoverage(candidates.get(body) ?? []),
		segmentStateAt: (kernel, segment, time) => evaluateSegment(segments.get(segmentKey(kernel, segment)), time),
	}
}

// Key of a segment in a set: its file and its index in the summaries of the file.
function segmentKey(kernel: string, segment: number) {
	return `${segment}:${kernel}`
}

// Selects, among `list` in selection order, the first segment covering `seconds` (TDB seconds past J2000).
function select(list: readonly Candidate[], seconds: number) {
	return list.find((e) => seconds >= e.descriptor.start && seconds <= e.descriptor.end)
}

// Evaluates one segment at time relative to its center.
function evaluateSegment(candidate: Candidate | undefined, time: Time): SpkSegmentStateResult {
	if (!candidate) return { ok: false, reason: 'missing' }

	const { descriptor, segment } = candidate
	const seconds = spkSeconds(time)
	if (seconds < descriptor.start || seconds > descriptor.end) return { ok: false, reason: 'coverage' }
	if (!segment) return { ok: false, reason: descriptor.reason! }

	const [p, v] = segment.at(time)
	return {
		ok: true,
		state: [
			[p[0], p[1], p[2]],
			[v[0], v[1], v[2]],
		],
		target: descriptor.target,
		center: descriptor.center,
	}
}

// Effective coverage of the candidates of one body in selection order. Every bound of every segment splits the time
// line; the segment selected inside each piece, and at each bound, is the first covering one, and consecutive pieces
// with the same segment are merged. A bound is kept as an interval of its own only when the segment selected there is
// selected by neither neighbouring piece, as for a segment whose coverage is a single instant.
function effectiveCoverage(list: readonly Candidate[]): SpkCoverageInterval[] {
	const bounds = [...new Set(list.flatMap((e) => [e.descriptor.start, e.descriptor.end]))].sort((a, b) => a - b)
	const intervals: SpkCoverageInterval[] = []

	function push(start: number, end: number, candidate: Candidate | undefined) {
		if (!candidate) return

		const last = intervals.at(-1)

		if (last && last.kernel === candidate.kernel && last.segment === candidate.descriptor.index && last.end >= start) {
			intervals[intervals.length - 1] = { ...last, end: Math.max(last.end, end) }
		} else {
			intervals.push({ start, end, kernel: candidate.kernel, segment: candidate.descriptor.index, preferred: candidate.preferred, supported: candidate.descriptor.supported })
		}
	}

	for (let i = 0; i < bounds.length; i++) {
		const bound = bounds[i]
		const atBound = select(list, bound)
		const before = i > 0 ? select(list, (bounds[i - 1] + bound) / 2) : undefined
		const after = i < bounds.length - 1 ? select(list, (bound + bounds[i + 1]) / 2) : undefined

		if (atBound && atBound !== before && atBound !== after) push(bound, bound, atBound)
		if (after) push(bound, bounds[i + 1], after)
	}

	return intervals
}

// Resolves the barycentric state of `body` by following the selected segment of each body of the chain.
function resolveState(candidates: ReadonlyMap<number, readonly Candidate[]>, body: number, time: Time): SpkStateResult {
	const seconds = spkSeconds(time)
	const position: MutVec3 = [0, 0, 0]
	const velocity: MutVec3 = [0, 0, 0]
	const kernels: string[] = []
	const chain: SpkChainLink[] = []

	for (let link = 0; body !== SOLAR_SYSTEM_BARYCENTER; link++) {
		if (link >= MAXIMUM_CHAIN_LENGTH) return { ok: false, reason: 'cycle', body }

		const list = candidates.get(body)
		if (!list) return { ok: false, reason: 'missing', body }

		const selected = select(list, seconds)
		if (!selected) return { ok: false, reason: 'coverage', body }
		if (!selected.segment) return { ok: false, reason: selected.descriptor.reason!, body, kernel: selected.kernel, segment: selected.descriptor.index }

		const [p, v] = selected.segment.at(time)
		position[0] += p[0]
		position[1] += p[1]
		position[2] += p[2]
		velocity[0] += v[0]
		velocity[1] += v[1]
		velocity[2] += v[2]

		if (!kernels.includes(selected.kernel)) kernels.push(selected.kernel)
		chain.push({ body, center: selected.descriptor.center, kernel: selected.kernel, segment: selected.descriptor.index, preferred: selected.preferred })

		body = selected.descriptor.center
	}

	return { ok: true, state: [position, velocity], kernels, chain }
}
