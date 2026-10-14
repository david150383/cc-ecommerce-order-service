import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Env } from "../config/env.js";

// Credentials come from the default provider chain (task role in AWS; env vars locally).
export function createSqs(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL && { endpoint: env.AWS_ENDPOINT_URL }),
    // Always use the configured endpoint, not the host inside the QueueUrl (locally http://floci:4566,
    // which resolves only inside Docker).
    useQueueUrlAsEndpoint: false,
  });
}

export function createSns(env: Env): SNSClient {
  return new SNSClient({ region: env.AWS_REGION, ...(env.AWS_ENDPOINT_URL && { endpoint: env.AWS_ENDPOINT_URL }) });
}
