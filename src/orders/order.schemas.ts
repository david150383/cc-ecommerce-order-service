import { z } from "../lib/zod.js";
import type { OrderDoc } from "./order.model.js";
import { toSafeNumber } from "./pricing.js";
import { CANCELLATION_REASONS, ORDER_STATUSES } from "./state-machine.js";

const Sku = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const ShippingAddressSchema = z
  .object({
    name: text(200),
    line1: text(200),
    line2: z.string().trim().max(200).optional(),
    city: text(100),
    state: z.string().trim().max(100).optional(),
    postalCode: text(20),
    country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2"),
    phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "E.164, e.g. +919800000000"),
  })
  .strict()
  .openapi("ShippingAddress");

export const CreateOrderRequest = z
  .object({
    customerId: z.uuid(),
    sagaId: z.uuid().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    items: z
      .array(z.object({ sku: Sku, quantity: z.number().int().min(1).max(1000) }).strict())
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, "Each SKU may appear only once"),
    shippingAddress: ShippingAddressSchema,
    couponCode: z.string().trim().max(32).optional(),
  })
  .strict()
  .openapi("CreateOrderRequest", {
    description: "Sent by the Saga Orchestrator. Prices and totals are NOT accepted: they are looked up.",
  });

export const TransitionRequest = z
  .object({
    toStatus: z.enum(ORDER_STATUSES),
    reason: z.string().trim().min(1).max(200),
    cancellationReason: z.enum(CANCELLATION_REASONS).optional(),
  })
  .strict()
  .openapi("TransitionRequest");

export const FulfillmentRequest = z
  .object({ toStatus: z.enum(["PROCESSING", "SHIPPED", "DELIVERED"]), reason: z.string().trim().min(1).max(200) })
  .strict()
  .openapi("FulfillmentRequest");

export const ListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.uuid().optional(),
  })
  .strict();

export const AdminListQuery = ListQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  customerId: z.uuid().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
}).strict();

export const OrderIdParam = z.object({ orderId: z.uuid() });

const Money = z.object({ amountMinor: z.number().int(), currency: z.string() }).openapi("Money");

export const OrderDto = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    status: z.enum(ORDER_STATUSES),
    currency: z.string(),
    items: z.array(
      z.object({
        sku: z.string(),
        productId: z.string(),
        variantId: z.string(),
        name: z.string(),
        quantity: z.number().int(),
        unitPrice: Money,
        lineSubtotal: Money,
        discount: Money,
        tax: Money,
        lineTotal: Money,
      }),
    ),
    totals: z.object({ subtotal: Money, discount: Money, tax: Money, shipping: Money, grandTotal: Money }),
    taxRateBps: z.number().int(),
    couponCode: z.string().nullable(),
    shippingAddress: ShippingAddressSchema,
    sagaId: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    statusHistory: z.array(
      z.object({ from: z.string().nullable(), to: z.string(), reason: z.string(), actor: z.string(), at: z.iso.datetime() }),
    ),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Order");

export const OrderResponse = z.object({ order: OrderDto }).openapi("OrderResponse");
export const OrderPage = z
  .object({ data: z.array(OrderDto), page: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }) })
  .openapi("OrderPage");

export const InternalOrderView = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    status: z.enum(ORDER_STATUSES),
    total: Money,
    version: z.number().int(),
  })
  .openapi("InternalOrderView");

export type OrderDtoT = z.infer<typeof OrderDto>;

const m = (amount: bigint, currency: string) => ({ amountMinor: toSafeNumber(amount), currency });

export function toOrderDto(o: OrderDoc): OrderDtoT {
  const c = o.currency;
  return {
    id: o._id,
    customerId: o.customerId,
    status: o.status,
    currency: c,
    items: o.items.map((i) => ({
      sku: i.sku,
      productId: i.productId,
      variantId: i.variantId,
      name: i.name,
      quantity: i.quantity,
      unitPrice: m(i.unitPriceMinor, c),
      lineSubtotal: m(i.lineSubtotalMinor, c),
      discount: m(i.discountMinor, c),
      tax: m(i.taxMinor, c),
      lineTotal: m(i.lineTotalMinor, c),
    })),
    totals: {
      subtotal: m(o.subtotalMinor, c),
      discount: m(o.discountMinor, c),
      tax: m(o.taxMinor, c),
      shipping: m(o.shippingMinor, c),
      grandTotal: m(o.grandTotalMinor, c),
    },
    taxRateBps: o.taxRateBps,
    couponCode: o.couponCode,
    shippingAddress: {
      name: o.shippingAddress.name,
      line1: o.shippingAddress.line1,
      ...(o.shippingAddress.line2 && { line2: o.shippingAddress.line2 }),
      city: o.shippingAddress.city,
      ...(o.shippingAddress.state && { state: o.shippingAddress.state }),
      postalCode: o.shippingAddress.postalCode,
      country: o.shippingAddress.country,
      phone: o.shippingAddress.phone,
    },
    sagaId: o.sagaId,
    cancellationReason: o.cancellationReason,
    // correlationId is an internal tracing detail; not shown to customers.
    statusHistory: o.statusHistory.map((h) => ({ from: h.from, to: h.to, reason: h.reason, actor: h.actor, at: new Date(h.at).toISOString() })),
    version: o.version,
    createdAt: new Date(o.createdAt).toISOString(),
    updatedAt: new Date(o.updatedAt).toISOString(),
  };
}
