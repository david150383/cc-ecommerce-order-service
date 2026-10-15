# ---- build: compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- certs: Amazon's RDS CA bundle (DocumentDB TLS). Public certificates; pinned so a changed file fails the build ----
FROM node:24-alpine AS certs
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b
RUN wget -qO /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && echo "${RDS_CA_SHA256}  /rds-global-bundle.pem" | sha256sum -c -

# ---- prod: production dependencies + compiled JS (shared by migrate and runtime) ----
FROM node:24-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Command schemas: the SQS consumer validates incoming commands against the schemas this service owns.
COPY events/schemas ./events/schemas
COPY --from=certs /rds-global-bundle.pem /app/certs/rds-global-bundle.pem
USER node

# ---- migrate: one-off job that syncs MongoDB indexes, then exits ----
FROM prod AS migrate
CMD ["node", "dist/scripts/sync-indexes.js"]

# ---- runtime (last stage = the default for a plain `docker build .`) ----
FROM prod AS runtime
EXPOSE 4004
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4004}/health/live" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
