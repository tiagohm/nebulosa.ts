import type { MeteorCatalogMetadata, MeteorObservationTechnique, MeteorShower, MeteorShowerActivity, MeteorShowerActivityYearRange, MeteorShowerSolution, MeteorShowerSolutionSelector, MeteorShowerStatus } from '../../astronomy/meteors/types'
import { deg, normalizeAngle } from '../../math/units/angle'
import { kilometerPerSecond } from '../../math/units/velocity'

// IAU Meteor Data Center adapter. This module is the untrusted-data boundary for the versioned
// streamfulldata JSON document; normalization converts published degrees and km/s to the project's
// radians and AU/day units while preserving source text, status integers, solution order and absence.

// Official IAU MDC stream catalog endpoint.
export const IAU_METEOR_SHOWER_CATALOG_URL = 'https://ceresiaumdc.ta3.sk/downloads/lists_shw_data/streamfulldata.json'

// Parsed, structurally validated catalog document. Unknown source properties are intentionally not
// copied into the normalized domain model.
export interface IauMeteorShowerCatalog {
	// Catalog source label.
	readonly source: string
	// Catalog release identifier.
	readonly version?: string
	// Published record count.
	readonly count?: number
	// Source field dictionary, retained for callers that need provenance.
	readonly fields?: unknown
	// Raw shower records in source order.
	readonly data: readonly IauMeteorShowerRecord[]
}

// Raw record shape accepted from the MDC JSON document.
export interface IauMeteorShowerRecord {
	readonly [key: string]: unknown
}

// Parse and validate the versioned IAU MDC object. JSON text is accepted as a convenience, but an
// array root is rejected because accepting it would silently discard catalog metadata.
export function parseIauMeteorShowerCatalog(input: unknown): IauMeteorShowerCatalog {
	let value: unknown = input
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown
		} catch (cause) {
			throw new Error(`invalid IAU meteor shower catalog JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
		}
	}

	if (!isObject(value) || Array.isArray(value)) throw new Error('IAU meteor shower catalog must be a versioned object')
	const source = requiredString(value.source, 'catalog source')
	const version = requiredString(value.version, 'catalog version')
	const data = value.data
	if (!Array.isArray(data)) throw new Error('IAU meteor shower catalog data must be an array')

	const records: IauMeteorShowerRecord[] = []
	for (const [index, record] of data.entries()) {
		if (!isObject(record) || Array.isArray(record)) throw new Error(`IAU meteor shower record ${index} must be an object`)
		const solutions = record.solution
		if (!Array.isArray(solutions)) throw new Error(`IAU meteor shower record ${index} solution must be an array`)
		for (const [solutionIndex, solution] of solutions.entries()) {
			if (!isObject(solution) || Array.isArray(solution)) throw new Error(`IAU meteor shower solution ${index}/${solutionIndex} must be an object`)
		}
		records.push(record)
	}

	return {
		source,
		version,
		count: optionalNumber(value.count),
		fields: value.fields,
		data: records,
	}
}

// Normalize every IAU record into the reusable meteor-shower domain model. No activity profile is
// inferred from MDC dates and no missing value is replaced with zero.
export function normalizeIauMeteorShowerCatalog(input: IauMeteorShowerCatalog): { readonly metadata: MeteorCatalogMetadata; readonly showers: readonly MeteorShower[] } {
	const showers = input.data.map((record) => {
		const recordStatus = optionalNumber(record.s)
		const solutions = (record.solution as readonly IauMeteorShowerRecord[]).map((raw) => normalizeSolution(raw, record, recordStatus))
		return {
			catalogRecordId: optionalString(record.LP),
			number: optionalNumber(record.IAUNo),
			code: optionalString(record.Code),
			name: optionalString(record.Name) ?? optionalString(record.ProvName) ?? 'Unnamed meteor shower',
			provisionalName: optionalString(record.ProvName),
			status: statusOf(recordStatus),
			sourceStatus: recordStatus,
			solutions,
		} satisfies MeteorShower
	})

	return {
		metadata: {
			source: input.source,
			version: input.version,
			url: IAU_METEOR_SHOWER_CATALOG_URL,
		},
		showers,
	}
}

// Selects one already-normalized solution under an explicit policy. `largestSample` compares the
// published member count and preserves source order for ties; it never combines fields from solutions.
export function selectMeteorShowerSolution(shower: MeteorShower, selector: MeteorShowerSolutionSelector = 'largestSample'): MeteorShowerSolution | undefined {
	if (typeof selector === 'function') return selector(shower.solutions)
	if (selector !== 'largestSample') return undefined
	let selected: MeteorShowerSolution | undefined
	for (const solution of shower.solutions) if (solution.memberCount !== undefined && (selected === undefined || solution.memberCount > (selected.memberCount ?? Number.NEGATIVE_INFINITY))) selected = solution
	return selected
}

// Fetch, validate and normalize the official catalog. The timeout is an adapter concern and is not
// used by tests unless the caller explicitly requests network access.
export async function fetchIauMeteorShowerCatalog(options: { readonly url?: string; readonly signal?: AbortSignal; readonly timeout?: number } = {}): Promise<{ readonly metadata: MeteorCatalogMetadata; readonly showers: readonly MeteorShower[] }> {
	const controller = new AbortController()
	const signal = options.signal
	let timer: ReturnType<typeof setTimeout> | undefined
	if (options.timeout !== undefined) timer = setTimeout(() => controller.abort(), options.timeout)
	if (signal?.aborted) controller.abort()
	const abort = () => controller.abort()
	signal?.addEventListener('abort', abort, { once: true })

	try {
		const response = await fetch(options.url ?? IAU_METEOR_SHOWER_CATALOG_URL, { signal: controller.signal })
		if (!response.ok) throw new Error(`IAU meteor shower catalog request failed with HTTP ${response.status}`)
		const parsed = parseIauMeteorShowerCatalog(await response.json())
		const normalized = normalizeIauMeteorShowerCatalog(parsed)
		return {
			metadata: { ...normalized.metadata, retrievedAt: new Date() },
			showers: normalized.showers,
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		signal?.removeEventListener('abort', abort)
	}
}

function normalizeSolution(raw: IauMeteorShowerRecord, record: IauMeteorShowerRecord, recordStatus: number | undefined): MeteorShowerSolution {
	const sourceStatus = optionalNumber(raw.s)
	const start = optionalNumber(raw.LoSb)
	const end = optionalNumber(raw.LoSe)
	const reference = optionalNumber(raw.LoS)
	const rightAscension = optionalNumber(raw.Ra)
	const declination = optionalNumber(raw.De)
	const driftRa = optionalNumber(raw.dRa)
	const driftDec = optionalNumber(raw.dDe)
	const activitySource = typeof raw.activity === 'string' ? raw.activity : ''
	const orbit = normalizeOrbit(raw)
	const startAngle = start === undefined ? undefined : normalizeAngle(deg(start))
	const endAngle = end === undefined ? undefined : normalizeAngle(deg(end))

	return {
		catalogRecordId: optionalString(record.LP),
		solutionId: optionalString(raw.AdNo),
		status: sourceStatus === undefined ? undefined : statusOf(sourceStatus),
		sourceStatus,
		activity: activityOf(activitySource),
		activityInterval: startAngle === undefined || endAngle === undefined || startAngle === endAngle ? undefined : { start: startAngle, end: endAngle },
		referenceSolarLongitude: reference === undefined ? undefined : normalizeAngle(deg(reference)),
		rightAscension: rightAscension === undefined ? undefined : normalizeAngle(deg(rightAscension)),
		declination: declination === undefined ? undefined : deg(declination),
		radiantDrift: driftRa === undefined || driftDec === undefined ? undefined : { basis: 'day', rightAscensionRate: deg(driftRa), declinationRate: deg(driftDec) },
		geocentricSpeed: optionalNumber(raw.Vg) === undefined ? undefined : kilometerPerSecond(optionalNumber(raw.Vg)!),
		eclipticLongitude: optionalNumber(raw.LoR) === undefined ? undefined : normalizeAngle(deg(optionalNumber(raw.LoR)!)),
		eclipticLatitude: optionalNumber(raw.LaR) === undefined ? undefined : deg(optionalNumber(raw.LaR)!),
		sunCenteredEclipticLongitude: optionalNumber(raw.S_LoR) === undefined ? undefined : normalizeAngle(deg(optionalNumber(raw.S_LoR)!)),
		orbit,
		memberCount: optionalNumber(raw.N),
		parentBody: optionalString(raw['Parent body']),
		group: optionalNumber(raw.Group),
		observationTechnique: techniqueOf(raw.Ote),
		submissionDate: optionalString(raw['sub.date']),
		sourceFlags: optionalString(raw.Flags),
		reference: referenceText(raw.References),
		remarks: optionalString(raw.Remarks),
		...(sourceStatus === undefined && recordStatus !== undefined ? { status: statusOf(recordStatus) } : {}),
	} satisfies MeteorShowerSolution
}

function normalizeOrbit(raw: IauMeteorShowerRecord) {
	const semiMajorAxis = optionalNumber(raw.a)
	const perihelionDistance = optionalNumber(raw.q)
	const eccentricity = optionalNumber(raw.e)
	const argumentOfPerihelion = optionalNumber(raw.peri)
	const longitudeOfAscendingNode = optionalNumber(raw.node)
	const inclination = optionalNumber(raw.inc)

	if ([semiMajorAxis, perihelionDistance, eccentricity, argumentOfPerihelion, longitudeOfAscendingNode, inclination].every((value) => value === undefined)) return undefined
	return {
		semiMajorAxis,
		perihelionDistance,
		eccentricity,
		argumentOfPerihelion: argumentOfPerihelion === undefined ? undefined : deg(argumentOfPerihelion),
		longitudeOfAscendingNode: longitudeOfAscendingNode === undefined ? undefined : normalizeAngle(deg(longitudeOfAscendingNode)),
		inclination: inclination === undefined ? undefined : deg(inclination),
	}
}

const DATED_OUTBURST_PATTERN = /^(\d{4})out$/

function activityOf(source: string): MeteorShowerActivity {
	const value = source.trim().toLowerCase()
	if (value === 'annual' || value === 'annual?' || value === 'periodic') return { kind: 'annual', source }

	const datedOutburst = DATED_OUTBURST_PATTERN.exec(value)
	if (datedOutburst !== null) {
		const year = Number(datedOutburst[1])
		return { kind: 'outburst', source, years: { start: year, end: year } }
	}

	const years = activityYears(value)
	if (years !== undefined) return { kind: 'yearSpecific', source, years }
	if (value === 'variable') return { kind: 'variable', source }
	if (value === 'irr.' || value === 'irregular' || value === 'episodic') return { kind: 'irregular', source }
	if (value.includes('outburst')) return { kind: 'outburst', source }
	return { kind: 'unknown', source }
}

const SINGLE_YEAR_PATTERN = /^(\d{4})(?:\/\d{2})?$/
const SHORT_RANGE_YEAR_PATTERN = /^(\d{4})-(\d{2})$/
const FULL_RANGE_YEAR_PATTERN = /^(\d{4})-(\d{4})$/

// Parses supported MDC single-year and inclusive multi-year labels. Month suffixes remain only in
// source because solar-longitude bounds provide the astronomical within-year activity support.
function activityYears(value: string): MeteorShowerActivityYearRange | undefined {
	const single = SINGLE_YEAR_PATTERN.exec(value)
	if (single !== null) {
		const year = Number(single[1])
		return { start: year, end: year }
	}

	const shortRange = SHORT_RANGE_YEAR_PATTERN.exec(value)
	if (shortRange !== null) {
		const start = Number(shortRange[1])
		return { start, end: expandShortEndYear(start, Number(shortRange[2])) }
	}

	const fullRange = FULL_RANGE_YEAR_PATTERN.exec(value)
	if (fullRange === null) return undefined

	const start = Number(fullRange[1])
	const end = Number(fullRange[2])
	return end >= start ? { start, end } : undefined
}

// Expands a two-digit inclusive end year in the first matching or following century.
function expandShortEndYear(start: number, suffix: number): number {
	const century = Math.floor(start / 100) * 100
	const end = century + suffix
	return end < start ? end + 100 : end
}

function statusOf(value: number | undefined): MeteorShowerStatus {
	if (value === 0) return 'working'
	if (value === 1) return 'established'
	if (value === 2) return 'toBeEstablished'
	if (value !== undefined && value < 0) return 'removed'
	return 'unknown'
}

function techniqueOf(value: unknown): MeteorObservationTechnique | undefined {
	const text = optionalString(value)?.toUpperCase()
	if (text === undefined) return undefined
	if (text.startsWith('C')) return 'ccd'
	if (text.startsWith('P')) return 'photo'
	if (text.startsWith('R')) return 'radar'
	if (text.startsWith('T')) return 'tv'
	if (text.startsWith('V')) return 'visual'
	return 'unknown'
}

function referenceText(value: unknown): string | undefined {
	if (typeof value === 'string') return optionalString(value)
	if (!Array.isArray(value)) return undefined
	const values = value.filter((entry): entry is string => typeof entry === 'string')
	return values.length === 0 ? undefined : values.join('\n').trim() || undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function requiredString(value: unknown, label: string): string {
	const result = optionalString(value)
	if (result === undefined) throw new Error(`IAU meteor shower ${label} is required`)
	return result
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string' && value.trim() !== '') {
		const result = Number(value)
		return Number.isFinite(result) ? result : undefined
	}
	return undefined
}
