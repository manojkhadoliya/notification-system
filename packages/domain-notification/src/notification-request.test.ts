import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { NotificationRequest } from "./notification-request.js";

function accept(): NotificationRequest {
  return NotificationRequest.accept({
    id: NotificationRequestId("88888888-8888-8888-8888-888888888888"),
    tenantId: TenantId("99999999-9999-9999-9999-999999999999"),
    recipientId: RecipientId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    notificationType: "billing",
    idempotencyKey: "idem-1",
    channel: "email",
    payload: {},
  });
}

test("a newly accepted request starts at status accepted", () => {
  assert.equal(accept().status, "accepted");
});

test("idempotencyKey may be null — a Door-2-originated request has none", () => {
  const req = NotificationRequest.accept({
    id: NotificationRequestId("88888888-8888-8888-8888-888888888888"),
    tenantId: TenantId("99999999-9999-9999-9999-999999999999"),
    recipientId: RecipientId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    notificationType: "billing",
    idempotencyKey: null,
    channel: "email",
    payload: {},
  });
  assert.equal(req.idempotencyKey, null);
});

test("accepted -> sent -> delivered is a valid chain", () => {
  const sent = accept().advanceStatus("sent");
  assert.notEqual(sent, null);
  assert.equal(sent?.status, "sent");

  const delivered = sent?.advanceStatus("delivered");
  assert.notEqual(delivered, null);
  assert.equal(delivered?.status, "delivered");
});

test("advanceStatus returns null for a regressive transition, and does not mutate", () => {
  const req = accept();
  const sent = req.advanceStatus("sent");
  assert.ok(sent);
  const regressed = sent.advanceStatus("accepted");
  assert.equal(regressed, null);
  assert.equal(sent.status, "sent", "original must be unaffected");
});

test("advanceStatus returns null out of a terminal status", () => {
  const delivered = accept().advanceStatus("sent")?.advanceStatus("delivered");
  assert.ok(delivered);
  assert.equal(delivered.advanceStatus("sent"), null);
  assert.equal(delivered.advanceStatus("failed"), null);
});

test("advanceStatus does not mutate the original instance on a valid transition either", () => {
  const req = accept();
  const sent = req.advanceStatus("sent");
  assert.equal(req.status, "accepted");
  assert.equal(sent?.status, "sent");
});
