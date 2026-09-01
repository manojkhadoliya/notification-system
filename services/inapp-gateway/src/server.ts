import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RecipientId } from "@notification-system/shared-kernel";
import { ConnectionRegistry } from "./connection-registry.js";

/** Only path this service serves — see this package's README for why
 * there's no other REST surface (no domain repository ports, connection
 * routing is mechanical per ADR 0012). */
export const FEED_STREAM_PATH = "/v1/feed/stream";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InappGatewayServer {
  readonly httpServer: HttpServer;
  readonly registry: ConnectionRegistry;
  /** Closes every open socket and stops the HTTP server. */
  close(): Promise<void>;
}

/**
 * Builds the WebSocket registry server. No routing/business logic beyond
 * "does this connection carry a recipientId" — that's deliberate (ADR
 * 0012: "connection routing is mechanical, not a business decision").
 *
 * **Connection identity — a known, documented Phase 1 gap, not an
 * oversight:** identity comes from a `?recipientId=<uuid>` query param on
 * the upgrade request, and this server performs **no verification** that
 * the caller actually is that recipient. `domain-identity`'s only auth
 * primitive is a tenant-scoped API key (`services/api`'s Door 1 —
 * `Authorization: Bearer <api-key>`), which is a backend secret and wrong
 * to hand to a browser/mobile client directly; nothing in this system
 * yet models a recipient-scoped session/token an untrusted client could
 * safely present, and ADR 0012 explicitly keeps this service free of
 * domain repository ports (so it can't itself look one up even if it
 * existed). Resolving that — a signed short-lived recipient token, or an
 * authenticating edge/BFF in front of this service — is real,
 * separately-scoped work; see this package's README for the full
 * writeup. Flagged here, not silently skipped.
 */
export function buildServer(
  options: { registry?: ConnectionRegistry } = {},
): InappGatewayServer {
  const registry = options.registry ?? new ConnectionRegistry();

  const httpServer = createServer((_req, res) => {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(
        JSON.stringify({ error: { code: "not_found", message: "not found" } }),
      );
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: FEED_STREAM_PATH,
  });

  wss.on("connection", (socket: WebSocket, request) => {
    const recipientId = parseRecipientId(request.url);
    if (recipientId === null) {
      socket.close(4400, "recipientId query param must be a UUID");
      return;
    }

    registry.add(recipientId, socket);
    const unregister = (): void => registry.remove(recipientId, socket);
    socket.on("close", unregister);
    socket.on("error", unregister);
  });

  return {
    httpServer,
    registry,
    async close() {
      for (const socket of wss.clients)
        socket.close(1001, "server shutting down");
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function parseRecipientId(url: string | undefined): RecipientId | null {
  if (url === undefined) return null;
  const { searchParams } = new URL(url, "http://localhost");
  const raw = searchParams.get("recipientId");
  if (raw === null || !UUID_RE.test(raw)) return null;
  return RecipientId(raw);
}
