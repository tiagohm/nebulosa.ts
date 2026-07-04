import { expect, test } from 'bun:test'
import { extendedPermanentAsteroidNumber, extendedPrimaryBodyOfPermanentAsteroidNumber, extendedProvisionalAsteroidNumber, extendedSatelliteOfPermanentAsteroidNumber, originalPermanentAsteroidNumber, originalProvisionalAsteroidNumber } from '../../../../src/astronomy/ephemeris/kernels/naif'

test('NAIF asteroid numbering helpers encode original and extended schemes', () => {
	expect(originalPermanentAsteroidNumber(1)).toBe(2_000_001)
	expect(extendedPermanentAsteroidNumber(1)).toBe(20_000_001)
	expect(extendedPrimaryBodyOfPermanentAsteroidNumber(65803)).toBe(920_065_803)
	expect(extendedSatelliteOfPermanentAsteroidNumber(65803, 1)).toBe(120_065_803)
	expect(originalProvisionalAsteroidNumber(12345)).toBe(3_012_345)
	expect(extendedProvisionalAsteroidNumber(12345)).toBe(50_012_345)
})
