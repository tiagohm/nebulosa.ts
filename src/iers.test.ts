import { test } from 'bun:test'
import { iersa, iersb } from './iers'

test('iersA', async () => {
	await iersa.load(await Bun.file('data/finals2000A.txt').arrayBuffer())
})

test('iersB', async () => {
	await iersb.load(await Bun.file('data/eopc04.1962-now.txt').arrayBuffer())
})
