import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidDeliveryStatusTransition } from "./delivery-status.js";

test("accepted can move to sent or failed", () => {
  assert.equal(isValidDeliveryStatusTransition("accepted", "sent"), true);
  assert.equal(isValidDeliveryStatusTransition("accepted", "failed"), true);
});

test("sent can move to delivered or failed", () => {
  assert.equal(isValidDeliveryStatusTransition("sent", "delivered"), true);
  assert.equal(isValidDeliveryStatusTransition("sent", "failed"), true);
});

test("delivered and failed are terminal", () => {
  assert.equal(isValidDeliveryStatusTransition("delivered", "sent"), false);
  assert.equal(isValidDeliveryStatusTransition("delivered", "failed"), false);
  assert.equal(isValidDeliveryStatusTransition("failed", "sent"), false);
  assert.equal(isValidDeliveryStatusTransition("failed", "delivered"), false);
});

test("status can never move backwards", () => {
  assert.equal(isValidDeliveryStatusTransition("sent", "accepted"), false);
  assert.equal(isValidDeliveryStatusTransition("delivered", "accepted"), false);
});

test("a status is never its own valid transition (redelivery is a no-op, not a transition)", () => {
  assert.equal(isValidDeliveryStatusTransition("accepted", "accepted"), false);
  assert.equal(isValidDeliveryStatusTransition("sent", "sent"), false);
});
