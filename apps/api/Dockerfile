# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:25-alpine AS build
# Node 25 dropped bundled corepack; install it explicitly so bumping the base
# image cannot take pnpm away. The version it provisions comes from
# "packageManager" in the root package.json.
RUN npm i -g corepack@latest && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @finance-planner/api build

FROM node:25-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
# Carry the installed workspace so external deps (fastify) are available at runtime.
COPY --from=build /repo ./
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
