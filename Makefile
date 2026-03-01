.PHONY: build test integration-test lint check dev-env clean

BINARY := bin/vh
DEV_DIR := .dev
VH_HOME := $(DEV_DIR)/vh

build:
	go build -o $(BINARY) ./cmd/vh/

test:
	go test -short -count=1 ./...

integration-test:
	go test -count=1 -timeout 120s ./...

lint:
	golangci-lint run ./...

check: lint test build

dev-env: build
	@mkdir -p $(VH_HOME)
	@echo "Dev environment ready."
	@echo "  export VH_HOME=$$(pwd)/$(VH_HOME)"
	@echo "  ./$(BINARY) new --name test --prompt 'hello'"

clean:
	rm -rf bin/ $(DEV_DIR)
