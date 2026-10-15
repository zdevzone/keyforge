# KEYFORGE_TOOLCHAIN_TEMPLATE
FROM node:24.21.0-bookworm AS build
WORKDIR /app
RUN npm install -g vite-plus@1.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ui/
COPY packages/keyforge-client/package.json packages/keyforge-client/
RUN vp install --frozen-lockfile
COPY tsconfig.json tsconfig.test.json ./
COPY src src
COPY scripts scripts
COPY packages/keyforge-client/src packages/keyforge-client/src
COPY packages/keyforge-client/tsconfig.json packages/keyforge-client/
COPY packages/keyforge-client/README.md packages/keyforge-client/
COPY docs docs
COPY ui ui
RUN vp run build && vp -C ui run build
FROM node:24.21.0-bookworm AS deps
WORKDIR /app
RUN npm install -g vite-plus@1.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ui/
COPY packages/keyforge-client/package.json packages/keyforge-client/
RUN vp install --frozen-lockfile --prod
FROM postgres:18.6-bookworm AS pgtools
FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 liblz4-1 libzstd1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=pgtools /usr/lib/postgresql/18/bin/pg_dump /usr/lib/postgresql/18/bin/pg_restore /usr/local/bin/
COPY --from=pgtools /usr/lib/x86_64-linux-gnu/libpq.so.5* /usr/lib/x86_64-linux-gnu/
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/dist/runtime-package.json package.json
COPY scripts scripts
ENV LICENSE_DB_PATH=/data/licenses.sqlite
ENV LICENSE_HOST=0.0.0.0
VOLUME /data
EXPOSE 4100
CMD ["node", "dist/src/index.js"]
