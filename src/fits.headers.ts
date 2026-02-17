export type FitsKeywordType = 'STRING' | 'INTEGER' | 'LOGICAL' | 'REAL' | 'NONE' | 'ANY'

export interface FitsKeyword {
	readonly type: FitsKeywordType
	readonly comment?: string
}

// https://github.com/nom-tam-fits/nom-tam-fits/blob/master/src/main/java/nom/tam/fits/header
// Unusual or deprecated keywords have been omitted

// FITS keywords currently defined in the FITS Standard: https://heasarc.gsfc.nasa.gov/docs/fcg/standard_dict.html
export const AUTHOR: FitsKeyword = { type: 'STRING', comment: 'Author name(s)' }
export const BITPIX: FitsKeyword = { type: 'INTEGER', comment: 'Bits per data element' }
export const BLANK: FitsKeyword = { type: 'INTEGER', comment: 'Value used for undefined array elements' }
export const BSCALE: FitsKeyword = { type: 'REAL', comment: 'Data quantization scaling' }
export const BUNIT: FitsKeyword = { type: 'STRING', comment: 'Data physical unit' }
export const BZERO: FitsKeyword = { type: 'REAL', comment: 'Data quantization offset' }
export const CDELT1: FitsKeyword = { type: 'REAL', comment: 'Coordinate spacing along axis' }
export const CDELT2: FitsKeyword = { type: 'REAL', comment: 'Coordinate spacing along axis' }
export const COMMENT: FitsKeyword = { type: 'NONE' }
export const CONTINUE: FitsKeyword = { type: 'NONE' }
export const CROTA1: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis rotation angle in deg' }
export const CROTA2: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis rotation angle in deg' }
export const CRPIX1: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis reference pixel' }
export const CRPIX2: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis reference pixel' }
export const CRVAL1: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis value at reference pixel' }
export const CRVAL2: FitsKeyword = { type: 'REAL', comment: 'Coordinate axis value at reference pixel' }
export const CTYPE1: FitsKeyword = { type: 'STRING', comment: 'Coordinate axis type / name' }
export const CTYPE2: FitsKeyword = { type: 'STRING', comment: 'Coordinate axis type / name' }
export const DATAMAX: FitsKeyword = { type: 'REAL', comment: 'Maximum data value' }
export const DATAMIN: FitsKeyword = { type: 'REAL', comment: 'Minimum data value' }
export const DATE: FitsKeyword = { type: 'STRING', comment: 'Date of file creation' }
export const END: FitsKeyword = { type: 'NONE' }
export const EQUINOX: FitsKeyword = { type: 'REAL', comment: 'Equinox of celestial coordinate system' }
export const EXTEND: FitsKeyword = { type: 'LOGICAL', comment: 'Allow extensions' }
export const EXTLEVEL: FitsKeyword = { type: 'INTEGER', comment: 'Hierarchical level of the extension' }
export const EXTNAME: FitsKeyword = { type: 'STRING', comment: 'HDU name' }
export const EXTVER: FitsKeyword = { type: 'INTEGER', comment: 'HDU version' }
export const HISTORY: FitsKeyword = { type: 'NONE', comment: 'Processing history of the data' }
export const INHERIT: FitsKeyword = { type: 'LOGICAL', comment: 'Inherit primary header entries' }
export const INSTRUME: FitsKeyword = { type: 'STRING', comment: 'Name of instrument' }
export const NAXIS: FitsKeyword = { type: 'INTEGER', comment: 'Number of axes' }
export const NAXIS1: FitsKeyword = { type: 'INTEGER', comment: 'Fastest changing axis' }
export const NAXIS2: FitsKeyword = { type: 'INTEGER', comment: 'Next to fastest changing axis' }
export const NAXIS3: FitsKeyword = { type: 'INTEGER', comment: 'Next to slowest changing axis' }
export const OBJECT: FitsKeyword = { type: 'STRING', comment: 'Name of observed object' }
export const OBSERVER: FitsKeyword = { type: 'STRING', comment: 'Observer(s) who acquired the data' }
export const RADESYS: FitsKeyword = { type: 'STRING', comment: 'Celestial coordinate reference frame' }
export const SIMPLE: FitsKeyword = { type: 'LOGICAL', comment: 'Primary HDU' }
export const TELESCOP: FitsKeyword = { type: 'STRING', comment: 'Name of telescope / observatory' }
export const XTENSION: FitsKeyword = { type: 'STRING', comment: 'HDU extension type' }

// FITS keywords that have been widely used within the astronomical community: https://heasarc.gsfc.nasa.gov/docs/fcg/common_dict.html

export const AIRMASS: FitsKeyword = { type: 'REAL', comment: 'Relative optical path length through atmosphere' }
export const DEC: FitsKeyword = { type: 'STRING', comment: 'Declination of the observed object' }
export const LATITUDE: FitsKeyword = { type: 'REAL', comment: 'Geographic latitude of the observation' }
export const MOONANGL: FitsKeyword = { type: 'REAL', comment: 'Angle between the observation and the moon' }
export const OBJNAME: FitsKeyword = { type: 'STRING', comment: 'AU name of observed object' }
export const ORIENTAT: FitsKeyword = { type: 'REAL', comment: 'Position angle of image y axis (deg. E of N)' }
export const PA_PNT: FitsKeyword = { type: 'REAL', comment: 'Position angle of the pointing' }
export const RA: FitsKeyword = { type: 'STRING', comment: 'Right Ascension of the observation' }
export const SUNANGLE: FitsKeyword = { type: 'REAL', comment: 'Angle between the observation and the sun' }

export const FILTER: FitsKeyword = { type: 'STRING', comment: 'Name of filter used during the observation' }

export const DATE_END: FitsKeyword = { type: 'STRING', comment: 'Date of the end of observation' }
export const EXPOSURE: FitsKeyword = { type: 'REAL', comment: 'Duration of exposure in seconds' }

// FITS keywords that may be added or read by MaxIm DL: https://cdn.diffractionlimited.com/help/maximdl/FITS_File_Header_Definitions.htm

export const APTDIA: FitsKeyword = { type: 'REAL', comment: 'Diameter of the telescope in mm' }
export const APTAREA: FitsKeyword = { type: 'REAL', comment: 'Aperture area of the telescope in mm²' }
export const BAYERPAT: FitsKeyword = { type: 'STRING', comment: 'Bayer color pattern' }
export const CBLACK: FitsKeyword = { type: 'REAL', comment: 'Indicates the black point used when displaying the image' }
export const CSTRETCH: FitsKeyword = { type: 'STRING', comment: 'Initial display screen stretch mode' }
export const CCD_TEMP: FitsKeyword = { type: 'REAL', comment: 'Actual measured sensor temperature at the start of exposure in deg C' }
export const COLORTYP: FitsKeyword = { type: 'REAL', comment: 'Type of color sensor Bayer array or zero for monochrome' }
export const CWHITE: FitsKeyword = { type: 'REAL', comment: 'Indicates the white point used when displaying the image' }
export const DATE_OBS: FitsKeyword = { type: 'STRING', comment: 'Date of observation in the ISO standard 8601 format' }
export const EXPTIME: FitsKeyword = { type: 'REAL', comment: 'Duration of exposure in seconds' }
export const DARKTIME: FitsKeyword = { type: 'REAL', comment: 'Dark current integration time' }
export const EGAIN: FitsKeyword = { type: 'REAL', comment: 'Electronic gain in photoelectrons per ADU' }
export const FOCALLEN: FitsKeyword = { type: 'REAL', comment: 'Focal length of the telescope in mm' }
export const FOCUSPOS: FitsKeyword = { type: 'REAL', comment: 'Focuser position in steps' }
export const FOCUSSSZ: FitsKeyword = { type: 'REAL', comment: 'Focuser step size in microns' }
export const FOCUSTEM: FitsKeyword = { type: 'REAL', comment: 'Focuser temperature readout in deg C' }
export const IMAGETYP: FitsKeyword = { type: 'STRING', comment: 'Type of image' }
export const INPUTFMT: FitsKeyword = { type: 'STRING', comment: 'Format of file from which image was read' }
export const ISOSPEED: FitsKeyword = { type: 'REAL', comment: 'ISO camera setting' }
export const JD: FitsKeyword = { type: 'REAL', comment: 'Records the geocentric Julian Day of the start of exposure' }
export const JD_HELIO: FitsKeyword = { type: 'REAL', comment: 'Records the Heliocentric Julian Date at the exposure midpoint' }
export const MIDPOINT: FitsKeyword = { type: 'STRING', comment: 'UT of midpoint of exposure' }
export const NOTES: FitsKeyword = { type: 'STRING', comment: 'User-entered information' }
export const OBJCTALT: FitsKeyword = { type: 'REAL', comment: 'Altitude of center of image in deg' }
export const OBJCTAZ: FitsKeyword = { type: 'REAL', comment: 'Azimuth of center of image in deg' }
export const OBJCTDEC: FitsKeyword = { type: 'STRING', comment: 'Declination of object being imaged' }
export const OBJCTHA: FitsKeyword = { type: 'STRING', comment: 'Hour angle of center of image' }
export const OBJCTRA: FitsKeyword = { type: 'STRING', comment: 'Right Ascension of object being imaged' }
export const PEDESTAL: FitsKeyword = { type: 'REAL', comment: 'Add this value to each pixel value to get a zero-based ADU' }
export const PIERSIDE: FitsKeyword = { type: 'STRING', comment: 'Indicates side-of-pier status when connected to a GEM' }
export const READOUTM: FitsKeyword = { type: 'STRING', comment: 'Records the selected Readout Mode for the camera' }
export const ROTATANG: FitsKeyword = { type: 'REAL', comment: 'Rotator angle in deg' }
export const ROWORDER: FitsKeyword = { type: 'STRING', comment: 'Pixel row readout order' }
export const SITELAT: FitsKeyword = { type: 'REAL', comment: 'Latitude at observing site in deg' }
export const SITELONG: FitsKeyword = { type: 'REAL', comment: 'Longitude at observing site in deg' }
export const XBAYROFF: FitsKeyword = { type: 'REAL', comment: 'X offset of Bayer array on imaging sensor' }
export const YBAYROFF: FitsKeyword = { type: 'REAL', comment: 'Y offset of Bayer array on imaging sensor' }
export const XBINNING: FitsKeyword = { type: 'REAL', comment: 'Binning factor used on X axis' }
export const XORGSUBF: FitsKeyword = { type: 'REAL', comment: 'Subframe origin on X axis' }
export const XPIXSZ: FitsKeyword = { type: 'REAL', comment: 'Physical X dimension of the sensor in microns' }
export const YBINNING: FitsKeyword = { type: 'REAL', comment: 'Binning factor used on Y axis' }
export const YORGSUBF: FitsKeyword = { type: 'REAL', comment: 'Subframe origin on Y axis' }
export const YPIXSZ: FitsKeyword = { type: 'REAL', comment: 'Physical Y dimension of the sensor in microns' }

// Other

export const FRAME: FitsKeyword = { type: 'STRING', comment: 'Type of image' }
export const GAIN: FitsKeyword = { type: 'REAL', comment: 'Amplifier gain in electrons per analog unit' }
export const OFFSET: FitsKeyword = { type: 'REAL', comment: 'Camera offset setting' }
export const PIXSIZE1: FitsKeyword = { type: 'REAL', comment: 'Unbinned X pixel size of the sensor in microns' }
export const PIXSIZE2: FitsKeyword = { type: 'REAL', comment: 'Unbinned Y pixel size of the sensor in microns' }
export const SITEELEV: FitsKeyword = { type: 'REAL', comment: 'Elevation at observing site in m' }

export const STANDARD_KEYWORDS = {
	AUTHOR,
	BITPIX,
	BLANK,
	BSCALE,
	BUNIT,
	BZERO,
	CDELT1,
	CDELT2,
	COMMENT,
	CONTINUE,
	CROTA1,
	CROTA2,
	CRPIX1,
	CRPIX2,
	CRVAL1,
	CRVAL2,
	CTYPE1,
	CTYPE2,
	DATAMAX,
	DATAMIN,
	DATE,
	END,
	EQUINOX,
	EXTEND,
	EXTLEVEL,
	EXTNAME,
	EXTVER,
	HISTORY,
	INHERIT,
	INSTRUME,
	NAXIS,
	NAXIS1,
	NAXIS2,
	NAXIS3,
	OBJECT,
	OBSERVER,
	RADESYS,
	SIMPLE,
	TELESCOP,
	XTENSION,
} as const

export const OBSERVATION_KEYWORDS = {
	AIRMASS,
	DEC,
	LATITUDE,
	MOONANGL,
	OBJNAME,
	ORIENTAT,
	PA_PNT,
	RA,
	SUNANGLE,
} as const

export const INSTRUMENT_KEYWORDS = {
	FILTER,
} as const

const MAXIMDL_KEYWORDS = {
	APTDIA,
	APTAREA,
	BAYERPAT,
	CBLACK,
	CSTRETCH,
	'CCD-TEMP': CCD_TEMP,
	COLORTYP,
	CWHITE,
	'DATE-OBS': DATE_OBS,
	EXPTIME,
	DARKTIME,
	EGAIN,
	FOCALLEN,
	FOCUSPOS,
	FOCUSSSZ,
	FOCUSTEM,
	IMAGETYP,
	INPUTFMT,
	ISOSPEED,
	JD,
	'JD-HELIO': JD_HELIO,
	MIDPOINT,
	NOTES,
	OBJCTALT,
	OBJCTAZ,
	OBJCTDEC,
	OBJCTHA,
	OBJCTRA,
	PEDESTAL,
	PIERSIDE,
	READOUTM,
	ROTATANG,
	ROWORDER,
	SITELAT,
	SITELONG,
	XBAYROFF,
	YBAYROFF,
	XBINNING,
	XORGSUBF,
	XPIXSZ,
	YBINNING,
	YORGSUBF,
	YPIXSZ,
}

export const DURATION_KEYWORDS = {
	'DATE-END': DATE_END,
	EXPOSURE,
} as const

export const OTHER_KEYWORDS = {
	FRAME,
	GAIN,
	OFFSET,
	PIXSIZE1,
	PIXSIZE2,
	SITEELEV,
} as const

export const KEYWORDS = { ...STANDARD_KEYWORDS, ...OBSERVATION_KEYWORDS, ...INSTRUMENT_KEYWORDS, ...MAXIMDL_KEYWORDS, ...DURATION_KEYWORDS, ...OTHER_KEYWORDS } as const

export type FitsKeywords = keyof typeof KEYWORDS
