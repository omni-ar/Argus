# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Enable corepack and install pnpm v9 (matches lockfileVersion: '9.0')
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Install dependencies first (layer-cached unless lockfile changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy all source needed for tsc
COPY tsconfig.json constants.ts reconciliation_output.json ./
COPY src ./src
COPY scripts ./scripts

# Compile TypeScript → dist/
RUN pnpm build

# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Pull compiled output from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/reconciliation_output.json ./reconciliation_output.json

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check (wget is available on alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# tsc compiles src/index.ts → dist/src/index.js (rootDir is "./")
CMD ["node", "dist/src/index.js"]
