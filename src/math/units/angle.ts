import { AMIN2RAD, ASEC2RAD, DEG2RAD, HOUR2RAD, MILLIASEC2RAD, PI, RAD2DEG, RAD2HOUR, TAU } from '../../core/constants'
import { pmod } from '../numerical/math'

// Angle type and conversions. The canonical `Angle` is radians; helpers build angles from degrees,
// hours, arcmin/arcsec/mas or sexagesimal components and convert back, plus wrap-safe normalization
// and sexagesimal parsing/formatting. Functions that normalize state their target range explicitly.

// Fallback values applied per-field when formatAngle is called without the corresponding option.
const DEFAULT_FORMAT_ANGLE_OPTIONS: Required<FormatAngleOptions> = {
	isHour: false,
	noSign: false,
	noSecond: false,
	fractionDigits: 2,
	separators: [],
	minusSign: '-',
	plusSign: '+',
	padLength: 2,
}

// Represents an angle in radians.
export type Angle = number

// Options controlling how a string/number is interpreted by parseAngle.
export interface ParseAngleOptions {
	// When true, a bare numeric input is read as hours instead of degrees.
	isHour?: boolean
	// Angle (radians) returned when the input is empty, non-finite, or unparseable.
	defaultValue?: Angle
}

// Options controlling sexagesimal formatting in formatAngle.
export interface FormatAngleOptions {
	// Format as hours:minutes:seconds instead of degrees:arcmin:arcsec.
	isHour?: boolean
	// Omit the leading sign entirely (otherwise a non-negative value gets `plusSign`).
	noSign?: boolean
	// Drop the seconds field, rounding into minutes.
	noSecond?: boolean
	// Number of fractional digits on the seconds field.
	fractionDigits?: number
	// Separators between the three fields; a single string applies to all, an array sets them individually.
	separators?: string[] | string
	// String used for the negative sign.
	minusSign?: string
	// String used for the positive sign when signs are shown.
	plusSign?: string
	// Zero-pad width of the leading (degrees/hours) field.
	padLength?: number
}

// Normalizes the angle to the range [0, TAU).
export function normalizeAngle(angle: Angle): Angle {
	return pmod(angle, TAU)
}

// Normalizes the angle to the range (-PI, PI].
export function normalizePI(angle: Angle): Angle {
	const rem = pmod(angle + PI, TAU)
	return rem === 0 ? PI : rem - PI
}

// Creates a new Angle from degrees.
export function deg(value: number): Angle {
	return value * DEG2RAD
}

// Creates a new Angle from hours.
export function hour(value: number): Angle {
	return value * HOUR2RAD
}

// Creates a new Angle from arcmin.
export function arcmin(value: number): Angle {
	return value * AMIN2RAD
}

// Creates a new Angle from arcseconds.
export function arcsec(value: number): Angle {
	return value * ASEC2RAD
}

// Creates a new Angle from milliarcseconds.
export function mas(value: number): Angle {
	return value * MILLIASEC2RAD
}

// Creates a new Angle from degress, minutes and seconds.
export function dms(d: number, min: number = 0, sec: number = 0): Angle {
	const neg = d < 0 || Object.is(d, -0)
	const angle = deg(Math.abs(d) + Math.abs(min) / 60 + Math.abs(sec) / 3600)
	return neg ? -angle : angle
}

// Creates a new Angle from hours, minutes and seconds.
export function hms(h: number, min: number = 0, sec: number = 0): Angle {
	const neg = h < 0 || Object.is(h, -0)
	const angle = hour(Math.abs(h) + Math.abs(min) / 60 + Math.abs(sec) / 3600)
	return neg ? -angle : angle
}

// Converts the angle to degrees.
export function toDeg(angle: Angle): number {
	return angle * RAD2DEG
}

// Converts the angle to hours.
export function toHour(angle: Angle): number {
	return angle * RAD2HOUR
}

// Converts the angle to arcmin.
export function toArcmin(angle: Angle): number {
	return angle / AMIN2RAD
}

// Converts the angle to arcseconds.
export function toArcsec(angle: Angle): number {
	return angle / ASEC2RAD
}

// Converts the angle to milliarcseconds.
export function toMas(angle: Angle): number {
	return angle / MILLIASEC2RAD
}

// Splits the angle into sexagesimal degrees as [degrees, minutes, seconds, sign], where degrees and
// minutes are non-negative integers, seconds is fractional, and sign is Math.sign(angle) (-1, 0 or 1).
// The angle is not normalized; magnitudes above 360° are kept as-is.
export function toDms(angle: Angle): [number, number, number, number] {
	const d = Math.abs(toDeg(angle))
	const m = ((d - Math.trunc(d)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.abs(Math.trunc(d)), Math.trunc(m), s, Math.sign(angle)]
}

// Splits the angle into sexagesimal hours as [hours, minutes, seconds]. The angle is first normalized
// to [0, TAU), so the result is always non-negative with hours in [0, 24).
export function toHms(angle: Angle): [number, number, number] {
	const h = toHour(normalizeAngle(angle))
	const m = ((h - Math.trunc(h)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.trunc(h), Math.trunc(m), s]
}

// Wrap-safe angular difference in [-PI, PI]; never compare longitudes with a plain subtraction.
export function safeAngularDifference(a: Angle, b: Angle) {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

const ANGLE = '\\d+(?:\\.\\d+)?'
const SIGNED_ANGLE = `[-+]?${ANGLE}`
const UNIT = '[^\\d-+\\s]'

// -12d 45m 23.123s
const PARSE_ANGLE_DHMS_REGEX = new RegExp(`(${SIGNED_ANGLE})(${UNIT})?\\D*(?:(${ANGLE})(${UNIT})?\\D*)?(?:(${ANGLE})(${UNIT})?\\D*)?`)

const UNICODE_SIGNS = '−′″'
const REPLACE_UNICODE_SIGNS = '-\'"'
const UNICODE_SIGN_REGEX = new RegExp(`[${UNICODE_SIGNS}]`, 'g')

function replaceUnicodeSign(s: string) {
	return REPLACE_UNICODE_SIGNS[UNICODE_SIGNS.indexOf(s)]
}

function isHourSign(input?: string) {
	return input === 'h' || input === 'H'
}

function isDegSign(input?: string) {
	return input === 'd' || input === 'D' || input === '°'
}

function isMinuteSign(input?: string) {
	return input === 'm' || input === 'M' || input === "'"
}

function isSecondSign(input?: string) {
	return input === 's' || input === 'S' || input === '"'
}

// Parses an angle from a string or number input.
export function parseAngle(input?: string | number, options?: ParseAngleOptions | true | Angle): Angle | undefined {
	let isHour = false
	let defaultValue: Angle | undefined

	if (options === true) {
		isHour = true
	} else if (typeof options === 'number') {
		defaultValue = options
	} else if (options !== undefined) {
		isHour = !!options.isHour
		defaultValue = options.defaultValue
	}

	if (typeof input === 'number') {
		if (!Number.isFinite(input)) return defaultValue
		return isHour ? hour(input) : deg(input)
	}

	input = input?.trim().replaceAll(UNICODE_SIGN_REGEX, replaceUnicodeSign)

	if (!input) return defaultValue

	const numericInput = +input

	if (Number.isFinite(numericInput)) {
		return isHour ? hour(numericInput) : deg(numericInput)
	}

	const res = PARSE_ANGLE_DHMS_REGEX.exec(input)

	if (res === null || res.index !== 0 || res[0].length !== input.length) {
		return defaultValue
	}

	let neg = false
	let angle = 0

	if (res[1]) {
		const a = +res[1]
		const b = res[3] ? +res[3] : 0
		const c = res[5] ? +res[5] : 0

		// Read the sign from the matched degree/hour token, not from `a < 0`: a negative angle whose integer
		// field is zero (e.g. "-000 38 00", "-0 30") parses to negative zero, and `-0 < 0` is false, which
		// would silently drop the sign and flip the angle to the wrong hemisphere. The unicode sign was already
		// normalized to ASCII above, so a leading '-' is reliable.
		neg = res[1].startsWith('-')

		if (isHourSign(res[2])) isHour = true
		else if (isDegSign(res[2])) isHour = false

		if (isMinuteSign(res[2])) angle += Math.abs(a) / 60
		else if (isSecondSign(res[2])) angle += Math.abs(a) / 3600
		else angle += Math.abs(a)

		if (b) {
			if (isSecondSign(res[4])) angle += Math.abs(b) / 3600
			else angle += Math.abs(b) / 60
		}

		if (c) {
			angle += Math.abs(c) / 3600
		}

		angle = isHour ? hour(angle) : deg(angle)

		return neg ? -angle : angle
	}

	return defaultValue
}

// Propagates a minutes overflow (>= 60) into the leading field after seconds were rounded up.
// Wraps the leading field back to 0 at 24 when formatting hours. Mutates `hdms` in place.
function carryMinute(hdms: number[], isHour: boolean) {
	if (hdms[1] >= 60) {
		hdms[1] = 0
		hdms[0]++

		if (isHour && hdms[0] === 24) {
			hdms[0] = 0
		}
	}
}

// Formats the angle as a string.
export function formatAngle(angle: Angle, options?: FormatAngleOptions) {
	const isHour = options?.isHour ?? DEFAULT_FORMAT_ANGLE_OPTIONS.isHour
	const noSecond = options?.noSecond ?? DEFAULT_FORMAT_ANGLE_OPTIONS.noSecond
	const noSign = options?.noSign ?? DEFAULT_FORMAT_ANGLE_OPTIONS.noSign
	const minusSign = options?.minusSign ?? DEFAULT_FORMAT_ANGLE_OPTIONS.minusSign
	const plusSign = options?.plusSign ?? DEFAULT_FORMAT_ANGLE_OPTIONS.plusSign
	const separators = options?.separators ?? DEFAULT_FORMAT_ANGLE_OPTIONS.separators
	const fractionDigits = options?.fractionDigits ?? DEFAULT_FORMAT_ANGLE_OPTIONS.fractionDigits
	const padLength = options?.padLength ?? DEFAULT_FORMAT_ANGLE_OPTIONS.padLength

	const hdms = isHour ? toHms(angle) : toDms(angle)
	const sign = hdms[3] === -1 ? minusSign : noSign ? '' : plusSign
	const sa = separators[0] ?? ' '
	const sb = separators[1] ?? (noSecond ? '' : sa)
	const sc = separators[2] ?? ''

	if (noSecond) {
		if (hdms[2] >= 30) {
			hdms[1]++
			carryMinute(hdms, isHour)
		}

		const d = `${Math.abs(hdms[0])}`.padStart(padLength, '0')
		const m = `${Math.abs(hdms[1])}`.padStart(2, '0')

		return `${sign}${d}${sa}${m}${sb}${sc}`
	}

	let s = hdms[2].toFixed(fractionDigits)

	if (s.startsWith('60')) {
		hdms[2] = 0
		hdms[1]++
		carryMinute(hdms, isHour)
		s = hdms[2].toFixed(fractionDigits)
	}

	const d = `${Math.abs(hdms[0])}`.padStart(padLength, '0')
	const m = `${Math.abs(hdms[1])}`.padStart(2, '0')
	s = noSecond ? '' : s.padStart(fractionDigits === 0 ? 2 : fractionDigits + 3, '0')

	return `${sign}${d}${sa}${m}${sb}${s}${sc}`
}

// Preset FormatAngleOptions for the common astronomical notations (HH:MM:SS, DMS, RA/Dec, azimuth/altitude).
// Each `*_NO_FRACTION` variant drops the fractional seconds; RA/Dec/AZ/ALT variants use space separators.
export const DEFAULT_HMS_FORMAT: FormatAngleOptions = { isHour: true, separators: ':', noSign: true }
export const DEFAULT_HMS_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_HMS_FORMAT, fractionDigits: 0 }
export const DEFAULT_DMS_FORMAT: FormatAngleOptions = { noSign: true, separators: 'dms' }
export const DEFAULT_DMS_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_DMS_FORMAT, fractionDigits: 0 }
export const DEFAULT_SIGNED_DMS_FORMAT: FormatAngleOptions = { ...DEFAULT_DMS_FORMAT, noSign: false }
export const DEFAULT_SIGNED_DMS_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_SIGNED_DMS_FORMAT, fractionDigits: 0 }
export const DEFAULT_RA_FORMAT: FormatAngleOptions = { ...DEFAULT_HMS_FORMAT, separators: ' ' }
export const DEFAULT_RA_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_RA_FORMAT, fractionDigits: 0 }
export const DEFAULT_DEC_FORMAT: FormatAngleOptions = { ...DEFAULT_SIGNED_DMS_FORMAT, separators: ' ' }
export const DEFAULT_DEC_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_DEC_FORMAT, fractionDigits: 0 }
export const DEFAULT_AZ_FORMAT: FormatAngleOptions = { ...DEFAULT_DMS_FORMAT, separators: ' ', padLength: 3 }
export const DEFAULT_AZ_NO_FRACTION_FORMAT: FormatAngleOptions = { ...DEFAULT_AZ_FORMAT, fractionDigits: 0 }

// Formats the angle as 00:00:00.00.
export function formatHMS(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_HMS_NO_FRACTION_FORMAT : DEFAULT_HMS_FORMAT)
}

// Formats the angle as 00d00m00.00s, signed only if negative
export function formatDMS(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_DMS_NO_FRACTION_FORMAT : DEFAULT_DMS_FORMAT)
}

// Formats the angle as +00d00m00.00s, always signed
export function formatSignedDMS(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_SIGNED_DMS_NO_FRACTION_FORMAT : DEFAULT_SIGNED_DMS_FORMAT)
}

// Formats the angle as 00 00 00.00
export function formatRA(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_RA_NO_FRACTION_FORMAT : DEFAULT_RA_FORMAT)
}

// Formats the angle as +00 00 00.00, always signed
export function formatDEC(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_DEC_NO_FRACTION_FORMAT : DEFAULT_DEC_FORMAT)
}

// Formats the angle as 000 00 00.00
export function formatAZ(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_AZ_NO_FRACTION_FORMAT : DEFAULT_AZ_FORMAT)
}

// Formats the angle as +00 00 00.00, always signed
export function formatALT(angle: Angle, noFractionDigits: boolean = false) {
	return formatAngle(angle, noFractionDigits ? DEFAULT_DEC_NO_FRACTION_FORMAT : DEFAULT_DEC_FORMAT)
}
