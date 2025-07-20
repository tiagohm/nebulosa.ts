import { readCsv, TSV_DELIMITER } from './csv'

// https://simbad.cds.unistra.fr/simbad/sim-tap/

export const SIMBAD_URL = 'https://simbad.cds.unistra.fr/'
export const SIMBAD_ALTERNATIVE_URL = 'https://simbad.u-strasbg.fr/'

const SIMBAD_QUERY_PATH = 'simbad/sim-tap/sync'

export interface SimbadQueryOptions extends Omit<RequestInit, 'method' | 'body'> {
	baseUrl?: string
	timeout?: number
}

export async function simbadQuery(query: string, { baseUrl, timeout = 60000, signal, ...options }: SimbadQueryOptions = {}): Promise<string[][] | undefined> {
	const uri = `${baseUrl || SIMBAD_URL}${SIMBAD_QUERY_PATH}`

	const body = new FormData()
	body.append('request', 'doQuery')
	body.append('lang', 'adql')
	body.append('format', 'tsv')
	body.append('query', query)

	const response = await fetch(uri, { method: 'POST', body, signal: signal ?? AbortSignal.timeout(timeout), ...options })
	if (response.status >= 300) return undefined
	const text = await response.text()
	return readCsv(text, TSV_DELIMITER)
}

// https://vizier.cds.unistra.fr/cgi-bin/OType

export const SIMBAD_OBJECT_TYPES = {
	ACTIVE_GALAXY_NUCLEUS: { id: 200, description: 'Active Galaxy Nucleus', classification: 'GALAXY', codes: ['AGN', 'AG?'] },
	ALPHA2_CVN_VARIABLE: { id: 0, description: 'alpha2 CVn Variable', classification: 'STAR', codes: ['a2*', 'a2?'] },
	ASSOCIATION_OF_STARS: { id: 100, description: 'Association of Stars', classification: 'SET_OF_STARS', codes: ['As*', 'As?'] },
	ASYMPTOTIC_GIANT_BRANCH_STAR: { id: 1, description: 'Asymptotic Giant Branch Star', classification: 'STAR', codes: ['AB*', 'AB?'] },
	BETA_CEP_VARIABLE: { id: 2, description: 'beta Cep Variable', classification: 'STAR', codes: ['bC*', 'bC?'] },
	BE_STAR: { id: 3, description: 'Be Star', classification: 'STAR', codes: ['Be*', 'Be?'] },
	BLACK_HOLE: { id: 600, description: 'Black Hole', classification: 'GRAVITATION', codes: ['BH', 'BH?'] },
	BLAZAR: { id: 201, description: 'Blazar', classification: 'GALAXY', codes: ['Bla', 'Bz?'] },
	BLUE_COMPACT_GALAXY: { id: 202, description: 'Blue Compact Galaxy', classification: 'GALAXY', codes: ['bCG'] },
	BLUE_OBJECT: { id: 500, description: 'Blue Object', classification: 'SPECTRAL', codes: ['blu'] },
	BLUE_STRAGGLER: { id: 4, description: 'Blue Straggler', classification: 'STAR', codes: ['BS*', 'BS?'] },
	BLUE_SUPERGIANT: { id: 5, description: 'Blue Supergiant', classification: 'STAR', codes: ['s*b', 's?b'] },
	BL_LAC: { id: 203, description: 'BL Lac', classification: 'GALAXY', codes: ['BLL', 'BL?'] },
	BRIGHTEST_GALAXY_IN_A_CLUSTER_BCG: { id: 204, description: 'Brightest Galaxy in a Cluster (BCG)', classification: 'GALAXY', codes: ['BiC'] },
	BROWN_DWARF: { id: 6, description: 'Brown Dwarf', classification: 'STAR', codes: ['BD*', 'BD?'] },
	BUBBLE: { id: 400, description: 'Bubble', classification: 'INTERSTELLAR_MEDIUM', codes: ['bub'] },
	BY_DRA_VARIABLE: { id: 7, description: 'BY Dra Variable', classification: 'STAR', codes: ['BY*', 'BY?'] },
	CARBON_STAR: { id: 8, description: 'Carbon Star', classification: 'STAR', codes: ['C*', 'C*?'] },
	CATACLYSMIC_BINARY: { id: 9, description: 'Cataclysmic Binary', classification: 'STAR', codes: ['CV*', 'CV?'] },
	CENTIMETRIC_RADIO_SOURCE: { id: 501, description: 'Centimetric Radio Source', classification: 'SPECTRAL', codes: ['cm'] },
	CEPHEID_VARIABLE: { id: 10, description: 'Cepheid Variable', classification: 'STAR', codes: ['Ce*', 'Ce?'] },
	CHEMICALLY_PECULIAR_STAR: { id: 11, description: 'Chemically Peculiar Star', classification: 'STAR', codes: ['Pe*', 'Pe?'] },
	CLASSICAL_CEPHEID_VARIABLE: { id: 12, description: 'Classical Cepheid Variable', classification: 'STAR', codes: ['cC*'] },
	CLASSICAL_NOVA: { id: 13, description: 'Classical Nova', classification: 'STAR', codes: ['No*', 'No?'] },
	CLOUD: { id: 401, description: 'Cloud', classification: 'INTERSTELLAR_MEDIUM', codes: ['Cld'] },
	CLUSTER_OF_GALAXIES: { id: 300, description: 'Cluster of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['ClG', 'C?G'] },
	CLUSTER_OF_STARS: { id: 101, description: 'Cluster of Stars', classification: 'SET_OF_STARS', codes: ['Cl*', 'Cl?', 'C?*'] },
	COMETARY_GLOBULE_PILLAR: { id: 402, description: 'Cometary Globule / Pillar', classification: 'INTERSTELLAR_MEDIUM', codes: ['CGb'] },
	COMPACT_GROUP_OF_GALAXIES: { id: 301, description: 'Compact Group of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['CGG'] },
	COMPOSITE_OBJECT_BLEND: { id: 700, description: 'Composite Object, Blend', classification: 'OTHER', codes: ['mul'] },
	DARK_CLOUD_NEBULA: { id: 403, description: 'Dark Cloud (nebula)', classification: 'INTERSTELLAR_MEDIUM', codes: ['DNe'] },
	DELTA_SCT_VARIABLE: { id: 14, description: 'delta Sct Variable', classification: 'STAR', codes: ['dS*'] },
	DENSE_CORE: { id: 404, description: 'Dense Core', classification: 'INTERSTELLAR_MEDIUM', codes: ['cor'] },
	DOUBLE_OR_MULTIPLE_STAR: { id: 15, description: 'Double or Multiple Star', classification: 'STAR', codes: ['**', '**?'] },
	ECLIPSING_BINARY: { id: 16, description: 'Eclipsing Binary', classification: 'STAR', codes: ['EB*', 'EB?'] },
	ELLIPSOIDAL_VARIABLE: { id: 17, description: 'Ellipsoidal Variable', classification: 'STAR', codes: ['El*', 'El?'] },
	EMISSION_LINE_GALAXY: { id: 205, description: 'Emission-line galaxy', classification: 'GALAXY', codes: ['EmG'] },
	EMISSION_LINE_STAR: { id: 18, description: 'Emission-line Star', classification: 'STAR', codes: ['Em*'] },
	EMISSION_OBJECT: { id: 502, description: 'Emission Object', classification: 'SPECTRAL', codes: ['EmO'] },
	ERUPTIVE_VARIABLE: { id: 19, description: 'Eruptive Variable', classification: 'STAR', codes: ['Er*', 'Er?'] },
	EVOLVED_STAR: { id: 20, description: 'Evolved Star', classification: 'STAR', codes: ['Ev*', 'Ev?'] },
	EVOLVED_SUPERGIANT: { id: 21, description: 'Evolved Supergiant', classification: 'STAR', codes: ['sg*', 'sg?'] },
	EXTRA_SOLAR_PLANET: { id: 22, description: 'Extra-solar Planet', classification: 'STAR', codes: ['Pl', 'Pl?'] },
	FAR_IR_SOURCE_30_M: { id: 503, description: 'Far-IR source (λ >= 30 µm)', classification: 'SPECTRAL', codes: ['FIR'] },
	GALAXY: { id: 206, description: 'Galaxy', classification: 'GALAXY', codes: ['G', 'G?'] },
	GALAXY_IN_PAIR_OF_GALAXIES: { id: 207, description: 'Galaxy in Pair of Galaxies', classification: 'GALAXY', codes: ['GiP'] },
	GALAXY_TOWARDS_A_CLUSTER_OF_GALAXIES: { id: 208, description: 'Galaxy towards a Cluster of Galaxies', classification: 'GALAXY', codes: ['GiC'] },
	GALAXY_TOWARDS_A_GROUP_OF_GALAXIES: { id: 209, description: 'Galaxy towards a Group of Galaxies', classification: 'GALAXY', codes: ['GiG'] },
	GAMMA_DOR_VARIABLE: { id: 23, description: 'gamma Dor Variable', classification: 'STAR', codes: ['gD*'] },
	GAMMA_RAY_BURST: { id: 504, description: 'Gamma-ray Burst', classification: 'SPECTRAL', codes: ['gB'] },
	GAMMA_RAY_SOURCE: { id: 505, description: 'Gamma-ray Source', classification: 'SPECTRAL', codes: ['gam'] },
	GLOBULAR_CLUSTER: { id: 102, description: 'Globular Cluster', classification: 'SET_OF_STARS', codes: ['GlC', 'Gl?'] },
	GLOBULE_LOW_MASS_DARK_CLOUD: { id: 405, description: 'Globule (low-mass dark cloud)', classification: 'INTERSTELLAR_MEDIUM', codes: ['glb'] },
	GRAVITATIONALLY_LENSED_IMAGE: { id: 601, description: 'Gravitationally Lensed Image', classification: 'GRAVITATION', codes: ['LeI', 'LI?'] },
	GRAVITATIONALLY_LENSED_IMAGE_OF_A_GALAXY: { id: 602, description: 'Gravitationally Lensed Image of a Galaxy', classification: 'GRAVITATION', codes: ['LeG'] },
	GRAVITATIONALLY_LENSED_IMAGE_OF_A_QUASAR: { id: 603, description: 'Gravitationally Lensed Image of a Quasar', classification: 'GRAVITATION', codes: ['LeQ'] },
	GRAVITATIONAL_LENS: { id: 604, description: 'Gravitational Lens', classification: 'GRAVITATION', codes: ['gLe', 'Le?'] },
	GRAVITATIONAL_LENS_SYSTEM_LENS_IMAGES: { id: 605, description: 'Gravitational Lens System (lens+images)', classification: 'GRAVITATION', codes: ['gLS', 'LS?'] },
	GRAVITATIONAL_SOURCE: { id: 606, description: 'Gravitational Source', classification: 'GRAVITATION', codes: ['grv'] },
	GRAVITATIONAL_WAVE_EVENT: { id: 607, description: 'Gravitational Wave Event', classification: 'GRAVITATION', codes: ['GWE'] },
	GROUP_OF_GALAXIES: { id: 302, description: 'Group of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['GrG', 'Gr?'] },
	HERBIG_AE_BE_STAR: { id: 24, description: 'Herbig Ae/Be Star', classification: 'STAR', codes: ['Ae*', 'Ae?'] },
	HERBIG_HARO_OBJECT: { id: 25, description: 'Herbig-Haro Object', classification: 'STAR', codes: ['HH'] },
	HIGH_MASS_X_RAY_BINARY: { id: 26, description: 'High Mass X-ray Binary', classification: 'STAR', codes: ['HXB', 'HX?'] },
	HIGH_PROPER_MOTION_STAR: { id: 27, description: 'High Proper Motion Star', classification: 'STAR', codes: ['PM*'] },
	HIGH_VELOCITY_CLOUD: { id: 406, description: 'High-velocity Cloud', classification: 'INTERSTELLAR_MEDIUM', codes: ['HVC'] },
	HIGH_VELOCITY_STAR: { id: 28, description: 'High Velocity Star', classification: 'STAR', codes: ['HV*'] },
	HII_GALAXY: { id: 210, description: 'HII Galaxy', classification: 'GALAXY', codes: ['H2G'] },
	HII_REGION: { id: 407, description: 'HII Region', classification: 'INTERSTELLAR_MEDIUM', codes: ['HII'] },
	HI_21CM_SOURCE: { id: 506, description: 'HI (21cm) Source', classification: 'SPECTRAL', codes: ['HI'] },
	HORIZONTAL_BRANCH_STAR: { id: 29, description: 'Horizontal Branch Star', classification: 'STAR', codes: ['HB*', 'HB?'] },
	HOT_SUBDWARF: { id: 30, description: 'Hot Subdwarf', classification: 'STAR', codes: ['HS*', 'HS?'] },
	INFRA_RED_SOURCE: { id: 507, description: 'Infra-Red Source', classification: 'SPECTRAL', codes: ['IR'] },
	INTERACTING_GALAXIES: { id: 303, description: 'Interacting Galaxies', classification: 'SET_OF_GALAXIES', codes: ['IG'] },
	INTERSTELLAR_FILAMENT: { id: 408, description: 'Interstellar Filament', classification: 'INTERSTELLAR_MEDIUM', codes: ['flt'] },
	INTERSTELLAR_MEDIUM_OBJECT: { id: 409, description: 'Interstellar Medium Object', classification: 'INTERSTELLAR_MEDIUM', codes: ['ISM'] },
	INTERSTELLAR_SHELL: { id: 410, description: 'Interstellar Shell', classification: 'INTERSTELLAR_MEDIUM', codes: ['sh'] },
	IRREGULAR_VARIABLE: { id: 31, description: 'Irregular Variable', classification: 'STAR', codes: ['Ir*'] },
	LINER_TYPE_ACTIVE_GALAXY_NUCLEUS: { id: 211, description: 'LINER-type Active Galaxy Nucleus', classification: 'GALAXY', codes: ['LIN'] },
	LONG_PERIOD_VARIABLE: { id: 32, description: 'Long-Period Variable', classification: 'STAR', codes: ['LP*', 'LP?'] },
	LOW_MASS_STAR: { id: 33, description: 'Low-mass Star', classification: 'STAR', codes: ['LM*', 'LM?'] },
	LOW_MASS_X_RAY_BINARY: { id: 34, description: 'Low Mass X-ray Binary', classification: 'STAR', codes: ['LXB', 'LX?'] },
	LOW_SURFACE_BRIGHTNESS_GALAXY: { id: 212, description: 'Low Surface Brightness Galaxy', classification: 'GALAXY', codes: ['LSB'] },
	MAIN_SEQUENCE_STAR: { id: 35, description: 'Main Sequence Star', classification: 'STAR', codes: ['MS*', 'MS?'] },
	MASER: { id: 508, description: 'Maser', classification: 'SPECTRAL', codes: ['Mas'] },
	MASSIVE_STAR: { id: 36, description: 'Massive Star', classification: 'STAR', codes: ['Ma*', 'Ma?'] },
	METRIC_RADIO_SOURCE: { id: 509, description: 'Metric Radio Source', classification: 'SPECTRAL', codes: ['mR'] },
	MICRO_LENSING_EVENT: { id: 608, description: '(Micro)Lensing Event', classification: 'GRAVITATION', codes: ['Lev'] },
	MID_IR_SOURCE_3_TO_30_M: { id: 510, description: 'Mid-IR Source (3 to 30 µm)', classification: 'SPECTRAL', codes: ['MIR'] },
	MILLIMETRIC_RADIO_SOURCE: { id: 511, description: 'Millimetric Radio Source', classification: 'SPECTRAL', codes: ['mm'] },
	MIRA_VARIABLE: { id: 37, description: 'Mira Variable', classification: 'STAR', codes: ['Mi*', 'Mi?'] },
	MOLECULAR_CLOUD: { id: 411, description: 'Molecular Cloud', classification: 'INTERSTELLAR_MEDIUM', codes: ['MoC'] },
	MOVING_GROUP: { id: 103, description: 'Moving Group', classification: 'SET_OF_STARS', codes: ['MGr'] },
	NEAR_IR_SOURCE_3_M: { id: 512, description: 'Near-IR Source (λ < 3 µm)', classification: 'SPECTRAL', codes: ['NIR'] },
	NEBULA: { id: 412, description: 'Nebula', classification: 'INTERSTELLAR_MEDIUM', codes: ['GNe'] },
	NEUTRON_STAR: { id: 38, description: 'Neutron Star', classification: 'STAR', codes: ['N*', 'N*?'] },
	NOT_AN_OBJECT_ERROR_ARTEFACT: { id: 701, description: 'Not an Object (Error, Artefact, ...)', classification: 'OTHER', codes: ['err'] },
	OBJECT_OF_UNKNOWN_NATURE: { id: 702, description: 'Object of Unknown Nature', classification: 'OTHER', codes: ['?'] },
	OH_IR_STAR: { id: 39, description: 'OH/IR Star', classification: 'STAR', codes: ['OH*', 'OH?'] },
	OPEN_CLUSTER: { id: 104, description: 'Open Cluster', classification: 'SET_OF_STARS', codes: ['OpC'] },
	OPTICAL_SOURCE: { id: 513, description: 'Optical Source', classification: 'SPECTRAL', codes: ['Opt'] },
	ORION_VARIABLE: { id: 40, description: 'Orion Variable', classification: 'STAR', codes: ['Or*'] },
	OUTFLOW: { id: 41, description: 'Outflow', classification: 'STAR', codes: ['out', 'of?'] },
	PAIR_OF_GALAXIES: { id: 304, description: 'Pair of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['PaG'] },
	PART_OF_A_GALAXY: { id: 703, description: 'Part of a Galaxy', classification: 'OTHER', codes: ['PoG'] },
	PART_OF_CLOUD: { id: 704, description: 'Part of Cloud', classification: 'OTHER', codes: ['PoC'] },
	PLANETARY_NEBULA: { id: 42, description: 'Planetary Nebula', classification: 'STAR', codes: ['PN', 'PN?'] },
	POST_AGB_STAR: { id: 43, description: 'Post-AGB Star', classification: 'STAR', codes: ['pA*', 'pA?'] },
	PROTO_CLUSTER_OF_GALAXIES: { id: 305, description: 'Proto Cluster of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['PCG'] },
	PULSAR: { id: 44, description: 'Pulsar', classification: 'STAR', codes: ['Psr'] },
	PULSATING_VARIABLE: { id: 45, description: 'Pulsating Variable', classification: 'STAR', codes: ['Pu*', 'Pu?'] },
	QUASAR: { id: 213, description: 'Quasar', classification: 'GALAXY', codes: ['QSO', 'Q?'] },
	RADIO_BURST: { id: 514, description: 'Radio Burst', classification: 'SPECTRAL', codes: ['rB'] },
	RADIO_GALAXY: { id: 214, description: 'Radio Galaxy', classification: 'GALAXY', codes: ['rG'] },
	RADIO_SOURCE: { id: 515, description: 'Radio Source', classification: 'SPECTRAL', codes: ['Rad'] },
	RED_GIANT_BRANCH_STAR: { id: 46, description: 'Red Giant Branch star', classification: 'STAR', codes: ['RG*', 'RB?'] },
	RED_SUPERGIANT: { id: 47, description: 'Red Supergiant', classification: 'STAR', codes: ['s*r', 's?r'] },
	REFLECTION_NEBULA: { id: 413, description: 'Reflection Nebula', classification: 'INTERSTELLAR_MEDIUM', codes: ['RNe'] },
	REGION_DEFINED_IN_THE_SKY: { id: 705, description: 'Region defined in the Sky', classification: 'OTHER', codes: ['reg'] },
	ROTATING_VARIABLE: { id: 48, description: 'Rotating Variable', classification: 'STAR', codes: ['Ro*', 'Ro?'] },
	RR_LYRAE_VARIABLE: { id: 49, description: 'RR Lyrae Variable', classification: 'STAR', codes: ['RR*', 'RR?'] },
	RS_CVN_VARIABLE: { id: 50, description: 'RS CVn Variable', classification: 'STAR', codes: ['RS*', 'RS?'] },
	RV_TAURI_VARIABLE: { id: 51, description: 'RV Tauri Variable', classification: 'STAR', codes: ['RV*', 'RV?'] },
	R_CRB_VARIABLE: { id: 52, description: 'R CrB Variable', classification: 'STAR', codes: ['RC*', 'RC?'] },
	SEYFERT_1_GALAXY: { id: 215, description: 'Seyfert 1 Galaxy', classification: 'GALAXY', codes: ['Sy1'] },
	SEYFERT_2_GALAXY: { id: 216, description: 'Seyfert 2 Galaxy', classification: 'GALAXY', codes: ['Sy2'] },
	SEYFERT_GALAXY: { id: 217, description: 'Seyfert Galaxy', classification: 'GALAXY', codes: ['SyG'] },
	SPECTROSCOPIC_BINARY: { id: 53, description: 'Spectroscopic Binary', classification: 'STAR', codes: ['SB*', 'SB?'] },
	STAR: { id: 54, description: 'Star', classification: 'STAR', codes: ['*'] },
	STARBURST_GALAXY: { id: 218, description: 'Starburst Galaxy', classification: 'GALAXY', codes: ['SBG'] },
	STAR_FORMING_REGION: { id: 414, description: 'Star Forming Region', classification: 'INTERSTELLAR_MEDIUM', codes: ['SFR'] },
	STELLAR_STREAM: { id: 105, description: 'Stellar Stream', classification: 'SET_OF_STARS', codes: ['St*'] },
	SUB_MILLIMETRIC_SOURCE: { id: 516, description: 'Sub-Millimetric Source', classification: 'SPECTRAL', codes: ['smm'] },
	SUPERCLUSTER_OF_GALAXIES: { id: 306, description: 'Supercluster of Galaxies', classification: 'SET_OF_GALAXIES', codes: ['SCG', 'SC?'] },
	SUPERNOVA: { id: 55, description: 'SuperNova', classification: 'STAR', codes: ['SN*', 'SN?'] },
	SUPERNOVA_REMNANT: { id: 415, description: 'SuperNova Remnant', classification: 'INTERSTELLAR_MEDIUM', codes: ['SNR', 'SR?'] },
	SX_PHE_VARIABLE: { id: 56, description: 'SX Phe Variable', classification: 'STAR', codes: ['SX*'] },
	SYMBIOTIC_STAR: { id: 57, description: 'Symbiotic Star', classification: 'STAR', codes: ['Sy*', 'Sy?'] },
	S_STAR: { id: 58, description: 'S Star', classification: 'STAR', codes: ['S*', 'S*?'] },
	TRANSIENT_EVENT: { id: 517, description: 'Transient Event', classification: 'SPECTRAL', codes: ['ev'] },
	TYPE_II_CEPHEID_VARIABLE: { id: 59, description: 'Type II Cepheid Variable', classification: 'STAR', codes: ['WV*', 'WV?'] },
	T_TAURI_STAR: { id: 60, description: 'T Tauri Star', classification: 'STAR', codes: ['TT*', 'TT?'] },
	ULTRA_LUMINOUS_X_RAY_SOURCE: { id: 518, description: 'Ultra-luminous X-ray Source', classification: 'SPECTRAL', codes: ['ULX', 'UX?'] },
	UNDERDENSE_REGION_OF_THE_UNIVERSE: { id: 307, description: 'Underdense Region of the Universe', classification: 'SET_OF_GALAXIES', codes: ['vid'] },
	UV_EMISSION_SOURCE: { id: 519, description: 'UV-emission Source', classification: 'SPECTRAL', codes: ['UV'] },
	VARIABLE_STAR: { id: 61, description: 'Variable Star', classification: 'STAR', codes: ['V*', 'V*?'] },
	VARIABLE_SOURCE: { id: 520, description: 'Variable Source', classification: 'SPECTRAL', codes: ['var'] },
	WHITE_DWARF: { id: 62, description: 'White Dwarf', classification: 'STAR', codes: ['WD*', 'WD?'] },
	WOLF_RAYET: { id: 63, description: 'Wolf-Rayet', classification: 'STAR', codes: ['WR*', 'WR?'] },
	X_RAY_BINARY: { id: 64, description: 'X-ray Binary', classification: 'STAR', codes: ['XB*', 'XB?'] },
	X_RAY_SOURCE: { id: 521, description: 'X-ray Source', classification: 'SPECTRAL', codes: ['X'] },
	YELLOW_SUPERGIANT: { id: 65, description: 'Yellow Supergiant', classification: 'STAR', codes: ['s*y', 's?y'] },
	YOUNG_STELLAR_OBJECT: { id: 66, description: 'Young Stellar Object', classification: 'STAR', codes: ['Y*O', 'Y*?'] },
} as const

// STAR: 000 - 099
// SET_OF_STARS: 100 - 199
// GALAXY: 200 - 299
// SET_OF_GALAXIES: 300 - 399
// INTERSTELLAR_MEDIUM: 400 - 499
// SPECTRAL: 500 - 599
// GRAVITATION: 600 - 699
// OTHER: 700 - 799

export type SimbadObjectType = keyof typeof SIMBAD_OBJECT_TYPES

export type SimbadObjectClassification = (typeof SIMBAD_OBJECT_TYPES)[SimbadObjectType]['classification']

export type SimbadObjectCode = (typeof SIMBAD_OBJECT_TYPES)[SimbadObjectType]['codes'][number]

export interface SimbadObjectTypeInfo {
	readonly id: number
	readonly description: string
	readonly classification: SimbadObjectClassification
	readonly codes: readonly SimbadObjectCode[]
}

export function findSimbadObjectTypeInfoById(id: number): SimbadObjectTypeInfo | undefined {
	return Object.values(SIMBAD_OBJECT_TYPES).find((info) => info.id === id)
}

export function findSimbadObjectTypeInfoByCode(code: SimbadObjectCode): SimbadObjectTypeInfo | undefined {
	return Object.values(SIMBAD_OBJECT_TYPES).find((info) => info.codes.includes(code as never))
}
