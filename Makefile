.PHONY: run lint prettier test compile astro

run:
	bun .

lint:
	bun lint

prettier:
	bun prettier

test:
	bun test --timeout 1000

astro:
	python scripts/$(name).py $(a)

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif
