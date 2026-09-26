/**
 * Room service → charge to room.
 *
 * Hospitality requires that a guest can consume first and pay later: production
 * must never be gated on payment, and a bill that has already been served must
 * still be postable to the guest's folio.
 *
 * Two defects were proven against the live database and repaired at the
 * narrowest layer, both inside `pos_post_room_charge`:
 *   • it jumped `served -> charged-to-room`, which the canonical order
 *     lifecycle guard rejects (cash settlement steps through
 *     `awaiting-payment`), so charge-to-room after service was impossible;
 *   • it inserted the folio line with a raw INSERT instead of the canonical
 *     `folio_post_charge`, so folio totals and balance never moved and the
 *     Finance auto-post was recorded as failed.
 *
 * These assertions read the deployed routine so a future edit cannot quietly
 * reintroduce either defect. Without a database connection the suite skips
 * rather than passing silently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

const routine = (name: string) =>
  HAS_SQL
    ? execFileSync(
        "psql",
        [
          "-At",
          "-c",
          `select replace(coalesce(string_agg(p.prosrc, ' '), ''), chr(10), ' ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}'`,
        ],
        { encoding: "utf8" },
      ).trim()
    : "";

describe.skipIf(!HAS_SQL)("room service charge to room", () => {
  const roomCharge = () => routine("pos_post_room_charge");

  it("accepts an open bill anywhere between production send and settlement", () => {
    // Charge to room is itself a settlement path: an unpaid bill that has been
    // sent to the kitchen or bar may be charged to the guest's room without a
    // prior cash payment or an artificial 'finalise' step.
    const src = roomCharge();
    for (const status of [
      "'sent'",
      "'accepted'",
      "'in-preparation'",
      "'partially-ready'",
      "'ready'",
      "'partially-served'",
      "'served'",
      "'awaiting-payment'",
    ]) {
      expect(src, `${status} must be chargeable to a room`).toContain(status);
    }
  });

  it("still refuses a bill that has not reached production", () => {
    const src = roomCharge();
    // The accepted list is the whole gate; draft/held/confirmed are absent.
    const gate = src.slice(src.indexOf("status NOT IN ("), src.indexOf("cannot be charged"));
    for (const status of ["'draft'", "'held'", "'confirmed'", "'cancelled'", "'voided'", "'closed'"]) {
      expect(gate, `${status} must not be chargeable to a room`).not.toContain(status);
    }
    expect(src).toContain("send it to production first");
  });

  it("settles straight to charged-to-room under the shared lifecycle rulebook", () => {
    const src = roomCharge();
    expect(src).toContain("status = 'charged-to-room'");
    const guard = routine("pos_enforce_order_status");
    // The guard now evaluates the shared rulebook; settlement states are still
    // only reachable from 'awaiting-payment'.
    expect(guard).toContain("neo_pos_status_rules() -> OLD.status");
    const rules = readFileSync(
      join(process.cwd(), "src/lib/__tests__/fixtures/pos-status-rules.sql"),
      "utf8",
    );
    expect(rules).toContain(
      "'awaiting-payment', jsonb_build_array('paid','charged-to-room','credit','void-pending')",
    );
    expect(rules).toContain("'served', jsonb_build_array('awaiting-payment','void-pending')");
    // Production states reach the same single pre-settlement state, so the one
    // settlement path is shared by cash, M-Pesa and room charge alike.
    expect(rules).toContain(
      "'sent', jsonb_build_array('accepted','in-preparation','partially-ready','ready','awaiting-payment','cancelled','void-pending')",
    );
  });

  it("posts through the canonical folio charge routine so balances move", () => {
    const src = roomCharge();
    expect(src).toContain("folio_post_charge(");
    expect(src).not.toContain("INSERT INTO public.folio_lines");
    // folio_post_charge is what maintains folio totals and balance.
    expect(routine("folio_post_charge")).toContain("balance = balance + _net");
  });

  it("keeps the charge idempotent and permission gated", () => {
    const src = roomCharge();
    expect(src).toContain("has_permission('pos','room_charge.post')");
    expect(src).toContain("Order already posted to a folio");
    // A repeat call with the same identity returns the first folio line rather
    // than charging the guest twice.
    expect(src).toContain("idempotency_key = _idempotency_key");
    expect(src).toContain("IF _line IS NOT NULL THEN RETURN _line; END IF;");
  });

  it("never requires payment before production", () => {
    // Sending to production has no payment precondition at all.
    const send = routine("neo_pos_send_to_kitchen");
    expect(send).not.toContain("payment_status");
  });
});
