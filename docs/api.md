# Order Service API (v1)

Base URL (local): `http://localhost:4004`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Status: **documented, not yet implemented** (Phase 2). Implemented today: health endpoints only.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/orders` | service token (saga) | `Idempotency-Key` **required** | Create a PENDING order from cart lines; prices are looked up, never trusted |
| GET | `/api/v1/orders` | customer (own) / admin | n/a | List orders (customers see only their own) |
| GET | `/api/v1/orders/my-orders` | customer | n/a | Current user's order history |
| GET | `/api/v1/orders/{orderId}` | owner or admin | n/a | Order detail with status history |
| POST | `/api/v1/orders/{orderId}/cancel` | owner or admin | idempotent | Request cancellation (allowed only before SHIPPED) |
| GET | `/api/v1/admin/orders` | admin | n/a | Search/filter all orders |
| GET | `/internal/v1/orders/{orderId}` | service token | n/a | Authoritative amount and owner, used by Payment |

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

- Item names, SKUs and unit prices are fetched from the Product Service at creation time and
  stored as an **immutable snapshot**. Later catalog changes never alter an existing order.
- Tax: basis points per line, rounded half-up once per line (`taxRateBps: 1800`).
- Errors: `400 VALIDATION_FAILED`, `409 IDEMPOTENCY_IN_PROGRESS`, `422 PRODUCT_UNAVAILABLE`
  (unknown/unpublished SKU), `422 CURRENCY_MISMATCH`, `503 DEPENDENCY_UNAVAILABLE` (Product down).

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

Every transition appends `{ from, to, reason, actor, correlationId, at }` to the order's
`statusHistory` (audit trail).

## Authorization

- Customers: only orders where `customerId == token.sub`. Otherwise **404** (not 403), so the
  existence of other customers' orders is not revealed.
- Admins (`roles` contains `admin`): all orders.
- Totals, prices and statuses sent by the browser are ignored.
