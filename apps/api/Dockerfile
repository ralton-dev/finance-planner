# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
# Node 25 dropped bundled corepack; install it explicitly so bumping the base
# image cannot take pnpm away. The version it provisions comes from
# "packageManager" in the root package.json.
RUN npm i -g corepack@latest && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @finance-planner/api build

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
# Carry the installed workspace so external deps (fastify) are available at runtime.
COPY --from=build /repo ./
WORKDIR /repo/apps/api
EXPOSE 4000
# The preload is permanent; whether it does anything is OTEL_ENABLED's business.
# With the flag unset it costs one `if` and loads no OpenTelemetry module at all.
#
# The `./` is load-bearing. `--import dist/otel.js` is read as a *bare package
# specifier* and dies with ERR_MODULE_NOT_FOUND before the app is reached;
# `./dist/otel.js` is a relative path and resolves against the cwd set above.
CMD ["node", "--import", "./dist/otel.js", "dist/index.js"]
