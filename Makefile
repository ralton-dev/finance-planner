.PHONY: install dev build test lint typecheck format up up-otel down logs logs-otel migrate seed up-kind down-kind help

help:
	@echo "Targets:"
	@echo "  install    pnpm install all workspaces"
	@echo "  dev        run all services + web in watch mode (turbo)"
	@echo "  build      build all apps"
	@echo "  test       run all tests"
	@echo "  lint       lint all workspaces"
	@echo "  typecheck  typecheck all workspaces"
	@echo "  format     prettier --write ."
	@echo "  up         docker-compose up the local stack (postgres, redis, services)"
	@echo "  up-otel    up, plus a collector, with tracing on (OTEL_ENABLED=true)"
	@echo "  down       docker-compose down"
	@echo "  logs       tail docker-compose logs"
	@echo "  logs-otel  tail the collector, which prints every span it receives"
	@echo "  migrate    apply DB migrations against the local DB"
	@echo "  seed       load seed data into the local DB"
	@echo "  up-kind    build images, load into kind, helm install (local overlay)"
	@echo "  down-kind  helm uninstall from kind"

install:
	pnpm install

dev:
	pnpm dev

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

format:
	pnpm format

up:
	docker compose -f deploy/local/docker-compose.yml up -d --build

# The same stack plus an OTLP collector that prints every span it receives.
# OTEL_ENABLED is set here rather than in .env so that `make up` and `make up`
# after it stay honest about what they started; the endpoint comes from the
# compose default. Read the traces with `make logs-otel`.
up-otel:
	OTEL_ENABLED=true docker compose -f deploy/local/docker-compose.yml --profile otel up -d --build

# `down` must name the profile too, or the collector is left running.
down:
	docker compose -f deploy/local/docker-compose.yml --profile otel down

logs:
	docker compose -f deploy/local/docker-compose.yml logs -f

logs-otel:
	docker compose -f deploy/local/docker-compose.yml --profile otel logs -f otel-collector

migrate:
	docker compose -f deploy/local/docker-compose.yml exec -T postgres sh -c \
		'for f in /migrations/*.sql; do echo "applying $$f"; \
		 psql -v ON_ERROR_STOP=1 -U $${POSTGRES_USER:-finance} -d $${POSTGRES_DB:-finance} -f "$$f"; done'

seed:
	docker compose -f deploy/local/docker-compose.yml exec -T postgres \
		psql -U $${POSTGRES_USER:-finance} -d $${POSTGRES_DB:-finance} -f /seed/seed.sql

up-kind:
	bash deploy/local/kind-up.sh

down-kind:
	helm uninstall finance-planner || true
