import mongoose from "mongoose";
import { orderModel } from "../src/orders/order.model.js";

// Local default: the platform's MongoDB (root user, test database). CI: an unauthenticated service container.
export const TEST_MONGODB_URI =
  process.env.TEST_MONGODB_URI ?? "mongodb://root:mongo_local_admin@localhost:27017/order_test?authSource=admin";

export default async function setup(): Promise<void> {
  const connection = mongoose.createConnection(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3_000, useBigInt64: true });
  try {
    await connection.asPromise();
  } catch (err) {
    throw new Error(
      "Cannot reach MongoDB for integration tests. Start it with `docker compose up -d` here or in " +
        "ecommerce-infrastructure, or set TEST_MONGODB_URI.",
      { cause: err },
    );
  }
  await connection.dropDatabase();
  await orderModel(connection).syncIndexes(); // the real indexes, incl. the unique idempotency key
  await connection.close();
}
