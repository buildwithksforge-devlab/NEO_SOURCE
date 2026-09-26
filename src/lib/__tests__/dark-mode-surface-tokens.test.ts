import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_BOOT_SCRIPT } from "../brand-cache";

const root = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Dark mode regression guard.
 *
 * The tenant palette writes brand tokens onto the document. Surface tokens
 * (--background / --foreground / --secondary) are LIGHT-mode values: if they
 * are applied while `.dark` is active they beat the `.dark` block and the whole
 * shell renders as a light dashboard on a dark chrome.
 */
describe("dark mode surface tokens", () => {
  it("boot script sets the dark class before writing brand tokens", () => {
    const darkIdx = BRAND_BOOT_SCRIPT.indexOf('classList.toggle("dark"');
    const bgIdx = BRAND_BOOT_SCRIPT.indexOf("--background");
    expect(darkIdx).toBeGreaterThan(-1);
    expect(bgIdx).toBeGreaterThan(darkIdx);
  });

  it("boot script only writes light surface tokens when not dark", () => {
    expect(BRAND_BOOT_SCRIPT).toContain("if(!k){");
    for (const token of ["--background", "--foreground", "--secondary"]) {
      const idx = BRAND_BOOT_SCRIPT.indexOf(token);
      expect(idx).toBeGreaterThan(BRAND_BOOT_SCRIPT.indexOf("if(!k){"));
    }
  });

  it("boot script still applies theme-independent brand hue tokens", () => {
    expect(BRAND_BOOT_SCRIPT).toContain("--brand:");
    expect(BRAND_BOOT_SCRIPT).toContain("--brand-accent:");
  });

  it("tenant provider removes light surface overrides in dark mode", () => {
    const src = read("lib/tenant.tsx");
    for (const token of ["--secondary", "--background", "--foreground"]) {
      expect(src).toContain(`root.style.removeProperty("${token}")`);
    }
  });

  it("both themes define the full surface, chip and tint scale", () => {
    const css = read("styles.css");
    const dark = css.slice(css.indexOf(".dark {"));
    for (const token of [
      "--surface-1",
      "--surface-2",
      "--surface-3",
      "--chip",
      "--chip-selected",
      "--tint-success",
      "--tint-warning",
      "--tint-info",
      "--tint-destructive",
      "--tint-accent",
      "--on-tint-success",
      "--on-tint-warning",
      "--on-tint-info",
      "--on-tint-destructive",
      "--on-tint-accent",
      "--outline-subtle",
    ]) {
      expect(dark).toContain(`${token}:`);
    }
  });

  it("core staff-shell shared components use semantic tokens, not light-only classes", () => {
    const files = [
      "components/ui/card.tsx",
      "components/ui/badge.tsx",
      "components/ui/button.tsx",
      "components/ui/input.tsx",
      "components/ui/table.tsx",
      "components/ui/select.tsx",
      "components/ui/dropdown-menu.tsx",
      "components/ui/popover.tsx",
      "components/ui/dialog.tsx",
      "components/ui/tooltip.tsx",
      "components/common/DataDisplay.tsx",
      "components/dashboard/DashboardFrame.tsx",
      "components/layout/AppShell.tsx",
      "components/layout/Topbar.tsx",
      "components/layout/Sidebar.tsx",
    ];
    const banned = /\b(bg-white|text-black|bg-black|(bg|text|border)-(gray|slate|neutral|zinc)-\d{2,3})\b/;
    for (const file of files) {
      expect(banned.test(read(file)), `${file} uses a light-only class`).toBe(false);
    }
  });
});
