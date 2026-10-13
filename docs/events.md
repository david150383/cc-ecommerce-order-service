# Order Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).

## Produced events (owned here, SNS `order-events`)

| Event | Consumers | When |
|---|---|---|
| `OrderCreated` v1 | none yet (analytics later) | Pending order committed |
| `OrderConfirmed` v1 | Saga, Notification | Transition to CONFIRMED |
| `OrderCancelled` v1 | Saga, Notification | Transition to CANCELLED |
| `OrderStatusChanged` v1 | Notification | Every transition (used for SHIPPED/DELIVERED emails) |

## Consumed commands (owned here, SQS `order-commands`)

| Command | Sender | Idempotency |
|---|---|---|
| `OrderStatusTransitionRequested` v1 | Saga | `idempotencyKey` required. A duplicate whose target status is already the current status succeeds as a no-op. An invalid transition is acknowledged (retrying cannot fix it) and logged at error level. The saga's timeout and reconciliation detect that the expected event never arrived |

## Sent commands (owned by others)

| Command | To | Why |
|---|---|---|
| `NotificationRequested` | `notification-commands` | Admin-triggered custom messages (later phases) |

Processing rules: dedupe by `messageId` in `processed_messages` (unique index) inside the same
MongoDB transaction as the order update. MongoDB transactions require a replica set; the local
`mongo` container is started as a single-node replica set from Phase 3.
