#!/usr/bin/env node
// Round-trips real HTTP requests against a live services/api process —
// the thing app.inject()-based unit tests can't prove (a real TCP
// listener, real Postgres/Kafka/Redis wiring via index.ts). Not part of
// the automated test suite (no live infra in CI yet — see
// roadmap.md's integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/api build
//   pnpm --filter @notification-system/api start &   (reads .env / your shell's env — see .env.example)
//   pnpm --filter @notification-system/api smoke-test
//
// Seeds its own Tenant + ApiKey directly via Prisma — there's no
// self-service signup endpoint (see api-spec.md's "out of scope"). Exits
// non-zero on any assertion failure.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://notification:notification@localhost:5432/notification";

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

function hashApiKey(rawKey) {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

async function seedTenantAndApiKey() {
  const tenantId = randomUUID();
  const rawKey = `smoke-test-${randomUUID()}`;
  await prisma.tenant.create({
    data: { id: tenantId, name: "smoke-test-tenant" },
  });
  await prisma.apiKey.create({
    data: { id: randomUUID(), tenantId, hashedKey: hashApiKey(rawKey) },
  });
  return rawKey;
}

async function main() {
  const rawKey = await seedTenantAndApiKey();
  const authHeaders = {
    Authorization: `Bearer ${rawKey}`,
    "Content-Type": "application/json",
  };

  console.log("POST /v1/templates...");
  const templateRes = await fetch(`${BASE_URL}/v1/templates`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: `smoke-test-${randomUUID()}`,
      channel: "sms",
    }),
  });
  assert.equal(templateRes.status, 201);
  const template = await templateRes.json();

  console.log("POST /v1/templates/:id/versions...");
  const versionRes = await fetch(
    `${BASE_URL}/v1/templates/${template.id}/versions`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ locale: "en-US", content: "hello {{name}}" }),
    },
  );
  assert.equal(versionRes.status, 201);

  console.log("GET /v1/templates/:id (expects the version just published)...");
  const getTemplateRes = await fetch(
    `${BASE_URL}/v1/templates/${template.id}`,
    { headers: authHeaders },
  );
  assert.equal(getTemplateRes.status, 200);
  assert.equal((await getTemplateRes.json()).versions.length, 1);

  console.log("PUT /v1/preferences/:recipientId...");
  const recipientId = randomUUID();
  const putPrefRes = await fetch(`${BASE_URL}/v1/preferences/${recipientId}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      channel: "sms",
      notificationType: "order.shipped",
      optedIn: true,
    }),
  });
  assert.equal(putPrefRes.status, 200);

  console.log("GET /v1/preferences/:recipientId...");
  const getPrefRes = await fetch(`${BASE_URL}/v1/preferences/${recipientId}`, {
    headers: authHeaders,
  });
  assert.equal(getPrefRes.status, 200);
  assert.equal((await getPrefRes.json()).length, 1);

  console.log("POST /v1/notifications...");
  const notifyRes = await fetch(`${BASE_URL}/v1/notifications`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      recipientId,
      notificationType: "order.shipped",
      payload: { message: "hi" },
    }),
  });
  assert.equal(notifyRes.status, 202);
  const notification = await notifyRes.json();
  assert.equal(notification.status, "accepted");

  console.log(
    "GET /v1/notifications/:id (expects 404 — services/projection-notification, which would populate this",
  );
  console.log(
    "  read model from the event this just published, isn't built yet; see this package's README)...",
  );
  const getNotifyRes = await fetch(
    `${BASE_URL}/v1/notifications/${notification.id}`,
    { headers: authHeaders },
  );
  assert.equal(getNotifyRes.status, 404);

  console.log("401 without an Authorization header...");
  const unauthedRes = await fetch(`${BASE_URL}/v1/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", channel: "sms" }),
  });
  assert.equal(unauthedRes.status, 401);

  console.log("\nAll services/api smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
