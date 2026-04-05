import { expect, test } from 'bun:test'
import { deg, formatDEC, formatRA, normalizeAngle, parseAngle } from '../src/angle'
import { angularDistance, eclipticToEquatorial, equatorEcliptic, equatorialFromJ2000, equatorialToEcliptic, equatorialToEclipticJ2000, equatorialToGalatic, equatorialToHorizontal, equatorialToJ2000, galacticToEquatorial, meridianEcliptic, meridianEquator, zenith } from '../src/coordinate'
import { timeNormalize, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2026, 1, 4, 23, 30, 0)
const SIRIUS_J2000 = [parseAngle('06h 45 09.22')!, parseAngle('-16 43 30.49')!] as const
const SIRIUS = [parseAngle('06h 46 19.27')!, parseAngle('-16 45 06.3')!] as const

test('equatorial to J2000', () => {
	const [rightAscension, declination] = equatorialToJ2000(...SIRIUS, TIME)

	expect(formatRA(rightAscension)).toBe('06 45 09.23')
	expect(formatDEC(declination)).toBe('-16 43 30.44')
})

test('equatorial from J2000', () => {
	const [rightAscension, declination] = equatorialFromJ2000(...SIRIUS_J2000, TIME)

	expect(formatRA(rightAscension)).toBe('06 46 19.26')
	expect(formatDEC(declination)).toBe('-16 45 06.35')
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

test('equatorial to galatic', () => {
	const [longitude, latitude] = equatorialToGalatic(...SIRIUS_J2000)

	expect(formatDEC(normalizeAngle(longitude))).toBe('+227 14 20.56')
	expect(formatDEC(latitude)).toBe('-08 53 35.22')
})

test('galatic to equatorial', () => {
	const [rightAscension, declination] = galacticToEquatorial(parseAngle('+227 14 20.56')!, parseAngle('-08 53 35.22')!)

	expect(formatRA(rightAscension)).toBe('06 45 09.22')
	expect(formatDEC(declination)).toBe('-16 43 30.49')
})

test('zenith', () => {
	const [rightAscension, declination] = zenith(deg(-45), deg(-22), TIME)

	expect(formatRA(rightAscension, true)).toBe('03 28 20')
	expect(formatDEC(declination, true)).toBe('-22 00 00')
})

test('meridian - equator', () => {
	const [rightAscension, declination] = meridianEquator(deg(-45), TIME)

	expect(formatRA(rightAscension, true)).toBe('03 28 20')
	expect(formatDEC(declination, true)).toBe('+00 00 00')
})

test('meridian - ecliptic', () => {
	const [rightAscension, declination] = meridianEcliptic(deg(-45), TIME)

	expect(formatRA(rightAscension, true)).toBe('03 28 20')
	expect(formatDEC(declination, true)).toBe('+18 52 53')
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

test('angular distance is zero for identical coordinates', () => {
	expect(angularDistance(deg(15), deg(-22), deg(15), deg(-22))).toBeCloseTo(0, 15)
})

test('angular distance is ninety degrees for equatorial quadrature', () => {
	expect(angularDistance(0, 0, deg(90), 0)).toBeCloseTo(deg(90), 15)
})

test('angular distance handles RA wrap-around near zero', () => {
	expect(angularDistance(deg(359.5), 0, deg(0.5), 0)).toBeCloseTo(deg(1), 14)
})

test('angular distance is invariant to RA at the celestial pole', () => {
	expect(angularDistance(0, deg(90), deg(137), deg(90))).toBeCloseTo(0, 15)
})

test('angular distance is one hundred eighty degrees for antipodal poles', () => {
	expect(angularDistance(0, deg(90), deg(13), deg(-90))).toBeCloseTo(Math.PI, 15)
})

test('angular distance preserves tiny separations', () => {
	expect(angularDistance(0, 0, 1e-9, 0)).toBeCloseTo(1e-9, 15)
})

test('equatorial to horizontal handles a north-pole observer', () => {
	const [azimuth, altitude] = equatorialToHorizontal(0, 0, deg(90), deg(90))

	expect(azimuth).toBeCloseTo(deg(270), 15)
	expect(altitude).toBeCloseTo(0, 15)
})
