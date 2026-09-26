import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECK_IN_EFFECTS,
  RECONCILIATION_ISSUES,
  REVERT_CAPABILITIES,
  REVERT_EFFECTS,
  REVERT_REFUSALS,
  revertAllowed,
} from "@/lib/checkin-lifecycle";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const SQL = readFileSync(
  join(process.cwd(), "src/lib/__tests__/fixtures/pms-checkin-lifecycle.sql"),
  "utf8",
);

describe("check-in reversal contract", () => {
  it("touches every record the arrival created", () => {
    for (const table of REVERT_EFFECTS) {
      expect(SQL, `revert must handle ${table}`).toContain(`public.${table}`);
    }
  });

  it("removes the stay, its folio and the arrival workflow event", () => {
    expect(SQL).toMatch(/DELETE FROM public\.folio_lines/);
    expect(SQL).toMatch(/DELETE FROM public\.folios/);
    expect(SQL).toMatch(/DELETE FROM public\.stays/);
    expect(SQL).toMatch(/DELETE FROM public\.pms_workflow_events/);
  });

  it("returns the reservation to confirmed and frees the room", () => {
    expect(SQL).toMatch(/SET status = 'confirmed'/);
    expect(SQL).toMatch(/room_condition = 'vacant-clean'/);
  });

  it("refuses when the folio already carries posted lines", () => {
    expect(SQL).toContain("folio_has_activity");
    expect(SQL).toMatch(/coalesce\(status,'posted'\) <> 'reversed'/);
  });

  it("declares every refusal reason the database can return", () => {
    for (const r of REVERT_REFUSALS) {
      expect(SQL, `missing refusal ${r.reason}`).toContain(`'${r.reason}'`);
    }
  });

  it("demands a written reason and records it in the audit trail", () => {
    expect(SQL).toContain("reason_required");
    expect(SQL).toContain("'pms.checkin.revert'");
    expect(SQL).toMatch(/INSERT INTO public\.audit_logs/);
  });

  it("enforces capability and property scope server-side", () => {
    for (const cap of REVERT_CAPABILITIES) {
      const [, feature, action] = cap.split(".");
      expect(SQL).toContain(`has_permission('pms','${feature}.${action}')`);
    }
    expect(SQL).toContain("neo_branch_in_scope");
  });

  it("is registered as an authenticated routine", () => {
    expect(RPC_MANIFEST["pms_revert_check_in"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_checkin_reconciliation"]).toBe("authenticated");
  });

  it("is not executable by anonymous callers", () => {
    expect(SQL).toMatch(/REVOKE EXECUTE ON FUNCTION public\.pms_revert_check_in/);
    expect(SQL).toMatch(/REVOKE EXECUTE ON FUNCTION public\.neo_checkin_reconciliation/);
  });
});

describe("revert eligibility mirror", () => {
  const base = { hasStay: true, checkedOut: false, liveFolioLines: 0, reason: "Wrong room" };

  it("allows a clean revert", () => {
    expect(revertAllowed(base)).toEqual({ allowed: true });
  });

  it.each([
    [{ ...base, reason: "  " }, "reason_required"],
    [{ ...base, hasStay: false }, "not_checked_in"],
    [{ ...base, checkedOut: true }, "already_checked_out"],
    [{ ...base, liveFolioLines: 2 }, "folio_has_activity"],
  ])("refuses %o", (input, reason) => {
    expect(revertAllowed(input)).toEqual({ allowed: false, reason });
  });
});

describe("in-house reconciliation monitor", () => {
  it("declares every finding the SQL emits, with matching severity and drill target", () => {
    for (const f of RECONCILIATION_ISSUES) {
      expect(SQL, `missing issue ${f.issue}`).toContain(`'${f.issue}'`);
      expect(SQL).toContain(`'${f.drill}'`);
    }
    const emitted = [...SQL.matchAll(/SELECT '([a-z_]+)'(?:::text)?, '(critical|warning|info)'/g)].map(
      (m) => m[1],
    );
    expect(new Set(emitted)).toEqual(new Set(RECONCILIATION_ISSUES.map((f) => f.issue)));
  });

  it("keeps the arrival effects list aligned with what reconciliation checks", () => {
    expect(CHECK_IN_EFFECTS).toContain("stays");
    expect(SQL).toContain("checked_in_without_stay");
    expect(SQL).toContain("stay_without_folio");
  });
});
