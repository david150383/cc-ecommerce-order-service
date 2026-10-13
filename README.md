# ecommerce-order-service

Orders for the e-commerce platform: pending-order creation with immutable price snapshots, totals (tax, shipping, discounts in integer minor units), validated status transitions, customer order history, cancellation requests and an audit trail. It executes `OrderStatusTransitionRequested` commands from the Saga Orchestrator.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, MongoDB 8, Mongoose *(Phase 2)* |
| Port | 4004 |
| Database | `order_db` (MongoDB), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 2: features | ⏳ see [docs/api.md](docs/api.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4004/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone), or in `ecommerce-infrastructure` (whole platform).

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
```
