import { $ } from 'bun'
import { basename, dirname, join } from 'path'
import { readCsv } from './csv'
import type { DetectedStar } from './stardetector'

export interface AstapStarDetectOptions {
	executable?: string
	minSNR?: number
	outputDirectory?: string
}

export async function astapStarDetect(input: string, options?: AstapStarDetectOptions): Promise<DetectedStar[]> {
	const cwd = options?.outputDirectory || dirname(input)
	const minSNR = options?.minSNR ?? 0
	const executable = options?.executable || defaultExecutableForPlatform()

	const { exitCode } = await $`${executable} -f ${input} -z 0 -extract ${minSNR}`.cwd(cwd).quiet().nothrow()

	if (exitCode === 0) {
		const file = Bun.file(`${join(cwd, basename(input, '.jpg'))}.csv`)
		const csv = readCsv(await file.text())

		if (csv.length > 1) {
			const stars = new Array<DetectedStar>(csv.length - 1)

			for (let i = 1; i < csv.length; i++) {
				const row = csv[i]
				const x = +row[0]
				const y = +row[1]
				const hfd = +row[2]
				const snr = +row[3]
				const flux = +row[4]

				stars[i - 1] = { x, y, hfd, snr, flux }
			}

			return stars
		}
	}

	return []
}

function defaultExecutableForPlatform() {
	switch (process.platform) {
		case 'win32':
			return 'C:\\Program Files\\astap\\astap.exe'
		default:
			return 'astap'
	}
}
