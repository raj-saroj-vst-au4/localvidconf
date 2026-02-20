# =============================================================================
# Media Server Dockerfile
# This is the container you replicate across servers for load balancing.
# Includes mediasoup native addon build dependencies.
# =============================================================================

# --- Stage 1: Build ---
# mediasoup requires native compilation (C++ worker binary)
# python3, make, g++ are needed for the node-gyp build
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies for mediasoup native addon
# py3-pip is required by mediasoup's build script (npm-scripts.mjs)
# openssl needed so Prisma can detect OpenSSL 3.x and generate the correct binary
RUN apk add --no-cache python3 py3-pip make g++ linux-headers openssl

# Copy package files first for layer caching
COPY packages/media-server/package.json packages/media-server/package-lock.json* ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm install

# Copy source code and compile TypeScript
COPY packages/media-server/ ./
RUN npx prisma generate && npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# mediasoup worker needs these runtime libs; openssl for Prisma query engine
RUN apk add --no-cache libstdc++ openssl

# Create non-root user (security best practice)
RUN addgroup --system --gid 1001 mediaserver && \
    adduser --system --uid 1001 mediaserver

# Copy compiled output and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

USER mediaserver

EXPOSE 4000
# Expose mediasoup RTC port range for WebRTC media traffic
EXPOSE 40000-40100/udp

CMD ["node", "dist/index.js"]
