import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fontOptions } from "@/lib/tenant-types";
import { fontCatalogue } from "@/lib/experience-brand";
describe("locally hosted brand fonts", () => {
  const css = readFileSync(resolve("src/fonts.css"), "utf8");
  it("backs every selectable family with a local face and system fallback", () => {
    for (const font of [...fontOptions, ...Object.values(fontCatalogue)]) {
      const family = font.stack.match(/["']([^"']+)["']/)?.[1];
      expect(css, font.label).toContain(`font-family: '${family}'`);
      expect(font.stack).toMatch(/sans-serif|serif/);
    }
  });
  it("ships each referenced binary and its pinned package license", () => {
    for (const [, url] of css.matchAll(/url\(([^)]+)\)/g)) {
      expect(url).not.toMatch(/^https?:/);
      expect(existsSync(resolve("node_modules", url!)), url).toBe(true);
      const packageName = url!.split("/files/")[0]!;
      expect(existsSync(resolve("node_modules", packageName, "LICENSE"))).toBe(true);
    }
  });
  it("loads no remote Google font stylesheet from the application root", () => {
    expect(readFileSync(resolve("src/routes/__root.tsx"), "utf8")).not.toMatch(
      /fonts\.(googleapis|gstatic)\.com/,
    );
    expect(readFileSync(resolve("src/styles.css"), "utf8")).toContain("./fonts.css");
  });
});
