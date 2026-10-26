// INDI number encoding: parsing a numberValue received on the wire and formatting a value with the printf
// style format a driver declares on its defNumber, including the INDI sexagesimal extension %<w>.<f>m.
// Values stay in the driver's own units (hours, degrees, seconds, ...): nothing here converts angles or
// infers a unit from a property or element name. Pure and allocation-light, so it is safe for any runtime.

// Fraction base of the sexagesimal formats by their precision digit f of %<w>.<f>m, as INDI's numberFormat:
// 9 → :mm:ss.ss, 8 → :mm:ss.s, 6 → :mm:ss, 5 → :mm.m, anything else → :mm.
const SEXAGESIMAL_BASES: Readonly<Record<number, number>> = { 9: 360000, 8: 36000, 6: 3600, 5: 600 }

// One printf conversion: flags, width, optional precision, and conversion character. The INDI sexagesimal
// conversion m is matched too, so a format is scanned once.
const CONVERSION = /%([-+ 0#]*)(\d*)(?:\.(\d*))?([diufFeEgGm])/

// Default precision of the f, e, and g conversions when the format omits it, as in C.
const DEFAULT_PRECISION = 6

// Parses an INDI numberValue as a decimal or sexagesimal scalar without applying an angle unit conversion.
// Sexagesimal fields are separated by ':', ';' or whitespace (12:30:36, 12;30, -5 30); missing minute or
// second fields are zero, and a leading sign applies to the whole value. Returns NaN for text that is
// neither; an empty or blank text reads as 0, as Number reads it.
export function parseIndiNumber(value: string) {
	const numeric = Number(value)
	if (!Number.isNaN(numeric)) return numeric

	const fields = (value.includes(':') || value.includes(';') ? value.split(/[:;]/) : value.split(/\s+/)).map((field) => field.trim())
	if (fields.length > 3 || fields[0] === '') return Number.NaN

	const first = fields[0]
	const sign = first.startsWith('-') ? -1 : 1
	const degrees = Math.abs(Number(first))
	const minutes = fields.length > 1 && fields[1] !== '' ? Number(fields[1]) : 0
	const seconds = fields.length > 2 && fields[2] !== '' ? Number(fields[2]) : 0

	if (fields.slice(1).some((field) => field.startsWith('+') || field.startsWith('-')) || Number.isNaN(degrees) || Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.NaN

	return sign * (degrees + minutes / 60 + seconds / 3600)
}

// Formats a value with the format of its defNumber, as INDI's numberFormat does: %<w>.<f>m writes it in
// sexagesimal (whole part right-aligned in w - f characters, then the fields chosen by f, rounded to the
// last field shown), and any other format is a C printf conversion among d, i, u, f, F, e, E, g, and G
// with the flags -, +, space, 0, and #. Text around the conversion is kept and %% writes a percent sign.
// d, i, and u truncate the value toward zero, the intent of drivers that declare an integer format for a
// double. A format without a conversion returns the value as JavaScript writes it. Non-finite values are
// written nan, inf, or -inf. Digits come from toFixed and toExponential, so a value exactly halfway between
// two outputs rounds away from zero (2.5 with %.0f is 3), where glibc rounds it to even (2).
export function formatIndiNumber(value: number, format: string) {
	const match = CONVERSION.exec(format)
	if (match === null) return String(value)

	const [conversion, flags, width, precision, type] = match
	const text = type === 'm' ? formatSexagesimal(value, +width - +(precision ?? 0), +(precision ?? 0)) : formatPrintf(value, flags, width === '' ? 0 : +width, precision === undefined ? undefined : +precision, type)

	return unescapePercent(format.slice(0, match.index)) + text + unescapePercent(format.slice(match.index + conversion.length))
}

// Writes a value as INDI's fs_sexa: the whole part right-aligned in width characters (a negative value
// below one keeps its sign as -0), then :mm, :mm.m, :mm:ss, :mm:ss.s, or :mm:ss.ss by the precision digit.
function formatSexagesimal(value: number, width: number, precision: number) {
	if (!Number.isFinite(value)) return nonFinite(value)

	const base = SEXAGESIMAL_BASES[precision] ?? 60
	const negative = value < 0
	// Integral number of the smallest field shown, rounded half up as the C implementation does.
	const n = Math.floor(Math.abs(value) * base + 0.5)
	const whole = Math.floor(n / base)
	const fraction = n % base

	let text = (negative && whole === 0 ? '-0' : String(negative ? -whole : whole)).padStart(width)

	switch (base) {
		case 60:
			text += `:${pad2(fraction)}`
			break
		case 600:
			text += `:${pad2(Math.floor(fraction / 10))}.${fraction % 10}`
			break
		case 3600:
			text += `:${pad2(Math.floor(fraction / 60))}:${pad2(fraction % 60)}`
			break
		case 36000: {
			const seconds = fraction % 600
			text += `:${pad2(Math.floor(fraction / 600))}:${pad2(Math.floor(seconds / 10))}.${seconds % 10}`
			break
		}
		default: {
			const seconds = fraction % 6000
			text += `:${pad2(Math.floor(fraction / 6000))}:${pad2(Math.floor(seconds / 100))}.${pad2(seconds % 100)}`
		}
	}

	return text
}

// Writes a value with one C printf conversion: the digits by type and precision, then the sign or space,
// then the padding to width (zeros after the sign with the 0 flag, spaces after the text with -).
function formatPrintf(value: number, flags: string, width: number, precision: number | undefined, type: string) {
	const alternate = flags.includes('#')
	const integral = type === 'd' || type === 'i' || type === 'u'
	// A truncated integer has no negative zero; a fixed or exponential one keeps it, as C writes -0.00.
	const negative = integral ? Math.trunc(value) < 0 : value < 0 || Object.is(value, -0)
	const magnitude = Math.abs(value)
	let digits: string

	if (!Number.isFinite(value)) {
		digits = nonFinite(magnitude)
	} else {
		switch (type) {
			case 'd':
			case 'i':
			case 'u': {
				const integer = String(Math.trunc(magnitude))
				// An explicit precision is the minimum number of digits, and a zero value with precision 0 has none.
				digits = precision === undefined ? integer : precision === 0 && integer === '0' ? '' : integer.padStart(precision, '0')
				break
			}
			case 'f':
			case 'F':
				digits = magnitude.toFixed(precision ?? DEFAULT_PRECISION)
				if (alternate && precision === 0) digits += '.'
				break
			case 'e':
			case 'E':
				digits = exponential(magnitude, precision ?? DEFAULT_PRECISION, alternate)
				break
			default:
				digits = general(magnitude, precision ?? DEFAULT_PRECISION, alternate)
		}
	}

	if (type === 'E' || type === 'G' || type === 'F') digits = digits.toUpperCase()

	const sign = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
	const fill = width - sign.length - digits.length

	if (fill <= 0) return sign + digits
	if (flags.includes('-')) return sign + digits + ' '.repeat(fill)
	// The 0 flag is ignored for an integer with an explicit precision and for a non-finite value, as in C.
	if (flags.includes('0') && Number.isFinite(value) && !(precision !== undefined && integral)) return sign + '0'.repeat(fill) + digits
	return ' '.repeat(fill) + sign + digits
}

// Writes a non-negative finite value as C's %e: one digit, the fraction of precision digits, and an
// exponent of at least two digits.
function exponential(value: number, precision: number, alternate: boolean) {
	const [mantissa, exponent] = value.toExponential(precision).split('e')
	const sign = exponent[0] === '-' ? '-' : '+'
	const digits = exponent.slice(1).padStart(2, '0')
	return `${alternate && precision === 0 ? `${mantissa}.` : mantissa}e${sign}${digits}`
}

// Writes a non-negative finite value as C's %g: precision significant digits (at least one), in fixed
// notation when the decimal exponent X after rounding satisfies -4 <= X < precision, in exponential
// notation otherwise, with trailing zeros removed unless alternate.
function general(value: number, precision: number, alternate: boolean) {
	const significant = precision === 0 ? 1 : precision
	const exponent = value === 0 ? 0 : +value.toExponential(significant - 1).split('e')[1]
	const text = exponent >= -4 && exponent < significant ? value.toFixed(significant - 1 - exponent) : exponential(value, significant - 1, false)

	if (alternate) return text.includes('.') ? text : text.replace(/(e|$)/, '.$1')

	const [mantissa, suffix] = text.split('e')
	const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
	return suffix === undefined ? trimmed : `${trimmed}e${suffix}`
}

// Writes a non-finite value as C does.
function nonFinite(value: number) {
	return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf'
}

// Writes an integer in [0, 99] with two digits.
function pad2(value: number) {
	return value < 10 ? `0${value}` : String(value)
}

// Replaces the escaped percent signs of the literal text of a format.
function unescapePercent(text: string) {
	return text.replaceAll('%%', '%')
}
