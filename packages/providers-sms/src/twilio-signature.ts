import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies `X-Twilio-Signature` per Twilio's request-validation scheme —
 * see api-spec.md#post-v1webhookstwilio ("Signature-verified using
 * Twilio's request-signing scheme before being trusted"), what
 * `services/api` calls before trusting a `POST /v1/webhooks/twilio`
 * delivery-status callback.
 *
 * The scheme: concatenate the full request URL with every POST
 * parameter's name immediately followed by its value, parameters sorted
 * lexicographically by name, then HMAC-SHA1 the result with the account's
 * auth token and base64-encode it. `params` must be every field Twilio's
 * `application/x-www-form-urlencoded` body sent, string-valued.
 *
 * Pure and unit-tested against self-generated fixtures (no live Twilio
 * account to source an official test vector from in this session) — see
 * `twilio-signature.test.ts`.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken)
    .update(data, "utf8")
    .digest("base64");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // Length must match before timingSafeEqual (it throws on a length
  // mismatch rather than returning false) — checking it first is itself
  // not a timing leak worth avoiding, since only the signature's length
  // is revealed, not any of its content.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
