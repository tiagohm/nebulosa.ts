import { expect, test } from 'bun:test'
import { type ExoplanetArchiveRow, exoplanetArchiveTransitEphemeris } from '../../../src/adapters/catalogs/exoplanet.archive'
import { Timescale } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'

// Rows of the NASA Exoplanet Archive `ps` table (TAP JSON numbers or CSV strings), queried 2026-10-15.

// WASP-12 b, Leonardi et al. 2024 (default_flag = 1), JSON.
const WASP12: ExoplanetArchiveRow = {
	pl_name: 'WASP-12 b',
	ra: 97.636645,
	dec: 29.6722662,
	pl_tranmid: 2457607.519305,
	pl_tranmiderr1: 0.000032,
	pl_tranmiderr2: -0.000032,
	pl_orbper: 1.091418901,
	pl_orbpererr1: 0.000000018,
	pl_orbpererr2: -0.000000018,
	pl_trandur: 3.001,
	pl_trandurerr1: 0.0043,
	pl_trandurerr2: -0.0043,
	pl_tsystemref: 'BJD-TDB',
}

// HD 189733 b, Cegla et al. 2016, CSV: a BJD_UTC epoch and a duration without errors.
const HD189733: ExoplanetArchiveRow = {
	pl_name: 'HD 189733 b',
	ra: '300.1821223',
	dec: '22.7097759',
	pl_tranmid: '2454279.43671400',
	pl_tranmiderr1: '0.00001500',
	pl_tranmiderr2: '-0.00001500',
	pl_orbper: '2.21857567000',
	pl_orbpererr1: '0.00000015000',
	pl_orbpererr2: '-0.00000015000',
	pl_trandur: '1.8270000',
	pl_trandurerr1: '',
	pl_trandurerr2: '',
	pl_tsystemref: 'BJD-UTC',
}

// HAT-P-7 b, Winn et al. 2009: an unqualified HJD.
const HATP7: ExoplanetArchiveRow = {
	pl_name: 'HAT-P-7 b',
	pl_tranmid: 2454731.67929,
	pl_tranmiderr1: 0.00043,
	pl_tranmiderr2: -0.00043,
	pl_orbper: 2.2047304,
	pl_orbpererr1: 0.0000024,
	pl_orbpererr2: -0.0000024,
	pl_trandur: 4.0056,
	pl_trandurerr1: 0.0648,
	pl_trandurerr2: -0.0648,
	pl_tsystemref: 'HJD',
}

test('a BJD_TDB row becomes a barycentric TDB ephemeris in days and radians', () => {
	const result = exoplanetArchiveTransitEphemeris(WASP12)
	if (!result.success) throw new Error(result.reason)

	expect(result.name).toBe('WASP-12 b')
	expect(result.assumedScale).toBe(false)
	expect(result.rightAscension).toBeCloseTo(deg(97.636645), 15)
	expect(result.declination).toBeCloseTo(deg(29.6722662), 15)

	const { ephemeris } = result
	expect(ephemeris.reference).toBe('barycentric')
	expect(ephemeris.epoch.scale).toBe(Timescale.TDB)
	expect(ephemeris.epoch.day + ephemeris.epoch.fraction).toBe(2457607.519305)
	expect(ephemeris.period).toBe(1.091418901)
	expect(ephemeris.duration).toBeCloseTo(3.001 / 24, 15)
	expect(ephemeris.epochUncertainty).toBe(0.000032)
	expect(ephemeris.periodUncertainty).toBe(0.000000018)
	expect(ephemeris.durationUncertainty).toBeCloseTo(0.0043 / 24, 18)
	expect(ephemeris.covariance).toBeUndefined()
})

test('a CSV BJD_UTC row keeps every epoch digit and leaves missing errors undefined', () => {
	const result = exoplanetArchiveTransitEphemeris(HD189733)
	if (!result.success) throw new Error(result.reason)

	const { ephemeris } = result
	expect(ephemeris.reference).toBe('barycentric')
	expect(ephemeris.epoch.scale).toBe(Timescale.UTC)
	expect(ephemeris.epoch.day).toBe(2454279)
	// 0.436714 is split from the integer day, so it carries 1e-17 d instead of the 4.7e-10 d of a double JD.
	expect(ephemeris.epoch.fraction).toBe(0.436714)
	expect(ephemeris.period).toBe(2.21857567)
	expect(ephemeris.durationUncertainty).toBeUndefined()
	expect(result.rightAscension).toBeCloseTo(deg(300.1821223), 15)
})

test('an unqualified HJD is heliocentric UTC and flagged as assumed', () => {
	const result = exoplanetArchiveTransitEphemeris(HATP7)
	if (!result.success) throw new Error(result.reason)

	expect(result.assumedScale).toBe(true)
	expect(result.ephemeris.reference).toBe('heliocentric')
	expect(result.ephemeris.epoch.scale).toBe(Timescale.UTC)
	expect(result.rightAscension).toBeUndefined()
	expect(result.declination).toBeUndefined()
})

test('time references ignore separators and case', () => {
	const scales: Record<string, readonly [Timescale, 'barycentric' | 'heliocentric', boolean]> = {
		BJD: [Timescale.TDB, 'barycentric', true],
		bjd_tdb: [Timescale.TDB, 'barycentric', false],
		'BJD/TDB': [Timescale.TDB, 'barycentric', false],
		'BJD-TT': [Timescale.TT, 'barycentric', false],
		'UTC-BJD': [Timescale.UTC, 'barycentric', false],
		'BJD-TCB': [Timescale.TCB, 'barycentric', false],
		'HJD-UTC': [Timescale.UTC, 'heliocentric', false],
		'HJD-TDB': [Timescale.TDB, 'heliocentric', false],
	}

	for (const [label, [scale, reference, assumed]] of Object.entries(scales)) {
		const result = exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tsystemref: label })
		if (!result.success) throw new Error(`${label}: ${result.reason}`)
		expect(result.ephemeris.epoch.scale).toBe(scale)
		expect(result.ephemeris.reference).toBe(reference)
		expect(result.assumedScale).toBe(assumed)
	}
})

test('rows that cannot give a transit ephemeris are rejected with a reason', () => {
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: null })).toEqual({ success: false, reason: 'missingEpoch' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_orbper: '' })).toEqual({ success: false, reason: 'missingPeriod' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_trandur: undefined })).toEqual({ success: false, reason: 'missingDuration' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tsystemref: null })).toEqual({ success: false, reason: 'missingTimeReference' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tsystemref: 'JD' })).toEqual({ success: false, reason: 'unsupportedTimeReference' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tsystemref: 'TJD-TDB' })).toEqual({ success: false, reason: 'unsupportedTimeReference' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: 'n/a' })).toEqual({ success: false, reason: 'invalidValue' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_orbpererr1: 'x' })).toEqual({ success: false, reason: 'invalidValue' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_orbper: -1 })).toEqual({ success: false, reason: 'invalidValue' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_trandur: 30 })).toEqual({ success: false, reason: 'invalidValue' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_trandur: 0 })).toEqual({ success: false, reason: 'invalidValue' })
})

test('non-finite epochs from external payloads are rejected', () => {
	// 400 nines match the decimal pattern but overflow a double to Infinity.
	for (const pl_tranmid of ['9'.repeat(400), `${'9'.repeat(400)}.5`, '1e309', '-1e309', 'Infinity', '-Infinity', 'NaN', Number.POSITIVE_INFINITY, Number.NaN]) {
		expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid })).toEqual({ success: false, reason: 'invalidValue' })
	}

	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: '' })).toEqual({ success: false, reason: 'missingEpoch' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: '  ' })).toEqual({ success: false, reason: 'missingEpoch' })

	// A long fraction keeps its integer day; exponent notation falls back to a double.
	const long = exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: '2457607.51930500000000000000000001' })
	if (!long.success) throw new Error(long.reason)
	expect(long.ephemeris.epoch.day).toBe(2457608)
	expect(long.ephemeris.epoch.fraction).toBe(0.519305 - 1)
	const exponent = exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid: '2.457607519305e6' })
	if (!exponent.success) throw new Error(exponent.reason)
	expect(exponent.ephemeris.epoch.day + exponent.ephemeris.epoch.fraction).toBe(2457607.519305)
})

test('a composite-parameter row reads pl_tranmid_systemref', () => {
	// WASP-12 b in `pscomppars` (queried 2026-10-15) has pl_tranmid_systemref and no pl_tsystemref.
	const composite = { ...WASP12, pl_tsystemref: undefined, pl_tranmid_systemref: 'BJD-TDB' }
	const result = exoplanetArchiveTransitEphemeris(composite, { timeReference: 'HJD' })
	if (!result.success) throw new Error(result.reason)
	expect(result.ephemeris.epoch.scale).toBe(Timescale.TDB)
	expect(result.ephemeris.reference).toBe('barycentric')
	expect(result.timeReferenceSource).toBe('pl_tranmid_systemref')

	const table = exoplanetArchiveTransitEphemeris(WASP12)
	if (!table.success) throw new Error(table.reason)
	expect(table.timeReferenceSource).toBe('pl_tsystemref')

	// Matching labels in both columns agree; different clocks or origins are never mixed.
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid_systemref: 'bjd_tdb' }).success).toBe(true)
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid_systemref: 'BJD-UTC' })).toEqual({ success: false, reason: 'conflictingTimeReference' })
	expect(exoplanetArchiveTransitEphemeris({ ...WASP12, pl_tranmid_systemref: 'HJD' })).toEqual({ success: false, reason: 'conflictingTimeReference' })
})

test('a row without any reference uses the supplied one', () => {
	const row = { ...WASP12, pl_tsystemref: undefined }
	const result = exoplanetArchiveTransitEphemeris(row, { timeReference: 'BJD-TDB' })
	if (!result.success) throw new Error(result.reason)
	expect(result.ephemeris.epoch.scale).toBe(Timescale.TDB)
	expect(result.assumedScale).toBe(false)
	expect(result.timeReferenceSource).toBe('option')
	expect(exoplanetArchiveTransitEphemeris(row)).toEqual({ success: false, reason: 'missingTimeReference' })
})
