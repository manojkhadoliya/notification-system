import type { RecipientId } from "@notification-system/shared-kernel";

/**
 * Minimal shape this registry needs from a live connection. A real `ws`
 * `WebSocket` satisfies this structurally (its `send(data, cb?)` accepts
 * a lone string argument) — this file has zero dependency on the `ws`
 * package itself, matching the "pure logic, thin wiring" split used by
 * every other `services/*` composition root this session (e.g.
 * `worker-inapp`'s `WorkerService` vs. its `index.ts`). Tests use a plain
 * fake object.
 */
export interface Socket {
  send(data: string): void;
}

/**
 * Which recipient is connected to which live socket(s) — on *this*
 * instance only. Per ADR 0012, connection routing is deliberately
 * mechanical and per-instance: there is no cross-instance registry, and a
 * recipient's socket landing on a different replica is expected, not an
 * error (see `RedisInAppGateway`'s doc comment — a publish reaching zero
 * subscribers isn't a delivery failure, since the `NotificationFeedItem`
 * row is the durable delivery).
 *
 * A recipient can hold more than one socket at once (multiple browser
 * tabs, multiple devices), so each `recipientId` maps to a `Set`, not a
 * single value.
 */
export class ConnectionRegistry {
  private readonly byRecipient = new Map<RecipientId, Set<Socket>>();

  add(recipientId: RecipientId, socket: Socket): void {
    let sockets = this.byRecipient.get(recipientId);
    if (sockets === undefined) {
      sockets = new Set();
      this.byRecipient.set(recipientId, sockets);
    }
    sockets.add(socket);
  }

  /** No-op if `socket` was already removed (or never added) — a socket's
   * `close`/`error` handlers both call this, and both can fire for the
   * same disconnect. */
  remove(recipientId: RecipientId, socket: Socket): void {
    const sockets = this.byRecipient.get(recipientId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.byRecipient.delete(recipientId);
  }

  /** Pushes `data` to every socket currently held for `recipientId` on
   * this instance. Returns how many sockets it reached (0 if the
   * recipient has no live connection here) — purely informational, not
   * something a caller needs to act on. */
  push(recipientId: RecipientId, data: string): number {
    const sockets = this.byRecipient.get(recipientId);
    if (sockets === undefined) return 0;
    for (const socket of sockets) socket.send(data);
    return sockets.size;
  }

  /** Total live sockets across every recipient — used only for a
   * lightweight liveness/debug signal (see `server.ts`), never for
   * routing decisions. */
  connectionCount(): number {
    let total = 0;
    for (const sockets of this.byRecipient.values()) total += sockets.size;
    return total;
  }
}
