import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  KAFKA_BROKERS: "localhost:9092",
};

describe("loadConfig", () => {
  it("applies defaults for optional Kafka vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "projection-notification");
    assert.equal(config.kafkaGroupId, "projection-notification");
  });

  it("honors overrides for optional vars", () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_CLIENT_ID: "custom",
      KAFKA_GROUP_ID: "custom-group",
    });
    assert.equal(config.kafkaClientId, "custom");
    assert.equal(config.kafkaGroupId, "custom-group");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });
});
