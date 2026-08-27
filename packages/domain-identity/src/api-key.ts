import { ApiKeyId, TenantId } from "@notification-system/shared-kernel";

export interface ApiKeyProps {
  readonly id: ApiKeyId;
  readonly tenantId: TenantId;
  /** Never the raw key — see multi-tenancy.md#auth. Hashing itself is an
   * infra concern (which algorithm, salt handling); the domain only ever
   * sees and stores the hash. */
  readonly hashedKey: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/** A credential a tenant uses to call the API — see
 * domain-model.md#identity--tenancy. */
export class ApiKey {
  private constructor(private readonly props: ApiKeyProps) {}

  static issue(props: {
    id: ApiKeyId;
    tenantId: TenantId;
    hashedKey: string;
  }): ApiKey {
    return new ApiKey({ ...props, createdAt: new Date(), revokedAt: null });
  }

  static reconstitute(props: ApiKeyProps): ApiKey {
    return new ApiKey(props);
  }

  get id(): ApiKeyId {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get hashedKey(): string {
    return this.props.hashedKey;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  /** A revoked key is rejected immediately, regardless of `hashedKey`
   * matching — see multi-tenancy.md#auth. */
  isValid(): boolean {
    return this.props.revokedAt === null;
  }

  /** Returns a new, revoked `ApiKey` — revocation is a one-way transition
   * (there's no "un-revoke"), so this doesn't take an explicit "revoked"
   * flag to set. Calling it twice is a no-op: the second call's `at` is
   * discarded in favor of the first revocation timestamp. */
  revoke(at: Date = new Date()): ApiKey {
    if (this.props.revokedAt !== null) {
      return this;
    }
    return new ApiKey({ ...this.props, revokedAt: at });
  }
}
