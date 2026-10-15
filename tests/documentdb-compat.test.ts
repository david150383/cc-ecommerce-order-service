import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production runs on Amazon DocumentDB 5.0, which is MongoDB-compatible but not identical, and there is
 * no local DocumentDB to test against. So the operators and driver features this service may use are an
 * explicit allowlist, each checked against the DocumentDB 5.0 "supported MongoDB APIs" list. Using
 * anything new fails here: check it is supported by DocumentDB first, then add it.
 */
const ALLOWED_OPERATORS = new Set([
  // update
  "$set", "$inc", "$push", "$pull", "$each",
  // query
  "$lt", "$gte", "$or", "$exists",
]);
/** Not database operators: JSON Schema keywords read by the message validators. */
const NOT_MONGO = new Set(["$id", "$ref", "$schema"]);
/** Known gaps of DocumentDB 5.0 (or features that behave differently there). */
const FORBIDDEN_APIS: [RegExp, string][] = [
  [/\.watch\(/, "change streams must be enabled per collection on DocumentDB; use the outbox instead"],
  [/mapReduce/, "mapReduce is not supported"],
  [/\$where|\$function|\$accumulator/, "server-side JavaScript is not supported"],
  [/collation/i, "collations are not supported"],
  [/retryWrites\s*:\s*true/, "DocumentDB has no retryable writes"],
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const files = sources(join(import.meta.dirname, "..", "src"));

describe("Amazon DocumentDB 5.0 compatibility (production database)", () => {
  it("uses only allow-listed MongoDB operators", () => {
    const used = new Map<string, string>();
    for (const f of files) {
      for (const [op] of readFileSync(f, "utf8").matchAll(/\$[a-zA-Z]+\b/g)) if (!NOT_MONGO.has(op)) used.set(op, f);
    }
    const unknown = [...used].filter(([op]) => !ALLOWED_OPERATORS.has(op)).map(([op, f]) => `${op} (${f})`);
    expect(unknown, "check DocumentDB 5.0 support, then add to ALLOWED_OPERATORS").toEqual([]);
  });

  it("uses no feature DocumentDB lacks", () => {
    const hits = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return FORBIDDEN_APIS.filter(([re]) => re.test(text)).map(([, why]) => `${f}: ${why}`);
    });
    expect(hits).toEqual([]);
  });

  it("the guard itself catches an unsupported operator", () => {
    expect([..."{ $where: 'x', $set: {} }".matchAll(/\$[a-zA-Z]+\b/g)].map((m) => m[0]).filter((o) => !ALLOWED_OPERATORS.has(o))).toEqual(["$where"]);
  });
});
