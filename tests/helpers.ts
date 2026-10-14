import { Writable } from "node:stream";
import { type CryptoKey, exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import mongoose, { type Connection } from "mongoose";
import { pino } from "pino";
import { v7 as uuidv7 } from "uuid";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { HttpProblem } from "../src/lib/problem.js";
import type { Catalog, CatalogItem, PriceLookupResult } from "../src/orders/catalog-client.js";
import { orderModel } from "../src/orders/order.model.js";
import { OrderService } from "../src/orders/order.service.js";
import type { ReadinessCheck } from "../src/routes/health.js";
import { TokenVerifier } from "../src/security/token-verifier.js";
import { TEST_MONGODB_URI } from "./global-setup.js";

/** In-memory stand-in for the Product Service's price lookup. */
export class FakeCatalog implements Catalog {
  readonly items = new Map<string, CatalogItem>();
  calls = 0;
  down = false;

  set(sku: string, amountMinor: number, currency = "INR", name = `Product ${sku}`): void {
    this.items.set(sku, { sku, productId: uuidv7(), variantId: uuidv7(), name, unitPrice: { amountMinor, currency } });
  }

  async lookup(skus: string[]): Promise<PriceLookupResult> {
    this.calls++;
    if (this.down) throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Product Service unreachable");
    return {
      items: skus.filter((s) => this.items.has(s)).map((s) => structuredClone(this.items.get(s)!)),
      unavailable: skus.filter((s) => !this.items.has(s)),
    };
  }
}

let keys: Promise<{ privateKey: CryptoKey; jwks: JSONWebKeySet }> | undefined;
function testKeys() {
  keys ??= generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => ({
    privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] },
  }));
  return keys;
}

export async function token(roles: string[], opts: { sub?: string; audience?: string; expiresIn?: string } = {}) {
  const { privateKey } = await testKeys();
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("ecommerce-auth-service")
    .setAudience(opts.audience ?? (roles.includes("service") ? "ecommerce-order-service" : "ecommerce-api"))
    .setSubject(opts.sub ?? uuidv7())
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "15m")
    .sign(privateKey);
}

export const auth = async (roles: string[], sub?: string) => ({
  Authorization: `Bearer ${await token(roles, sub ? { sub } : {})}`,
});

let connection: Connection | undefined;
export async function testConnection(): Promise<Connection> {
  connection ??= await mongoose.createConnection(TEST_MONGODB_URI, { useBigInt64: true, autoIndex: false }).asPromise();
  return connection;
}

export async function resetDatabase(): Promise<void> {
  await orderModel(await testConnection()).deleteMany({});
}

export async function buildTestContext(overrides: Record<string, string> = {}, readinessChecks: ReadinessCheck[] = []) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    MONGODB_URI: TEST_MONGODB_URI,
    COUPONS: JSON.stringify([{ code: "WELCOME10", percentBps: 1000, maxDiscountMinor: 50_000 }]),
    ...overrides,
  });
  const logs: string[] = [];
  const logger = pino(
    { level: env.LOG_LEVEL },
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  );
  const catalog = new FakeCatalog();
  const conn = await testConnection();
  const verifier = new TokenVerifier(
    { jwksUrl: "http://unused.invalid/jwks", issuer: "ecommerce-auth-service", audiences: ["ecommerce-api", "ecommerce-order-service"] },
    (await testKeys()).jwks,
  );
  const orders = orderModel(conn);
  const service = new OrderService(orders, catalog, env);
  const app = createApp({ env, logger, orders, catalog, verifier, readinessChecks, service });
  return { app, catalog, logs, orders, service, env, logger };
}

export const newId = () => uuidv7();

export const address = {
  name: "Asha Rao",
  line1: "12 MG Road",
  city: "Bengaluru",
  postalCode: "560001",
  country: "IN",
  phone: "+919800000000",
};
