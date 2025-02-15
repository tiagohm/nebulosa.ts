import { expect, test } from 'bun:test'
import { camera, cameras, sensor, sensors, telescope, telescopes } from './astrobin'

test.skip('sensor', async () => {
	const data = await sensors(1)

	expect(data.count).toBeGreaterThanOrEqual(474)
	expect(data.results).toHaveLength(50)

	const s = await sensor(184)

	expect(s.id).toBe(184)
	expect(s.brandName).toBe('Sony')
	expect(s.name).toBe('IMX492 (mono)')
	expect(s.quantumEfficiency).toBe('90.00')
	expect(s.pixelSize).toBe('2.32')
	expect(s.pixelWidth).toBe(8240)
	expect(s.pixelHeight).toBe(5628)
	expect(s.readNoise).toBe('1.30')
	expect(s.fullWellCapacity).toBe('14.00')
	expect(s.frameRate).toBe(16)
	expect(s.adc).toBe(12)
	expect(s.colorOrMono).toBe('M')
	expect(s.cameras).toEqual([189, 529, 272, 8119, 14125, 19372, 56, 1218, 4393, 1244])
})

test.skip('camera', async () => {
	const data = await cameras(1)

	expect(data.count).toBeGreaterThanOrEqual(3512)
	expect(data.results).toHaveLength(50)

	const c = await camera(529)

	expect(c.id).toBe(529)
	expect(c.brandName).toBe('ZWO')
	expect(c.name).toBe('ASI294MM')
	expect(c.type).toBe('GUIDER_PLANETARY')
	expect(c.cooled).toBeFalse()
	expect(c.sensor).toBe(184)
})

test.skip('telescope', async () => {
	const data = await telescopes(1)

	expect(data.count).toBeGreaterThanOrEqual(3952)
	expect(data.results).toHaveLength(50)

	const t = await telescope(1097)

	expect(t.id).toBe(1097)
	expect(t.brandName).toBe('GSO')
	expect(t.name).toBe('6" f/9 Ritchey-Chretien')
	expect(t.type).toBe('REFLECTOR_RITCHEY_CHRETIEN')
	expect(t.aperture).toBe('152.00')
	expect(t.minFocalLength).toBe('1368.00')
	expect(t.maxFocalLength).toBe('1368.00')
})
