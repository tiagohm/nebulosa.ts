import fs from 'fs/promises'
import { iersb } from '../src/iers'
import { fileHandleSource } from '../src/io'
import { download } from './download'

Bun.dns.prefetch('github.com')

// IERS

await download('eopc04.1962-now.txt')

try {
	if (await fs.exists('data/eopc04.1962-now.txt')) {
		const handle = await fs.open('data/eopc04.1962-now.txt')
		await using source = fileHandleSource(handle)
		source.seek(4640029)
		await iersb.load(source)
	}
} catch (e) {
	console.info('failed to download eopc04.1962-now.txt')
}
