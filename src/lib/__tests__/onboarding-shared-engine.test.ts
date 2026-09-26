import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ONBOARDING_DOMAINS, domainByKey, duplicateRulesFor, stageOf } from "@/lib/onboarding/domains";
import { allAdapters, adapterFor } from "@/lib/onboarding/adapters";

/**
 * Shared-engine regression suite.
 *
 * The Hotel Data Onboarding Centre is one product. A behaviour that belongs to
 * the engine — the workspace shell, scrolling, pagination, resolution,
 * duplicate decisions, the plan, the readiness gate, the lifecycle — must be
 * implemented once and inherited by every adapter. These tests fail if any
 * adapter forks that behaviour, and they fail if the workspace shell loses the
 * layout guarantees that keep long content reachable.
 *
 * The scrolling defect these guard against was real: the workspace body used a
 * scroll primitive whose viewport height resolves against its parent. Inside a
 * flex column with no resolved height, it clipped instead of scrolling, so at
 * 29 unresolved values (Inventory Items) the administrator could see that more
 * rows existed and could not reach them. That was never an Inventory bug — it
 * was the shell, so it applied to every adapter and every tenant.
 */

const shell = readFileSync("src/components/onboarding/OnboardingWorkspace.tsx", "utf8");
const wizard = readFileSync("src/components/onboarding/ImportWizard.tsx", "utf8");

const ADAPTER_KEYS_UNDER_REGRESSION = [
  "assets",
  "stock_items",
  "employees",
  "rooms",
  "suppliers",
];

describe("one shared workspace shell", () => {
  it("bounds the surface to the viewport so the footer can never be pushed off-screen", () => {
    expect(shell).toContain("h-[100dvh]");
    expect(shell).toContain("sm:h-[94dvh]");
    expect(shell).toContain("overflow-hidden");
  });

  it("scrolls exactly one region, with native overflow that cannot clip", () => {
    const body = shell.slice(shell.indexOf('data-onboarding-shell="body"'));
    expect(body).toContain("min-h-0");
    expect(body).toContain("flex-1");
    expect(body).toContain("overflow-y-auto");
    expect(body).toContain("overscroll-contain");
  });

  it("keeps the header and the action bar out of the scrolling region", () => {
    const header = shell.slice(shell.indexOf('data-onboarding-shell="header"'));
    expect(header.slice(0, 400)).toContain("shrink-0");
    const footer = shell.slice(shell.indexOf('data-onboarding-shell="footer"'));
    expect(footer.slice(0, 400)).toContain("shrink-0");
    // The footer is a sibling below the body, never overlaying it, so no row
    // of the table can hide beneath the actions.
    expect(shell.indexOf('data-onboarding-shell="body"')).toBeLessThan(
      shell.indexOf('data-onboarding-shell="footer"'),
    );
  });

  it("respects the mobile safe area so the actions stay tappable on a phone", () => {
    expect(shell).toContain("env(safe-area-inset-bottom)");
  });

  it("never reintroduces a height-dependent scroll primitive in the workspace", () => {
    expect(shell.includes('from "@/components/ui/scroll-area"')).toBe(false);
    expect(wizard.includes('from "@/components/ui/scroll-area"')).toBe(false);
  });
});

describe("every adapter inherits the shell rather than forking it", () => {
  it("routes the whole wizard through the shared workspace", () => {
    expect(wizard).toContain("<OnboardingWorkspace");
    // No adapter-specific dialog, sheet or drawer shell inside the wizard.
    expect(/<DialogContent/.test(wizard)).toBe(false);
    expect(/<SheetContent/.test(wizard)).toBe(false);
  });

  it("gives the shell the action bar, so it is reachable at any content length", () => {
    expect(wizard).toContain("footer={footerActions}");
  });

  it("has exactly one onboarding wizard implementation in the product", () => {
    // A second wizard file is how two implementations start to diverge.
    const others = [
      "src/components/onboarding/AssetImportWizard.tsx",
      "src/components/onboarding/InventoryImportWizard.tsx",
      "src/components/onboarding/EmployeeImportWizard.tsx",
    ];
    for (const path of others) {
      let exists = true;
      try {
        readFileSync(path, "utf8");
      } catch {
        exists = false;
      }
      expect(exists, `forked onboarding wizard: ${path}`).toBe(false);
    }
  });
});

describe("adapter contract — adapters declare domain meaning only", () => {
  it.each(ADAPTER_KEYS_UNDER_REGRESSION)("%s plugs into the shared engine", (key) => {
    const domain = domainByKey(key);
    expect(domain, `missing domain: ${key}`).toBeTruthy();
    const adapter = adapterFor(key);
    expect(adapter, `missing adapter: ${key}`).toBeTruthy();
    // Domain declarations, not workflow: schema, destination, write rules.
    expect(domain!.fields.length).toBeGreaterThan(0);
    expect(domain!.fields.some((f) => f.requirement === "required")).toBe(true);
    expect(adapter!.table).toBeTruthy();
  });

  it("keeps duplicate evidence adapter-specific while the framework stays shared", () => {
    for (const key of ADAPTER_KEYS_UNDER_REGRESSION) {
      const domain = domainByKey(key)!;
      const rules = duplicateRulesFor(domain);
      expect(rules.length, `no duplicate evidence declared for ${key}`).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(["exact", "probable", "possible"]).toContain(rule.classification);
        expect(rule.fields.length).toBeGreaterThan(0);
      }
    }
  });

  it("never lets an adapter claim identity from weak evidence alone", () => {
    // Hotels legitimately stock similarly named items in different pack sizes,
    // so for operational records a name-only match can never be certain. A
    // foundation list (departments, categories, stores) is different: there the
    // name genuinely is the identity.
    for (const domain of ONBOARDING_DOMAINS) {
      if (stageOf(domain) === "foundation") continue;
      for (const rule of duplicateRulesFor(domain)) {
        if (rule.classification !== "exact") continue;
        const onlyName = rule.fields.length === 1 && /name|title|label/.test(rule.fields[0]!);
        expect(onlyName, `${domain.key}: name alone treated as certain identity`).toBe(false);
      }
    }
  });

  it("declares every adapter against a real domain, with no orphan adapters", () => {
    for (const adapter of allAdapters()) {
      expect(domainByKey(adapter.key), `orphan adapter: ${adapter.key}`).toBeTruthy();
    }
  });

  it("keeps transactional domains out of direct table import", () => {
    // Reservations, opening stock and opening balances must commit through
    // their own engines; they may share upload, mapping and resolution only.
    for (const key of ["future_reservations", "opening_stock", "opening_balances"]) {
      expect(adapterFor(key), `${key} must not have a direct-write adapter`).toBeUndefined();
    }
  });
});
