.PHONY: run test compile

run:
	bun .

test:
	bun test

ifeq ($(OS),Windows_NT)
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa.exe
else
compile:
	bun build --compile --minify --bytecode . --outfile nebulosa
endif
