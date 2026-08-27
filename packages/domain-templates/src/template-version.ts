import type {
  TemplateId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";

/** BCP-47-ish locale tag, e.g. `en-US`. Not validated against a fixed list
 * here — that's a UI/API-boundary concern, not a domain invariant. */
export type Locale = string;

export interface TemplateVersionProps {
  readonly id: TemplateVersionId;
  readonly templateId: TemplateId;
  readonly locale: Locale;
  readonly version: number;
  /** Handlebars source. Rendering it is `services/router`'s job (see
   * roadmap.md's Phase 1 checklist) — this package only owns the
   * immutable content, not the templating engine that interprets it;
   * swapping engines is a technology choice, not a domain one (see
   * domain-model.md#where-does-new-logic-belong). */
  readonly content: string;
  readonly createdAt: Date;
}

/** An immutable, locale-specific rendering of a `Template` — see
 * domain-model.md#templates. A `NotificationRequest` references a specific
 * version by id, never "the latest," so an edit never changes the content
 * of an already-sent request's history; edits create a new version. */
export class TemplateVersion {
  private constructor(private readonly props: TemplateVersionProps) {}

  /** `version` is provided by the caller (the repository knows the current
   * max for this `templateId` and increments it) rather than computed
   * here — this entity can't see other versions of the same template to
   * derive "next" itself. */
  static publish(props: {
    id: TemplateVersionId;
    templateId: TemplateId;
    locale: Locale;
    version: number;
    content: string;
  }): TemplateVersion {
    if (props.version < 1 || !Number.isInteger(props.version)) {
      throw new Error("TemplateVersion.version must be a positive integer");
    }
    if (props.content.trim().length === 0) {
      throw new Error("TemplateVersion.content must not be empty");
    }
    return new TemplateVersion({ ...props, createdAt: new Date() });
  }

  static reconstitute(props: TemplateVersionProps): TemplateVersion {
    return new TemplateVersion(props);
  }

  get id(): TemplateVersionId {
    return this.props.id;
  }

  get templateId(): TemplateId {
    return this.props.templateId;
  }

  get locale(): Locale {
    return this.props.locale;
  }

  get version(): number {
    return this.props.version;
  }

  get content(): string {
    return this.props.content;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
