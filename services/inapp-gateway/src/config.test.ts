import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("applies defaults for optional vars", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.port, 3001);
    assert.equal(config.host, "0.0.0.0");
  });

  it("honors overrides for optional vars", () => {
    const config = loadConfig({ ...baseEnv, PORT: "8080", HOST: "127.0.0.1" });
    assert.equal(config.port, 8080);
    assert.equal(config.host, "127.0.0.1");
  });

  it("throws when REDIS_URL is missing", () => {
    assert.throws(() => loadConfig({}), /REDIS_URL/);
  });

  it("throws when REDIS_URL is an empty string", () => {
    assert.throws(() => loadConfig({ REDIS_URL: "" }), /REDIS_URL/);
  });
});
