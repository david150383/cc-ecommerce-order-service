// The Order Service's "migration" job: creates/updates the indexes declared in
// order.model.ts and drops indexes no longer declared. Idempotent. Runs before deploys
// (compose: order-migrate), never at app startup (autoIndex is off).
//   node dist/scripts/sync-indexes.js    |    npm run db:sync-indexes
import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { orderModel } from "../orders/order.model.js";

const env = loadEnv();
const connection = await connectMongo(env.MONGODB_URI, { tlsCAFile: env.MONGODB_TLS_CA_FILE });
const dropped = await orderModel(connection).syncIndexes();
const indexes = await orderModel(connection).listIndexes();
console.log(
  JSON.stringify({ msg: "indexes in sync", indexes: indexes.map((i: { name?: string }) => i.name), dropped }),
);
await connection.close();
