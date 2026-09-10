import { describe, expect, it } from "vitest";
import { TitleTagsSchema } from "../../config/project-config.ts";
import { renderHeader, renderTitleTag } from "./header.ts";

describe("renderHeader", () => {
  const template = ["// case: {case}", "// sheet: {link.url} row {link.ref}", "// {title}"].join("\n");

  it("fills the placeholders the case has", () => {
    expect(
      renderHeader(template, {
        case: "todo/add_item",
        "link.url": "https://example.test/sheet",
        "link.ref": "1030",
        title: "Adding an item puts it on the list",
      }),
    ).toBe(
      [
        "// case: todo/add_item",
        "// sheet: https://example.test/sheet row 1030",
        "// Adding an item puts it on the list",
      ].join("\n"),
    );
  });

  it("drops a line whose placeholders are all empty, and keeps a partly-filled one", () => {
    const out = renderHeader(template, { case: "todo/add_item", "link.ref": "1030" });
    expect(out).toBe(["// case: todo/add_item", "// sheet:  row 1030"].join("\n"));
  });
});

describe("renderTitleTag", () => {
  const tags = TitleTagsSchema.parse({ field: "priority", map: { high: "high", low: "low" } });

  it("maps the field's value through the project's own table", () => {
    expect(renderTitleTag(tags, { priority: "high" })).toBe(" @high");
  });

  it("tags nothing when the project has not classified the value", () => {
    expect(renderTitleTag(tags, { priority: "someday" })).toBe("");
    expect(renderTitleTag(tags, {})).toBe("");
    expect(renderTitleTag(undefined, { priority: "high" })).toBe("");
  });
});
