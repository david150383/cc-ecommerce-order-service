import { z } from "zod";

const jsonArray = <T extends z.ZodType>(name: string, item: T) =>
  z
    .string()
    .default("[]")
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: `${name} must be valid JSON` });
        return z.NEVER;
      }
    })
    .pipe(z.array(item));

// All configuration comes from environment variables and is validated once at
// startup. The process refuses to boot with invalid config, rather than failing
// later on the first request that touches it.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4004),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),

  // Incoming tokens: user tokens (shared audience) and service tokens addressed to this service.
  JWKS_URL: z.url().default("http://localhost:4001/.well-known/jwks.json"),
  JWT_ISSUER: z.string().default("ecommerce-auth-service"),
  JWT_AUDIENCE: z.string().default("ecommerce-api"),
  JWT_SERVICE_AUDIENCE: z.string().default("ecommerce-order-service"),

  // Outgoing calls: client-credentials grant at the Auth Service, then the Product Service.
  AUTH_SERVICE_URL: z.url().default("http://localhost:4001"),
  SERVICE_CLIENT_ID: z.string().default("ecommerce-order-service"),
  SERVICE_CLIENT_SECRET: z.string().min(1).optional(),
  PRODUCT_SERVICE_URL: z.url().default("http://localhost:4002"),
  DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

  // Messaging (SNS/SQS). Disabled: REST still works; outbox entries accumulate in the documents.
  MESSAGING_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  AWS_REGION: z.string().default("us-east-1"),
  /// Local emulator (Floci). Unset in AWS.
  AWS_ENDPOINT_URL: z.url().optional(),
  EVENTS_TOPIC_ARN: z.string().default("arn:aws:sns:us-east-1:000000000000:local-ecommerce-order-events"),
  COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-order-commands"),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  /// SQS long-poll wait (max 20). Tests use 1.
  CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),

  // Pricing policy.
  SUPPORTED_CURRENCIES: z
    .string()
    .default("INR")
    .transform((v) => v.split(",").map((c) => c.trim()))
    .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)),
  TAX_RATE_BPS: z.coerce.number().int().min(0).max(10_000).default(1_800),
  SHIPPING_FEE_MINOR: z.coerce.number().int().min(0).default(4_900),
  FREE_SHIPPING_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(99_900),
  /// e.g. [{"code":"WELCOME10","percentBps":1000,"maxDiscountMinor":50000}]
  COUPONS: jsonArray(
    "COUPONS",
    z.object({
      code: z.string().regex(/^[A-Z0-9]{3,32}$/),
      percentBps: z.number().int().min(1).max(10_000),
      maxDiscountMinor: z.number().int().min(0).optional(),
      minSubtotalMinor: z.number().int().min(0).optional(),
    }),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
