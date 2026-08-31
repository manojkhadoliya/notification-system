import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DeliveryAttempt,
  NotificationRequest,
} from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { buildServer } from "../server.js";
import { authHeader, createTestContext } from "../test-support.js";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    recipientId: randomUUID(),
    notificationType: "order.shipped",
    payload: { message: "hello" },
    ...overrides,
  };
}

describe("POST /v1/notifications", () => {
  it("401s without an Authorization header", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { "idempotency-key": "k1" },
      payload: validBody(),
    });
    assert.equal(response.statusCode, 401);
  });

  it("401s with an unknown API key", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader("not-a-real-key"), "idempotency-key": "k1" },
      payload: validBody(),
    });
    assert.equal(response.statusCode, 401);
  });

  it("400s without an Idempotency-Key header", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: authHeader(ctx.apiKey),
      payload: validBody(),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, "bad_request");
  });

  it("400s on a body missing a required field", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "k1" },
      payload: { notificationType: "order.shipped", payload: {} }, // missing recipientId
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, "validation_error");
  });

  it("202s on a valid request with no channel override, publishing the event and skipping rate limiting", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "k1" },
      payload: validBody(),
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "accepted");
    assert.ok(body.id);

    assert.equal(ctx.fakes.messageBroker.publishedEvents.length, 1);
    const published = ctx.fakes.messageBroker.publishedEvents[0]!;
    assert.equal(published.channel, null);
    assert.equal(published.priority, "standard");
    assert.equal(published.tenantId, ctx.tenantId);
    assert.equal(
      ctx.fakes.rateLimiter.calls.length,
      0,
      "no channel override -> ingest-time rate limiting is skipped",
    );
  });

  it("checks the rate limiter and 429s when a channel override is denied", async () => {
    const ctx = createTestContext();
    ctx.fakes.rateLimiter.allow = false;
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "k1" },
      payload: validBody({ channel: "sms" }),
    });
    assert.equal(response.statusCode, 429);
    assert.equal(ctx.fakes.rateLimiter.calls.length, 1);
    assert.equal(ctx.fakes.rateLimiter.calls[0]!.channel, "sms");
    assert.equal(ctx.fakes.messageBroker.publishedEvents.length, 0);
  });

  it("replays the same 202 for a repeated Idempotency-Key with an identical body, without republishing", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const payload = validBody();

    const first = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "same-key" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "same-key" },
      payload,
    });

    assert.equal(second.statusCode, 202);
    assert.equal(JSON.parse(second.body).id, JSON.parse(first.body).id);
    assert.equal(
      ctx.fakes.messageBroker.publishedEvents.length,
      1,
      "the second call must not republish",
    );
  });

  it("409s when the same Idempotency-Key is reused with a different body", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);

    await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "same-key" },
      payload: validBody({ notificationType: "order.shipped" }),
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/notifications",
      headers: { ...authHeader(ctx.apiKey), "idempotency-key": "same-key" },
      payload: validBody({ notificationType: "order.cancelled" }),
    });

    assert.equal(second.statusCode, 409);
    assert.equal(ctx.fakes.messageBroker.publishedEvents.length, 1);
  });
});

describe("GET /v1/notifications/:id", () => {
  it("404s for an id that doesn't exist", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/notifications/${randomUUID()}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 404);
  });

  it("404s for an id that belongs to a different tenant", async () => {
    const ctx = createTestContext();
    const id = NotificationRequestId(randomUUID());
    ctx.fakes.notificationRepository.seed(
      NotificationRequest.accept({
        id,
        tenantId: TenantId(randomUUID()), // a different tenant
        recipientId: RecipientId(randomUUID()),
        notificationType: "order.shipped",
        idempotencyKey: "k1",
        channel: "sms",
        payload: {},
      }),
    );
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/notifications/${id}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 404);
  });

  it("200s with status and attempt history for an existing, owned request", async () => {
    const ctx = createTestContext();
    const id = NotificationRequestId(randomUUID());
    const request = NotificationRequest.accept({
      id,
      tenantId: ctx.tenantId,
      recipientId: RecipientId(randomUUID()),
      notificationType: "order.shipped",
      idempotencyKey: "k1",
      channel: "sms",
      payload: {},
    });
    const advanced = request.advanceStatus("sent")!;
    ctx.fakes.notificationRepository.seed(advanced, [
      DeliveryAttempt.record({
        notificationRequestId: id,
        attemptNumber: 1,
        status: "sent",
      }),
    ]);

    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/notifications/${id}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.id, id);
    assert.equal(body.channel, "sms");
    assert.equal(body.status, "sent");
    assert.equal(body.attempts.length, 1);
    assert.equal(body.attempts[0].status, "sent");
  });
});
