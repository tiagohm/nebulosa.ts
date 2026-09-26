import { expect, test } from 'bun:test'
import { KT0803L, RDA5807, TEA5767 } from '../../../../src/devices/firmata/components/radio'
import { MockFirmataClient } from '../util'

test('KT0803L tunes frequency steps and wraps within the supported band', () => {
	using transmitter = new KT0803L(undefined as never)

	expect(transmitter.frequency).toBe(89.7)

	transmitter.frequencyUp()
	expect(transmitter.frequency).toBe(89.75)

	transmitter.frequency = 107.98
	expect(transmitter.frequency).toBe(108)

	transmitter.frequencyUp()
	expect(transmitter.frequency).toBe(70)

	transmitter.frequencyDown()
	expect(transmitter.frequency).toBe(108)
})

test('KT0803L configures the transmitter and updates register-backed settings', () => {
	const client = new MockFirmataClient()
	const transmitter = new KT0803L(client as never, KT0803L.ADDRESS, {
		frequency: 100.1,
		muted: true,
		stereo: false,
		gain: 5,
		transmitPower: 9,
		bassBoost: 11,
		preEmphasis: 50,
		pilotToneHigh: true,
		automaticLevelControl: true,
		automaticPowerDown: true,
		powerAmplifierBias: false,
		deviation: 112.5,
		audioEnhancement: true,
	})

	let updates = 0

	transmitter.addListener(() => {
		updates++
	})

	transmitter.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x84])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG10, 0xa9])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0xc6])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0E, 0x00])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG17, 0x60])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG13, 0x00])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x73])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x4d])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG00, 0xe9])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x04])],
	])

	transmitter.frequency = 70
	expect(transmitter.frequency).toBe(70)
	expect(client.messages.slice(-3)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x72])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x4d])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG00, 0xbc])],
	])
	expect(updates).toBe(1)

	transmitter.transmitPower = 4
	expect(transmitter.transmitPower).toBe(4)
	expect(client.messages.slice(-3)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG13, 0x80])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x32])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x0d])],
	])
	expect(updates).toBe(2)

	transmitter.gain = -3
	expect(transmitter.gain).toBe(-3)
	expect(client.messages.slice(-2)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x02])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0xf6])],
	])
	expect(updates).toBe(3)

	transmitter.unmute()
	expect(transmitter.muted).toBeFalse()
	expect(client.messages.at(-1)).toEqual(['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x05])])
	expect(updates).toBe(4)

	transmitter.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x84])])
})

test('KT0803L updates audio controls after startup without losing other register flags', () => {
	const client = new MockFirmataClient()
	using transmitter = new KT0803L(client as never)
	transmitter.start()
	client.messages.length = 0

	transmitter.preEmphasis = 50
	transmitter.pilotToneHigh = true
	transmitter.stereo = false
	transmitter.automaticLevelControl = true
	transmitter.automaticPowerDown = true
	transmitter.powerAmplifierBias = false
	transmitter.deviation = 112.5
	transmitter.audioEnhancement = true

	expect(client.messages).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x41])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x45])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0x44])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0xc4])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x04])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0E, 0x00])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG17, 0x40])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG17, 0x60])],
	])
	transmitter.audioEnhancement = true
	expect(client.messages).toHaveLength(8)
})

test('TEA5767 tunes frequency steps and wraps within the configured band', () => {
	using tuner = new TEA5767(undefined as never)

	expect(tuner.frequency).toBe(87.5)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.6)

	tuner.frequency = 107.95
	expect(tuner.frequency).toBe(108)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.5)

	tuner.frequencyDown()
	expect(tuner.frequency).toBe(108)
})

test('TEA5767 reports fixed volume support and mute state', () => {
	using tuner = new TEA5767(undefined as never)

	expect(tuner.volume).toBe(100)

	tuner.volumeDown()
	expect(tuner.volume).toBe(100)

	tuner.stereo = false
	expect(tuner.stereo).toBeFalse()

	tuner.mute()
	expect(tuner.muted).toBeTrue()

	tuner.unmute()
	expect(tuner.muted).toBeFalse()
})

test('TEA5767 configures the tuner and writes frequency and mute changes', () => {
	const client = new MockFirmataClient()
	const tuner = new TEA5767(client as never)

	tuner.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0xd5, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.frequency = 103.9
	expect(client.messages.slice(-2)).toEqual([
		['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.mute()
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0xb1, 0xa7, 0xd0, 0x1e, 0x00])])

	tuner.unmute()
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x1e, 0x00])])

	tuner.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x5e, 0x00])])
})

test('TEA5767 applies live noise controls and refreshes status after oscillator changes', () => {
	const client = new MockFirmataClient()
	using tuner = new TEA5767(client as never)
	tuner.start()
	client.messages.length = 0

	tuner.softMute = false
	tuner.highCutControl = false
	tuner.stereoNoiseCancelling = false
	tuner.highSideInjection = false

	expect(client.messages).toEqual([
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0xd5, 0xd0, 0x16, 0x00])],
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0xd5, 0xd0, 0x12, 0x00])],
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0xd5, 0xd0, 0x10, 0x00])],
		// Low-side injection also changes the PLL word for the same station frequency.
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0x9e, 0xc0, 0x10, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])
	expect(tuner.softMute).toBeFalse()
	expect(tuner.highCutControl).toBeFalse()
	expect(tuner.stereoNoiseCancelling).toBeFalse()
	expect(tuner.highSideInjection).toBeFalse()
})

test('TEA5767 seeks to the next station and updates stereo, rssi and station state', () => {
	const client = new MockFirmataClient()
	using tuner = new TEA5767(client as never, TEA5767.ADDRESS, 1000, { frequency: 100.9 })
	let updates = 0

	tuner.addListener(() => {
		updates++
	})

	tuner.start()
	client.messages.length = 0

	tuner.seek('up')

	expect(client.messages).toEqual([
		['write', TEA5767.ADDRESS, Buffer.from([0xf0, 0x45, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.twoWireMessage(client as never, TEA5767.ADDRESS, 0, Buffer.from([0xb0, 0x51, 0xb8, 0xa0, 0x00]))

	expect(tuner.frequency).toBe(101.1)
	expect(tuner.seekFailed).toBeFalse()
	expect(tuner.stereo).toBeTrue()
	expect(tuner.rssi).toBe(85)
	expect(tuner.station).toBeTrue()
	expect(updates).toBe(1)
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x30, 0x51, 0xd0, 0x1e, 0x00])])
})

test('TEA5767 reports seek failure at the band limit when wrapping is disabled', () => {
	const client = new MockFirmataClient()
	using tuner = new TEA5767(client as never, TEA5767.ADDRESS, 1000, { frequency: 108 })
	let updates = 0
	tuner.addListener(() => updates++)
	tuner.start()
	client.messages.length = 0

	tuner.seek('up', false)

	expect(tuner.frequency).toBe(108)
	expect(tuner.seekFailed).toBeTrue()
	expect(tuner.station).toBeFalse()
	expect(updates).toBe(1)
	expect(client.messages).toHaveLength(1)
	expect(client.messages[0]?.[0]).toBe('write')
})

test('RDA5807 tunes frequency steps and wraps within the configured band', () => {
	using tuner = new RDA5807(undefined as never)

	expect(tuner.frequency).toBe(87)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.1)

	tuner.frequency = 107.95
	expect(tuner.frequency).toBe(108)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87)

	tuner.frequencyDown()
	expect(tuner.frequency).toBe(108)
})

test('RDA5807 clamps volume and mute state', () => {
	using tuner = new RDA5807(undefined as never)

	tuner.volume = 7.8
	expect(tuner.volume).toBe(7)

	tuner.volumeUp()
	expect(tuner.volume).toBe(13)

	tuner.volumeDown()
	expect(tuner.volume).toBe(7)

	tuner.volume = 99
	expect(tuner.volume).toBe(100)

	tuner.volume = 1
	expect(tuner.volume).toBe(0)

	tuner.volume = 50
	expect(tuner.volume).toBe(53)

	tuner.mute()
	expect(tuner.muted).toBeTrue()

	tuner.unmute()
	expect(tuner.muted).toBeFalse()
})

test('RDA5807 configures the tuner and writes frequency and volume changes', () => {
	const client = new MockFirmataClient()
	const tuner = new RDA5807(client as never)

	tuner.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x8f])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x00, 0x10])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])

	tuner.frequency = 103.9
	expect(client.messages.slice(-3)).toEqual([
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x2a, 0x40])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x2a, 0x50])],
	])

	tuner.volume = 7
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x81])])

	tuner.mute()
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x80, 0x01])])

	tuner.unmute()
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])])

	tuner.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x00])])
})

test('RDA5807 preserves control bits while stereo, bass and output impedance change', () => {
	const client = new MockFirmataClient()
	using tuner = new RDA5807(client as never)
	tuner.start()
	client.messages.length = 0

	tuner.stereo = false
	tuner.bassBoost = true
	tuner.audioOutputHighZ = true
	tuner.stereo = true

	expect(client.messages).toEqual([
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xe0, 0x01])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xf0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x70, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x50, 0x01])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])
	expect(tuner.stereo).toBeTrue()
	expect(tuner.bassBoost).toBeTrue()
	expect(tuner.audioOutputHighZ).toBeTrue()
})

test('RDA5807 applies stereo mode, bass boost, high-z output and east europe 50-65 MHz mode', () => {
	const client = new MockFirmataClient()
	using tuner = new RDA5807(client as never, RDA5807.ADDRESS, 1000, {
		band: 'eastEurope',
		eastEuropeMode: '50_65',
		frequency: 50,
		stereo: false,
		bassBoost: true,
		audioOutputHighZ: true,
	})

	tuner.start()

	expect(tuner.stereo).toBe(false)
	expect(tuner.bassBoost).toBeTrue()
	expect(tuner.frequency).toBe(50)

	expect(client.messages).toEqual([
		['config', 0],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x70, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x8f])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.SYSTEM_REG, 0x60, 0x00])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.BAND_REG, 0x40, 0x02])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x00, 0x1c])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])
})

test('RDA5807 seeks to the next station and updates stereo, rssi and station state', () => {
	const client = new MockFirmataClient()
	using tuner = new RDA5807(client as never, RDA5807.ADDRESS, 1000, { frequency: 100.9, volume: 5 })
	let updates = 0

	tuner.addListener(() => {
		updates++
	})

	tuner.start()
	client.messages.length = 0

	tuner.seek('up')

	expect(client.messages).toEqual([
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x22, 0xc0])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc3, 0x01])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])

	tuner.twoWireMessage(client as never, RDA5807.ADDRESS, RDA5807.STATUS_REG, Buffer.from([0x44, 0x8d, 0x81, 0x80]))

	expect(tuner.frequency).toBe(101.1)
	expect(tuner.seekFailed).toBeFalse()
	expect(tuner.stereo).toBeTrue()
	expect(tuner.rssi).toBe(64)
	expect(tuner.station).toBeTrue()
	expect(updates).toBe(1)
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])])
})

test('RDA5807 polls status frames', async () => {
	const client = new MockFirmataClient()
	using tuner = new RDA5807(client as never, RDA5807.ADDRESS, 10)

	tuner.start()
	client.messages.length = 0

	await Bun.sleep(130)

	expect(client.messages.length).toBeGreaterThan(0)
	expect(client.messages[0]).toEqual(['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'])
})
