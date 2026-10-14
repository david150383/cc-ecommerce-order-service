import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpCatalog } from "../src/orders/catalog-client.js";
import { ServiceTokenProvider } from "../src/security/service-token-provider.js";

/** A tiny stand-in for the Auth and Product services, speaking real HTTP. */
let server: Server;
let baseUrl: string;
let tokenRequests: { audience: string; clientId: string }[];
let issued = 0;
let productAuthHeaders: string[];
let productBehaviour: "ok" | "reject-first-token" | "500";

const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(JSON.parse(raw || "{}")));
  });

beforeEach(async () => {
  tokenRequests = [];
  productAuthHeaders = [];
  issued = 0;
  productBehaviour = "ok";
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url === "/internal/v1/auth/service-token") {
      tokenRequests.push(body as { audience: string; clientId: string });
      await new Promise((r) => setTimeout(r, 20)); // slow enough for concurrent callers to overlap
      if (body.clientSecret !== "right-secret") return void res.writeHead(401).end();
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ accessToken: `token-${++issued}`, tokenType: "Bearer", expiresIn: 300 }),
      );
      return;
    }
    if (req.url === "/internal/v1/products/price-lookup") {
      productAuthHeaders.push(req.headers.authorization ?? "");
      if (productBehaviour === "500") return void res.writeHead(500).end();
      if (productBehaviour === "reject-first-token" && req.headers.authorization === "Bearer token-1") return void res.writeHead(401).end();
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          items: [{ sku: "TEE-1", productId: "p", variantId: "v", name: "Tee", unitPrice: { amountMinor: 100, currency: "INR" } }],
          unavailable: (body.skus as string[]).filter((s) => s !== "TEE-1"),
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const provider = (secret = "right-secret") =>
  new ServiceTokenProvider({ authUrl: baseUrl, clientId: "ecommerce-order-service", clientSecret: secret, timeoutMs: 2_000 });

describe("ServiceTokenProvider", () => {
  it("caches one token per audience and shares a single in-flight request", async () => {
    const p = provider();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => p.token("ecommerce-product-service")));
    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({ clientId: "ecommerce-order-service", audience: "ecommerce-product-service" });

    await p.token("ecommerce-product-service");
    expect(tokenRequests).toHaveLength(1); // cached
    await p.token("ecommerce-inventory-service");
    expect(tokenRequests).toHaveLength(2); // a different audience gets its own token
  });

  it("maps bad credentials, missing config and an unreachable Auth Service to 503", async () => {
    await expect(provider("wrong").token("x")).rejects.toMatchObject({ status: 503, code: "DEPENDENCY_UNAVAILABLE" });
    // Note: provider(undefined) would silently use the default secret (JS default parameters).
    const unconfigured = new ServiceTokenProvider({ authUrl: baseUrl, clientId: "c", clientSecret: undefined, timeoutMs: 2_000 });
    await expect(unconfigured.token("x")).rejects.toMatchObject({ status: 503 });
    const unreachable = new ServiceTokenProvider({ authUrl: "http://127.0.0.1:1", clientId: "c", clientSecret: "s", timeoutMs: 500 });
    await expect(unreachable.token("x")).rejects.toMatchObject({ status: 503 });
  });
});

describe("HttpCatalog", () => {
  it("calls the Product Service with a service token for the Product audience", async () => {
    const catalog = new HttpCatalog(baseUrl, provider(), 2_000);
    const result = await catalog.lookup(["TEE-1", "GONE-1"]);
    expect(result).toEqual({
      items: [{ sku: "TEE-1", productId: "p", variantId: "v", name: "Tee", unitPrice: { amountMinor: 100, currency: "INR" } }],
      unavailable: ["GONE-1"],
    });
    expect(productAuthHeaders).toEqual(["Bearer token-1"]);
    expect(tokenRequests[0]!.audience).toBe("ecommerce-product-service");
  });

  it("on 401 it drops the cached token and retries once with a fresh one", async () => {
    productBehaviour = "reject-first-token";
    const catalog = new HttpCatalog(baseUrl, provider(), 2_000);
    await catalog.lookup(["TEE-1"]);
    expect(productAuthHeaders).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("maps Product Service errors and outages to 503", async () => {
    productBehaviour = "500";
    await expect(new HttpCatalog(baseUrl, provider(), 2_000).lookup(["TEE-1"])).rejects.toMatchObject({ status: 503 });
    await expect(new HttpCatalog("http://127.0.0.1:1", provider(), 500).lookup(["TEE-1"])).rejects.toMatchObject({ status: 503 });
  });
});
