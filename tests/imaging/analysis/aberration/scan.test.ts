import { expect, test } from 'bun:test'
import { inspectAberrationFocusScan, type AberrationFocusFrame } from '../../../../src/imaging/analysis/aberration/scan'
import type { StarProfile } from '../../../../src/imaging/stars/profile'

// Creates a valid synthetic moments profile at a normalized sensor location.
function profile(u: number, v: number, value: number): StarProfile {
	return {
		x: (u + 0.5) * 100,
		y: (v + 0.5) * 100,
		valid: true,
		flux: 1,
		snr: 30,
		hfd: value,
		fwhm: value,
		major: value * 1.1,
		minor: value,
		eccentricity: 0.3,
		elongation: 1.1,
		theta: 0,
		background: 0,
		deviation: 0.01,
		peak: 0.5,
		quality: 1,
		model: 'moments',
		flags: [],
	}
}

// Creates one profiles-only scan frame whose fixed-sensor regional minima form a known plane.
function frame(position: number): { readonly position: number; readonly profiles: readonly StarProfile[]; readonly width: number; readonly height: number } {
	const profiles: StarProfile[] = []
	for (const v of [-0.4, 0, 0.4]) {
		for (const u of [-0.4, 0, 0.4]) {
			const bestFocus = 100 + 10 * u - 4 * v
			const value = 2 + ((position - bestFocus) * (position - bestFocus)) / 25
			for (let sample = 0; sample < 3; sample++) profiles.push(profile(u, v, value))
		}
	}
	return { position, profiles, width: 101, height: 101 }
}

// Creates uniquely positioned stars with a small frame-to-frame dither for registration-track tests.
function trackingFrame(position: number): { readonly position: number; readonly profiles: readonly StarProfile[]; readonly width: number; readonly height: number } {
	const coordinates = [
		[-0.4, -0.4],
		[0, -0.35],
		[0.38, -0.25],
		[-0.3, 0.1],
		[0.1, 0.2],
		[0.4, 0.4],
	] as const
	const shiftX = 0.03 * (position - 100)
	const shiftY = -0.02 * (position - 100)
	const profiles: StarProfile[] = []
	for (let i = 0; i < coordinates.length; i++) {
		const [u, v] = coordinates[i]
		const bestFocus = 100 + 6 * u - 3 * v
		const measured = profile(u, v, 2 + ((position - bestFocus) * (position - bestFocus)) / 25)
		profiles.push({ ...measured, x: measured.x + shiftX, y: measured.y + shiftY, sourceIndex: i })
	}
	return { position, profiles, width: 101, height: 101 }
}

// Ground-truth planar focus field in normalized sensor coordinates.
interface RealFocusSweepGroundTruth {
	// Focus at the normalized sensor origin in focuser steps.
	readonly c: number
	// Focus gradient along normalized sensor X in focuser steps.
	readonly ax: number
	// Focus gradient along normalized sensor Y in focuser steps.
	readonly ay: number
}

// Width of the source NGC 3372 detector frame in pixels.
const REAL_FOCUS_SWEEP_WIDTH = 1037
// Height of the source NGC 3372 detector frame in pixels.
const REAL_FOCUS_SWEEP_HEIGHT = 706
// Sampled focuser positions in steps, spanning every field-dependent minimum on both sides.
const REAL_FOCUS_SWEEP_POSITIONS = [9700, 9800, 9850, 9900, 9950, 10000, 10050, 10100, 10150, 10200, 10300] as const
// Known plane applied to the real star coordinates.
const REAL_FOCUS_SWEEP_GROUND_TRUTH: RealFocusSweepGroundTruth = { c: 10000, ax: 120, ay: -70 }
// Focuser-step scale whose square adds one pixel to the synthetic defocus metric.
const DEFOCUS_SCALE = 100

// Four highest-SNR retained detector measurements from each cell of a 3x3 grid over NGC3372--32.3.fit.
const REAL_FIELD_STARS = [
	{ x: 255, y: 69, hfd: 2.007948920796636, fwhm: 2.0506145864743495, snr: 1.6114916610705534, flux: 2.5972485461207406 },
	{ x: 36, y: 32, hfd: 2.112031019189417, fwhm: 2.1287631875670203, snr: 1.3752776189644464, flux: 1.89138946440757 },
	{ x: 119, y: 163, hfd: 1.8234805182896208, fwhm: 1.9200573454403265, snr: 1.014509562912081, flux: 1.0292510141120421 },
	{ x: 18, y: 105, hfd: 2.8405712842283504, fwhm: 2.953663085597879, snr: 0.7774506039926361, flux: 0.6044315259110924 },
	{ x: 577, y: 24, hfd: 2.3260931011096933, fwhm: 2.322302234494129, snr: 2.1737621271889997, flux: 4.725258391229319 },
	{ x: 594, y: 108, hfd: 1.9642946281905045, fwhm: 2.0359201065312043, snr: 1.8593203115726769, flux: 3.4570759159703814 },
	{ x: 439, y: 71, hfd: 1.856506101438268, fwhm: 2.014318112635066, snr: 1.3190167685278062, flux: 1.739807120189895 },
	{ x: 412, y: 215, hfd: 2.0333786857040095, fwhm: 2.1178997161889566, snr: 1.2373299261995143, flux: 1.5310143397439229 },
	{ x: 1006, y: 190, hfd: 2.1139615567760566, fwhm: 2.139918733854258, snr: 2.1593666225328034, flux: 4.663022360432658 },
	{ x: 924, y: 132, hfd: 1.9031497598205964, fwhm: 1.992897486865323, snr: 1.616878353738379, flux: 2.6143000802211716 },
	{ x: 746, y: 54, hfd: 2.0577694521205, fwhm: 2.041399846372209, snr: 1.5822326803135038, flux: 2.5041478571873284 },
	{ x: 986, y: 175, hfd: 1.8616466126797317, fwhm: 1.948661758420559, snr: 1.3913077420543123, flux: 1.935741810226225 },
	{ x: 177, y: 345, hfd: 3.3258775035951205, fwhm: 3.220265222686411, snr: 2.8494017318973466, flux: 8.13494885181639 },
	{ x: 109, y: 248, hfd: 2.1920511090159716, fwhm: 2.1871461345606664, snr: 2.172313503624702, flux: 4.718956892507498 },
	{ x: 244, y: 380, hfd: 2.0757281088398956, fwhm: 2.1196213262932226, snr: 1.9748118025642911, flux: 3.90008813939689 },
	{ x: 191, y: 450, hfd: 2.126604941261524, fwhm: 2.164446468955906, snr: 1.7352171743169034, flux: 3.0109872015163464 },
	{ x: 457, y: 310, hfd: 2.9661776129387354, fwhm: 2.797932501732788, snr: 3.231741026979684, flux: 10.683527579778142 },
	{ x: 434, y: 442, hfd: 2.6508479162588157, fwhm: 2.552516119198226, snr: 2.8737121897292464, flux: 8.258332458270436 },
	{ x: 658, y: 422, hfd: 2.2975262254134123, fwhm: 2.259329482240836, snr: 2.396143538325811, flux: 5.743654402611631 },
	{ x: 482, y: 353, hfd: 2.8905125919577306, fwhm: 3.0328123265561593, snr: 2.3637335104594355, flux: 6.932081761489732 },
	{ x: 858, y: 466, hfd: 2.1967278880410293, fwhm: 2.176854408439633, snr: 2.3613863860400066, flux: 5.579393260784196 },
	{ x: 969, y: 282, hfd: 2.059046411230638, fwhm: 2.078774322576929, snr: 2.003086830501851, flux: 4.012379867698315 },
	{ x: 927, y: 271, hfd: 1.8480429024224412, fwhm: 1.9430822044442342, snr: 1.832351469623157, flux: 3.35752535958312 },
	{ x: 738, y: 277, hfd: 1.9074186445367982, fwhm: 2.066173229880165, snr: 1.4742418392914964, flux: 2.174499843211203 },
	{ x: 183, y: 526, hfd: 2.639834324122723, fwhm: 2.5316012042992955, snr: 2.9220734500744916, flux: 8.538622646027793 },
	{ x: 277, y: 580, hfd: 2.5079623029260127, fwhm: 2.4212626438650546, snr: 2.697824830757575, flux: 7.300346581523698 },
	{ x: 45, y: 561, hfd: 2.3833727499239057, fwhm: 2.3051777919823047, snr: 2.6478430725209727, flux: 7.011100789041953 },
	{ x: 191, y: 650, hfd: 2.0166948669001963, fwhm: 2.0615911854383735, snr: 2.0694727176171446, flux: 4.282724426493151 },
	{ x: 564, y: 544, hfd: 4.696288577343458, fwhm: 4.195199696377722, snr: 5.712565749333472, flux: 32.87075967518085 },
	{ x: 541, y: 543, hfd: 2.291560255376859, fwhm: 2.2533347441555853, snr: 2.3630811631199853, flux: 5.584221853274367 },
	{ x: 658, y: 490, hfd: 2.2071532709389494, fwhm: 2.1064722084346705, snr: 2.211488830800506, flux: 5.780383675896996 },
	{ x: 637, y: 523, hfd: 1.9711006979553074, fwhm: 2.013740876424789, snr: 2.0053771481529976, flux: 4.021613769508774 },
	{ x: 984, y: 578, hfd: 2.9525228186012136, fwhm: 2.8039662765023916, snr: 3.326494131310963, flux: 11.066091594517301 },
	{ x: 880, y: 640, hfd: 2.209327303836876, fwhm: 2.159396356701706, snr: 2.2443799776059277, flux: 5.113895265091967 },
	{ x: 845, y: 541, hfd: 2.21232730654464, fwhm: 2.2028920366566935, snr: 2.1405177647300593, flux: 4.5818278801889045 },
	{ x: 705, y: 531, hfd: 2.16084788729299, fwhm: 2.1539151995473516, snr: 2.1084276168041307, flux: 4.445476016252545 },
] as const

// Returns the known best focus for a detector coordinate in focuser steps.
function realFocusSweepBestFocus(x: number, y: number): number {
	const u = x / (REAL_FOCUS_SWEEP_WIDTH - 1) - 0.5
	const v = y / (REAL_FOCUS_SWEEP_HEIGHT - 1) - 0.5
	return REAL_FOCUS_SWEEP_GROUND_TRUTH.c + REAL_FOCUS_SWEEP_GROUND_TRUTH.ax * u + REAL_FOCUS_SWEEP_GROUND_TRUTH.ay * v
}

// Builds one profiles-only frame using real field geometry and an analytic quadratic defocus term.
function realFocusSweepFrame(position: number): AberrationFocusFrame {
	const profiles = new Array<StarProfile>(REAL_FIELD_STARS.length)
	for (let i = 0; i < REAL_FIELD_STARS.length; i++) {
		const star = REAL_FIELD_STARS[i]
		const offset = (position - realFocusSweepBestFocus(star.x, star.y)) / DEFOCUS_SCALE
		const defocus = offset * offset
		const hfd = star.hfd + defocus
		const fwhm = star.fwhm + defocus
		profiles[i] = {
			x: star.x,
			y: star.y,
			valid: true,
			flux: star.flux,
			snr: star.snr,
			hfd,
			fwhm,
			major: fwhm * 1.05,
			minor: fwhm,
			eccentricity: 0.3049106779729929,
			elongation: 1.05,
			theta: 0,
			background: 0,
			deviation: 0.01,
			peak: 0.5,
			quality: Math.min(1, star.snr / 5),
			model: 'moments',
			flags: [],
			sourceIndex: i,
		}
	}
	return { id: `ngc3372-focus-${position}`, position, profiles, width: REAL_FOCUS_SWEEP_WIDTH, height: REAL_FOCUS_SWEEP_HEIGHT }
}

// Fits fixed-sensor regional curves and recovers their planar best-focus surface without registration.
test('inspects a regional profiles-only focus scan', () => {
	const frames = [80, 90, 95, 100, 105, 110, 120].map(frame)
	const result = inspectAberrationFocusScan(frames, { regions: { layout: 'grid', columns: 3, rows: 3 }, curve: { minimumPoints: 5 }, surface: { model: 'plane' } })

	expect(result.width).toBe(101)
	expect(result.height).toBe(101)
	expect(result.quality.usedFrameCount).toBe(7)
	expect(result.quality.breakdown.sampleSupport).toBe(1)
	expect(result.quality.breakdown.spatialCoverage).toBe(1)
	expect(result.quality.breakdown.total).toBeGreaterThan(0)
	expect(result.regions).toHaveLength(9)
	expect(result.regions.every((region) => region.curve.success)).toBeTrue()
	expect(result.surface?.success).toBeTrue()
	if (!result.surface?.success) return
	expect(result.surface.coefficients.c).toBeCloseTo(100, 6)
	expect(result.surface.coefficients.ax).toBeCloseTo(10, 6)
	expect(result.surface.coefficients.ay).toBeCloseTo(-4, 6)
	expect(result.plane?.effect).toBeCloseTo(14, 6)
	expect(result.findings.some((finding) => finding.kind === 'sensorTiltPattern')).toBeTrue()
	expect(result.findings.some((finding) => finding.kind === 'backfocusMismatch')).toBeFalse()
})

// Rejects a frame that has selected profiles but no usable value for the requested metric.
test('rejects frames without support for the requested metric', () => {
	const unsupported = frame(100)
	const profiles = unsupported.profiles.map((profile) => ({ ...profile, fwhm: undefined }))
	const result = inspectAberrationFocusScan([{ ...unsupported, profiles }], { metric: 'fwhm', regions: { layout: 'grid', columns: 3, rows: 3 } })

	expect(result.frames[0].status).toBe('rejected')
	expect(result.frames[0].rejectionReasons).toContain('unsupportedPosition')
	expect(result.quality.usedFrameCount).toBe(0)
})

// Preserves rejected-frame order and identity when dimensions do not match the accepted scan.
test('rejects inconsistent focus-scan frame dimensions', () => {
	const frames = [...[90, 95, 100, 105, 110].map(frame), { ...frame(115), id: 'wrong-size', width: 99 }]
	const result = inspectAberrationFocusScan(frames, { regions: { layout: 'grid', columns: 3, rows: 3 } })

	expect(result.frames).toHaveLength(6)
	expect(result.frames[5].status).toBe('rejected')
	expect(result.frames[5].id).toBe('wrong-size')
	expect(result.frames[5].rejectionReasons).toContain('inconsistentDimensions')
})

// Registers dithered frames without warping and publishes unambiguous per-star focus curves.
test('builds registered per-star tracks and curves', () => {
	const result = inspectAberrationFocusScan([80, 90, 95, 100, 105, 110, 120].map(trackingFrame), {
		inspection: { minimumStars: 1, minimumStarsPerRegion: 1 },
		regions: { layout: 'grid', columns: 3, rows: 3 },
		tracking: { minimumFrames: 5, maximumResidual: 0.5, registration: { acceptance: { minInliers: 3, maxRmsError: 0.5 } } },
		surface: { model: 'plane' },
	})

	expect(result.quality.usedFrameCount).toBe(7)
	expect(result.quality.breakdown.registrationQuality).toBeDefined()
	expect(result.tracks).toHaveLength(6)
	expect(result.tracks?.every((track) => track.points.length === 7 && track.curve?.success)).toBeTrue()
})

// Keeps FWHM-only profiles eligible for registration when HFD was not measured.
test('builds FWHM tracks without requiring HFD profiles', () => {
	const frames = [80, 90, 95, 100, 105, 110, 120].map((position) => {
		const current = trackingFrame(position)
		return Object.assign({}, current, { profiles: current.profiles.map((profile) => Object.assign({}, profile, { hfd: undefined })) })
	})
	const result = inspectAberrationFocusScan(frames, {
		metric: 'fwhm',
		inspection: { minimumStars: 1, minimumStarsPerRegion: 1 },
		regions: { layout: 'grid', columns: 3, rows: 3 },
		tracking: { minimumFrames: 5, maximumResidual: 0.5, registration: { acceptance: { minInliers: 3, maxRmsError: 0.5 } } },
	})

	expect(result.frames.every((frame) => frame.status === 'used')).toBeTrue()
	expect(result.tracks).toHaveLength(6)
	expect(result.tracks?.every((track) => track.points.length === 7 && track.curve?.success)).toBeTrue()
	expect(result.quality.breakdown.stability).toBeGreaterThan(0)
	expect(result.quality.confidence).toBeGreaterThan(0)
})

// Prevents a frame rejected by registration from leaking into fixed-sensor regional curves.
test('excludes registration-failed frames from regional curves', () => {
	const failed = trackingFrame(130)
	const result = inspectAberrationFocusScan([...[80, 90, 95, 100, 105, 110, 120].map(trackingFrame), { ...failed, id: 'registration-failure', profiles: failed.profiles.slice(0, 1) }], {
		inspection: { minimumStars: 1, minimumStarsPerRegion: 1 },
		regions: { layout: 'grid', columns: 3, rows: 3 },
		tracking: { minimumFrames: 5, maximumResidual: 0.5, registration: { acceptance: { minInliers: 3, maxRmsError: 0.5 } } },
		surface: { model: 'plane' },
	})

	expect(result.frames[7].status).toBe('rejected')
	expect(result.frames[7].rejectionReasons).toContain('registrationFailed')
	for (const region of result.regions) expect(region.curve.points.some((point) => point.position === 130)).toBeFalse()
})

// Recovers known per-star minima and field tilt from real NGC 3372 detector geometry.
test('recovers ground truth from a real-field-derived focus sweep', () => {
	const result = inspectAberrationFocusScan(REAL_FOCUS_SWEEP_POSITIONS.map(realFocusSweepFrame), {
		inspection: { minimumStars: 30, minimumStarsPerRegion: 3 },
		regions: { layout: 'grid', columns: 3, rows: 3 },
		curve: { model: 'auto' },
		tracking: { minimumFrames: 7, maximumResidual: 0.1, registration: { acceptance: { minInliers: 12, maxRmsError: 0.1 } } },
		surface: { model: 'plane' },
	})

	expect(result.frames.every((frame) => frame.status === 'used')).toBeTrue()
	expect(result.frames[0].id).toBe(`ngc3372-focus-${REAL_FOCUS_SWEEP_POSITIONS[0]}`)
	expect(result.regions).toHaveLength(9)
	expect(result.regions.every((region) => region.curve.success)).toBeTrue()
	expect(result.surface?.success).toBeTrue()
	if (!result.surface?.success) return
	expect(result.surface.coefficients.c).toBeCloseTo(REAL_FOCUS_SWEEP_GROUND_TRUTH.c, 6)
	expect(result.surface.coefficients.ax).toBeCloseTo(REAL_FOCUS_SWEEP_GROUND_TRUTH.ax, 6)
	expect(result.surface.coefficients.ay).toBeCloseTo(REAL_FOCUS_SWEEP_GROUND_TRUTH.ay, 6)
	expect(result.tracks).toHaveLength(36)
	for (const track of result.tracks ?? []) {
		expect(track.curve?.success).toBeTrue()
		if (track.curve?.success) expect(track.curve.minimum.x).toBeCloseTo(realFocusSweepBestFocus(track.x, track.y), 5)
	}
})
