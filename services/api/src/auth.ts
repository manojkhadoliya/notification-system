import type { FastifyRequest } from "fastify";
import type { ApiKeyRepository } from "@notification-system/domain-identity";
import type { TenantId } from "@notification-system/shared-kernel";
import { hashApiKey } from "./hash-api-key.js";
import { unauthorized } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: TenantId;
  }
}

/**
 * Resolves the caller's tenant from `Authorization: Bearer <api-key>` —
 * see multi-tenancy.md#auth. Registered as a global `onRequest` hook in
 * `server.ts`, so it runs before every route in this package. Throws
 * (caught by `server.ts`'s error handler) rather than returning a
 * boolean, so any route handler that runs at all can assume
 * `request.tenantId` is already set.
 */
export async function authenticate(
  request: FastifyRequest,
  apiKeyRepository: ApiKeyRepository,
): Promise<void> {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw unauthorized();
  }
  const rawKey = header.slice("Bearer ".length);
  if (rawKey.length === 0) {
    throw unauthorized();
  }

  const apiKey = await apiKeyRepository.findByHashedKey(hashApiKey(rawKey));
  // A revoked key is rejected immediately, regardless of the hash still
  // matching a row — see ApiKey.isValid()'s doc comment and
  // multi-tenancy.md#auth.
  if (apiKey === null || !apiKey.isValid()) {
    throw unauthorized();
  }
  request.tenantId = apiKey.tenantId;
}
