import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  KAFKA_BROKERS: "localhost:9092,localhost:9093",
};

describe("loadConfig", () => {
  it("applies defaults for optional vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "services-router");
    assert.equal(config.kafkaGroupId, "services-router");
    assert.deepEqual(config.kafkaBrokers, ["localhost:9092", "localhost:9093"]);
  });

  it("honors overrides for optional vars", () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_CLIENT_ID: "custom-client",
      KAFKA_GROUP_ID: "custom-group",
    });
    assert.equal(config.kafkaClientId, "custom-client");
    assert.equal(config.kafkaGroupId, "custom-group");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });
});
