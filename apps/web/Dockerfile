FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm -C apps/web build

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --gid 10001 ledger && useradd --uid 10001 --gid ledger --create-home ledger && mkdir /data && chown ledger:ledger /data
WORKDIR /app
COPY --from=builder --chown=ledger:ledger /app/apps/web/.next/standalone ./
COPY --from=builder --chown=ledger:ledger /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=ledger:ledger /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=ledger:ledger /app/apps/web/db/migrations ./apps/web/db/migrations
COPY --from=builder --chown=ledger:ledger /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=ledger:ledger /app/apps/web/docker-entrypoint.sh ./apps/web/docker-entrypoint.sh
WORKDIR /app/apps/web
USER ledger
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
