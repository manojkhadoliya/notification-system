export { NotificationRequest } from "./notification-request.js";
export type { NotificationRequestProps } from "./notification-request.js";

export { DeliveryAttempt, ATTEMPT_STATUSES } from "./delivery-attempt.js";
export type {
  DeliveryAttemptProps,
  AttemptStatus,
} from "./delivery-attempt.js";

export { RetryPolicy } from "./retry-policy.js";

export { dedupeClaimKey } from "./dedupe-claim.js";
export type { DedupeClaim } from "./dedupe-claim.js";

export {
  ScheduledNotification,
  SCHEDULED_NOTIFICATION_STATUSES,
} from "./scheduled-notification.js";
export type {
  ScheduledNotificationProps,
  ScheduledNotificationStatus,
} from "./scheduled-notification.js";

export type { RoutingDecision } from "./routing-decision.js";

export { MAX_RECIPIENTS_PER_CHUNK, assertValidChunkSize } from "./broadcast.js";
export type { BroadcastRequest, Chunk } from "./broadcast.js";

export type { ChannelCommand } from "./channel-command.js";

export type {
  GatewaySendResult,
  SmsGateway,
  PushGateway,
  EmailGateway,
  InAppGateway,
} from "./gateways.js";

export type { RateLimiter } from "./rate-limiter.js";

export type { IdempotencyRecord, IdempotencyStore } from "./idempotency.js";

export type {
  NotificationEvent,
  DeliveryStatusEvent,
  MessageBroker,
  NotificationRepository,
  DedupeRepository,
  ScheduledNotificationRepository,
} from "./ports.js";

export { DispatchService } from "./dispatch-service.js";
export type { DispatchOutcome } from "./dispatch-service.js";
