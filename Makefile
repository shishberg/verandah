.PHONY: build test integration-test lint check dev-env clean

BINARY := bin/vh
BUNDLE := dist/vh.js
DAEMON_BUNDLE := dist/daemon.js
DEV_DIR := .dev
VH_HOME := $(DEV_DIR)/vh

ESBUILD_FLAGS := \
	--bundle \
	--platform=node \
	--target=node22 \
	--format=esm \
	--external:better-sqlite3 \
	--banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

build:
	npx esbuild src/cli/main.ts $(ESBUILD_FLAGS) --outfile=$(BUNDLE)
	npx esbuild src/daemon/entry.ts $(ESBUILD_FLAGS) --outfile=$(DAEMON_BUNDLE)
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
