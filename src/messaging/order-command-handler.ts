import type { Logger } from "../lib/logger.js";
import { HttpProblem } from "../lib/problem.js";
import type { OrderService } from "../orders/order.service.js";
import { CANCELLATION_REASONS, type CancellationReason, type OrderStatus } from "../orders/state-machine.js";
import { type CommandEnvelope, type CommandHandler, InvalidCommand } from "./command-consumer.js";

/** Executes OrderStatusTransitionRequested commands from the saga (same code path as the REST endpoint). */
export class OrderCommandHandler implements CommandHandler {
  constructor(
    private readonly orders: OrderService,
    private readonly logger: Logger,
  ) {}

  async handle(cmd: CommandEnvelope): Promise<void> {
    if (cmd.messageType !== "OrderStatusTransitionRequested") throw new InvalidCommand(`no handler for ${cmd.messageType}`);
    const p = cmd.payload as { orderId: string; toStatus: OrderStatus; reason?: string };
    const meta = { actor: cmd.producer, correlationId: cmd.correlationId, causationId: cmd.messageId };
    const cancellationReason: CancellationReason | undefined =
      p.toStatus === "CANCELLED"
        ? ((CANCELLATION_REASONS as readonly string[]).includes(p.reason ?? "") ? (p.reason as CancellationReason) : "SYSTEM")
        : undefined;
    try {
      const { changed } = await this.orders.transition(p.orderId, p.toStatus, p.reason ?? "saga", meta, cancellationReason);
      // Duplicate (already in the target status): answer again so a re-sending saga is not left waiting.
      if (!changed) await this.orders.reemitOutcome(p.orderId, meta);
    } catch (err) {
      if (!(err instanceof HttpProblem)) throw err; // infrastructure error: retry
      if (err.code === "NOT_FOUND") throw new InvalidCommand(`unknown order ${p.orderId}`);
      if (err.code === "INVALID_TRANSITION") {
        // Retrying cannot fix it. Acknowledge; the saga's timeout + reconciliation notice the missing event.
        this.logger.error({ orderId: p.orderId, toStatus: p.toStatus, correlationId: cmd.correlationId, ...err.extra }, "invalid transition requested");
        return;
      }
      throw err; // CONCURRENT_MODIFICATION etc.: retry
    }
  }
}
