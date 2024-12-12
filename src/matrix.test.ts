import { expect, test } from 'bun:test'
import { identity, Mat3, rotX, rotY, rotZ } from './matrix'

test('rotX', () => {
	const m = new Mat3(2, 3, 2, 3, 2, 3, 3, 4, 5)
	m.rotX(0.3456789)

	expect(m[0]).toBeCloseTo(2, 12)
	expect(m[1]).toBeCloseTo(3, 12)
	expect(m[2]).toBeCloseTo(2, 12)
	expect(m[3]).toBeCloseTo(3.83904338823561246, 12)
	expect(m[4]).toBeCloseTo(3.237033249594111899, 12)
	expect(m[5]).toBeCloseTo(4.516714379005982719, 12)
	expect(m[6]).toBeCloseTo(1.806030415924501684, 12)
	expect(m[7]).toBeCloseTo(3.085711545336372503, 12)
	expect(m[8]).toBeCloseTo(3.687721683977873065, 12)

	expect(identity().rotX(0.3456789)).toEqual(rotX(0.3456789))
})

test('rotY', () => {
	const m = new Mat3(2, 3, 2, 3, 2, 3, 3, 4, 5)
	m.rotY(0.3456789)

	expect(m[0]).toBeCloseTo(0.865184781897815993, 12)
	expect(m[1]).toBeCloseTo(1.467194920539316554, 12)
	expect(m[2]).toBeCloseTo(0.1875137911274457342, 12)
	expect(m[3]).toBeCloseTo(3, 12)
	expect(m[4]).toBeCloseTo(2, 12)
	expect(m[5]).toBeCloseTo(3, 12)
	expect(m[6]).toBeCloseTo(3.50020789285042733, 12)
	expect(m[7]).toBeCloseTo(4.77988902226229815, 12)
	expect(m[8]).toBeCloseTo(5.381899160903798712, 12)

	expect(identity().rotY(0.3456789)).toEqual(rotY(0.3456789))
})

test('rotZ', () => {
	const m = new Mat3(2, 3, 2, 3, 2, 3, 3, 4, 5)
	m.rotZ(0.3456789)

	expect(m[0]).toBeCloseTo(2.898197754208926769, 12)
	expect(m[1]).toBeCloseTo(3.50020789285042733, 12)
	expect(m[2]).toBeCloseTo(2.898197754208926769, 12)
	expect(m[3]).toBeCloseTo(2.144865911309686813, 12)
	expect(m[4]).toBeCloseTo(0.865184781897815993, 12)
	expect(m[5]).toBeCloseTo(2.144865911309686813, 12)
	expect(m[6]).toBeCloseTo(3, 12)
	expect(m[7]).toBeCloseTo(4, 12)
	expect(m[8]).toBeCloseTo(5, 12)

	expect(identity().rotZ(0.3456789)).toEqual(rotZ(0.3456789))
})

test('clone', () => {
	const m = new Mat3(2, 3, 2, 3, 2, 3, 3, 4, 5)
	const n = m.clone()
	expect(n).toEqual(m)
	expect(m === n).toBe(false)
})
