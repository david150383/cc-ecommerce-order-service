/**
 * The order lifecycle. Every status change goes through canTransition(); anything not
 * listed is rejected. See docs/api.md#status-transitions.
 */
export const ORDER_STATUSES = [
  "PENDING",
  "INVENTORY_RESERVING",
  "INVENTORY_RESERVED",
  "PAYMENT_PENDING",
  "PAYMENT_PROCESSING",
  "PAYMENT_SUCCEEDED",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLATION_PENDING",
  "CANCELLED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["INVENTORY_RESERVING", "CANCELLED", "FAILED"],
  INVENTORY_RESERVING: ["INVENTORY_RESERVED", "CANCELLED", "FAILED"],
  INVENTORY_RESERVED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_PROCESSING", "PAYMENT_SUCCEEDED", "CANCELLED"],
  PAYMENT_PROCESSING: ["PAYMENT_SUCCEEDED", "CANCELLED"],
  PAYMENT_SUCCEEDED: ["CONFIRMED", "REFUND_PENDING"],
  CONFIRMED: ["PROCESSING", "CANCELLATION_PENDING"],
  PROCESSING: ["SHIPPED", "CANCELLATION_PENDING"],
  SHIPPED: ["DELIVERED"],
  CANCELLATION_PENDING: ["REFUND_PENDING", "CANCELLED", "CONFIRMED"],
  REFUND_PENDING: ["REFUNDED"],
  DELIVERED: [],
  CANCELLED: [],
  FAILED: [],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses from which the customer can still simply walk away (no money taken yet). */
export const CANCELLABLE_BEFORE_PAYMENT: readonly OrderStatus[] = [
  "PENDING",
  "INVENTORY_RESERVING",
  "INVENTORY_RESERVED",
  "PAYMENT_PENDING",
];

/** Statuses where a cancellation needs a refund, so it is only *requested*. */
export const CANCELLABLE_AFTER_PAYMENT: readonly OrderStatus[] = ["CONFIRMED", "PROCESSING"];

export const CANCELLATION_REASONS = [
  "OUT_OF_STOCK",
  "PAYMENT_FAILED",
  "PAYMENT_TIMEOUT",
  "CUSTOMER_REQUESTED",
  "ADMIN",
  "SYSTEM",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];
