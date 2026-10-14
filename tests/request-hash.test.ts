import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash } from "../src/orders/order.service.js";

const base = {
  customerId: "c-1",
  currency: "INR",
  items: [
    { sku: "A-1", quantity: 1 },
    { sku: "B-1", quantity: 2 },
  ],
  shippingAddress: { name: "Asha", line1: "12 MG Road", city: "Bengaluru", postalCode: "560001", country: "IN", phone: "+919800000000" },
};

describe("requestHash", () => {
  it("ignores key order and item order", () => {
    const reordered = {
      shippingAddress: { ...base.shippingAddress },
      items: [{ quantity: 2, sku: "B-1" }, { sku: "A-1", quantity: 1 }],
      currency: "INR",
      customerId: "c-1",
    };
    expect(requestHash(reordered)).toBe(requestHash(base));
  });

  it("changes when ANY nested value changes (a key reused for a different order is detected)", () => {
    const h = requestHash(base);
    expect(requestHash({ ...base, items: [{ sku: "A-1", quantity: 1 }, { sku: "B-1", quantity: 3 }] })).not.toBe(h);
    expect(requestHash({ ...base, items: [{ sku: "A-1", quantity: 1 }, { sku: "C-1", quantity: 2 }] })).not.toBe(h);
    expect(requestHash({ ...base, shippingAddress: { ...base.shippingAddress, city: "Mysuru" } })).not.toBe(h);
    expect(requestHash({ ...base, couponCode: "WELCOME10" })).not.toBe(h);
  });

  it("canonicalJson sorts nested keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
