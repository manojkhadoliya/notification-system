import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildServer } from "../server.js";
import { authHeader, createTestContext } from "../test-support.js";

describe("POST /v1/templates", () => {
  it("201s and returns the created template", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/templates",
      headers: authHeader(ctx.apiKey),
      payload: { name: "order-shipped", channel: "sms" },
    });
    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.ok(body.id);
    assert.equal(body.name, "order-shipped");
    assert.equal(body.channel, "sms");
  });

  it("400s on an invalid channel", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/templates",
      headers: authHeader(ctx.apiKey),
      payload: { name: "order-shipped", channel: "carrier-pigeon" },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe("POST /v1/templates/:id/versions", () => {
  async function createTemplate(
    app: ReturnType<typeof buildServer>,
    apiKey: string,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/templates",
      headers: authHeader(apiKey),
      payload: { name: `template-${randomUUID()}`, channel: "email" },
    });
    return JSON.parse(response.body).id as string;
  }

  it("404s for an unknown template", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "POST",
      url: `/v1/templates/${randomUUID()}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "hello" },
    });
    assert.equal(response.statusCode, 404);
  });

  it("publishes version 1 for a fresh locale, then increments to version 2", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const templateId = await createTemplate(app, ctx.apiKey);

    const first = await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "v1" },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(JSON.parse(first.body).version, 1);

    const second = await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "v2" },
    });
    assert.equal(JSON.parse(second.body).version, 2);
  });

  it("versions each locale independently", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const templateId = await createTemplate(app, ctx.apiKey);

    await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "v1" },
    });
    const frVersion = await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "fr-FR", content: "v1 en francais" },
    });
    assert.equal(
      JSON.parse(frVersion.body).version,
      1,
      "a different locale starts its own version count at 1",
    );
  });
});

describe("GET /v1/templates/:id", () => {
  it("404s for an unknown template", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);
    const response = await app.inject({
      method: "GET",
      url: `/v1/templates/${randomUUID()}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 404);
  });

  it("200s with the template and its full version history", async () => {
    const ctx = createTestContext();
    const app = buildServer(ctx.deps);

    const created = await app.inject({
      method: "POST",
      url: "/v1/templates",
      headers: authHeader(ctx.apiKey),
      payload: { name: "welcome", channel: "email" },
    });
    const templateId = JSON.parse(created.body).id as string;

    await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "v1" },
    });
    await app.inject({
      method: "POST",
      url: `/v1/templates/${templateId}/versions`,
      headers: authHeader(ctx.apiKey),
      payload: { locale: "en-US", content: "v2" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/templates/${templateId}`,
      headers: authHeader(ctx.apiKey),
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.name, "welcome");
    assert.equal(body.versions.length, 2);
    assert.deepEqual(
      body.versions.map((v: { version: number }) => v.version),
      [1, 2],
    );
  });
});
