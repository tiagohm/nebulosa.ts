import { DEG2RAD } from '../../core/constants'
import type { BitpixOrZero } from '../../io/formats/fits/fits'
import { type Angle, toDeg } from '../../math/units/angle'

// Client for the CDS hips2fits service: extracts a cutout image (FITS/JPG/PNG) from a Hierarchical
// Progressive Survey (HiPS) for a given center, field of view, and projection, and lists available
// HiPS surveys. Angles are radians on the API surface and converted to degrees in the request URLs.

// https://www.ivoa.net/documents/HiPS/20170406/PR-HIPS-1.0-20170406.pdf

// Primary hips2fits/MocServer host.
export const HIPS2FITS_BASE_URL = 'https://alasky.cds.unistra.fr/'
// Mirror host used as a fallback.
export const HIPS2FITS_ALTERNATIVE_URL = 'http://alaskybis.cds.unistra.fr/'

// Coordinate frame of the output WCS projection.
export type CoordinateFrameType = 'icrs' | 'galactic'

// Output image encoding.
export type ImageFormatType = 'fits' | 'jpg' | 'png'

// WCS projection code for the cutout.
export type ProjectionType = 'AZP' | 'SZP' | 'TAN' | 'STG' | 'SIN' | 'ARC' | 'ZEA' | 'AIR' | 'CYP' | 'CEA' | 'CAR' | 'MER' | 'SFL' | 'PAR' | 'MOL' | 'AIT' | 'TSC' | 'CSC' | 'QSC' | 'HPX' | 'XPH'

// Observational wavelength regime of a survey.
export type HipsSurveyRegime = 'infrared' | 'uv' | 'radio' | 'optical' | 'gamma-ray' | 'x-ray'

// Native sky frame of a survey.
export type HipsSurveyFrame = 'equatorial' | 'galactic'

// Options for a hips2fits cutout request.
export interface Hips2FitsOptions {
	// Override host base URL.
	baseUrl?: string
	// Output width, pixels.
	width?: number
	// Output height, pixels.
	height?: number
	// Image rotation angle, radians.
	rotation?: Angle
	// Field of view, radians.
	fov?: Angle
	// WCS projection.
	projection?: ProjectionType
	// Output WCS coordinate frame; the `ra`/`dec` center remains ICRS.
	coordSystem?: CoordinateFrameType
	// Output format.
	format?: ImageFormatType
	// Request timeout, milliseconds.
	timeout?: number
}

// Metadata describing one HiPS survey.
export interface HipsSurvey {
	// Survey identifier.
	readonly id: string
	// Client category path.
	readonly category: string
	// Native sky frame.
	readonly frame: HipsSurveyFrame
	// Wavelength regime.
	readonly regime: HipsSurveyRegime
	// Pixel BITPIX (0 when unknown).
	readonly bitpix: BitpixOrZero
	// Native pixel scale, degrees/pixel.
	readonly pixelScale: number
	// Fraction of the sky covered, 0..1.
	readonly skyFraction: number
	// Title of the survey for people, when the record gives one.
	readonly title?: string
	// Copyright or acknowledgment the survey's publisher asks for, when the record gives one.
	readonly copyright?: string
	// Page of that copyright or acknowledgment, when the record gives one.
	readonly copyrightUrl?: string
}

// URL of a hips2fits cutout of the survey id centered on the ICRS ra and dec (radians), with the
// options of hips2Fits and their defaults (1200 × 900 px, 1° field, no rotation, TAN, ICRS, FITS);
// a timeout does not enter the URL.
export function hips2FitsUrl(id: string, ra: Angle, dec: Angle, { width = 1200, height = 900, rotation = 0, fov = DEG2RAD, projection = 'TAN', coordSystem = 'icrs', format = 'fits', baseUrl = '' }: Hips2FitsOptions = {}) {
	return `${baseUrl || HIPS2FITS_BASE_URL}hips-image-services/hips2fits?hips=${encodeURIComponent(id)}&ra=${toDeg(ra)}&dec=${toDeg(dec)}&width=${width}&height=${height}&projection=${projection}&fov=${toDeg(fov)}&coordsys=${coordSystem}&rotation_angle=${toDeg(rotation)}&format=${format}`
}

// Extracts a FITS image from a HiPS given the output image pixel size,
// the center of projection, the type of projection and the field of view.
export async function hips2Fits(id: string, ra: Angle, dec: Angle, options: Hips2FitsOptions = {}) {
	const signal = AbortSignal.timeout(options.timeout ?? 60000)
	const response = await fetch(hips2FitsUrl(id, ra, dec, options), { signal })
	return response.ok ? await response.blob() : undefined
}

// URL of the MocServer query listing the CDS image surveys served by alasky that cover at least
// minSkyFraction (0..1) of the sky, as JSON records.
export function hipsSurveysUrl(minSkyFraction: number = 0.99, baseUrl?: string) {
	const expr = encodeURIComponent(`ID=CDS* && hips_service_url*=*alasky* && dataproduct_type=image && moc_sky_fraction >= ${minSkyFraction} && obs_regime=Optical,Infrared,UV,Radio,X-ray,Gamma-ray && client_category=Image/*`)
	return `${baseUrl || HIPS2FITS_BASE_URL}MocServer/query?get=record&fmt=json&expr=${expr}`
}

// Fetches HiPS surveys with a minimum sky fraction.
export async function hipsSurveys(minSkyFraction: number = 0.99, baseUrl?: string) {
	const response = await fetch(hipsSurveysUrl(minSkyFraction, baseUrl))
	if (!response.ok) return []
	return parseHipsSurveys(await response.json())
}

// Maps the raw MocServer records of hipsSurveysUrl into typed HipsSurvey objects; a title or
// copyright the record does not give is left out.
export function parseHipsSurveys(records: readonly Record<string, unknown>[]): HipsSurvey[] {
	return records.map((record) => {
		const survey: { -readonly [K in keyof HipsSurvey]: HipsSurvey[K] } = {
			id: record.ID as string,
			category: record.client_category as string,
			frame: record.hips_frame as HipsSurveyFrame,
			regime: (record.obs_regime as string).toLowerCase() as HipsSurveyRegime,
			bitpix: +(record.hips_pixel_bitpix as string) || 0,
			pixelScale: +(record.hips_pixel_scale as string),
			skyFraction: +(record.moc_sky_fraction as string),
		}

		if (typeof record.obs_title === 'string' && record.obs_title) survey.title = record.obs_title
		if (typeof record.obs_copyright === 'string' && record.obs_copyright) survey.copyright = record.obs_copyright
		if (typeof record.obs_copyright_url === 'string' && record.obs_copyright_url) survey.copyrightUrl = record.obs_copyright_url
		return survey
	})
}
