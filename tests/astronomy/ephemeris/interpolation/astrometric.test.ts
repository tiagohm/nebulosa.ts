import { expect, test } from 'bun:test'
import { angularDistance } from '../../../../src/astronomy/coordinates/coordinate'
import { AstrometricInterpolator, type AstrometricInterpolationMethod } from '../../../../src/astronomy/ephemeris/interpolation/astrometric'
import { TAU } from '../../../../src/core/constants'
import { deg } from '../../../../src/math/units/angle'

function makeGrid(width: number, height: number, coordinate: (col: number, row: number) => readonly [number, number]) {
	const ra = new Float64Array(width * height)
	const dec = new Float64Array(width * height)

	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const index = row * width + col
			const sample = coordinate(col, row)
			ra[index] = sample[0]
			dec[index] = sample[1]
		}
	}

	return { ra, dec }
}

function expectFiniteSky(sky: readonly [number, number]) {
	expect(Number.isFinite(sky[0])).toBe(true)
	expect(Number.isFinite(sky[1])).toBe(true)
	expect(sky[0]).toBeGreaterThanOrEqual(0)
	expect(sky[0]).toBeLessThan(TAU)
	expect(sky[1]).toBeGreaterThanOrEqual(-Math.PI / 2)
	expect(sky[1]).toBeLessThanOrEqual(Math.PI / 2)
}

test('constant grid returns the same sky coordinate', () => {
	const rightAscension = deg(123)
	const declination = deg(-34)
	const { ra, dec } = makeGrid(4, 3, () => [rightAscension, declination])
	const interpolator = new AstrometricInterpolator(ra, dec, 4, 3, 32, 16)

	for (const [x, y] of [
		[0, 0],
		[12.5, 7.25],
		[64, 16],
		[96, 32],
	]) {
		const sky = interpolator.pixelToSky(x, y)
		expect(sky[0]).toBeCloseTo(rightAscension, 14)
		expect(sky[1]).toBeCloseTo(declination, 14)
	}
})

test('cell center interpolation follows a smooth local trend', () => {
	const { ra, dec } = makeGrid(4, 4, (col, row) => [deg(10 + col), deg(-5 + row)])
	const interpolator = new AstrometricInterpolator(ra, dec, 4, 4, 10, 20, { interpolation: 'bilinear' })
	const sky = interpolator.pixelToSky(15, 30)

	expectFiniteSky(sky)
	expect(sky[0]).toBeCloseTo(deg(11.5), 3)
	expect(sky[1]).toBeCloseTo(deg(-3.5), 3)
})

test('interpolates RA wrap through zero without crossing pi', () => {
	const samples = [
		[deg(359.9), 0],
		[0, 0],
		[deg(0.1), 0],
	] as const
	const { ra, dec } = makeGrid(3, 2, (col) => samples[col])
	const interpolator = new AstrometricInterpolator(ra, dec, 3, 2, 10, 10, { interpolation: 'bilinear' })
	const sky = interpolator.pixelToSky(5, 5)

	expectFiniteSky(sky)
	expect(Math.min(sky[0], TAU - sky[0])).toBeLessThan(deg(0.1))
})

test('interpolation passes exactly through interior grid nodes', () => {
	// Node (col, row) maps to pixel (col*scaleX, row*scaleY); a smooth interpolator
	// must reproduce the sampled value there for both bilinear and Catmull-Rom.
	const { ra, dec } = makeGrid(4, 4, (col, row) => [deg(10 + col), deg(-5 + row)])

	for (const interpolation of ['bilinear', 'catmullRom'] as const) {
		const interpolator = new AstrometricInterpolator(ra, dec, 4, 4, 10, 20, { interpolation })
		const sky = interpolator.pixelToSky(20, 40) // node col=2, row=2
		expect(sky[0]).toBeCloseTo(deg(12), 12)
		expect(sky[1]).toBeCloseTo(deg(-3), 12)
	}
})

test('border queries clamp instead of extrapolating', () => {
	const { ra, dec } = makeGrid(3, 3, (col, row) => [deg(20 + 10 * col), deg(-10 + 5 * row)])
	const interpolator = new AstrometricInterpolator(ra, dec, 3, 3, 10, 10, { interpolation: 'nearest' })
	const negative = interpolator.pixelToSky(-100, -50)
	const beyond = interpolator.pixelToSky(1000, 500)

	expectFiniteSky(negative)
	expectFiniteSky(beyond)
	expect(negative[0]).toBeCloseTo(deg(20), 14)
	expect(negative[1]).toBeCloseTo(deg(-10), 14)
	expect(beyond[0]).toBeCloseTo(deg(40), 14)
	expect(beyond[1]).toBeCloseTo(0, 14)
})

test('supported interpolation methods produce finite nearby results on a smooth grid', () => {
	const { ra, dec } = makeGrid(6, 5, (col, row) => [deg(40 + 0.4 * col + 0.08 * row), deg(-8 + 0.2 * row - 0.04 * col)])
	const methods: AstrometricInterpolationMethod[] = ['nearest', 'bilinear', 'catmullRom', 'cubicConvolution'] // , 'naturalCubic', 'cubicHermite', 'pchip', 'akima', 'chebyshev'
	const reference = new AstrometricInterpolator(ra, dec, 6, 5, 16, 12, { interpolation: 'catmullRom' }).pixelToSky(41.25, 22.5)

	for (const interpolation of methods) {
		const sky = new AstrometricInterpolator(ra, dec, 6, 5, 16, 12, { interpolation }).pixelToSky(41.25, 22.5)
		expectFiniteSky(sky)
		expect(angularDistance(sky[0], sky[1], reference[0], reference[1])).toBeLessThan(deg(0.35))
		if (interpolation === 'cubicConvolution') expect(angularDistance(sky[0], sky[1], reference[0], reference[1])).toBeCloseTo(0, 14)
	}
})

test('normalizes the interpolated vector before converting to declination', () => {
	const { ra, dec } = makeGrid(2, 2, (_col, row) => [0, row === 0 ? 0 : Math.PI / 2])
	const interpolator = new AstrometricInterpolator(ra, dec, 2, 2, 10, 10, { interpolation: 'bilinear' })
	const sky = interpolator.pixelToSky(5, 5)

	expectFiniteSky(sky)
	expect(sky[0]).toBeCloseTo(0, 14)
	expect(sky[1]).toBeCloseTo(Math.PI / 4, 14)
})

test('falls back to nearest sample when interpolation cancels to zero vector', () => {
	const { ra, dec } = makeGrid(2, 1, (col) => [col === 0 ? 0 : Math.PI, 0])
	const interpolator = new AstrometricInterpolator(ra, dec, 2, 1, 10, 10, { interpolation: 'bilinear' })
	const sky = interpolator.pixelToSky(5, 0)

	expectFiniteSky(sky)
	expect(sky[0]).toBeCloseTo(Math.PI, 14)
	expect(sky[1]).toBeCloseTo(0, 14)
})

test('constructs derived Cartesian grids once as Float64Array', () => {
	const { ra, dec } = makeGrid(2, 2, (col, row) => [deg(col), deg(row)])
	const interpolator = new AstrometricInterpolator(ra, dec, 2, 2, 10, 10)

	expect(interpolator.xGrid).toBeInstanceOf(Float64Array)
	expect(interpolator.yGrid).toBeInstanceOf(Float64Array)
	expect(interpolator.zGrid).toBeInstanceOf(Float64Array)
	expect(interpolator.xGrid).toHaveLength(4)
	expect(interpolator.yGrid).toHaveLength(4)
	expect(interpolator.zGrid).toHaveLength(4)
})

test('writes pixelToSky results into the provided output tuple', () => {
	const { ra, dec } = makeGrid(2, 2, () => [deg(5), deg(6)])
	const interpolator = new AstrometricInterpolator(ra, dec, 2, 2, 10, 10)
	const out: [number, number] = [0, 0]

	expect(interpolator.pixelToSky(1, 1, out)).toBe(out)
	expect(out[0]).toBeCloseTo(deg(5), 14)
	expect(out[1]).toBeCloseTo(deg(6), 14)
})

test('rejects invalid constructor inputs', () => {
	expect(() => new AstrometricInterpolator([0], [0], 0, 1, 1, 1)).toThrow('value must be a positive integer')
	expect(() => new AstrometricInterpolator([0], [0], 1.5, 1, 1, 1)).toThrow('value must be a positive integer')
	expect(() => new AstrometricInterpolator([0], [0], 1, 1, 0, 1)).toThrow('value must be positive')
	expect(() => new AstrometricInterpolator([0], [0], 1, 1, 1, Number.NaN)).toThrow('value must be finite')
	expect(() => new AstrometricInterpolator([0, 1], [0], 1, 1, 1, 1)).toThrow('astrometric RA and Dec grids must have the same length')
	expect(() => new AstrometricInterpolator([0, 1], [0, 1], 3, 1, 1, 1)).toThrow('astrometric grid length must equal width * height')
	expect(() => new AstrometricInterpolator([Number.NaN], [0], 1, 1, 1, 1)).toThrow('astrometric RA grid value at index 0 must be finite')
	expect(() => new AstrometricInterpolator([0], [Number.POSITIVE_INFINITY], 1, 1, 1, 1)).toThrow('astrometric Dec grid value at index 0 must be finite')
	expect(() => new AstrometricInterpolator([0], [0], 1, 1, 1, 1, { interpolation: 'cubicConvolution', cubicTension: Number.NaN })).toThrow('astrometric cubic tension must be finite')
})
