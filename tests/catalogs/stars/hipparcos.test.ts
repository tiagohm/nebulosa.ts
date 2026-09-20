import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { spaceMotion, star } from '../../../src/astronomy/bodies/star'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { timeJulianYear } from '../../../src/astronomy/time/time'
import { HipparcosCatalog, type HipparcosCatalogEntry, readHipparcosCatalog } from '../../../src/catalogs/stars/hipparcos'
import { bufferSource, fileHandleSource, readableStreamSource } from '../../../src/io/io'
import { deg, mas, normalizeAngle, toMas } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'

await downloadPerTag('hipparcos')

test.concurrent('official Hipparcos catalog preserves astrometry and skips missing positions', async () => {
	let usableRows = 0
	let sirius: HipparcosCatalogEntry | undefined
	let barnard: HipparcosCatalogEntry | undefined
	let negative: HipparcosCatalogEntry | undefined

	await using source = fileHandleSource(await fs.open('data/hip_main.dat', 'r'))
	for await (const entry of readHipparcosCatalog(source)) {
		usableRows++
		if (entry.id === 32349) sirius = entry
		else if (entry.id === 87937) barnard = entry
		else if (entry.id === 40) negative = entry
	}

	expect(usableRows).toBe(117955)
	expect(sirius?.id).toBe(32349)
	expect(sirius?.epoch).toBe(1991.25)
	expect(sirius?.rightAscension).toBeCloseTo(deg(101.28854105), 12)
	expect(sirius?.declination).toBeCloseTo(deg(-16.71314306), 12)
	expect(sirius?.magnitude).toBe(-1.44)
	expect(toMas(sirius!.parallax!)).toBeCloseTo(379.21, 8)
	expect(toMas(sirius!.pmRA!)).toBeCloseTo(-546.01 / Math.cos(deg(-16.71314306)), 8)
	expect(toMas(sirius!.pmRA! * Math.cos(sirius!.declination))).toBeCloseTo(-546.01, 8)
	expect(toMas(sirius!.pmDEC!)).toBeCloseTo(-1223.08, 8)
	expect(sirius?.rv).toBeUndefined()

	expect(barnard?.id).toBe(87937)
	expect(barnard?.epoch).toBe(1991.25)
	expect(barnard?.rightAscension).toBeCloseTo(deg(269.45402305), 12)
	expect(barnard?.declination).toBeCloseTo(deg(4.66828815), 12)
	expect(barnard?.magnitude).toBe(9.54)
	expect(toMas(barnard!.parallax!)).toBeCloseTo(549.01, 8)
	expect(toMas(barnard!.pmRA!)).toBeCloseTo(-797.84 / Math.cos(deg(4.66828815)), 8)
	expect(toMas(barnard!.pmRA! * Math.cos(barnard!.declination))).toBeCloseTo(-797.84, 8)
	expect(toMas(barnard!.pmDEC!)).toBeCloseTo(10326.93, 8)
	expect(toMas(negative!.parallax!)).toBeCloseTo(-3.4, 8)

	// PyERFA 2.0.1.5, erfa.starpm, zero RV, TT Julian epochs J1991.25 to J2025.0.
	const stellarState = star(barnard!.rightAscension, barnard!.declination, barnard!.pmRA, barnard!.pmDEC, barnard!.parallax, 0, timeJulianYear(barnard!.epoch))
	const [stateRa, stateDec] = eraC2s(...stellarState[0])
	expect(normalizeAngle(stateRa)).toBeCloseTo(barnard!.rightAscension, 8)
	expect(stateDec).toBeCloseTo(barnard!.declination, 8)
	const [movedRa, movedDec] = eraC2s(...spaceMotion(stellarState, timeJulianYear(2025))[0])
	expect(normalizeAngle(movedRa)).toBeCloseTo(4.702728886110352, 11)
	expect(movedDec).toBeCloseTo(0.08316673630073339, 11)
}, 8000)

test.concurrent('streaming chunks, missing fields, invalid positions, and polar motion', async () => {
	const row = (id: number, ra: string, dec: string, magnitude = '', parallax = '', pmRA = '', pmDEC = '') => {
		const fields = new Array<string>(78).fill('')
		fields[0] = 'H'
		fields[1] = String(id)
		fields[5] = magnitude
		fields[8] = ra
		fields[9] = dec
		fields[11] = parallax
		fields[12] = pmRA
		fields[13] = pmDEC
		return fields.join('|')
	}

	const bytes = Buffer.from(`${row(1, '12.5', '-4.5')}\n${row(2, '', '20')}\n${row(3, 'NaN', '20')}\n${row(4, '33', '90', '5', '-2', '10', '3')}\n${row(0, '10', '10')}\n`)
	let offset = 0

	const stream = new ReadableStream<Uint8Array>({
		pull(controller: ReadableStreamDefaultController<Uint8Array>) {
			if (offset >= bytes.length) controller.close()
			else {
				controller.enqueue(bytes.subarray(offset, offset + 3))
				offset += 3
			}
		},
	})

	await using source = readableStreamSource(stream)
	const entries: HipparcosCatalogEntry[] = []
	for await (const entry of readHipparcosCatalog(source)) entries.push(entry)
	expect(entries.map((entry) => entry.id)).toEqual([1, 4])
	expect(entries[0].magnitude).toBeUndefined()
	expect(entries[0].parallax).toBeUndefined()
	expect(entries[0].pmRA).toBeUndefined()
	expect(entries[0].pmDEC).toBeUndefined()
	expect(entries[1].magnitude).toBe(5)
	expect(entries[1].parallax).toBe(mas(-2))
	expect(entries[1].pmRA).toBeUndefined()
	expect(entries[1].pmDEC).toBe(mas(3))

	const catalog = new HipparcosCatalog()
	await catalog.load(bufferSource(bytes))
	expect(catalog.size).toBe(2)
	expect(catalog.queryCone(deg(12.5), deg(-4.5), deg(0.1)).map((entry) => entry.id)).toEqual([1])
	expect(catalog.queryBox(deg(12), deg(13), deg(-5), deg(-4)).map((entry) => entry.id)).toEqual([1])
	const triangle = [
		[deg(12), deg(-5)],
		[deg(13), deg(-5)],
		[deg(12.5), deg(-4)],
	] as const
	expect(catalog.queryTriangle(...triangle).map((entry) => entry.id)).toEqual([1])
	expect(catalog.queryPolygon(triangle).map((entry) => entry.id)).toEqual([1])
	expect([...catalog.streamRegion({ kind: 'cone', centerRA: deg(12.5), centerDEC: deg(-4.5), radius: deg(0.1) })].map((entry) => entry.id)).toEqual([1])
})

test.concurrent('official catalog indexes known fields at its source epoch', async () => {
	const catalog = new HipparcosCatalog()
	await using source = fileHandleSource(await fs.open('data/hip_main.dat', 'r'))
	await catalog.load(source)
	expect(catalog.size).toBe(117955)
	expect(catalog.get(421)).toBeUndefined()
	expect(catalog.queryCone(deg(101.28854105), deg(-16.71314306), deg(0.25)).map((entry) => entry.id)).toEqual([32349])
	expect(catalog.queryCone(deg(269.45402305), deg(4.66828815), deg(0.25)).map((entry) => entry.id)).toEqual([87937])
}, 10000)
