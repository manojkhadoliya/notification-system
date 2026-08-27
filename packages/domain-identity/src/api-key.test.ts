import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiKeyId, TenantId } from "@notification-system/shared-kernel";
import { ApiKey } from "./api-key.js";

function issueTestKey(): ApiKey {
  return ApiKey.issue({
    id: ApiKeyId("11111111-1111-1111-1111-111111111111"),
    tenantId: TenantId("22222222-2222-2222-2222-222222222222"),
    hashedKey: "hashed-value",
  });
}

test("a freshly issued key is valid", () => {
  assert.equal(issueTestKey().isValid(), true);
});

test("revoke() makes the key invalid", () => {
  const revoked = issueTestKey().revoke();
  assert.equal(revoked.isValid(), false);
  assert.notEqual(revoked.revokedAt, null);
});

test("revoke() does not mutate the original instance", () => {
  const key = issueTestKey();
  const revoked = key.revoke();
  assert.equal(key.isValid(), true, "original must be unaffected");
  assert.equal(revoked.isValid(), false);
});

test("revoke() is idempotent — a second call keeps the first revocation time", () => {
  const first = issueTestKey().revoke(new Date("2026-01-01T00:00:00Z"));
  const second = first.revoke(new Date("2027-01-01T00:00:00Z"));
  assert.equal(second.revokedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
});
