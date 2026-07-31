import { type EquatorialCoordinate, equatorialToHorizontal } from '../../astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../astronomy/observer/location'
import type { Time } from '../../astronomy/time/time'
import { PI, PIOVERTWO } from '../../core/constants'
import type { PierSide } from '../../devices/indi/device'
import type { NumberArray } from '../../math/numerical/math'
import { type Angle, normalizePI } from '../../math/units/angle'

// Basis functions for the mount pointing-error model: the observing context derived from a sky
// position, the canonical TPOINT-style semi-physical terms, and the empirical linear feature set.
// Every basis maps a sky position plus mount state to a local tangent-plane offset in radians with
// dx positive toward east and dy positive toward north, matching the error convention
// `error = solved - target`. Bases return contributions per unit parameter; the fitted coefficient
// carries the magnitude. Nothing here mutates its inputs.

// A local tangent-plane offset in radians: dx toward east, dy toward north.
export interface PointingOffset {
	// East-positive tangent offset (radians).
	readonly dx: number
	// North-positive tangent offset (radians).
	readonly dy: number
}

// Reference frame in which a pointing coordinate is expressed.
//
// The mechanical model describes where the tube goes, not how the sky was reduced, so mixing frames
// makes it absorb precession, aberration or refraction as if they were mechanical error. Declare the
// frame once and keep every sample and every prediction in it.
//   'apparentTopocentric'          apparent place of date, topocentric, no refraction — the recommended
//                                  default, since refraction belongs to the astrometric layer;
//   'apparentTopocentricRefracted' the same, with refraction already applied to the coordinates;
//   'icrs'                         catalogue (J2000/ICRS) place, with no apparent-place reduction.
export type PointingFrame = 'apparentTopocentric' | 'apparentTopocentricRefracted' | 'icrs'

// Every frame the model accepts, in declaration order.
export const POINTING_FRAMES = ['apparentTopocentric', 'apparentTopocentricRefracted', 'icrs'] as const satisfies readonly PointingFrame[]

// A coordinate plus optional context to evaluate or correct with a fitted model.
export interface PointingModelInput extends EquatorialCoordinate {
	// Time used to derive local sidereal time, hour angle and altitude.
	time?: Time
	// Site geodetic latitude (radians).
	latitude?: Angle
	// Site longitude (radians, positive east).
	longitude?: Angle
	// Mount pier side.
	pierSide?: PierSide
	// Frame the coordinate is expressed in. When given, a prediction warns if it differs from the frame
	// the model was fitted in; when omitted, the model's frame is assumed.
	frame?: PointingFrame
}

// Geometric state derived from a coordinate and observing context, shared by all model components.
export interface PointingContext extends Readonly<EquatorialCoordinate> {
	// Observation time, when available.
	readonly time?: Time
	// Normalized pier side ('EAST' | 'WEST' | 'NEITHER').
	readonly pierSide: PierSide
	// Numeric pier-side encoding: +1 east, -1 west, 0 neither.
	readonly pierSideValue: number
	// Local apparent sidereal time (radians), when derivable.
	readonly lst?: Angle
	// Hour angle (radians, normalized to -PI..PI), when derivable.
	readonly hourAngle?: Angle
	// Altitude above the horizon (radians), when derivable.
	readonly altitude?: Angle
	// Azimuth (radians), when derivable.
	readonly azimuth?: Angle
	// Site latitude (radians).
	readonly latitude?: Angle
	// Site longitude (radians, positive east).
	readonly longitude?: Angle
	// Frame declared by the input, carried through unchanged. No basis term uses it; it exists so a
	// prediction can be checked against the frame the model was fitted in.
	readonly frame?: PointingFrame
}

// Observing context a basis term needs before it can be evaluated. Terms are dropped from the fit
// when the available samples cannot satisfy their requirement; they are never zero-filled, because a
// zeroed term silently aliases the constant term and corrupts the remaining coefficients.
//   'none'       only the declination of the requested coordinate;
//   'hourAngle'  additionally the hour angle, so time and site longitude;
//   'horizon'    additionally the site latitude, so the full horizontal geometry.
export type PointingContextRequirement = 'none' | 'hourAngle' | 'horizon'

// Canonical TPOINT-style term names for an equatorial mount.
//   CH  collimation: optical axis not perpendicular to the declination axis;
//   IH  hour-angle index (zero-point) error;
//   ID  declination index (zero-point) error;
//   NP  non-perpendicularity between the polar and declination axes;
//   MA  polar-axis misalignment in azimuth (left-right);
//   ME  polar-axis misalignment in elevation (up-down);
//   TF  tube flexure, drooping the optical axis toward the horizon.
export type SemiPhysicalTermName = 'CH' | 'IH' | 'ID' | 'NP' | 'MA' | 'ME' | 'TF'

// Ordered default term set. The basis builder maps names to columns through this order.
export const SEMI_PHYSICAL_TERM_NAMES = ['CH', 'IH', 'ID', 'NP', 'MA', 'ME', 'TF'] as const satisfies readonly SemiPhysicalTermName[]

// Observing context each semi-physical term requires. MA and ME are hour-angle dependent; TF is
// referenced to the horizon and therefore also needs the site latitude.
export const SEMI_PHYSICAL_TERM_REQUIREMENTS: Readonly<Record<SemiPhysicalTermName, PointingContextRequirement>> = {
	CH: 'none',
	IH: 'none',
	ID: 'none',
	NP: 'none',
	MA: 'hourAngle',
	ME: 'hourAngle',
	TF: 'horizon',
}

// Toggles for which empirical basis terms enter the design matrix.
export interface PointingFeatureConfiguration {
	// Include a constant bias term.
	readonly includeBias?: boolean
	// Include sin/cos of hour angle.
	readonly includeHourAngleTerms?: boolean
	// Include sin/cos of declination.
	readonly includeDeclinationTerms?: boolean
	// Include sin/cos of altitude.
	readonly includeAltitudeTerms?: boolean
	// Include hour-angle×declination and altitude×declination cross terms.
	readonly includeCrossTerms?: boolean
	// Include pier-side terms (and pier-side×angle cross terms when cross terms are enabled).
	readonly includePierSideTerms?: boolean
	// Include normalized-angle polynomial terms.
	readonly includePolynomialTerms?: boolean
}

// Feature configuration with all flags resolved to concrete booleans.
export type ResolvedPointingFeatureConfiguration = Required<PointingFeatureConfiguration>

// A computed empirical feature row plus the context it was derived from.
export interface PointingFeatureVector {
	// Ordered feature names matching `values`.
	readonly names: readonly string[]
	// Feature values aligned with `names`.
	readonly values: Readonly<Float64Array>
	// Geometric context used to build the features.
	readonly context: PointingContext
}

// Default empirical feature set: all geometric terms on, polynomial terms off.
const DEFAULT_FEATURE_CONFIGURATION: ResolvedPointingFeatureConfiguration = {
	includeBias: true,
	includeHourAngleTerms: true,
	includeDeclinationTerms: true,
	includeAltitudeTerms: true,
	includeCrossTerms: true,
	includePierSideTerms: true,
	includePolynomialTerms: false,
}

// Observing context each empirical feature requires, keyed by feature name.
const EMPIRICAL_FEATURE_REQUIREMENTS: Readonly<Record<string, PointingContextRequirement>> = {
	bias: 'none',
	sinHA: 'hourAngle',
	cosHA: 'hourAngle',
	sinDec: 'none',
	cosDec: 'none',
	sinAlt: 'horizon',
	cosAlt: 'horizon',
	pierSide: 'none',
	'sinHA*sinDec': 'hourAngle',
	'sinHA*cosDec': 'hourAngle',
	'cosHA*sinDec': 'hourAngle',
	'cosHA*cosDec': 'hourAngle',
	'sinAlt*sinDec': 'horizon',
	'cosAlt*cosDec': 'horizon',
	'pierSide*sinHA': 'hourAngle',
	'pierSide*cosHA': 'hourAngle',
	'pierSide*sinDec': 'none',
	'pierSide*cosDec': 'none',
	normalizedHA: 'hourAngle',
	normalizedDec: 'none',
	'normalizedHA*normalizedDec': 'hourAngle',
}

// Reports the observing context a named empirical feature needs; unknown names are treated as the
// strictest requirement so an unrecognized term can never be silently zero-filled.
export function empiricalFeatureRequirement(name: string): PointingContextRequirement {
	return EMPIRICAL_FEATURE_REQUIREMENTS[name] ?? 'horizon'
}

// Reports the observing context actually available in a derived context.
export function availableContextRequirement(context: PointingContext): PointingContextRequirement {
	if (context.hourAngle === undefined) return 'none'
	return context.altitude === undefined || context.latitude === undefined ? 'hourAngle' : 'horizon'
}

// True when `available` satisfies everything `required` demands.
export function satisfiesContextRequirement(available: PointingContextRequirement, required: PointingContextRequirement) {
	if (required === 'none') return true
	if (required === 'hourAngle') return available !== 'none'
	return available === 'horizon'
}

// Normalizes the optional pier-side input to the three states the model distinguishes.
export function normalizePierSide(pierSide?: PierSide): PierSide {
	return pierSide === 'EAST' || pierSide === 'WEST' ? pierSide : 'NEITHER'
}

// Checks whether the provided value is a finite angular value.
function isFiniteAngle(value: number | undefined) {
	return value !== undefined && Number.isFinite(value)
}

// Extracts the geometric context needed by the empirical and semi-physical bases. Hour angle needs a
// time and a longitude; altitude and azimuth additionally need a latitude. Missing pieces stay
// `undefined` rather than defaulting, so callers can drop the terms that depend on them.
export function extractPointingContext(input: Readonly<PointingModelInput>): PointingContext {
	const pierSide = normalizePierSide(input.pierSide)
	const latitude = isFiniteAngle(input.latitude) ? input.latitude : undefined
	const longitude = isFiniteAngle(input.longitude) ? input.longitude : undefined

	let lst: Angle | undefined
	let hourAngle: Angle | undefined
	let azimuth: Angle | undefined
	let altitude: Angle | undefined

	if (input.time && longitude !== undefined) {
		lst = localSiderealTime(input.time, longitude, true)
		hourAngle = normalizePI(lst - input.rightAscension)
	}

	if (latitude !== undefined && lst !== undefined) {
		;[azimuth, altitude] = equatorialToHorizontal(input.rightAscension, input.declination, latitude, lst)
	}

	return { rightAscension: input.rightAscension, declination: input.declination, time: input.time, pierSide, pierSideValue: pierSide === 'EAST' ? 1 : pierSide === 'WEST' ? -1 : 0, lst, hourAngle, azimuth, altitude, latitude, longitude, frame: input.frame }
}

// Builds the semi-physical design columns for one sky position, writing the east contribution of
// each requested term into `dx` and the north contribution into `dy`.
//
// The columns are the canonical TPOINT equatorial terms, converted from TPOINT's (Δh, Δδ) form into
// this module's tangent-plane convention through `dx = -Δh·cos δ` and `dy = Δδ`:
//
//   CH  dx = -1                          dy = 0
//   IH  dx = -cos δ                      dy = 0
//   ID  dx = 0                           dy = 1
//   NP  dx = -sin δ                      dy = 0
//   MA  dx = sin δ·cos h                 dy = sin h
//   ME  dx = -sin δ·sin h                dy = cos h
//   TF  dx = -cos φ·sin h                dy = cos φ·sin δ·cos h - sin φ·cos δ
//
// TF is a horizon-referenced effect: the tube droops toward the zenith direction by `-cos a` in the
// horizontal tangent plane, which reaches the equatorial tangent plane rotated by the parallactic
// angle q. That rotation is folded in analytically through the identities
// `cos a·sin q = cos φ·sin h` and `cos a·cos q = sin φ·cos δ - cos φ·sin δ·cos h`, so no parallactic
// angle, altitude or division is evaluated and the term stays exact at the poles and at the zenith.
//
// Terms whose context is unavailable are written as zero; callers must drop such terms from the fit
// instead of relying on that, since a zeroed column aliases the constant term.
export function semiPhysicalBasis(context: PointingContext, terms: readonly SemiPhysicalTermName[], dx: Float64Array, dy: Float64Array) {
	const sinDec = Math.sin(context.declination)
	const cosDec = Math.cos(context.declination)
	const hasHourAngle = context.hourAngle !== undefined
	const hasLatitude = context.latitude !== undefined
	const hourAngle = context.hourAngle ?? 0
	const sinHa = Math.sin(hourAngle)
	const cosHa = Math.cos(hourAngle)
	const latitude = context.latitude ?? 0
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)

	for (let i = 0; i < terms.length; i++) {
		let x = 0
		let y = 0

		switch (terms[i]) {
			case 'CH':
				x = -1
				break
			case 'IH':
				x = -cosDec
				break
			case 'ID':
				y = 1
				break
			case 'NP':
				x = -sinDec
				break
			case 'MA':
				if (hasHourAngle) {
					x = sinDec * cosHa
					y = sinHa
				}
				break
			case 'ME':
				if (hasHourAngle) {
					x = -sinDec * sinHa
					y = cosHa
				}
				break
			case 'TF':
				if (hasHourAngle && hasLatitude) {
					x = -cosLat * sinHa
					y = cosLat * sinDec * cosHa - sinLat * cosDec
				}
				break
		}

		dx[i] = x
		dy[i] = y
	}
}

// Evaluates a semi-physical basis instance against fitted parameters.
export function evaluateSemiPhysicalBasis(parameters: Readonly<NumberArray>, dx: Readonly<NumberArray>, dy: Readonly<NumberArray>): PointingOffset {
	let x = 0
	let y = 0

	for (let i = 0; i < parameters.length; i++) {
		x += parameters[i] * dx[i]
		y += parameters[i] * dy[i]
	}

	return { dx: x, dy: y }
}

// Predicts the semi-physical offset for one sky position from the fitted shared parameters.
export function predictSemiPhysicalOffset(parameters: Readonly<NumberArray>, terms: readonly SemiPhysicalTermName[], context: PointingContext): PointingOffset {
	const dx = new Float64Array(terms.length)
	const dy = new Float64Array(terms.length)
	semiPhysicalBasis(context, terms, dx, dy)
	return evaluateSemiPhysicalBasis(parameters, dx, dy)
}

// Resolves the configured empirical feature flags.
export function resolveFeatureConfiguration(configuration: PointingFeatureConfiguration = {}): ResolvedPointingFeatureConfiguration {
	return {
		includeBias: configuration.includeBias ?? DEFAULT_FEATURE_CONFIGURATION.includeBias,
		includeHourAngleTerms: configuration.includeHourAngleTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeHourAngleTerms,
		includeDeclinationTerms: configuration.includeDeclinationTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeDeclinationTerms,
		includeAltitudeTerms: configuration.includeAltitudeTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeAltitudeTerms,
		includeCrossTerms: configuration.includeCrossTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeCrossTerms,
		includePierSideTerms: configuration.includePierSideTerms ?? DEFAULT_FEATURE_CONFIGURATION.includePierSideTerms,
		includePolynomialTerms: configuration.includePolynomialTerms ?? DEFAULT_FEATURE_CONFIGURATION.includePolynomialTerms,
	}
}

// Builds the deterministic empirical feature-name list for the configured model.
export function buildEmpiricalPointingFeatureNames(configuration: PointingFeatureConfiguration = {}): readonly string[] {
	const resolved = resolveFeatureConfiguration(configuration)
	const names: string[] = []

	if (resolved.includeBias) names.push('bias')
	if (resolved.includeHourAngleTerms) names.push('sinHA', 'cosHA')
	if (resolved.includeDeclinationTerms) names.push('sinDec', 'cosDec')
	if (resolved.includeAltitudeTerms) names.push('sinAlt', 'cosAlt')
	if (resolved.includePierSideTerms) names.push('pierSide')
	if (resolved.includeCrossTerms) {
		names.push('sinHA*sinDec', 'sinHA*cosDec', 'cosHA*sinDec', 'cosHA*cosDec')
		names.push('sinAlt*sinDec', 'cosAlt*cosDec')
		if (resolved.includePierSideTerms) names.push('pierSide*sinHA', 'pierSide*cosHA', 'pierSide*sinDec', 'pierSide*cosDec')
	}
	if (resolved.includePolynomialTerms) names.push('normalizedHA', 'normalizedDec', 'normalizedHA*normalizedDec')

	return names
}

// Writes the empirical feature values for an already-derived context into `values`, which must have
// room for every name produced by `buildEmpiricalPointingFeatureNames` for the same configuration.
// Splitting this from `extractEmpiricalPointingFeatures` lets fitting loops derive the context once
// per sample instead of recomputing sidereal time and horizontal coordinates per call.
//
// Features whose context is unavailable are written as zero; as with the semi-physical basis, the
// caller is responsible for dropping them from the fit rather than relying on that fallback.
export function featuresFromContext(context: PointingContext, configuration: ResolvedPointingFeatureConfiguration, values: Float64Array) {
	let index = 0

	const hasHourAngle = context.hourAngle !== undefined
	const hasAltitude = context.altitude !== undefined
	const hourAngle = context.hourAngle ?? 0
	const altitude = context.altitude ?? 0
	const normalizedHourAngle = hasHourAngle ? hourAngle / PI : 0
	const normalizedDeclination = context.declination / PIOVERTWO
	const sinHa = hasHourAngle ? Math.sin(hourAngle) : 0
	const cosHa = hasHourAngle ? Math.cos(hourAngle) : 0
	const sinDec = Math.sin(context.declination)
	const cosDec = Math.cos(context.declination)
	const sinAlt = hasAltitude ? Math.sin(altitude) : 0
	const cosAlt = hasAltitude ? Math.cos(altitude) : 0
	const pierSide = context.pierSideValue

	if (configuration.includeBias) values[index++] = 1

	if (configuration.includeHourAngleTerms) {
		values[index++] = sinHa
		values[index++] = cosHa
	}

	if (configuration.includeDeclinationTerms) {
		values[index++] = sinDec
		values[index++] = cosDec
	}

	if (configuration.includeAltitudeTerms) {
		values[index++] = sinAlt
		values[index++] = cosAlt
	}

	if (configuration.includePierSideTerms) values[index++] = pierSide

	if (configuration.includeCrossTerms) {
		values[index++] = sinHa * sinDec
		values[index++] = sinHa * cosDec
		values[index++] = cosHa * sinDec
		values[index++] = cosHa * cosDec
		values[index++] = sinAlt * sinDec
		values[index++] = cosAlt * cosDec

		if (configuration.includePierSideTerms) {
			values[index++] = pierSide * sinHa
			values[index++] = pierSide * cosHa
			values[index++] = pierSide * sinDec
			values[index++] = pierSide * cosDec
		}
	}

	if (configuration.includePolynomialTerms) {
		values[index++] = normalizedHourAngle
		values[index++] = normalizedDeclination
		values[index++] = normalizedHourAngle * normalizedDeclination
	}

	return index
}

// Extracts the configured empirical feature vector from the current sky position and mount state.
export function extractEmpiricalPointingFeatures(input: Readonly<PointingModelInput>, configuration: PointingFeatureConfiguration = {}): PointingFeatureVector {
	const resolved = resolveFeatureConfiguration(configuration)
	const context = extractPointingContext(input)
	const names = buildEmpiricalPointingFeatureNames(resolved)
	const values = new Float64Array(names.length)
	featuresFromContext(context, resolved, values)
	return { names, values, context }
}
