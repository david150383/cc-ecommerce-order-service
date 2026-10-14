# ---- build: compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod: production dependencies + compiled JS (shared by migrate and runtime) ----
FROM node:24-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Command schemas: the SQS consumer validates incoming commands against the schemas this service owns.
COPY events/schemas ./events/schemas
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
