#!/usr/bin/env node
// Round-trips one row through every repository adapter in this package
// against a real, reachable Postgres — the thing `prisma validate`/
// `tsc` alone can't prove. Not a permanent part of the test suite (no
// live DB in CI yet — see roadmap.md's integration-tests item); run this
// by hand after `pnpm compose:up` + `pnpm prisma:migrate`:
//
//   pnpm --filter @notification-system/infra-postgres build
//   pnpm --filter @notification-system/infra-postgres smoke-test
//
// Exits non-zero on the first failed assertion, printing which adapter
// failed. Cleans up its own rows on success; leaves them on failure so
// you can inspect what happened.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  PostgresTenantRepository,
  PostgresApiKeyRepository,
  PostgresPreferenceRepository,
  PostgresTemplateRepository,
  PostgresNotificationRepository,
  PostgresDedupeRepository,
  PostgresScheduledNotificationRepository,
} from "../dist/index.js";
import {
  TenantId,
  RecipientId,
  NotificationRequestId,
  ApiKeyId,
  TemplateId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";
import { Tenant, ApiKey } from "@notification-system/domain-identity";
import {
  Recipient,
  Preference,
  quietHoursFromClock,
} from "@notification-system/domain-preferences";
import {
  Template,
  TemplateVersion,
} from "@notification-system/domain-templates";
import {
  NotificationRequest,
  DeliveryAttempt,
  ScheduledNotification,
} from "@notification-system/domain-notification";

const prisma = new PrismaClient();
const tenantId = TenantId(randomUUID());
const recipientId = RecipientId(randomUUID());

async function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  console.log("ok");
}

async function main() {
  const tenantRepo = new PostgresTenantRepository(prisma);
  const apiKeyRepo = new PostgresApiKeyRepository(prisma);
  const preferenceRepo = new PostgresPreferenceRepository(prisma);
  const templateRepo = new PostgresTemplateRepository(prisma);
  const notificationRepo = new PostgresNotificationRepository(prisma);
  const dedupeRepo = new PostgresDedupeRepository(prisma);
  const scheduledRepo = new PostgresScheduledNotificationRepository(prisma);

  await step("Tenant round-trip", async () => {
    const tenant = Tenant.create({ id: tenantId, name: "Smoke Test Tenant" });
    await tenantRepo.save(tenant);
    const found = await tenantRepo.findById(tenantId);
    assert.ok(found);
    assert.equal(found.name, "Smoke Test Tenant");
  });

  await step("ApiKey round-trip + findByHashedKey", async () => {
    const apiKey = ApiKey.issue({
      id: ApiKeyId(randomUUID()),
      tenantId,
      hashedKey: `smoke-test-hash-${randomUUID()}`,
    });
    await apiKeyRepo.save(apiKey);
    const found = await apiKeyRepo.findByHashedKey(apiKey.hashedKey);
    assert.ok(found);
    assert.equal(found.tenantId, tenantId);
    assert.equal(found.isValid(), true);
  });

  await step(
    "Recipient + Preference round-trip, including quiet hours",
    async () => {
      const recipient = Recipient.create({
        id: recipientId,
        tenantId,
        phone: "+15555550100",
      });
      await preferenceRepo.saveRecipient(recipient);
      const foundRecipient = await preferenceRepo.findRecipient(recipientId);
      assert.ok(foundRecipient);
      assert.equal(foundRecipient.phone, "+15555550100");

      const preference = Preference.create({
        id: randomUUID(),
        recipientId,
        channel: "sms",
        notificationType: "billing",
        optedIn: true,
        quietHours: quietHoursFromClock(22, 0, 6, 0),
      });
      await preferenceRepo.savePreference(preference);
      const foundPreference = await preferenceRepo.findPreference(
        recipientId,
        "sms",
        "billing",
      );
      assert.ok(foundPreference);
      assert.equal(foundPreference.optedIn, true);
      assert.ok(foundPreference.quietHours);
      assert.equal(foundPreference.quietHours.startMinute, 22 * 60);
      assert.equal(foundPreference.quietHours.endMinute, 6 * 60);
    },
  );

  await step("Template + TemplateVersion round-trip", async () => {
    const templateId = TemplateId(randomUUID());
    const template = Template.create({
      id: templateId,
      tenantId,
      name: `smoke-test-${randomUUID()}`,
      channel: "email",
    });
    await templateRepo.saveTemplate(template);

    const version = TemplateVersion.publish({
      id: TemplateVersionId(randomUUID()),
      templateId,
      locale: "en-US",
      version: 1,
      content: "Hello {{name}}",
    });
    await templateRepo.saveVersion(version);

    const latest = await templateRepo.findLatestVersion(templateId, "en-US");
    assert.ok(latest);
    assert.equal(latest.content, "Hello {{name}}");
  });

  const notificationRequestId = NotificationRequestId(randomUUID());

  await step("NotificationRequest + DeliveryAttempt round-trip", async () => {
    const request = NotificationRequest.accept({
      id: notificationRequestId,
      tenantId,
      recipientId,
      notificationType: "billing",
      idempotencyKey: randomUUID(),
      channel: "sms",
      payload: { body: "hello" },
    });
    await notificationRepo.save(request);

    const sent = request.advanceStatus("sent");
    assert.ok(sent);
    await notificationRepo.save(sent);

    const found = await notificationRepo.findById(notificationRequestId);
    assert.ok(found);
    assert.equal(found.status, "sent");

    const attempt = DeliveryAttempt.record({
      notificationRequestId,
      attemptNumber: 1,
      status: "sent",
    });
    await notificationRepo.saveAttempt(attempt);
    const attempts = await notificationRepo.findAttempts(notificationRequestId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "sent");
  });

  await step("DedupeClaim: first claim succeeds, second fails", async () => {
    const claim = {
      tenantId,
      notificationRequestId,
      recipientId,
      channel: "sms",
      claimedAt: new Date(),
    };
    const first = await dedupeRepo.tryClaim(claim);
    const second = await dedupeRepo.tryClaim(claim);
    assert.equal(first, true, "first claim must succeed");
    assert.equal(second, false, "second claim on the same key must fail");
  });

  await step(
    "ScheduledNotification: schedule, then claimDue picks it up",
    async () => {
      const scheduled = ScheduledNotification.schedule({
        id: randomUUID(),
        tenantId,
        recipientId,
        notificationType: "digest",
        payload: {},
        priority: "standard",
        dueAt: new Date(Date.now() - 1000), // already due
      });
      await scheduledRepo.save(scheduled);

      const claimed = await scheduledRepo.claimDue({
        upTo: new Date(),
        dueMinuteBucket: scheduled.dueMinute % 10,
        bucketCount: 10,
        limit: 10,
      });
      const ours = claimed.find((c) => c.id === scheduled.id);
      assert.ok(ours, "claimDue must pick up the row we just scheduled");
      assert.equal(ours.status, "claimed");
    },
  );

  console.log("\nAll smoke tests passed. Cleaning up...");
  await prisma.dedupeClaim.deleteMany({ where: { tenantId } });
  await prisma.deliveryAttempt.deleteMany({
    where: { notificationRequestId },
  });
  await prisma.notificationRequest.deleteMany({ where: { tenantId } });
  await prisma.scheduledNotification.deleteMany({ where: { tenantId } });
  await prisma.templateVersion.deleteMany({
    where: { template: { tenantId } },
  });
  await prisma.template.deleteMany({ where: { tenantId } });
  await prisma.preference.deleteMany({ where: { recipient: { tenantId } } });
  await prisma.recipient.deleteMany({ where: { tenantId } });
  await prisma.apiKey.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  console.log("Done.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
