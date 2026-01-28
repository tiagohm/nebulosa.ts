import { PHD2Client, type PHD2ClientHandler } from '../src/phd2'

const handler: PHD2ClientHandler = {
	event: (client, event) => {
		console.info(event)
	},
	command: (client, command, success, result) => {
		console.info(command, success, result)
	},
}

const client = new PHD2Client({ handler })
await client.connect('localhost')
