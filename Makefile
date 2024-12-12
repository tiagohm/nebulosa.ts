.PHONY: run lint test compile

run:
	bun .

lint:
	bun lint

test:
	bun test

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif
