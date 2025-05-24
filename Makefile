.PHONY: run lint format test astro

run:
	bun .

lint:
	bun lint

format:
	bun format

test:
	bun test --timeout 1000

astro:
	uv run scripts/astro.py $(a)
