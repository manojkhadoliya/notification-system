import { randomUUID } from "node:crypto";
import type {
  ChannelCommand,
  NotificationEvent,
} from "@notification-system/domain-notification";
import { ScheduledNotification } from "@notification-system/domain-notification";
import type { Recipient } from "@notification-system/domain-preferences";
import { buildChannelPayload } from "./build-channel-payload.js";
import { renderTemplate } from "./render-template.js";
import { decideChannel, type ChannelDecision } from "./routing.js";
import type { RouterDependencies } from "./types.js";

/** `Date.prototype.getHours()` reads the *server process's* local
 * timezone, which is meaningless here — quiet hours needs the
 * *recipient's* local time, and nothing in the domain model stores a
 * recipient's timezone yet (see `quiet-hours.ts`'s own doc comment: "the
 * router resolves a recipient's timezone and passes an already-localized
 * now in" — there's no way to yet). UTC is the only deterministic,
 * environment-independent choice available without that data — a real,
 * documented limitation (see this package's README), not a silent
 * assumption. */
function utcMinuteOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Upper bound on the random jitter added to a deferred `dueAt` — see
 * `defer()`'s doc comment and ADR 0011's "sharding and jitter from day
 * one" rationale. 60s spreads a large cohort sharing one quiet-hours
 * window's exact end minute (the common case: many recipients on the
 * same policy) across enough distinct `due_minute` values that
 * `services/scheduler`'s `(due_minute, bucket)` sharding actually has
 * something to shard, without meaningfully delaying anyone — not a
 * number ADR 0011 itself pins down, so this is a judgment call, not a
 * spec'd constant. */
const MAX_DEFER_JITTER_MS = 60_000;

/**
 * The router's core orchestration — one call per consumed
 * `events.{critical|standard|bulk}` message, per messaging.md#router's
 * five steps. Everything decision-shaped is delegated to pure functions
 * (`decideChannel`, `renderTemplate`, `buildChannelPayload`); this class
 * is only the I/O sequencing and side effects (publish, schedule).
 *
 * `now` is a constructor seam (defaults to `() => new Date()`) so
 * quiet-hours behavior is deterministic in tests; `jitter` is a second
 * seam (defaults to a random `[0, MAX_DEFER_JITTER_MS)` offset, added
 * only in `defer()` — never subtracted, so a deferred send is always at
 * or after its computed `dueAt`, never before) so that behavior is
 * deterministic too — see `router-service.test.ts`.
 */
export class RouterService {
  constructor(
    private readonly deps: RouterDependencies,
    private readonly now: () => Date = () => new Date(),
    private readonly jitter: () => number = () =>
      Math.floor(Math.random() * MAX_DEFER_JITTER_MS),
  ) {}

  async handle(event: NotificationEvent): Promise<void> {
    const nowDate = this.now();
    const nowMinuteOfDay = utcMinuteOfDay(nowDate);

    let recipient = await this.deps.preferenceRepository.findRecipient(
      event.recipientId,
    );
    if (recipient !== null && recipient.tenantId !== event.tenantId) {
      // A recipientId that resolves to a different tenant than the
      // event's — treat as "doesn't exist" for this event's purposes
      // rather than ever routing to it. Should only happen from a bug
      // upstream (Door 1/Door 2 always operate within one tenant), but
      // this is the one place that invariant can be cheaply double-checked.
      recipient = null;
    }
    const preferences =
      recipient === null
        ? []
        : await this.deps.preferenceRepository.findPreferences(
            event.recipientId,
            event.notificationType,
          );

    const decision = decideChannel({
      notificationRequestId: event.notificationRequestId,
      requestedChannel: event.channel,
      priority: event.priority,
      recipient,
      preferences,
      now: nowDate,
      nowMinuteOfDay,
    });

    switch (decision.kind) {
      case "dispatch": {
        if (recipient === null) {
          throw new Error(
            "invariant violated: decideChannel returned 'dispatch' with a null recipient",
          );
        }
        await this.dispatch(event, decision, recipient, nowDate);
        return;
      }
      case "deferred":
        await this.defer(event, decision);
        return;
      case "suppressed":
        // Nothing dropped through a failure path, nothing to publish —
        // see this package's README on why a suppressed request
        // currently leaves no delivery-status trace.
        return;
    }
  }

  private async dispatch(
    event: NotificationEvent,
    decision: Extract<ChannelDecision, { kind: "dispatch" }>,
    recipient: Recipient,
    now: Date,
  ): Promise<void> {
    const renderedBody = await this.renderBody(event);
    if (renderedBody === null) {
      return; // template lookup failed — already logged inside renderBody
    }

    const renderedPayload = buildChannelPayload(
      decision.channel,
      recipient,
      event.notificationType,
      renderedBody,
    );
    const command: ChannelCommand = {
      notificationRequestId: event.notificationRequestId,
      tenantId: event.tenantId,
      recipientId: event.recipientId,
      channel: decision.channel,
      priority: event.priority,
      renderedPayload,
      attemptNumber: 1,
    };
    // Published *before* the command, deliberately: "accepted" is what
    // lets services/projection-notification create the NotificationRequest
    // row that a channel worker's own DeliveryAttempt write has a real FK
    // to (see PostgresNotificationRepository.saveAttempt's doc comment).
    // Kafka gives no cross-topic ordering guarantee, so this narrows that
    // race rather than closing it — the worker side's bounded retry is
    // what actually makes it safe either way.
    await this.deps.messageBroker.publishDeliveryStatus({
      notificationRequestId: event.notificationRequestId,
      status: "accepted",
      // No attempt has been made yet at this point — attempts (1, 2, ...)
      // are the channel worker's, once it actually calls a provider (see
      // ADR 0010). `0` is this package's convention for "before any
      // attempt"; `DeliveryStatusEvent.attemptNumber` has no
      // null/optional variant for that state.
      attemptNumber: 0,
      occurredAt: now,
      // Everything services/projection-notification needs to *create*
      // the NotificationRequest row — this is the one place all of it is
      // known at once (see DeliveryStatusEvent's own doc comment for
      // why "accepted" carries this and sent/delivered/failed don't).
      tenantId: event.tenantId,
      recipientId: event.recipientId,
      notificationType: event.notificationType,
      idempotencyKey: event.idempotencyKey,
      channel: decision.channel,
      broadcastId: event.broadcastId,
      payload: renderedPayload,
    });
    await this.deps.messageBroker.publishCommand(command);
  }

  private async renderBody(event: NotificationEvent): Promise<string | null> {
    if (event.templateVersionId === null) {
      // api-spec.md: "payload is either raw content... or the variables
      // a templateVersionId renders against". Raw content's documented
      // shape is `{ message: "string" }` (see POST /v1/notifications'
      // example body) — used directly as the body.
      const message = event.payloadRef.message;
      return typeof message === "string"
        ? message
        : JSON.stringify(event.payloadRef);
    }

    const version = await this.deps.templateRepository.findVersion(
      event.templateVersionId,
    );
    if (version === null) {
      // A templateVersionId that doesn't resolve to anything is a data
      // problem upstream, not a transient failure retrying would fix —
      // logged and skipped rather than thrown, since throwing here would
      // just redeliver the same unprocessable event forever (events.*
      // has no DLQ of its own the way command.* does).
      console.error(
        `services/router: templateVersionId ${event.templateVersionId} not found for notificationRequestId ${event.notificationRequestId} — skipping`,
      );
      return null;
    }
    return renderTemplate(version.content, event.payloadRef);
  }

  private async defer(
    event: NotificationEvent,
    decision: Extract<ChannelDecision, { kind: "deferred" }>,
  ): Promise<void> {
    const scheduled = ScheduledNotification.schedule({
      id: randomUUID(),
      notificationRequestId: event.notificationRequestId,
      tenantId: event.tenantId,
      recipientId: event.recipientId,
      notificationType: event.notificationType,
      channel: event.channel,
      templateVersionId: event.templateVersionId,
      payload: event.payloadRef,
      priority: event.priority,
      broadcastId: event.broadcastId,
      // Jittered forward (never earlier — see MAX_DEFER_JITTER_MS's doc
      // comment), so many recipients sharing one quiet-hours policy's
      // exact end minute don't all land on the same due_minute for
      // services/scheduler's poller shards to contend over.
      dueAt: new Date(decision.dueAt.getTime() + this.jitter()),
    });
    await this.deps.scheduledNotificationRepository.save(scheduled);
  }
}
