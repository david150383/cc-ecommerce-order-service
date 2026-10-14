import { OpenApiGeneratorV31, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "../lib/zod.js";
import {
  AdminListQuery,
  CreateOrderRequest,
  FulfillmentRequest,
  InternalOrderView,
  ListQuery,
  OrderPage,
  OrderResponse,
  TransitionRequest,
} from "../orders/order.schemas.js";

// Built from the SAME zod schemas that validate requests; a test compares it with openapi/openapi.json.

const Problem = z
  .object({ type: z.string(), title: z.string(), status: z.number().int(), code: z.string(), instance: z.string() })
  .catchall(z.unknown())
  .openapi("Problem");

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const problem = (description: string) => ({ description, content: { "application/problem+json": { schema: Problem } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const OrderIdParams = z.object({ orderId: z.uuid() });
const IdempotencyHeader = z.object({ "idempotency-key": z.string().min(1).max(255) });

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  const secured = [{ [bearer.name]: [] }];

  const paths: RouteConfig[] = [
    {
      method: "post", path: "/api/v1/orders", tags: ["orders"], security: secured,
      summary: "Create a PENDING order (service token: Saga Orchestrator). Prices are looked up, never accepted.",
      request: { ...body(CreateOrderRequest), headers: IdempotencyHeader },
      responses: {
        201: json(OrderResponse, "Created"), 200: json(OrderResponse, "Replayed (Idempotency-Replayed: true)"),
        400: problem("VALIDATION_FAILED / IDEMPOTENCY_KEY_REQUIRED"), 401: problem("UNAUTHENTICATED"), 403: problem("FORBIDDEN"),
        422: problem("PRODUCT_UNAVAILABLE, CURRENCY_MISMATCH, UNSUPPORTED_CURRENCY, INVALID_COUPON, IDEMPOTENCY_KEY_REUSED"),
        503: problem("DEPENDENCY_UNAVAILABLE (Product or Auth unreachable)"),
      },
    },
    {
      method: "get", path: "/api/v1/orders", tags: ["orders"], security: secured,
      summary: "Orders: customers get their own, admins get all (cursor pagination, newest first)",
      request: { query: ListQuery }, responses: { 200: json(OrderPage, "Orders") },
    },
    {
      method: "get", path: "/api/v1/orders/my-orders", tags: ["orders"], security: secured,
      summary: "The caller's own orders", request: { query: ListQuery }, responses: { 200: json(OrderPage, "Orders") },
    },
    {
      method: "get", path: "/api/v1/orders/{orderId}", tags: ["orders"], security: secured,
      summary: "Order detail (owner or admin; others get 404)", request: { params: OrderIdParams },
      responses: { 200: json(OrderResponse, "Order"), 404: problem("NOT_FOUND") },
    },
    {
      method: "post", path: "/api/v1/orders/{orderId}/cancel", tags: ["orders"], security: secured,
      summary: "Cancel before payment, or request cancellation after payment (idempotent)", request: { params: OrderIdParams },
      responses: { 200: json(OrderResponse, "Cancelled or CANCELLATION_PENDING"), 409: problem("CANNOT_CANCEL") },
    },
    {
      method: "get", path: "/api/v1/admin/orders", tags: ["admin"], security: secured,
      summary: "Search all orders (admin)", request: { query: AdminListQuery }, responses: { 200: json(OrderPage, "Orders") },
    },
    {
      method: "patch", path: "/api/v1/admin/orders/{orderId}/status", tags: ["admin"], security: secured,
      summary: "Fulfillment: PROCESSING, SHIPPED, DELIVERED (admin)", request: { params: OrderIdParams, ...body(FulfillmentRequest) },
      responses: { 200: json(OrderResponse, "Updated"), 409: problem("INVALID_TRANSITION") },
    },
    {
      method: "get", path: "/internal/v1/orders/{orderId}", tags: ["internal"], security: secured,
      summary: "Authoritative amount and owner (service token)", request: { params: OrderIdParams },
      responses: { 200: json(InternalOrderView, "Order summary"), 404: problem("NOT_FOUND") },
    },
    {
      method: "post", path: "/internal/v1/orders/{orderId}/transitions", tags: ["internal"], security: secured,
      summary: "Saga-driven status change (service token); idempotent", request: { params: OrderIdParams, ...body(TransitionRequest) },
      responses: { 200: json(z.object({ order: z.unknown(), changed: z.boolean() }), "Applied or already in that status"), 409: problem("INVALID_TRANSITION") },
    },
  ];
  paths.forEach((p) => registry.registerPath(p));

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Order Service", version: "1.0.0", description: "Orders, price snapshots and the order lifecycle. Semantics: docs/api.md" },
    servers: [{ url: "http://localhost:4004" }],
  });
}
