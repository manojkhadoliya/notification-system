import type {
  Channel,
  TemplateId,
  TenantId,
} from "@notification-system/shared-kernel";

export interface TemplateProps {
  readonly id: TemplateId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly channel: Channel;
  readonly createdAt: Date;
}

/** A named, tenant-owned, per-channel message definition — see
 * domain-model.md#templates. `name` is unique per tenant (per
 * data-model.md), enforced by the adapter's unique constraint — the
 * domain layer states the rule but doesn't itself have a way to check
 * uniqueness without a repository round-trip. */
export class Template {
  private constructor(private readonly props: TemplateProps) {}

  static create(props: {
    id: TemplateId;
    tenantId: TenantId;
    name: string;
    channel: Channel;
  }): Template {
    if (props.name.trim().length === 0) {
      throw new Error("Template name must not be empty");
    }
    return new Template({ ...props, createdAt: new Date() });
  }

  static reconstitute(props: TemplateProps): Template {
    return new Template(props);
  }

  get id(): TemplateId {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get channel(): Channel {
    return this.props.channel;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
