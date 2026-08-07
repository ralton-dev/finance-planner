# Build context is the repo root: docker build -f apps/web/Dockerfile .
FROM node:25-alpine AS build
# Node 25 dropped bundled corepack; install it explicitly so bumping the base
# image cannot take pnpm away. The version it provisions comes from
# "packageManager" in the root package.json.
RUN npm i -g corepack@latest && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @finance-planner/web build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
