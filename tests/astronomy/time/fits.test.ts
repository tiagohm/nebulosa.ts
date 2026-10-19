import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { itrs } from '../../../src/astronomy/coordinates/itrs'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { exposureInterval } from '../../../src/astronomy/time/exposure'
import { FITS_TIME_KEYWORDS, type FitsTimeMetadata, fitsExposure, formatFitsDateTime, readFitsTime, writeFitsTime } from '../../../src/astronomy/time/fits'
import { type Time, Timescale, tai, tcb, tdb, timeSubtract, timeToDate, timeYMDHMS, tt } from '../../../src/astronomy/time/time'
import { DAYSEC } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { FitsKeywordReader, FitsKeywordWriter, type FitsHeader, readFits } from '../../../src/io/formats/fits/fits'
import { deg } from '../../../src/math/units/angle'
import { meter, toMeter } from '../../../src/math/units/distance'
import { download } from '../../download'

await download('NGC3372-16.1.fit')

// Seconds from a to b, measured on TAI.
function seconds(a: Time, b: Time) {
	return timeSubtract(b, a, Timescale.TAI) * DAYSEC
}

// Diagnostic kinds and keywords as compact strings.
function findings(metadata: FitsTimeMetadata) {
	return metadata.diagnostics.map((e) => `${e.kind}:${e.keyword}`)
}

describe('real fixture', () => {
	// PixInsight header: TIMESYS = 'UTC', DATE-OBS/DATE-END 30 s apart, EXPTIME = EXPOSURE = 30, no site.
	test('reads the PixInsight timing of NGC3372-16.1.fit', async () => {
		await using source = fileHandleSource(await fs.open('data/NGC3372-16.1.fit'))
		const fits = (await readFits(source))!
		const metadata = readFitsTime(fits.hdus[0].header)

		expect(metadata.timeSystem).toBe('UTC')
		expect(metadata.scale).toBe(Timescale.UTC)
		expect(metadata.referencePosition).toBe('topocenter')
		expect(metadata.observation).toBe(metadata.start)
		expect(metadata.start!.keyword).toBe('DATE-OBS')
		expect(metadata.start!.resolution).toBeCloseTo(0.001, 15)
		expect(metadata.end!.keyword).toBe('DATE-END')
		expect(metadata.exposure).toBe(30)
		expect(metadata.exposureKeyword).toBe('EXPTIME')
		expect(metadata.location).toBeUndefined()
		expect(findings(metadata)).toEqual(['defaulted:TREFPOS', 'missing:OBSGEO-X', 'assumed:DATE-OBS'])

		// Astropy 7.1.0: Time('2023-01-15T01:27:05.460', scale='utc').tt -> jd1 2459960.0, jd2 -0.4387193981481482.
		const start = tt(metadata.start!.time)
		expect(start.day).toBe(2459960)
		expect(start.fraction).toBeCloseTo(-0.4387193981481482, 14)

		const interval = exposureInterval(fitsExposure(metadata)!)
		expect(interval.duration).toBeCloseTo(30, 9)
		expect(timeToDate(interval.midpoint)).toEqual([2023, 1, 15, 1, 27, 20, 460])
	})
})

describe('time scale and reference position', () => {
	test('missing TIMESYS defaults to UTC at the topocenter', () => {
		const metadata = readFitsTime({ 'DATE-BEG': '2024-03-10T03:00:00' })
		expect(metadata.timeSystem).toBe('UTC')
		expect(metadata.start!.time.scale).toBe(Timescale.UTC)
		expect(findings(metadata)).toEqual(['defaulted:TIMESYS', 'defaulted:TREFPOS', 'missing:OBSGEO-X'])
	})

	test('explicit TT, TDB, and TCG keep their scale and default reference position', () => {
		const ttMetadata = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:01:09.184' })
		expect(ttMetadata.scale).toBe(Timescale.TT)
		expect(ttMetadata.referencePosition).toBe('geocenter')
		expect(ttMetadata.diagnostics).toBeEmpty()
		expect(timeToDate(ttMetadata.start!.time)).toEqual([2024, 3, 10, 3, 1, 9, 184])

		// A TDB value without TREFPOS refers to the barycenter (FITS 4.0 §4.4.2.2), and is returned as is.
		const tdbMetadata = readFitsTime({ TIMESYS: 'TDB', 'MJD-AVG': 60379.125800757975 })
		expect(tdbMetadata.scale).toBe(Timescale.TDB)
		expect(tdbMetadata.referencePosition).toBe('barycenter')
		expect(tdbMetadata.midpoint!.time.scale).toBe(Timescale.TDB)
		expect(tdbMetadata.midpoint!.time.location).toBeUndefined()
		expect(findings(tdbMetadata)).toEqual(['defaulted:TREFPOS'])
		// Astropy 7.1.0: Time('2024-03-10T03:00:00', scale='utc').tdb.mjd = 60379.125800757975.
		expect(seconds(timeYMDHMS(2024, 3, 10, 3, 0, 0, Timescale.UTC), tdbMetadata.midpoint!.time)).toBeCloseTo(0, 5)

		expect(readFitsTime({ TIMESYS: 'TCG' }).referencePosition).toBe('geocenter')
	})

	test('the coordinate-time default names its departure from the TREFPOS keyword default', () => {
		const message = (header: FitsHeader) => readFitsTime(header).diagnostics.find((e) => e.keyword === 'TREFPOS')!.message
		expect(message({ TIMESYS: 'TDB' })).toContain('§4.4.2.2')
		expect(message({ TIMESYS: 'TDB' })).toContain('TOPOCENTER default of §9.2.3')
		expect(message({ TIMESYS: 'TCB' })).toContain('BARYCENTER')
		expect(message({ TIMESYS: 'TCG' })).toContain('GEOCENTER')
		expect(message({ TIMESYS: 'TT' })).toBe('TREFPOS is absent; TOPOCENTER is assumed (FITS 4.0 §9.2.3)')
		expect(message({ TIMESYS: 'UTC' })).toBe('TREFPOS is absent; TOPOCENTER is assumed (FITS 4.0 §9.2.3)')

		// A declared position always prevails over the scale convention.
		const declared = readFitsTime({ TIMESYS: 'TDB', TREFPOS: 'TOPOCENTER', 'OBSGEO-X': 1838458, 'OBSGEO-Y': -5259021, 'OBSGEO-Z': -3099890, 'DATE-BEG': '2026-01-01T00:00:00' })
		expect(declared.referencePosition).toBe('topocenter')
		expect(findings(declared)).toEqual(['incompatible:TREFPOS'])
		expect(readFitsTime({ TIMESYS: 'TT', TREFPOS: 'BARYCENTER' }).referencePosition).toBe('barycenter')
	})

	test('incompatible scale and reference position combinations are flagged', () => {
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'BARYCENTER', 'DATE-BEG': '2024-03-10T03:00:00' }))).toEqual(['incompatible:TREFPOS'])
		expect(findings(readFitsTime({ TIMESYS: 'TDB', TREFPOS: 'TOPOCENTER', 'DATE-BEG': '2024-03-10T03:00:00' }))).toEqual(['incompatible:TREFPOS', 'missing:OBSGEO-X'])
		// Only the first three characters are significant.
		expect(readFitsTime({ TIMESYS: 'TDB', TREFPOS: 'BARYCENT' }).referencePosition).toBe('barycenter')
	})

	test('synonyms, realizations, and the legacy TIMEREF', () => {
		const metadata = readFitsTime({ TIMESYS: 'TT(BIPM08)', TREFPOS: 'GEO' })
		expect(metadata.timeSystem).toBe('TT')
		expect(metadata.realization).toBe('BIPM08')

		const tdt = readFitsTime({ TIMESYS: 'TDT', TREFPOS: 'TOPOCENTER', 'OBSGEO-X': 1838458, 'OBSGEO-Y': -5259021, 'OBSGEO-Z': -3099890, 'DATE-OBS': '2024-03-10T03:00:00' })
		expect(tdt.scale).toBe(Timescale.TT)
		expect(findings(tdt)).toEqual(['nonStandard:TIMESYS', 'assumed:DATE-OBS'])

		const legacy = readFitsTime({ TIMESYS: 'TDB', TIMEREF: 'SOLARSYSTEM' })
		expect(legacy.referencePosition).toBe('barycenter')
		expect(findings(legacy)).toEqual(['nonStandard:TIMEREF', 'missing:DATE-OBS'])
	})

	test('GPS readings are carried on TAI, 19 s ahead', () => {
		const metadata = readFitsTime({ TIMESYS: 'GPS', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00' })
		expect(metadata.timeSystem).toBe('GPS')
		expect(metadata.scale).toBe(Timescale.TAI)
		expect(timeToDate(metadata.start!.time)).toEqual([2024, 3, 10, 3, 0, 19, 0])
	})

	test('LOCAL and unrecognized scales return no instant', () => {
		for (const scale of ['LOCAL', 'MET', 7]) {
			const metadata = readFitsTime({ TIMESYS: scale, 'DATE-OBS': '2024-03-10T03:00:00', 'MJD-OBS': 60379.125, TSTART: 10 })
			expect(metadata.scale).toBeUndefined()
			expect(metadata.observation).toBeUndefined()
			expect(metadata.start).toBeUndefined()
			expect(findings(metadata)).toContain('unsupported:TIMESYS')
		}
	})
})

describe('instants', () => {
	test('DATE and MJD of the same instant keep the finer value when they agree', () => {
		// 59959.0604799 d is 8.64 ms coarse; the DATE value to 1 ms is kept.
		const agree = readFitsTime({ 'DATE-OBS': '2023-01-15T01:27:05.460', 'MJD-OBS': 59959.0604799, TREFPOS: 'GEOCENTER' })
		expect(agree.observation!.keyword).toBe('DATE-OBS')
		expect(findings(agree)).toEqual(['defaulted:TIMESYS', 'assumed:DATE-OBS'])

		// Astropy 7.1.0: Time('2023-01-15T01:27:05.460', scale='utc').mjd = 59959.06047986111.
		const fine = readFitsTime({ 'DATE-OBS': '2023-01-15T01:27:05.460', 'MJD-OBS': 59959.06047986111, TREFPOS: 'GEOCENTER' })
		expect(fine.observation!.keyword).toBe('MJD-OBS')
		expect(seconds(agree.observation!.time, fine.observation!.time)).toBeCloseTo(0, 6)
	})

	test('a disagreeing MJD supersedes the DATE value', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2023-01-15T01:27:05.460', 'MJD-OBS': 59959.0615 })
		expect(metadata.start!.keyword).toBe('MJD-OBS')
		expect(findings(metadata)).toEqual(['conflict:MJD-OBS', 'assumed:MJD-OBS'])
		expect(seconds(timeYMDHMS(2023, 1, 15, 1, 27, 5.46), metadata.start!.time)).toBeCloseTo(88.14, 3)
	})

	test('DATE-BEG is the start and DATE-OBS is never read as the midpoint', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2024-03-10T03:02:30', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-AVG': '2024-03-10T03:02:30' })
		expect(metadata.start!.keyword).toBe('DATE-BEG')
		expect(metadata.midpoint!.keyword).toBe('DATE-AVG')
		expect(metadata.observation!.keyword).toBe('DATE-OBS')
		expect(findings(metadata)).toEqual(['conflict:DATE-BEG'])
	})

	test('high-precision fractional seconds survive in two-part form', () => {
		const metadata = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00.123456789' })
		const start = metadata.start!
		expect(start.resolution).toBeCloseTo(1e-9, 20)
		expect(timeSubtract(start.time, timeYMDHMS(2024, 3, 10, 3, 0, 0, Timescale.TT)) * DAYSEC).toBeCloseTo(0.123456789, 10)
		expect(formatFitsDateTime(start.time, 9)).toBe('2024-03-10T03:00:00.123456789')
	})

	test('23:59:60 is accepted only inside a UTC leap second', () => {
		const leap = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2016-12-31T23:59:60.5' })
		// Astropy 7.1.0: Time('2016-12-31T23:59:60.5', scale='utc').tai = 2017-01-01T00:00:36.500.
		expect(timeToDate(tai(leap.start!.time))).toEqual([2017, 1, 1, 0, 0, 36, 500])
		expect(timeToDate(leap.start!.time)).toEqual([2016, 12, 31, 23, 59, 60, 500])

		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2016-12-30T23:59:60.5' }))).toEqual(['invalid:DATE-BEG', 'missing:DATE-OBS'])
		expect(findings(readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2016-12-31T23:59:60.5' }))).toEqual(['invalid:DATE-BEG', 'missing:DATE-OBS'])
	})

	test('a long exposure across a leap second measures SI seconds', () => {
		const header = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2016-12-31T23:30:00', 'DATE-END': '2017-01-01T00:30:00', XPOSURE: 3601, TELAPSE: 3601 }
		const metadata = readFitsTime(header)
		expect(metadata.diagnostics).toBeEmpty()
		expect(seconds(metadata.start!.time, metadata.end!.time)).toBeCloseTo(3601, 6)

		const interval = exposureInterval(fitsExposure(metadata)!)
		expect(interval.duration).toBeCloseTo(3601, 6)
		// 1800.5 SI seconds after 23:30:00 is inside the inserted second.
		expect(timeToDate(interval.midpoint)).toEqual([2016, 12, 31, 23, 59, 60, 500])

		// The clock-label difference contradicts the SI span once the values are written finely enough;
		// whole seconds are only known to 1 s.
		expect(findings(readFitsTime({ ...header, TELAPSE: 3600 }))).toEqual([])
		const fine = { ...header, 'DATE-BEG': '2016-12-31T23:30:00.50', 'DATE-END': '2017-01-01T00:30:00.75' }
		expect(findings(readFitsTime({ ...fine, TELAPSE: 3601.25 }))).toEqual([])
		expect(findings(readFitsTime({ ...fine, TELAPSE: 3600.25 }))).toEqual(['conflict:TELAPSE'])
	})

	test('TSTART and TSTOP are relative to the split MJDREF in TIMEUNIT', () => {
		// Chandra convention. Astropy 7.1.0: Time(50814, 7.428703703703703e-4, format='mjd', scale='tt')
		// + 600000000 s = jd1 2457759.0, jd2 -0.05481268518518523 (2017-01-05T10:41:04.184 TT).
		const header = { TIMESYS: 'TT', TREFPOS: 'TOPOCENTER', 'OBSGEO-X': 1838458, 'OBSGEO-Y': -5259021, 'OBSGEO-Z': -3099890, MJDREFI: 50814, MJDREFF: 7.428703703703703e-4, MJDREF: 1, TSTART: 600000000, TSTOP: 600000100 }
		const metadata = readFitsTime(header)
		expect(metadata.diagnostics).toBeEmpty()
		expect(metadata.start!.keyword).toBe('TSTART')
		expect(metadata.start!.time.day).toBe(2457759)
		expect(metadata.start!.time.fraction).toBeCloseTo(-0.05481268518518523, 13)
		expect(seconds(metadata.start!.time, metadata.end!.time)).toBeCloseTo(100, 6)

		// The same instant in days, from JDREF, and from DATEREF with TIMEOFFS.
		const days = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', JDREF: 2450814.5007428704, TIMEUNIT: 'd', TSTART: 600000000 / DAYSEC })
		expect(seconds(metadata.start!.time, days.start!.time)).toBeCloseTo(0, 3)
		const dated = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', DATEREF: '2017-01-05T10:00:00', TIMEOFFS: 2464.184, TSTART: 0 })
		expect(seconds(metadata.start!.time, dated.start!.time)).toBeCloseTo(0, 6)
	})

	test('relative UTC offsets count leap seconds and MJDREF defaults to 0', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', DATEREF: '2016-12-31T23:59:59', TSTART: 2 })
		expect(timeToDate(metadata.start!.time)).toEqual([2017, 1, 1, 0, 0, 0, 0])

		const defaulted = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', TSTART: 86400 })
		expect(findings(defaulted)).toEqual(['defaulted:MJDREF'])
		expect(timeToDate(defaulted.start!.time)).toEqual([1858, 11, 18, 0, 0, 0, 0])

		expect(findings(readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', TIMEUNIT: 'ta', TSTART: 1, XPOSURE: 1 }))).toEqual(['unsupported:TIMEUNIT', 'missing:DATE-OBS'])
	})

	test('reference epochs are exact, so a short written fraction does not hide a conflict', () => {
		const base = { TIMESYS: 'TT', TREFPOS: 'GEOCENTER', TSTART: 0 }
		// MJD 60000 starts at 2023-02-25T00:00 TT; DATE-BEG is one hour later.
		const zero = readFitsTime({ ...base, MJDREFI: 60000, MJDREFF: 0, 'DATE-BEG': '2023-02-25T01:00:00' })
		expect(findings(zero)).toEqual(['conflict:DATE-BEG'])
		expect(findings(readFitsTime({ ...base, MJDREFI: 60000, MJDREFF: 0, TSTART: 3600, 'DATE-BEG': '2023-02-25T01:00:00' }))).toBeEmpty()
		expect(findings(readFitsTime({ ...base, MJDREFI: 60000, MJDREFF: 0.5, 'DATE-BEG': '2023-02-25T13:00:00' }))).toEqual(['conflict:DATE-BEG'])
		expect(findings(readFitsTime({ ...base, MJDREF: 60000, 'DATE-BEG': '2023-02-25T00:00:03' }))).toEqual(['conflict:DATE-BEG'])
		// JD 2460000.0 is 2023-02-24T12:00 TT.
		expect(findings(readFitsTime({ ...base, JDREFI: 2460000, JDREFF: 0, 'DATE-BEG': '2023-02-24T13:00:00' }))).toEqual(['conflict:DATE-BEG'])
		expect(findings(readFitsTime({ ...base, JDREF: 2460000, 'DATE-BEG': '2023-02-24T12:00:00' }))).toBeEmpty()
		expect(findings(readFitsTime({ ...base, DATEREF: '2023-02-25', 'DATE-BEG': '2023-02-25T01:00:00' }))).toEqual(['conflict:DATE-BEG'])
		expect(findings(readFitsTime({ ...base, MJDREFI: 60000, MJDREFF: 1e-20, TIMEOFFS: 0, 'DATE-BEG': '2023-02-25T00:00:03' }))).toEqual(['conflict:DATE-BEG'])
	})

	test('the two-digit DATE-OBS has no start role', () => {
		const metadata = readFitsTime({ TREFPOS: 'GEOCENTER', 'DATE-OBS': '15/01/99' })
		expect(timeToDate(metadata.observation!.time)).toEqual([1999, 1, 15, 0, 0, 0, 0])
		expect(metadata.observation!.resolution).toBe(DAYSEC)
		expect(metadata.start).toBeUndefined()
		expect(findings(metadata)).toEqual(['defaulted:TIMESYS', 'nonStandard:DATE-OBS'])
	})

	test('signed five-digit years and the Z designator', () => {
		const metadata = readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', 'DATE-BEG': '-00100-03-01T12:00:00', 'DATE-END': '2024-03-10T03:00:00Z' })
		expect(timeToDate(metadata.start!.time)).toEqual([-100, 3, 1, 12, 0, 0, 0])
		// Z designates UTC, but the value is still read in TIMESYS.
		expect(timeToDate(metadata.end!.time)).toEqual([2024, 3, 10, 3, 0, 0, 0])
		expect(metadata.end!.time.scale).toBe(Timescale.TT)
		expect(findings(metadata)).toEqual(['conflict:DATE-END'])

		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00Z' }))).toEqual(['nonStandard:DATE-BEG'])
		expect(findings(readFitsTime({ TIMESYS: 'TT', TREFPOS: 'GEOCENTER', 'DATE-BEG': '-05000-01-01' }))).toEqual(['unsupported:DATE-BEG', 'missing:DATE-OBS'])
	})

	test('invalid and contradictory values are reported, not thrown', () => {
		const invalid = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2023-02-30T00:00:00', 'MJD-OBS': 'soon', EXPTIME: 'long', EXPOSURE: -1, 'DATE-END': 5 })
		expect(findings(invalid)).toEqual(['invalid:DATE-OBS', 'invalid:MJD-OBS', 'invalid:DATE-END', 'missing:DATE-OBS', 'invalid:EXPTIME', 'invalid:EXPOSURE'])
		expect(invalid.exposure).toBeUndefined()

		const contradictory = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-AVG': '2024-03-10T04:00:00', 'DATE-END': '2024-03-10T02:59:00', XPOSURE: 30, EXPTIME: 35 })
		expect(findings(contradictory)).toEqual(['conflict:XPOSURE', 'conflict:DATE-END', 'conflict:XPOSURE', 'conflict:DATE-AVG'])
		expect(contradictory.exposure).toBe(30)
		expect(contradictory.exposureKeyword).toBe('XPOSURE')
		expect(contradictory.continuous).toBe(false)
		expect(fitsExposure(contradictory)).toBeUndefined()
	})
})

describe('observatory location', () => {
	test('OBSGEO-X/Y/Z is preferred and attached to topocentric instants', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', 'DATE-OBS': '2024-03-10T03:00:00', 'OBSGEO-X': 1838458.3145, 'OBSGEO-Y': -5259021.0107, 'OBSGEO-Z': -3099890.6993 })
		expect(metadata.locationSource).toBe('geocentric')
		expect(metadata.start!.time.location).toBe(metadata.location)
		expect(toMeter(itrs(metadata.location!)[0])).toBeCloseTo(1838458.3145, 3)

		// The topocentric TDB - TT term (about 1 µs here) now applies.
		const topocentric = tdb(metadata.start!.time)
		const geocentric = tdb(timeYMDHMS(2024, 3, 10, 3, 0, 0))
		const difference = Math.abs(topocentric.day - geocentric.day + (topocentric.fraction - geocentric.fraction)) * DAYSEC
		expect(difference).toBeGreaterThan(1e-8)
		expect(difference).toBeLessThan(3e-6)
	})

	// Comparing DATE-OBS with MJD-OBS converts both to TAI; the cached conversion must keep the site,
	// or the exposure midpoint loses the topocentric TDB - TT term (about 2 µs).
	test('the location survives the scale conversions made while reading', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', 'DATE-OBS': '2016-12-31T23:59:30.250', 'MJD-OBS': 57753.9996441, EXPTIME: 60, SITELAT: '-29 15 22.7', SITELONG: -70.7313, SITEELEV: 2400 })
		expect(tai(metadata.start!.time).location).toBe(metadata.location)

		const midpoint = exposureInterval(fitsExposure(metadata)!).midpoint
		expect(midpoint.location).toBe(metadata.location)
		const fresh = timeYMDHMS(2016, 12, 31, 23, 59, 60.25)
		fresh.location = metadata.location
		expect(formatFitsDateTime(tdb(midpoint), 7)).toBe(formatFitsDateTime(tdb(fresh), 7))
		// Astropy 7.1.0: Time('2016-12-31T23:59:60.25', scale='utc', location=EarthLocation.from_geodetic(
		// -70.7313°, -29°15'22.7", 2400 m, 'WGS84')).tdb = 2017-01-01T00:01:08.433949 (geocentric: .433951).
		expect(formatFitsDateTime(tdb(midpoint), 6)).toBe('2017-01-01T00:01:08.433949')
	})

	test('OBSGEO-B/L/H refer to the IAU 1976 ellipsoid', () => {
		const metadata = readFitsTime({ TIMESYS: 'UTC', 'DATE-OBS': '2024-03-10T03:00:00', 'OBSGEO-B': -29.2563, 'OBSGEO-L': -70.7313, 'OBSGEO-H': 2400 })
		expect(metadata.locationSource).toBe('geodetic')
		// pyerfa 2.0.1.5: gd2gce(6378140, 1/298.2577, -70.7313°, -29.2563°, 2400) in meters.
		const [x, y, z] = itrs(metadata.location!)
		expect(toMeter(x)).toBeCloseTo(1838458.3144973735, 3)
		expect(toMeter(y)).toBeCloseTo(-5259021.010706097, 3)
		expect(toMeter(z)).toBeCloseTo(-3099890.6993318098, 3)
		expect(findings(metadata)).toEqual(['defaulted:TREFPOS', 'assumed:DATE-OBS'])
	})

	test('SITELAT/SITELONG/SITEELEV are an assumed WGS84 fallback compared with OBSGEO', () => {
		const site = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'DATE-OBS': '2024-03-10T03:00:00', SITELAT: '-29 15 22.68', SITELONG: -70.7313, SITEELEV: 2400 })
		expect(site.locationSource).toBe('site')
		expect(site.location!.latitude).toBeCloseTo(deg(-29.2563), 12)
		expect(findings(site)).toEqual(['assumed:SITELAT', 'assumed:DATE-OBS'])

		// pyerfa 2.0.1.5: the same B/L/H on WGS84 is 2.9 m from IAU 1976, within the default 100 m.
		const close = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'OBSGEO-B': -29.2563, 'OBSGEO-L': -70.7313, 'OBSGEO-H': 2400, SITELAT: -29.2563, SITELONG: -70.7313, SITEELEV: 2400 })
		expect(close.locationSource).toBe('geodetic')
		expect(findings(close)).toEqual(['missing:DATE-OBS'])
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'OBSGEO-B': -29.2563, 'OBSGEO-L': -70.7313, 'OBSGEO-H': 2400, SITELAT: -29.2563, SITELONG: -70.7313, SITEELEV: 2400 }, { locationTolerance: 1 }))).toEqual(['conflict:OBSGEO-B', 'missing:DATE-OBS'])

		// A west-positive longitude written into SITELONG lands on the other side of the planet.
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'OBSGEO-B': -29.2563, 'OBSGEO-L': -70.7313, 'OBSGEO-H': 2400, SITELAT: -29.2563, SITELONG: 70.7313 }))).toEqual(['defaulted:SITEELEV', 'conflict:OBSGEO-B', 'missing:DATE-OBS'])
	})

	test('incomplete, out-of-range, and kilometer locations are rejected', () => {
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'OBSGEO-X': 1838458, 'OBSGEO-Y': -5259021 }))).toEqual(['missing:OBSGEO-X', 'missing:OBSGEO-X', 'missing:DATE-OBS'])
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', 'OBSGEO-X': 1838.458, 'OBSGEO-Y': -5259.021, 'OBSGEO-Z': -3099.89 }))).toEqual(['invalid:OBSGEO-X', 'missing:OBSGEO-X', 'missing:DATE-OBS'])
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', SITELAT: 95, SITELONG: 10 }))).toEqual(['invalid:SITELAT', 'missing:OBSGEO-X', 'missing:DATE-OBS'])
		expect(findings(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'TOPOCENTER', SITELAT: true, SITELONG: 10 }))).toEqual(['invalid:SITELAT', 'missing:OBSGEO-X', 'missing:DATE-OBS'])
	})
})

describe('exposure', () => {
	test('a single timestamp with an exposure labels its role', () => {
		const base = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', EXPTIME: 60, TIMSYER: 0.002 }
		const fromStart = fitsExposure(readFitsTime({ ...base, 'DATE-OBS': '2024-03-10T03:00:00' }), { openLatency: 0.1 }) as { reference: string; duration: number; uncertainty: number; openLatency: number }
		expect(fromStart.reference).toBe('start')
		expect(fromStart.duration).toBe(60)
		expect(fromStart.uncertainty).toBe(0.002)
		expect(fromStart.openLatency).toBe(0.1)

		const fromMidpoint = exposureInterval(fitsExposure(readFitsTime({ ...base, 'DATE-AVG': '2024-03-10T03:00:30' }))!)
		expect(timeToDate(fromMidpoint.start)).toEqual([2024, 3, 10, 3, 0, 0, 0])
		const fromEnd = exposureInterval(fitsExposure(readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:01:00' }))!)
		expect(timeToDate(fromEnd.midpoint)).toEqual([2024, 3, 10, 3, 0, 30, 0])

		expect(fitsExposure(readFitsTime({ TIMESYS: 'UTC', 'DATE-OBS': '2024-03-10T03:00:00' }))).toBeUndefined()
	})

	test('an exposure shorter than the start-end window is not turned into a collection interval', () => {
		const base = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-END': '2024-03-10T03:01:00', TELAPSE: 60 }

		// 30 s of integration inside a 60 s window: dead time or co-added frames.
		const deadTime = readFitsTime({ ...base, XPOSURE: 30, 'DATE-AVG': '2024-03-10T03:00:20' })
		expect(deadTime.continuous).toBe(false)
		expect(deadTime.exposure).toBe(30)
		expect(deadTime.elapsed).toBe(60)
		expect(findings(deadTime)).toBeEmpty()
		expect(fitsExposure(deadTime)).toBeUndefined()

		const continuous = readFitsTime({ ...base, XPOSURE: 60 })
		expect(continuous.continuous).toBe(true)
		expect(exposureInterval(fitsExposure(continuous)!).duration).toBeCloseTo(60, 9)

		// Two endpoints and TELAPSE without an integration time do not prove a continuous exposure.
		const unknown = readFitsTime(base)
		expect(unknown.continuous).toBeUndefined()
		expect(fitsExposure(unknown)).toBeUndefined()
		expect(readFitsTime({ TIMESYS: 'UTC', 'DATE-OBS': '2024-03-10T03:00:00', EXPTIME: 60 }).continuous).toBeUndefined()
	})

	test('an inverted window is never a collection interval', () => {
		const base = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:01:00', 'DATE-END': '2024-03-10T03:00:00' }

		const bare = readFitsTime(base)
		expect(findings(bare)).toEqual(['conflict:DATE-END'])
		expect(bare.continuous).toBe(false)
		expect(fitsExposure(bare)).toBeUndefined()

		expect(fitsExposure(readFitsTime({ ...base, XPOSURE: 60 }))).toBeUndefined()

		// A 0.5 s inversion is detected once both endpoints are written to 0.1 s.
		const fine = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00.5', 'DATE-END': '2024-03-10T03:00:00.0', XPOSURE: 0 })
		expect(findings(fine)).toEqual(['conflict:DATE-END'])
		expect(fine.continuous).toBe(false)
		expect(fitsExposure(fine)).toBeUndefined()
	})

	test('timestamps too coarse to resolve the exposure leave continuity undetermined', () => {
		// Date-only endpoints are known to a day each, so a 30 s XPOSURE neither matches nor contradicts the day.
		const dateOnly = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-01-01', 'DATE-END': '2024-01-02', XPOSURE: 30 })
		expect(dateOnly.continuous).toBeUndefined()
		expect(fitsExposure(dateOnly)).toBeUndefined()

		// Whole seconds resolve a 60 s exposure, but not a 1 s one.
		const header = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-END': '2024-03-10T03:00:01' }
		expect(readFitsTime({ ...header, XPOSURE: 1 }).continuous).toBeUndefined()
		expect(readFitsTime({ ...header, 'DATE-END': '2024-03-10T03:01:00', XPOSURE: 60 }).continuous).toBe(true)
		// An integer XPOSURE is known only to 1 s, so even millisecond timestamps cannot prove a 1 s exposure.
		const fine = { ...header, 'DATE-BEG': '2024-03-10T03:00:00.000', 'DATE-END': '2024-03-10T03:00:01.000' }
		expect(readFitsTime({ ...fine, XPOSURE: 1 }).continuous).toBeUndefined()
		expect(readFitsTime({ ...fine, 'DATE-END': '2024-03-10T03:00:01.500', XPOSURE: 1.5 }).continuous).toBe(true)
	})

	test('dead time within the exposure resolution is not taken as a continuous exposure', () => {
		const base = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-END': '2024-03-10T03:00:32', XPOSURE: 30, TELAPSE: 32 }

		// 30 s of integration inside a 32 s window of whole seconds: compatible, but not proven continuous.
		const overhead = readFitsTime(base)
		expect(overhead.exposure).toBe(30)
		expect(overhead.elapsed).toBe(32)
		expect(overhead.continuous).toBeUndefined()
		expect(findings(overhead)).toBeEmpty()
		expect(fitsExposure(overhead)).toBeUndefined()

		const fine = readFitsTime({ ...base, 'DATE-BEG': '2024-03-10T03:00:00.000', 'DATE-END': '2024-03-10T03:00:30.900', TELAPSE: 30.9 })
		expect(fine.continuous).toBeUndefined()
		expect(findings(fine)).toBeEmpty()
		expect(fitsExposure(fine)).toBeUndefined()

		// One whole second of difference is already beyond the quantization of whole-second timestamps.
		expect(readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:00:31', TELAPSE: 31 }).continuous).toBeUndefined()

		const exact = readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:00:30', TELAPSE: 30 })
		expect(exact.continuous).toBe(true)
		expect(exposureInterval(fitsExposure(exact)!).duration).toBeCloseTo(30, 9)
	})

	test('coarse timestamps never replace a finer explicit exposure', () => {
		const base = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00', 'DATE-END': '2024-03-10T03:00:31', XPOSURE: 30.1, TELAPSE: 31 }

		// Whole-second timestamps round a 30.1 s exposure to 31 s just as well as they hide 0.9 s of overhead.
		const coarse = readFitsTime(base)
		expect(coarse.exposure).toBe(30.1)
		expect(coarse.elapsed).toBe(31)
		expect(coarse.continuous).toBeUndefined()
		expect(findings(coarse)).toBeEmpty()
		expect(fitsExposure(coarse)).toBeUndefined()

		expect(readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:00:30', TELAPSE: 30, XPOSURE: 29.1 }).continuous).toBeUndefined()
		expect(readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:00:30', TELAPSE: 30 }).continuous).toBeUndefined()
		expect(readFitsTime({ ...base, 'DATE-END': '2024-03-10T03:00:33', TELAPSE: 33 }).continuous).toBe(false)

		// Millisecond timestamps reproduce the exposure to its last digit, or reveal a mismatch beyond it.
		const fine = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00.000', XPOSURE: 30.1 }
		const exact = readFitsTime({ ...fine, 'DATE-END': '2024-03-10T03:00:30.100' })
		expect(exact.continuous).toBe(true)
		expect(exposureInterval(fitsExposure(exact)!).duration).toBeCloseTo(30.1, 9)
		expect(readFitsTime({ ...fine, 'DATE-END': '2024-03-10T03:00:30.150' }).continuous).toBeUndefined()
	})

	test('a zero-length window never becomes a continuous exposure', () => {
		const header = { TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-03-10T03:00:00.000', 'DATE-END': '2024-03-10T03:00:00.000', XPOSURE: 1 }
		const zero = readFitsTime(header)
		expect(zero.continuous).not.toBe(true)
		expect(fitsExposure(zero)).toBeUndefined()

		for (const end of ['2024-03-10T03:00:00.100', '2024-03-10T03:00:00.200']) {
			const short = readFitsTime({ ...header, 'DATE-END': end })
			expect(short.continuous).not.toBe(true)
			expect(fitsExposure(short)).toBeUndefined()
		}

		// A finer exposure exposes the mismatch as a conflict.
		const conflict = readFitsTime({ ...header, XPOSURE: 1.0001 })
		expect(conflict.continuous).toBe(false)
		expect(findings(conflict)).toEqual(['conflict:XPOSURE'])
	})

	test('timestamp quantization and both time errors reach the interval', () => {
		const dateOnly = exposureInterval(fitsExposure(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2024-01-01', EXPTIME: 60 }))!)
		expect(dateOnly.resolution).toBe(86400)
		expect(dateOnly.uncertainty).toBe(0)

		const random = fitsExposure(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2024-01-01T00:00:00.1', EXPTIME: 60, TIMRDER: 0.2 }))!
		expect(random.uncertainty).toBe(0.2)
		expect(random.resolution).toBeCloseTo(0.1, 15)

		const both = fitsExposure(readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-OBS': '2024-01-01T00:00:00', EXPTIME: 60, TIMSYER: 0.3, TIMRDER: 0.4 }))!
		expect(both.uncertainty).toBeCloseTo(0.5, 15)

		// The coarser of two timestamps bounds the span; the shutter overrides the defaults.
		const mixed = readFitsTime({ TIMESYS: 'UTC', TREFPOS: 'GEOCENTER', 'DATE-BEG': '2024-01-01T00:00:00.001', 'DATE-END': '2024-01-01T00:01:00', XPOSURE: 60, TIMSYER: 0.3 })
		expect(exposureInterval(fitsExposure(mixed)!).resolution).toBe(1)
		expect(exposureInterval(fitsExposure(mixed, { uncertainty: 0.01, resolution: 0 })!)).toMatchObject({ uncertainty: 0.01, resolution: 0 })
	})
})

describe('writing', () => {
	test('formats leap seconds, carries, and extended years', () => {
		expect(formatFitsDateTime(timeYMDHMS(2016, 12, 31, 23, 59, 60.25), 6)).toBe('2016-12-31T23:59:60.250000')
		expect(formatFitsDateTime(timeYMDHMS(2016, 12, 31, 23, 59, 59.9999999), 6)).toBe('2016-12-31T23:59:60.000000')
		expect(formatFitsDateTime(timeYMDHMS(2016, 12, 31, 23, 59, 60.9999999), 3)).toBe('2017-01-01T00:00:00.000')
		expect(formatFitsDateTime(timeYMDHMS(2024, 12, 31, 23, 59, 59.9999996, Timescale.TT), 6)).toBe('2025-01-01T00:00:00.000000')
		expect(formatFitsDateTime(timeYMDHMS(2024, 3, 10, 3, 0, 0, Timescale.TT), 0)).toBe('2024-03-10T03:00:00')
		expect(formatFitsDateTime(timeYMDHMS(12000, 1, 2, 3, 4, 5, Timescale.TT), 0)).toBe('+12000-01-02T03:04:05')
		expect(formatFitsDateTime(timeYMDHMS(-100, 3, 1, 12, 0, 0, Timescale.TT), 1)).toBe('-00100-03-01T12:00:00.0')
		// Astropy 7.1.0: Time('2024-03-10T03:00:00', scale='utc').tdb.isot = 2024-03-10T03:01:09.185.
		expect(formatFitsDateTime(tdb(timeYMDHMS(2024, 3, 10, 3)), 3)).toBe('2024-03-10T03:01:09.185')
	})

	test('round-trips through header cards and passes unrelated keywords through', () => {
		const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
		const start = timeYMDHMS(2016, 12, 31, 23, 59, 30.123456, Timescale.UTC)
		const end = timeYMDHMS(2017, 1, 1, 0, 0, 30.123456, Timescale.UTC)
		const header: FitsHeader = { SIMPLE: true, OBJECT: 'M42', 'MJD-OBS': 1, TSTART: 5, MJDREF: 3, 'OBSGEO-B': 10, HISTORY: 'stacked' }

		writeFitsTime(header, { start, end, exposure: 60, referencePosition: 'topocenter', location, systematicError: 0.001, ephemeris: 'DE440' })

		expect(Object.keys(header).slice(0, 3)).toEqual(['SIMPLE', 'OBJECT', 'MJD-OBS'])
		expect(header.HISTORY).toBe('stacked')
		expect(header.TSTART).toBeUndefined()
		expect(header.MJDREF).toBeUndefined()
		expect(header['OBSGEO-B']).toBeUndefined()
		expect(header['DATE-OBS']).toBe('2016-12-31T23:59:30.123456')
		expect(header['DATE-END']).toBe('2017-01-01T00:00:30.123456')
		expect(header.TELAPSE).toBeCloseTo(61, 6)
		expect(header.TIMEUNIT).toBe('s')

		const buffer = Buffer.alloc(80 * 64)
		new FitsKeywordWriter().writeAll(header, buffer)
		const read = readFitsTime(new FitsKeywordReader().readAll(buffer))

		expect(read.diagnostics).toBeEmpty()
		expect(read.locationSource).toBe('geocentric')
		expect(read.ephemeris).toBe('DE440')
		expect(read.systematicError).toBe(0.001)
		expect(read.exposure).toBe(60)
		expect(read.elapsed).toBeCloseTo(61, 6)
		expect(Math.abs(seconds(start, read.start!.time))).toBeLessThan(1e-6)
		expect(Math.abs(seconds(end, read.end!.time))).toBeLessThan(1e-6)
		expect(toMeter(Math.hypot(...itrs(read.location!).map((e, i) => e - itrs(location)[i])))).toBeLessThan(1e-3)
	})

	test('instants are converted to the requested scale and absent values are removed', () => {
		const header: FitsHeader = { TIMESYS: 'UTC', 'DATE-AVG': '2000-01-01T00:00:00', EXPOSURE: 1 }
		writeFitsTime(header, { scale: Timescale.TT, start: timeYMDHMS(2016, 12, 31, 23, 59, 60.5, Timescale.UTC) })

		expect(header.TIMESYS).toBe('TT')
		// Astropy 7.1.0: Time('2016-12-31T23:59:60.5', scale='utc').tt = 2017-01-01T00:01:08.684.
		expect(header['DATE-BEG']).toBe('2017-01-01T00:01:08.684000')
		expect(header['DATE-AVG']).toBeUndefined()
		expect(header.EXPOSURE).toBeUndefined()
		expect(header.TIMEUNIT).toBeUndefined()
		for (const key of Object.keys(header)) expect(FITS_TIME_KEYWORDS).toContain(key)
	})

	test('a clock conversion to TDB stays topocentric unless the barycenter is declared', () => {
		const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
		const start = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC)

		const topocentric = writeFitsTime({}, { scale: Timescale.TDB, start, location })
		expect(topocentric.TREFPOS).toBe('TOPOCENTER')
		const read = readFitsTime(topocentric)
		expect(read.referencePosition).toBe('topocenter')
		expect(findings(read)).toEqual(['incompatible:TREFPOS'])

		expect(writeFitsTime({}, { scale: Timescale.TCG, start }).TREFPOS).toBe('TOPOCENTER')
		expect(writeFitsTime({}, { scale: Timescale.TT, start }).TREFPOS).toBeUndefined()

		// A BJD_TDB already light-time corrected elsewhere keeps its declared origin.
		const barycentric = writeFitsTime({}, { start: tdb(start), referencePosition: 'barycenter' })
		expect(barycentric.TREFPOS).toBe('BARYCENTER')
		expect(readFitsTime(barycentric).referencePosition).toBe('barycenter')
	})

	test('the separate location enters the topocentric TDB-TT term without mutating the input', () => {
		const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
		const start = timeYMDHMS(2026, 1, 1, 6, 0, 0, Timescale.UTC)
		const located = timeYMDHMS(2026, 1, 1, 6, 0, 0, Timescale.UTC)
		located.location = location

		const separate = writeFitsTime({}, { scale: Timescale.TDB, start, location, digits: 9 })
		expect(start.location).toBeUndefined()
		expect(separate['DATE-BEG']).toBe(writeFitsTime({}, { scale: Timescale.TDB, start: located, digits: 9 })['DATE-BEG'])
		expect(separate['DATE-BEG']).not.toBe(writeFitsTime({}, { scale: Timescale.TDB, start, digits: 9 })['DATE-BEG'])
	})

	test('the written location is the one the TDB conversion used', () => {
		// Two sites about a quarter turn apart in longitude, so their topocentric TDB-TT terms differ by microseconds.
		const a = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
		const b = geodeticLocation(deg(17.8792), deg(28.7606), meter(2396))
		const at = (location?: typeof a) => {
			const instant = timeYMDHMS(2026, 1, 1, 6, 0, 0, Timescale.UTC)
			instant.location = location
			return instant
		}

		const start = at(a)
		const overridden = writeFitsTime({}, { scale: Timescale.TDB, start, location: b, digits: 9 })
		expect(start.location).toBe(a)
		expect(overridden['DATE-BEG']).toBe(writeFitsTime({}, { scale: Timescale.TDB, start: at(b), digits: 9 })['DATE-BEG'])
		expect(overridden['DATE-BEG']).not.toBe(writeFitsTime({}, { scale: Timescale.TDB, start: at(a), digits: 9 })['DATE-BEG'])
		expect(toMeter(Math.hypot(...itrs(readFitsTime(overridden).location!).map((e, i) => e - itrs(b)[i])))).toBeLessThan(1e-3)

		// Swapping the sites moves the written instant by the same microseconds.
		const swapped = writeFitsTime({}, { scale: Timescale.TDB, start: at(b), location: a, digits: 9 })
		expect(swapped['DATE-BEG']).toBe(writeFitsTime({}, { scale: Timescale.TDB, start: at(a), digits: 9 })['DATE-BEG'])

		// Without input.location, the instant's own site is recorded in the header.
		const own = writeFitsTime({}, { scale: Timescale.TDB, start: at(a), digits: 9 })
		expect(toMeter(Math.hypot(...itrs(readFitsTime(own).location!).map((e, i) => e - itrs(a)[i])))).toBeLessThan(1e-3)
		expect(findings(readFitsTime(own))).toEqual(['incompatible:TREFPOS'])
	})

	test('a TDB instant from another site is rebased through TT to the written location', () => {
		const a = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
		const b = geodeticLocation(deg(17.8792), deg(28.7606), meter(2396))
		const at = (location: typeof a) => {
			const instant = timeYMDHMS(2026, 1, 1, 6, 0, 0, Timescale.UTC)
			instant.location = location
			return instant
		}

		const atA = tdb(at(a))
		const expected = writeFitsTime({}, { scale: Timescale.TDB, start: at(b), digits: 9 })['DATE-BEG']
		expect(writeFitsTime({}, { scale: Timescale.TDB, start: atA, location: b, digits: 9 })['DATE-BEG']).toBe(expected)
		expect(writeFitsTime({}, { scale: Timescale.TDB, start: tcb(at(a)), location: b, digits: 9 })['DATE-BEG']).toBe(expected)
		expect(atA.location).toBe(a)

		// A barycentric TDB is not tied to the observatory: its value is kept and the location only recorded.
		const barycentric = writeFitsTime({}, { start: atA, location: b, referencePosition: 'barycenter', digits: 9 })
		expect(barycentric['DATE-BEG']).toBe(formatFitsDateTime(atA, 9))
		expect(barycentric['DATE-BEG']).not.toBe(expected)
		expect(toMeter(Math.hypot(...itrs(readFitsTime(barycentric).location!).map((e, i) => e - itrs(b)[i])))).toBeLessThan(1e-3)
	})
})
