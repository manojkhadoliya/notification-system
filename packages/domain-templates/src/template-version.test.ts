import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TemplateId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";
import { TemplateVersion } from "./template-version.js";

const templateId = TemplateId("44444444-4444-4444-4444-444444444444");

function publish(overrides: Partial<{ version: number; content: string }>) {
  return TemplateVersion.publish({
    id: TemplateVersionId("55555555-5555-5555-5555-555555555555"),
    templateId,
    locale: "en-US",
    version: 1,
    content: "Hello {{name}}",
    ...overrides,
  });
}

test("publish() accepts a valid version", () => {
  const v = publish({});
  assert.equal(v.version, 1);
  assert.equal(v.content, "Hello {{name}}");
});

test("publish() rejects version 0 or negative", () => {
  assert.throws(() => publish({ version: 0 }));
  assert.throws(() => publish({ version: -1 }));
});

test("publish() rejects a non-integer version", () => {
  assert.throws(() => publish({ version: 1.5 }));
});

test("publish() rejects empty content", () => {
  assert.throws(() => publish({ content: "   " }));
});
