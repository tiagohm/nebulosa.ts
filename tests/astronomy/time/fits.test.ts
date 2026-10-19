import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { itrs } from '../../../src/astronomy/coordinates/itrs'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { exposureInterval } from '../../../src/astronomy/time/exposure'
import { FITS_TIME_KEYWORDS, type FitsTimeMetadata, fitsExposure, formatFitsDateTime, readFitsTime, writeFitsTime } from '../../../src/astronomy/time/fits'
import { type Time, Timescale, tai, tdb, timeSubtract, timeToDate, timeYMDHMS, tt } from '../../../src/astronomy/time/time'
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
})
