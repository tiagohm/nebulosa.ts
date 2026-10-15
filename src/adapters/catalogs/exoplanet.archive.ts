import type { TransitEphemeris, TransitEpochReference } from '../../astronomy/events/exoplanet'
import { Timescale, time } from '../../astronomy/time/time'
import { type Angle, deg } from '../../math/units/angle'

// NASA Exoplanet Archive ingestion: converts one row of the Planetary Systems (`ps`) table into the
// linear TransitEphemeris consumed by exoplanetTransits. Rows come from TAP queries in JSON (numbers
// and nulls) or CSV (strings); this module performs no network access. Archive epochs are Julian
// Dates labelled by `pl_tsystemref`, periods are days, durations are hours, coordinates are degrees.
// The archive publishes asymmetric errors and no epoch-period covariance, so the larger error
// magnitude becomes the 1σ value and the covariance is left undefined.

// https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html

// One `ps` table row. Only the transit-ephemeris columns are read; others may be present.
export interface ExoplanetArchiveRow {
	// Planet name.
	readonly pl_name?: string | null
	// Right ascension in degrees.
	readonly ra?: number | string | null
	// Declination in degrees.
	readonly dec?: number | string | null
	// Mid-transit epoch T0, as a Julian Date on the clock named by pl_tsystemref.
	readonly pl_tranmid?: number | string | null
	// Upper (+) error of T0, in days.
	readonly pl_tranmiderr1?: number | string | null
	// Lower (−) error of T0, in days.
	readonly pl_tranmiderr2?: number | string | null
	// Orbital period in days.
	readonly pl_orbper?: number | string | null
	// Upper (+) error of the period, in days.
	readonly pl_orbpererr1?: number | string | null
	// Lower (−) error of the period, in days.
	readonly pl_orbpererr2?: number | string | null
	// Total transit duration T14, in hours.
	readonly pl_trandur?: number | string | null
	// Upper (+) error of the duration, in hours.
	readonly pl_trandurerr1?: number | string | null
	// Lower (−) error of the duration, in hours.
	readonly pl_trandurerr2?: number | string | null
	// Time reference of pl_tranmid, for example 'BJD-TDB', 'BJD-UTC', 'BJD', or 'HJD'.
	readonly pl_tsystemref?: string | null
}

// Why a row cannot become a transit ephemeris. 'invalidValue' covers non-numeric or non-finite
// fields, a non-positive period, and a duration outside (0, period).
export type ExoplanetArchiveTransitFailureReason = 'missingEpoch' | 'missingPeriod' | 'missingDuration' | 'missingTimeReference' | 'unsupportedTimeReference' | 'invalidValue'

// A converted row.
export interface ExoplanetArchiveTransitSuccess {
	readonly success: true
	// Planet name, when present.
	readonly name?: string
	// Linear ephemeris with T0 on the reported clock and origin.
	readonly ephemeris: TransitEphemeris
	// Right ascension in radians, when present.
	readonly rightAscension?: Angle
	// Declination in radians, when present.
	readonly declination?: Angle
	// The reference did not name a time scale ('BJD' or 'HJD'), so one was assumed: TDB for BJD and
	// UTC for HJD.
	readonly assumedScale: boolean
}

// A rejected row.
export interface ExoplanetArchiveTransitFailure {
	readonly success: false
	// Why the row was rejected.
	readonly reason: ExoplanetArchiveTransitFailureReason
}

// Result of exoplanetArchiveTransitEphemeris.
export type ExoplanetArchiveTransitResult = ExoplanetArchiveTransitSuccess | ExoplanetArchiveTransitFailure

// Options of exoplanetArchiveTransitEphemeris.
export interface ExoplanetArchiveTransitOptions {
	// Time reference used when the row has none, as composite-parameter rows lack pl_tsystemref.
	readonly timeReference?: string
}

// Parsed clock and origin of an archive time reference.
interface TimeReference {
	readonly reference: TransitEpochReference
	readonly scale: Timescale
	readonly assumed: boolean
}

// Supported archive time references, keyed without separators or case: barycentric dates on TDB, TT,
// UTC, or TCB, and heliocentric dates on UTC or TDB. Plain 'BJD' is taken as BJD_TDB, the archive's
// prevailing convention, and plain 'HJD' as HJD_UTC, the historical one; both are flagged as assumed.
// Plain 'JD' (no light-time origin) and other labels are unsupported.
const TIME_REFERENCES: Readonly<Record<string, TimeReference>> = {
	BJDTDB: { reference: 'barycentric', scale: Timescale.TDB, assumed: false },
	BJDTT: { reference: 'barycentric', scale: Timescale.TT, assumed: false },
	BJDUTC: { reference: 'barycentric', scale: Timescale.UTC, assumed: false },
	UTCBJD: { reference: 'barycentric', scale: Timescale.UTC, assumed: false },
	BJDTCB: { reference: 'barycentric', scale: Timescale.TCB, assumed: false },
	BJD: { reference: 'barycentric', scale: Timescale.TDB, assumed: true },
	HJDUTC: { reference: 'heliocentric', scale: Timescale.UTC, assumed: false },
	HJDTDB: { reference: 'heliocentric', scale: Timescale.TDB, assumed: false },
	HJD: { reference: 'heliocentric', scale: Timescale.UTC, assumed: true },
}

// Parses an optional numeric field: undefined when absent or blank, NaN when not a finite number.
function numeric(value: number | string | null | undefined) {
	if (value === null || value === undefined) return undefined
	if (typeof value === 'string') {
		const text = value.trim()
		if (text === '') return undefined
		const parsed = Number(text)
		return Number.isFinite(parsed) ? parsed : Number.NaN
	}
	return Number.isFinite(value) ? value : Number.NaN
}

// Plain decimal notation, split into its integer and fractional digits.
const DECIMAL_PATTERN = /^([+-]?\d+)(\.\d*)?$/

// Parses an optional Julian Date into [day, fraction]: undefined when absent or blank, NaN when not a
// finite number. A decimal string keeps every digit by parsing its integer and fractional parts
// separately; a number has already been rounded to a double, which resolves ≈ 40 µs near JD 2.46e6.
function julianDate(value: number | string | null | undefined): readonly [number, number] | undefined {
	if (typeof value === 'string') {
		const match = DECIMAL_PATTERN.exec(value.trim())

		if (match !== null) {
			const day = Number(match[1])
			const fraction = match[2] === undefined ? 0 : Number(`0${match[2]}`)
			return [day, match[1].startsWith('-') ? -fraction : fraction]
		}
	}

	const parsed = numeric(value)
	return parsed === undefined ? undefined : [parsed, 0]
}

// Larger magnitude of an asymmetric error pair; undefined when both are absent.
function symmetricError(upper: number | undefined, lower: number | undefined) {
	if (upper === undefined && lower === undefined) return undefined
	return Math.max(Math.abs(upper ?? 0), Math.abs(lower ?? 0))
}

// Converts one NASA Exoplanet Archive `ps` row into a TransitEphemeris.
// Parameters: row holds the archive columns as numbers or strings. options.timeReference supplies the
// time reference of rows that carry none. Returns the ephemeris with T0 on the scale and origin named
// by pl_tsystemref (a decimal-string T0 is split into day and fraction without rounding), the period in days, T14 converted from hours to days, 1σ uncertainties taken as
// the larger magnitude of each asymmetric pair (undefined when both are absent), no covariance, and
// the coordinates in radians when present. Rejects a row with a missing epoch, period, duration, or
// time reference, an unsupported reference such as plain 'JD', or an invalid value, instead of
// guessing. Separators and case of the reference are ignored ('BJD_TDB' = 'BJD-TDB' = 'bjd/tdb').
export function exoplanetArchiveTransitEphemeris(row: ExoplanetArchiveRow, options: ExoplanetArchiveTransitOptions = {}): ExoplanetArchiveTransitResult {
	const epoch = julianDate(row.pl_tranmid)
	const period = numeric(row.pl_orbper)
	const hours = numeric(row.pl_trandur)
	if (epoch === undefined) return { success: false, reason: 'missingEpoch' }
	if (period === undefined) return { success: false, reason: 'missingPeriod' }
	if (hours === undefined) return { success: false, reason: 'missingDuration' }

	const label = row.pl_tsystemref?.trim() || options.timeReference?.trim()
	if (!label) return { success: false, reason: 'missingTimeReference' }
	const timeReference = TIME_REFERENCES[label.toUpperCase().replaceAll(/[\s_/-]+/g, '')]
	if (timeReference === undefined) return { success: false, reason: 'unsupportedTimeReference' }

	const errors = [row.pl_tranmiderr1, row.pl_tranmiderr2, row.pl_orbpererr1, row.pl_orbpererr2, row.pl_trandurerr1, row.pl_trandurerr2].map(numeric)
	const ra = numeric(row.ra)
	const dec = numeric(row.dec)
	const duration = hours / 24

	// A non-finite field or an impossible period/duration would make the prediction throw or mislead.
	if (Number.isNaN(epoch[0]) || Number.isNaN(ra) || Number.isNaN(dec) || errors.some(Number.isNaN)) return { success: false, reason: 'invalidValue' }
	if (!(period > 0) || !(duration > 0 && duration < period)) return { success: false, reason: 'invalidValue' }

	const durationError = symmetricError(errors[4], errors[5])

	const ephemeris: TransitEphemeris = {
		epoch: time(epoch[0], epoch[1], timeReference.scale),
		reference: timeReference.reference,
		period,
		duration,
		epochUncertainty: symmetricError(errors[0], errors[1]),
		periodUncertainty: symmetricError(errors[2], errors[3]),
		durationUncertainty: durationError === undefined ? undefined : durationError / 24,
	}

	return {
		success: true,
		name: row.pl_name ?? undefined,
		ephemeris,
		rightAscension: ra === undefined ? undefined : deg(ra),
		declination: dec === undefined ? undefined : deg(dec),
		assumedScale: timeReference.assumed,
	}
}
