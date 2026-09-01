import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { RecipientId } from "@notification-system/shared-kernel";
import { buildServer, FEED_STREAM_PATH, type InappGatewayServer } from "./server.js";

/** Real loopback HTTP + WebSocket server on an ephemeral port — this is
 * the standard way to test a `ws` server (there's no Fastify-style
 * `.inject()` for raw upgrades), and it never touches Docker/external
 * infra: everything here is in-process, localhost-only. */
async function start(): Promise<{ gateway: InappGatewayServer; wsUrl: (recipientId?: string) => string }> {
  const gateway = buildServer();
  await new Promise<void>((resolve) => gateway.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = gateway.httpServer.address() as AddressInfo;
  return {
    gateway,
    wsUrl: (recipientId) =>
      `ws://127.0.0.1:${port}${FEED_STREAM_PATH}${recipientId !== undefined ? `?recipientId=${recipientId}` : ""}`,
  };
}

function waitFor(socket: WebSocket, event: "open" | "close" | "message"): Promise<[unknown, unknown]> {
  return new Promise((resolve) => {
    socket.once(event, (...args: unknown[]) => resolve(args as [unknown, unknown]));
  });
}

describe("inapp-gateway server", () => {
  let harness: { gateway: InappGatewayServer; wsUrl: (recipientId?: string) => string };

  before(async () => {
    harness = await start();
  });

  after(async () => {
    await harness.gateway.close();
  });

  it("registers a connection carrying a valid recipientId and delivers a push to it", async () => {
    const recipientId = randomUUID();
    const socket = new WebSocket(harness.wsUrl(recipientId));
    await waitFor(socket, "open");

    harness.gateway.registry.push(RecipientId(recipientId), JSON.stringify({ hello: "world" }));
    const [data] = await waitFor(socket, "message");

    assert.deepEqual(JSON.parse(String(data)), { hello: "world" });
    socket.close();
  });

  it("rejects a connection with no recipientId query param", async () => {
    const socket = new WebSocket(harness.wsUrl());
    const [code, reason] = await waitFor(socket, "close");

    assert.equal(code, 4400);
    assert.match(String(reason), /recipientId/);
  });

  it("rejects a connection whose recipientId isn't a UUID", async () => {
    const socket = new WebSocket(harness.wsUrl("not-a-uuid"));
    const [code] = await waitFor(socket, "close");

    assert.equal(code, 4400);
  });

  it("removes a socket from the registry once it disconnects", async () => {
    const recipientId = randomUUID();
    const socket = new WebSocket(harness.wsUrl(recipientId));
    await waitFor(socket, "open");
    const before_ = harness.gateway.registry.connectionCount();

    socket.close();
    await waitFor(socket, "close");
    // The server's own "close"/"error" handler runs asynchronously
    // relative to the client seeing its own close event — poll briefly
    // rather than assert immediately.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(before_ - harness.gateway.registry.connectionCount(), 1);
  });

  it("fans a push out to two sockets open for the same recipientId", async () => {
    const recipientId = randomUUID();
    const socketA = new WebSocket(harness.wsUrl(recipientId));
    const socketB = new WebSocket(harness.wsUrl(recipientId));
    await Promise.all([waitFor(socketA, "open"), waitFor(socketB, "open")]);

    harness.gateway.registry.push(RecipientId(recipientId), "ping");
    const [[dataA], [dataB]] = await Promise.all([
      waitFor(socketA, "message"),
      waitFor(socketB, "message"),
    ]);

    assert.equal(String(dataA), "ping");
    assert.equal(String(dataB), "ping");
    socketA.close();
    socketB.close();
  });
});
