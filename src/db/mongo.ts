import mongoose, { type Connection } from "mongoose";

/**
 * A dedicated connection (not the mongoose global), so the app and the tests can each
 * own theirs. autoIndex is off: indexes are created by the migrate job (scripts/sync-indexes).
 * Money is stored as BSON Int64 and read back as bigint (useBigInt64), never as a double.
 */
export async function connectMongo(uri: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
    // Return BSON Int64 money fields as native bigint (not driver Long objects), on every read path.
    useBigInt64: true,
  });
  await connection.asPromise();
  return connection;
}
