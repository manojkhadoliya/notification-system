import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  REDIS_URL: "redis://localhost:6379",
  KAFKA_BROKERS: "localhost:9092",
};

describe("loadConfig", () => {
  it("defaults to the mock gateway with no overrides", () => {
    const config = loadConfig(baseEnv);
    assert.deepEqual(config.gateway, { kind: "mock" });
  });

  it("honors mock gateway overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      MOCK_PUSH_SUCCESS_RATE: "0.5",
      MOCK_PUSH_LATENCY_MS: "100",
    });
    assert.deepEqual(config.gateway, {
      kind: "mock",
      successRate: 0.5,
      latencyMs: 100,
    });
  });

  it("selects the FCM gateway when PUSH_PROVIDER=fcm, requiring its credentials", () => {
    const config = loadConfig({
      ...baseEnv,
      PUSH_PROVIDER: "fcm",
      FCM_PROJECT_ID: "my-project",
      FCM_CLIENT_EMAIL: "svc@my-project.iam.gserviceaccount.com",
      FCM_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
    });
    assert.deepEqual(config.gateway, {
      kind: "fcm",
      projectId: "my-project",
      clientEmail: "svc@my-project.iam.gserviceaccount.com",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    });
  });

  it("throws when PUSH_PROVIDER=fcm but a credential is missing", () => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv,
          PUSH_PROVIDER: "fcm",
          FCM_PROJECT_ID: "my-project",
        }),
      /FCM_CLIENT_EMAIL/,
    );
  });

  it("applies defaults for optional Kafka vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "worker-push");
    assert.equal(config.kafkaGroupId, "worker-push");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });
});
