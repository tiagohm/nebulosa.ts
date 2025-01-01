import { expect, test } from 'bun:test'
import { deg, mas } from './angle'
import { equatorial } from './astrometry'
import { star } from './star'
import { Timescale, timeYMDHMS } from './time'
import { kilometerPerSecond } from './velocity'

test('star', () => {
	const e = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)
	const dec = deg(41.2)
	// astropy works with pm_ra * cos(dec)
	const s = star(deg(10.625), dec, mas(2) / Math.cos(dec), mas(1), mas(10000), kilometerPerSecond(10), e)

	let cp = s.position
	expect(cp[0]).toBeCloseTo(15253.58664217385739903, 11)
	expect(cp[1]).toBeCloseTo(2861.52044579003495528, 12)
	expect(cp[2]).toBeCloseTo(13586.445386838409831398, 11)

	let sp = equatorial(cp)
	expect(sp[0]).toBeCloseTo(0.185441233024397523, 15)
	expect(sp[1]).toBeCloseTo(0.719075651821663775, 15)
	expect(sp[2]).toBeCloseTo(20626.480624709631229052, 11)

	cp = s.at(timeYMDHMS(2021, 10, 7, 12, 0, 0, Timescale.TCB))
	expect(cp[0]).toBeCloseTo(15255.14544970152201131, 11)
	expect(cp[1]).toBeCloseTo(2861.813076076006836956, 12)
	expect(cp[2]).toBeCloseTo(13587.83399008352716919, 11)

	sp = equatorial(cp)
	expect(sp[0]).toBeCloseTo(0.18544124590113148, 15)
	expect(sp[1]).toBeCloseTo(0.719075656665987051, 15)
	expect(sp[2]).toBeCloseTo(20628.588640913312701741, 11)
})
