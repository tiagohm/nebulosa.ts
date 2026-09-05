import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { designation, designationAliases, designations, isOpticalObservation, list, listAll, neocpObservations, observations, observationDesignation, observationIdentifier, observationToOrbitFitObservation, observationsToOrbitFit, observatories, observatory, observatoryItrsPosition, observatoryLocation, orbit, orbitCartesianState, orbitToKeplerOrbit, packMPCDesignation, parseADESObservation, parseADESPSV, parseMPC80, parseMPC80Lines, parseObservatoryCode, parseObservatoryCodes, primaryDesignation, queryObservations, unpackMPCDesignation, writeADESPSV, writeMPC80, writeMPC80Lines, writeObservatoryCode, type MPCObservation, type MPCOpticalObservation, type MPCOrbitSolution } from '../../../src/adapters/orbits/mpc'
import { Ellipsoid } from '../../../src/astronomy/observer/location'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { fitOrbit } from '../../../src/astronomy/orbits/fit'
import { Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ASEC2RAD, ECLIPTIC_J2000_MATRIX } from '../../../src/core/constants'
import { matIdentity, matMulVec, matTranspose } from '../../../src/math/linear-algebra/mat3'
import { vecLength } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'
import { kilometer, meter } from '../../../src/math/units/distance'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

function mpc80(line: string) {
	return line.padEnd(80).slice(0, 80)
}

function expectTimeClose(actual: { day: number; fraction: number; scale: number }, expected: { day: number; fraction: number; scale: number }, digits = 8) {
	expect(actual.scale).toBe(expected.scale)
	expect(timeSubtract(actual, expected)).toBeCloseTo(0, digits)
}

describe('designation helpers', () => {
	test('empty ids return without a network request', async () => {
		expect(await designations([])).toEqual([])
	})

	test('more than 100 ids is rejected', async () => {
		try {
			await designations(Array.from({ length: 101 }, (_, i) => `${i}`))
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(RangeError)
		}
	})

	test('primaryDesignation prefers permanent then provisional then IAU then name', () => {
		expect(
			primaryDesignation({
				query: 'Ceres',
				found: 1,
				name: 'Ceres',
				iauDesignation: '1',
				permanentId: '1',
				primaryProvisionalDesignation: 'A801 AA',
				packedSecondaryProvisionalDesignations: [],
				secondaryProvisionalDesignations: [],
			}),
		).toBe('1')
		expect(
			primaryDesignation({
				query: '2020 AB1',
				found: 1,
				iauDesignation: '2020 AB1',
				primaryProvisionalDesignation: '2020 AB1',
				packedSecondaryProvisionalDesignations: [],
				secondaryProvisionalDesignations: [],
			}),
		).toBe('2020 AB1')
	})

	test('designationAliases deduplicates and omits disambiguation', () => {
		expect(
			designationAliases({
				query: 'Ceres',
				found: 1,
				name: 'Ceres',
				permanentId: '1',
				packedPermanentId: '00001',
				iauDesignation: '1',
				orbfitName: '1',
				primaryProvisionalDesignation: 'A801 AA',
				packedPrimaryProvisionalDesignation: 'I01A00A',
				packedSecondaryProvisionalDesignations: ['I99O00F', 'I01A00A'],
				secondaryProvisionalDesignations: ['A899 OF', 'A801 AA'],
				disambiguation: [{ name: 'other' }],
			}),
		).toEqual(['1', '00001', 'A801 AA', 'I01A00A', 'Ceres', 'A899 OF', 'I99O00F'])
	})
})

describe.skipIf(SKIP)('designation network', () => {
	test('Ceres by name and numbered id', async () => {
		const byName = await designation('Ceres')
		const byNumber = await designation('1')
		expect(byName?.found).toBe(1)
		expect(byName?.name).toBe('Ceres')
		expect(byName?.permanentId).toBe('1')
		expect(byNumber?.permanentId).toBe('1')
		expect(byNumber?.name).toBe('Ceres')
	})

	test('2020 AB1 unpacked and packed', async () => {
		const unpacked = await designation('2020 AB1')
		const packed = await designation('K20A01B')
		expect(unpacked?.found).toBe(1)
		expect(unpacked?.primaryProvisionalDesignation).toBe('2020 AB1')
		expect(unpacked?.packedPrimaryProvisionalDesignation).toBe('K20A01B')
		expect(packed?.primaryProvisionalDesignation).toBe('2020 AB1')
	})

	test('multiple queries preserve input order', async () => {
		const results = await designations(['2020 AB1', 'Ceres', '2020 AB1'])
		expect(results.map((item) => item.query)).toEqual(['2020 AB1', 'Ceres', '2020 AB1'])
		expect(results[0]?.primaryProvisionalDesignation).toBe('2020 AB1')
		expect(results[1]?.name).toBe('Ceres')
		expect(results[2]?.primaryProvisionalDesignation).toBe('2020 AB1')
	})

	test('missing object has found 0 and high-level designation is undefined', async () => {
		const [raw] = await designations(['zzzznotanobject'])
		expect(raw?.found).toBe(0)
		expect(await designation('zzzznotanobject')).toBeUndefined()
	})

	test('Chiron is unique with comet dual status 95P', async () => {
		const chiron = await designation('Chiron')
		expect(chiron?.found).toBe(1)
		expect(chiron?.dualStatus?.permanentId).toBe('95P')
		expect(chiron?.permanentId).not.toBe('95P')
	})

	test('fuzzy Boriso is ambiguous', async () => {
		const [raw] = await designations(['Boriso'], { comparison: '%', group: 'Minor Planets' })
		expect(raw?.found).toBeGreaterThan(1)
		expect(await designation('Boriso', { comparison: '%', group: 'Minor Planets' })).toBeUndefined()
	})
})

describe('observatory', () => {
	const LINE_310 = '310 288.871640.739802+0.670574Minor Planet Center Test Code'

	test('parses and writes the published 310 flatfile line', () => {
		const parsed = parseObservatoryCode(LINE_310)
		expect(parsed.code).toBe('310')
		expect(parsed.name).toBe('Minor Planet Center Test Code')
		expect(toDeg(parsed.longitude ?? Number.NaN)).toBeCloseTo(288.87164, 5)
		expect(parsed.rhoCosPhi).toBeCloseTo(0.739802, 6)
		expect(parsed.rhoSinPhi).toBeCloseTo(0.670574, 6)
		expect(parsed.observationType).toBeUndefined()
		expect(writeObservatoryCode(parsed)).toBe(LINE_310)
	})

	test('parseObservatoryCodes skips blanks and rejects a line without a code', () => {
		expect(parseObservatoryCodes(`\n${LINE_310}\n\n`).map((item) => item.code)).toEqual(['310'])
		expect(() => parseObservatoryCodes('12')).toThrow()
	})

	test('writer refuses satellite-style records with no geometry', () => {
		expect(() => writeObservatoryCode({ code: '250', name: 'Hubble', oldNames: [] })).toThrow(RangeError)
	})

	test('ITRS of 310 is finite and the geocenter is undefined', () => {
		const parsed = parseObservatoryCode(LINE_310)
		const itrs = observatoryItrsPosition(parsed)
		expect(itrs).toBeDefined()
		expect(itrs?.every(Number.isFinite)).toBe(true)
		const location = observatoryLocation(parsed, Ellipsoid.IERS2010)
		expect(location).toBeDefined()
		const longitude = ((toDeg(location?.longitude ?? Number.NaN) % 360) + 360) % 360
		expect(longitude).toBeCloseTo(288.87164, 1)
		expect(observatoryItrsPosition({ code: '500', name: 'Geocentric', longitude: 0, rhoCosPhi: 0, rhoSinPhi: 0, oldNames: [] })).toBeUndefined()
		expect(observatoryItrsPosition({ code: '250', name: 'Hubble', oldNames: [] })).toBeUndefined()
	})
})

describe.skipIf(SKIP)('observatory network', () => {
	test('310 has longitude and rho', async () => {
		const site = await observatory('310')
		expect(site?.code).toBe('310')
		expect(site?.longitude).toBeDefined()
		expect(site?.rhoCosPhi).toBeDefined()
		expect(site?.observationType).toBe('optical')
	})

	test('250 is a satellite without ITRS geometry', async () => {
		const hubble = await observatory('250')
		expect(hubble?.observationType).toBe('satellite')
		expect(hubble?.usesTwoLineObservations).toBe(true)
		expect(observatoryItrsPosition(hubble!)).toBeUndefined()
	})

	test('500 is the geocenter and 311 is missing', async () => {
		const geocenter = await observatory('500')
		expect(observatoryItrsPosition(geocenter!)).toBeUndefined()
		expect(await observatory('311')).toBeUndefined()
	})

	test('observatories returns the full catalog', async () => {
		expect((await observatories()).length).toBeGreaterThan(2000)
	})
})

describe('ADES JSON', () => {
	test('optical with string ra/dec and rms in arcsec', () => {
		const observation = parseADESObservation({
			Obstype: 'optical',
			obstime: '2016-02-22T11:01:42.528Z',
			stn: 'F51',
			ra: '54.59613',
			dec: '-15.5',
			rmsra: '0.188',
			rmsdec: '0.2',
			permid: '1',
			disc: '*',
		})
		expect(observation.type).toBe('optical')
		if (observation.type !== 'optical') return
		expect(observation.station).toBe('F51')
		expect(observation.permanentId).toBe('1')
		expect(observation.discovery).toBe(true)
		expect(observation.time.scale).toBe(Timescale.UTC)
		expectTimeClose(observation.time, timeYMDHMS(2016, 2, 22, 11, 1, 42.528, Timescale.UTC))
		expect(toDeg(observation.rightAscension)).toBeCloseTo(54.59613, 6)
		expect(toDeg(observation.declination)).toBeCloseTo(-15.5, 6)
		expect(observation.raError).toBeCloseTo(0.188 * ASEC2RAD, 12)
		expect(observation.decError).toBeCloseTo(0.2 * ASEC2RAD, 12)
	})

	test('nulls become undefined and numeric ids stay strings', () => {
		const observation = parseADESObservation({
			obsTime: '2016-08-29T12:32:34Z',
			stn: 'F51',
			ra: 10,
			dec: 20,
			permID: '1234456',
			rmsRA: null,
			provID: null,
		})
		expect(observation.permanentId).toBe('1234456')
		expect(observation.provisionalId).toBeUndefined()
		if (observation.type === 'optical') expect(observation.raError).toBeUndefined()
	})

	test('spacecraft Gaia-style optical keeps ICRF_KM in AU', () => {
		const observation = parseADESObservation({
			Obstype: 'optical',
			obstime: '2019-07-26T05:49:32.000Z',
			stn: '258',
			ra: 354.378425,
			dec: -17.1234,
			sys: 'ICRF_KM',
			ctr: 399,
			pos1: '551363.13',
			pos2: '-1190783.85',
			pos3: '-650915.72',
		})
		expect(observation.type).toBe('optical')
		if (observation.type !== 'optical' || observation.observer?.kind !== 'spacecraft') throw new Error('expected spacecraft optical')
		expect(observation.observer.sys).toBe('ICRF_KM')
		expect(observation.observer.center).toBe(399)
		expect(observation.observer.position[0]).toBeCloseTo(kilometer(551363.13), 12)
	})

	test('offset, radar, occultation and extra 2022 keys', () => {
		const offset = parseADESObservation({
			obsType: 'offset',
			obsTime: '2016-02-22T11:01:42Z',
			stn: '500',
			deltaRA: '0.1',
			deltaDec: '-0.2',
			fltr: 'V',
			trkmpc: 'ignored-extra',
		})
		expect(offset.type).toBe('offset')
		const radar = parseADESObservation({
			obsType: 'radar',
			obsTime: '1975-01-22T04:30:00Z',
			stn: '251',
			delay: 150885360,
			doppler: -13,
			frq: 430,
			trx: '251',
			rcv: '251',
			com: 'S',
		})
		expect(radar.type).toBe('radar')
		if (radar.type === 'radar') {
			expect(radar.delay).toBeCloseTo(150.88536, 6)
			expect(radar.transmitFrequency).toBe(430e6)
			expect(radar.bounce).toBe('surface')
		}
		const occultation = parseADESObservation({
			obsType: 'occultation',
			obsTime: '2016-02-22T11:01:42Z',
			stn: '247',
			ra: 10,
			dec: 20,
		})
		expect(occultation.type).toBe('occultation')
	})

	test('invalid payload throws', () => {
		expect(() => parseADESObservation({})).toThrow()
		expect(() => parseADESObservation({ obsTime: '2016-02-22T11:01:42Z', stn: 'F51', obsType: 'optical' })).toThrow()
		expect(() => parseADESObservation({ obsTime: '2016-02-22T11:01:42Z', stn: 'F51', obsType: 'nope' })).toThrow()
		expect(() => parseADESObservation({ obsTime: '2016-02-22T11:01:42Z', stn: 'F51', ra: 'not-a-number', dec: 1 })).toThrow()
	})
})

describe('ADES PSV', () => {
	const SAMPLE = `# version=2017
# observatory
! mpcCode F51
! name Pan-STARRS 1
# submitter
! name P. Villa
! institution Ejercito Constitucionalista
permID |trkSub |mode|stn |obsTime                |ra         |dec        |rmsRA|rmsDec|rmsCorr|astCat|mag  |rmsMag|band|photCat|logSNR|notes|remarks
1234456|     aa| CCD|F51 |2016-08-29T12:32:34Z   |  0        | 90        |0.15 |0.13  | 0.21  | 2MASS|21.9 |0.25  |   w|  2MASS|0.775 |klmn |High winds affected tracking
1234457|     aa| CCD|F51 |2016-08-29T12:32:34Z   |  0.1      | 30.0      |0.15 |0.13  | 0.21  | 2MASS|21.9 |0.25  |   w|  2MASS|0.775 |klmn |High winds affected tracking
`

	test('parses context, pipes, empty-enough fields and CRLF', () => {
		const document = parseADESPSV(SAMPLE.replaceAll('\n', '\r\n'))
		expect(document.version).toBe('2017')
		expect(document.blocks).toHaveLength(1)
		expect(document.blocks[0]?.context?.observatory?.mpcCode).toBe('F51')
		expect(document.blocks[0]?.context?.submitter?.name).toBe('P. Villa')
		expect(document.blocks[0]?.observations).toHaveLength(2)
		const first = document.blocks[0]?.observations[0]
		expect(first?.permanentId).toBe('1234456')
		expect(first?.type).toBe('optical')
		if (first?.type === 'optical') {
			expect(first.rightAscension).toBeCloseTo(0, 12)
			expect(toDeg(first.declination)).toBeCloseTo(90, 12)
			expect(first.raError).toBeCloseTo(0.15 * ASEC2RAD, 12)
			expect(first.band).toBe('w')
		}
	})

	test('round-trips modeled PSV fields', () => {
		const document = parseADESPSV(SAMPLE)
		const written = writeADESPSV(document)
		const again = parseADESPSV(written)
		expect(again.version).toBe('2017')
		expect(again.blocks[0]?.observations).toHaveLength(2)
		const original = document.blocks[0]?.observations[1]
		const copy = again.blocks[0]?.observations[1]
		expect(copy?.permanentId).toBe(original?.permanentId)
		if (original?.type === 'optical' && copy?.type === 'optical') {
			expect(copy.rightAscension).toBeCloseTo(original.rightAscension, 10)
			expect(copy.declination).toBeCloseTo(original.declination, 10)
			expect(copy.raError).toBeCloseTo(original.raError ?? Number.NaN, 12)
		}
	})
})

describe('packed designations', () => {
	test('numbered minor planets', () => {
		expect(packMPCDesignation('1')).toBe('00001')
		expect(unpackMPCDesignation('00001')).toBe('1')
		expect(packMPCDesignation('3202')).toBe('03202')
		expect(packMPCDesignation('100000')).toBe('A0000')
		expect(unpackMPCDesignation('A0000')).toBe('100000')
		expect(packMPCDesignation('100345')).toBe('A0345')
		expect(packMPCDesignation('360017')).toBe('a0017')
		expect(packMPCDesignation('203289')).toBe('K3289')
		expect(packMPCDesignation('620000')).toBe('~0000')
		expect(unpackMPCDesignation('~0000')).toBe('620000')
		expect(packMPCDesignation('620061')).toBe('~000z')
		expect(packMPCDesignation('3140113')).toBe('~AZaz')
		expect(packMPCDesignation('15396335')).toBe('~zzzz')
	})

	test('provisional minor planets including the extended scheme', () => {
		expect(packMPCDesignation('2020 AB1')).toBe('K20A01B')
		expect(unpackMPCDesignation('K20A01B')).toBe('2020 AB1')
		expect(unpackMPCDesignation('J95X00A')).toBe('1995 XA')
		expect(unpackMPCDesignation('J95X01L')).toBe('1995 XL1')
		expect(unpackMPCDesignation('J95F13B')).toBe('1995 FB13')
		expect(unpackMPCDesignation('J98SA8Q')).toBe('1998 SQ108')
		expect(unpackMPCDesignation('K08Aa0A')).toBe('2008 AA360')
		expect(unpackMPCDesignation('K07Tf8A')).toBe('2007 TA418')
		expect(unpackMPCDesignation('K25Dz9Z')).toBe('2025 DZ619')
		expect(unpackMPCDesignation('_PD0000')).toBe('2025 DA620')
		expect(packMPCDesignation('2025 DA620')).toBe('_PD0000')
		expect(unpackMPCDesignation('_QC0000')).toBe('2026 CA620')
		expect(unpackMPCDesignation('PLS2040')).toBe('2040 P-L')
		expect(packMPCDesignation('2040 P-L')).toBe('PLS2040')
		expect(packMPCDesignation('3138 T-1')).toBe('T1S3138')
	})

	test('comets and natural satellites', () => {
		expect(unpackMPCDesignation('J95A010')).toBe('1995 A1')
		expect(packMPCDesignation('1995 A1')).toBe('J95A010')
		expect(unpackMPCDesignation('J94P01b')).toBe('1994 P1-B')
		expect(unpackMPCDesignation('K88AA30')).toBe('2088 A103')
		expect(packMPCDesignation('P/2023 BA')).toBe('PK23B00A')
		expect(unpackMPCDesignation('J013S')).toBe('J 13')
		expect(packMPCDesignation('J 13')).toBe('J013S')
	})
})

describe('MPC80', () => {
	test('numbered optical line', () => {
		const line = mpc80('00001         C2000 01 01.00000000 00 00.000+00 00 00.00                     500')
		const observation = parseMPC80(line)
		expect(observation.permanentId).toBe('1')
		expect(observation.type).toBe('optical')
		if (observation.type !== 'optical') return
		expect(observation.rightAscension).toBeCloseTo(0, 10)
		expect(observation.declination).toBeCloseTo(0, 10)
		expect(observation.station).toBe('500')
		expect(writeMPC80(observation)).toBe(line)
	})

	test('provisional packed, discovery asterisk, note A, magnitude and band', () => {
		const chars = Array.from({ length: 80 }, () => ' ')
		const put = (start1: number, text: string) => {
			for (let i = 0; i < text.length; i++) chars[start1 - 1 + i] = text[i]!
		}
		put(6, 'K20A01B')
		put(13, '*')
		put(14, 'A')
		put(15, 'C')
		put(16, '2020 01 01.123456')
		put(33, '10 11 12.345')
		put(45, '-01 02 03.40')
		put(66, ' 18.3V')
		put(78, 'F51')
		const line = chars.join('')
		const observation = parseMPC80(line)
		expect(observation.provisionalId).toBe('2020 AB1')
		expect(observation.discovery).toBe(true)
		expect(observation.programCode).toBe('A')
		if (observation.type !== 'optical') throw new Error('expected optical')
		expect(observation.magnitude).toBeCloseTo(18.3, 5)
		expect(observation.band).toBe('V')
		expect(toDeg(observation.declination)).toBeCloseTo(-1.034277, 4)
	})

	test('RA wrap and declination overflow', () => {
		const wrapped = parseMPC80(mpc80('00001         C2000 01 01.00000023 59 59.999+00 00 00.00                     500'))
		if (wrapped.type !== 'optical') throw new Error('expected optical')
		const written = writeMPC80({ ...wrapped, rightAscension: deg(360) - 1e-18 })
		expect(written.slice(32, 44).startsWith('00') || written.slice(32, 44).startsWith('23')).toBe(true)
		expect(() =>
			writeMPC80({
				...wrapped,
				declination: deg(90.1),
			}),
		).toThrow(RangeError)
		expect(written).toBe('00001         C2000 01 01.00000000 00 00.000+00 00 00.00                     500')
	})

	test('Hubble two-line satellite example', () => {
		const text = `${mpc80('     T1S1222  S1995 10 19.53839 23 45 35.737+09 09 38.13                     250')}
${mpc80('     T1S1222  s1995 10 19.53839 1 + 5530.3041 - 4255.1515 -  550.2319        250')}`
		const [observation] = parseMPC80Lines(text)
		expect(observation?.provisionalId).toBe('1222 T-1')
		expect(observation?.type).toBe('optical')
		if (observation?.type !== 'optical' || observation.observer?.kind !== 'spacecraft') throw new Error('expected HST optical')
		expect(observation.observer.sys).toBe('ICRF_KM')
		expect(observation.observer.position[0]).toBeCloseTo(kilometer(5530.3041), 8)
		expect(observation.station).toBe('250')
		const roundTrip = parseMPC80Lines(writeMPC80Lines([observation]))
		const copy = roundTrip[0]
		expect(copy?.type === 'optical' && copy.observer?.kind).toBe('spacecraft')
	})

	test('Gaia two-line satellite uses km type 1', () => {
		const text = `${mpc80('z9987K06UJ8Y  S2019 07 26.24274223 37 30.822-17 07 24.24                ~3GcZ258')}
${mpc80('z9987K06UJ8Y  s2019 07 26.2427421 + 551363.13 -1190783.85 - 650915.72   ~3GcZ258')}`
		const [observation] = parseMPC80Lines(text)
		if (observation?.type !== 'optical' || observation.observer?.kind !== 'spacecraft') throw new Error('expected Gaia optical')
		expect(observation.observer.sys).toBe('ICRF_KM')
		expect(observation.observer.position[0]).toBeCloseTo(kilometer(551363.13), 6)
	})

	test('roving 247 two-line', () => {
		const first = mpc80('     K20A01B  V2020 01 01.00000000 00 00.000+00 00 00.00                     247')
		const second = mpc80('     K20A01B  v2020 01 01.0000001  288.8716  +42.3600    690                 247')
		const [observation] = parseMPC80Lines(`${first}\n${second}`)
		if (observation?.type !== 'optical' || observation.observer?.kind !== 'geodetic') throw new Error('expected roving optical')
		expect(observation.observer.sys).toBe('WGS84')
		expect(toDeg(observation.observer.longitude)).toBeCloseTo(288.8716, 4)
		expect(observation.observer.elevation).toBeCloseTo(meter(690), 12)
	})

	test('radar two-line 00433 example and orphan second line', () => {
		const first = mpc80('00433         R1975 01 22.187500  150885360    -         13     430 251       251')
		const second = mpc80('00433         r1975 01 22.187500S        15              20         251       251')
		const [observation] = parseMPC80Lines(`${first}\n${second}`)
		expect(observation?.type).toBe('radar')
		if (observation?.type !== 'radar') return
		expect(observation.permanentId).toBe('433')
		expect(observation.bounce).toBe('surface')
		expect(observation.delay).toBeCloseTo(150.88536, 5)
		expect(() => parseMPC80(second)).toThrow()
		expect(() => parseMPC80Lines(second)).toThrow()
	})

	test('parse then write then parse keeps RA/Dec', () => {
		const line = mpc80('00001         C2000 01 01.25000012 30 00.000+45 00 00.00  12.3 R          500')
		const parsed = parseMPC80(line)
		const again = parseMPC80(writeMPC80(parsed).split('\n')[0] ?? '')
		if (parsed.type !== 'optical' || again.type !== 'optical') throw new Error('expected optical')
		expect(again.rightAscension).toBeCloseTo(parsed.rightAscension, 8)
		expect(again.declination).toBeCloseTo(parsed.declination, 8)
		expect(writeMPC80(parsed).split('\n')[0]?.length).toBe(80)
	})
})

describe.skipIf(SKIP)('observations network', () => {
	test('2020 AB1 ADES_DF is optical with finite RA/Dec', async () => {
		const items = await observations('2020 AB1')
		expect(items.length).toBeGreaterThan(0)
		const first = items.find(isOpticalObservation)
		expect(first).toBeDefined()
		expect(Number.isFinite(first?.rightAscension)).toBe(true)
		expect(Number.isFinite(first?.declination)).toBe(true)
	})

	test('OBS80 lines are 80 characters and OBS_DF carries obs80', async () => {
		const payload = await queryObservations('2020 AB1', { outputFormats: ['OBS80', 'OBS_DF'] })
		const lines = payload.obs80?.split('\n').filter((line) => line.trim()) ?? []
		expect(lines.length).toBeGreaterThan(0)
		expect(lines[0]?.length).toBe(80)
		expect(payload.obsDf?.[0]?.obs80.length).toBe(80)
	})

	test('missing designation is an empty high-level list', async () => {
		expect(await observations('zzzznotanobject')).toEqual([])
	})
})

describe('NEOCP', () => {
	test('parses a local ADES_DF fixture', () => {
		const observation = parseADESObservation({
			Obstype: 'optical',
			trksub: 'A118xu6',
			obstime: '2024-01-01T00:00:00Z',
			stn: 'F51',
			ra: 10.5,
			dec: -5.25,
			rmsra: 0.3,
			rmsdec: 0.3,
		})
		expect(observation.trackletSubmissionId).toBe('A118xu6')
		expect(observation.type).toBe('optical')
	})
})

describe.skipIf(SKIP)('NEOCP network', () => {
	test('unknown tracklet is empty', async () => {
		expect(await neocpObservations('zzzzzz')).toEqual([])
	})
})

describe('orbits', () => {
	function solution(overrides: Partial<MPCOrbitSolution> = {}): MPCOrbitSolution {
		return {
			car: {
				coefficientNames: ['x', 'y', 'z', 'vx', 'vy', 'vz'],
				coefficients: [2.7, 0.1, 0.2, 0, 0.01, 0],
			},
			epochData: { epoch: 60000, timeForm: 'MJD', timeSystem: 'TDT' },
			systemData: { referenceSystem: 'Ecliptic', referenceFrame: 'ICRF' },
			...overrides,
		}
	}

	test('equatorial CAR uses identity rotation', () => {
		const equatorial = solution({ systemData: { referenceSystem: 'Equatorial', referenceFrame: 'ICRF' } })
		const kepler = orbitToKeplerOrbit(equatorial)
		const state = orbitCartesianState(equatorial)
		expect(kepler).toBeDefined()
		expect(state?.position).toEqual([2.7, 0.1, 0.2])
		const propagated = kepler!.at(state!.epoch)[0]
		expect(propagated[0]).toBeCloseTo(2.7, 12)
		expect(propagated[1]).toBeCloseTo(0.1, 12)
		expect(propagated[2]).toBeCloseTo(0.2, 12)
	})

	test('ecliptic CAR applies the default ecliptic-to-equatorial rotation', () => {
		const ecliptic = solution()
		const kepler = orbitToKeplerOrbit(ecliptic)!
		const state = orbitCartesianState(ecliptic)!
		const expected = matMulVec(matTranspose(ECLIPTIC_J2000_MATRIX), state.position)
		const propagated = kepler.at(state.epoch)[0]
		expect(propagated[0]).toBeCloseTo(expected[0], 12)
		expect(propagated[1]).toBeCloseTo(expected[1], 12)
		expect(propagated[2]).toBeCloseTo(expected[2], 12)
	})

	test('natural satellites and malformed CAR names are undefined', () => {
		expect(orbitToKeplerOrbit(solution({ categorization: { objectTypeInt: 30 } }))).toBeUndefined()
		expect(
			orbitCartesianState(
				solution({
					car: { coefficientNames: ['q', 'e', 'i', 'node', 'argperi', 'peri_time'], coefficients: [1, 0, 0, 0, 0, 0] },
				}),
			),
		).toBeUndefined()
	})
})

describe.skipIf(SKIP)('orbits network', () => {
	test('Ceres has an ecliptic CAR state and a Kepler orbit', async () => {
		const ceres = await orbit('Ceres')
		expect(ceres).toBeDefined()
		expect(ceres?.systemData?.referenceSystem).toBe('Ecliptic')
		const state = orbitCartesianState(ceres!)
		expect(state?.epoch.scale).toBe(Timescale.TT)
		expect(state?.position.every(Number.isFinite)).toBe(true)
		expect(state?.velocity.every(Number.isFinite)).toBe(true)
		expect(vecLength(state!.position)).toBeGreaterThan(2.5)
		expect(vecLength(state!.position)).toBeLessThan(3.2)
		const kepler = orbitToKeplerOrbit(ceres!)
		expect(toDeg(kepler!.inclination)).toBeCloseTo(10.59, 0)
	})

	test('Sedna exists, misses and Lysithea do not become Kepler orbits', async () => {
		expect(await orbit('Sedna')).toBeDefined()
		expect(await orbit('zzzznotanobject')).toBeUndefined()
		expect(orbitToKeplerOrbit((await orbit('Lysithea')) ?? { categorization: { objectTypeInt: 30 } })).toBeUndefined()
	})
})

describe.skipIf(SKIP)('list network', () => {
	test('neos like 2010% respects the limit', async () => {
		const result = await list('neos', { like: '2010%', limit: 2 })
		expect(result.items).toHaveLength(2)
		expect(result.items[0]?.unpackedPrimaryProvisionalDesignation?.startsWith('2010')).toBe(true)
	}, 30000)

	test('impacted and dual-status expose their extra fields', async () => {
		const impacted = await list('impacted', { limit: 1 })
		expect(impacted.items[0]?.impactJulianDate).toBeGreaterThan(0)
		const dual = await list('dual-status', { limit: 1 })
		expect(dual.items[0]?.permanentIdComet ?? dual.items[0]?.unpackedPrimaryProvisionalDesignationComet).toBeDefined()
	})

	test('listAll paginates up to maxItems', async () => {
		const items = await listAll('neos', { like: '2010%', limit: 2, maxItems: 5 })
		expect(items).toHaveLength(5)
		const ids = items.map((item) => item.unpackedPrimaryProvisionalDesignation)
		expect(new Set(ids).size).toBe(5)
	}, 30000)
})

describe('listAll guards', () => {
	test('maxItems is required to be a positive integer', async () => {
		try {
			await listAll('neos', { maxItems: 0 })
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
		}
	})
})

describe('orbit fit adapter', () => {
	const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
	const TRUE_ORBIT = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, EPOCH, undefined, matIdentity())

	function syntheticOptical(index: number): MPCOpticalObservation {
		const time = timeShift(EPOCH, (index - 5) * 8)
		const observerPosition = [Math.cos(index), Math.sin(index), 0.04] as const
		const position = TRUE_ORBIT.at(time)[0]
		const x = position[0] - observerPosition[0]
		const y = position[1] - observerPosition[1]
		const z = position[2] - observerPosition[2]
		const range = Math.hypot(x, y, z)
		return {
			type: 'optical',
			time,
			station: '500',
			rightAscension: Math.atan2(y, x),
			declination: Math.asin(z / range),
			raError: ASEC2RAD,
			decError: ASEC2RAD,
		}
	}

	test('rmsRA of 1 arcsec is raErr without an extra cos(dec)', () => {
		const observation = syntheticOptical(0)
		const fitted = observationToOrbitFitObservation(observation, [1, 0, 0])
		expect(fitted.raErr).toBe(ASEC2RAD)
		expect(fitted.decErr).toBe(ASEC2RAD)
	})

	test('non-optical and unresolved observers are rejected, not dropped', () => {
		const optical = syntheticOptical(0)
		const radar: MPCObservation = { type: 'radar', time: EPOCH, station: '251' }
		const result = observationsToOrbitFit([optical, radar], (time, observation) => (observation.station === '500' ? [1, 0, 0] : undefined))
		expect(result.observations).toHaveLength(1)
		expect(result.rejected).toEqual([radar])
		expect(observationDesignation(optical)).toBeUndefined()
		expect(observationIdentifier({ ...optical, observationId: 'abc' })).toBe('abc')
	})

	test('a coherent optical set converges', () => {
		const observations = Array.from({ length: 12 }, (_, i) => syntheticOptical(i))
		const input = observationsToOrbitFit(observations, (_, observation) => {
			const index = observations.indexOf(observation)
			return [Math.cos(index), Math.sin(index), 0.04]
		})
		const result = fitOrbit(input.observations, EPOCH, TRUE_ORBIT.position, TRUE_ORBIT.velocity)
		expect(result.converged).toBe(true)
		expect(result.rms).toBeLessThan(1e-8)
	})
})
