import { v7 as uuidv7 } from "uuid";
import { SERVICE_NAME } from "./logger.js";

// Message envelope; schema in events/schemas/envelope.v1.schema.json.
export function newEventEnvelope(args: {
  messageType: string;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId?: string | null;
  sagaId?: string | null;
}) {
  return {
    messageId: uuidv7(),
    messageKind: "event" as const,
    messageType: args.messageType,
    messageVersion: 1,
    producer: SERVICE_NAME,
    occurredAt: new Date().toISOString(),
    correlationId: args.correlationId,
    causationId: args.causationId ?? null,
    sagaId: args.sagaId ?? null,
    idempotencyKey: null,
    payload: args.payload,
  };
}
