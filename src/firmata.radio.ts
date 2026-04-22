import type { FirmataClient } from './firmata'
import { DEFAULT_POLLING_INTERVAL, PeripheralBase, type RadioTransmitter, type RadioTuner, type RadioTunerSeekDirection } from './firmata.peripheral'
import { clamp } from './math'

export type RDA5807Band = 'usEurope' | 'japanWide' | 'world' | 'eastEurope'

export type RDA5807ChannelSpacing = 25 | 50 | 100 | 200 // kHz

export type RDA5807EastEuropeMode = '65_76' | '50_65'

export type TEA5767Band = 'usEurope' | 'japan'

export type TEA5767DeEmphasis = 50 | 75 // us

export type TEA5767ReferenceClock = 32768 | 6500000 | 13000000 // Hz

export type TEA5767SearchStopLevel = 'low' | 'mid' | 'high'

export type KT0803LBassBoost = 0 | 5 | 11 | 17 // dB

export type KT0803LFrequencyDeviation = 75 | 112.5 // kHz

export interface RDA5807Options {
	readonly frequency?: number // MHz
	readonly volume?: number
	readonly muted?: boolean
	readonly band?: RDA5807Band
	readonly stereo?: boolean
	readonly bassBoost?: boolean
	readonly audioOutputHighZ?: boolean
	readonly eastEuropeMode?: RDA5807EastEuropeMode
	readonly spacing?: RDA5807ChannelSpacing // kHz
	readonly seekThreshold?: number
	readonly wrap?: boolean
}

export interface TEA5767Options {
	readonly frequency?: number // MHz
	readonly muted?: boolean
	readonly band?: TEA5767Band
	readonly stereo?: boolean
	readonly softMute?: boolean
	readonly highCutControl?: boolean
	readonly stereoNoiseCancelling?: boolean
	readonly highSideInjection?: boolean
	readonly referenceClock?: TEA5767ReferenceClock // Hz
	readonly deEmphasis?: TEA5767DeEmphasis // us
	readonly searchStopLevel?: TEA5767SearchStopLevel
	readonly wrap?: boolean
}

export interface KT0803LOptions {
	readonly frequency?: number // MHz
	readonly muted?: boolean
	readonly stereo?: boolean
	readonly gain?: number // dB
	readonly transmitPower?: number // Datasheet Table 4 RFGAIN code, 0..15
	readonly bassBoost?: KT0803LBassBoost // dB
	readonly preEmphasis?: TEA5767DeEmphasis // us
	readonly pilotToneHigh?: boolean
	readonly automaticLevelControl?: boolean
	readonly automaticPowerDown?: boolean
	readonly powerAmplifierBias?: boolean
	readonly deviation?: KT0803LFrequencyDeviation // kHz
	readonly audioEnhancement?: boolean
}

interface RDA5807Status {
	readonly rdsReady: boolean
	readonly seekTuneComplete: boolean
	readonly seekFailed: boolean
	readonly stereo: boolean
	readonly channel: number
	readonly rssi: number
	readonly station: boolean
	readonly ready: boolean
}

interface TEA5767Status {
	readonly ready: boolean
	readonly bandLimit: boolean
	readonly pll: number
	readonly stereo: boolean
	readonly ifCounter: number
	readonly level: number
}

const RDA5807_VOLUME_FACTOR = 100 / 15

export const DEFAULT_RDA5807_OPTIONS: Required<RDA5807Options> = {
	frequency: 87,
	volume: 100,
	muted: false,
	band: 'usEurope',
	stereo: true,
	bassBoost: false,
	audioOutputHighZ: false,
	eastEuropeMode: '65_76',
	spacing: 100,
	seekThreshold: 8,
	wrap: true,
}

export const DEFAULT_TEA5767_OPTIONS: Required<TEA5767Options> = {
	frequency: 87.5,
	muted: false,
	band: 'usEurope',
	stereo: true,
	softMute: true,
	highCutControl: true,
	stereoNoiseCancelling: true,
	highSideInjection: true,
	referenceClock: 32768,
	deEmphasis: 50,
	searchStopLevel: 'mid',
	wrap: true,
}

export const DEFAULT_KT0803L_OPTIONS: Required<KT0803LOptions> = {
	frequency: 89.7,
	muted: false,
	stereo: true,
	gain: 0,
	transmitPower: 15,
	bassBoost: 0,
	preEmphasis: 75,
	pilotToneHigh: false,
	automaticLevelControl: false,
	automaticPowerDown: false,
	powerAmplifierBias: true,
	deviation: 75,
	audioEnhancement: false,
}

// https://cdn.sparkfun.com/assets/4/5/f/a/d/TEA5767.pdf

export class TEA5767 extends PeripheralBase<TEA5767> implements RadioTuner {
	#frequency: number
	#muted: boolean
	#stereo: boolean
	#softMute: boolean
	#highCutControl: boolean
	#stereoNoiseCancelling: boolean
	#highSideInjection: boolean
	#seekFailed = false
	#station = false
	#rssi = 0

	static readonly ADDRESS = 0x60
	static readonly STATUS_BYTES = 5
	static readonly FREQUENCY_STEP_KHZ = 100
	static readonly IF_KHZ = 225
	static readonly MAX_LEVEL = 15
	static readonly MAX_RSSI = 127
	static readonly IF_VALID_MIN = 0x29
	static readonly IF_VALID_MAX = 0x7f

	static readonly BYTE1_MUTE = 1 << 7
	static readonly BYTE1_SEARCH = 1 << 6
	static readonly BYTE3_SEARCH_UP = 1 << 7
	static readonly BYTE3_SEARCH_STOP_LEVEL_SHIFT = 5
	static readonly BYTE3_HIGH_SIDE_INJECTION = 1 << 4
	static readonly BYTE3_FORCE_MONO = 1 << 3
	static readonly BYTE4_STANDBY = 1 << 6
	static readonly BYTE4_BAND_LIMIT_JAPAN = 1 << 5
	static readonly BYTE4_XTAL_32768HZ = 1 << 4
	static readonly BYTE4_SOFT_MUTE = 1 << 3
	static readonly BYTE4_HIGH_CUT_CONTROL = 1 << 2
	static readonly BYTE4_STEREO_NOISE_CANCELLING = 1 << 1
	static readonly BYTE5_PLLREF_6500KHZ = 1 << 7
	static readonly BYTE5_DEEMPHASIS_75US = 1 << 6

	static readonly STATUS_READY = 1 << 7
	static readonly STATUS_BAND_LIMIT = 1 << 6
	static readonly STATUS_PLL_HIGH_MASK = 0x3f
	static readonly STATUS_STEREO = 1 << 7
	static readonly STATUS_LEVEL_SHIFT = 4

	readonly #bandStartKHz: number
	readonly #bandEndKHz: number
	readonly #bandBits: number
	readonly #xtalBit: number
	readonly #pllRefBit: number
	readonly #deEmphasisBit: number
	readonly #referenceDividerHz: number
	readonly #searchStopBits: number
	readonly #wrapAround: boolean

	#frequencyKHz: number
	#started = false
	#seeking = false
	#stereoAllowed: boolean
	#seekDirection: RadioTunerSeekDirection = 'up'
	#seekWrapRemaining = 0
	#timer?: NodeJS.Timeout

	readonly name = 'TEA5767'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = TEA5767.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: TEA5767Options = DEFAULT_TEA5767_OPTIONS,
	) {
		super()

		const band = options.band ?? DEFAULT_TEA5767_OPTIONS.band
		const referenceClock = options.referenceClock ?? DEFAULT_TEA5767_OPTIONS.referenceClock
		const searchStopLevel = options.searchStopLevel ?? DEFAULT_TEA5767_OPTIONS.searchStopLevel
		const stereo = options.stereo ?? DEFAULT_TEA5767_OPTIONS.stereo

		this.#bandStartKHz = band === 'japan' ? 76000 : 87500
		this.#bandEndKHz = band === 'japan' ? 91000 : 108000
		this.#bandBits = band === 'japan' ? TEA5767.BYTE4_BAND_LIMIT_JAPAN : 0
		this.#xtalBit = referenceClock === 32768 ? TEA5767.BYTE4_XTAL_32768HZ : 0
		this.#pllRefBit = referenceClock === 6500000 ? TEA5767.BYTE5_PLLREF_6500KHZ : 0
		this.#deEmphasisBit = (options.deEmphasis ?? DEFAULT_TEA5767_OPTIONS.deEmphasis) === 75 ? TEA5767.BYTE5_DEEMPHASIS_75US : 0
		this.#referenceDividerHz = referenceClock === 32768 ? 32768 : 50000
		this.#searchStopBits = this.#searchStopLevelBits(searchStopLevel)
		this.#wrapAround = options.wrap ?? DEFAULT_TEA5767_OPTIONS.wrap
		this.#frequencyKHz = this.#normalizeFrequencyKHz(options.frequency ?? DEFAULT_TEA5767_OPTIONS.frequency)
		this.#frequency = this.#frequencyKHz / 1000
		this.#muted = options.muted ?? DEFAULT_TEA5767_OPTIONS.muted
		this.#stereoAllowed = stereo
		this.#stereo = stereo
		this.#softMute = options.softMute ?? DEFAULT_TEA5767_OPTIONS.softMute
		this.#highCutControl = options.highCutControl ?? DEFAULT_TEA5767_OPTIONS.highCutControl
		this.#stereoNoiseCancelling = options.stereoNoiseCancelling ?? DEFAULT_TEA5767_OPTIONS.stereoNoiseCancelling
		this.#highSideInjection = options.highSideInjection ?? DEFAULT_TEA5767_OPTIONS.highSideInjection
	}

	// Powers the tuner on and schedules periodic raw status polling.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#writeState()
		this.#requestStatus()
		this.#timer = setInterval(this.#requestStatus.bind(this), Math.max(100, this.pollingInterval))
	}

	// Puts the tuner into standby mode and stops status polling.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.#seeking = false
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#writeState(false, true)
	}

	// Gets the current tuned frequency in MHz.
	get frequency() {
		return this.#frequency
	}

	// Sets the current tuned frequency in MHz and requests a fresh status frame.
	set frequency(value: number) {
		this.#frequencyKHz = this.#normalizeFrequencyKHz(value)
		this.#frequency = this.#frequencyKHz / 1000
		this.#seekFailed = false
		this.#seeking = false

		if (this.#started) {
			this.#writeState()
			this.#requestStatus()
		}
	}

	// Steps the frequency up by 100 kHz and wraps at band end.
	frequencyUp() {
		const nextFrequencyKHz = this.#frequencyKHz < this.#bandEndKHz ? this.#frequencyKHz + TEA5767.FREQUENCY_STEP_KHZ : this.#bandStartKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Steps the frequency down by 100 kHz and wraps at band start.
	frequencyDown() {
		const nextFrequencyKHz = this.#frequencyKHz > this.#bandStartKHz ? this.#frequencyKHz - TEA5767.FREQUENCY_STEP_KHZ : this.#bandEndKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Returns whether the current reception is stereo.
	get stereo() {
		return this.#stereo
	}

	// Forces mono reception when false and allows stereo decoding when true.
	set stereo(value: boolean) {
		this.#stereoAllowed = value
		if (!value) this.#stereo = false
		if (this.#started) {
			this.#writeState(this.#seeking)
			this.#requestStatus()
		}
	}

	// Returns whether the tuner audio path is muted.
	get muted() {
		return this.#muted
	}

	// Enables or disables the tuner mute bit.
	set muted(value: boolean) {
		this.#muted = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	// Mutes the tuner audio output.
	mute() {
		this.muted = true
	}

	// Unmutes the tuner audio output.
	unmute() {
		this.muted = false
	}

	// Returns the derived signal level mapped to the shared 0..127 radio RSSI scale.
	get rssi() {
		return this.#rssi
	}

	// Returns whether the current tuned channel passed the IF counter and level checks.
	get station() {
		return this.#station
	}

	// Returns whether the latest seek hit a band limit without finding a valid station.
	get seekFailed() {
		return this.#seekFailed
	}

	// Returns 100 because TEA5767 has no on-chip hardware volume control.
	get volume() {
		return 100
	}

	// TEA5767 leaves volume control to the downstream analog amplifier.
	volumeUp() {}

	// TEA5767 leaves volume control to the downstream analog amplifier.
	volumeDown() {}

	// Enables or disables the chip soft mute function.
	set softMute(value: boolean) {
		this.#softMute = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	get softMute() {
		return this.#softMute
	}

	// Enables or disables the chip high-cut control.
	set highCutControl(value: boolean) {
		this.#highCutControl = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	get highCutControl() {
		return this.#highCutControl
	}

	// Enables or disables stereo noise cancelling.
	set stereoNoiseCancelling(value: boolean) {
		this.#stereoNoiseCancelling = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	get stereoNoiseCancelling() {
		return this.#stereoNoiseCancelling
	}

	// Selects high-side or low-side local oscillator injection.
	set highSideInjection(value: boolean) {
		this.#highSideInjection = value
		if (this.#started) {
			this.#writeState(this.#seeking)
			this.#requestStatus()
		}
	}

	get highSideInjection() {
		return this.#highSideInjection
	}

	// Starts an autonomous seek and optionally wraps once at the band limit.
	seek(direction: RadioTunerSeekDirection = 'up', wrap: boolean = this.#wrapAround) {
		this.#ensureStarted()
		this.#seekDirection = direction
		this.#seekFailed = false
		this.#seeking = true
		this.#seekWrapRemaining = wrap ? 1 : 0
		this.#beginSeekCycle()
	}

	// Decodes 5-byte raw status frames returned by the chip read mode.
	twoWireMessage(client: FirmataClient, address: number, _register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || data.byteLength !== TEA5767.STATUS_BYTES) return

		const previousFrequency = this.#frequency
		const status = this.#decodeStatus(data)
		const nextFrequencyKHz = this.#frequencyFromPll(status.pll)

		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000

		if (this.#seeking) {
			this.#handleSeekStatus(status, previousFrequency)
			return
		}

		console.info('%j', status)

		if (!status.ready) return

		const nextStereo = this.#stereoAllowed && status.stereo
		const nextRssi = this.#rssiFromLevel(status.level)
		const nextStation = this.#isStation(status)
		const changed = this.#frequency !== previousFrequency || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation

		if (changed) this.fire()
	}

	// Handles seek completion, false stops, and optional one-pass wraparound.
	#handleSeekStatus(status: TEA5767Status, previousFrequency: number) {
		if (!status.ready) return

		const nextStation = !status.bandLimit && this.#isStation(status)

		if (!nextStation) {
			this.#beginSeekCycle()
			return
		}

		const nextStereo = this.#stereoAllowed && status.stereo
		const nextRssi = this.#rssiFromLevel(status.level)
		const changed = this.#frequency !== previousFrequency || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#seeking = false
		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation
		this.#seekFailed = false
		this.#writeState()

		if (changed) this.fire()
	}

	// Advances to the next search start frequency or marks the seek as failed.
	#beginSeekCycle() {
		const nextFrequencyKHz = this.#nextSeekFrequencyKHz()

		if (nextFrequencyKHz === undefined) {
			const changed = this.#seekFailed === false || this.#station !== false

			this.#seeking = false
			this.#seekFailed = true
			this.#station = false
			this.#stereo = false
			this.#rssi = 0
			this.#writeState()
			if (changed) this.fire()
			return
		}

		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000
		this.#writeState(true)
		this.#requestStatus()
	}

	// Computes the next search entry point while honoring the optional wraparound.
	#nextSeekFrequencyKHz() {
		if (this.#seekDirection === 'up') {
			if (this.#frequencyKHz < this.#bandEndKHz) return Math.min(this.#bandEndKHz, this.#frequencyKHz + TEA5767.FREQUENCY_STEP_KHZ)
			if (this.#seekWrapRemaining > 0) {
				this.#seekWrapRemaining--
				return this.#bandStartKHz
			}
		} else {
			if (this.#frequencyKHz > this.#bandStartKHz) return Math.max(this.#bandStartKHz, this.#frequencyKHz - TEA5767.FREQUENCY_STEP_KHZ)
			if (this.#seekWrapRemaining > 0) {
				this.#seekWrapRemaining--
				return this.#bandEndKHz
			}
		}
	}

	// Packs the current state into the chip 5-byte write frame.
	#writeState(search: boolean = false, standby: boolean = false) {
		const pll = this.#frequencyToPll(this.#frequencyKHz)
		const data = Buffer.allocUnsafe(TEA5767.STATUS_BYTES)

		data[0] = (this.#muted || search ? TEA5767.BYTE1_MUTE : 0) | (search ? TEA5767.BYTE1_SEARCH : 0) | ((pll >>> 8) & TEA5767.STATUS_PLL_HIGH_MASK)
		data[1] = pll & 0xff
		data[2] = (this.#seekDirection === 'up' ? TEA5767.BYTE3_SEARCH_UP : 0) | this.#searchStopBits | (this.#highSideInjection ? TEA5767.BYTE3_HIGH_SIDE_INJECTION : 0) | (this.#stereoAllowed ? 0 : TEA5767.BYTE3_FORCE_MONO)
		data[3] = (standby ? TEA5767.BYTE4_STANDBY : 0) | this.#bandBits | this.#xtalBit | (this.#softMute ? TEA5767.BYTE4_SOFT_MUTE : 0) | (this.#highCutControl ? TEA5767.BYTE4_HIGH_CUT_CONTROL : 0) | (this.#stereoNoiseCancelling ? TEA5767.BYTE4_STEREO_NOISE_CANCELLING : 0)
		data[4] = this.#pllRefBit | this.#deEmphasisBit

		this.client.twoWireWrite(this.address, data)
	}

	// Requests the next 5-byte read-mode status frame.
	#requestStatus() {
		if (!this.#started) return
		this.client.twoWireRead(this.address, -1, TEA5767.STATUS_BYTES)
	}

	// Throws when an active I2C session is required for the operation.
	#ensureStarted() {
		if (!this.#started) throw new Error('TEA5767 has not been started.')
	}

	// Decodes the read-mode status bytes into a convenient internal structure.
	#decodeStatus(data: Buffer): TEA5767Status {
		return {
			ready: (data[0] & TEA5767.STATUS_READY) !== 0,
			bandLimit: (data[0] & TEA5767.STATUS_BAND_LIMIT) !== 0,
			pll: ((data[0] & TEA5767.STATUS_PLL_HIGH_MASK) << 8) | data[1],
			stereo: (data[2] & TEA5767.STATUS_STEREO) !== 0,
			ifCounter: data[2] & 0x7f,
			level: (data[3] >>> TEA5767.STATUS_LEVEL_SHIFT) & 0x0f,
		}
	}

	// Converts the 4-bit level ADC reading into the shared radio RSSI scale.
	#rssiFromLevel(level: number) {
		return Math.round(level * (TEA5767.MAX_RSSI / TEA5767.MAX_LEVEL))
	}

	// Checks whether the current tuned channel satisfies the IF and level validity rules.
	#isStation(status: TEA5767Status) {
		return status.ifCounter >= TEA5767.IF_VALID_MIN && status.ifCounter <= TEA5767.IF_VALID_MAX
	}

	// Maps the selected stop level to the write-mode search threshold bits.
	#searchStopLevelBits(searchStopLevel: TEA5767SearchStopLevel) {
		const value = searchStopLevel === 'low' ? 0b01 : searchStopLevel === 'mid' ? 0b10 : 0b11
		return value << TEA5767.BYTE3_SEARCH_STOP_LEVEL_SHIFT
	}

	// Converts a tuned frequency to the PLL word using the configured reference clock.
	#frequencyToPll(frequencyKHz: number) {
		const oscillatorFrequencyHz = frequencyKHz * 1000 + (this.#highSideInjection ? TEA5767.IF_KHZ * 1000 : -TEA5767.IF_KHZ * 1000)
		return Math.max(0, Math.min(0x3fff, Math.round((4 * oscillatorFrequencyHz) / this.#referenceDividerHz)))
	}

	// Converts the PLL word back to the nearest public FM frequency.
	#frequencyFromPll(pll: number) {
		const frequencyKHz = Math.round(((pll * this.#referenceDividerHz) / 4 + (this.#highSideInjection ? -TEA5767.IF_KHZ * 1000 : TEA5767.IF_KHZ * 1000)) / 1000)
		return this.#normalizeFrequencyKHzValue(frequencyKHz)
	}

	// Clamps a requested frequency to the current band and public 100 kHz tuning grid.
	#normalizeFrequencyKHz(frequency: number) {
		return this.#normalizeFrequencyKHzValue(Math.round(frequency * 1000))
	}

	// Clamps a kHz value to the band and rounds it to the nearest 100 kHz step.
	#normalizeFrequencyKHzValue(frequencyKHz: number) {
		const clampedFrequencyKHz = Math.max(this.#bandStartKHz, Math.min(this.#bandEndKHz, frequencyKHz))
		const channel = Math.round((clampedFrequencyKHz - this.#bandStartKHz) / TEA5767.FREQUENCY_STEP_KHZ)
		return this.#bandStartKHz + channel * TEA5767.FREQUENCY_STEP_KHZ
	}
}

// https://cdn-shop.adafruit.com/product-files/5651/5651_tuner84_RDA5807M_datasheet_v1.pdf

export class RDA5807 extends PeripheralBase<RDA5807> implements RadioTuner {
	#frequency: number
	#volume: number
	#muted: boolean
	#bassBoost: boolean
	#audioOutputHighZ: boolean
	#seekFailed = false
	#stereo = false
	#rssi = 0
	#station = false

	static readonly ADDRESS = 0x11

	static readonly DEVICE_ID_REG = 0x00
	static readonly CONTROL_REG = 0x02
	static readonly TUNING_REG = 0x03
	static readonly AUDIO_REG = 0x05
	static readonly SYSTEM_REG = 0x06
	static readonly BAND_REG = 0x07
	static readonly STATUS_REG = 0x0a

	static readonly REG02_DHIZ = 1 << 15
	static readonly REG02_DMUTE = 1 << 14
	static readonly REG02_MONO = 1 << 13
	static readonly REG02_BASS = 1 << 12
	static readonly REG02_SEEKUP = 1 << 9
	static readonly REG02_SEEK = 1 << 8
	static readonly REG02_SKMODE = 1 << 7
	static readonly REG02_ENABLE = 1 << 0

	static readonly REG03_CHAN_SHIFT = 6
	static readonly REG03_TUNE = 1 << 4

	static readonly REG06_OPEN_MODE_SHIFT = 13
	static readonly REG06_OPEN_WRITE = 0b11 << RDA5807.REG06_OPEN_MODE_SHIFT

	static readonly REG05_SEEKTH_SHIFT = 8
	static readonly REG05_SEEKTH_MASK = 0x0f << RDA5807.REG05_SEEKTH_SHIFT
	static readonly REG05_LNA_PORT_SEL_SHIFT = 6
	static readonly REG05_VOLUME_MASK = 0x0f

	static readonly REG07_SOFTBLEND_THRESHOLD_SHIFT = 10
	static readonly REG07_SOFTBLEND_THRESHOLD_DEFAULT = 0x10 << RDA5807.REG07_SOFTBLEND_THRESHOLD_SHIFT
	static readonly REG07_EAST_EUROPE_65_76 = 1 << 9
	static readonly REG07_SOFTBLEND_ENABLE = 1 << 1

	static readonly STATUS_RDS_READY = 1 << 15
	static readonly STATUS_SEEK_TUNE_COMPLETE = 1 << 14
	static readonly STATUS_SEEK_FAILED = 1 << 13
	static readonly STATUS_STEREO = 1 << 10
	static readonly STATUS_CHANNEL_MASK = 0x03ff
	static readonly SIGNAL_RSSI_SHIFT = 9
	static readonly SIGNAL_RSSI_MASK = 0x7f << RDA5807.SIGNAL_RSSI_SHIFT
	static readonly SIGNAL_STATION = 1 << 8
	static readonly SIGNAL_READY = 1 << 7

	readonly #bandStartKHz: number
	readonly #bandEndKHz: number
	readonly #bandBits: number
	readonly #spacingKHz: number
	readonly #spacingBits: number
	readonly #wrapAround: boolean

	#frequencyKHz: number
	#started = false
	#seeking = false
	#reg02: number
	#reg05: number
	#reg06: number
	#reg07: number
	#timer?: NodeJS.Timeout

	readonly name = 'RDA5807'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = RDA5807.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: RDA5807Options = DEFAULT_RDA5807_OPTIONS,
	) {
		super()

		const band = options.band ?? DEFAULT_RDA5807_OPTIONS.band
		const spacing = options.spacing ?? DEFAULT_RDA5807_OPTIONS.spacing
		const seekThreshold = clamp(Math.trunc(options.seekThreshold ?? DEFAULT_RDA5807_OPTIONS.seekThreshold), 0, 15)
		const volume = clamp(Math.round((options.volume ?? DEFAULT_RDA5807_OPTIONS.volume) / RDA5807_VOLUME_FACTOR), 0, 15)
		const muted = options.muted ?? DEFAULT_RDA5807_OPTIONS.muted
		const stereo = options.stereo ?? DEFAULT_RDA5807_OPTIONS.stereo
		const bassBoost = options.bassBoost ?? DEFAULT_RDA5807_OPTIONS.bassBoost
		const audioOutputHighZ = options.audioOutputHighZ ?? DEFAULT_RDA5807_OPTIONS.audioOutputHighZ
		const eastEuropeMode = options.eastEuropeMode ?? DEFAULT_RDA5807_OPTIONS.eastEuropeMode

		this.#bandStartKHz = band === 'usEurope' ? 87000 : band === 'japanWide' || band === 'world' ? 76000 : eastEuropeMode === '50_65' ? 50000 : 65000
		this.#bandEndKHz = band === 'usEurope' ? 108000 : band === 'japanWide' ? 91000 : band === 'world' ? 108000 : eastEuropeMode === '50_65' ? 65000 : 76000
		this.#bandBits = band === 'usEurope' ? 0 : band === 'japanWide' ? 1 : band === 'world' ? 2 : 3
		this.#spacingKHz = spacing
		this.#spacingBits = spacing === 100 ? 0 : spacing === 200 ? 1 : spacing === 50 ? 2 : 3
		this.#wrapAround = options.wrap ?? DEFAULT_RDA5807_OPTIONS.wrap
		this.#frequencyKHz = this.#normalizeFrequencyKHz(options.frequency ?? DEFAULT_RDA5807_OPTIONS.frequency)
		this.#frequency = this.#frequencyKHz / 1000
		this.#volume = volume
		this.#muted = muted
		this.#stereo = stereo
		this.#bassBoost = bassBoost
		this.#audioOutputHighZ = audioOutputHighZ
		this.#reg02 = (audioOutputHighZ ? 0 : RDA5807.REG02_DHIZ) | (muted ? 0 : RDA5807.REG02_DMUTE) | (stereo === false ? RDA5807.REG02_MONO : 0) | (bassBoost ? RDA5807.REG02_BASS : 0) | RDA5807.REG02_ENABLE
		this.#reg05 = (seekThreshold << RDA5807.REG05_SEEKTH_SHIFT) | (2 << RDA5807.REG05_LNA_PORT_SEL_SHIFT) | volume
		this.#reg06 = RDA5807.REG06_OPEN_WRITE
		this.#reg07 = RDA5807.REG07_SOFTBLEND_THRESHOLD_DEFAULT | (eastEuropeMode === '65_76' ? RDA5807.REG07_EAST_EUROPE_65_76 : 0) | RDA5807.REG07_SOFTBLEND_ENABLE
	}

	// Powers the tuner on, configures the audio path, and tunes the initial frequency.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02)
		this.#writeRegister(RDA5807.AUDIO_REG, this.#reg05)
		if (this.#bandBits === 3) {
			this.#writeRegister(RDA5807.SYSTEM_REG, this.#reg06)
			this.#writeRegister(RDA5807.BAND_REG, this.#reg07)
		}
		this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(true))
		this.#requestStatus()
		this.#timer = setInterval(this.#requestStatus.bind(this), Math.max(100, this.pollingInterval))
	}

	// Powers the tuner down and clears any pending register reads.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.#seeking = false
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_ENABLE & ~RDA5807.REG02_SEEK)
		this.clearPendingTwoWireReads(new Error('RDA5807 stopped before the I2C read completed.'))
	}

	// Gets the current tuned frequency in MHz.
	get frequency() {
		return this.#frequency
	}

	// Sets the current tuned frequency in MHz.
	set frequency(value: number) {
		const nextFrequencyKHz = this.#normalizeFrequencyKHz(value)
		this.#seeking = false
		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000
		this.#seekFailed = false

		if (this.#started) {
			this.#clearSeekTuneState()
			this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(true))
		}
	}

	// Steps the frequency up by the configured channel spacing and wraps at band end.
	frequencyUp() {
		const nextFrequencyKHz = this.#frequencyKHz < this.#bandEndKHz ? this.#frequencyKHz + this.#spacingKHz : this.#bandStartKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Steps the frequency down by the configured channel spacing and wraps at band start.
	frequencyDown() {
		const nextFrequencyKHz = this.#frequencyKHz > this.#bandStartKHz ? this.#frequencyKHz - this.#spacingKHz : this.#bandEndKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Returns whether the configured output audio mode is stereo.
	get stereo() {
		return this.#stereo
	}

	// Gets the current RSSI level from the chip status register.
	get rssi() {
		return this.#rssi
	}

	// Returns whether the current channel is considered a valid station.
	get station() {
		return this.#station
	}

	// Gets the output volume level between 0 and 100.
	get volume() {
		return Math.round(this.#volume * RDA5807_VOLUME_FACTOR)
	}

	// Sets the output volume level between 0 and 100.
	set volume(volume: number) {
		const nextVolume = clamp(Math.round(volume / RDA5807_VOLUME_FACTOR), 0, 15)
		this.#volume = nextVolume
		this.#reg05 = (this.#reg05 & ~RDA5807.REG05_VOLUME_MASK) | nextVolume
		if (this.#started) this.#writeRegister(RDA5807.AUDIO_REG, this.#reg05)
	}

	// Increments the output volume by one step.
	volumeUp() {
		this.volume += RDA5807_VOLUME_FACTOR
	}

	// Decrements the output volume by one step.
	volumeDown() {
		this.volume -= RDA5807_VOLUME_FACTOR
	}

	// Returns whether the audio is muted.
	get muted() {
		return this.#muted
	}

	// Sets whether the tuner should force mono or allow stereo decoding.
	set stereo(value: boolean) {
		this.#stereo = value
		this.#reg02 = value === false ? this.#reg02 | RDA5807.REG02_MONO : this.#reg02 & ~RDA5807.REG02_MONO
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
		this.#requestStatus()
	}

	// Returns whether bass boost is enabled.
	get bassBoost() {
		return this.#bassBoost
	}

	// Enables or disables bass boost.
	set bassBoost(value: boolean) {
		this.#bassBoost = value
		this.#reg02 = value ? this.#reg02 | RDA5807.REG02_BASS : this.#reg02 & ~RDA5807.REG02_BASS
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	// Enables or disables high-impedance analog audio output.
	set audioOutputHighZ(value: boolean) {
		this.#audioOutputHighZ = value
		this.#reg02 = value ? this.#reg02 & ~RDA5807.REG02_DHIZ : this.#reg02 | RDA5807.REG02_DHIZ
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	get audioOutputHighZ() {
		return this.#audioOutputHighZ
	}

	// Enables or disables the audio mute bit.
	set muted(value: boolean) {
		this.#muted = value
		this.#reg02 = value ? this.#reg02 & ~RDA5807.REG02_DMUTE : this.#reg02 | RDA5807.REG02_DMUTE
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	// Mutes the tuner audio output.
	mute() {
		this.muted = true
	}

	// Unmutes the tuner audio output.
	unmute() {
		this.muted = false
	}

	get seekFailed() {
		return this.#seekFailed
	}

	// Starts seeking in the requested direction and completes when the next status frame reports STC.
	seek(direction: RadioTunerSeekDirection = 'up', wrap: boolean = this.#wrapAround) {
		this.#ensureStarted()
		this.#clearSeekTuneState()

		const seekDirection = direction === 'up' ? RDA5807.REG02_SEEKUP : 0
		const seekMode = wrap ? 0 : RDA5807.REG02_SKMODE
		this.#seeking = true
		this.#seekFailed = false
		this.#writeRegister(RDA5807.CONTROL_REG, (this.#reg02 & ~(RDA5807.REG02_SEEKUP | RDA5807.REG02_SKMODE)) | seekDirection | seekMode | RDA5807.REG02_SEEK)
		this.#requestStatus()
	}

	// Decodes polled status frames and finalizes seek completion when STC is asserted.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== RDA5807.STATUS_REG || data.byteLength !== 4) return

		const status = this.#decodeStatus(data)
		const applyStatus = !this.#seeking || status.seekTuneComplete
		const nextFrequency = applyStatus ? this.#frequencyFromChannel(status.channel) : this.#frequency
		const nextSeekFailed = applyStatus ? status.seekFailed : this.#seekFailed
		const nextStereo = applyStatus ? status.stereo : this.#stereo
		const nextRssi = applyStatus ? status.rssi : this.#rssi
		const nextStation = applyStatus ? status.station : this.#station
		const changed = nextFrequency !== this.#frequency || nextSeekFailed !== this.#seekFailed || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#frequencyKHz = Math.round(nextFrequency * 1000)
		this.#frequency = nextFrequency
		this.#seekFailed = nextSeekFailed
		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation

		if (this.#seeking && status.seekTuneComplete) {
			this.#seeking = false
			this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~(RDA5807.REG02_SEEKUP | RDA5807.REG02_SKMODE | RDA5807.REG02_SEEK))
		}

		if (changed) this.fire()
	}

	// Converts the polled 0x0A/0x0B status frame into decoded tuner state.
	#decodeStatus(data: Buffer): RDA5807Status {
		const status = data.readUInt16BE(0)
		const signal = data.readUInt16BE(2)

		return {
			rdsReady: (status & RDA5807.STATUS_RDS_READY) !== 0,
			seekTuneComplete: (status & RDA5807.STATUS_SEEK_TUNE_COMPLETE) !== 0,
			seekFailed: (status & RDA5807.STATUS_SEEK_FAILED) !== 0,
			stereo: (status & RDA5807.STATUS_STEREO) !== 0,
			channel: status & RDA5807.STATUS_CHANNEL_MASK,
			rssi: (signal & RDA5807.SIGNAL_RSSI_MASK) >>> RDA5807.SIGNAL_RSSI_SHIFT,
			station: (signal & RDA5807.SIGNAL_STATION) !== 0,
			ready: (signal & RDA5807.SIGNAL_READY) !== 0,
		}
	}

	// Writes a 16-bit register through the direct-access I2C address.
	#writeRegister(register: number, value: number) {
		this.client.twoWireWrite(this.address, [register, value >>> 8, value & 0xff])
	}

	// Builds the tuning register value for the current band, spacing, and frequency.
	#tuningValue(tune: boolean) {
		return (this.#frequencyToChannel(this.#frequencyKHz) << RDA5807.REG03_CHAN_SHIFT) | (tune ? RDA5807.REG03_TUNE : 0) | (this.#bandBits << 2) | this.#spacingBits
	}

	// Clears any stale seek/tune bits before starting a new operation.
	#clearSeekTuneState() {
		this.#seeking = false
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
		this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(false))
	}

	// Requests a combined 0x0A/0x0B status frame.
	#requestStatus() {
		if (!this.#started) return
		this.client.twoWireRead(this.address, RDA5807.STATUS_REG, 4)
	}

	// Throws when an active I2C session is required for the operation.
	#ensureStarted() {
		if (!this.#started) throw new Error('RDA5807 has not been started.')
	}

	// Converts a channel index into the corresponding FM frequency in MHz.
	#frequencyFromChannel(channel: number) {
		return (this.#bandStartKHz + channel * this.#spacingKHz) / 1000
	}

	// Converts a normalized frequency into the chip channel index.
	#frequencyToChannel(frequencyKHz: number) {
		return Math.max(0, Math.min(0x03ff, Math.round((frequencyKHz - this.#bandStartKHz) / this.#spacingKHz)))
	}

	// Clamps a requested frequency to the current band and channel spacing.
	#normalizeFrequencyKHz(frequency: number) {
		const requestedFrequencyKHz = Math.round(frequency * 1000)
		const clampedFrequencyKHz = Math.max(this.#bandStartKHz, Math.min(this.#bandEndKHz, requestedFrequencyKHz))
		const channel = Math.round((clampedFrequencyKHz - this.#bandStartKHz) / this.#spacingKHz)
		return this.#bandStartKHz + channel * this.#spacingKHz
	}
}

// https://www.radiolocman.com/datasheet/pdf.html?di=186075

export class KT0803L extends PeripheralBase<KT0803L> implements RadioTransmitter {
	static readonly ADDRESS = 0x3e
	static readonly MIN_CHANNEL = 1400 // 70.0 MHz * 20
	static readonly MAX_CHANNEL = 2160 // 108.0 MHz * 20
	static readonly DEFAULT_CHANNEL = 1720 // 86.0 MHz * 20
	static readonly CHANNELS_PER_MHZ = 20

	static readonly REG00 = 0x00
	static readonly REG01 = 0x01
	static readonly REG02 = 0x02
	static readonly REG04 = 0x04
	static readonly REG0B = 0x0b
	static readonly REG0E = 0x0e
	static readonly REG10 = 0x10
	static readonly REG13 = 0x13
	static readonly REG17 = 0x17

	static readonly REG02_CHSEL_LSB = 1 << 7
	static readonly REG02_RFGAIN3 = 1 << 6
	static readonly REG02_MUTE = 1 << 3
	static readonly REG02_PILOT_HIGH = 1 << 2
	static readonly REG02_PREEMPHASIS_50 = 1 << 0

	static readonly REG04_ALC_ENABLE = 1 << 7
	static readonly REG04_MONO = 1 << 6
	static readonly REG04_PGA_LSB_SHIFT = 4
	static readonly REG04_RESERVED = 0x04

	static readonly REG0B_STANDBY = 1 << 7
	static readonly REG0B_AUTO_POWER_DOWN = 1 << 2

	static readonly REG0E_PA_BIAS = 1 << 1

	static readonly REG10_RESERVED = 0xa8
	static readonly REG10_PGA_1DB_MODE = 1 << 0

	static readonly REG13_RFGAIN2 = 1 << 7

	static readonly REG17_DEVIATION_112_5_KHZ = 1 << 6
	static readonly REG17_AUDIO_ENHANCEMENT = 1 << 5

	#channel: number
	#muted: boolean
	#stereo: boolean
	#gain: number
	#transmitPower: number
	#bassBoost: KT0803LBassBoost
	#preEmphasis: TEA5767DeEmphasis
	#pilotToneHigh: boolean
	#automaticLevelControl: boolean
	#automaticPowerDown: boolean
	#powerAmplifierBias: boolean
	#deviation: KT0803LFrequencyDeviation
	#audioEnhancement: boolean
	#started = false

	readonly name = 'KT0803L'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = KT0803L.ADDRESS,
		options: KT0803LOptions = DEFAULT_KT0803L_OPTIONS,
	) {
		super()

		this.#channel = this.#normalizeChannel(options.frequency ?? DEFAULT_KT0803L_OPTIONS.frequency)
		this.#muted = options.muted ?? DEFAULT_KT0803L_OPTIONS.muted
		this.#stereo = options.stereo ?? DEFAULT_KT0803L_OPTIONS.stereo
		this.#gain = this.#normalizeGain(options.gain ?? DEFAULT_KT0803L_OPTIONS.gain)
		this.#transmitPower = this.#normalizeTransmitPower(options.transmitPower ?? DEFAULT_KT0803L_OPTIONS.transmitPower)
		this.#bassBoost = this.#normalizeBassBoost(options.bassBoost ?? DEFAULT_KT0803L_OPTIONS.bassBoost)
		this.#preEmphasis = (options.preEmphasis ?? DEFAULT_KT0803L_OPTIONS.preEmphasis) === 50 ? 50 : 75
		this.#pilotToneHigh = options.pilotToneHigh ?? DEFAULT_KT0803L_OPTIONS.pilotToneHigh
		this.#automaticLevelControl = options.automaticLevelControl ?? DEFAULT_KT0803L_OPTIONS.automaticLevelControl
		this.#automaticPowerDown = options.automaticPowerDown ?? DEFAULT_KT0803L_OPTIONS.automaticPowerDown
		this.#powerAmplifierBias = options.powerAmplifierBias ?? DEFAULT_KT0803L_OPTIONS.powerAmplifierBias
		this.#deviation = (options.deviation ?? DEFAULT_KT0803L_OPTIONS.deviation) === 112.5 ? 112.5 : 75
		this.#audioEnhancement = options.audioEnhancement ?? DEFAULT_KT0803L_OPTIONS.audioEnhancement
	}

	// Puts the transmitter in standby, applies the current configuration, and resumes transmission.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#applyConfiguration()
	}

	// Places the transmitter in standby and detaches the Firmata handler.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.#writeRegister(KT0803L.REG0B, this.#register0BValue(true))
		this.client.removeHandler(this)
	}

	// Gets the current transmit frequency in MHz.
	get frequency() {
		return this.#frequencyFromChannel(this.#channel)
	}

	// Sets the transmit frequency in 50 kHz steps within the chip band limits.
	set frequency(value: number) {
		const nextChannel = this.#normalizeChannel(value)
		if (nextChannel === this.#channel) return
		this.#channel = nextChannel
		if (this.#started) this.#writeFrequency()
		this.fire()
	}

	// Steps the transmit frequency up by 50 kHz and wraps at the upper band edge.
	frequencyUp() {
		this.frequency = this.#channel < KT0803L.MAX_CHANNEL ? this.#frequencyFromChannel(this.#channel + 1) : this.#frequencyFromChannel(KT0803L.MIN_CHANNEL)
	}

	// Steps the transmit frequency down by 50 kHz and wraps at the lower band edge.
	frequencyDown() {
		this.frequency = this.#channel > KT0803L.MIN_CHANNEL ? this.#frequencyFromChannel(this.#channel - 1) : this.#frequencyFromChannel(KT0803L.MAX_CHANNEL)
	}

	// Returns whether the audio input path is muted.
	get muted() {
		return this.#muted
	}

	// Enables or disables the transmitter mute bit.
	set muted(value: boolean) {
		if (value === this.#muted) return
		this.#muted = value
		if (this.#started) this.#writeRegister(KT0803L.REG02, this.#register02Value())
		this.fire()
	}

	// Mutes the audio input path.
	mute() {
		this.muted = true
	}

	// Unmutes the audio input path.
	unmute() {
		this.muted = false
	}

	// Returns whether the stereo encoder is enabled.
	get stereo() {
		return this.#stereo
	}

	// Enables stereo multiplexing when true and forces mono when false.
	set stereo(value: boolean) {
		if (value === this.#stereo) return
		this.#stereo = value
		if (this.#started) this.#writeRegister(KT0803L.REG04, this.#register04Value())
		this.fire()
	}

	// Returns the configured PGA gain in dB.
	get gain() {
		return this.#gain
	}

	// Sets the PGA gain in dB using the KT0803L 1 dB mode.
	set gain(value: number) {
		const nextGain = this.#normalizeGain(value)
		if (nextGain === this.#gain) return
		this.#gain = nextGain

		if (this.#started) {
			this.#writeRegister(KT0803L.REG01, this.#register01Value())
			this.#writeRegister(KT0803L.REG04, this.#register04Value())
		}

		this.fire()
	}

	// Returns the current RFGAIN code from datasheet Table 4.
	get transmitPower() {
		return this.#transmitPower
	}

	// Sets the RF output level using the datasheet RFGAIN code range 0..15.
	set transmitPower(value: number) {
		const nextTransmitPower = this.#normalizeTransmitPower(value)
		if (nextTransmitPower === this.#transmitPower) return
		this.#transmitPower = nextTransmitPower

		if (this.#started) {
			this.#writeRegister(KT0803L.REG13, this.#register13Value())
			this.#writeRegister(KT0803L.REG01, this.#register01Value())
			this.#writeRegister(KT0803L.REG02, this.#register02Value())
		}

		this.fire()
	}

	// Returns the configured low-frequency bass boost amount in dB.
	get bassBoost() {
		return this.#bassBoost
	}

	// Sets the low-frequency bass boost to the closest supported datasheet value.
	set bassBoost(value: KT0803LBassBoost) {
		const nextBassBoost = this.#normalizeBassBoost(value)
		if (nextBassBoost === this.#bassBoost) return
		this.#bassBoost = nextBassBoost
		if (this.#started) this.#writeRegister(KT0803L.REG04, this.#register04Value())
		this.fire()
	}

	// Returns the configured pre-emphasis time constant in microseconds.
	get preEmphasis() {
		return this.#preEmphasis
	}

	// Sets the audio pre-emphasis time constant.
	set preEmphasis(value: TEA5767DeEmphasis) {
		const nextPreEmphasis = value === 50 ? 50 : 75
		if (nextPreEmphasis === this.#preEmphasis) return
		this.#preEmphasis = nextPreEmphasis
		if (this.#started) this.#writeRegister(KT0803L.REG02, this.#register02Value())
		this.fire()
	}

	// Returns whether the higher pilot tone amplitude is selected.
	get pilotToneHigh() {
		return this.#pilotToneHigh
	}

	// Selects the higher or lower pilot tone amplitude.
	set pilotToneHigh(value: boolean) {
		if (value === this.#pilotToneHigh) return
		this.#pilotToneHigh = value
		if (this.#started) this.#writeRegister(KT0803L.REG02, this.#register02Value())
		this.fire()
	}

	// Returns whether the automatic level control loop is enabled.
	get automaticLevelControl() {
		return this.#automaticLevelControl
	}

	// Enables or disables the automatic level control loop.
	set automaticLevelControl(value: boolean) {
		if (value === this.#automaticLevelControl) return
		this.#automaticLevelControl = value
		if (this.#started) this.#writeRegister(KT0803L.REG04, this.#register04Value())
		this.fire()
	}

	// Returns whether automatic power-down on silence is enabled.
	get automaticPowerDown() {
		return this.#automaticPowerDown
	}

	// Enables or disables automatic power-down on silence.
	set automaticPowerDown(value: boolean) {
		if (value === this.#automaticPowerDown) return
		this.#automaticPowerDown = value
		if (this.#started) this.#writeRegister(KT0803L.REG0B, this.#register0BValue())
		this.fire()
	}

	// Returns whether the PA bias path is enabled.
	get powerAmplifierBias() {
		return this.#powerAmplifierBias
	}

	// Enables or disables the PA bias helper bit.
	set powerAmplifierBias(value: boolean) {
		if (value === this.#powerAmplifierBias) return
		this.#powerAmplifierBias = value
		if (this.#started) this.#writeRegister(KT0803L.REG0E, this.#register0EValue())
		this.fire()
	}

	// Returns the configured peak frequency deviation in kHz.
	get deviation() {
		return this.#deviation
	}

	// Selects either 75 kHz or 112.5 kHz peak frequency deviation.
	set deviation(value: KT0803LFrequencyDeviation) {
		const nextDeviation = value === 112.5 ? 112.5 : 75
		if (nextDeviation === this.#deviation) return
		this.#deviation = nextDeviation
		if (this.#started) this.#writeRegister(KT0803L.REG17, this.#register17Value())
		this.fire()
	}

	// Returns whether audio enhancement is enabled.
	get audioEnhancement() {
		return this.#audioEnhancement
	}

	// Enables or disables the internal audio enhancement block.
	set audioEnhancement(value: boolean) {
		if (value === this.#audioEnhancement) return
		this.#audioEnhancement = value
		if (this.#started) this.#writeRegister(KT0803L.REG17, this.#register17Value())
		this.fire()
	}

	// Applies the full write-only configuration while holding the transmitter in standby.
	#applyConfiguration() {
		this.#writeRegister(KT0803L.REG0B, this.#register0BValue(true))
		this.#writeRegister(KT0803L.REG10, this.#register10Value())
		this.#writeRegister(KT0803L.REG04, this.#register04Value())
		this.#writeRegister(KT0803L.REG0E, this.#register0EValue())
		this.#writeRegister(KT0803L.REG17, this.#register17Value())
		this.#writeRegister(KT0803L.REG13, this.#register13Value())
		this.#writeFrequency()
		this.#writeRegister(KT0803L.REG0B, this.#register0BValue())
	}

	// Writes the channel-dependent frequency and RF power registers.
	#writeFrequency() {
		this.#writeRegister(KT0803L.REG01, this.#register01Value())
		this.#writeRegister(KT0803L.REG02, this.#register02Value())
		this.#writeRegister(KT0803L.REG00, this.#register00Value())
	}

	// Writes one register/value pair to the KT0803L I2C address.
	#writeRegister(register: number, value: number) {
		this.client.twoWireWrite(this.address, [register, value & 0xff])
	}

	// Encodes CHSEL[8:1] into register 0x00.
	#register00Value() {
		return (this.#channel >>> 1) & 0xff
	}

	// Encodes RFGAIN[1:0], PGA[2:0], and CHSEL[11:9] into register 0x01.
	#register01Value() {
		const [pga, _pgaLsb] = this.#gainCode()
		return ((this.#transmitPower & 0x03) << 6) | (pga << 3) | ((this.#channel >>> 9) & 0x07)
	}

	// Encodes CHSEL[0], RFGAIN[3], mute, pilot, and pre-emphasis into register 0x02.
	#register02Value() {
		return (this.#channel & 1 ? KT0803L.REG02_CHSEL_LSB : 0) | (this.#transmitPower & 0x08 ? KT0803L.REG02_RFGAIN3 : 0) | (this.#muted ? KT0803L.REG02_MUTE : 0) | (this.#pilotToneHigh ? KT0803L.REG02_PILOT_HIGH : 0) | (this.#preEmphasis === 50 ? KT0803L.REG02_PREEMPHASIS_50 : 0)
	}

	// Encodes ALC, mono/stereo, PGA_LSB, and bass boost into register 0x04.
	#register04Value() {
		const [_pga, pgaLsb] = this.#gainCode()
		return (this.#automaticLevelControl ? KT0803L.REG04_ALC_ENABLE : 0) | (this.#stereo ? 0 : KT0803L.REG04_MONO) | (pgaLsb << KT0803L.REG04_PGA_LSB_SHIFT) | KT0803L.REG04_RESERVED | this.#bassBoostBits()
	}

	// Encodes standby and automatic power-down into register 0x0B.
	#register0BValue(standby: boolean = false) {
		return (standby ? KT0803L.REG0B_STANDBY : 0) | (this.#automaticPowerDown ? KT0803L.REG0B_AUTO_POWER_DOWN : 0)
	}

	// Encodes the PA bias helper bit into register 0x0E.
	#register0EValue() {
		return this.#powerAmplifierBias ? KT0803L.REG0E_PA_BIAS : 0
	}

	// Enables the KT0803L 1 dB PGA mode while preserving reserved default bits.
	#register10Value() {
		return KT0803L.REG10_RESERVED | KT0803L.REG10_PGA_1DB_MODE
	}

	// Encodes RFGAIN[2] into register 0x13.
	#register13Value() {
		return this.#transmitPower & 0x04 ? KT0803L.REG13_RFGAIN2 : 0
	}

	// Encodes deviation and audio enhancement into register 0x17.
	#register17Value() {
		return (this.#deviation === 112.5 ? KT0803L.REG17_DEVIATION_112_5_KHZ : 0) | (this.#audioEnhancement ? KT0803L.REG17_AUDIO_ENHANCEMENT : 0)
	}

	// Converts the public gain in dB into PGA[2:0] and PGA_LSB[1:0].
	#gainCode() {
		if (this.#gain === 0) return [0, 0] as const

		if (this.#gain > 0) {
			const positiveGain = this.#gain - 1
			return [5 + Math.floor(positiveGain / 4), positiveGain & 0x03] as const
		}

		const negativeGain = -this.#gain
		return [Math.floor(negativeGain / 4), negativeGain & 0x03] as const
	}

	// Converts the selected bass boost value into the register field bits.
	#bassBoostBits() {
		return this.#bassBoost === 5 ? 0x01 : this.#bassBoost === 11 ? 0x02 : this.#bassBoost === 17 ? 0x03 : 0x00
	}

	// Clamps the requested frequency to the chip band and rounds to 50 kHz steps.
	#normalizeChannel(frequency: number) {
		const requestedChannel = Number.isFinite(frequency) ? Math.round(frequency * KT0803L.CHANNELS_PER_MHZ) : KT0803L.DEFAULT_CHANNEL
		return clamp(requestedChannel, KT0803L.MIN_CHANNEL, KT0803L.MAX_CHANNEL)
	}

	// Converts one internal channel index back into the public MHz frequency.
	#frequencyFromChannel(channel: number) {
		return channel / KT0803L.CHANNELS_PER_MHZ
	}

	// Clamps the PGA gain to the supported 1 dB range.
	#normalizeGain(gain: number) {
		const requestedGain = Number.isFinite(gain) ? Math.round(gain) : DEFAULT_KT0803L_OPTIONS.gain
		return clamp(requestedGain, -15, 12)
	}

	// Clamps the datasheet RFGAIN code to the supported nibble range.
	#normalizeTransmitPower(transmitPower: number) {
		const requestedTransmitPower = Number.isFinite(transmitPower) ? Math.round(transmitPower) : DEFAULT_KT0803L_OPTIONS.transmitPower
		return clamp(requestedTransmitPower, 0, 15)
	}

	// Snaps one requested bass boost value to the nearest supported hardware setting.
	#normalizeBassBoost(bassBoost: number) {
		const requestedBassBoost = Number.isFinite(bassBoost) ? bassBoost : DEFAULT_KT0803L_OPTIONS.bassBoost
		if (requestedBassBoost < 2.5) return 0
		if (requestedBassBoost < 8) return 5
		if (requestedBassBoost < 14) return 11
		return 17
	}
}
