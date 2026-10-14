import { CreateTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { v7 as uuidv7 } from "uuid";

// Messaging tests run against the local AWS emulator (Floci), like the DB tests run against Postgres.
export const AWS_ENDPOINT = process.env.TEST_AWS_ENDPOINT_URL ?? "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const config = { region: "us-east-1", endpoint: AWS_ENDPOINT };
export const sqs = new SQSClient({ ...config, useQueueUrlAsEndpoint: false });
export const sns = new SNSClient(config);

export interface TestTopology {
  topicArn: string;
  commandsQueue: string;
  commandsUrl: string;
  dlqUrl: string;
  probeUrl: string;
}

/** A private topic + command queue (with DLQ) + probe queue subscribed to the topic. */
export async function createTestTopology(): Promise<TestTopology> {
  const id = uuidv7().slice(-12);
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `test-${id}-events` }));
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `test-${id}-commands-dlq` }));
  const dlqArn = await queueArn(dlq.QueueUrl!);
  const commands = await sqs.send(
    new CreateQueueCommand({
      QueueName: `test-${id}-commands`,
      Attributes: {
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }),
      },
    }),
  );
  const probe = await sqs.send(new CreateQueueCommand({ QueueName: `test-${id}-probe` }));
  await sns.send(
    new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: await queueArn(probe.QueueUrl!),
      Attributes: { RawMessageDelivery: "true" },
    }),
  );
  return {
    topicArn: TopicArn!,
    commandsQueue: `test-${id}-commands`,
    commandsUrl: commands.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    probeUrl: probe.QueueUrl!,
  };
}

async function queueArn(url: string): Promise<string> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  return Attributes!.QueueArn!;
}

/** Drains up to `max` messages, waiting up to `waitSeconds` for the first. */
export async function receiveAll(url: string, waitSeconds = 2, max = 50): Promise<Message[]> {
  const out: Message[] = [];
  for (let i = 0; i < 10 && out.length < max; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: i === 0 ? waitSeconds : 1,
        MessageAttributeNames: ["All"],
      }),
    );
    if (Messages.length === 0) break;
    out.push(...Messages);
  }
  return out;
}

export async function sendCommand(url: string, body: unknown): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: typeof body === "string" ? body : JSON.stringify(body) }));
}

export function command(messageType: string, payload: object, over: Record<string, unknown> = {}) {
  return {
    messageId: uuidv7(),
    messageKind: "command",
    messageType,
    messageVersion: 1,
    producer: "ecommerce-saga-orchestrator",
    occurredAt: new Date().toISOString(),
    correlationId: uuidv7(),
    causationId: null,
    sagaId: uuidv7(),
    idempotencyKey: uuidv7(),
    payload,
    ...over,
  };
}
