import { $ } from 'bun'
import os from 'os'
import { join } from 'path'
import { type Angle, normalize, toDeg, toHour } from './angle'
import type { FitsHeader } from './fits'
import { solutionFrom } from './platesolver'
import { isValidHeaderKey } from './wcs'

export interface AstapPlateSolveOptions {
	fov?: Angle
	ra?: Angle
	dec?: Angle
	radius?: Angle
	downsample?: number
	timeout?: number
}

export async function astapSolve(executable: string, path: string, options?: AstapPlateSolveOptions) {
	const fov = Math.max(0, Math.min(toDeg(options?.fov ?? 0), 360))
	const z = options?.downsample ?? 0
	const o = join(os.tmpdir(), `astap.${Date.now()}.ini`)
	const r = options?.radius ? Math.max(0, Math.min(Math.ceil(toDeg(options.radius)), 180)) : 0
	const ra = options?.ra ? toHour(normalize(options.ra)) : 0
	const spd = options?.dec ? toDeg(options.dec) + 90 : 90
	const c = r ? `-ra ${ra} -spd ${spd} -r ${r}` : '-r 180'

	const header: FitsHeader = {}

	const { exitCode } = await $`${executable} -o ${o} -z ${z} -fov ${fov} ${{ raw: c }} -f ${path}`.quiet().nothrow()

	if (exitCode === 0) {
		const text = await Bun.file(o).text()
		const lines = text.split('\n').map((e) => e.split('='))

		for (const line of lines) {
			const [key, value] = line

			if (isValidHeaderKey(key)) {
				header[key] = parseFloat(value.trim())
			} else if (key === 'DIMENSIONS') {
				const [width, height] = value.split('x')
				header.NAXIS1 = parseInt(width.trim())
				header.NAXIS2 = parseInt(height.trim())
			}
		}
	}

	return solutionFrom(header)
}
