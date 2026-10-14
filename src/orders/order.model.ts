import { type Connection, type Model, Schema } from "mongoose";
import { ORDER_STATUSES, type OrderStatus } from "./state-machine.js";

/**
 * One document per order. MongoDB writes to a single document are atomic, so everything
 * that must change together lives IN the document:
 *  - statusHistory: the audit trail of every transition
 *  - outbox: events waiting to be published (the relay arrives in Phase 3)
 * A status change is therefore one conditional findOneAndUpdate. No multi-document
 * transaction (and no replica set) is required.
 *
 * Money: BSON Int64 ("long") via Mongoose's BigInt type; never doubles.
 */

export interface OrderItem {
  sku: string;
  productId: string;
  variantId: string;
  name: string;
  quantity: number;
  unitPriceMinor: bigint;
  lineSubtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  lineTotalMinor: bigint;
}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
  phone: string;
}

export interface StatusHistoryEntry {
  from: OrderStatus | null;
  to: OrderStatus;
  reason: string;
  actor: string;
  correlationId: string;
  at: Date;
}

export interface OutboxEntry {
  messageId: string;
  messageType: string;
  envelope: Record<string, unknown>;
  createdAt: Date;
}

export interface OrderDoc {
  _id: string;
  customerId: string;
  status: OrderStatus;
  currency: string;
  items: OrderItem[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  shippingMinor: bigint;
  grandTotalMinor: bigint;
  taxRateBps: number;
  couponCode: string | null;
  shippingAddress: ShippingAddress;
  sagaId: string | null;
  idempotencyKey: string;
  requestHash: string;
  cancellationReason: string | null;
  statusHistory: StatusHistoryEntry[];
  outbox: OutboxEntry[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const money = { type: BigInt, required: true } as const;

const ItemSchema = new Schema<OrderItem>(
  {
    sku: { type: String, required: true },
    productId: { type: String, required: true },
    variantId: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceMinor: money,
    lineSubtotalMinor: money,
    discountMinor: money,
    taxMinor: money,
    lineTotalMinor: money,
  },
  { _id: false },
);

const OrderSchema = new Schema<OrderDoc>(
  {
    _id: { type: String, required: true },
    customerId: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    items: { type: [ItemSchema], required: true },
    subtotalMinor: money,
    discountMinor: money,
    taxMinor: money,
    shippingMinor: money,
    grandTotalMinor: money,
    taxRateBps: { type: Number, required: true },
    couponCode: { type: String, default: null },
    shippingAddress: {
      name: { type: String, required: true },
      line1: { type: String, required: true },
      line2: { type: String, default: null },
      city: { type: String, required: true },
      state: { type: String, default: null },
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
      phone: { type: String, required: true },
    },
    sagaId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String, required: true },
    cancellationReason: { type: String, default: null },
    statusHistory: [
      {
        _id: false,
        from: { type: String, default: null },
        to: { type: String, required: true },
        reason: { type: String, required: true },
        actor: { type: String, required: true },
        correlationId: { type: String, required: true },
        at: { type: Date, required: true },
      },
    ],
    outbox: [
      {
        _id: false,
        messageId: { type: String, required: true },
        messageType: { type: String, required: true },
        envelope: { type: Schema.Types.Mixed, required: true },
        createdAt: { type: Date, required: true },
      },
    ],
    version: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, versionKey: false, collection: "orders", strict: "throw" },
);

// Same idempotency key = same order, forever.
OrderSchema.index({ idempotencyKey: 1 }, { unique: true, name: "uq_orders_idempotency_key" });
// "My orders", newest first (UUIDv7 ids sort by creation time).
OrderSchema.index({ customerId: 1, _id: -1 }, { name: "ix_orders_customer" });
// Admin filtering by status.
OrderSchema.index({ status: 1, _id: -1 }, { name: "ix_orders_status" });
// The outbox relay (Phase 3) finds documents with pending events.
OrderSchema.index({ "outbox.createdAt": 1 }, { name: "ix_orders_outbox_pending", sparse: true });

export type OrderModel = Model<OrderDoc>;

export function orderModel(connection: Connection): OrderModel {
  return connection.models.Order ?? connection.model<OrderDoc>("Order", OrderSchema);
}
