import { expect, test } from 'bun:test'
import { equatorialToHorizontal } from '../../../src/astronomy/coordinates/coordinate'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { enuToEquatorialMatrix, enuToTakiMatrix, enuVectorToHorizontal, equatorialToEnuMatrix, horizontalToEnuVector, takiToEnuMatrix } from '../../../src/astronomy/coordinates/frame.local'
import { PIOVERTWO } from '../../../src/core/constants'
import { matDeterminant, matIdentity, matMul, matMulVec, matTranspose } from '../../../src/math/linear-algebra/mat3'
import { deg } from '../../../src/math/units/angle'

// Tests local-frame conventions, round trips, and equivalence with the existing trigonometric API.

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

// Compares one 3x3 matrix at the requested decimal precision.
function expectMatrixClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 9; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

test('horizontal cardinal directions follow ENU', () => {
	expectVectorClose(horizontalToEnuVector(0, 0), [0, 1, 0])
	expectVectorClose(horizontalToEnuVector(PIOVERTWO, 0), [1, 0, 0])
	expectVectorClose(horizontalToEnuVector(Math.PI, 0), [0, -1, 0])
	expectVectorClose(horizontalToEnuVector(3 * PIOVERTWO, 0), [-1, 0, 0])
	expectVectorClose(horizontalToEnuVector(0, PIOVERTWO), [0, 0, 1])
})

test('ENU conversion canonicalizes azimuth at zenith and nadir', () => {
	expect(enuVectorToHorizontal([0, 0, 4])).toEqual({ azimuth: 0, altitude: PIOVERTWO })
	expect(enuVectorToHorizontal([0, 0, -2])).toEqual({ azimuth: 0, altitude: -PIOVERTWO })
	expect(() => enuVectorToHorizontal([0, 0, 0])).toThrow()
})

test('equatorial matrix matches the existing trigonometric conversion', () => {
	const latitudes = [deg(-90), deg(-23.55), 0, deg(52), deg(90)]
	const lsts = [0, deg(37), deg(180), deg(359.9)]
	const rightAscensions = [0, deg(0.1), deg(95), deg(240), deg(359.9)]
	const declinations = [deg(-90), deg(-60), 0, deg(42), deg(90)]

	for (const latitude of latitudes) {
		for (const lst of lsts) {
			const matrix = equatorialToEnuMatrix(latitude, lst)
			for (const rightAscension of rightAscensions) {
				for (const declination of declinations) {
					const actual = matMulVec(matrix, eraS2c(rightAscension, declination))
					const [azimuth, altitude] = equatorialToHorizontal(rightAscension, declination, latitude, lst)
					const expected = horizontalToEnuVector(azimuth, altitude)
					expectVectorClose(actual, expected, 11)
				}
			}
		}
	}
})

test('equatorial and Taki matrices are proper rotations with transpose inverses', () => {
	for (const latitude of [deg(-90), deg(-23), 0, deg(48), deg(90)]) {
		const equatorial = equatorialToEnuMatrix(latitude, deg(123))
		const taki = takiToEnuMatrix(latitude)

		expectMatrixClose(enuToEquatorialMatrix(latitude, deg(123)), matTranspose(equatorial))
		expectMatrixClose(enuToTakiMatrix(latitude), matTranspose(taki))
		expectMatrixClose(matMul(equatorial, matTranspose(equatorial)), matIdentity())
		expectMatrixClose(matMul(taki, matTranspose(taki)), matIdentity())
		expect(matDeterminant(equatorial)).toBeCloseTo(1, 12)
		expect(matDeterminant(taki)).toBeCloseTo(1, 12)
	}
})

test('positive west hour angle has negative Taki Y and points west in ENU', () => {
	const latitude = deg(30)
	const hourAngle = deg(45)
	const declination = deg(20)
	const taki = [Math.cos(declination) * Math.cos(hourAngle), -Math.cos(declination) * Math.sin(hourAngle), Math.sin(declination)] as const
	const enu = matMulVec(takiToEnuMatrix(latitude), taki)

	expect(taki[1]).toBeLessThan(0)
	expect(enu[0]).toBeLessThan(0)
	expectVectorClose(matMulVec(enuToTakiMatrix(latitude), enu), taki)
})
