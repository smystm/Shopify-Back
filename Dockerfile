# syntax=docker/dockerfile:1

# The shop API, as a container that runs the same way on a laptop, on an x86 VM
# and on Oracle's Ampere ARM shape.
#
# Two stages, because sqlite3 is a native module: it is compiled in one and the
# compiler is thrown away with it, so the image that ships carries no toolchain.

# ---------------------------------------------------------------- build stage
FROM node:20-bookworm-slim AS build

# python3/make/g++ are here to compile sqlite3 from source.
#
# sqlite3 5.0.11 does publish a prebuilt binary for linux-arm64 as well as x64,
# so on Oracle's Ampere shape it would normally be downloaded rather than built.
# `--build-from-source` below turns that off deliberately: the alternative is a
# build whose success depends on GitHub's release CDN being reachable from the
# machine, which is a dependency nobody remembers exists until it fails at 2am.
# Compiling costs a minute or two once, and afterwards the only network the
# install needs is the npm registry it already needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The lockfile is copied on its own so this layer is cached until dependencies
# actually change, rather than on every edit to the application.
COPY package.json package-lock.json ./

# --omit=dev keeps nodemon and friends out of what gets copied forward.
RUN npm ci --omit=dev --build-from-source

# -------------------------------------------------------------- runtime stage
FROM node:20-bookworm-slim AS runtime

# The sqlite3 CLI is not used by the app - it is here so the backup job can use
# `.backup`, which is the one way to copy a SQLite file that is being written to
# without risking a torn database.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .

# The database lives on a volume, never in the image: an image is a build
# artefact that gets rebuilt and redeployed, and a database is not.
ENV DATABASE_PATH=/data/usersdb.sqlite
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 5000

# Answers `/api`, which touches the database - so a healthy check means the schema
# is there too, not merely that a port is open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "./bin/www"]
