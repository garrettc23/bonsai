# syntax=docker/dockerfile:1.6
#
# Bonsai production image, used by Railway (or any container platform).
# Multi-stage so the final image only carries deps + source — no build
# toolchain — keeping cold-start fast on Railway's free / hobby tiers.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /app

# Pull deps from the builder layer.
COPY --from=deps /app/node_modules ./node_modules

# App source — copy after deps so a code-only change reuses the deps cache.
COPY . .

# Bonsai writes per-user files + SQLite under $BONSAI_DATA_DIR. On Railway
# we mount a volume here so data survives deploys. Locally this directory
# is created on demand.
ENV BONSAI_DATA_DIR=/app/data
RUN mkdir -p /app/data

# NODE_ENV=production flips on the cookie Secure flag and the strict svix
# verification on the Resend inbound webhook (fail-closed if the secret
# isn't configured). Railway also sets this by default — declared here so
# `docker run` works the same way.
ENV NODE_ENV=production

# Railway injects $PORT; locally Docker users can leave it unset and the
# server falls back to 3333 (see src/server.ts).
EXPOSE 3333

# Run as root inside the container. Railway mounts the persistent volume
# at /app/data at runtime — that volume's ownership is root, and the
# build-time `chown -R bun:bun /app` doesn't survive the mount. With
# `USER bun` the bun process can't write the SQLite DB or per-user file
# tree, and every signup / audit returns 500. The Railway container is
# already isolated from the host; running as root here is the same risk
# surface most Node/Bun images take. A future hardening PR can re-introduce
# the bun user via an entrypoint script that chowns /app/data on startup.
RUN chown -R bun:bun /app

CMD ["bun", "run", "src/server.ts"]
