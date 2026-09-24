import { clamp } from '../../../math/numerical/math'
import { DEFAULT_STREAK_CLASSIFIER_OPTIONS, type StreakClass, type StreakClassScore, type StreakClassification, type StreakClassificationContext, type StreakClassificationEvidence, type StreakClassifierOptions, type StreakEvidenceContribution, type StreakEvidenceProvider } from './classification.types'
import { defaultStreakEvidenceProviders } from './evidence'
import type { Streak } from './types'

// Combines streak-evidence votes into one uncalibrated classification per streak.
// A named class is emitted only when its primary weight clears `minimumScore` and leads every other
// primary weight by `minimumMargin`. Morphology and intensity remain visible as alternatives, so an
// ambiguous trail stays `unknown` instead of inheriting the largest heuristic. No provider is allowed
// to perform network or catalog access; predicted tracks and radiants come from the caller.

// Classes that can receive votes, in the tie-break order used when primary weights are equal.
const CLASS_ORDER = ['airplane', 'meteor', 'movingObject', 'opticalArtifact', 'satellite', 'sensorArtifact', 'trackingFailure'] as const satisfies readonly Exclude<StreakClass, 'unknown'>[]

// Running primary and secondary weight of one class.
interface ClassTally {
	// Class being accumulated.
	readonly class: (typeof CLASS_ORDER)[number]
	// Sum of primary votes, clamped to [0, 1].
	primary: number
	// Sum of secondary votes, clamped to [0, 1].
	secondary: number
}

// Classifies one streak. Field-wide star coherence and spike families that depend on other streaks
// need `classifyStreaks`; a tracking snapshot or star list on `context` still applies to this call.
export function classifyStreak(streak: Streak, context: Readonly<StreakClassificationContext> = {}, options: Readonly<StreakClassifierOptions> = {}): StreakClassification {
	return classifyStreaks([streak], context, options)[0]
}

// Classifies every streak in input order. Providers see the full set as `peers`.
export function classifyStreaks(streaks: readonly Streak[], context: Readonly<StreakClassificationContext> = {}, options: Readonly<StreakClassifierOptions> = {}): readonly StreakClassification[] {
	const providers = options.providers ?? defaultStreakEvidenceProviders
	const minimumScore = options.minimumScore ?? DEFAULT_STREAK_CLASSIFIER_OPTIONS.minimumScore
	const minimumMargin = options.minimumMargin ?? DEFAULT_STREAK_CLASSIFIER_OPTIONS.minimumMargin
	const results = new Array<StreakClassification>(streaks.length)
	for (let index = 0; index < streaks.length; index++) results[index] = classifyOne(streaks[index], context, streaks, providers, minimumScore, minimumMargin)
	return results
}

// Evaluates providers and applies the primary-score decision rule.
function classifyOne(streak: Streak, context: Readonly<StreakClassificationContext>, peers: readonly Streak[], providers: readonly StreakEvidenceProvider[], minimumScore: number, minimumMargin: number): StreakClassification {
	const tallies = new Map<Exclude<StreakClass, 'unknown'>, ClassTally>()
	const evidence: StreakClassificationEvidence[] = []

	for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
		const contributions = providers[providerIndex].evaluate(streak, context, peers)

		for (let contributionIndex = 0; contributionIndex < contributions.length; contributionIndex++) {
			const contribution = contributions[contributionIndex]
			appendEvidence(evidence, contribution.evidence)
			addVote(tallies, contribution)
		}
	}

	return decide(tallies, evidence, minimumScore, minimumMargin)
}

// Adds one finite positive vote into its tier. Non-positive scores still keep their diagnostics.
function addVote(tallies: Map<Exclude<StreakClass, 'unknown'>, ClassTally>, contribution: StreakEvidenceContribution): void {
	const score = contribution.score
	const weight = contribution.weight
	if (!(score > 0) || !(weight > 0)) return
	const added = Math.min(score, 1) * Math.min(weight, 1)
	const tally = tallies.get(contribution.class) ?? { class: contribution.class, primary: 0, secondary: 0 }
	if (contribution.tier === 'primary') tally.primary = Math.min(1, tally.primary + added)
	else tally.secondary = Math.min(1, tally.secondary + added)
	tallies.set(contribution.class, tally)
}

// Copies diagnostics in provider order, dropping non-finite scores.
function appendEvidence(target: StreakClassificationEvidence[], evidence: readonly StreakClassificationEvidence[]): void {
	for (let index = 0; index < evidence.length; index++) {
		const item = evidence[index]
		if (!Number.isFinite(item.score)) continue
		target.push(item)
	}
}

// Names a class only from primary weights. Secondary weight changes confidence and alternatives.
function decide(tallies: Map<Exclude<StreakClass, 'unknown'>, ClassTally>, evidence: readonly StreakClassificationEvidence[], minimumScore: number, minimumMargin: number): StreakClassification {
	const ranked = tallies.values().toArray().sort(compareTallies)
	let leader: ClassTally | undefined
	let runnerPrimary = 0

	for (let index = 0; index < ranked.length; index++) {
		const tally = ranked[index]
		if (!(tally.primary > 0)) continue
		if (leader === undefined) leader = tally
		else if (tally.primary > runnerPrimary) runnerPrimary = tally.primary
	}

	const leaderPrimary = leader?.primary ?? 0
	const named = leader !== undefined && leaderPrimary >= minimumScore && leaderPrimary - runnerPrimary >= minimumMargin
	const selected = named ? leader : undefined
	const alternatives = ranked
		.filter((tally) => totalOf(tally) > 0 && (selected === undefined || tally.class !== selected.class))
		.map((tally) => ({ class: tally.class, score: totalOf(tally) }) satisfies StreakClassScore)
		.sort(compareScores)

	let bestTotal = named && leader !== undefined ? totalOf(leader) : 0
	for (let index = 0; index < alternatives.length; index++) if (alternatives[index].score > bestTotal) bestTotal = alternatives[index].score

	if (!named || leader === undefined) return { class: 'unknown', confidence: clamp(1 - bestTotal, 0, 1), alternatives, evidence }
	return { class: leader.class, confidence: totalOf(leader), alternatives, evidence }
}

// Combined weight shown for a class, including secondary evidence and clamped to [0, 1].
function totalOf(tally: ClassTally): number {
	return Math.min(1, tally.primary + tally.secondary)
}

// Orders primary weights descending, then by the fixed class order so equal weights stay deterministic.
function compareTallies(left: ClassTally, right: ClassTally): number {
	return right.primary - left.primary || classIndex(left.class) - classIndex(right.class)
}

// Orders published alternatives by descending total, then by class name.
function compareScores(left: StreakClassScore, right: StreakClassScore): number {
	return right.score - left.score || (left.class < right.class ? -1 : left.class > right.class ? 1 : 0)
}

// Index of a votable class in the deterministic tie break.
function classIndex(value: Exclude<StreakClass, 'unknown'>): number {
	return CLASS_ORDER.indexOf(value)
}
