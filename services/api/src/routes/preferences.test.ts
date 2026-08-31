import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Recipient } from "@notification-system/domain-preferences";
import { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { buildServer } from "../server.js";
import { authHeader, createTestContext } from "../test-support.js";

describe("GET /v1/preferences/:recipientId", () => {
  it("404s for an unknown recipient", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/preferences/${randomUUID()}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 404);
  });

  it("404s for a recipient belonging to a different tenant", async () => {
    const ctx = createTestContext();
    const recipientId = RecipientId(randomUUID());
    await ctx.fakes.preferenceRepository.saveRecipient(
      Recipient.create({ id: recipientId, tenantId: TenantId(randomUUID()) }),
    );
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 404);
  });

  it("200s with an empty array for an existing recipient with no preferences set", async () => {
    const ctx = createTestContext();
    const recipientId = RecipientId(randomUUID());
    await ctx.fakes.preferenceRepository.saveRecipient(
      Recipient.create({ id: recipientId, tenantId: ctx.tenantId }),
    );
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), []);
  });
});

describe("PUT /v1/preferences/:recipientId", () => {
  it("implicitly creates the recipient and the preference on first use", async () => {
    const ctx = createTestContext();
    const recipientId = randomUUID();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
      payload: { channel: "sms", notificationType: "billing", optedIn: true },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.channel, "sms");
    assert.equal(body.optedIn, true);
    assert.equal(body.quietHoursStart, null);

    const recipient = await ctx.fakes.preferenceRepository.findRecipient(
      RecipientId(recipientId),
    );
    assert.ok(recipient);
    assert.equal(recipient!.tenantId, ctx.tenantId);
  });

  it("round-trips quiet hours as HH:MM strings", async () => {
    const ctx = createTestContext();
    const recipientId = randomUUID();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
      payload: {
        channel: "sms",
        notificationType: "billing",
        optedIn: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.quietHoursStart, "22:00");
    assert.equal(body.quietHoursEnd, "07:00");

    const get = await app.inject({
      method: "GET",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
    });
    const [preference] = JSON.parse(get.body);
    assert.equal(preference.quietHoursStart, "22:00");
    assert.equal(preference.quietHoursEnd, "07:00");
  });

  it("400s when only one of quietHoursStart/quietHoursEnd is given", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/preferences/${randomUUID()}`,
      headers: authHeader(ctx.apiKey),
      payload: {
        channel: "sms",
        notificationType: "billing",
        optedIn: true,
        quietHoursStart: "22:00",
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("updates (not duplicates) an existing channel/notificationType preference", async () => {
    const ctx = createTestContext();
    const recipientId = randomUUID();
    const app = buildServer(ctx.deps);

    await app.inject({
      method: "PUT",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
      payload: { channel: "sms", notificationType: "billing", optedIn: true },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
      payload: { channel: "sms", notificationType: "billing", optedIn: false },
    });

    const get = await app.inject({
      method: "GET",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
    });
    const preferences = JSON.parse(get.body);
    assert.equal(
      preferences.length,
      1,
      "the second PUT must update the existing row, not add a second one",
    );
    assert.equal(preferences[0].optedIn, false);
  });

  it("404s when the recipient already exists under a different tenant", async () => {
    const ctx = createTestContext();
    const recipientId = RecipientId(randomUUID());
    await ctx.fakes.preferenceRepository.saveRecipient(
      Recipient.create({ id: recipientId, tenantId: TenantId(randomUUID()) }),
    );
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/preferences/${recipientId}`,
      headers: authHeader(ctx.apiKey),
      payload: { channel: "sms", notificationType: "billing", optedIn: true },
    });
    assert.equal(response.statusCode, 404);
  });
});
