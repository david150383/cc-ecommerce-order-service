import mongoose, { type Connection } from "mongoose";
import { isDocumentDb } from "../config/env.js";

/** Amazon's RDS/DocumentDB CA bundle, downloaded (checksum-pinned) into the image at build time. */
export const BUNDLED_RDS_CA_FILE = "/app/certs/rds-global-bundle.pem";

/**
 * A dedicated connection (not the mongoose global), so the app and the tests can each
 * own theirs. autoIndex is off: indexes are created by the migrate job (scripts/sync-indexes).
 * Money is stored as BSON Int64 and read back as bigint (useBigInt64), never as a double.
 *
 * Amazon DocumentDB (production) is MongoDB-compatible with a few differences that matter here: no
 * retryable writes (the URI must say retryWrites=false; the config refuses it otherwise), TLS with
 * Amazon's CA, and only the operators listed in tests/documentdb-compat.test.ts.
 */
export async function connectMongo(uri: string, opts: { tlsCAFile?: string | undefined } = {}): Promise<Connection> {
  const tlsCAFile = opts.tlsCAFile ?? (isDocumentDb(uri) ? BUNDLED_RDS_CA_FILE : undefined);
  const connection = mongoose.createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
    // Return BSON Int64 money fields as native bigint (not driver Long objects), on every read path.
    useBigInt64: true,
    ...(tlsCAFile && { tlsCAFile }),
  });
  await connection.asPromise();
  return connection;
}
