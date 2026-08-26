# Build stage: compile the server and the admin console.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci, not npm install: it installs exactly the locked tree and fails
# when the lockfile and package.json disagree, so an image can be rebuilt
# months later and get the same dependencies.
RUN npm ci
COPY ui/package.json ui/package-lock.json ui/
RUN npm --prefix ui ci
COPY tsconfig.json tsconfig.test.json ./
COPY src src
COPY ui ui
RUN npm run build && npm --prefix ui run build

# Production dependencies only (better-sqlite3 ships prebuilt binaries).
FROM node:22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime: the compiled server, the built console, and nothing else.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY scripts scripts
# SQLite data lives under /data by default; mount a volume there.
ENV LICENSE_DB_PATH=/data/licenses.sqlite
ENV LICENSE_HOST=0.0.0.0
# LICENSE_PORT is deliberately unset: hosts that assign a port pass it as PORT,
# and a baked-in LICENSE_PORT would outrank it. Unset means 4100 locally.
VOLUME /data
EXPOSE 4100
CMD ["node", "dist/src/index.js"]
