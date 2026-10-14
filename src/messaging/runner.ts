import type { Env } from "../config/env.js";
import type { Logger } from "../lib/logger.js";
import type { OrderModel } from "../orders/order.model.js";
import type { OrderService } from "../orders/order.service.js";
import { createSns, createSqs } from "./aws.js";
import { CommandConsumer } from "./command-consumer.js";
import { commandParser } from "./command-schemas.js";
import { OrderCommandHandler } from "./order-command-handler.js";
import { OutboxRelay } from "./outbox-relay.js";

/** The outbox relay and command consumer, wired from configuration. */
export function createMessaging(env: Env, logger: Logger, orders: OrderModel, service: OrderService) {
  const relay = new OutboxRelay(orders, createSns(env), env.EVENTS_TOPIC_ARN, env.OUTBOX_POLL_INTERVAL_MS, logger);
  const consumer = new CommandConsumer(
    createSqs(env),
    env.COMMANDS_QUEUE_NAME,
    new OrderCommandHandler(service, logger),
    commandParser(),
    logger,
    env.CONSUMER_WAIT_TIME_SECONDS,
  );
  return {
    relay,
    consumer,
    start() {
      relay.start();
      consumer.start();
      logger.info({ topic: env.EVENTS_TOPIC_ARN, queue: env.COMMANDS_QUEUE_NAME }, "messaging started");
    },
    async stop() {
      await consumer.stop(); // stop taking commands first
      await relay.stop();
    },
  };
}
