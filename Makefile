.PHONY: build test integration-test lint check dev-env clean

BINARY := bin/vh
BUNDLE := dist/vh.js
DEV_DIR := .dev
VH_HOME := $(DEV_DIR)/vh

build:
	npx esbuild src/cli/main.ts \
		--bundle \
		--platform=node \
		--target=node22 \
		--format=esm \
		--outfile=$(BUNDLE) \
		--external:better-sqlite3 \
		--banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
	@mkdir -p bin
	@printf '#!/usr/bin/env node\n' > $(BINARY)
	@cat $(BUNDLE) >> $(BINARY)
	@chmod +x $(BINARY)

test:
	npx vitest run

integration-test:
	npx vitest run --config vitest.integration.config.ts

lint:
	npx eslint src/

check: lint test build

dev-env: build
	@mkdir -p $(VH_HOME)
	@echo "Dev environment ready."
	@echo "  export VH_HOME=$$(pwd)/$(VH_HOME)"
	@echo "  ./$(BINARY) new --name test --prompt 'hello'"

clean:
	rm -rf bin/ $(DEV_DIR) dist/ node_modules/
