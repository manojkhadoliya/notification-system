import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  REDIS_URL: "redis://localhost:6379",
  KAFKA_BROKERS: "localhost:9092",
};

describe("loadConfig", () => {
  it("has no mock overrides by default", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.mockSuccessRate, undefined);
    assert.equal(config.mockLatencyMs, undefined);
  });

  it("honors mock overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      MOCK_EMAIL_SUCCESS_RATE: "0.5",
      MOCK_EMAIL_LATENCY_MS: "100",
    });
    assert.equal(config.mockSuccessRate, 0.5);
    assert.equal(config.mockLatencyMs, 100);
  });

  it("applies defaults for optional Kafka vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "worker-email");
    assert.equal(config.kafkaGroupId, "worker-email");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });
});
