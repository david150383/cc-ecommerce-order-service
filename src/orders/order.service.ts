import { createHash } from "node:crypto";
import type { Env } from "../config/env.js";
import { newEventEnvelope } from "../lib/envelope.js";
import { HttpProblem } from "../lib/problem.js";
import type { Catalog } from "./catalog-client.js";
import type { OrderDoc, OrderModel, OutboxEntry, ShippingAddress, StatusHistoryEntry } from "./order.model.js";
import { type Coupon, priceOrder, toSafeNumber } from "./pricing.js";
import {
  CANCELLABLE_AFTER_PAYMENT,
  CANCELLABLE_BEFORE_PAYMENT,
  type CancellationReason,
  canTransition,
  type OrderStatus,
} from "./state-machine.js";
import { v7 as uuidv7 } from "uuid";

export interface ActorMeta {
  actor: string;
  correlationId: string;
}

export interface CreateOrderInput {
  customerId: string;
  sagaId?: string | undefined;
  currency: string;
  items: { sku: string; quantity: number }[];
  shippingAddress: ShippingAddress;
  couponCode?: string | undefined;
}

export interface Viewer {
  subject: string;
  isAdmin: boolean;
}

const MAX_TRANSITION_ATTEMPTS = 3;

/** JSON with object keys sorted at every level, so equal requests always serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(input: CreateOrderInput): string {
  // Item order does not change the meaning of an order, so it does not change the hash.
  const normalized = { ...input, items: [...input.items].sort((a, b) => a.sku.localeCompare(b.sku)) };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

export class OrderService {
  constructor(
    private readonly orders: OrderModel,
    private readonly catalog: Catalog,
    private readonly env: Env,
  ) {}

  // ===================================================================== create

  /**
   * Creates a PENDING order with an immutable snapshot of names and CURRENT prices from the
   * Product Service. Idempotent per key; the unique index makes concurrent duplicates safe.
   */
  async create(idempotencyKey: string, input: CreateOrderInput, meta: ActorMeta): Promise<{ order: OrderDoc; replayed: boolean }> {
    const hash = requestHash(input);
    const existing = await this.orders.findOne({ idempotencyKey }).lean<OrderDoc>();
    if (existing) return { order: this.assertSameRequest(existing, hash), replayed: true };

    if (!this.env.SUPPORTED_CURRENCIES.includes(input.currency)) {
      throw new HttpProblem(422, "UNSUPPORTED_CURRENCY", `Currency ${input.currency} is not supported`);
    }
    const coupon = this.findCoupon(input.couponCode);

    const lookup = await this.catalog.lookup(input.items.map((i) => i.sku));
    if (lookup.unavailable.length > 0) {
      throw new HttpProblem(422, "PRODUCT_UNAVAILABLE", "Some items cannot be purchased", undefined, undefined, {
        extra: { unavailableSkus: lookup.unavailable },
      });
    }
    const bySku = new Map(lookup.items.map((i) => [i.sku, i]));
    const wrongCurrency = lookup.items.filter((i) => i.unitPrice.currency !== input.currency).map((i) => i.sku);
    if (wrongCurrency.length > 0) {
      throw new HttpProblem(422, "CURRENCY_MISMATCH", `Some items are not priced in ${input.currency}`, undefined, undefined, {
        extra: { skus: wrongCurrency },
      });
    }

    const priced = priceOrder(
      input.items.map((i) => ({ sku: i.sku, quantity: i.quantity, unitPriceMinor: BigInt(bySku.get(i.sku)!.unitPrice.amountMinor) })),
      {
        taxRateBps: this.env.TAX_RATE_BPS,
        shippingFeeMinor: BigInt(this.env.SHIPPING_FEE_MINOR),
        freeShippingThresholdMinor: BigInt(this.env.FREE_SHIPPING_THRESHOLD_MINOR),
      },
      coupon,
    );

    const id = uuidv7();
    const now = new Date();
    const order: OrderDoc = {
      _id: id,
      customerId: input.customerId,
      status: "PENDING",
      currency: input.currency,
      items: priced.lines.map((l) => {
        const c = bySku.get(l.sku)!;
        return {
          sku: l.sku,
          productId: c.productId,
          variantId: c.variantId,
          name: c.name,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          lineSubtotalMinor: l.lineSubtotalMinor,
          discountMinor: l.discountMinor,
          taxMinor: l.taxMinor,
          lineTotalMinor: l.lineTotalMinor,
        };
      }),
      subtotalMinor: priced.subtotalMinor,
      discountMinor: priced.discountMinor,
      taxMinor: priced.taxMinor,
      shippingMinor: priced.shippingMinor,
      grandTotalMinor: priced.grandTotalMinor,
      taxRateBps: this.env.TAX_RATE_BPS,
      couponCode: coupon?.code ?? null,
      shippingAddress: input.shippingAddress,
      sagaId: input.sagaId ?? null,
      idempotencyKey,
      requestHash: hash,
      cancellationReason: null,
      statusHistory: [{ from: null, to: "PENDING", reason: "CREATED", actor: meta.actor, correlationId: meta.correlationId, at: now }],
      outbox: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    order.outbox.push(
      this.event(order, "OrderCreated", meta, {
        orderId: id,
        customerId: order.customerId,
        status: "PENDING",
        items: order.items.map((i) => ({
          sku: i.sku,
          productId: i.productId,
          name: i.name,
          quantity: i.quantity,
          unitPrice: this.money(i.unitPriceMinor, order.currency),
        })),
        total: this.money(order.grandTotalMinor, order.currency),
      }),
    );

    try {
      await this.orders.create(order);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // A concurrent request with the same key won the race: return its order.
      const winner = await this.orders.findOne({ idempotencyKey }).lean<OrderDoc>();
      return { order: this.assertSameRequest(winner!, hash), replayed: true };
    }
    return { order, replayed: false };
  }

  // ===================================================================== reads

  async get(id: string, viewer: Viewer | null): Promise<OrderDoc> {
    const order = await this.orders.findById(id).lean<OrderDoc>();
    // Someone else's order is indistinguishable from a missing one (404, not 403).
    if (!order || (viewer && !viewer.isAdmin && order.customerId !== viewer.subject)) {
      throw new HttpProblem(404, "NOT_FOUND", "Order not found");
    }
    return order;
  }

  /** Keyset pagination over UUIDv7 ids (which sort by creation time), newest first. */
  async list(filter: {
    customerId?: string | undefined;
    status?: OrderStatus | undefined;
    createdFrom?: Date | undefined;
    createdTo?: Date | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<{ orders: OrderDoc[]; nextCursor: string | null }> {
    const query: Record<string, unknown> = {};
    if (filter.customerId) query.customerId = filter.customerId;
    if (filter.status) query.status = filter.status;
    if (filter.createdFrom || filter.createdTo) {
      query.createdAt = { ...(filter.createdFrom && { $gte: filter.createdFrom }), ...(filter.createdTo && { $lt: filter.createdTo }) };
    }
    if (filter.cursor) query._id = { $lt: filter.cursor };
    const rows = await this.orders
      .find(query, { outbox: 0 })
      .sort({ _id: -1 })
      .limit(filter.limit + 1)
      .lean<OrderDoc[]>();
    const hasMore = rows.length > filter.limit;
    const orders = hasMore ? rows.slice(0, filter.limit) : rows;
    return { orders, nextCursor: hasMore ? orders[orders.length - 1]!._id : null };
  }

  // ===================================================================== transitions

  /**
   * Moves an order to `to` if the state machine allows it. Atomic compare-and-set on
   * (status, version): status, history and outbox events change together in ONE document
   * write. Idempotent: if the order is already in `to`, nothing happens.
   */
  async transition(
    id: string,
    to: OrderStatus,
    reason: string,
    meta: ActorMeta,
    cancellationReason?: CancellationReason,
  ): Promise<{ order: OrderDoc; changed: boolean }> {
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
      const order = await this.orders.findById(id).lean<OrderDoc>();
      if (!order) throw new HttpProblem(404, "NOT_FOUND", "Order not found");
      if (order.status === to) return { order, changed: false };
      if (!canTransition(order.status, to)) {
        throw new HttpProblem(409, "INVALID_TRANSITION", `Cannot move an order from ${order.status} to ${to}`, undefined, undefined, {
          extra: { from: order.status, to },
        });
      }

      const entry: StatusHistoryEntry = { from: order.status, to, reason, actor: meta.actor, correlationId: meta.correlationId, at: new Date() };
      const events = this.eventsFor(order, to, meta, cancellationReason);
      const updated = await this.orders
        .findOneAndUpdate(
          { _id: id, status: order.status, version: order.version },
          {
            $set: { status: to, ...(to === "CANCELLED" && { cancellationReason: cancellationReason ?? "SYSTEM" }) },
            $inc: { version: 1 },
            $push: { statusHistory: entry, outbox: { $each: events } },
          },
          { returnDocument: "after" },
        )
        .lean<OrderDoc>();
      if (updated) return { order: updated, changed: true };
      // Someone else changed the order between our read and write: re-evaluate.
    }
    throw new HttpProblem(409, "CONCURRENT_MODIFICATION", "The order is being changed concurrently; retry");
  }

  /**
   * Customer/admin cancellation. Before payment the order is simply cancelled (the saga then
   * releases stock). After payment it becomes CANCELLATION_PENDING (a refund is needed).
   */
  async cancel(id: string, viewer: Viewer, meta: ActorMeta): Promise<OrderDoc> {
    const order = await this.get(id, viewer);
    if (order.status === "CANCELLED" || order.status === "CANCELLATION_PENDING") return order;
    const reason: CancellationReason = viewer.isAdmin && order.customerId !== viewer.subject ? "ADMIN" : "CUSTOMER_REQUESTED";
    if (CANCELLABLE_BEFORE_PAYMENT.includes(order.status)) {
      return (await this.transition(id, "CANCELLED", reason, meta, reason)).order;
    }
    if (CANCELLABLE_AFTER_PAYMENT.includes(order.status)) {
      return (await this.transition(id, "CANCELLATION_PENDING", reason, meta)).order;
    }
    throw new HttpProblem(409, "CANNOT_CANCEL", `An order that is ${order.status} cannot be cancelled`, undefined, undefined, {
      extra: { status: order.status },
    });
  }

  // ===================================================================== internals

  private eventsFor(order: OrderDoc, to: OrderStatus, meta: ActorMeta, cancellationReason?: CancellationReason): OutboxEntry[] {
    const events = [
      this.event(order, "OrderStatusChanged", meta, {
        orderId: order._id,
        customerId: order.customerId,
        fromStatus: order.status,
        toStatus: to,
      }),
    ];
    if (to === "CONFIRMED") {
      events.push(
        this.event(order, "OrderConfirmed", meta, {
          orderId: order._id,
          customerId: order.customerId,
          total: this.money(order.grandTotalMinor, order.currency),
        }),
      );
    }
    if (to === "CANCELLED") {
      events.push(
        this.event(order, "OrderCancelled", meta, {
          orderId: order._id,
          customerId: order.customerId,
          previousStatus: order.status,
          reason: cancellationReason ?? "SYSTEM",
        }),
      );
    }
    return events;
  }

  private event(order: OrderDoc, messageType: string, meta: ActorMeta, payload: Record<string, unknown>): OutboxEntry {
    const envelope = newEventEnvelope({ messageType, payload, correlationId: meta.correlationId, sagaId: order.sagaId });
    return { messageId: envelope.messageId, messageType, envelope: envelope as unknown as Record<string, unknown>, createdAt: new Date() };
  }

  private money(amount: bigint, currency: string) {
    return { amountMinor: toSafeNumber(amount), currency };
  }

  private findCoupon(code: string | undefined): Coupon | null {
    if (!code) return null;
    const coupon = this.env.COUPONS.find((c) => c.code === code.trim().toUpperCase());
    if (!coupon) throw new HttpProblem(422, "INVALID_COUPON", "This coupon code is not valid");
    return coupon;
  }

  private assertSameRequest(order: OrderDoc, hash: string): OrderDoc {
    if (order.requestHash !== hash) {
      throw new HttpProblem(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different request");
    }
    return order;
  }
}
