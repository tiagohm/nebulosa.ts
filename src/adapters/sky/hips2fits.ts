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

// Coordinate system of the requested cutout.
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
	// Coordinate system of `ra`/`dec`.
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
}

// Extracts a FITS image from a HiPS given the output image pixel size,
// the center of projection, the type of projection and the field of view.
export async function hips2Fits(id: string, ra: Angle, dec: Angle, { width = 1200, height = 900, rotation = 0, fov = DEG2RAD, projection = 'TAN', coordSystem = 'icrs', format = 'fits', baseUrl = '', timeout = 60000 }: Hips2FitsOptions = {}) {
	const uri = `${baseUrl || HIPS2FITS_BASE_URL}hips-image-services/hips2fits?hips=${id}&ra=${toDeg(ra)}&dec=${toDeg(dec)}&width=${width}&height=${height}&projection=${projection}&fov=${toDeg(fov)}&coordsys=${coordSystem}&rotation_angle=${toDeg(rotation)}&format=${format}`
	const signal = AbortSignal.timeout(timeout)
	const response = await fetch(uri, { signal })
	return response.ok ? await response.blob() : undefined
}

// Fetches HiPS surveys with a minimum sky fraction.
export async function hipsSurveys(minSkyFraction: number = 0.99, baseUrl?: string) {
	const expr = encodeURIComponent(`ID=CDS* && hips_service_url*=*alasky* && dataproduct_type=image && moc_sky_fraction >= ${minSkyFraction} && obs_regime=Optical,Infrared,UV,Radio,X-ray,Gamma-ray && client_category=Image/*`)
	const uri = `${baseUrl || HIPS2FITS_BASE_URL}MocServer/query?get=record&fmt=json&expr=${expr}`
	const response = await fetch(uri)
	if (!response.ok) return []
	return mapHipsSurveys(await response.json())
}

// Maps raw MocServer survey records into typed HipsSurvey objects.
function mapHipsSurveys(survey: Record<string, unknown>[]) {
	return survey.map(
		(survey) =>
			<HipsSurvey>{
				id: survey.ID as string,
				category: survey.client_category as string,
				frame: survey.hips_frame as string,
				regime: (survey.obs_regime as string).toLowerCase() as never,
				bitpix: +(survey.hips_pixel_bitpix as string) || 0,
				pixelScale: +(survey.hips_pixel_scale as string),
				skyFraction: +(survey.moc_sky_fraction as string),
			},
	)
}
