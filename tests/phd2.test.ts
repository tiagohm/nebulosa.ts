import { test } from 'bun:test'
import { Phd2Client } from '../src/phd2'

test.skip('client', async () => {
	const client = new Phd2Client({
		handler: {
			event: (_, event) => {
				console.info(event)
			},
		},
	})

	await client.connect('0.0.0.0')

	await Bun.sleep(1000)

	await client.findStar()
}, 5000)
