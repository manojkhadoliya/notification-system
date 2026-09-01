import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Preference,
  PreferenceRepository,
  Recipient,
} from "@notification-system/domain-preferences";
import type { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { TenantId as makeTenantId } from "@notification-system/shared-kernel";
import { PreferenceAudienceResolver } from "./audience-resolver.js";

class FakePreferenceRepository implements PreferenceRepository {
  constructor(
    private readonly recipientIdsByTenant: Map<string, RecipientId[]>,
  ) {}

  async findRecipient(): Promise<Recipient | null> {
    return null;
  }
  async saveRecipient(): Promise<void> {}
  async findRecipientIdsByTenant(tenantId: TenantId): Promise<RecipientId[]> {
    return this.recipientIdsByTenant.get(tenantId) ?? [];
  }
  async findPreferences(): Promise<Preference[]> {
    return [];
  }
  async findAllPreferences(): Promise<Preference[]> {
    return [];
  }
  async findPreference(): Promise<Preference | null> {
    return null;
  }
  async savePreference(): Promise<void> {}
}

const tenantId = makeTenantId("tenant-1");

test("resolves 'all_recipients' to every recipientId seeded for that tenant", async () => {
  const repository = new FakePreferenceRepository(
    new Map([[tenantId, ["r1", "r2"] as RecipientId[]]]),
  );
  const resolver = new PreferenceAudienceResolver(repository);

  const ids = await resolver.resolve(tenantId, { kind: "all_recipients" });

  assert.deepEqual(ids, ["r1", "r2"]);
});

test("an empty tenant resolves to an empty audience, not an error", async () => {
  const repository = new FakePreferenceRepository(new Map());
  const resolver = new PreferenceAudienceResolver(repository);

  const ids = await resolver.resolve(tenantId, { kind: "all_recipients" });

  assert.deepEqual(ids, []);
});

test("an unsupported descriptor kind throws rather than silently resolving to nobody", async () => {
  const repository = new FakePreferenceRepository(new Map());
  const resolver = new PreferenceAudienceResolver(repository);

  await assert.rejects(
    () => resolver.resolve(tenantId, { kind: "opted_in_to_sms" }),
    /Unsupported audienceDescriptor\.kind/,
  );
});

test("a descriptor with no kind at all throws the same way", async () => {
  const repository = new FakePreferenceRepository(new Map());
  const resolver = new PreferenceAudienceResolver(repository);

  await assert.rejects(() => resolver.resolve(tenantId, {}));
});
