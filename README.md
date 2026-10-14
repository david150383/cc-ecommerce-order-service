# ecommerce-order-service

Orders for the e-commerce platform: pending-order creation with immutable price snapshots, totals (tax, shipping, discounts in integer minor units), validated status transitions, customer order history, cancellation requests and an audit trail. It executes `OrderStatusTransitionRequested` commands from the Saga Orchestrator.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, MongoDB 8, Mongoose 9, jose 6, Zod 4 |
| Port | 4004 |
| Database | `order_db` (MongoDB), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 2: features | ✅ Price-snapshot orders via Product (service token from Auth), BigInt pricing with coupons/tax/shipping, idempotent creation, state machine with compare-and-set transitions, cancellation rules, ownership checks, embedded outbox, OpenAPI |
| 3 | ⏳ SQS command consumer + outbox relay |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4004/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone MongoDB on 27018), or in `ecommerce-infrastructure`
(whole platform; MongoDB on 27017). `npm test` needs MongoDB: it recreates the `order_test` database.

Creating orders needs the Product and Auth services plus service credentials (`SERVICE_CLIENT_SECRET`);
reading, transitions and cancellation work without them.

## Data and indexes

MongoDB has no schema migrations; this service's equivalent is **index management**. `autoIndex` is off and
`npm run db:sync-indexes` (the `migrate` image target, `order-migrate` in compose) creates the indexes declared
in `src/orders/order.model.ts` and drops undeclared ones. Data migrations, when needed, will be versioned
scripts in `src/scripts/`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `docker build -t ecommerce-order-service .` | Production image (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
src/orders/           model, pricing (BigInt), state machine, service, routes, Product client
src/security/         token verification (JWKS), client-credentials token provider
src/openapi/          OpenAPI generated from the Zod schemas
src/scripts/          sync-indexes (migrate job), export-openapi
```
