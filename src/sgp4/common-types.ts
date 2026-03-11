import type { Angle } from '../angle'

// A set of "singly averaged mean elements" that describe shape of the
// satellite?s orbit at the propagation date. They are averaged
// with respect to the mean anomaly and include the effects of secular
// gravity, atmospheric drag, and - in Deep Space mode - of those
// pertubations from the Sun and Moon that SGP4 averages over an entire
// revolution of each of those bodies. They omit both the shorter-term
// and longer-term periodic pertubations from the Sun and Moon that
// SGP4 applies right before computing each position.
export interface MeanElements {
	readonly am: number // Average semi-major axis (earth radii).
	readonly em: number // Average eccentricity.
	readonly im: Angle // Average inclination.
	readonly Om: Angle // Average right ascension of ascending node.
	readonly om: Angle // Average argument of perigee.
	readonly mm: Angle // Average mean anomaly.
	readonly nm: Angle // Average mean motion (radians/minute).
}

// This is the base interface for the OMM JSON object as specified in Orbit Data Messages
// recommended standard, version 3.0.
// Note that this is not a 1:1 mapping. Only the fields that are necessary to propagate
// a satellite orbit are made required. For example, CCSDS_OMM_VERS is required by the spec,
// but is not present in Celestrak OMM output, and is not required to propagate the satellite,
// so it is made optional here.
// Numeric fields may be represented as strings or numbers in the original json, depending on
// the source. This is because the spec doesn't specify the type, and different sources use
// different types: at the time of writing, Celestrak uses numbers, while SpaceTrack uses strings.
export interface OMMJsonObject {
	CCSDS_OMM_VERS?: `3.${string}`
	COMMENT?: string
	CLASSIFICATION?: string
	OBJECT_NAME: string
	OBJECT_ID: string
	CENTER_NAME?: 'EARTH'
	REF_FRAME?: 'TEME'
	REF_FRAME_EPOCH?: string
	TIME_SYSTEM?: 'UTC'
	MEAN_ELEMENT_THEORY?: 'SGP4'
	CREATION_DATE?: string
	ORIGINATOR?: string
	EPOCH: string
	MEAN_MOTION: string | number
	ECCENTRICITY: string | number
	INCLINATION: number | string
	RA_OF_ASC_NODE: number | string
	ARG_OF_PERICENTER: number | string
	MEAN_ANOMALY: number | string
	EPHEMERIS_TYPE?: 0 | '0'
	CLASSIFICATION_TYPE?: 'U' | 'C'
	NORAD_CAT_ID: string | number
	ELEMENT_SET_NO: string | number
	REV_AT_EPOCH?: string | number
	BSTAR: string | number
	MEAN_MOTION_DOT: string | number
	MEAN_MOTION_DDOT: string | number
	[key: string]: unknown // This handles additional metadata, such as OBJECT_TYPE, COUNTRY_CODE etc
}

export type SupportedOMMVersion = NonNullable<OMMJsonObject['CCSDS_OMM_VERS']>
