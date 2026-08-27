import type {
  Channel,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

export interface RecipientProps {
  readonly id: RecipientId;
  readonly tenantId: TenantId;
  readonly phone: string | null;
  readonly pushToken: string | null;
  readonly email: string | null;
  readonly createdAt: Date;
}

/** A tenant's end user, with channel addresses — see
 * domain-model.md#recipient-preferences. */
export class Recipient {
  private constructor(private readonly props: RecipientProps) {}

  static create(props: {
    id: RecipientId;
    tenantId: TenantId;
    phone?: string | null;
    pushToken?: string | null;
    email?: string | null;
  }): Recipient {
    return new Recipient({
      id: props.id,
      tenantId: props.tenantId,
      phone: props.phone ?? null,
      pushToken: props.pushToken ?? null,
      email: props.email ?? null,
      createdAt: new Date(),
    });
  }

  static reconstitute(props: RecipientProps): Recipient {
    return new Recipient(props);
  }

  get id(): RecipientId {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get phone(): string | null {
    return this.props.phone;
  }

  get pushToken(): string | null {
    return this.props.pushToken;
  }

  get email(): string | null {
    return this.props.email;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Does this recipient have an address to deliver on `channel` at all?
   * A missing address and an opted-out preference are different reasons
   * to skip a send — this only answers the former. */
  hasAddressFor(channel: Channel): boolean {
    switch (channel) {
      case "sms":
        return this.props.phone !== null;
      case "push":
        return this.props.pushToken !== null;
      case "email":
        return this.props.email !== null;
      case "in_app":
        // in_app has no external address — delivery is "does this
        // recipient exist," which it does by construction here.
        return true;
    }
  }
}
