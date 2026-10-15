import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const required = { MONGODB_URI: "mongodb://localhost:27017/x" };

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(required);
    expect(env.PORT).toBe(4004);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("parses comma-separated CORS origins", () => {
    const env = loadEnv({ ...required, CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("requires MONGODB_URI and validates coupons", () => {
    expect(() => loadEnv({})).toThrow(/MONGODB_URI/);
    expect(() => loadEnv({ ...required, COUPONS: '[{"code":"x","percentBps":0}]' })).toThrow(/Invalid environment/);
  });

  it("rejects invalid configuration at startup", () => {
    expect(() => loadEnv({ ...required, PORT: "not-a-port" })).toThrow(/Invalid environment configuration/);
  });

  it("Amazon DocumentDB: refuses a URI without retryWrites=false or TLS, and never echoes the password", () => {
    const host = "prod-ecommerce-docdb.cluster-abc123.ap-south-1.docdb.amazonaws.com:27017";
    const uri = (q: string) => `mongodb://order_svc:S3cret-Passw0rd@${host}/order_db?${q}`;
    let message = "";
    try {
      loadEnv({ MONGODB_URI: uri("tls=true&replicaSet=rs0") });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/retryWrites=false/);
    expect(message).not.toContain("S3cret-Passw0rd");
    expect(() => loadEnv({ MONGODB_URI: uri("retryWrites=false&replicaSet=rs0") })).toThrow(/tls=true/);
    expect(loadEnv({ MONGODB_URI: uri("tls=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false") }).MONGODB_URI).toContain(host);
    // Plain MongoDB (local) is unaffected.
    expect(() => loadEnv({ MONGODB_URI: "mongodb://root:x@mongo:27017/order_db?authSource=admin" })).not.toThrow();
  });
});

