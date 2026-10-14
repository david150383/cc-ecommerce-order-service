import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { connectMongo } from "./db/mongo.js";
import { createLogger } from "./lib/logger.js";
import { HttpCatalog } from "./orders/catalog-client.js";
import { orderModel } from "./orders/order.model.js";
import { ServiceTokenProvider } from "./security/service-token-provider.js";
import { TokenVerifier } from "./security/token-verifier.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const connection = await connectMongo(env.MONGODB_URI);

const tokens = new ServiceTokenProvider({
  authUrl: env.AUTH_SERVICE_URL,
  clientId: env.SERVICE_CLIENT_ID,
  clientSecret: env.SERVICE_CLIENT_SECRET,
  timeoutMs: env.DEPENDENCY_TIMEOUT_MS,
});
if (!env.SERVICE_CLIENT_SECRET) logger.warn("SERVICE_CLIENT_SECRET is not set: order creation will fail with 503");

let shuttingDown = false;

const app = createApp({
  env,
  logger,
  orders: orderModel(connection),
  catalog: new HttpCatalog(env.PRODUCT_SERVICE_URL, tokens, env.DEPENDENCY_TIMEOUT_MS),
  verifier: new TokenVerifier({
    jwksUrl: env.JWKS_URL,
    issuer: env.JWT_ISSUER,
    audiences: [env.JWT_AUDIENCE, env.JWT_SERVICE_AUDIENCE],
  }),
  readinessChecks: [
    {
      // Report "not ready" as soon as shutdown starts, so the load balancer
      // stops sending new requests while in-flight ones finish.
      name: "accepting-traffic",
      check: async () => {
        if (shuttingDown) throw new Error("shutting down");
      },
    },
    { name: "database", check: async () => void (await connection.db!.admin().ping()) },
  ],
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "server listening");
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");

  server.close((err) => {
    void connection.close().finally(() => {
      if (err) {
        logger.error({ err }, "error while closing server");
        process.exit(1);
      }
      logger.info("shutdown complete");
      process.exit(0);
    });
  });
  server.closeIdleConnections();

  setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "forced shutdown after timeout");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
