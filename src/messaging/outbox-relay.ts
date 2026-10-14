import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { Logger } from "../lib/logger.js";
import type { OrderDoc, OrderModel } from "../orders/order.model.js";

const LEASE_MS = 30_000;

/**
 * Publishes the events embedded in order documents (the outbox array) to SNS.
 *
 * 1. CLAIM one document with pending events by atomically setting a short lease, so relay
 *    instances never work on the same order at once (and a crashed instance's lease expires).
 * 2. Publish its entries in order; $pull each entry as soon as SNS accepted it.
 * 3. Release the lease.
 * A crash between Publish and $pull re-publishes that entry later: at-least-once, consumers
 * dedupe on messageId. $pull/$push are atomic per document, so concurrent status changes
 * (which $push new events) are never lost.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly orders: OrderModel,
    private readonly sns: SNSClient,
    private readonly topicArn: string,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.publishPending()
        .then(() => undefined)
        .catch((err: unknown) => this.logger.error({ err }, "outbox relay tick failed"))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Drains all claimable documents. Returns the number of events published. */
  async publishPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const now = new Date();
      const doc = await this.orders
        .findOneAndUpdate(
          {
            "outbox.createdAt": { $exists: true }, // has pending events (uses ix_orders_outbox_pending)
            $or: [{ relayLeaseUntil: null }, { relayLeaseUntil: { $lt: now } }],
          },
          { $set: { relayLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
          { returnDocument: "after", projection: { outbox: 1 }, sort: { "outbox.createdAt": 1 } },
        )
        .lean<Pick<OrderDoc, "_id" | "outbox">>();
      if (!doc) return total;

      let failed = false;
      for (const entry of doc.outbox) {
        try {
          await this.sns.send(
            new PublishCommand({
              TopicArn: this.topicArn,
              Message: JSON.stringify(entry.envelope),
              MessageAttributes: { messageType: { DataType: "String", StringValue: entry.messageType } },
            }),
          );
        } catch (err) {
          this.logger.warn({ err, orderId: doc._id, messageId: entry.messageId }, "publish failed; will retry after the lease expires");
          failed = true;
          break;
        }
        await this.orders.updateOne({ _id: doc._id }, { $pull: { outbox: { messageId: entry.messageId } } });
        total++;
      }
      if (failed) return total; // keep the lease: back off for LEASE_MS instead of hammering a broken SNS
      await this.orders.updateOne({ _id: doc._id }, { $set: { relayLeaseUntil: null } });
    }
  }
}
