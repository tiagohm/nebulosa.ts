.PHONY: run lint prettier test compile astropy skyfield

run:
	bun .

lint:
	bun lint

prettier:
	bun prettier

test:
	bun test --timeout 1000

astropy:
	python scripts/astropy/$(name).py $(a)

skyfield:
	python scripts/skyfield/$(name).py $(a)

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif
