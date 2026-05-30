# Build context is the repo root: docker build -f apps/auth/Dockerfile .
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @finance-planner/auth build

FROM node:26-alpine AS runtime
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo ./
WORKDIR /repo/apps/auth
EXPOSE 4001
CMD ["node", "dist/index.js"]
