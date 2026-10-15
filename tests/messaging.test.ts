import { SNSClient } from "@aws-sdk/client-sns";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxRelay } from "../src/messaging/outbox-relay.js";
import { createMessaging } from "../src/messaging/runner.js";
import { AWS_ENDPOINT, command, createTestTopology, receiveAll, sendCommand, sns, sqs, type TestTopology } from "./floci.js";
import { address, auth, buildTestContext, newId, resetDatabase } from "./helpers.js";
import { deleteTestQueues, deleteTestTopics } from "./test-cleanup.js";

let topo: TestTopology;
let ctx: Awaited<ReturnType<typeof buildTestContext>>;
let messaging: ReturnType<typeof createMessaging>;

beforeAll(async () => {
  topo = await createTestTopology();
});
afterAll(async () => {
  await deleteTestTopics(sns, topo.prefix);
  await deleteTestQueues(sqs, topo.prefix);
});

beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext({
    LOG_LEVEL: "silent",
    AWS_ENDPOINT_URL: AWS_ENDPOINT,
    EVENTS_TOPIC_ARN: topo.topicArn,
    COMMANDS_QUEUE_NAME: topo.commandsQueue,
    CONSUMER_WAIT_TIME_SECONDS: "1",
  });
  ctx.catalog.set("TEE-1", 50_000);
  // Not started: the tests drive the relay and the consumer step by step.
  messaging = createMessaging(ctx.env, ctx.logger, ctx.orders, ctx.service);
  await receiveAll(topo.probeUrl, 0);
});

async function createOrder(sagaId = newId()): Promise<string> {
  const res = await request(ctx.app)
    .post("/api/v1/orders")
    .set(await auth(["service"], "ecommerce-saga-orchestrator"))
    .set("Idempotency-Key", newId())
    .send({ customerId: newId(), sagaId, currency: "INR", items: [{ sku: "TEE-1", quantity: 1 }], shippingAddress: address });
  expect(res.status).toBe(201);
  return res.body.order.id;
}

const transitionCmd = (orderId: string, toStatus: string, reason = "saga step") =>
  command("OrderStatusTransitionRequested", { orderId, toStatus, reason });

async function deliver(cmd: object | string) {
  await sendCommand(topo.commandsUrl, cmd);
  const handled = await messaging.consumer.pollOnce();
  await messaging.relay.publishPending();
  return handled;
}

const published = async () => (await receiveAll(topo.probeUrl)).map((m) => JSON.parse(m.Body!) as { messageId: string; messageType: string; causationId: string | null; payload: Record<string, unknown> });

describe("outbox relay (embedded outbox)", () => {
  it("publishes a document's pending events with the messageType attribute and removes them", async () => {
    const id = await createOrder();
    expect(await messaging.relay.publishPending()).toBe(1);

    const received = await receiveAll(topo.probeUrl);
    expect(received.map((m) => JSON.parse(m.Body!).messageType)).toEqual(["OrderCreated"]);
    expect(received[0]!.MessageAttributes?.messageType?.StringValue).toBe("OrderCreated");
    const doc = await ctx.orders.findById(id).lean();
    expect(doc!.outbox).toEqual([]);
    expect(doc!.relayLeaseUntil).toBeNull();
    expect(await messaging.relay.publishPending()).toBe(0);
  });

  it("keeps events when SNS is unreachable, backs off via the lease, and publishes later", async () => {
    const id = await createOrder();
    const broken = new OutboxRelay(ctx.orders, new SNSClient({ region: "us-east-1", endpoint: "http://127.0.0.1:1", maxAttempts: 1 }), topo.topicArn, 1000, ctx.logger);
    expect(await broken.publishPending()).toBe(0);
    const doc = await ctx.orders.findById(id).lean();
    expect(doc!.outbox).toHaveLength(1);
    expect(doc!.relayLeaseUntil!.getTime()).toBeGreaterThan(Date.now()); // backing off

    expect(await messaging.relay.publishPending()).toBe(0); // lease held: not claimable yet
    await ctx.orders.updateOne({ _id: id }, { $set: { relayLeaseUntil: new Date(Date.now() - 1) } }); // lease expired
    expect(await messaging.relay.publishPending()).toBe(1);
  });

  it("two relay instances racing publish each event exactly once", async () => {
    for (let i = 0; i < 8; i++) await createOrder();
    const second = createMessaging(ctx.env, ctx.logger, ctx.orders, ctx.service);
    const [a, b] = await Promise.all([messaging.relay.publishPending(), second.relay.publishPending()]);
    expect(a + b).toBe(8);
    const events = await published();
    expect(events).toHaveLength(8);
    expect(new Set(events.map((e) => e.messageId)).size).toBe(8);
  });
});

describe("command consumer", () => {
  it("OrderStatusTransitionRequested moves the order, deletes the message, and links events to the command", async () => {
    const id = await createOrder();
    const cmd = transitionCmd(id, "INVENTORY_RESERVING");
    expect(await deliver(cmd)).toBe(1);

    expect((await ctx.orders.findById(id).lean())!.status).toBe("INVENTORY_RESERVING");
    const changed = (await published()).find((e) => e.messageType === "OrderStatusChanged")!;
    expect(changed.causationId).toBe(cmd.messageId);
    expect(await receiveAll(topo.commandsUrl, 2)).toHaveLength(0);
  });

  it("a duplicate CONFIRMED command does not transition again but re-emits OrderConfirmed", async () => {
    const id = await createOrder();
    for (const s of ["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED"]) await deliver(transitionCmd(id, s));
    const confirm = transitionCmd(id, "CONFIRMED");
    await deliver(confirm);
    await deliver(confirm); // redelivery

    const doc = await ctx.orders.findById(id).lean();
    expect(doc!.statusHistory.filter((h) => h.to === "CONFIRMED")).toHaveLength(1);
    expect((await published()).filter((e) => e.messageType === "OrderConfirmed")).toHaveLength(2);
  });

  it("CANCELLED with a known reason records it; duplicates re-emit OrderCancelled", async () => {
    const id = await createOrder();
    const cancel = transitionCmd(id, "CANCELLED", "OUT_OF_STOCK");
    await deliver(cancel);
    await deliver(cancel);
    expect((await ctx.orders.findById(id).lean())!.cancellationReason).toBe("OUT_OF_STOCK");
    const cancelled = (await published()).filter((e) => e.messageType === "OrderCancelled");
    expect(cancelled.map((e) => e.payload.reason)).toEqual(["OUT_OF_STOCK", "OUT_OF_STOCK"]);
  });

  it("an invalid transition is acknowledged (retrying cannot fix it) and changes nothing", async () => {
    const id = await createOrder();
    expect(await deliver(transitionCmd(id, "SHIPPED"))).toBe(1);
    expect((await ctx.orders.findById(id).lean())!.status).toBe("PENDING");
    expect(await receiveAll(topo.commandsUrl, 2)).toHaveLength(0);
  });

  it("unknown orders and schema-invalid commands are never deleted: they end up in the DLQ", async () => {
    await sendCommand(topo.commandsUrl, transitionCmd(newId(), "CONFIRMED"));
    await sendCommand(topo.commandsUrl, command("OrderStatusTransitionRequested", { orderId: newId(), toStatus: "TELEPORTED" }));
    await sendCommand(topo.commandsUrl, "{not json");
    for (let i = 0; i < 3; i++) {
      expect(await messaging.consumer.pollOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 1_200));
    }
    await messaging.consumer.pollOnce();
    expect(await receiveAll(topo.dlqUrl, 3)).toHaveLength(3);
  });
});

describe("start/stop", () => {
  it("runs both loops and stops gracefully, ending the long poll", async () => {
    const id = await createOrder();
    messaging.start();
    await sendCommand(topo.commandsUrl, transitionCmd(id, "INVENTORY_RESERVING"));
    for (let i = 0; i < 30 && (await ctx.orders.findById(id).lean())!.status !== "INVENTORY_RESERVING"; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const t = Date.now();
    await messaging.stop();
    expect(Date.now() - t).toBeLessThan(3_000);
    expect((await ctx.orders.findById(id).lean())!.status).toBe("INVENTORY_RESERVING");
    void sns;
  });
});
