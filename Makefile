.PHONY: run lint format test astropy

run:
	bun .

lint:
	bun lint

format:
	bun format

test:
	bun test --timeout 1000

astropy:
	python scripts/$(name).py $(a)
