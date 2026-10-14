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
});
