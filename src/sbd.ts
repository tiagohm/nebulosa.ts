export const MAIN_URL = 'https://ssd-api.jpl.nasa.gov/'

const SEARCH_PATH = 'sbdb.api?alt-des=1&alt-orbits=1&ca-data=1&ca-time=both&ca-tunc=both&cd-epoch=1&cd-tp=1&discovery=1&full-prec=1&nv-fmt=both&orbit-defs=1&phys-par=1&r-notes=1&r-observer=1&radar-obs=1&sat=1&vi-data=1&www=1'

export type SmallBodySearch =
	| {
			readonly object: {
				readonly orbit_id: string
				readonly orbit_class: {
					readonly name: string
					readonly code: string
				}
				readonly neo: boolean
				readonly pha: boolean
				readonly des_alt: string[]
				readonly kind: 'an' | 'au' | 'cn' | 'cu'
				readonly fullname: string
				readonly shortname: string
				readonly prefix: string
				readonly des: string
				readonly spkid: string
			}
			readonly orbit: {
				readonly first_obs: string
				readonly pe_used: string
				// readonly two_body: string
				readonly equinox: string
				readonly cov_epoch: string
				readonly last_obs: string
				readonly soln_date: string
				readonly n_del_obs_used: number | null
				readonly t_jup: string
				readonly epoch: string
				readonly comment: string | null
				readonly rms: string
				readonly n_dop_obs_used: number | null
				readonly orbit_id: string
				readonly moid_jup: string
				readonly n_obs_used: number
				readonly not_valid_after: string | null
				readonly data_arc: string
				readonly producer: string
				readonly moid: string
				readonly sb_used: string
				readonly source: string
				readonly epoch_cd: string
				readonly elements: {
					readonly sigma: string | null
					readonly title: string
					readonly name: string
					readonly units: string | null
					readonly value: string | null
					readonly label: string
				}[]
			}
			readonly signature: {
				readonly version: string
				readonly source: string
			}
			readonly phys_par: {
				readonly desc: string
				readonly value: string
				readonly notes: string
				readonly ref: string
				readonly title: string
				readonly sigma: string
				readonly units: string | null
				readonly name: string
			}[]
	  }
	| {
			readonly list: {
				readonly pdes: string
				readonly name: string
			}[]
	  }
	| {
			readonly message: string
	  }

export async function search(text: string) {
	const uri = `${MAIN_URL}${SEARCH_PATH}&sstr=${encodeURIComponent(text)}`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodySearch
}
