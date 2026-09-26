import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("shared public portal containment", () => {
  it("gives every public application a bounded page, panel, row and text contract", () => {
    const css = read("src/styles.css");
    for (const utility of [
      "@utility neo-public-app",
      "@utility neo-public-wrap",
      "@utility neo-public-panel",
      "@utility neo-public-row",
      "@utility neo-rider-card",
      "@utility neo-rider-page",
    ]) {
      expect(css).toContain(utility);
    }
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toContain("overflow-wrap: break-word");
    expect(css).toContain("word-break: normal");
  });

  it("connects Guest and Rider roots to the shared visual system", () => {
    expect(read("src/components/public/PublicAppShell.tsx")).toContain("neo-public-app");
    expect(read("src/components/public/GuestScreen.tsx")).toContain("neo-rider-card");
    for (const path of [
      "src/routes/rider.index.tsx",
      "src/routes/rider.active.tsx",
      "src/routes/rider.profile.tsx",
      "src/routes/rider.support.tsx",
    ]) {
      expect(read(path), path).toContain("neo-rider-page");
    }
  });

  it("contains partner tables and platform-console records locally", () => {
    const partner = read("src/routes/partner.$propertySlug.tsx");
    const consoleRoute = read("src/routes/platform-console.tsx");
    expect(partner).toContain("neo-table-scroll");
    expect(partner).toContain("table-fixed");
    expect(consoleRoute).toContain("neo-public-app");
    expect(consoleRoute).toContain("neo-table-scroll");
  });

  it("lets shared buttons wrap and shared cards contain their contents", () => {
    expect(read("src/components/ui/button.tsx")).toContain("whitespace-normal");
    expect(read("src/components/ui/card.tsx")).toContain("overflow-hidden");
  });
});