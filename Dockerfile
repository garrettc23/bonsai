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
VOLUME ["/app/data"]

# NODE_ENV=production flips on the cookie Secure flag and the strict svix
# verification on the Resend inbound webhook (fail-closed if the secret
# isn't configured). Railway also sets this by default — declared here so
# `docker run` works the same way.
ENV NODE_ENV=production

# Railway injects $PORT; locally Docker users can leave it unset and the
# server falls back to 3333 (see src/server.ts).
EXPOSE 3333

# Drop to a non-root user so a vulnerability in any dependency can't
# scribble outside /app. The `bun` image already ships a `bun` user
# with a writable home, but /app/data needs explicit ownership.
RUN chown -R bun:bun /app
USER bun

CMD ["bun", "run", "src/server.ts"]
