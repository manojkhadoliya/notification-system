import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allRetryTopics,
  commandTopic,
  dlqTopic,
  eventTopic,
  retryTopic,
} from "./topics.js";

test("eventTopic maps each priority to its own topic", () => {
  assert.equal(eventTopic("critical"), "events.critical");
  assert.equal(eventTopic("standard"), "events.standard");
  assert.equal(eventTopic("bulk"), "events.bulk");
});

test("commandTopic and dlqTopic are per-channel", () => {
  assert.equal(commandTopic("sms"), "command.sms");
  assert.equal(dlqTopic("in_app"), "command.in_app.dlq");
});

test("retryTopic maps the three known RetryPolicy delays to their tiers", () => {
  assert.equal(retryTopic("sms", 30_000), "command.sms.retry-30s");
  assert.equal(retryTopic("sms", 300_000), "command.sms.retry-5m");
  assert.equal(retryTopic("sms", 1_800_000), "command.sms.retry-30m");
});

test("retryTopic throws on a delay no retry tier corresponds to", () => {
  assert.throws(() => retryTopic("sms", 60_000));
  assert.throws(() => retryTopic("sms", 0));
});

test("allRetryTopics lists all three tiers for one channel", () => {
  assert.deepEqual(allRetryTopics("push"), [
    "command.push.retry-30s",
    "command.push.retry-5m",
    "command.push.retry-30m",
  ]);
});
