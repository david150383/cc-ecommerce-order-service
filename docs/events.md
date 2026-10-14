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
(index `ix_orders_outbox_pending`).

**Relay (Phase 3).** It claims ONE document with pending events by atomically setting `relayLeaseUntil`
(30 s), publishes its entries in order with the `messageType` attribute, `$pull`s each entry once SNS
accepts it, then clears the lease. Several relay instances never publish the same document at once (tested:
two racing relays publish 8 events exactly once; removing the lease makes that test fail). After a failed
publish the lease is kept, so the relay backs off instead of hammering SNS. A crash between Publish and
`$pull` re-publishes the entry later: at-least-once; consumers dedupe on `messageId`.

**Commands (Phase 3).** `OrderStatusTransitionRequested` is validated against this repo's schema and
handled by the same `OrderService.transition` as REST. Duplicate idempotency comes from the state machine
itself: a transition to the current status is a no-op, and for `CONFIRMED`/`CANCELLED` the outcome event
is re-emitted so a re-sending saga gets its answer. Invalid transitions are acknowledged and logged; unknown
orders and schema violations are left for the DLQ.

All events validate against `events/schemas/*` (tested against real output, not only examples).
