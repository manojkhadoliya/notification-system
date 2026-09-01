import {
  NotificationRequest,
  type DeliveryStatusEvent,
  type NotificationRepository,
} from "@notification-system/domain-notification";
import type { ConsumedMessage } from "@notification-system/infra-kafka";

export interface ProjectionServiceDeps {
  readonly notificationRepository: NotificationRepository;
}

type AcceptedEvent = Extract<DeliveryStatusEvent, { status: "accepted" }>;
type AdvancingEvent = Extract<
  DeliveryStatusEvent,
  { status: "sent" | "delivered" | "failed" }
>;

/**
 * The single writer of `NotificationRequest.status` — see ADR 0010's
 * "single-writer-status" and this package's README. Consumes exactly one
 * topic, `delivery-status`, not two: `"accepted"` — published by
 * `services/router`, once, with everything needed to *create* the row —
 * and `"sent"`/`"delivered"`/`"failed"` — published by the channel
 * workers, each only *advancing* a row that must already exist.
 *
 * (`messaging.md`'s prose says this consumes `events.*` "for the accepted
 * transition" — that's stale relative to how `services/router` actually
 * publishes it, see `DeliveryStatusEvent`'s own doc comment for why a
 * single topic, keyed by `notificationRequestId`, is what actually
 * guarantees the ordering ADR 0010 needs; corrected in this PR.)
 *
 * No business logic beyond the state machine `NotificationRequest`
 * itself already enforces (`advanceStatus`) — this class is only I/O
 * sequencing: parse, look up, apply, save.
 */
export class ProjectionService {
  constructor(private readonly deps: ProjectionServiceDeps) {}

  async handle(message: ConsumedMessage): Promise<void> {
    if (message.value === null) return;
    let event: DeliveryStatusEvent;
    try {
      event = JSON.parse(message.value) as DeliveryStatusEvent;
    } catch (err) {
      console.error(
        "services/projection-notification: failed to parse a message on delivery-status, skipping",
        err,
      );
      return;
    }

    if (event.status === "accepted") {
      return this.handleAccepted(event);
    }
    return this.advance(event);
  }

  private async handleAccepted(event: AcceptedEvent): Promise<void> {
    const existing = await this.deps.notificationRepository.findById(
      event.notificationRequestId,
    );
    if (existing !== null) {
      // A redelivered "accepted" (Kafka at-least-once) — the row already
      // exists, possibly already advanced further by a later status this
      // consumer has since processed. Re-creating or overwriting it here
      // would be a regression exactly like the one ADR 0010 fixed;
      // idempotent no-op is correct.
      return;
    }
    const request = NotificationRequest.accept({
      id: event.notificationRequestId,
      tenantId: event.tenantId,
      recipientId: event.recipientId,
      notificationType: event.notificationType,
      idempotencyKey: event.idempotencyKey,
      channel: event.channel,
      broadcastId: event.broadcastId,
      payload: event.payload,
    });
    await this.deps.notificationRepository.save(request);
  }

  private async advance(event: AdvancingEvent): Promise<void> {
    const existing = await this.deps.notificationRepository.findById(
      event.notificationRequestId,
    );
    if (existing === null) {
      // sent/delivered/failed arriving with no row yet — "accepted"
      // hasn't been processed for this notificationRequestId. Shouldn't
      // happen in normal operation: every status for one
      // notificationRequestId is keyed identically onto `delivery-status`,
      // so Kafka's per-partition ordering guarantee means "accepted" is
      // always produced (and consumed) first. Handled defensively rather
      // than assumed impossible — logged and skipped, not thrown; this
      // consumer must not crash-loop on a data anomaly it can't recover
      // from by retrying the same message.
      console.error(
        `services/projection-notification: no NotificationRequest found for ${event.notificationRequestId} ` +
          `(status "${event.status}") — the "accepted" event hasn't been processed yet, or never arrives. Skipping.`,
      );
      return;
    }
    const advanced = existing.advanceStatus(event.status);
    if (advanced === null) {
      // An out-of-order or regressive transition (a redelivered "sent"
      // arriving after "delivered" already landed, say) — discarded, not
      // applied, per NotificationRequest.advanceStatus's own doc comment.
      return;
    }
    await this.deps.notificationRepository.save(advanced);
  }
}
