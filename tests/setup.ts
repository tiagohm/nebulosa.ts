import fs from 'fs/promises'
import { iersb } from '../src/iers'
import { fileHandleSource } from '../src/io'
import { download } from './download'

Bun.dns.prefetch('github.com')

// IERS

try {
	await download('eopc04.1962-now.txt')

	try {
		await fs.access('data/eopc04.1962-now.txt')
		const handle = await fs.open('data/eopc04.1962-now.txt')
		await using source = fileHandleSource(handle)
		source.seek(4640029)
		await iersb.load(source)
	} catch (e) {
		console.error('failed to load eopc04.1962-now.txt', e)
	}
} catch (e) {
	console.error('failed to download eopc04.1962-now.txt', e)
}
