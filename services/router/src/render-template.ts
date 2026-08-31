import Handlebars from "handlebars";

/**
 * Compiles and renders `content` (a `TemplateVersion`'s Handlebars source
 * — see domain-templates' doc comment on why the templating engine is a
 * technology choice made here, not in the domain layer) against
 * `variables`. `noEscape: true` — the output is plain-text message
 * content (an SMS/push/email body), not HTML markup being interpolated
 * into a page, so Handlebars' default HTML-entity escaping (`&` ->
 * `&amp;`, etc.) would actively corrupt it rather than protect anything.
 *
 * Not cached — `TemplateVersion` rows are immutable once published (see
 * that entity's doc comment), so a fresh compile per call is simple and
 * correct; revisit only if profiling ever shows compilation itself as a
 * hot path.
 */
export function renderTemplate(
  content: string,
  variables: Record<string, unknown>,
): string {
  const template = Handlebars.compile(content, {
    noEscape: true,
    strict: false,
  });
  return template(variables);
}
