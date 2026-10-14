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

## How events are recorded: an outbox inside the document

MongoDB guarantees atomicity **per document**. So instead of a separate outbox collection (which would need a
multi-document transaction, and therefore a replica set), each order embeds its pending events in an
`outbox` array. The status change, the history entry and the events are written by **one**
`findOneAndUpdate`, so they cannot get out of sync. The Phase 3 relay publishes entries and removes them
(index `ix_orders_outbox_pending`). Command deduplication (Phase 3) uses the same idea: processed command
ids are recorded on the order document in the same update.

All events validate against `events/schemas/*` (tested against real output, not only examples).
