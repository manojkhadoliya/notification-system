import type { InAppNotification } from "@notification-system/infra-redis";
import type { ConnectionRegistry } from "./connection-registry.js";

/**
 * Bridges one decoded pub/sub message (from `infra-redis`'s
 * `InAppSubscriber`) to the local `ConnectionRegistry` — this is the
 * entire "reaction" this service has, per ADR 0012 ("connection routing
 * is mechanical, not a business decision"). JSON-encodes once per
 * notification, not once per socket, since a recipient may hold more
 * than one open connection.
 *
 * Forwards the notification's full shape unchanged (`renderedPayload`
 * included) rather than reshaping it — same "this transport doesn't
 * interpret content" stance `RedisInAppGateway`'s doc comment takes on
 * the publish side; the connected client decides how to render it.
 */
export function pushToRegistry(
  registry: ConnectionRegistry,
  notification: InAppNotification,
): number {
  return registry.push(notification.recipientId, JSON.stringify(notification));
}
