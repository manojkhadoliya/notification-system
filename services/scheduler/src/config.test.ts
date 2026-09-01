import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/db",
  KAFKA_BROKERS: "localhost:9092",
};

describe("loadConfig", () => {
  it("applies defaults for optional vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.kafkaClientId, "scheduler");
    assert.equal(config.bucket, 0);
    assert.equal(config.bucketCount, 1);
    assert.equal(config.claimLimit, 100);
    assert.equal(config.pollIntervalMs, 5_000);
  });

  it("honors overrides for optional vars", () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_CLIENT_ID: "custom",
      SCHEDULER_BUCKET: "2",
      SCHEDULER_BUCKET_COUNT: "4",
      SCHEDULER_CLAIM_LIMIT: "50",
      SCHEDULER_POLL_INTERVAL_MS: "1000",
    });
    assert.equal(config.kafkaClientId, "custom");
    assert.equal(config.bucket, 2);
    assert.equal(config.bucketCount, 4);
    assert.equal(config.claimLimit, 50);
    assert.equal(config.pollIntervalMs, 1000);
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = baseEnv;
    void DATABASE_URL;
    assert.throws(() => loadConfig(withoutDatabaseUrl), /DATABASE_URL/);
  });

  it("throws when bucket >= bucketCount", () => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv,
          SCHEDULER_BUCKET: "4",
          SCHEDULER_BUCKET_COUNT: "4",
        }),
      /Invalid scheduler shard config/,
    );
  });

  it("throws when bucket is negative", () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, SCHEDULER_BUCKET: "-1" }),
      /Invalid scheduler shard config/,
    );
  });

  it("throws when bucketCount is not a positive integer", () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, SCHEDULER_BUCKET_COUNT: "0" }),
      /Invalid scheduler shard config/,
    );
  });
});
