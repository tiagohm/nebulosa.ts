.PHONY: run lint prettier test compile astropy

run:
	bun .

lint:
	bun lint

prettier:
	bun prettier

test:
	bun test

astropy:
	python scripts/astropy/$(name).py

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif
