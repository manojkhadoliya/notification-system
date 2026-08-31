import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a raw API key — see `ApiKey.hashedKey`'s doc
 * comment ("hashing itself is an infra concern... the domain only ever
 * sees and stores the hash"). Plain SHA-256, not bcrypt/argon2/scrypt: an
 * API key is a long, high-entropy, machine-generated credential looked up
 * by exact hash match on every request, not a human-memorable password
 * that needs slow, salted hashing to resist offline brute force — the
 * key's own entropy is what makes it hard to guess, so the extra latency
 * a deliberately-slow hash would add buys nothing here.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}
