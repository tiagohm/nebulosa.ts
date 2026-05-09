import { type Angle, normalizeAngle, normalizePI } from './angle'
import { AU_KM, DAYSEC } from './constants'
import { equatorialToHorizontal } from './coordinate'
import type { Distance } from './distance'
import { clamp } from './math'
import { parallacticAngle, refractedAltitude } from './astrometry'
import { type BesselianElements, type BesselianState, evaluateBesselian, normalizeBesselianTime } from './sun.eclipse.besselian'
import type { SolarEclipseType } from './sun'
import { type Time, Timescale, timeShift, timeSubtract, toJulianDay } from './time'
import { NumberComparator } from './util'

// Local solar-eclipse circumstances derived from Besselian elements.
//
// Longitude is eastPositive internally. If longitudeConvention is
// westPositive, longitude is negated once at the API boundary. Azimuth is
// north = 0, east = +pi/2. Position angle is measured on the solar disk from
// celestial north toward east. Zenith angle is the parallactic/zenith angle at
// the Sun, normalized to [0, 2pi).
//
// This module follows the sun.besselian.ts convention: x/xi are eastward in
// the fundamental plane, y/eta are northward, l2 is positive for umbral total
// geometry and negative for antumbral annular geometry. Effective local radii
// are corrected by zeta because l1/l2 are defined on the geocentric
// fundamental plane.

const DEFAULT_SCAN_STEP_SECONDS = 60
const DEFAULT_TIME_TOLERANCE_SECONDS = 0.5
const DEFAULT_SOLAR_HORIZON_MIN_ALTITUDE = 0
const MINIMUM_RADIUS = 1e-12
const CONTACT_VALUE_TOLERANCE = 1e-7
const GRAZING_CONTACT_VALUE_TOLERANCE = 1e-5
const GOLDEN_RATIO_CONJUGATE = 0.3819660112501051

export type LocalEclipseContactType = 'C1' | 'C2' | 'MAX' | 'C3' | 'C4'
export type LocalEclipseVisibilityType = 'NONE' | SolarEclipseType

export interface LocalEclipseLocation {
	readonly latitude: Angle
	readonly longitude: Angle
	readonly altitude?: Distance
}

export interface LocalEclipseOptions {
	readonly useEarthEllipsoid?: boolean
	readonly includeRefraction?: boolean
	readonly solarHorizonMinAltitude?: Angle
	readonly timeToleranceSeconds?: number
	readonly scanStepSeconds?: number
	readonly longitudeConvention?: 'eastPositive' | 'westPositive'
}

export interface EclipseContact {
	readonly type: LocalEclipseContactType
	readonly time: Time
	readonly visible: boolean
	readonly sunAltitude: number
	readonly sunAzimuth: number
	readonly positionAngle: number
	readonly zenithAngle: number
	readonly magnitude: number
	readonly obscuration: number
	readonly moonSunDiameterRatio: number
	readonly shadowAxisDistance: number
	readonly penumbralRadius: number
	readonly umbralRadius: number
	readonly phase: LocalEclipsePhase
}

export interface LocalEclipsePhase {
	readonly type: LocalEclipseVisibilityType
	readonly isPartial: boolean
	readonly isTotal: boolean
	readonly isAnnular: boolean
	readonly isHybrid: boolean
	readonly geometricallyEclipsed: boolean
	readonly visibleAboveHorizon: boolean
}

export interface LocalEclipseDetail {
	readonly time: Time
	readonly location: LocalEclipseLocation
	readonly xi: number
	readonly eta: number
	readonly zeta: number
	readonly x: number
	readonly y: number
	readonly d?: number
	readonly mu?: number
	readonly u: number
	readonly v: number
	readonly m: number
	readonly L1: number
	readonly L2: number
	readonly magnitude: number
	readonly obscuration: number
	readonly moonSunDiameterRatio: number
	readonly sunAltitude: number
	readonly sunAzimuth: number
	readonly positionAngle: number
	readonly zenithAngle: number
	readonly phase: LocalEclipsePhase
	readonly visible: boolean
}

export interface LocalEclipseCircumstances {
	readonly location: LocalEclipseLocation
	readonly visible: boolean
	readonly type: LocalEclipseVisibilityType
	readonly c1?: EclipseContact
	readonly c2?: EclipseContact
	readonly maximum?: EclipseContact
	readonly c3?: EclipseContact
	readonly c4?: EclipseContact
	readonly maximumMagnitude: number
	readonly maximumObscuration: number
	readonly moonSunDiameterRatioAtMaximum: number
	readonly partialDurationSeconds?: number
	readonly totalOrAnnularDurationSeconds?: number
	readonly approximateShadowWidthKmAtMaximum?: number
	readonly geometricallyOccurs: boolean
	readonly visibleAboveHorizon: boolean
	readonly contacts: readonly EclipseContact[]
}

interface ResolvedLocalEclipseOptions {
	readonly useEarthEllipsoid: boolean
	readonly includeRefraction: boolean
	readonly solarHorizonMinAltitude: Angle
	readonly timeToleranceSeconds: number
	readonly scanStepSeconds: number
	readonly longitudeConvention: 'eastPositive' | 'westPositive'
}

interface ObserverFundamentalCoordinates {
	readonly xi: number
	readonly eta: number
	readonly zeta: number
}

interface ScanSample {
	readonly tauHours: number
	readonly detail: LocalEclipseDetail
	readonly penumbra: number
	readonly central: number
}

// Computes local eclipse circumstances at one instant without contact search.
export function computeLocalEclipseAt(elements: BesselianElements, location: LocalEclipseLocation, time: Time, options?: LocalEclipseOptions): LocalEclipseDetail {
	validateElements(elements)
	const resolved = resolveOptions(options)
	const local = normalizeLocation(location, resolved.longitudeConvention)
	validateLocation(local)

	const state = evaluateBesselian(elements, time)
	const observer = geodeticToFundamentalPlaneObserver(elements, local, state, resolved.useEarthEllipsoid)
	const u = state.x - observer.xi
	const v = state.y - observer.eta
	const m = Math.hypot(u, v)

	// l1/l2 are geocentric-plane radii. zeta projects the observer along the
	// shadow axis; the penumbra widens along the ray direction while the umbra
	// narrows until the antumbral cone begins.
	const L1 = state.l1 + observer.zeta * state.tanF1
	const L2 = state.l2 - observer.zeta * state.tanF2
	const sunRadius = Math.max((L1 - L2) * 0.5, MINIMUM_RADIUS)
	const moonRadius = Math.max((L1 + L2) * 0.5, MINIMUM_RADIUS)
	const magnitude = computeMagnitude(sunRadius, moonRadius, m)
	const obscuration = computeObscuration(sunRadius, moonRadius, m)
	const moonSunDiameterRatio = moonRadius / sunRadius
	const [sunAzimuth, sunAltitude] = computeSolarAltAz(state, local, resolved)
	const positionAngle = computePositionAngle(u, v)
	const zenithAngle = computeZenithAngle(state, local)
	const visibleAboveHorizon = sunAltitude >= resolved.solarHorizonMinAltitude
	const phase = computePhase(elements, magnitude, obscuration, m, L1, L2, visibleAboveHorizon)

	return {
		time,
		location: local,
		xi: observer.xi,
		eta: observer.eta,
		zeta: observer.zeta,
		x: state.x,
		y: state.y,
		d: state.d,
		mu: state.mu,
		u,
		v,
		m,
		L1,
		L2,
		magnitude,
		obscuration,
		moonSunDiameterRatio,
		sunAltitude,
		sunAzimuth,
		positionAngle,
		zenithAngle,
		phase,
		visible: phase.geometricallyEclipsed && visibleAboveHorizon,
	}
}

function EclipseContactComparator(a: EclipseContact, b: EclipseContact) {
	if (a.time === b.time) return 0
	return toJulianDay(a.time) - toJulianDay(b.time)
}

// Computes all local contacts and maximum circumstances inside the element validity interval.
export function computeLocalCircumstances(elements: BesselianElements, location: LocalEclipseLocation, options?: LocalEclipseOptions): LocalEclipseCircumstances {
	validateElements(elements)
	const resolved = resolveOptions(options)
	const local = normalizeLocation(location, resolved.longitudeConvention)
	validateLocation(local)

	const startTau = normalizeBesselianTime(elements, elements.validFrom)
	const endTau = normalizeBesselianTime(elements, elements.validTo)

	if (!(endTau > startTau)) throw new Error('Besselian validity interval must have positive duration')

	const samples = scanLocalCircumstances(elements, local, resolved, startTau, endTau)
	const penumbralRoots = findContactRoots(elements, local, resolved, samples, (detail) => detail.m - detail.L1)
	const maximumDetail = refineMaximum(elements, local, resolved, samples, startTau, endTau)
	const geometricallyOccurs = penumbralRoots.length >= 2 || maximumDetail.phase.geometricallyEclipsed

	let c1: EclipseContact | undefined
	let c4: EclipseContact | undefined
	let c2: EclipseContact | undefined
	let c3: EclipseContact | undefined
	let maximum: EclipseContact | undefined

	if (geometricallyOccurs) {
		if (penumbralRoots.length > 0) c1 = makeContact('C1', computeAtTau(elements, local, resolved, penumbralRoots[0]))
		if (penumbralRoots.length > 1) c4 = makeContact('C4', computeAtTau(elements, local, resolved, penumbralRoots.at(-1)!))

		const centralRoots = findContactRoots(elements, local, resolved, samples, (detail) => detail.m - Math.abs(detail.L2))

		if (centralRoots.length > 0 && maximumDetail.phase.type !== 'PARTIAL') c2 = makeContact('C2', computeAtTau(elements, local, resolved, centralRoots[0]))
		if (centralRoots.length > 1 && maximumDetail.phase.type !== 'PARTIAL') c3 = makeContact('C3', computeAtTau(elements, local, resolved, centralRoots.at(-1)!))

		maximum = makeContact('MAX', maximumDetail)
	}

	const contacts = [c1, c2, maximum, c3, c4].filter((contact) => contact !== undefined).sort(EclipseContactComparator)
	const visibleAboveHorizon = contacts.some((contact) => contact.visible) || samples.some((sample) => sample.detail.phase.geometricallyEclipsed && sample.detail.phase.visibleAboveHorizon)
	const visible = geometricallyOccurs && visibleAboveHorizon
	const partialDurationSeconds = c1 && c4 ? durationInSeconds(c1, c4) : undefined
	const totalOrAnnularDurationSeconds = c2 && c3 ? durationInSeconds(c2, c3) : undefined
	const preliminary: LocalEclipseCircumstances = {
		location: local,
		visible,
		type: 'NONE',
		c1,
		c2,
		maximum,
		c3,
		c4,
		maximumMagnitude: geometricallyOccurs ? maximumDetail.magnitude : 0,
		maximumObscuration: geometricallyOccurs ? maximumDetail.obscuration : 0,
		moonSunDiameterRatioAtMaximum: maximumDetail.moonSunDiameterRatio,
		partialDurationSeconds,
		totalOrAnnularDurationSeconds,
		approximateShadowWidthKmAtMaximum: approximateShadowWidthKm(elements, maximumDetail),
		geometricallyOccurs,
		visibleAboveHorizon,
		contacts,
	}

	return { ...preliminary, type: classifyLocalEclipse(preliminary) }
}

// Classifies visible local eclipse type from computed circumstances.
export function classifyLocalEclipse(circumstances: LocalEclipseCircumstances): LocalEclipseVisibilityType {
	if (!circumstances.visible || !circumstances.maximum) return 'NONE'

	const phase = circumstances.maximum.phase
	if (phase.isHybrid) return 'HYBRID'
	if (phase.isTotal) return 'TOTAL'
	if (phase.isAnnular) return 'ANNULAR'
	if (circumstances.maximumMagnitude > 0) return 'PARTIAL'
	return 'NONE'
}

function resolveOptions(options: LocalEclipseOptions = {}): ResolvedLocalEclipseOptions {
	const timeToleranceSeconds = options.timeToleranceSeconds ?? DEFAULT_TIME_TOLERANCE_SECONDS
	const scanStepSeconds = options.scanStepSeconds ?? DEFAULT_SCAN_STEP_SECONDS
	const solarHorizonMinAltitude = options.solarHorizonMinAltitude ?? DEFAULT_SOLAR_HORIZON_MIN_ALTITUDE

	validatePositiveFinite('timeToleranceSeconds', timeToleranceSeconds)
	validatePositiveFinite('scanStepSeconds', scanStepSeconds)
	validateFinite('solarHorizonMinAltitude', solarHorizonMinAltitude)

	return {
		useEarthEllipsoid: options.useEarthEllipsoid ?? true,
		includeRefraction: options.includeRefraction ?? false,
		solarHorizonMinAltitude,
		timeToleranceSeconds,
		scanStepSeconds,
		longitudeConvention: options.longitudeConvention ?? 'eastPositive',
	}
}

function normalizeLocation(location: LocalEclipseLocation, longitudeConvention: 'eastPositive' | 'westPositive'): Required<LocalEclipseLocation> {
	return {
		latitude: location.latitude,
		longitude: normalizePI(longitudeConvention === 'westPositive' ? -location.longitude : location.longitude),
		altitude: location.altitude ?? 0,
	}
}

function geodeticToFundamentalPlaneObserver(elements: BesselianElements, location: Required<LocalEclipseLocation>, state: BesselianState, useEarthEllipsoid: boolean): ObserverFundamentalCoordinates {
	const [rhoCosPhi, rhoSinPhi] = geodeticToGeocentric(elements, location, useEarthEllipsoid)
	const hourAngle = state.mu + location.longitude
	const sinH = Math.sin(hourAngle)
	const cosH = Math.cos(hourAngle)
	const sinD = Math.sin(state.d)
	const cosD = Math.cos(state.d)

	return { xi: rhoCosPhi * sinH, eta: rhoSinPhi * cosD - rhoCosPhi * cosH * sinD, zeta: rhoSinPhi * sinD + rhoCosPhi * cosH * cosD }
}

function geodeticToGeocentric(elements: BesselianElements, location: Required<LocalEclipseLocation>, useEarthEllipsoid: boolean): readonly [number, number] {
	const altitude = location.altitude / elements.earth.equatorialRadius
	const sinLat = Math.sin(location.latitude)
	const cosLat = Math.cos(location.latitude)

	if (!useEarthEllipsoid) {
		const radius = 1 + altitude
		return [radius * cosLat, radius * sinLat]
	}

	const flattening = elements.earth.flattening
	const eccentricitySquared = flattening * (2 - flattening)
	const normal = 1 / Math.sqrt(1 - eccentricitySquared * sinLat * sinLat)

	return [(normal + altitude) * cosLat, (normal * (1 - eccentricitySquared) + altitude) * sinLat]
}

function computeMagnitude(sunRadius: number, moonRadius: number, distance: number) {
	if (distance >= sunRadius + moonRadius) return 0
	return Math.max(0, (sunRadius + moonRadius - distance) / (2 * sunRadius))
}

function computeObscuration(sunRadius: number, moonRadius: number, distance: number) {
	const overlap = diskOverlapArea(sunRadius, moonRadius, distance)
	return clamp(overlap / (Math.PI * sunRadius * sunRadius), 0, 1)
}

function diskOverlapArea(a: number, b: number, distance: number) {
	if (!(a > 0) || !(b > 0)) return 0
	if (distance >= a + b) return 0

	const minRadius = Math.min(a, b)
	const maxRadius = Math.max(a, b)

	if (distance <= maxRadius - minRadius) return Math.PI * minRadius * minRadius
	if (distance <= 0) return Math.PI * minRadius * minRadius

	const a2 = a * a
	const b2 = b * b
	const d2 = distance * distance
	const alpha = Math.acos(clamp((d2 + a2 - b2) / (2 * distance * a), -1, 1))
	const beta = Math.acos(clamp((d2 + b2 - a2) / (2 * distance * b), -1, 1))
	const area = a2 * alpha + b2 * beta - 0.5 * Math.sqrt(Math.max(0, (-distance + a + b) * (distance + a - b) * (distance - a + b) * (distance + a + b)))

	return Math.max(0, area)
}

function computeSolarAltAz(state: BesselianState, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions): readonly [Angle, Angle] {
	const sunHourAngle = state.mu + location.longitude - Math.PI
	const [azimuth, geometricAltitude] = equatorialToHorizontal(0, -state.d, location.latitude, sunHourAngle)

	if (!options.includeRefraction) return [azimuth, geometricAltitude]

	const apparentAltitude = refractedAltitude(geometricAltitude)
	return [azimuth, Number.isFinite(apparentAltitude) ? apparentAltitude : geometricAltitude]
}

function computePositionAngle(u: number, v: number) {
	if (u === 0 && v === 0) return 0
	return normalizeAngle(Math.atan2(u, v))
}

function computeZenithAngle(state: BesselianState, location: Required<LocalEclipseLocation>) {
	return normalizeAngle(parallacticAngle(state.mu + location.longitude - Math.PI, -state.d, location.latitude))
}

function computePhase(elements: BesselianElements, magnitude: number, obscuration: number, m: number, L1: number, L2: number, visibleAboveHorizon: boolean): LocalEclipsePhase {
	const geometricallyEclipsed = magnitude > 0 && m < L1 + CONTACT_VALUE_TOLERANCE
	const central = geometricallyEclipsed && m <= Math.abs(L2) + CONTACT_VALUE_TOLERANCE
	const isHybrid = central && elements.eclipseTypeApprox === 'HYBRID'
	const isTotal = central && L2 > 0 && !isHybrid
	const isAnnular = central && L2 < 0 && !isHybrid
	const type: LocalEclipseVisibilityType = !geometricallyEclipsed ? 'NONE' : isHybrid ? 'HYBRID' : isTotal ? 'TOTAL' : isAnnular ? 'ANNULAR' : 'PARTIAL'

	return {
		type,
		isPartial: geometricallyEclipsed && !isTotal && !isAnnular && !isHybrid && obscuration > 0,
		isTotal,
		isAnnular,
		isHybrid,
		geometricallyEclipsed,
		visibleAboveHorizon,
	}
}

function scanLocalCircumstances(elements: BesselianElements, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions, startTau: number, endTau: number) {
	const samples: ScanSample[] = []
	const stepHours = options.scanStepSeconds / 3600

	for (let tau = startTau; tau < endTau; tau += stepHours) {
		samples.push(makeScanSample(elements, location, options, tau))
	}

	if (samples.length === 0 || Math.abs(samples.at(-1)!.tauHours - endTau) > 1e-12) {
		samples.push(makeScanSample(elements, location, options, endTau))
	}

	return samples
}

function makeScanSample(elements: BesselianElements, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions, tauHours: number): ScanSample {
	const detail = computeAtTau(elements, location, options, tauHours)
	return { tauHours, detail, penumbra: detail.m - detail.L1, central: detail.m - Math.abs(detail.L2) }
}

function findContactRoots(elements: BesselianElements, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions, samples: readonly ScanSample[], value: (detail: LocalEclipseDetail) => number) {
	const roots: number[] = []

	function bisectRootValue(tau: number) {
		return value(computeAtTau(elements, location, options, tau))
	}

	for (let i = 1; i < samples.length; i++) {
		const previous = samples[i - 1]
		const current = samples[i]
		const f0 = value(previous.detail)
		const f1 = value(current.detail)

		if (Math.abs(f0) <= CONTACT_VALUE_TOLERANCE) addRoot(roots, previous.tauHours)
		if (f0 * f1 < 0) addRoot(roots, bisectRoot(previous.tauHours, current.tauHours, bisectRootValue, options.timeToleranceSeconds / 3600))
	}

	for (let i = 1; i + 1 < samples.length; i++) {
		const previous = value(samples[i - 1].detail)
		const current = value(samples[i].detail)
		const next = value(samples[i + 1].detail)

		if (current >= 0 && current <= previous && current <= next && current <= GRAZING_CONTACT_VALUE_TOLERANCE) {
			const root = goldenSectionMinimum(samples[i - 1].tauHours, samples[i + 1].tauHours, (tau) => Math.abs(value(computeAtTau(elements, location, options, tau))), options.timeToleranceSeconds / 3600)

			if (Math.abs(value(computeAtTau(elements, location, options, root))) <= GRAZING_CONTACT_VALUE_TOLERANCE) addRoot(roots, root)
		}
	}

	const last = samples.at(-1)
	if (last && Math.abs(value(last.detail)) <= CONTACT_VALUE_TOLERANCE) addRoot(roots, last.tauHours)

	return roots.sort(NumberComparator)
}

function addRoot(roots: number[], root: number) {
	if (!Number.isFinite(root)) return
	if (roots.length === 0 || Math.abs(root - roots.at(-1)!) > 1e-5) roots.push(root)
}

function bisectRoot(a: number, b: number, value: (tauHours: number) => number, toleranceHours: number) {
	let left = a
	let right = b
	let fLeft = value(left)
	let fRight = value(right)

	if (Math.abs(fLeft) <= CONTACT_VALUE_TOLERANCE) return left
	if (Math.abs(fRight) <= CONTACT_VALUE_TOLERANCE) return right

	for (let i = 0; i < 80 && right - left > toleranceHours; i++) {
		const mid = (left + right) * 0.5
		const fMid = value(mid)

		if (Math.abs(fMid) <= CONTACT_VALUE_TOLERANCE) return mid

		if (fLeft * fMid <= 0) {
			right = mid
			fRight = fMid
		} else {
			left = mid
			fLeft = fMid
		}
	}

	return Math.abs(fLeft) < Math.abs(fRight) ? left : right
}

function refineMaximum(elements: BesselianElements, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions, samples: readonly ScanSample[], startTau: number, endTau: number) {
	let best = 0

	for (let i = 1; i < samples.length; i++) {
		const candidate = samples[i]
		const current = samples[best]

		if (candidate.detail.magnitude > current.detail.magnitude || (candidate.detail.magnitude === current.detail.magnitude && candidate.penumbra < current.penumbra)) {
			best = i
		}
	}

	const left = best > 0 ? samples[best - 1].tauHours : startTau
	const right = best + 1 < samples.length ? samples[best + 1].tauHours : endTau
	const maximizeMagnitude = samples[best].detail.magnitude > 0

	function objective(tau: number) {
		const detail = computeAtTau(elements, location, options, tau)
		return maximizeMagnitude ? detail.magnitude : -Math.max(0, detail.m - detail.L1)
	}

	const tau = goldenSectionMaximum(left, right, objective, options.timeToleranceSeconds / 3600)
	return computeAtTau(elements, location, options, tau)
}

function goldenSectionMaximum(left: number, right: number, objective: (tauHours: number) => number, toleranceHours: number) {
	let a = left
	let b = right
	let c = b - GOLDEN_RATIO_CONJUGATE * (b - a)
	let d = a + GOLDEN_RATIO_CONJUGATE * (b - a)
	let fc = objective(c)
	let fd = objective(d)

	for (let i = 0; i < 80 && b - a > toleranceHours; i++) {
		if (fc < fd) {
			a = c
			c = d
			fc = fd
			d = a + GOLDEN_RATIO_CONJUGATE * (b - a)
			fd = objective(d)
		} else {
			b = d
			d = c
			fd = fc
			c = b - GOLDEN_RATIO_CONJUGATE * (b - a)
			fc = objective(c)
		}
	}

	return (a + b) * 0.5
}

function goldenSectionMinimum(left: number, right: number, objective: (tauHours: number) => number, toleranceHours: number) {
	return goldenSectionMaximum(left, right, (tau) => -objective(tau), toleranceHours)
}

function computeAtTau(elements: BesselianElements, location: Required<LocalEclipseLocation>, options: ResolvedLocalEclipseOptions, tauHours: number) {
	return computeLocalEclipseAt(elements, location, timeShift(elements.t0, tauHours / 24), { ...options, longitudeConvention: 'eastPositive' })
}

function makeContact(type: LocalEclipseContactType, detail: LocalEclipseDetail): EclipseContact {
	return {
		type,
		time: detail.time,
		visible: detail.phase.visibleAboveHorizon,
		sunAltitude: detail.sunAltitude,
		sunAzimuth: detail.sunAzimuth,
		positionAngle: detail.positionAngle,
		zenithAngle: detail.zenithAngle,
		magnitude: detail.magnitude,
		obscuration: detail.obscuration,
		moonSunDiameterRatio: detail.moonSunDiameterRatio,
		shadowAxisDistance: detail.m,
		penumbralRadius: detail.L1,
		umbralRadius: detail.L2,
		phase: detail.phase,
	}
}

function durationInSeconds(start: EclipseContact, end: EclipseContact) {
	return start.time && end.time ? timeSubtract(end.time, start.time, Timescale.TT) * DAYSEC : undefined
}

function approximateShadowWidthKm(elements: BesselianElements, maximum: LocalEclipseDetail) {
	if (!maximum.phase.isTotal && !maximum.phase.isAnnular && !maximum.phase.isHybrid) return undefined
	return 2 * Math.abs(maximum.L2) * elements.earth.equatorialRadius * AU_KM
}

function validateElements(elements: BesselianElements) {
	validateTime(elements.t0, 'elements.t0')
	validateTime(elements.validFrom, 'elements.validFrom')
	validateTime(elements.validTo, 'elements.validTo')
	validatePositiveFinite('elements.earth.equatorialRadius', elements.earth.equatorialRadius)
	validateFinite('elements.earth.flattening', elements.earth.flattening)
}

function validateLocation(location: Required<LocalEclipseLocation>) {
	validateFinite('location.latitude', location.latitude)
	validateFinite('location.longitude', location.longitude)
	validateFinite('location.altitude', location.altitude)

	if (Math.abs(location.latitude) > Math.PI / 2) throw new Error('location.latitude must be in radians within [-pi/2, pi/2]')
}

function validateTime(time: Time, name: string) {
	if (!Number.isFinite(time.day) || !Number.isFinite(time.fraction)) throw new Error(`${name} must have finite day and fraction`)
	if (time.scale < Timescale.UT1 || time.scale > Timescale.TCB) throw new Error(`${name} must have a valid timescale`)
}

function validatePositiveFinite(name: string, value: number) {
	if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} must be a positive finite number`)
}

function validateFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
