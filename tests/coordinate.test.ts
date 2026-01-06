import { expect, test } from 'bun:test'
import { deg, formatDEC, formatRA, parseAngle } from '../src/angle'
import { eclipticToEquatorial, equatorEcliptic, equatorialFromJ2000, equatorialToEcliptic, equatorialToEclipticJ2000, equatorialToJ2000, meridianEcliptic, meridianEquator, zenith } from '../src/coordinate'
import { timeNormalize, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2026, 1, 4, 23, 30, 0)
const SIRIUS_J2000 = [parseAngle('06h 45 09.22')!, parseAngle('-16 43 30.49')!] as const
const SIRIUS = [parseAngle('06h 46 19.27')!, parseAngle('-16 45 06.3')!] as const

test('equatorial to J2000', () => {
	const [rightAscension, declination] = equatorialToJ2000(...SIRIUS)

	expect(formatRA(rightAscension)).toBe('06 45 09.22')
	expect(formatDEC(declination)).toBe('-16 43 30.49')
})

test('equatorial from J2000', () => {
	const [rightAscension, declination] = equatorialFromJ2000(...SIRIUS_J2000)

	expect(formatRA(rightAscension)).toBe('06 46 19.27')
	expect(formatDEC(declination)).toBe('-16 45 06.30')
})

test('equatorial J2000 to ecliptic J2000', () => {
	const [longitude, latitude] = equatorialToEclipticJ2000(...SIRIUS_J2000)

	expect(formatDEC(longitude)).toBe('+104 05 03.86')
	expect(formatDEC(latitude)).toBe('-39 36 50.73')
})

test('equatorial to ecliptic', () => {
	const [longitude, latitude] = equatorialToEcliptic(...SIRIUS, TIME)

	expect(formatDEC(longitude)).toBe('+104 26 55.06')
	expect(formatDEC(latitude)).toBe('-39 36 39.12')
})

test('ecliptic to equatorial', () => {
	const [rightAscension, declination] = eclipticToEquatorial(parseAngle('284 35 58.8')!, parseAngle('-00 00 02.1')!, TIME) // Sun

	expect(formatRA(rightAscension)).toBe('19 03 23.79')
	expect(formatDEC(declination)).toBe('-22 38 16.52')
})

test('zenith', () => {
	const [rightAscension, declination] = zenith(deg(-45), deg(-22), TIME)

	expect(formatRA(rightAscension)).toBe('03 28 19.95')
	expect(formatDEC(declination)).toBe('-22 00 00.00')
})

test('meridian - equator', () => {
	const [rightAscension, declination] = meridianEquator(deg(-45), TIME)

	expect(formatRA(rightAscension)).toBe('03 28 19.95')
	expect(formatDEC(declination)).toBe('+00 00 00.00')
})

test('meridian - ecliptic', () => {
	const [rightAscension, declination] = meridianEcliptic(deg(-45), TIME)

	expect(formatRA(rightAscension)).toBe('03 28 19.95')
	expect(formatDEC(declination)).toBe('+18 52 52.84')
})

test('equator - ecliptic', () => {
	let [rightAscension, declination] = equatorEcliptic(deg(-45), TIME)

	expect(formatRA(rightAscension)).toBe('00 00 00.00')
	expect(formatDEC(declination)).toBe('+00 00 00.00')

	;[rightAscension, declination] = equatorEcliptic(deg(-45), timeNormalize(2461045, 0.58473)) // after P2 rising

	expect(formatRA(rightAscension)).toBe('12 00 00.00')
	expect(formatDEC(declination)).toBe('+00 00 00.00')

	;[rightAscension, declination] = equatorEcliptic(deg(-45), timeNormalize(2461045, 0.58403)) // before P2 rising

	expect(formatRA(rightAscension)).toBe('00 00 00.00')
	expect(formatDEC(declination)).toBe('+00 00 00.00')
})
