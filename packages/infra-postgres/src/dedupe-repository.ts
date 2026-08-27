import type { PrismaClient, Prisma } from "./prisma-client.js";
import type {
  DedupeClaim,
  DedupeRepository,
} from "@notification-system/domain-notification";

// Postgres unique-constraint violation — see
// https://www.prisma.io/docs/orm/reference/error-reference#p2002
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * The claim *is* the insert (see dedupe-claim.ts's doc comment and
 * ADR 0010) — this adapter relies on the composite primary key
 * (`@@id([tenantId, notificationRequestId, recipientId, channel])` in
 * schema.prisma) to make a conflicting claim fail, not a
 * check-then-insert (which would race).
 */
export class PostgresDedupeRepository implements DedupeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async tryClaim(claim: DedupeClaim): Promise<boolean> {
    try {
      await this.prisma.dedupeClaim.create({
        data: {
          tenantId: claim.tenantId,
          notificationRequestId: claim.notificationRequestId,
          recipientId: claim.recipientId,
          channel: claim.channel,
          claimedAt: claim.claimedAt,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return false;
      }
      throw error;
    }
  }
}
