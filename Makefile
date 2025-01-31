.PHONY: run lint format test compile astropy

run:
	bun .

lint:
	bun lint

format:
	bun format

test:
	bun test --timeout 1000

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif

astropy:
	python scripts/$(name).py $(a)
