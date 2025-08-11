import { expect, test } from 'bun:test'
import { deg, hour } from '../src/angle'
import { constellation } from '../src/constellation'
import { Timescale, timeBesselianYear } from '../src/time'

const B1875 = timeBesselianYear(1875, Timescale.TT)
const B1950 = timeBesselianYear(1950, Timescale.TT)

test('constellation', () => {
	expect(constellation(hour(9), deg(65), B1950)).toBe('UMA')
	expect(constellation(hour(23.5), deg(-20), B1950)).toBe('AQR')
	expect(constellation(hour(5.12), deg(9.12), B1950)).toBe('ORI')
	expect(constellation(hour(9.4555), deg(-19.9), B1950)).toBe('HYA')
	expect(constellation(hour(12.8888), deg(22), B1950)).toBe('COM')
	expect(constellation(hour(15.6687), deg(-12.1234), B1950)).toBe('LIB')
	expect(constellation(hour(19), deg(-40), B1950)).toBe('CRA')
	expect(constellation(hour(6.2222), deg(-81.1234), B1950)).toBe('MEN')

	expect(constellation(hour(6.241), deg(3), B1875)).toBe('ORI')
	expect(constellation(hour(6.2416), deg(3), B1875)).toBe('ORI')
	expect(constellation(hour(6.24166), deg(3), B1875)).toBe('ORI')
	expect(constellation(hour(6.24171), deg(3), B1875)).toBe('MON')
	expect(constellation(hour(22), deg(86.16), false)).toBe('CEP')
	expect(constellation(hour(22), deg(86.1666), false)).toBe('CEP')
	expect(constellation(hour(22), deg(86.16668), false)).toBe('UMI')
	expect(constellation(hour(22), deg(86.1668), false)).toBe('UMI')

	expect(constellation(deg(135), deg(65))).toBe('UMA')
	expect(constellation(hour(15), deg(30))).toBe('BOO')
})
