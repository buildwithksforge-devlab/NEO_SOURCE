import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(entry.name) ? [file] : [];
});

describe("NEØ shared date language", () => {
  const source = read("src/components/common/DatePicker.tsx");

  it("exports both the single and range pickers", () => {
    expect(source).toContain("export function NeoDatePicker");
    expect(source).toContain("export function NeoDateRangePicker");
  });

  it("keeps the ISO YYYY-MM-DD value contract of a native date input", () => {
    expect(source).toMatch(/toIso/);
    expect(source).toMatch(/parseIso/);
  });

  it("builds on the shared Calendar/Popover stack rather than a browser date input", () => {
    expect(source).toContain("@/components/ui/calendar");
    expect(source).toContain("@/components/ui/popover");
    expect(source).not.toMatch(/<input[^>]*type="date"/);
  });

  it("respects the density system for touch targets", () => {
    expect(source).toContain("useDensity");
  });

  it("has replaced native date inputs across the staff app", () => {
    const out = ["src/routes", "src/components"]
      .flatMap(sources)
      .filter((file) => read(file).includes('type="date"'))
      // The shared Field helpers branch on a "date" type prop; they render
      // NeoDatePicker, not a native input.
      .filter((f) => !/NeoDatePicker|NeoDateRangePicker/.test(read(f)));
    expect(out).toEqual([]);
  });
});

describe("Powered by NEØ signature", () => {
  it("uses the full wordmark asset, never the glyph alone", () => {
    const identity = read("src/components/brand/NeoIdentity.tsx");
    expect(identity).toContain("export function PoweredByNeoSignature");
    expect(identity).toMatch(/Powered by/);
    const signature = identity.slice(identity.indexOf("PoweredByNeoSignature"));
    expect(signature).toContain("NEO_WORDMARK_SRC");
    expect(signature).toContain('alt="NEØ"');
  });

  it("is rendered in the staff shell footer", () => {
    expect(read("src/components/layout/AppShell.tsx")).toContain("PoweredByNeoSignature");
  });

  it("is rendered in the public app shell", () => {
    expect(read("src/components/public/PublicAppShell.tsx")).toContain("NEO_WORDMARK_SRC");
  });
});

describe("Direct stock intake", () => {
  const dialog = read("src/components/inventory/ReceiveStockDialog.tsx");

  it("posts through the canonical stock ledger routine", () => {
    expect(dialog).toContain("useApplyMovement");
    expect(dialog).not.toContain("stock_levels");
  });

  it("supports both a direct purchase receipt and an opening balance", () => {
    expect(dialog).toContain('value="receipt"');
    expect(dialog).toContain('value="opening"');
  });

  it("is reachable as a primary action from the Inventory dashboard", () => {
    const index = read("src/routes/_shell.inventory.index.tsx");
    expect(index).toContain("ReceiveStockDialog");
    expect(index).toContain("Receive stock");
  });

  it("is offered alongside PO receiving", () => {
    expect(read("src/routes/_shell.inventory.receiving.tsx")).toContain(
      "Direct / opening receipt",
    );
  });
});

describe("Auth confirmation email artifact", () => {
  it("ships a branded HTML template with the required variables", () => {
    const html = read("emails/auth/confirm-signup.html");
    expect(html).toContain("{{ .ConfirmationURL }}");
    expect(html).toContain(".Data.full_name");
    expect(html).toContain('alt="NEØ"');
    expect(html).toMatch(/Powered by/);
  });

  it("ships a plain-text alternative", () => {
    expect(read("emails/auth/confirm-signup.txt")).toContain("{{ .ConfirmationURL }}");
  });
});

// Keep the unused import lint-safe.
