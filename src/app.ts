import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import type { Env } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import { buildOpenApiDocument } from "./openapi/document.js";
import type { Catalog } from "./orders/catalog-client.js";
import type { OrderModel } from "./orders/order.model.js";
import { orderRouters } from "./orders/order.routes.js";
import { OrderService } from "./orders/order.service.js";
import { healthRouter, type ReadinessCheck } from "./routes/health.js";
import type { TokenVerifier } from "./security/token-verifier.js";

export interface AppDependencies {
  env: Env;
  logger: Logger;
  orders: OrderModel;
  catalog: Catalog;
  verifier: TokenVerifier;
  readinessChecks?: ReadinessCheck[];
}

// Builds the Express app without starting a server, so tests can drive it
// in-process with Supertest. All collaborators are injected.
export function createApp({ env, logger, orders, catalog, verifier, readinessChecks = [] }: AppDependencies): Express {
  const service = new OrderService(orders, catalog, env);
  const routers = orderRouters(service, verifier);

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGINS,
      credentials: true,
      exposedHeaders: ["X-Correlation-Id", "X-Request-Id", "Location", "Idempotency-Replayed"],
    }),
  );
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => res.locals.requestId as string,
      customProps: (_req, res) => ({ correlationId: res.locals.correlationId as string }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
      // Log only what is useful for tracing; headers can carry credentials and are noisy.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(readinessChecks));
  const openApi = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi));

  app.use("/api/v1", routers.api);
  app.use("/internal/v1", routers.internal);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
