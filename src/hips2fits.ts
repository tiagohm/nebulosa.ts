import { type Angle, toDeg } from './angle'
import { DEG2RAD } from './constants'
import type { BitpixOrZero } from './fits'

export const HIPS2FITS_BASE_URL = 'https://alasky.cds.unistra.fr/'

export type CoordinateFrameType = 'icrs' | 'galactic'

export type ImageFormatType = 'fits' | 'jpg' | 'png'

export type ProjectionType = 'AZP' | 'SZP' | 'TAN' | 'STG' | 'SIN' | 'ARC' | 'ZEA' | 'AIR' | 'CYP' | 'CEA' | 'CAR' | 'MER' | 'SFL' | 'PAR' | 'MOL' | 'AIT' | 'TSC' | 'CSC' | 'QSC' | 'HPX' | 'XPH'

export type HipsSurveyRegime = 'infrared' | 'uv' | 'radio' | 'optical' | 'gamma-ray' | 'x-ray'

export type HipsSurveyFrame = 'equatorial' | 'galactic'

export interface Hips2FitsOptions {
	baseUrl?: string
	width?: number
	height?: number
	rotation?: Angle
	fov?: Angle
	projection?: ProjectionType
	coordSystem?: CoordinateFrameType
	format?: ImageFormatType
	timeout?: number
}

export interface HipsSurvey {
	readonly id: string
	readonly category: string
	readonly frame: HipsSurveyFrame
	readonly regime: HipsSurveyRegime
	readonly bitpix: BitpixOrZero
	readonly pixelScale: number
	readonly skyFraction: number
}

// Extracts a FITS image from a HiPS given the output image pixel size,
// the center of projection, the type of projection and the field of view.
export async function hips2Fits(id: string, ra: Angle, dec: Angle, { width = 1200, height = 900, rotation = 0, fov = DEG2RAD, projection = 'TAN', coordSystem = 'icrs', format = 'fits', baseUrl = '', timeout = 60000 }: Hips2FitsOptions) {
	const uri = `${baseUrl || HIPS2FITS_BASE_URL}hips-image-services/hips2fits?hips=${id}&ra=${toDeg(ra)}&dec=${toDeg(dec)}&width=${width}&height=${height}&projection=${projection}&fov=${toDeg(fov)}&coordsys=${coordSystem}&rotation_angle=${toDeg(rotation)}&format=${format}`
	const signal = AbortSignal.timeout(timeout)
	return await fetch(uri, { signal }).then((res) => res.blob())
}

// Fetches HiPS surveys with a minimum sky fraction.
export async function hipsSurveys(minSkyFraction: number = 0.99, baseUrl?: string) {
	const expr = encodeURIComponent(`ID=CDS* && hips_service_url*=*alasky* && dataproduct_type=image && moc_sky_fraction >= ${minSkyFraction} && obs_regime=Optical,Infrared,UV,Radio,X-ray,Gamma-ray && client_category=Image/*`)
	const uri = `${baseUrl || HIPS2FITS_BASE_URL}MocServer/query?get=record&fmt=json&expr=${expr}`
	return await fetch(uri)
		.then((res) => res.json())
		.then(mapHipsSurveys)
}

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
