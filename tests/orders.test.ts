import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { address, auth, buildTestContext, newId, resetDatabase } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;
let ctx: Ctx;
let saga: Record<string, string>;
const customerId = newId();

beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
  ctx.catalog.set("TEE-BLK-M", 49_900, "INR", "Classic Tee, Black, M");
  ctx.catalog.set("MUG-1", 25_000, "INR", "Mug");
  saga = await auth(["service"], "ecommerce-saga-orchestrator");
});

const orderBody = (over: object = {}) => ({
  customerId,
  currency: "INR",
  items: [{ sku: "TEE-BLK-M", quantity: 2 }],
  shippingAddress: address,
  ...over,
});
const create = (body: object = orderBody(), key = newId(), headers = saga) =>
  request(ctx.app).post("/api/v1/orders").set(headers).set("Idempotency-Key", key).send(body);
const transition = (id: string, toStatus: string, extra: object = {}) =>
  request(ctx.app).post(`/internal/v1/orders/${id}/transitions`).set(saga).send({ toStatus, reason: "test", ...extra });

describe("POST /api/v1/orders", () => {
  it("creates a PENDING order with a price snapshot and server-computed totals", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/orders/${res.body.order.id}`);
    const o = res.body.order;
    expect(o).toMatchObject({ customerId, status: "PENDING", currency: "INR", taxRateBps: 1800 });
    expect(o.items[0]).toMatchObject({
      sku: "TEE-BLK-M",
      name: "Classic Tee, Black, M",
      quantity: 2,
      unitPrice: { amountMinor: 49_900, currency: "INR" },
      lineSubtotal: { amountMinor: 99_800, currency: "INR" },
      tax: { amountMinor: 17_964, currency: "INR" },
    });
    expect(o.totals).toEqual({
      subtotal: { amountMinor: 99_800, currency: "INR" },
      discount: { amountMinor: 0, currency: "INR" },
      tax: { amountMinor: 17_964, currency: "INR" },
      shipping: { amountMinor: 4_900, currency: "INR" },
      grandTotal: { amountMinor: 122_664, currency: "INR" },
    });
    expect(o.statusHistory).toEqual([expect.objectContaining({ from: null, to: "PENDING", actor: "ecommerce-saga-orchestrator" })]);
  });

  it("ignores any price the caller tries to send", async () => {
    const res = await create({ ...orderBody(), items: [{ sku: "TEE-BLK-M", quantity: 1, unitPrice: 1 }] });
    expect(res.status).toBe(400); // unknown field rejected outright, not silently dropped
    const sneaky = await create({ ...orderBody(), totals: { grandTotal: 1 } });
    expect(sneaky.status).toBe(400);
  });

  it("snapshots are immutable: later catalog price changes do not affect the order", async () => {
    const created = (await create()).body.order;
    ctx.catalog.set("TEE-BLK-M", 1, "INR", "Renamed");
    const fetched = await request(ctx.app).get(`/api/v1/orders/${created.id}`).set(await auth(["customer"], customerId));
    expect(fetched.body.order.items[0]).toMatchObject({ name: "Classic Tee, Black, M", unitPrice: { amountMinor: 49_900 } });
  });

  it("stores money as BSON Int64, never as a floating-point double", async () => {
    const created = (await create()).body.order;
    const [types] = await ctx.orders.aggregate<{ grand: string; unit: string }>([
      { $match: { _id: created.id } },
      { $project: { grand: { $type: "$grandTotalMinor" }, unit: { $type: { $arrayElemAt: ["$items.unitPriceMinor", 0] } } } },
    ]);
    expect(types).toMatchObject({ grand: "long", unit: "long" });
  });

  it("applies a coupon, allocating the discount across lines", async () => {
    const res = await create(orderBody({ items: [{ sku: "TEE-BLK-M", quantity: 2 }, { sku: "MUG-1", quantity: 1 }], couponCode: "welcome10" }));
    const o = res.body.order;
    expect(o.couponCode).toBe("WELCOME10");
    expect(o.totals.discount.amountMinor).toBe(12_480); // 10 % of 124 800
    expect(o.items.reduce((a: number, i: { discount: { amountMinor: number } }) => a + i.discount.amountMinor, 0)).toBe(12_480);
    expect(o.totals.shipping.amountMinor).toBe(0); // 112 320 ≥ 99 900 after discount
    expect((await create(orderBody({ couponCode: "FAKE" }))).body.code).toBe("INVALID_COUPON");
  });

  it("rejects unavailable products, unsupported currencies and mismatched prices", async () => {
    const missing = await create(orderBody({ items: [{ sku: "GONE-1", quantity: 1 }] }));
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: "PRODUCT_UNAVAILABLE", unavailableSkus: ["GONE-1"] });
    expect((await create(orderBody({ currency: "USD" }))).body.code).toBe("UNSUPPORTED_CURRENCY");
    ctx.catalog.set("USD-ITEM", 100, "USD");
    expect((await create(orderBody({ items: [{ sku: "USD-ITEM", quantity: 1 }] }))).body.code).toBe("CURRENCY_MISMATCH");
  });

  it("returns 503 when the Product Service is down, and creates nothing", async () => {
    ctx.catalog.down = true;
    const res = await create();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(await ctx.orders.countDocuments()).toBe(0);
  });

  it("only the saga (a service token for THIS service) may create orders", async () => {
    expect((await create(orderBody(), newId(), await auth(["customer"], customerId))).status).toBe(403);
    expect((await create(orderBody(), newId(), await auth(["admin"]))).status).toBe(403);
    const forProduct = { Authorization: `Bearer ${await (await import("./helpers.js")).token(["service"], { audience: "ecommerce-product-service" })}` };
    expect((await create(orderBody(), newId(), forProduct)).status).toBe(401);
    expect((await request(ctx.app).post("/api/v1/orders").send(orderBody())).status).toBe(401);
  });

  it("validates input", async () => {
    const res = await create({ customerId: "x", currency: "inr", items: [{ sku: "A-1", quantity: 1 }, { sku: "A-1", quantity: 2 }], shippingAddress: { ...address, phone: "12345" } });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(["customerId", "currency", "items", "shippingAddress.phone"]),
    );
  });
});

describe("idempotent creation", () => {
  it("replays the same order for the same key, and does not call the catalog again", async () => {
    const key = newId();
    const first = await create(orderBody(), key);
    const calls = ctx.catalog.calls;
    const again = await create(orderBody(), key);
    expect(again.status).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body.order.id).toBe(first.body.order.id);
    expect(ctx.catalog.calls).toBe(calls);
  });

  it("rejects the same key with a different order", async () => {
    const key = newId();
    await create(orderBody(), key);
    const res = await create(orderBody({ items: [{ sku: "TEE-BLK-M", quantity: 3 }] }), key);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("concurrent duplicates create exactly one order (unique index)", async () => {
    const key = newId();
    const results = await Promise.all(Array.from({ length: 10 }, () => create(orderBody(), key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await ctx.orders.countDocuments()).toBe(1);
  });
});

describe("reading orders", () => {
  it("customers see only their own orders; others get 404; admins see all", async () => {
    const mine = (await create()).body.order;
    const theirs = (await create(orderBody({ customerId: newId() }))).body.order;
    const me = await auth(["customer"], customerId);

    expect((await request(ctx.app).get(`/api/v1/orders/${mine.id}`).set(me)).status).toBe(200);
    expect((await request(ctx.app).get(`/api/v1/orders/${theirs.id}`).set(me)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/orders/${theirs.id}`).set(await auth(["admin"]))).status).toBe(200);

    const list = await request(ctx.app).get("/api/v1/orders").set(me);
    expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    const mineOnly = await request(ctx.app).get("/api/v1/orders/my-orders").set(await auth(["admin"], customerId));
    expect(mineOnly.body.data.map((o: { id: string }) => o.id)).toEqual([mine.id]);
  });

  it("paginates newest first with a cursor, and admins can filter", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create()).body.order.id);
    const me = await auth(["customer"], customerId);
    const p1 = await request(ctx.app).get("/api/v1/orders?limit=3").set(me);
    const p2 = await request(ctx.app).get(`/api/v1/orders?limit=3&cursor=${p1.body.page.nextCursor}`).set(me);
    expect([...p1.body.data, ...p2.body.data].map((o: { id: string }) => o.id)).toEqual([...ids].reverse());
    expect(p2.body.page.nextCursor).toBeNull();

    await transition(ids[0]!, "CANCELLED", { cancellationReason: "SYSTEM" });
    const cancelled = await request(ctx.app).get("/api/v1/admin/orders?status=CANCELLED").set(await auth(["admin"]));
    expect(cancelled.body.data.map((o: { id: string }) => o.id)).toEqual([ids[0]]);
    expect((await request(ctx.app).get("/api/v1/admin/orders").set(me)).status).toBe(403);
  });

  it("the internal view gives the authoritative amount to services only", async () => {
    const o = (await create()).body.order;
    const res = await request(ctx.app).get(`/internal/v1/orders/${o.id}`).set(saga);
    expect(res.body).toEqual({ id: o.id, customerId, status: "PENDING", total: { amountMinor: 122_664, currency: "INR" }, version: 1 });
    expect((await request(ctx.app).get(`/internal/v1/orders/${o.id}`).set(await auth(["admin"]))).status).toBe(403);
  });
});

describe("status transitions", () => {
  it("follows the saga's happy path and records every step", async () => {
    const id = (await create()).body.order.id;
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED"]) {
      const res = await transition(id, s);
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe(s);
    }
    const o = (await request(ctx.app).get(`/api/v1/orders/${id}`).set(await auth(["admin"]))).body.order;
    expect(o.statusHistory.map((h: { to: string }) => h.to)).toEqual([
      "PENDING", "INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED",
    ]);
    expect(o.version).toBe(6);
  });

  it("rejects transitions the state machine does not allow", async () => {
    const id = (await create()).body.order.id;
    const res = await transition(id, "SHIPPED");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "INVALID_TRANSITION", from: "PENDING", to: "SHIPPED" });
  });

  it("is idempotent: repeating a transition is a no-op that reports changed=false", async () => {
    const id = (await create()).body.order.id;
    expect((await transition(id, "INVENTORY_RESERVING")).body.changed).toBe(true);
    const again = await transition(id, "INVENTORY_RESERVING");
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.order.version).toBe(2);
  });

  it("concurrent conflicting transitions: exactly one wins, history stays consistent", async () => {
    const id = (await create()).body.order.id;
    await transition(id, "INVENTORY_RESERVING");
    // FAILED and INVENTORY_RESERVED are both legal from here, but not from each other.
    const [a, b] = await Promise.all([transition(id, "INVENTORY_RESERVED"), transition(id, "FAILED")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const doc = await ctx.orders.findById(id).lean();
    expect(doc!.statusHistory).toHaveLength(3);
    expect(doc!.version).toBe(3);
  });

  it("admins drive fulfillment only through allowed statuses", async () => {
    const id = (await create()).body.order.id;
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED"]) await transition(id, s);
    const admin = await auth(["admin"]);
    const ship = (toStatus: string) => request(ctx.app).patch(`/api/v1/admin/orders/${id}/status`).set(admin).send({ toStatus, reason: "warehouse" });
    expect((await ship("SHIPPED")).body.code).toBe("INVALID_TRANSITION"); // must be PROCESSING first
    expect((await ship("PROCESSING")).status).toBe(200);
    expect((await ship("SHIPPED")).status).toBe(200);
    expect((await ship("DELIVERED")).body.order.status).toBe("DELIVERED");
    expect((await request(ctx.app).patch(`/api/v1/admin/orders/${id}/status`).set(admin).send({ toStatus: "REFUNDED", reason: "x" })).status).toBe(400);
  });
});

describe("cancellation", () => {
  const cancel = async (id: string, sub = customerId) =>
    request(ctx.app).post(`/api/v1/orders/${id}/cancel`).set(await auth(["customer"], sub));

  it("before payment: cancelled immediately, idempotent", async () => {
    const id = (await create()).body.order.id;
    await transition(id, "INVENTORY_RESERVING");
    const res = await cancel(id);
    expect(res.body.order).toMatchObject({ status: "CANCELLED", cancellationReason: "CUSTOMER_REQUESTED" });
    expect((await cancel(id)).status).toBe(200);
  });

  it("after payment: only a cancellation REQUEST (refund needed)", async () => {
    const id = (await create()).body.order.id;
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED"]) await transition(id, s);
    expect((await cancel(id)).body.order.status).toBe("CANCELLATION_PENDING");
  });

  it("not while payment is being captured, not once shipped, and never someone else's order", async () => {
    const id = (await create()).body.order.id;
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED"]) await transition(id, s);
    expect((await cancel(id)).body).toMatchObject({ code: "CANNOT_CANCEL", status: "PAYMENT_SUCCEEDED" });
    expect((await cancel(id, newId())).status).toBe(404);
  });
});

describe("outbox events", () => {
  const schemasDir = join(import.meta.dirname, "..", "events", "schemas");
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
  for (const f of readdirSync(schemasDir)) ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, f), "utf8")));
  const schemaId = (type: string) =>
    `https://schemas.ecommerce.local/order-service/${type.replace(/(?<!^)([A-Z])/g, "-$1").toLowerCase()}.v1.schema.json`;

  it("each change queues schema-valid events in the SAME document write", async () => {
    const sagaId = newId();
    const id = (await create(orderBody({ sagaId }))).body.order.id;
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED"]) await transition(id, s);
    const other = (await create()).body.order.id;
    await transition(other, "CANCELLED", { cancellationReason: "OUT_OF_STOCK" });

    const docs = await ctx.orders.find({}, { outbox: 1 }).lean();
    const events = docs.flatMap((d) => d.outbox);
    const types = events.map((e) => e.messageType);
    expect(types.filter((t) => t === "OrderCreated")).toHaveLength(2);
    expect(types.filter((t) => t === "OrderStatusChanged")).toHaveLength(6);
    expect(types.filter((t) => t === "OrderConfirmed")).toHaveLength(1);
    expect(types.filter((t) => t === "OrderCancelled")).toHaveLength(1);
    for (const e of events) {
      const validate = ajv.getSchema(schemaId(e.messageType))!;
      validate(e.envelope);
      expect({ type: e.messageType, errors: validate.errors ?? [] }).toEqual({ type: e.messageType, errors: [] });
    }
    const confirmed = events.find((e) => e.messageType === "OrderConfirmed")!;
    expect(confirmed.envelope).toMatchObject({ sagaId, payload: { orderId: id, total: { amountMinor: 122_664, currency: "INR" } } });
  });

  it("outbox entries are never exposed through the API", async () => {
    const id = (await create()).body.order.id;
    const res = await request(ctx.app).get(`/api/v1/orders/${id}`).set(await auth(["admin"]));
    expect(JSON.stringify(res.body)).not.toMatch(/outbox|envelope|requestHash|idempotencyKey/);
  });
});
