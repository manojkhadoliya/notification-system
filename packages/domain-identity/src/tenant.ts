import { TenantId } from "@notification-system/shared-kernel";

export interface TenantProps {
  readonly id: TenantId;
  readonly name: string;
  readonly createdAt: Date;
}

/** An isolated customer of the platform — see domain-model.md#identity--tenancy. */
export class Tenant {
  private constructor(private readonly props: TenantProps) {}

  static create(props: { id: TenantId; name: string }): Tenant {
    if (props.name.trim().length === 0) {
      throw new Error("Tenant name must not be empty");
    }
    return new Tenant({ ...props, createdAt: new Date() });
  }

  /** Rebuild from persisted state — bypasses `create`'s "new tenant"
   * defaults (e.g. `createdAt`), since a stored row already has them. */
  static reconstitute(props: TenantProps): Tenant {
    return new Tenant(props);
  }

  get id(): TenantId {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
