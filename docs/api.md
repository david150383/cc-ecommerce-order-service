# Order Service API (v1)

Base URL (local): `http://localhost:4004`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Machine-readable spec: [`openapi/openapi.json`](../openapi/openapi.json), served at `/openapi.json`, Swagger UI at
`/docs`. It is generated from the Zod schemas that validate requests; a test fails if the committed file is stale.

Status: **implemented** (Phase 2). Phase 3 adds the SQS consumer for `OrderStatusTransitionRequested` (same
`OrderService.transition`) and the outbox relay.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/orders` | service token (aud `ecommerce-order-service`) | `Idempotency-Key` **required** | Create a PENDING order from cart lines; prices are looked up, never trusted |
| GET | `/api/v1/orders` | customer (own) / admin | n/a | List orders (customers see only their own) |
| GET | `/api/v1/orders/my-orders` | customer | n/a | Current user's order history |
| GET | `/api/v1/orders/{orderId}` | owner or admin | n/a | Order detail with status history |
| POST | `/api/v1/orders/{orderId}/cancel` | owner or admin | idempotent | Request cancellation (allowed only before SHIPPED) |
| GET | `/api/v1/admin/orders` | admin | n/a | Filter by `status`, `customerId`, `createdFrom`/`createdTo`; cursor pagination |
| PATCH | `/api/v1/admin/orders/{orderId}/status` | admin | idempotent | Fulfillment: `PROCESSING`, `SHIPPED`, `DELIVERED` |
| GET | `/internal/v1/orders/{orderId}` | service token | n/a | Authoritative amount and owner, used by Payment |
| POST | `/internal/v1/orders/{orderId}/transitions` | service token | idempotent (same target = no-op) | Saga-driven status change |

## POST /api/v1/orders

```json
// request (from the Saga Orchestrator, on behalf of customerId)
{
  "customerId": "uuid",
  "currency": "INR",
  "items": [{ "sku": "TSHIRT-BLK-M", "quantity": 2 }],
  "shippingAddress": { "name": "Asha Rao", "line1": "12 MG Road", "city": "Bengaluru",
                       "postalCode": "560001", "country": "IN", "phone": "+919800000000" },
  "couponCode": null
}
// 201
{
  "order": {
    "id": "uuid", "customerId": "uuid", "status": "PENDING", "sagaId": "uuid",
    "items": [{ "sku": "TSHIRT-BLK-M", "productId": "uuid", "name": "Classic Tee, Black, M",
                "quantity": 2, "unitPrice": { "amountMinor": 49900, "currency": "INR" },
                "lineTotal": { "amountMinor": 99800, "currency": "INR" } }],
    "totals": {
      "subtotal": { "amountMinor": 99800, "currency": "INR" },
      "discount": { "amountMinor": 0, "currency": "INR" },
      "tax":      { "amountMinor": 17964, "currency": "INR" },
      "shipping": { "amountMinor": 0, "currency": "INR" },
      "grandTotal": { "amountMinor": 117764, "currency": "INR" }
    },
    "createdAt": "2026-10-13T09:30:00.000Z"
  }
}
```

- Item names, SKUs and unit prices are fetched from the Product Service at creation time
  (`POST /internal/v1/products/price-lookup` with a service token from Auth's client-credentials grant)
  and stored as an **immutable snapshot**. Later catalog changes never alter an existing order.
- Fields the caller is not allowed to set (prices, totals, status) are rejected, not silently ignored.
- Errors: `400 VALIDATION_FAILED | IDEMPOTENCY_KEY_REQUIRED`, `422 PRODUCT_UNAVAILABLE` (with `unavailableSkus`),
  `422 CURRENCY_MISMATCH | UNSUPPORTED_CURRENCY | INVALID_COUPON | IDEMPOTENCY_KEY_REUSED`,
  `503 DEPENDENCY_UNAVAILABLE` (Product or Auth unreachable; nothing is created).

### Pricing rules (all integer minor units, BigInt arithmetic)

1. line subtotal = unit price × quantity; subtotal = Σ line subtotals
2. **coupon** (`COUPONS` config): discount = ⌊subtotal × percentBps / 10000⌋, optionally capped by
   `maxDiscountMinor` and gated by `minSubtotalMinor`
3. the discount is **allocated across lines** in proportion to their subtotals with the
   *largest-remainder* method, so per-line discounts are integers that sum exactly to the order discount
4. **tax per line** = round-half-up((line subtotal − line discount) × `TAX_RATE_BPS` / 10000)
5. **shipping** = 0 if (subtotal − discount) ≥ `FREE_SHIPPING_THRESHOLD_MINOR`, else `SHIPPING_FEE_MINOR`
6. grand total = subtotal − discount + tax + shipping

Money is stored as BSON **Int64** (`long`) and read back as JS `bigint`; it is never a double. The API
serializes it as JSON numbers and refuses values beyond `Number.MAX_SAFE_INTEGER`.

### Idempotency

The same key returns the original order (`200`, `Idempotency-Replayed: true`) without calling the Product
Service again. The same key with a different request (compared by a canonical-JSON hash) returns `422`. A unique
index on the key makes concurrent duplicates safe: tested with 10 simultaneous requests → one order.

## Status transitions

Validated by a single transition table. Anything not listed is rejected with `409 INVALID_TRANSITION`.

| From | Allowed to |
|---|---|
| PENDING | INVENTORY_RESERVING, CANCELLED, FAILED |
| INVENTORY_RESERVING | INVENTORY_RESERVED, CANCELLED, FAILED |
| INVENTORY_RESERVED | PAYMENT_PENDING, CANCELLED |
| PAYMENT_PENDING | PAYMENT_PROCESSING, PAYMENT_SUCCEEDED, CANCELLED |
| PAYMENT_PROCESSING | PAYMENT_SUCCEEDED, CANCELLED |
| PAYMENT_SUCCEEDED | CONFIRMED, REFUND_PENDING |
| CONFIRMED | PROCESSING, CANCELLATION_PENDING |
| PROCESSING | SHIPPED, CANCELLATION_PENDING |
| SHIPPED | DELIVERED |
| CANCELLATION_PENDING | REFUND_PENDING, CANCELLED, CONFIRMED (cancellation rejected) |
| REFUND_PENDING | REFUNDED |
| DELIVERED, CANCELLED, FAILED, REFUNDED | (terminal) |

Every transition is **one atomic document update**, conditional on the status and version that were read
(compare-and-set). It sets the new status, appends `{ from, to, reason, actor, correlationId, at }` to
`statusHistory`, and queues the outbox events together. If another writer got there first, the update
matches nothing and the transition is re-evaluated (at most 3 times, then `409 CONCURRENT_MODIFICATION`).
Moving to the current status is a successful no-op (`changed: false`).

## Cancellation (`POST /api/v1/orders/{orderId}/cancel`)

| Current status | Result |
|---|---|
| PENDING, INVENTORY_RESERVING, INVENTORY_RESERVED, PAYMENT_PENDING | `CANCELLED` (reason `CUSTOMER_REQUESTED`, or `ADMIN`); the saga releases stock on `OrderCancelled` |
| CONFIRMED, PROCESSING | `CANCELLATION_PENDING` (money was taken; a refund flow follows in Phase 4) |
| CANCELLED, CANCELLATION_PENDING | `200`, unchanged (idempotent) |
| PAYMENT_PROCESSING, PAYMENT_SUCCEEDED, SHIPPED, DELIVERED, … | `409 CANNOT_CANCEL` |

## Authorization

- Customers: only orders where `customerId == token.sub`. Otherwise **404** (not 403), so the
  existence of other customers' orders is not revealed.
- Admins (`roles` contains `admin`): all orders.
- Services: tokens with role `service` **and** audience `ecommerce-order-service` (minted for this service);
  a service token minted for another service is rejected.
