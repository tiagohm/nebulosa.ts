export async function* arrayBufferToLines(buffer: AllowSharedBufferSource, charset: string = 'utf-8') {
	const decoder = new TextDecoder(charset)
	const stream = new ReadableStream<AllowSharedBufferSource>({
		start(controller) {
			controller.enqueue(buffer)
			controller.close()
		},
	})

	const reader = stream.getReader()
	let { value, done } = await reader.read()

	let line = ''

	while (!done) {
		// Decode incrementally
		line = decoder.decode(value, { stream: true })

		// Split by newline
		const parts = line.split('\n')

		// Store all complete lines
		for (let i = 0; i < parts.length - 1; i++) {
			if (parts[i]) {
				yield parts[i]
			}
		}

		// Keep the remainder (last part) for the next chunk
		line = parts[parts.length - 1]

		// Read the next chunk
		;({ value, done } = await reader.read())
	}

	if (line) {
		yield line
	}
}

export async function* readableStreamToLines(stream: ReadableStream<Uint8Array>, charset: string = 'utf-8') {
	const decoder = new TextDecoder(charset)

	let line = ''

	for await (const chunk of stream) {
		// Decode incrementally
		line = decoder.decode(chunk, { stream: true })

		// Split by newline
		const parts = line.split('\n')

		// Store all complete lines
		for (let i = 0; i < parts.length - 1; i++) {
			if (parts[i]) {
				yield parts[i]
			}
		}

		// Keep the remainder (last part) for the next chunk
		line = parts[parts.length - 1]
	}

	if (line) {
		yield line
	}
}
