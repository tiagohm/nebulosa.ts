import { describe, expect, test } from 'bun:test'
import { coneSearch, coneSearchUrl, parseSkybotResponse, SKYBOT_MAX_EPOCH, SKYBOT_MAX_RADIUS, SKYBOT_MIN_EPOCH } from '../../../src/adapters/orbits/skybot'
import { time } from '../../../src/astronomy/time/time'
import { ASEC2RAD } from '../../../src/core/constants'
import { deg, hour, toDeg, toHour } from '../../../src/math/units/angle'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

// Three records of a real answer of the cone search (basic JSON output) around RA 150°, Dec +12° on JD 2461055.5, recorded
// on 2026-10-28, without their ssodnet links.
const RESPONSE = JSON.parse(
	'[{"Name":"2017 YJ66","RA (hms)":"09 59 43.2242","DEC (dms)":"+11 58 59.134","Class":"MB>Inner","VMag (mag)":22.2,"Err (arcsec)":0.234,"d (arcsec)":253.559,"dRA (arcsec\\/h)":-17.0683,"dDEC (arcsec\\/h)":7.9175,"dg (ua)":1.49629486858,"dh (ua)":2.38012794723},{"Num":172438,"Name":"2003 QW37","RA (hms)":"09 59 47.5990","DEC (dms)":"+12 05 21.614","Class":"MB>Inner","VMag (mag)":21.1,"Err (arcsec)":0.026,"d (arcsec)":369.501,"dRA (arcsec\\/h)":-25.0237,"dDEC (arcsec\\/h)":5.1714,"dg (ua)":1.8059505837,"dh (ua)":2.68273077267},{"Name":"2023 JW18","RA (hms)":"10 00 5.8322","DEC (dms)":"+12 13 12.536","Class":"Centaur","VMag (mag)":23.3,"Err (arcsec)":45.164,"d (arcsec)":797.143,"dRA (arcsec\\/h)":-25.7405,"dDEC (arcsec\\/h)":0.8072,"dg (ua)":6.37693681473,"dh (ua)":7.21873291281}]',
) as unknown

describe('parse', () => {
	test('records in radians, AU, and days', () => {
		const [first, numbered, centaur] = parseSkybotResponse(RESPONSE)

		expect(first.name).toBe('2017 YJ66')
		expect(first.number).toBeUndefined()
		expect(first.class).toBe('MB>Inner')
		expect(toHour(first.rightAscension)).toBeCloseTo(9 + 59 / 60 + 43.2242 / 3600, 9)
		expect(toDeg(first.declination)).toBeCloseTo(11 + 58 / 60 + 59.134 / 3600, 9)
		expect(first.magnitude).toBe(22.2)
		expect(first.positionError).toBeCloseTo(0.234 * ASEC2RAD, 15)
		expect(first.distanceFromCenter).toBeCloseTo(253.559 * ASEC2RAD, 15)
		expect(first.motionRightAscension).toBeCloseTo(-17.0683 * 24 * ASEC2RAD, 15)
		expect(first.motionDeclination).toBeCloseTo(7.9175 * 24 * ASEC2RAD, 15)
		expect(first.distance).toBe(1.49629486858)
		expect(first.heliocentricDistance).toBe(2.38012794723)
		expect(numbered.number).toBe(172438)
		expect(centaur.class).toBe('Centaur')
		expect(toDeg(centaur.positionError!) * 3600).toBeCloseTo(45.164, 9)
	})

	test('an empty answer has no object', () => {
		expect(parseSkybotResponse(undefined)).toEqual([])
		expect(parseSkybotResponse('')).toEqual([])
		expect(parseSkybotResponse([])).toEqual([])
	})

	test('a malformed answer is refused', () => {
		expect(() => parseSkybotResponse({ error: 'x' })).toThrow('not an array')
		expect(() => parseSkybotResponse([1])).toThrow('not an object')
		expect(() => parseSkybotResponse([{ 'RA (hms)': '10 00 00', 'DEC (dms)': '+12 00 00' }])).toThrow('Name')
		expect(() => parseSkybotResponse([{ Name: 'a', 'RA (hms)': 'north', 'DEC (dms)': '+12 00 00' }])).toThrow('sexagesimal')
		expect(() => parseSkybotResponse([{ Name: 'a', 'RA (hms)': '10 00 00', 'DEC (dms)': '+12 00 00', 'VMag (mag)': 'bright' }])).toThrow('VMag')
	})
})

describe('request', () => {
	test('the parameters of the non-standard interface', () => {
		const url = new URL(coneSearchUrl(Date.UTC(2026, 0, 15), hour(10), deg(12), deg(0.25), { observer: 'I41', objects: { asteroids: true, planets: false, comets: true }, maxPositionError: 60 * ASEC2RAD }))

		expect(url.origin + url.pathname).toBe('https://ssp.imcce.fr/webservices/skybot/api/conesearch.php')
		expect(Number(url.searchParams.get('-ep'))).toBe(2461055.5)
		expect(Number(url.searchParams.get('-ra'))).toBeCloseTo(150, 9)
		expect(Number(url.searchParams.get('-dec'))).toBeCloseTo(12, 9)
		expect(Number(url.searchParams.get('-rd'))).toBeCloseTo(0.25, 9)
		expect(url.searchParams.get('-mime')).toBe('json')
		expect(url.searchParams.get('-output')).toBe('basic')
		expect(url.searchParams.get('-observer')).toBe('I41')
		expect(url.searchParams.get('-objFilter')).toBe('101')
		expect(Number(url.searchParams.get('-filter'))).toBeCloseTo(60, 9)
	})

	test('the geocenter and every class by default, and a toolkit time as its Julian day', () => {
		const url = new URL(coneSearchUrl(time(2461055, 0.5), 0, 0, deg(1)))
		expect(url.searchParams.get('-ep')).toBe('2461055.5')
		expect(url.searchParams.get('-observer')).toBe('500')
		expect(url.searchParams.get('-objFilter')).toBe('111')
		expect(url.searchParams.has('-filter')).toBeFalse()
	})

	test('limits of the service', () => {
		expect(toDeg(SKYBOT_MAX_RADIUS)).toBeCloseTo(10, 12)
		expect(SKYBOT_MIN_EPOCH).toBe(2411320)
		expect(SKYBOT_MAX_EPOCH).toBe(2473540)
	})
})

describe.skipIf(SKIP)('cone search', () => {
	test('asteroids near the ecliptic', async () => {
		const objects = await coneSearch(Date.UTC(2026, 0, 15), hour(10), deg(12), deg(0.25), { objects: { asteroids: true, planets: false, comets: true } })
		expect(objects.length).toBeGreaterThan(0)
		for (const object of objects) expect(object.distanceFromCenter!).toBeLessThanOrEqual(deg(0.25) + ASEC2RAD)
	}, 60000)

	test('an empty field', async () => {
		expect(await coneSearch(Date.UTC(2026, 0, 15), hour(10), deg(85), deg(0.01))).toEqual([])
	}, 60000)
})
