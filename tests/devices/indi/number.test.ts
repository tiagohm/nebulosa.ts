import { describe, expect, test } from 'bun:test'
import { formatIndiNumber, parseIndiNumber } from '../../../src/devices/indi/number'

describe('parse', () => {
	test('decimal', () => {
		expect(parseIndiNumber('1.25')).toBe(1.25)
		expect(parseIndiNumber('1e-6')).toBe(1e-6)
		expect(parseIndiNumber('-42')).toBe(-42)
		expect(parseIndiNumber('')).toBe(0)
	})

	test('sexagesimal', () => {
		expect(parseIndiNumber('12:30:36')).toBeCloseTo(12.51, 12)
		expect(parseIndiNumber('12;30')).toBe(12.5)
		expect(parseIndiNumber('-5 30')).toBe(-5.5)
		expect(parseIndiNumber('-0:30')).toBe(-0.5)
		expect(parseIndiNumber('+5:30:00')).toBe(5.5)
		expect(parseIndiNumber('5:34:32.1')).toBeCloseTo(5 + 34 / 60 + 32.1 / 3600, 12)
	})

	test('unreadable', () => {
		expect(parseIndiNumber('abc')).toBeNaN()
		expect(parseIndiNumber('1:2:3:4')).toBeNaN()
		expect(parseIndiNumber('5:-30')).toBeNaN()
		expect(parseIndiNumber(':30')).toBeNaN()
	})
})

// Expected printf outputs were produced with the C printf of GNU bash 5 for the same format and value.
describe('format printf', () => {
	test('general', () => {
		expect(formatIndiNumber(1234567, '%g')).toBe('1.23457e+06')
		expect(formatIndiNumber(0.0001, '%g')).toBe('0.0001')
		expect(formatIndiNumber(0.00001, '%g')).toBe('1e-05')
		expect(formatIndiNumber(123456.7, '%g')).toBe('123457')
		expect(formatIndiNumber(100000, '%g')).toBe('100000')
		expect(formatIndiNumber(1000000, '%g')).toBe('1e+06')
		expect(formatIndiNumber(0.0012345, '%.3g')).toBe('0.00123')
		expect(formatIndiNumber(0.1, '%.10g')).toBe('0.1')
		expect(formatIndiNumber(1, '%#g')).toBe('1.00000')
		expect(formatIndiNumber(1e-10, '%G')).toBe('1E-10')
		expect(formatIndiNumber(0, '%g')).toBe('0')
	})

	test('fixed', () => {
		expect(formatIndiNumber(-3.14159, '%10.4f')).toBe('   -3.1416')
		expect(formatIndiNumber(2.5, '%-8.2f|')).toBe('2.50    |')
		expect(formatIndiNumber(2.5, '%+08.3f')).toBe('+002.500')
		expect(formatIndiNumber(2, '% f')).toBe(' 2.000000')
		expect(formatIndiNumber(3.5, '%.0f')).toBe('4')
		expect(formatIndiNumber(3, '%#.0f')).toBe('3.')
		expect(formatIndiNumber(1500, '%5.0f')).toBe(' 1500')
		expect(formatIndiNumber(-0.0000001, '%f')).toBe('-0.000000')
		expect(formatIndiNumber(-0, '%.2f')).toBe('-0.00')
	})

	test('exponential', () => {
		expect(formatIndiNumber(12345.678, '%e')).toBe('1.234568e+04')
		expect(formatIndiNumber(0, '%E')).toBe('0.000000E+00')
		expect(formatIndiNumber(-0.000123, '%.2e')).toBe('-1.23e-04')
	})

	test('integer', () => {
		expect(formatIndiNumber(3.9, '%d')).toBe('3')
		expect(formatIndiNumber(-3.9, '%d')).toBe('-3')
		expect(formatIndiNumber(-0.5, '%d')).toBe('0')
		expect(formatIndiNumber(42, '%05d')).toBe('00042')
		expect(formatIndiNumber(7, '%.3d')).toBe('007')
		expect(formatIndiNumber(7, '%05.3d')).toBe('  007')
	})

	test('non-finite', () => {
		expect(formatIndiNumber(Number.NaN, '%f')).toBe('nan')
		expect(formatIndiNumber(Number.NEGATIVE_INFINITY, '%08.2f')).toBe('    -inf')
		expect(formatIndiNumber(Number.POSITIVE_INFINITY, '%E')).toBe('INF')
	})

	test('literal text', () => {
		expect(formatIndiNumber(1.5, '%.2f s')).toBe('1.50 s')
		expect(formatIndiNumber(2, '100%% %.0f')).toBe('100% 2')
		expect(formatIndiNumber(1.5, 'none')).toBe('1.5')
	})
})

describe('format sexagesimal', () => {
	test('fields by precision', () => {
		expect(formatIndiNumber(1.75, '%5.3m')).toBe(' 1:45')
		expect(formatIndiNumber(1.755, '%6.5m')).toBe('1:45.3')
		expect(formatIndiNumber(5.5, '%10.6m')).toBe('   5:30:00')
		expect(formatIndiNumber(5.5025, '%11.8m')).toBe('  5:30:09.0')
		expect(formatIndiNumber(-10.505, '%10.9m')).toBe('-10:30:18.00')
	})

	test('negative below one keeps its sign', () => {
		expect(formatIndiNumber(-0.5, '%9.6m')).toBe(' -0:30:00')
		expect(formatIndiNumber(-0.5, '%.6m')).toBe('-0:30:00')
	})

	test('rounds to the last field shown', () => {
		expect(formatIndiNumber(1.9999999, '%9.6m')).toBe('  2:00:00')
		expect(formatIndiNumber(359.99999, '%10.6m')).toBe(' 360:00:00')
	})

	test('round trip', () => {
		expect(parseIndiNumber(formatIndiNumber(-10.505, '%10.9m'))).toBeCloseTo(-10.505, 9)
		expect(parseIndiNumber(formatIndiNumber(12.51, '%010.6m'))).toBeCloseTo(12.51, 9)
	})

	test('non-finite', () => {
		expect(formatIndiNumber(Number.NaN, '%10.6m')).toBe('nan')
	})
})
