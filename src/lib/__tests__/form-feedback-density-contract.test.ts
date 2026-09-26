/**
 * Track B UX contract: viewport-safe forms, a dirty-state Save gate, one
 * feedback language and a user-controlled dashboard density.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("form shell", () => {
  const dialog = read("src/components/ui/dialog.tsx");
  const shell = read("src/components/common/FormDialog.tsx");

  it("keeps dialogs inside the viewport and scrolls only the body", () => {
    expect(dialog).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(dialog).toMatch(/DialogBody/);
    expect(dialog).toContain("min-h-0 flex-1 overflow-y-auto");
  });

  it("gives every dialog a clear close affordance sized for touch", () => {
    expect(dialog).toContain('aria-label="Close"');
    expect(dialog).toContain("size-9");
  });

  it("uses a sticky footer action row in the shared form shell", () => {
    expect(shell).toContain("DialogFooter");
    expect(shell).toContain("border-t");
    expect(shell).toContain("env(safe-area-inset-bottom)");
  });
});

describe("dirty save gate", () => {
  const menu = read("src/components/pos/MenuCatalogueManager.tsx");

  it("only enables Save on a real change when editing", () => {
    expect(menu).toContain("useDirtyForm");
    expect(menu).toContain("const ready = valid && dirty;");
  });

  it("does not clear the stored category before options have loaded", () => {
    expect(menu).toContain("if (!optionsLoaded) return;");
  });

  it("re-baselines after a successful save", () => {
    expect(menu).toContain("markSaved(snapshot);");
  });
});

describe("feedback language", () => {
  const toaster = read("src/components/ui/sonner.tsx");
  const alert = read("src/components/ui/alert.tsx");
  const css = read("src/styles.css");

  it("styles toasts as NEØ surfaces with semantic tones", () => {
    for (const tone of ["success", "warning", "error", "info"]) {
      expect(toaster).toContain(`neo-toast-${tone}`);
      expect(css).toContain(`.neo-toast-${tone}`);
    }
    expect(toaster).toContain("closeButton");
  });

  it("gives alerts the same semantic variants", () => {
    for (const tone of ["success", "warning", "info", "neutral", "destructive"]) {
      expect(alert).toContain(`${tone}:`);
    }
  });
});

describe("dashboard density", () => {
  const css = read("src/styles.css");
  const frame = read("src/components/dashboard/DashboardFrame.tsx");
  const shellFile = read("src/components/layout/AppShell.tsx");

  it("drives spacing from a document-level attribute", () => {
    expect(css).toContain('[data-density="compact"] .neo-card-pad');
    expect(css).toContain('[data-density="comfortable"] .neo-card-pad');
    expect(css).toContain('[data-density="touch"] .neo-card-pad');
  });

  it("exposes the control from the dashboard toolbar's own stable slot", () => {
    // Density is a workspace display preference, not shell chrome: it lives in
    // a dedicated right-hand slot of the dashboard filter toolbar and must
    // never return to the global header.
    const topbar = read("src/components/layout/Topbar.tsx");
    expect(topbar).not.toContain("DensityToggle");
    expect(frame).toContain("data-density-slot");
    expect(frame).toContain("<DensityToggle className=\"hidden md:inline-flex\" />");
    expect(frame).toContain("<DensityToggle variant=\"menu\" className=\"md:hidden\" />");
  });


  it("keeps the preference per signed-in user", () => {
    expect(shellFile).toContain("scopeDensityToUser(user?.id ?? null)");
  });
});

describe("filter surface", () => {
  const css = read("src/styles.css");
  const frame = read("src/components/dashboard/DashboardFrame.tsx");

  it("shares one responsive filter bar", () => {
    expect(css).toContain("@utility neo-filter-bar");
    expect(frame).toContain("neo-filter-bar");
  });
});
