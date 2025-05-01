.PHONY: run lint format test

run:
	bun .

lint:
	bun lint

format:
	bun format

test:
	bun test --timeout 1000
