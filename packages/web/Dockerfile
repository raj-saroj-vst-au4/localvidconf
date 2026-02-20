# =============================================================================
# Next.js Web App Dockerfile
# Multi-stage build for smaller production image
# Prisma schema is copied from the shared prisma/ directory
# =============================================================================

# --- Stage 1: Install dependencies ---
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package files for dependency installation
COPY packages/web/package.json packages/web/package-lock.json* ./
# Copy Prisma schema so prisma generate works during build
COPY prisma ./prisma/

RUN npm install

# --- Stage 2: Build the application ---
FROM node:20-alpine AS builder
WORKDIR /app

# openssl needed so Prisma can detect OpenSSL 3.x and generate the correct binary
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY packages/web/ ./
COPY prisma ./prisma/

# Generate Prisma client and build Next.js
# Ensure public/ exists (Next.js requires it for the standalone COPY step)
RUN mkdir -p public && npx prisma generate && npm run build

# --- Stage 3: Production image ---
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# openssl is required by Prisma's query engine on Alpine (OpenSSL 3.x)
RUN apk add --no-cache openssl

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy only the necessary build artifacts
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs

EXPOSE 3000

# Next.js standalone mode outputs a minimal server.js
CMD ["node", "server.js"]
