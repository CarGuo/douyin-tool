# douyin-tool — make targets
#
# Everything goes through the project-local Node in tools/node/, downloaded
# automatically by scripts/bootstrap-node.sh on first use. No host-level
# node / nvm / n / fnm / volta required.

SHELL := /bin/bash
NPM   := ./bin/npm
NODE  := ./bin/node

.PHONY: help setup install dev dev-server dev-web test build lint smoke docker-build docker-up docker-down clean-node clean

help:
	@echo "Targets:"
	@echo "  setup / install    bootstrap project-local node + npm install"
	@echo "  dev                run server + web dev concurrently (npm workspaces)"
	@echo "  dev-server         run only the Fastify server (port 3000)"
	@echo "  dev-web            run only the Vite dev server (port 5173)"
	@echo "  test               run all unit/integration tests"
	@echo "  build              build server + web for production"
	@echo "  lint               type-check all workspaces"
	@echo "  smoke              one-off real Douyin link smoke test"
	@echo "  docker-build       build Docker image"
	@echo "  docker-up/down     start/stop docker compose service"
	@echo "  clean-node         remove project-local Node (re-downloads next time)"
	@echo "  clean              clean dist + node_modules"

setup install:
	@bash scripts/bootstrap-node.sh
	$(NPM) install

dev:
	$(NPM) run dev

dev-server:
	$(NPM) run dev:server

dev-web:
	$(NPM) run dev:web

test:
	$(NPM) test

build:
	$(NPM) run build

lint:
	$(NPM) run lint

smoke:
	$(NPM) run build -w @douyin-tool/server
	$(NODE) scripts/oneoff-smoke.mjs

docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-down:
	docker compose down

clean-node:
	rm -rf tools/node tools/.cache

clean:
	rm -rf node_modules packages/*/node_modules packages/*/dist
