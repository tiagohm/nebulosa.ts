import { describe, expect, test } from 'bun:test'
import { exoplanetArchiveTransitEphemeris } from '../../../src/adapters/catalogs/exoplanet.archive'
import { ExoplanetArchiveTapError, exoplanetArchiveRows, exoplanetArchiveTapQuery } from '../../../src/adapters/catalogs/exoplanet.archive.tap'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { earth } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { exoplanetTransits } from '../../../src/astronomy/events/exoplanet'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { Timescale, timeNormalize, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC } from '../../../src/core/constants'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

const PS_HEADER = 'pl_name,ra,dec,pl_tranmid,pl_tranmiderr1,pl_tranmiderr2,pl_orbper,pl_orbpererr1,pl_orbpererr2,pl_trandur,pl_trandurerr1,pl_trandurerr2,pl_tsystemref'
const PSCOMPPARS_HEADER = 'pl_name,ra,dec,pl_tranmid,pl_tranmiderr1,pl_tranmiderr2,pl_orbper,pl_orbpererr1,pl_orbpererr2,pl_trandur,pl_trandurerr1,pl_trandurerr2,pl_tranmid_systemref'

// CSV of the archive `ps` solutions of WASP-12 b, as returned by /TAP/sync on 2026-10-15: strings are
// quoted and null columns are empty. The first row is the default solution (Leonardi et al. 2024).
const WASP12_DEFAULT = '"WASP-12 b",97.6366450,29.6722662,2457607.51930500,0.00003200,-0.00003200,1.09141890100,0.00000001800,-0.00000001800,3.0010000,0.0043000,-0.0043000,"BJD-TDB"'
const WASP12_BJD = '"WASP-12 b",97.6366450,29.6722662,2454508.97610000,0.00020000,-0.00020000,1.09142300000,0.00000300000,-0.00000300000,2.9280000,0.0240000,-0.0240000,"BJD"'
const WASP12_EMPTY = '"WASP-12 b",97.6366450,29.6722662,,,,1.09000000000,,,,,,'

// Runs callback with a local mock of the archive host; handler answers every request.
async function withArchive(handler: (request: Request) => Response | Promise<Response>, callback: (baseUrl: string, requests: URL[]) => Promise<void>) {
	const requests: URL[] = []
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			requests.push(new URL(request.url))
			return handler(request)
		},
	})

	try {
		await callback(`http://127.0.0.1:${server.port}/`, requests)
	} finally {
		await server.stop(true)
	}
}

// Runs callback with a mock that answers every request with the given CSV body.
function withCsv(body: string, callback: (baseUrl: string, requests: URL[]) => Promise<void>) {
	return withArchive(() => new Response(body, { headers: { 'content-type': 'text/plain' } }), callback)
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return error
	}

	throw new Error('expected a rejection')
}

async function tapError(promise: Promise<unknown>) {
	const error = await rejection(promise)
	expect(error).toBeInstanceOf(ExoplanetArchiveTapError)
	return error as ExoplanetArchiveTapError
}

describe('query construction', () => {
	test('a default ps lookup sends the fixed projection, default_flag, and csv format to /TAP/sync', async () => {
		await withCsv(`${PS_HEADER}\n${WASP12_DEFAULT}\n`, async (baseUrl, requests) => {
			const { rows, truncated } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'default', limit: 1 }, { baseUrl })

			expect(requests).toHaveLength(1)
			const [url] = requests
			expect(url.pathname).toBe('/TAP/sync')
			expect([...url.searchParams.keys()]).toEqual(['query', 'format'])
			expect(url.searchParams.get('format')).toBe('csv')
			expect(url.searchParams.get('query')).toBe(`SELECT TOP 2 ${PS_HEADER} FROM ps WHERE pl_name = 'WASP-12 b' AND default_flag = 1 ORDER BY pl_name, pl_refname`)

			expect(truncated).toBe(false)
			expect(rows).toEqual([
				{
					pl_name: 'WASP-12 b',
					ra: '97.6366450',
					dec: '29.6722662',
					pl_tranmid: '2457607.51930500',
					pl_tranmiderr1: '0.00003200',
					pl_tranmiderr2: '-0.00003200',
					pl_orbper: '1.09141890100',
					pl_orbpererr1: '0.00000001800',
					pl_orbpererr2: '-0.00000001800',
					pl_trandur: '3.0010000',
					pl_trandurerr1: '0.0043000',
					pl_trandurerr2: '-0.0043000',
					pl_tsystemref: 'BJD-TDB',
				},
			])
		})
	})

	test('an all-solutions ps lookup keeps every solution of the planet', async () => {
		await withCsv(`${PS_HEADER}\n${WASP12_EMPTY}\n${WASP12_BJD}\n${WASP12_DEFAULT}\n`, async (baseUrl, requests) => {
			const { rows, truncated } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'all', limit: 10 }, { baseUrl })

			const query = requests[0].searchParams.get('query')!
			expect(query).toBe(`SELECT TOP 11 ${PS_HEADER} FROM ps WHERE pl_name = 'WASP-12 b' ORDER BY pl_name, pl_refname`)
			expect(query).not.toContain('default_flag')

			expect(truncated).toBe(false)
			expect(rows.map((row) => row.pl_tranmid)).toEqual([null, '2454508.97610000', '2457607.51930500'])
			expect(rows.map((row) => row.pl_tsystemref)).toEqual([null, 'BJD', 'BJD-TDB'])
			expect(rows.map((row) => row.pl_orbper)).toEqual(['1.09000000000', '1.09142300000', '1.09141890100'])
		})
	})

	test('a pscomppars query selects pl_tranmid_systemref without solution filtering', async () => {
		const body = `${PSCOMPPARS_HEADER}\n"WASP-12 b",97.6366450,29.6722662,2457607.51930500,0.00003200,-0.00003200,1.09141890100,0.00000001800,-0.00000001800,3.0010000,0.0043000,-0.0043000,"BJD-TDB"\n`

		await withCsv(body, async (baseUrl, requests) => {
			const { rows } = await exoplanetArchiveRows({ table: 'pscomppars', hostName: 'WASP-12', limit: 5 }, { baseUrl })

			const query = requests[0].searchParams.get('query')!
			expect(query).toBe(`SELECT TOP 6 ${PSCOMPPARS_HEADER} FROM pscomppars WHERE hostname = 'WASP-12' ORDER BY pl_name`)
			expect(query).not.toContain('pl_tsystemref')
			expect(query).not.toContain('default_flag')

			expect(rows).toHaveLength(1)
			expect(rows[0].pl_tranmid_systemref).toBe('BJD-TDB')
			expect('pl_tsystemref' in rows[0]).toBe(false)
		})
	})

	test('names with apostrophes, plus signs, Unicode, and URL-sensitive characters are escaped', async () => {
		await withCsv(`${PS_HEADER}\n`, async (baseUrl, requests) => {
			const name = "O'Neil's + b & ç/%#?=é 🪐"
			await exoplanetArchiveRows({ table: 'ps', planetName: name, hostName: "x' OR '1'='1", solution: 'all', limit: 1 }, { baseUrl })

			const url = requests[0]
			// The raw query string carries no unescaped separators, and decoding restores the exact ADQL.
			expect(url.search).not.toContain('#')
			expect(url.search.split('&')).toHaveLength(2)
			expect(url.searchParams.get('query')).toBe(`SELECT TOP 2 ${PS_HEADER} FROM ps WHERE pl_name = 'O''Neil''s + b & ç/%#?=é 🪐' AND hostname = 'x'' OR ''1''=''1' ORDER BY pl_name, pl_refname`)
		})
	})

	test('a raw ADQL query is sent verbatim', async () => {
		await withCsv('pl_name\n"WASP-12 b"\n', async (baseUrl, requests) => {
			const result = await exoplanetArchiveTapQuery("select pl_name from ps where pl_name like 'WASP-12%'", { baseUrl })
			expect(requests[0].searchParams.get('query')).toBe("select pl_name from ps where pl_name like 'WASP-12%'")
			expect(result).toEqual({ columns: ['pl_name'], records: [{ pl_name: 'WASP-12 b' }] })
		})
	})
})

describe('CSV records', () => {
	test('quoted fields with commas, doubled quotes, and newlines round-trip', async () => {
		const body = `pl_name,pl_tranmid,note\n"Kepler-1, ""b""\nsecond line",2457607.5,"  #kept  "\n"#hash b",,\n`

		await withCsv(body, async (baseUrl) => {
			const { columns, records } = await exoplanetArchiveTapQuery('select 1', { baseUrl })
			expect(columns).toEqual(['pl_name', 'pl_tranmid', 'note'])
			expect(records).toEqual([
				{ pl_name: 'Kepler-1, "b"\nsecond line', pl_tranmid: '2457607.5', note: '  #kept  ' },
				{ pl_name: '#hash b', pl_tranmid: null, note: null },
			])
		})
	})

	test('an epoch keeps every decimal digit and converts to a two-part Julian Date', async () => {
		const row = WASP12_DEFAULT.replace('2457607.51930500', '2457607.519305123456789')

		await withCsv(`${PS_HEADER}\n${row}\n`, async (baseUrl) => {
			const { rows } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'default', limit: 1 }, { baseUrl })
			expect(rows[0].pl_tranmid).toBe('2457607.519305123456789')

			const result = exoplanetArchiveTransitEphemeris(rows[0])
			if (!result.success) throw new Error(result.reason)
			// Fractions above 0.5 are normalized onto the next day.
			expect(result.ephemeris.epoch.day).toBe(2457608)
			expect(result.ephemeris.epoch.fraction).toBe(0.519305123456789 - 1)
			expect(result.ephemeris.epoch.scale).toBe(Timescale.TDB)
		})
	})

	test('empty columns are null, zero stays zero, and unusable rows get the converter reason', async () => {
		const zero = '"Zero b",0,0,2457607.5,0,0,1.5,0,0,2,0,0,"BJD-TDB"'
		const noReference = WASP12_DEFAULT.replace('"BJD-TDB"', '')

		await withCsv(`${PS_HEADER}\n${zero}\n${WASP12_EMPTY}\n${noReference}\n`, async (baseUrl) => {
			const { rows } = await exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 10 }, { baseUrl })
			expect(rows).toHaveLength(3)

			expect(rows[0].ra).toBe('0')
			expect(rows[0].pl_tranmiderr1).toBe('0')
			const zeroResult = exoplanetArchiveTransitEphemeris(rows[0])
			if (!zeroResult.success) throw new Error(zeroResult.reason)
			expect(zeroResult.rightAscension).toBe(0)
			expect(zeroResult.ephemeris.epochUncertainty).toBe(0)

			expect(rows[1].pl_tranmid).toBeNull()
			expect(rows[1].pl_tsystemref).toBeNull()
			expect(exoplanetArchiveTransitEphemeris(rows[1])).toEqual({ success: false, reason: 'missingEpoch' })

			expect(rows[2].pl_tsystemref).toBeNull()
			expect(exoplanetArchiveTransitEphemeris(rows[2])).toEqual({ success: false, reason: 'missingTimeReference' })
		})
	})

	test('columns are matched by header name, not position', async () => {
		const header = 'pl_tsystemref,pl_trandurerr2,pl_trandurerr1,pl_trandur,pl_orbpererr2,pl_orbpererr1,pl_orbper,pl_tranmiderr2,pl_tranmiderr1,pl_tranmid,dec,ra,pl_name'
		const row = '"BJD-TDB",-0.0043000,0.0043000,3.0010000,-0.00000001800,0.00000001800,1.09141890100,-0.00003200,0.00003200,2457607.51930500,29.6722662,97.6366450,"WASP-12 b"'

		await withCsv(`${header}\n${row}\n`, async (baseUrl) => {
			const { rows } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'default', limit: 1 }, { baseUrl })
			expect(rows[0].pl_name).toBe('WASP-12 b')
			expect(rows[0].ra).toBe('97.6366450')
			expect(rows[0].pl_tranmid).toBe('2457607.51930500')
			expect(rows[0].pl_tsystemref).toBe('BJD-TDB')
		})
	})

	test('an empty selection with the expected header is an empty result', async () => {
		await withCsv(`${PS_HEADER}\n`, async (baseUrl) => {
			expect(await exoplanetArchiveRows({ table: 'ps', planetName: 'Nope b', solution: 'default', limit: 1 }, { baseUrl })).toEqual({ rows: [], truncated: false })
		})
	})

	test('malformed or mismatched CSV fails with kind format', async () => {
		const bodies = [
			'',
			'\n\n',
			// Wrong table: the composite reference column in a ps answer.
			`${PSCOMPPARS_HEADER}\n`,
			// Missing column.
			`${PS_HEADER.replace(',pl_tsystemref', '')}\n`,
			// Extra column.
			`${PS_HEADER},hostname\n`,
			// Duplicated column.
			`${PS_HEADER.replace('pl_tsystemref', 'pl_orbper')}\n`,
			// Short and long records.
			`${PS_HEADER}\n${WASP12_DEFAULT.replace(',"BJD-TDB"', '')}\n`,
			`${PS_HEADER}\n${WASP12_DEFAULT},extra\n`,
			// HTML instead of CSV.
			'<!DOCTYPE html><html><body>Maintenance</body></html>',
		]

		for (const body of bodies) {
			await withCsv(body, async (baseUrl) => {
				const error = await tapError(exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 1 }, { baseUrl }))
				expect(error.kind).toBe('format')
			})
		}
	})

	test('a body ending inside a quoted field is malformed, not a valid row', async () => {
		// Only the closing quote of "BJD-TDB" is missing, at EOF: the field count and numbers still look valid.
		const truncated = `${PS_HEADER}\n${WASP12_DEFAULT.slice(0, -1)}`

		await withCsv(truncated, async (baseUrl) => {
			const rows = await tapError(exoplanetArchiveRows({ table: 'ps', solution: 'default', limit: 1 }, { baseUrl }))
			expect(rows.kind).toBe('format')
			expect(rows.message).toContain('quoted field')

			const raw = await tapError(exoplanetArchiveTapQuery('select 1', { baseUrl }))
			expect(raw.kind).toBe('format')
		})

		// An unclosed quote in an earlier record swallows the rest of the body: up to EOF, or up to a later
		// quote that then leaves text before the next delimiter, which would otherwise yield a 13-field record.
		for (const tail of [WASP12_EMPTY.replace('"WASP-12 b"', 'WASP-12 b'), WASP12_BJD]) {
			await withCsv(`${PS_HEADER}\n"WASP-12 b,97.6366450\n${tail}\n`, async (baseUrl) => {
				expect((await tapError(exoplanetArchiveTapQuery('select 1', { baseUrl }))).kind).toBe('format')
			})
		}
	})
})

describe('failures', () => {
	test('HTTP failure statuses are errors, not empty results', async () => {
		for (const status of [400, 404, 500, 503]) {
			await withArchive(
				() => new Response('Service Unavailable', { status }),
				async (baseUrl) => {
					const error = await tapError(exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 1 }, { baseUrl }))
					expect(error.kind).toBe('http')
					expect(error.status).toBe(status)
					expect(error.message).toContain(`HTTP ${status}: Service Unavailable`)
				},
			)
		}
	})

	test('TAP error documents expose the service message', async () => {
		const votable = `<?xml version="1.0" encoding="UTF-8"?>\n<VOTABLE version="1.4" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">\n<RESOURCE type="results">\n<INFO name="QUERY_STATUS" value="ERROR">\nORA-00904: 'NOPE': invalid identifier\n</INFO>\n</RESOURCE>\n</VOTABLE>\n`

		await withArchive(
			() => new Response(votable, { status: 400, headers: { 'content-type': 'application/xml' } }),
			async (baseUrl) => {
				const error = await tapError(exoplanetArchiveTapQuery('select nope from ps', { baseUrl }))
				expect(error.kind).toBe('http')
				expect(error.status).toBe(400)
				expect(error.message).toContain("ORA-00904: 'NOPE': invalid identifier")
			},
		)

		// Some TAP services report query errors with a successful status.
		await withArchive(
			() => new Response(votable, { headers: { 'content-type': 'application/xml' } }),
			async (baseUrl) => {
				const error = await tapError(exoplanetArchiveTapQuery('select nope from ps', { baseUrl }))
				expect(error.kind).toBe('service')
				expect(error.status).toBe(200)
				expect(error.message).toContain('invalid identifier')
			},
		)

		// Single-quoted attributes in either order are recognized too.
		await withArchive(
			() => new Response(`<VOTABLE><RESOURCE><INFO value='ERROR' name='QUERY_STATUS'>table not found</INFO></RESOURCE></VOTABLE>`),
			async (baseUrl) => {
				const error = await tapError(exoplanetArchiveTapQuery('select 1 from nope', { baseUrl }))
				expect(error.kind).toBe('service')
				expect(error.message).toContain('table not found')
			},
		)
	})

	test('plain-text errors with a successful status are service errors, not empty results', async () => {
		for (const body of ['ORA-00904: invalid identifier\n', 'ERROR: invalid identifier', '  error : invalid identifier\n', 'QUERY_STATUS=ERROR invalid identifier\n']) {
			await withArchive(
				() => new Response(body, { headers: { 'content-type': 'text/plain' } }),
				async (baseUrl) => {
					const error = await tapError(exoplanetArchiveTapQuery('select invalid_field from ps', { baseUrl }))
					expect(error.kind).toBe('service')
					expect(error.status).toBe(200)
					expect(error.message).toContain('invalid identifier')
				},
			)
		}

		// Valid one-column CSV answers, including columns named like error words, stay results.
		for (const [body, columns] of [
			['pl_name\n', ['pl_name']],
			['error\n', ['error']],
			['error,ora\n', ['error', 'ora']],
			['error_flag\n', ['error_flag']],
		] as const) {
			await withCsv(body, async (baseUrl) => {
				expect(await exoplanetArchiveTapQuery('select 1', { baseUrl })).toEqual({ columns: [...columns], records: [] })
			})
		}
	})

	test('an unreachable host is a network error', async () => {
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
		const baseUrl = `http://127.0.0.1:${server.port}/`
		await server.stop(true)

		const error = await tapError(exoplanetArchiveTapQuery('select 1', { baseUrl, timeout: 5000 }))
		expect(error.kind).toBe('network')
		expect(error.cause).toBeDefined()
	})

	test('the timeout rejects a slow response with a TimeoutError', async () => {
		await withArchive(
			async () => {
				await Bun.sleep(2000)
				return new Response(`${PS_HEADER}\n`)
			},
			async (baseUrl) => {
				const start = performance.now()
				const error = await rejection(exoplanetArchiveTapQuery('select 1', { baseUrl, timeout: 50 }))
				expect((error as DOMException).name).toBe('TimeoutError')
				expect(performance.now() - start).toBeLessThan(1500)
			},
		)
	})

	test('a caller signal cancels before the request and during the response body', async () => {
		await withCsv(`${PS_HEADER}\n`, async (baseUrl, requests) => {
			const controller = new AbortController()
			const reason = new Error('cancelled by caller')
			controller.abort(reason)
			expect(await rejection(exoplanetArchiveTapQuery('select 1', { baseUrl, signal: controller.signal }))).toBe(reason)
			expect(requests).toHaveLength(0)
		})

		let release: (() => void) | undefined

		await withArchive(
			() => {
				// Sends the header, then stalls the body until the test ends.
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`${PS_HEADER}\n`))
					},
					pull: () =>
						new Promise<void>((resolve) => {
							release = resolve
						}),
				})
				return new Response(body, { headers: { 'content-type': 'text/plain' } })
			},
			async (baseUrl) => {
				const controller = new AbortController()
				const reason = new Error('cancelled mid-body')
				const promise = exoplanetArchiveTapQuery('select 1', { baseUrl, signal: controller.signal, timeout: 0 })
				setTimeout(() => controller.abort(reason), 100)
				expect(await rejection(promise)).toBe(reason)
				release?.()
			},
		)
	})

	test('the timeout stays active while a caller signal is given', async () => {
		await withArchive(
			async () => {
				await Bun.sleep(2000)
				return new Response('')
			},
			async (baseUrl) => {
				const controller = new AbortController()
				const error = await rejection(exoplanetArchiveTapQuery('select 1', { baseUrl, signal: controller.signal, timeout: 50 }))
				expect((error as DOMException).name).toBe('TimeoutError')
				expect(controller.signal.aborted).toBe(false)
			},
		)
	})
})

describe('bounds', () => {
	test('exactly limit rows are complete, limit + 1 rows report truncation', async () => {
		await withCsv(`${PS_HEADER}\n${WASP12_DEFAULT}\n${WASP12_BJD}\n`, async (baseUrl, requests) => {
			const exact = await exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 2 }, { baseUrl })
			expect(requests[0].searchParams.get('query')).toStartWith('SELECT TOP 3 ')
			expect(exact.truncated).toBe(false)
			expect(exact.rows).toHaveLength(2)

			const truncated = await exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 1 }, { baseUrl })
			expect(truncated.truncated).toBe(true)
			expect(truncated.rows).toHaveLength(1)
			expect(truncated.rows[0].pl_tranmid).toBe('2457607.51930500')
		})
	})

	test('a server ignoring TOP still yields at most limit rows', async () => {
		await withCsv(`${PS_HEADER}\n${WASP12_DEFAULT}\n${WASP12_BJD}\n${WASP12_EMPTY}\n${WASP12_DEFAULT}\n`, async (baseUrl) => {
			const { rows, truncated } = await exoplanetArchiveRows({ table: 'ps', solution: 'all', limit: 2 }, { baseUrl })
			expect(truncated).toBe(true)
			expect(rows).toHaveLength(2)
		})
	})

	test('a body over maxResponseBytes fails with kind size', async () => {
		const body = `${PS_HEADER}\n${`${WASP12_DEFAULT}\n`.repeat(100)}`

		// A declared Content-Length is checked before reading.
		await withCsv(body, async (baseUrl) => {
			const error = await tapError(exoplanetArchiveTapQuery('select 1', { baseUrl, maxResponseBytes: 1024 }))
			expect(error.kind).toBe('size')
			expect(error.status).toBe(200)
		})

		// A streamed body without a length is counted while it arrives.
		await withArchive(
			() => {
				const bytes = new TextEncoder().encode(body)
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (let i = 0; i < bytes.length; i += 256) controller.enqueue(bytes.subarray(i, i + 256))
						controller.close()
					},
				})
				return new Response(stream)
			},
			async (baseUrl) => {
				const error = await tapError(exoplanetArchiveTapQuery('select 1', { baseUrl, maxResponseBytes: 1024 }))
				expect(error.kind).toBe('size')
				expect((await exoplanetArchiveTapQuery('select 1', { baseUrl, maxResponseBytes: body.length })).records).toHaveLength(100)
			},
		)
	})
})

test('a fetched row drives exoplanetTransits through the archive converter', async () => {
	await withCsv(`${PS_HEADER}\n${WASP12_DEFAULT}\n`, async (baseUrl) => {
		const { rows } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'default', limit: 1 }, { baseUrl })
		const result = exoplanetArchiveTransitEphemeris(rows[0])
		if (!result.success) throw new Error(result.reason)

		const { ephemeris, rightAscension, declination } = result
		expect(result.name).toBe('WASP-12 b')
		expect(result.timeReferenceSource).toBe('pl_tsystemref')
		expect(result.assumedScale).toBe(false)
		expect(ephemeris.reference).toBe('barycentric')
		expect(ephemeris.epoch.scale).toBe(Timescale.TDB)
		expect(ephemeris.epoch.day).toBe(2457608)
		expect(ephemeris.epoch.fraction).toBe(0.519305 - 1)
		expect(ephemeris.period).toBe(1.091418901)
		expect(ephemeris.duration).toBeCloseTo(3.001 / 24, 15)
		expect(ephemeris.durationUncertainty).toBeCloseTo(0.0043 / 24, 18)
		expect(rightAscension).toBeCloseTo(deg(97.636645), 15)
		expect(declination).toBeCloseTo(deg(29.6722662), 15)

		const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84)
		const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH), earth)
		const observer = composeEphemerisPaths(earthPath, earthObserverEphemerisPath(site, customEphemerisEndpoint('la-silla')))
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const { events } = exoplanetTransits(ephemeris, eraS2c(rightAscension!, declination!), observer, site, start, timeShift(start, 1))

		expect(events).toHaveLength(1)
		const [event] = events
		expect(event.cycle).toBe(3414)
		expect(event.center.scale).toBe(Timescale.TDB)
		const expected = timeNormalize(2457607, 0.519305 + 3414 * 1.091418901, 0, Timescale.TDB)
		expect(timeSubtract(event.center, expected) * DAYSEC).toBeCloseTo(0, 4)
		expect(timeSubtract(event.egress, event.ingress) * DAYSEC).toBeCloseTo(3.001 * 3600, 4)
		expect(event.observedCenter.scale).toBe(Timescale.UTC)
	})
})

test.skipIf(SKIP)(
	'live archive returns the default WASP-12 b solution',
	async () => {
		const { rows, truncated } = await exoplanetArchiveRows({ table: 'ps', planetName: 'WASP-12 b', solution: 'default', limit: 1 })
		expect(truncated).toBe(false)
		expect(rows).toHaveLength(1)
		expect(rows[0].pl_name).toBe('WASP-12 b')
		expect(typeof rows[0].pl_tranmid).toBe('string')

		const composite = await exoplanetArchiveRows({ table: 'pscomppars', planetName: 'WASP-12 b', limit: 1 })
		expect(composite.rows).toHaveLength(1)
		expect(composite.rows[0].pl_tranmid_systemref).not.toBeUndefined()
		expect(exoplanetArchiveTransitEphemeris(composite.rows[0]).success).toBe(true)
	},
	120000,
)
