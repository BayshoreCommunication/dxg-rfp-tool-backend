# syntax=docker/dockerfile:1
#
# One image, three entrypoints. The API, the durable worker and the outbox
# dispatcher all run the same compiled bundle and differ only by CMD (see
# docker-compose.prod.yml). Everything is compiled ahead of time via
# tsconfig.build.json, so the runtime stage carries no ts-node and no
# devDependencies.
#
# bookworm-slim rather than alpine: sharp and pdf-parse both resolve prebuilt
# glibc binaries here, and the musl path has historically needed a source build.

# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# contracts:check fails the build if the generated contract types have drifted
# from their schemas — the same gate npm run ci applies.
RUN npm run contracts:check && npm run build

# ---------- production dependencies ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, which the worker and dispatcher rely
# on for their graceful-shutdown handlers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist        ./dist
COPY            --chown=node:node package.json       ./

# Legacy local upload path. Bind-mounted to a named volume in production so the
# files survive a container rebuild.
RUN mkdir -p /app/uploads/temp /app/uploads/portfolio && chown -R node:node /app/uploads

# Amazon RDS certificate bundle so POSTGRES_SSL=true can verify the server
# certificate (set NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem). Harmless
# for non-RDS deployments.
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
