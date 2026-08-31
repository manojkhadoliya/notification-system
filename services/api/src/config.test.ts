import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  REDIS_URL: "redis://localhost:6379",
  KAFKA_BROKERS: "localhost:9092,localhost:9093",
};

describe("loadConfig", () => {
  it("applies defaults for optional vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.port, 3000);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.kafkaClientId, "services-api");
    assert.deepEqual(config.kafkaBrokers, ["localhost:9092", "localhost:9093"]);
  });

  it("honors overrides for optional vars", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: "8080",
      HOST: "127.0.0.1",
      KAFKA_CLIENT_ID: "custom",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.kafkaClientId, "custom");
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });

  it("throws when a required var is an empty string", () => {
    assert.throws(() => loadConfig({ ...baseEnv, REDIS_URL: "" }), /REDIS_URL/);
  });
});
