import type { PositionAndVelocity, PositionAndVelocityOverTime } from './astrometry'
import type { Daf, Summary } from './daf'
import type { Time } from './time'
import { zero } from './vector'

export interface Spk {
	readonly segments: readonly [number, number, SpkSegment][]
	readonly segment: (center: number, target: number) => SpkSegment | undefined
}

export interface SpkSegment {
	readonly daf: Daf
	readonly source: string
	readonly start: number
	readonly end: number
	readonly center: number
	readonly target: number
	readonly frame: number
	readonly type: number
	readonly startIndex: number
	readonly endIndex: number

	readonly compute: PositionAndVelocityOverTime
}

export function spk(daf: Daf): Spk {
	const segments = daf.summaries.map((e) => [e.ints[1], e.ints[0], makeSegment(e, daf)] as Spk['segments'][number])

	return {
		segments,
		segment: (center, target) => {
			return segments.find((e) => e[0] === center && e[1] === target)?.[2]
		},
	}
}

function makeSegment(summary: Summary, daf: Daf): SpkSegment {
	const [start, end] = summary.doubles
	const [target, center, frame, type, startIndex, endIndex] = summary.ints

	switch (type) {
		case 9:
			return new Type9Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
		case 2:
		case 3:
			return new Type2And3Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
		case 21:
			return new Type21Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
	}

	throw Error('Only binary SPK data types 2, 3, 9 and 21 are supported')
}

export class Type2And3Segment implements SpkSegment {
	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	compute(time: Time): PositionAndVelocity {
		return [zero(), zero()]
	}
}

export class Type9Segment implements SpkSegment {
	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	compute(time: Time): PositionAndVelocity {
		return [zero(), zero()]
	}
}

export class Type21Segment implements SpkSegment {
	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	compute(time: Time): PositionAndVelocity {
		return [zero(), zero()]
	}
}
