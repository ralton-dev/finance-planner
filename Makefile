.PHONY: install dev build test lint typecheck format up down logs migrate seed up-kind down-kind help

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
	@echo "  down       docker-compose down"
	@echo "  logs       tail docker-compose logs"
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

down:
	docker compose -f deploy/local/docker-compose.yml down

logs:
	docker compose -f deploy/local/docker-compose.yml logs -f

migrate:
	docker compose -f deploy/local/docker-compose.yml exec -T postgres \
		psql -U $${POSTGRES_USER:-finance} -d $${POSTGRES_DB:-finance} -f /migrations/0001_init.sql

seed:
	docker compose -f deploy/local/docker-compose.yml exec -T postgres \
		psql -U $${POSTGRES_USER:-finance} -d $${POSTGRES_DB:-finance} -f /seed/seed.sql

up-kind:
	bash deploy/local/kind-up.sh

down-kind:
	helm uninstall finance-planner || true
