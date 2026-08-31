import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildFcmAssertionJwt,
  DEFAULT_FCM_TOKEN_URI,
  type ServiceAccountCredentials,
} from "./fcm-auth.js";

// A throwaway keypair generated fresh for this test run — nothing about
// real Google credentials is needed to verify the JWT-building logic
// itself, only that the header/claims/signature are structured and
// signed correctly.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const credentials: ServiceAccountCredentials = {
  clientEmail: "test@test-project.iam.gserviceaccount.com",
  privateKey,
};

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("buildFcmAssertionJwt", () => {
  it("produces three base64url-encoded, dot-separated parts", () => {
    const jwt = buildFcmAssertionJwt(credentials, 1_000);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);
  });

  it("header declares RS256", () => {
    const jwt = buildFcmAssertionJwt(credentials, 1_000);
    const header = decodePart(jwt.split(".")[0]!);
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  });

  it("claims carry the expected iss/scope/aud/iat/exp", () => {
    const jwt = buildFcmAssertionJwt(credentials, 1_000);
    const claims = decodePart(jwt.split(".")[1]!);
    assert.equal(claims.iss, credentials.clientEmail);
    assert.equal(
      claims.scope,
      "https://www.googleapis.com/auth/firebase.messaging",
    );
    assert.equal(claims.aud, DEFAULT_FCM_TOKEN_URI);
    assert.equal(claims.iat, 1_000);
    assert.equal(claims.exp, 1_000 + 3600);
  });

  it("respects a custom tokenUri as the audience", () => {
    const jwt = buildFcmAssertionJwt(
      { ...credentials, tokenUri: "https://example.com/token" },
      1_000,
    );
    const claims = decodePart(jwt.split(".")[1]!);
    assert.equal(claims.aud, "https://example.com/token");
  });

  it("produces a signature verifiable with the matching public key", () => {
    const jwt = buildFcmAssertionJwt(credentials, 1_000);
    const [headerPart, claimsPart, signaturePart] = jwt.split(".");
    const signature = Buffer.from(signaturePart!, "base64url");
    const verified = createVerify("RSA-SHA256")
      .update(`${headerPart}.${claimsPart}`)
      .verify(publicKey, signature);
    assert.equal(verified, true);
  });

  it("a signature verification fails against a different keypair", () => {
    const otherKeypair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const jwt = buildFcmAssertionJwt(credentials, 1_000);
    const [headerPart, claimsPart, signaturePart] = jwt.split(".");
    const signature = Buffer.from(signaturePart!, "base64url");
    const verified = createVerify("RSA-SHA256")
      .update(`${headerPart}.${claimsPart}`)
      .verify(otherKeypair.publicKey, signature);
    assert.equal(verified, false);
  });
});
