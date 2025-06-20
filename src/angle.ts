import { AMIN2RAD, ASEC2RAD, DEG2RAD, MILLIASEC2RAD, PI, RAD2DEG, TAU } from './constants'
import { pmod } from './math'

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

export interface ParseAngleOptions {
	isHour?: boolean
	defaultValue?: Angle
}

export interface FormatAngleOptions {
	isHour?: boolean
	noSign?: boolean
	noSecond?: boolean
	fractionDigits?: number
	separators?: string[] | string
	minusSign?: string
	plusSign?: string
	padLength?: number
}

export function normalizeAngle(angle: Angle): Angle {
	return pmod(angle, TAU)
}

export function normalizePI(angle: Angle): Angle {
	return ((angle + PI) % TAU) - PI
}

// Creates a new Angle from degrees.
export function deg(value: number): Angle {
	return value * DEG2RAD
}

// Creates a new Angle from hours.
export function hour(value: number): Angle {
	return value * (PI / 12)
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
	const neg = d < 0
	const angle = deg(Math.abs(d) + Math.abs(min) / 60 + sec / 3600)
	return neg ? -angle : angle
}

// Creates a new Angle from hours, minutes and seconds.
export function hms(h: number, min: number = 0, sec: number = 0): Angle {
	const neg = h < 0
	const angle = hour(Math.abs(h) + Math.abs(min) / 60 + sec / 3600)
	return neg ? -angle : angle
}

// Converts the angle to degrees.
export function toDeg(angle: Angle): number {
	return angle * RAD2DEG
}

// Converts the angle to hours.
export function toHour(angle: Angle): number {
	return angle * (12 / PI)
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

// Extracts the degrees, minutes and seconds from the angle.
export function toDms(angle: Angle): [number, number, number, number] {
	const d = Math.abs(toDeg(angle))
	const m = ((d - Math.trunc(d)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.abs(Math.trunc(d)), Math.trunc(m), s, Math.sign(angle)]
}

// Extracts the hours, minutes and seconds from the angle.
export function toHms(angle: Angle): [number, number, number] {
	const h = toHour(normalizeAngle(angle))
	const m = ((h - Math.trunc(h)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.trunc(h), Math.trunc(m), s]
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
	return !!input && input === 'h'
}

function isDegSign(input?: string) {
	return !!input && (input === 'd' || input === '°')
}

function isMinuteSign(input?: string) {
	return !!input && (input === 'm' || input === "'")
}

function isSecondSign(input?: string) {
	return !!input && (input === 's' || input === '"')
}

export function parseAngle(input?: string | number, options?: ParseAngleOptions): Angle | undefined {
	if (typeof input === 'number') {
		return options?.isHour ? hour(input) : deg(input)
	}

	input = input?.trim().replaceAll(UNICODE_SIGN_REGEX, replaceUnicodeSign)

	if (!input) return options?.defaultValue

	const numericInput = +input

	if (!Number.isNaN(numericInput)) {
		return options?.isHour ? hour(numericInput) : deg(numericInput)
	}

	const res = PARSE_ANGLE_DHMS_REGEX.exec(input)

	let isHour = !!options?.isHour
	let neg = false
	let angle = 0

	if (res?.[1]) {
		const a = parseFloat(res[1])
		const b = res[3] ? parseFloat(res[3]) : 0
		const c = res[5] ? parseFloat(res[5]) : 0

		neg = a < 0

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

	return options?.defaultValue
}

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
	const sign = noSign && (hdms[3] === undefined || hdms[3] === 1) ? '' : hdms[3] === -1 ? minusSign : plusSign
	const sa = separators[0] ?? ' '
	const sb = separators[1] ?? (noSecond ? '' : sa)
	const sc = separators[2] ?? ''
	let s = hdms[2].toFixed(fractionDigits)

	if (s.startsWith('60')) {
		hdms[2] = 0
		hdms[1]++

		if (!noSecond) s = hdms[2].toFixed(fractionDigits)

		if (hdms[1] >= 60) {
			hdms[1] = 0
			hdms[0]++

			if (isHour && hdms[0] === 24) {
				hdms[0] = 0
			}
		}
	}

	const d = `${Math.abs(hdms[0])}`.padStart(padLength, '0')
	const m = `${Math.abs(hdms[1])}`.padStart(2, '0')
	s = noSecond ? '' : s.padStart(fractionDigits === 0 ? 2 : fractionDigits + 3, '0')

	return `${sign}${d}${sa}${m}${sb}${s}${sc}`
}

const DEFAULT_HMS_FORMAT: FormatAngleOptions = { isHour: true, separators: ':', noSign: true }
const DEFAULT_DMS_FORMAT: FormatAngleOptions = { noSign: true, separators: 'dms' }
const DEFAULT_SIGNED_DMS_FORMAT: FormatAngleOptions = { ...DEFAULT_DMS_FORMAT, noSign: false }
const DEFAULT_RA_FORMAT = { ...DEFAULT_HMS_FORMAT, separators: ' ' }
const DEFAULT_DEC_FORMAT: FormatAngleOptions = { ...DEFAULT_SIGNED_DMS_FORMAT, separators: ' ', padLength: 3 }

// Format the angle as 00:00:00.00.
export function formatHms(angle: Angle) {
	return formatAngle(angle, DEFAULT_HMS_FORMAT)
}

// Format the angle as 00d00m00.00s, signed only if negative
export function formatDms(angle: Angle) {
	return formatAngle(angle, DEFAULT_DMS_FORMAT)
}

// Format the angle as +00d00m00.00s, always signed
export function formatSignedDms(angle: Angle) {
	return formatAngle(angle, DEFAULT_SIGNED_DMS_FORMAT)
}

// Format the angle as 00 00 00.00
export function formatRA(angle: Angle) {
	return formatAngle(angle, DEFAULT_RA_FORMAT)
}

// Format the angle as +000 00 00.00, always signed
export function formatDEC(angle: Angle) {
	return formatAngle(angle, DEFAULT_DEC_FORMAT)
}
