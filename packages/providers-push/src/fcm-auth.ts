import { createSign } from "node:crypto";

export interface ServiceAccountCredentials {
  readonly clientEmail: string;
  /** PEM-encoded RSA private key — the service account JSON's
   * `private_key` field (already newline-decoded), not the raw JSON
   * file. Parsing the downloaded key file is the composition root's job;
   * this package only consumes the PEM string. */
  readonly privateKey: string;
  readonly tokenUri?: string;
}

export const DEFAULT_FCM_TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// Google's documented max lifetime for this grant type's assertion.
const ASSERTION_TTL_SECONDS = 3600;

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString(
    "base64url",
  );
}

/**
 * Builds the signed JWT ("assertion") FCM's OAuth2 service-account flow
 * exchanges for an access token — see
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest.
 * Built by hand with `node:crypto` rather than `google-auth-library` —
 * same "one well-documented flow isn't worth a dependency for" call
 * `providers-sms` made for Twilio's request signing.
 *
 * `nowSeconds` is an injection seam so this is deterministic and
 * unit-testable (see `fcm-auth.test.ts`) instead of depending on
 * wall-clock time.
 */
export function buildFcmAssertionJwt(
  credentials: ServiceAccountCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: credentials.clientEmail,
    scope: FCM_SCOPE,
    aud: credentials.tokenUri ?? DEFAULT_FCM_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}
