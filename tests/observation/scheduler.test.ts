import { expect, test } from 'bun:test'
import { greenwichApparentSiderealTime, type Time, timeShift, timeSubtract, timeToDate, timeYMDHMS } from '../../src/astronomy/time/time'
import { DAYSEC, SIDEREAL_DRIFT_RATE } from '../../src/core/constants'
import { deg, normalizeAngle } from '../../src/math/units/angle'
// oxfmt-ignore
import { type ScheduleBlockRequest, type ScheduleOptions, type SchedulePointing, type ScheduleTarget, scheduleSession, type SessionSchedule } from '../../src/observation/scheduler'

// A winter night starting at 22:00 UTC, so the session wraps across 0h UTC after two hours.
const START = timeYMDHMS(2026, 1, 15, 22, 0, 0)
const NIGHT = 8 * 3600
const END = at(NIGHT)
const HOUR = 3600

function at(seconds: number) {
	return timeShift(START, seconds / DAYSEC)
}

function offset(time: Time) {
	return timeSubtract(time, START) * DAYSEC
}

function windowOf(start: number, end: number) {
	return { start: at(start), end: at(end) }
}

function target(id: string, blocks: readonly ScheduleBlockRequest[], extra: Partial<ScheduleTarget> = {}): ScheduleTarget {
	return { id, priority: 1, windows: [windowOf(0, NIGHT)], blocks, ...extra }
}

function summary(plan: SessionSchedule) {
	return plan.blocks.map((b) => [b.blockId, Math.round(offset(b.start)), Math.round(offset(b.end)), b.frames] as const)
}

function expectChronological(plan: SessionSchedule) {
	let previous = 0

	for (const block of plan.blocks) {
		expect(offset(block.start)).toBeGreaterThanOrEqual(previous - 1e-6)
		expect(offset(block.exposureStart)).toBeGreaterThanOrEqual(offset(block.start) - 1e-6)
		expect(offset(block.end)).toBeGreaterThan(offset(block.exposureStart))
		previous = offset(block.end)
	}

	const { diagnostics } = plan
	expect(diagnostics.exposure + diagnostics.overhead.total + diagnostics.idle).toBeCloseTo(diagnostics.duration, 3)
}

const M31: SchedulePointing = { rightAscension: deg(10.7), declination: deg(41.3) }
const M42: SchedulePointing = { rightAscension: deg(83.8), declination: deg(-5.4) }

test('a single divisible target fills its window with exact overhead accounting', () => {
	const costs = { slewRate: deg(2), slewSettle: 30, readout: 5, dither: 20, filterChange: 10 }
	const plan = scheduleSession([target('M31', [{ id: 'L', exposure: 295, count: 200, filter: 'L', divisible: true, ditherEvery: 3 }], { pointing: M31 })], START, END, { costs, initial: { pointing: M42, filter: 'R' } })

	expect(plan.blocks).toHaveLength(1)
	const [block] = plan.blocks
	const slew = 30 + Math.acos(Math.sin(M31.declination) * Math.sin(M42.declination) + Math.cos(M31.declination) * Math.cos(M42.declination) * Math.cos(M42.rightAscension - M31.rightAscension)) / deg(2)
	expect(block.overhead.slew).toBeCloseTo(slew, 9)
	expect(block.overhead.filterChange).toBe(10)
	expect(offset(block.exposureStart)).toBeCloseTo(slew + 10, 6)

	// 300 s per frame plus one 20 s dither after every three frames, except after the last one.
	const available = NIGHT - slew - 10
	const frames = Math.floor((available + 20) / 920) * 3 + Math.min(2, Math.floor(Math.max(0, available - Math.floor((available + 20) / 920) * 920) / 300))
	expect(block.frames).toBe(frames)
	expect(block.exposure).toBe(frames * 295)
	expect(block.overhead.readout).toBe(frames * 5)
	expect(block.overhead.dither).toBe(Math.floor((frames - 1) / 3) * 20)
	expect(offset(block.end)).toBeLessThanOrEqual(NIGHT + 1e-6)
	expect(block.flags).toEqual(['partial', 'filterChange'])
	expect(plan.unscheduled).toEqual([{ targetId: 'M31', blockId: 'L', remainingFrames: 200 - frames, scheduledFrames: frames, reason: 'partial' }])

	expectChronological(plan)
	expect(plan.diagnostics.efficiency).toBeCloseTo((frames * 295) / NIGHT, 12)
	expect(plan.diagnostics.objective).toBe(frames * 300)
	expect(plan.diagnostics.maximumObjective).toBe(200 * 300)
	expect(plan.diagnostics.completeness).toBeCloseTo(frames / 200, 12)
	expect(plan.diagnostics.iterations).toBe(1)
})

test('overlapping windows observe the setting target before the rising one', () => {
	const setting = target('setting', [{ id: 'S', exposure: 300, count: 36, divisible: true }], { pointing: M31, windows: [windowOf(0, 3 * HOUR)] })
	const rising = target('rising', [{ id: 'R', exposure: 300, count: 36, divisible: true }], { pointing: M42, windows: [windowOf(1 * HOUR, NIGHT)] })
	const plan = scheduleSession([rising, setting], START, END, { initial: { pointing: M31 } })

	expect(summary(plan)).toEqual([
		['S', 0, 3 * HOUR, 36],
		['R', 3 * HOUR, 6 * HOUR, 36],
	])
	expect(plan.unscheduled).toEqual([])
	expect(plan.diagnostics.completeness).toBe(1)
	expectChronological(plan)
})

test('a time-critical transit block is protected while a divisible filler uses the time around it', () => {
	const costs = { slewRate: deg(2), slewSettle: 30 }
	const filler = target('filler', [{ id: 'F', exposure: 300, count: 200, divisible: true }], { pointing: M31 })
	// Ingress at 3 h and egress at 5 h; the block opens 10 minutes early to absorb the slew.
	const transit = target('transit', [{ id: 'T', exposure: 60, count: 120, notBefore: at(2 * HOUR + 50 * 60), notAfter: at(5 * HOUR) }], { pointing: M42, priority: 10 })
	const plan = scheduleSession([filler, transit], START, END, { costs, initial: { pointing: M31 } })

	expect(plan.blocks.map((b) => b.blockId)).toEqual(['F', 'T', 'F'])
	const [before, critical, after] = plan.blocks
	expect(offset(before.end)).toBeLessThanOrEqual(offset(critical.start) + 1e-6)
	expect(offset(critical.start)).toBeGreaterThanOrEqual(2 * HOUR + 50 * 60 - 1e-6)
	expect(offset(critical.end)).toBeLessThanOrEqual(5 * HOUR + 1e-6)
	expect(critical.frames).toBe(120)
	// The filler chunk ending at the transit displaces nothing; the transit itself takes filler time.
	expect(before.displaced).toBe(0)
	expect(critical.displaced).toBeGreaterThan(0)
	expect(critical.displaced).toBeLessThan(10 * 120 * 60)
	expect(offset(after.start)).toBeCloseTo(offset(critical.end), 6)
	expect(offset(after.end)).toBeLessThanOrEqual(NIGHT + 1e-6)
	expect(plan.unscheduled.map((u) => [u.blockId, u.reason])).toEqual([['F', 'partial']])
	expectChronological(plan)

	// Without room for its setup, the indivisible block cannot fit at all.
	const tight = target('transit', [{ id: 'T', exposure: 60, count: 120, notBefore: at(3 * HOUR), notAfter: at(5 * HOUR) }], { pointing: M42, priority: 10 })
	const lost = scheduleSession([filler, tight], START, END, { costs, initial: { pointing: M31 } })
	expect(lost.blocks.map((b) => b.blockId)).toEqual(['F'])
	expect(lost.unscheduled.find((u) => u.blockId === 'T')?.reason).toBe('windowTooShort')
})

test('a low-priority filler yields to a high-priority target rising shortly after', () => {
	const costs = { slewRate: deg(2), slewSettle: 30 }
	const filler = target('filler', [{ id: 'F', exposure: 300, count: 200, divisible: true }], { pointing: M31 })
	const high = target('high', [{ id: 'H', exposure: 300, count: 50, divisible: true }], { pointing: M42, priority: 5, windows: [windowOf(600, 4200)] })
	const plan = scheduleSession([filler, high], START, END, { costs, initial: { pointing: M31 } })

	expect(summary(plan).map(([id, start, , frames]) => [id, start, frames])).toEqual([
		['F', 0, 2],
		['H', 600, 11],
		['F', Math.round(offset(plan.blocks[1].end)), 82],
	])
	expect(offset(plan.blocks[1].end)).toBeLessThanOrEqual(4200 + 1e-6)
	expect(plan.blocks.every((b) => b.idle < 1e-6)).toBe(true)
	expectChronological(plan)
})

test('a block crossing the meridian contains an inevitable flip', () => {
	const longitude = deg(-45)
	const lst = greenwichApparentSiderealTime(START) + longitude
	// Starts 7.5 degrees (30 sidereal minutes) east of the meridian.
	const pointing = { rightAscension: normalizeAngle(lst + deg(7.5)), declination: deg(20) }
	const request = [target('east', [{ id: 'E', exposure: 300, count: 24, divisible: true }], { pointing })]
	const options: ScheduleOptions = { costs: { meridianFlip: 600 }, meridian: { longitude }, initial: { pointing } }
	const plan = scheduleSession(request, START, END, options)

	expect(plan.blocks).toHaveLength(1)
	const [block] = plan.blocks
	// The crossing happens about 1795 s in, during the sixth frame; the flip follows that frame.
	expect(deg(7.5) / SIDEREAL_DRIFT_RATE).toBeGreaterThan(1500)
	expect(deg(7.5) / SIDEREAL_DRIFT_RATE).toBeLessThan(1800)
	expect(offset(block.meridianFlip!)).toBeCloseTo(1800, 3)
	expect(block.frames).toBe(24)
	expect(offset(block.end)).toBeCloseTo(24 * 300 + 600, 3)
	expect(block.overhead.meridianFlip).toBe(600)
	expect(block.flags).toEqual(['meridianFlip'])
	expect(plan.diagnostics.meridianFlips).toBe(1)

	// A fork mount (no meridian geometry) never flips.
	const fork = scheduleSession(request, START, END, { ...options, meridian: undefined })
	expect(fork.blocks[0].meridianFlip).toBeUndefined()
	expect(offset(fork.blocks[0].end)).toBeCloseTo(24 * 300, 3)

	// A target already west of the meridian is reached on the post-flip side.
	const west = { rightAscension: normalizeAngle(lst - deg(10)), declination: deg(20) }
	const western = scheduleSession([target('west', [{ id: 'W', exposure: 300, count: 24, divisible: true }], { pointing: west })], START, END, { ...options, initial: { pointing: M31 } })
	expect(western.blocks[0].meridianFlip).toBeUndefined()

	// Still pointed on the pre-flip side after the crossing: the flip happens before the first frame.
	const late = scheduleSession([target('west', [{ id: 'W', exposure: 300, count: 4 }], { pointing: west })], START, END, { ...options, initial: { pointing: west } })
	expect(offset(late.blocks[0].meridianFlip!)).toBe(0)
	expect(offset(late.blocks[0].exposureStart)).toBeCloseTo(600, 6)
	const flipped = scheduleSession([target('west', [{ id: 'W', exposure: 300, count: 4 }], { pointing: west })], START, END, { ...options, initial: { pointing: west, postFlip: true } })
	expect(flipped.blocks[0].meridianFlip).toBeUndefined()

	// The flip shortens what fits in a closing window.
	const closing = scheduleSession([target('east', [{ id: 'E', exposure: 300, count: 24, divisible: true }], { pointing, windows: [windowOf(0, 2 * HOUR)] })], START, END, options)
	expect(closing.blocks[0].frames).toBe(22)
	expect(closing.unscheduled[0]).toEqual({ targetId: 'east', blockId: 'E', remainingFrames: 2, scheduledFrames: 22, reason: 'partial' })
})

test('a target setting during acquisition is truncated or rejected by its window', () => {
	const setting = [windowOf(0, 1 * HOUR)]
	const divisible = scheduleSession([target('low', [{ id: 'D', exposure: 600, count: 12, divisible: true, minimumFrames: 2 }], { windows: setting })], START, END)
	expect(summary(divisible)).toEqual([['D', 0, HOUR, 6]])
	expect(divisible.unscheduled[0].reason).toBe('partial')

	const indivisible = scheduleSession([target('low', [{ id: 'I', exposure: 600, count: 12 }], { windows: setting })], START, END)
	expect(indivisible.blocks).toEqual([])
	expect(indivisible.unscheduled).toEqual([{ targetId: 'low', blockId: 'I', remainingFrames: 12, scheduledFrames: 0, reason: 'windowTooShort' }])

	// Fewer than minimumFrames fit in a short window: no worthless chunk is scheduled.
	const short = scheduleSession([target('low', [{ id: 'D', exposure: 600, count: 12, divisible: true, minimumFrames: 7 }], { windows: setting })], START, END)
	expect(short.blocks).toEqual([])
	expect(short.unscheduled[0].reason).toBe('windowTooShort')
})

test('overhead costs decide between a filter change and a slew', () => {
	const blocks = (pointing: SchedulePointing, ids: readonly [string, string][]) => ids.map(([id, filter]) => ({ id, filter, exposure: 300, count: 10 }))
	const targets = [
		target(
			'A',
			blocks(M31, [
				['AL', 'L'],
				['AR', 'R'],
			]),
			{ pointing: M31 },
		),
		target('B', blocks(M42, [['BL', 'L']]), { pointing: M42 }),
	]
	const initial = { pointing: M31, filter: 'L' }

	const slowSlew = scheduleSession(targets, START, END, { initial, costs: { slewRate: deg(0.5), slewSettle: 60, filterChange: 10 } })
	expect(slowSlew.blocks.map((b) => b.blockId)).toEqual(['AL', 'AR', 'BL'])
	expect(slowSlew.diagnostics.overhead.filterChange).toBe(20)

	const slowWheel = scheduleSession(targets, START, END, { initial, costs: { slewRate: deg(10), slewSettle: 5, filterChange: 300 } })
	expect(slowWheel.blocks.map((b) => b.blockId)).toEqual(['AL', 'BL', 'AR'])
	expect(slowWheel.diagnostics.overhead.filterChange).toBe(300)

	for (const plan of [slowSlew, slowWheel]) {
		expect(plan.unscheduled).toEqual([])
		expectChronological(plan)
	}
})

test('calibration frames use a cloudy slot that blocks the sky target', () => {
	const sky = target('M42', [{ id: 'S', exposure: 300, count: 200, divisible: true }], { pointing: M42, priority: 5 })
	const darks = target('darks', [{ id: 'darks', exposure: 300, count: 10 }], { sky: false })
	const bias = target('bias', [{ id: 'bias', exposure: 0, count: 20 }], { sky: false })
	const exclusions = [{ start: at(2 * HOUR), end: at(3 * HOUR), scope: 'sky' as const }]
	const plan = scheduleSession([sky, darks, bias], START, END, { exclusions, costs: { readout: 2, focus: 120 }, initial: { pointing: M42 } })

	expect(plan.blocks.map((b) => b.blockId)).toEqual(['S', 'darks', 'bias', 'S'])
	const [first, dark, zero, second] = plan.blocks
	expect(offset(first.end)).toBeLessThanOrEqual(2 * HOUR + 1e-6)
	expect(offset(dark.start)).toBeGreaterThanOrEqual(offset(first.end) - 1e-6)
	expect(offset(zero.end)).toBeLessThanOrEqual(3 * HOUR + 1e-6)
	expect(zero.exposure).toBe(0)
	expect(zero.overhead.readout).toBe(40)
	// Calibration needs neither focus nor a slew, and the sky target resumes without slewing.
	expect(dark.overhead.focus + dark.overhead.slew + zero.overhead.focus).toBe(0)
	expect(offset(second.start)).toBeCloseTo(3 * HOUR, 6)
	expect(second.overhead.slew).toBe(0)
	expect(second.flags).toContain('waited')
	expect(first.flags).toContain('focus')
	expectChronological(plan)

	// A safety exclusion of scope 'all' stops the calibration too.
	const safety = scheduleSession([darks], START, END, { exclusions: [{ start: at(0), end: at(NIGHT) }] })
	expect(safety.unscheduled).toEqual([{ targetId: 'darks', blockId: 'darks', remainingFrames: 10, scheduledFrames: 0, reason: 'excluded' }])
	// The cloudy-only exclusion does not.
	expect(scheduleSession([darks], START, END, { exclusions: [{ start: at(0), end: at(NIGHT), scope: 'sky' }] }).blocks).toHaveLength(1)
})

test('weather exclusions split the night around the bad interval', () => {
	const exclusions = [{ start: at(1 * HOUR), end: at(2 * HOUR) }]
	const indivisible = scheduleSession([target('M31', [{ id: 'I', exposure: 600, count: 9 }], { pointing: M31 })], START, END, { exclusions, initial: { pointing: M31 } })
	expect(summary(indivisible)).toEqual([['I', 2 * HOUR, 3.5 * HOUR, 9]])
	expect(indivisible.blocks[0].flags).toEqual(['waited'])

	const divisible = scheduleSession([target('M31', [{ id: 'D', exposure: 600, count: 18, divisible: true }], { pointing: M31, windows: [windowOf(0, 4 * HOUR)] })], START, END, { exclusions, initial: { pointing: M31 } })
	expect(summary(divisible)).toEqual([
		['D', 0, HOUR, 6],
		['D', 2 * HOUR, 4 * HOUR, 12],
	])
	expect(divisible.unscheduled).toEqual([])
})

test('replanning from an updated horizon resumes the remaining frames and reports skipped blocks', () => {
	const targets = [target('M31', [{ id: 'L', exposure: 300, count: 60, divisible: true, filter: 'L' }], { pointing: M31, windows: [windowOf(0, 6 * HOUR)] }), target('M42', [{ id: 'R', exposure: 300, count: 12, filter: 'R' }], { pointing: M42 })]
	const costs = { slewRate: deg(2), slewSettle: 30, filterChange: 10, focus: 120 }
	const plan = scheduleSession(targets, START, END, { costs })
	expect(plan.blocks[0].flags).toContain('unknownPointing')
	expect(plan.blocks[0].overhead.slew).toBeCloseTo(30 + Math.PI / deg(2), 9)

	// The sequencer was interrupted at 1.5 h after 15 frames of L; the sky is usable again at 2 h.
	const resume = at(2 * HOUR)
	const replan = scheduleSession(targets, resume, END, { costs, initial: { pointing: M31, filter: 'L', lastFocus: at(60), completedFrames: { L: 15 } } })
	expect(offset(replan.blocks[0].start)).toBeCloseTo(2 * HOUR, 6)
	expect(replan.blocks[0].blockId).toBe('L')
	expect(replan.blocks[0].overhead.total).toBe(0)
	expect(replan.blocks.filter((b) => b.blockId === 'L').reduce((sum, b) => sum + b.frames, 0)).toBe(45)
	expect(replan.diagnostics.duration).toBeCloseTo(6 * HOUR, 6)
	expect(replan.unscheduled).toEqual([])

	// The sequencer aborted R: it is reported, not rescheduled.
	const skipped = scheduleSession(targets, resume, END, { costs, initial: { pointing: M31, filter: 'L', completedFrames: { L: 15, R: 4 }, skip: ['R'] } })
	expect(skipped.blocks.every((b) => b.blockId === 'L')).toBe(true)
	expect(skipped.unscheduled).toEqual([{ targetId: 'M42', blockId: 'R', remainingFrames: 8, scheduledFrames: 0, reason: 'skipped' }])
})

test('autofocus runs first, after its interval, and optionally on filter changes', () => {
	const chunks = scheduleSession([target('M31', [{ id: 'L', exposure: 300, count: 18, divisible: true, maximumFrames: 6 }], { pointing: M31 })], START, END, { costs: { focus: 120, focusInterval: 3600 }, initial: { pointing: M31 } })
	expect(chunks.blocks.map((b) => [b.frames, b.overhead.focus])).toEqual([
		[6, 120],
		[6, 0],
		[6, 120],
	])

	const blocks = [
		{ id: 'L', exposure: 300, count: 2, filter: 'L' },
		{ id: 'R', exposure: 300, count: 2, filter: 'R' },
	]
	const onChange = scheduleSession([target('M31', blocks, { pointing: M31 })], START, END, { costs: { focus: 120, focusOnFilterChange: true }, initial: { pointing: M31, filter: 'L', lastFocus: START } })
	expect(onChange.blocks.map((b) => [b.blockId, b.overhead.focus])).toEqual([
		['L', 0],
		['R', 120],
	])
})

test('the night wraps across 0h UTC without discontinuity', () => {
	const plan = scheduleSession([target('M42', [{ id: 'S', exposure: 600, count: 30, divisible: true, maximumFrames: 6 }], { pointing: M42 })], START, END, { initial: { pointing: M42 } })
	expect(plan.blocks).toHaveLength(5)
	expect(plan.blocks.map((b) => Math.round(offset(b.start)))).toEqual([0, 3600, 7200, 10800, 14400])
	expect(timeToDate(plan.blocks[1].start).slice(0, 4)).toEqual([2026, 1, 15, 23])
	expect(timeToDate(plan.blocks[2].start).slice(0, 4)).toEqual([2026, 1, 16, 0])
	expect(plan.blocks[2].start.scale).toBe(START.scale)
	expectChronological(plan)
})

test('degenerate sessions and requests produce deterministic diagnostics', () => {
	const request = [target('M31', [{ id: 'L', exposure: 300, count: 10 }], { pointing: M31 })]

	const reversed = scheduleSession(request, END, START)
	expect(reversed.blocks).toEqual([])
	expect(reversed.unscheduled).toEqual([{ targetId: 'M31', blockId: 'L', remainingFrames: 10, scheduledFrames: 0, reason: 'noWindow' }])
	expect(reversed.diagnostics.duration).toBe(0)
	expect(reversed.diagnostics.efficiency).toBe(0)
	expect(reversed.diagnostics.completeness).toBe(0)

	const empty = scheduleSession([], START, END)
	expect(empty.blocks).toEqual([])
	expect(empty.diagnostics.completeness).toBe(1)
	expect(empty.diagnostics.idle).toBeCloseTo(NIGHT, 6)

	const done = scheduleSession([target('M31', [{ id: 'L', exposure: 300, count: 0 }])], START, END)
	expect(done.blocks).toEqual([])
	expect(done.unscheduled).toEqual([])

	const outside = scheduleSession([target('M31', [{ id: 'L', exposure: 300, count: 1 }], { windows: [windowOf(-2 * HOUR, -HOUR)] })], START, END)
	expect(outside.unscheduled[0].reason).toBe('noWindow')

	// Unordered and overlapping windows are merged before fitting.
	const merged = scheduleSession([target('M31', [{ id: 'L', exposure: 600, count: 9 }], { windows: [windowOf(HOUR, 2.5 * HOUR), windowOf(0, 1.5 * HOUR)] })], START, END)
	expect(summary(merged)).toEqual([['L', 0, 1.5 * HOUR, 9]])

	expect(() => scheduleSession([target('A', [{ id: 'X', exposure: 1, count: 1 }]), target('B', [{ id: 'X', exposure: 1, count: 1 }])], START, END)).toThrow(RangeError)
	expect(() => scheduleSession([target('A', [{ id: 'X', exposure: 0, count: 1 }])], START, END)).toThrow(RangeError)
	expect(() => scheduleSession([target('A', [{ id: 'X', exposure: 1, count: 1.5 }])], START, END)).toThrow(TypeError)
})

test('scheduling is deterministic and does not mutate its inputs', () => {
	const targets = [
		target('A', [{ id: 'A1', exposure: 300, count: 30, divisible: true, maximumFrames: 6 }], { pointing: M31, priority: 2 }),
		target('B', [{ id: 'B1', exposure: 120, count: 40, divisible: true, maximumFrames: 10 }], { pointing: M42, priority: 2 }),
		target('C', [{ id: 'C1', exposure: 60, count: 30, notBefore: at(HOUR) }], { pointing: M42, windows: [windowOf(HOUR, 3 * HOUR)] }),
	]
	const options: ScheduleOptions = { costs: { slewRate: deg(2), slewSettle: 30, readout: 3, filterChange: 10 }, initial: { completedFrames: { A1: 6 } } }
	const snapshot = JSON.stringify(targets)

	const a = scheduleSession(targets, START, END, options)
	const b = scheduleSession(targets, START, END, options)
	expect(summary(a)).toEqual(summary(b))
	expect(a.diagnostics).toEqual(b.diagnostics)
	expect(JSON.stringify(targets)).toBe(snapshot)
	expect(options.initial?.completedFrames).toEqual({ A1: 6 })
	expectChronological(a)
	expect(a.unscheduled).toEqual([])
})
