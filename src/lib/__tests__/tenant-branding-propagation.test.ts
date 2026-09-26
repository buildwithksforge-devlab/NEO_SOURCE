/**
 * Tenant branding propagation.
 *
 * Every accent, wash, icon well and logo on a dashboard surface must resolve
 * from the tenant's own brand tokens, applied at runtime by the tenant
 * provider. A literal colour anywhere in that chain would show one tenant's
 * palette inside another tenant's workspace, so the contract is: tokens in the
 * stylesheet, variables on the document root, and no hardcoded colour in any
 * shared surface or dashboard route.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const styles = read("src/styles.css");
const tenant = read("src/lib/tenant.tsx");

/** Shared surfaces every dashboard is composed from. */
const SHARED_SURFACES = [
  "src/components/common/DataDisplay.tsx",
  "src/components/common/StateSystem.tsx",
  "src/components/common/FactCard.tsx",
  "src/components/common/CommitmentsInbox.tsx",
  "src/components/charts/ChartKit.tsx",
];

/** A literal colour: hex, rgb()/hsl() literal, or a fixed Tailwind colour. */
const HARDCODED = [
  /#[0-9a-fA-F]{3,8}\b/,
  /\b(?:rgb|rgba|hsl|hsla)\(\s*\d/,
  /\b(?:bg|text|border|from|to|via)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
  /\b(?:bg|text|border)-(?:white|black)\b/,
];

describe("tenant brand tokens reach the UI at runtime", () => {
  it("the tenant provider writes brand variables onto the document root", () => {
    for (const variable of ["--brand", "--brand-accent", "--font-sans"]) {
      expect(tenant).toContain(`setProperty("${variable}"`);
    }
  });

  it("the logo is resolved per theme from the tenant's own uploads", () => {
    expect(tenant).toContain("pickThemedLogo");
    expect(tenant).toMatch(/logoLight/);
    expect(tenant).toMatch(/logoDark/);
  });

  it("the stylesheet derives its brand surfaces from the brand variables", () => {
    expect(styles).toContain("--brand");
    // Washes, icon wells and rails are all colour-mixed from the token, so a
    // property switch repaints them without touching component code.
    for (const utility of ["neo-page-hero", "neo-icon-well", "neo-section-rail"]) {
      expect(styles).toContain(`@utility ${utility}`);
    }
    expect(styles).toMatch(/color-mix\(/);
  });
});

describe("no surface hardcodes a tenant colour", () => {
  const dashboards = readdirSync("src/routes")
    .filter((f) => f.startsWith("_shell.") && f.endsWith(".tsx"))
    .map((f) => `src/routes/${f}`);

  it.each([...SHARED_SURFACES, ...dashboards])("%s uses only design tokens", (file) => {
    const src = read(file)
      // Comments may legitimately mention a brand hex in prose.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of HARDCODED) {
      expect(src).not.toMatch(pattern);
    }
  });
});
