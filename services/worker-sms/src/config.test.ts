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
      MOCK_SMS_SUCCESS_RATE: "0.5",
      MOCK_SMS_LATENCY_MS: "100",
    });
    assert.deepEqual(config.gateway, {
      kind: "mock",
      successRate: 0.5,
      latencyMs: 100,
    });
  });

  it("selects the Twilio gateway when SMS_PROVIDER=twilio, requiring its credentials", () => {
    const config = loadConfig({
      ...baseEnv,
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM_NUMBER: "+15550000000",
    });
    assert.deepEqual(config.gateway, {
      kind: "twilio",
      accountSid: "ACxxx",
      authToken: "secret",
      fromNumber: "+15550000000",
    });
  });

  it("throws when SMS_PROVIDER=twilio but a credential is missing", () => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv,
          SMS_PROVIDER: "twilio",
          TWILIO_ACCOUNT_SID: "ACxxx",
        }),
      /TWILIO_AUTH_TOKEN/,
    );
  });

  it("applies defaults for optional Kafka vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "worker-sms");
    assert.equal(config.kafkaGroupId, "worker-sms");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });
});
