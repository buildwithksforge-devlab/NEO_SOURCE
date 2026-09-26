/**
 * Void, cancel and discount governance.
 *
 * Authority is proven twice: in the compiled role model (who is granted the
 * action at all) and in the deployed database guards exported verbatim into
 * `fixtures/pos-void-governance.sql` (what the database refuses regardless of
 * what the browser sends).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleFeatures } from "@/lib/capabilities";
import {
  ROLE_ACCESS_SCOPES,
  ROLE_FEATURE_TEMPLATES,
  actionsForScope,
  compileRoleTemplate,
} from "@/lib/role-templates";

const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/pos-void-governance.sql"), "utf8");
const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const orderGuard = fn("neo_pos_guard_void_discount");
const itemGuard = fn("neo_pos_guard_item_void");
const orderStates = fn("pos_enforce_order_status");

const FEATURES = moduleFeatures();
const grantsFor = (role: string) => compileRoleTemplate(role, FEATURES);
const holds = (role: string, module: string, feature: string, action: string) =>
  grantsFor(role).some((g) => g.module === module && g.feature === feature && g.action === action);

/** Roles that must never hold void, refund or discount-override authority. */
const NON_AUTHORISED = [
  "finance-manager",
  "waiter",
  "barista",
  "receptionist",
  "housekeeper",
  "rider",
  "store-keeper",
].filter((r) => r in ROLE_FEATURE_TEMPLATES);

describe("who is granted void authority at all", () => {
  it("covers the roles named in the governance rule", () => {
    expect(NON_AUTHORISED.length).toBeGreaterThanOrEqual(5);
  });

  it("only organisation-scope roles receive void or refund actions from a template", () => {
    for (const [role, scope] of Object.entries(ROLE_ACCESS_SCOPES)) {
      const actions = actionsForScope(scope);
      if (scope === "organisation") {
        expect(actions, `${role} should carry void`).toContain("void");
      } else {
        expect(actions, `${role} must not carry void`).not.toContain("void");
        expect(actions, `${role} must not carry refund`).not.toContain("refund");
        expect(actions, `${role} must not carry override`).not.toContain("override");
      }
    }
  });

  it.each(NON_AUTHORISED)("%s cannot void, refund or override restaurant orders", (role) => {
    expect(holds(role, "restaurant", "orders", "void")).toBe(false);
    expect(holds(role, "restaurant", "orders", "refund")).toBe(false);
    expect(holds(role, "restaurant", "orders", "override")).toBe(false);
  });

  it("the owner holds void, refund and override", () => {
    expect(holds("owner", "restaurant", "orders", "void")).toBe(true);
    expect(holds("owner", "restaurant", "orders", "refund")).toBe(true);
    expect(holds("owner", "restaurant", "orders", "override")).toBe(true);
  });

  it("finance membership never carries operational void authority", () => {
    const finance = grantsFor("finance-manager");
    expect(finance.some((g) => g.action === "void" || g.action === "refund")).toBe(false);
    expect(finance.some((g) => g.module === "finance")).toBe(true);
  });

  it("a non-authorised role may still open the approvals queue only if templated for it", () => {
    for (const role of NON_AUTHORISED) {
      expect(holds(role, "restaurant", "approvals", "approve"), `${role} must not approve`).toBe(false);
    }
  });
});

describe("the database refuses an unauthorised void, whatever the browser sends", () => {
  it("guards the order void and cancel transition by capability, not by a hidden button", () => {
    expect(orderGuard).toContain("has_permission('restaurant','orders.void')");
    expect(orderGuard).toContain("void_requires_authority");
    expect(orderGuard).toContain("NEW.status IN ('voided','cancelled')");
    expect(orderGuard).toContain("42501");
  });

  it("guards the item void transition the same way", () => {
    expect(itemGuard).toContain("has_permission('restaurant','orders.void')");
    expect(itemGuard).toContain("void_requires_authority");
  });

  it("refuses an added or increased discount without discount authority", () => {
    expect(orderGuard).toContain("discount_requires_authority");
    expect(orderGuard).toContain("_new_disc > _old_disc + 0.0001");
    expect(orderGuard).toContain("has_permission('restaurant','orders.override')");
  });

  it("audits the actor, the order and the amounts for every void and discount", () => {
    expect(orderGuard).toContain("INSERT INTO public.audit_logs");
    expect(orderGuard).toContain("auth.uid()");
    expect(orderGuard).toContain("'restaurant.order.discount'");
    expect(itemGuard).toContain("INSERT INTO public.audit_logs");
  });

  it("runs before the write so a manipulated request never lands", () => {
    expect(SQL).toMatch(/BEFORE UPDATE ON public\.pos_orders/);
    expect(SQL).toMatch(/BEFORE UPDATE ON public\.pos_order_items/);
  });

  it("keeps the request path open: a void must pass through void-pending", () => {
    // The graph now lives in the shared rulebook the trigger reads.
    expect(orderStates).toContain("neo_pos_status_rules() -> OLD.status");
    const rules = readFileSync(
      join(process.cwd(), "src/lib/__tests__/fixtures/pos-status-rules.sql"),
      "utf8",
    );
    expect(rules).toContain("'void-pending', jsonb_build_array('voided','served','awaiting-payment')");
    expect(rules).toContain("'void-pending'");
  });
});
