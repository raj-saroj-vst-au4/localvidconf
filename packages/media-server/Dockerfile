# =============================================================================
# Media Server Dockerfile — Debian (glibc) base.
#
# IMPORTANT: mediasoup 3.19+ downloads a PREBUILT worker binary that is built
# against glibc. An Alpine (musl) image cannot load it — the dynamic loader
# /lib64/ld-linux-x86-64.so.2 is absent, so `spawn mediasoup-worker` fails with
# ENOENT even though the file exists. Use a glibc base (node:20-slim).
# =============================================================================

# --- Stage 1: Build ---
FROM node:20-slim AS builder
WORKDIR /app

# Build tools as a fallback if mediasoup compiles the worker from source.
# (Normally the prebuilt glibc worker is downloaded during npm install.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY packages/media-server/package.json packages/media-server/package-lock.json* ./
COPY prisma ./prisma/

RUN npm install

# Copy source and compile TypeScript
COPY packages/media-server/ ./
RUN npx prisma generate && npm run build

# --- Stage 2: Production ---
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# openssl: Prisma query engine. wget: container healthcheck. ca-certificates: TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root user (Debian uses groupadd/useradd, not Alpine's addgroup/adduser)
RUN groupadd --system --gid 1001 mediaserver \
 && useradd --system --uid 1001 --gid mediaserver mediaserver

# Copy compiled output and dependencies (incl. the glibc mediasoup worker)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

USER mediaserver

EXPOSE 4000
# mediasoup RTC media port range (UDP)
EXPOSE 40000-40100/udp

CMD ["node", "dist/index.js"]
