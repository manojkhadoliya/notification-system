import assert from "node:assert/strict";
import { test } from "node:test";
import { RecipientId } from "@notification-system/shared-kernel";
import { ConnectionRegistry, type Socket } from "./connection-registry.js";

function fakeSocket(): Socket & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

test("push delivers to the single socket held for a recipient", () => {
  const registry = new ConnectionRegistry();
  const recipientId = RecipientId("recipient-1");
  const socket = fakeSocket();
  registry.add(recipientId, socket);

  const reached = registry.push(recipientId, "hello");

  assert.equal(reached, 1);
  assert.deepEqual(socket.sent, ["hello"]);
});

test("push fans out to every socket held for the same recipient", () => {
  const registry = new ConnectionRegistry();
  const recipientId = RecipientId("recipient-1");
  const socketA = fakeSocket();
  const socketB = fakeSocket();
  registry.add(recipientId, socketA);
  registry.add(recipientId, socketB);

  const reached = registry.push(recipientId, "hello");

  assert.equal(reached, 2);
  assert.deepEqual(socketA.sent, ["hello"]);
  assert.deepEqual(socketB.sent, ["hello"]);
});

test("push to a recipient with no live connection is a no-op, not an error", () => {
  const registry = new ConnectionRegistry();

  const reached = registry.push(RecipientId("nobody-connected"), "hello");

  assert.equal(reached, 0);
});

test("push never reaches a different recipient's socket", () => {
  const registry = new ConnectionRegistry();
  const other = fakeSocket();
  registry.add(RecipientId("recipient-other"), other);

  const reached = registry.push(RecipientId("recipient-1"), "hello");

  assert.equal(reached, 0);
  assert.deepEqual(other.sent, []);
});

test("remove stops future pushes reaching that socket", () => {
  const registry = new ConnectionRegistry();
  const recipientId = RecipientId("recipient-1");
  const socket = fakeSocket();
  registry.add(recipientId, socket);

  registry.remove(recipientId, socket);
  const reached = registry.push(recipientId, "hello");

  assert.equal(reached, 0);
  assert.deepEqual(socket.sent, []);
});

test("remove is a safe no-op for a socket that was never added", () => {
  const registry = new ConnectionRegistry();

  registry.remove(RecipientId("recipient-1"), fakeSocket());
  // No throw is the assertion.
});

test("removing one of two sockets leaves the other reachable", () => {
  const registry = new ConnectionRegistry();
  const recipientId = RecipientId("recipient-1");
  const socketA = fakeSocket();
  const socketB = fakeSocket();
  registry.add(recipientId, socketA);
  registry.add(recipientId, socketB);

  registry.remove(recipientId, socketA);
  const reached = registry.push(recipientId, "hello");

  assert.equal(reached, 1);
  assert.deepEqual(socketB.sent, ["hello"]);
});

test("connectionCount reflects adds and removes across recipients", () => {
  const registry = new ConnectionRegistry();
  const recipientA = RecipientId("recipient-a");
  const recipientB = RecipientId("recipient-b");
  const socketA1 = fakeSocket();
  const socketA2 = fakeSocket();
  const socketB1 = fakeSocket();

  registry.add(recipientA, socketA1);
  registry.add(recipientA, socketA2);
  registry.add(recipientB, socketB1);
  assert.equal(registry.connectionCount(), 3);

  registry.remove(recipientA, socketA1);
  assert.equal(registry.connectionCount(), 2);
});
