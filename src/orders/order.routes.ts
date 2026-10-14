import { type Request, type Response, Router } from "express";
import { HttpProblem } from "../lib/problem.js";
import { requireRole } from "../middleware/authenticate.js";
import { parse } from "../middleware/validate.js";
import type { TokenVerifier } from "../security/token-verifier.js";
import {
  AdminListQuery,
  CreateOrderRequest,
  FulfillmentRequest,
  ListQuery,
  OrderIdParam,
  toOrderDto,
  TransitionRequest,
} from "./order.schemas.js";
import type { ActorMeta, OrderService, Viewer } from "./order.service.js";
import { toSafeNumber } from "./pricing.js";

function meta(res: Response): ActorMeta {
  return { actor: res.locals.principal!.subject, correlationId: res.locals.correlationId as string };
}

function viewer(res: Response): Viewer {
  const p = res.locals.principal!;
  return { subject: p.subject, isAdmin: p.roles.has("admin") };
}

function idempotencyKey(req: Request): string {
  const key = req.get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  }
  return key;
}

export function orderRouters(orders: OrderService, verifier: TokenVerifier) {
  const customer = requireRole(verifier, "customer", "admin");
  const admin = requireRole(verifier, "admin");
  const service = requireRole(verifier, "service");

  // ---------------------------------------------------------------- public API
  const api = Router();

  // Created by the Saga Orchestrator on behalf of a customer (Phase 3), never by the browser directly.
  api.post("/orders", service, async (req, res) => {
    const body = parse(CreateOrderRequest, req.body);
    const { order, replayed } = await orders.create(idempotencyKey(req), body, meta(res));
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    else res.setHeader("Location", `/api/v1/orders/${order._id}`);
    res.status(replayed ? 200 : 201).json({ order: toOrderDto(order) });
  });

  // Customers always see only their own orders; admins see all.
  const listOwnOrAll = async (req: Request, res: Response, forceOwn: boolean) => {
    const q = parse(ListQuery, req.query);
    const v = viewer(res);
    const { orders: rows, nextCursor } = await orders.list({
      ...(forceOwn || !v.isAdmin ? { customerId: v.subject } : {}),
      cursor: q.cursor,
      limit: q.limit,
    });
    res.json({ data: rows.map(toOrderDto), page: { limit: q.limit, nextCursor } });
  };
  api.get("/orders", customer, (req, res) => listOwnOrAll(req, res, false));
  // Declared before /orders/:orderId so "my-orders" is not parsed as an id.
  api.get("/orders/my-orders", customer, (req, res) => listOwnOrAll(req, res, true));

  api.get("/orders/:orderId", customer, async (req, res) => {
    const { orderId } = parse(OrderIdParam, req.params);
    res.json({ order: toOrderDto(await orders.get(orderId, viewer(res))) });
  });

  api.post("/orders/:orderId/cancel", customer, async (req, res) => {
    const { orderId } = parse(OrderIdParam, req.params);
    res.json({ order: toOrderDto(await orders.cancel(orderId, viewer(res), meta(res))) });
  });

  api.get("/admin/orders", admin, async (req, res) => {
    const q = parse(AdminListQuery, req.query);
    const { orders: rows, nextCursor } = await orders.list({
      status: q.status,
      customerId: q.customerId,
      createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
      createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
      cursor: q.cursor,
      limit: q.limit,
    });
    res.json({ data: rows.map(toOrderDto), page: { limit: q.limit, nextCursor } });
  });

  api.patch("/admin/orders/:orderId/status", admin, async (req, res) => {
    const { orderId } = parse(OrderIdParam, req.params);
    const body = parse(FulfillmentRequest, req.body);
    const { order } = await orders.transition(orderId, body.toStatus, body.reason, meta(res));
    res.json({ order: toOrderDto(order) });
  });

  // ---------------------------------------------------------------- internal API (service tokens only)
  const internal = Router();

  // Authoritative amount and owner, e.g. for the Payment Service. Never trust a caller-supplied amount.
  internal.get("/orders/:orderId", service, async (req, res) => {
    const { orderId } = parse(OrderIdParam, req.params);
    const o = await orders.get(orderId, null);
    res.json({
      id: o._id,
      customerId: o.customerId,
      status: o.status,
      total: { amountMinor: toSafeNumber(o.grandTotalMinor), currency: o.currency },
      version: o.version,
    });
  });

  // Saga-driven status changes. Phase 3 also delivers these as OrderStatusTransitionRequested commands.
  internal.post("/orders/:orderId/transitions", service, async (req, res) => {
    const { orderId } = parse(OrderIdParam, req.params);
    const body = parse(TransitionRequest, req.body);
    if (body.toStatus === "CANCELLED" && !body.cancellationReason) {
      throw new HttpProblem(400, "VALIDATION_FAILED", "cancellationReason is required when cancelling", undefined, [
        { path: "cancellationReason", message: "Required when toStatus is CANCELLED" },
      ]);
    }
    const { order, changed } = await orders.transition(orderId, body.toStatus, body.reason, meta(res), body.cancellationReason);
    res.json({ order: toOrderDto(order), changed });
  });

  return { api, internal };
}
