# Build context is the repo root: docker build -f apps/calc/Dockerfile .
FROM node:24-alpine AS build
# Node 25 dropped bundled corepack; install it explicitly so bumping the base
# image cannot take pnpm away. The version it provisions comes from
# "packageManager" in the root package.json.
RUN npm i -g corepack@latest && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @finance-planner/calc build

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo ./
WORKDIR /repo/apps/calc
EXPOSE 4002
CMD ["node", "dist/index.js"]
