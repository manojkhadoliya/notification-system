import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "./render-template.js";

describe("renderTemplate", () => {
  it("substitutes variables", () => {
    const result = renderTemplate(
      "Hello {{name}}, your order {{orderId}} shipped.",
      {
        name: "Alex",
        orderId: "4471",
      },
    );
    assert.equal(result, "Hello Alex, your order 4471 shipped.");
  });

  it("does not HTML-escape special characters (plain-text output, not HTML)", () => {
    const result = renderTemplate("{{company}}", {
      company: "Smith & Sons <ok>",
    });
    assert.equal(result, "Smith & Sons <ok>");
  });

  it("renders an empty string for a missing variable rather than throwing", () => {
    const result = renderTemplate("Hi {{name}}", {});
    assert.equal(result, "Hi ");
  });

  it("renders content with no variables unchanged", () => {
    assert.equal(renderTemplate("Static content.", {}), "Static content.");
  });
});
