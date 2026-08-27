/**
 * Nominal ("branded") id types. Plain `string` would let a `RecipientId`
 * be passed where a `TenantId` is expected — both are just strings at
 * runtime, so nothing catches the mistake. Branding makes that a
 * compile-time error while staying a zero-cost `string` underneath (no
 * wrapper object, no runtime overhead).
 *
 * Every id in this system is a UUID string; the brand only prevents mixing
 * *which* entity's id is being passed, not malformed UUIDs — that's a
 * validation concern for the boundary (API/adapter), not the type system.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Cast a raw string into a branded id. Only call this at a trust boundary
 * (parsing input, reading a repository row) — never to silence a type
 * error inside domain logic. */
export function brandId<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}

export type TenantId = Brand<string, "TenantId">;
export type RecipientId = Brand<string, "RecipientId">;
export type NotificationRequestId = Brand<string, "NotificationRequestId">;
export type BroadcastId = Brand<string, "BroadcastId">;
export type ChunkId = Brand<string, "ChunkId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;
export type TemplateId = Brand<string, "TemplateId">;
export type TemplateVersionId = Brand<string, "TemplateVersionId">;

export const TenantId = (value: string): TenantId => brandId(value);
export const RecipientId = (value: string): RecipientId => brandId(value);
export const NotificationRequestId = (value: string): NotificationRequestId =>
  brandId(value);
export const BroadcastId = (value: string): BroadcastId => brandId(value);
export const ChunkId = (value: string): ChunkId => brandId(value);
export const ApiKeyId = (value: string): ApiKeyId => brandId(value);
export const TemplateId = (value: string): TemplateId => brandId(value);
export const TemplateVersionId = (value: string): TemplateVersionId =>
  brandId(value);
