import { describe, expect, it } from "vitest";
import { allocate, couponDiscount, priceOrder, type PricingPolicy, toSafeNumber } from "../src/orders/pricing.js";

const policy: PricingPolicy = { taxRateBps: 1800, shippingFeeMinor: 4900n, freeShippingThresholdMinor: 99900n };

describe("allocate (largest remainder)", () => {
  it("splits proportionally and sums exactly", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(10n, [50n, 30n, 20n])).toEqual([5n, 3n, 2n]);
    expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
  });

  it("always sums to the total over many random inputs", () => {
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 2_000; i++) {
      const weights = Array.from({ length: 1 + rand(8) }, () => BigInt(1 + rand(1_000_000)));
      const total = BigInt(rand(1_000_000));
      const shares = allocate(total, weights);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(shares.every((s) => s >= 0n)).toBe(true);
    }
  });
});

describe("couponDiscount", () => {
  it("is floored, capped, and respects a minimum subtotal", () => {
    expect(couponDiscount(99_999n, { code: "X", percentBps: 1000 })).toBe(9_999n);
    expect(couponDiscount(1_000_000n, { code: "X", percentBps: 1000, maxDiscountMinor: 50_000 })).toBe(50_000n);
    expect(couponDiscount(10_000n, { code: "X", percentBps: 1000, minSubtotalMinor: 50_000 })).toBe(0n);
  });
});

describe("priceOrder", () => {
  it("computes a simple order: per-line tax, free shipping over the threshold", () => {
    const priced = priceOrder([{ sku: "TEE-1", quantity: 2, unitPriceMinor: 49_900n }], policy, null);
    expect(priced).toMatchObject({
      subtotalMinor: 99_800n,
      discountMinor: 0n,
      taxMinor: 17_964n, // 99_800 × 18 %
      shippingMinor: 4_900n, // 99_800 < 99_900
      grandTotalMinor: 122_664n,
    });
  });

  it("rounds tax half-up per line", () => {
    // 3 × 333 = 999 → 18 % = 179.82 → 180; 1 × 1 → 0.18 → 0
    const priced = priceOrder(
      [
        { sku: "A-1", quantity: 3, unitPriceMinor: 333n },
        { sku: "B-1", quantity: 1, unitPriceMinor: 1n },
      ],
      policy,
      null,
    );
    expect(priced.lines.map((l) => l.taxMinor)).toEqual([180n, 0n]);
    // exactly half: 25 × 18 % = 4.5 → 5
    expect(priceOrder([{ sku: "C-1", quantity: 1, unitPriceMinor: 25n }], policy, null).taxMinor).toBe(5n);
  });

  it("allocates a coupon across lines and taxes the discounted amounts", () => {
    const priced = priceOrder(
      [
        { sku: "A-1", quantity: 1, unitPriceMinor: 60_000n },
        { sku: "B-1", quantity: 1, unitPriceMinor: 40_000n },
      ],
      policy,
      { code: "WELCOME10", percentBps: 1000 },
    );
    expect(priced.discountMinor).toBe(10_000n);
    expect(priced.lines.map((l) => l.discountMinor)).toEqual([6_000n, 4_000n]);
    expect(priced.lines.map((l) => l.taxMinor)).toEqual([9_720n, 6_480n]); // 18 % of 54 000 and 36 000
    // The threshold applies AFTER the discount: 90 000 < 99 900, so shipping is charged.
    expect(priced.shippingMinor).toBe(4_900n);
  });

  it("totals are internally consistent for many random carts", () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 1_000; i++) {
      const lines = Array.from({ length: 1 + rand(5) }, (_, n) => ({
        sku: `SKU-${n}`,
        quantity: 1 + rand(5),
        unitPriceMinor: BigInt(1 + rand(500_000)),
      }));
      const coupon = rand(2) ? { code: "C", percentBps: 1 + rand(5_000) } : null;
      const p = priceOrder(lines, policy, coupon);
      const sum = (f: (l: (typeof p.lines)[number]) => bigint) => p.lines.reduce((a, l) => a + f(l), 0n);
      expect(sum((l) => l.lineSubtotalMinor)).toBe(p.subtotalMinor);
      expect(sum((l) => l.discountMinor)).toBe(p.discountMinor);
      expect(sum((l) => l.taxMinor)).toBe(p.taxMinor);
      expect(p.grandTotalMinor).toBe(p.subtotalMinor - p.discountMinor + p.taxMinor + p.shippingMinor);
      expect(p.lines.every((l) => l.discountMinor <= l.lineSubtotalMinor)).toBe(true);
    }
  });

  it("does not lose precision on very large amounts", () => {
    const priced = priceOrder([{ sku: "GOLD-1", quantity: 1000, unitPriceMinor: 9_007_199_254_740n }], policy, null);
    expect(priced.subtotalMinor).toBe(9_007_199_254_740_000n);
    expect(() => toSafeNumber(priced.grandTotalMinor)).toThrow(/safe integer/);
  });
});
