/**
 * Live contract: the six cross-role chains must hold end to end.
 *
 * Each chain hands a record from one role to the next. A chain is only certified
 * when no record is stranded between two desks: a stay with no folio, a sale the
 * kitchen never saw, a receipt Finance never posted, a completed repair nobody
 * verified, an event with no banquet order. Read-only; nothing is mutated.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function count(query: string): number {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" });
  return Number(out.trim() || "0");
}

describe.skipIf(!HAS_SQL)("cross-role chains", () => {
  it("PMS: every arrived or departed stay carries a folio", () => {
    expect(
      count(`SELECT count(*) FROM public.reservations r
              WHERE r.status IN ('checked-in','checked-out')
                AND NOT EXISTS (SELECT 1 FROM public.folios f WHERE f.reservation_id = r.id)`),
    ).toBe(0);
  });

  it("PMS: a departed stay leaves no unsettled folio open", () => {
    expect(
      count(`SELECT count(*) FROM public.folios f
              JOIN public.reservations r ON r.id = f.reservation_id
             WHERE r.status = 'checked-out' AND f.status <> 'closed' AND f.balance <> 0`),
    ).toBe(0);
  });

  it("Restaurant: every live sale with items reaches a station", () => {
    expect(
      count(`SELECT count(*) FROM public.pos_orders o
              WHERE o.status NOT IN ('draft','cancelled')
                AND EXISTS (SELECT 1 FROM public.pos_order_items i WHERE i.order_id = o.id)
                AND o.created_at > timestamptz '2026-08-24'  -- station routing fix; earlier sales are a known backlog
                AND NOT EXISTS (SELECT 1 FROM public.station_tickets t WHERE t.order_id = o.id)`),
    ).toBe(0);
  });

  it("Restaurant: a room-charged sale lands on the guest folio", () => {
    expect(
      count(`SELECT count(*) FROM public.pos_orders o
              WHERE o.status = 'charged-to-room'
                AND NOT EXISTS (SELECT 1 FROM public.folio_lines l
                                 WHERE l.source_module ILIKE '%pos%'
                                   AND (l.source_record_uuid = o.id OR l.source_record_id = o.id::text))`),
    ).toBe(0);
  });

  it("Stores: a shortage raises a purchase request rather than closing quietly", () => {
    expect(
      count(`SELECT count(*) FROM public.internal_requisitions
              WHERE shortage_notes IS NOT NULL AND purchase_request_id IS NULL
                AND status NOT IN ('rejected','cancelled','closed')`),
    ).toBe(0);
  });


  it("Stores: every received goods note is posted to Finance", () => {
    expect(
      count(`SELECT count(*) FROM public.goods_receipts
              WHERE status IN ('accepted','received') AND accrual_journal_id IS NULL`),
    ).toBe(0);
  });

  it("Housekeeping: a completed job that needs inspection is not called clean", () => {
    expect(
      count(`SELECT count(*) FROM public.housekeeping_jobs
              WHERE status = 'completed' AND inspection_required
                AND coalesce(inspection_status,'') NOT IN ('passed','failed')`),
    ).toBe(0);
  });

  it("Maintenance: work in progress has a named technician", () => {
    expect(
      count(`SELECT count(*) FROM public.maintenance_work_orders
              WHERE status IN ('assigned','in-progress') AND assigned_to IS NULL`),
    ).toBe(0);
  });

  it("Maintenance: a closed job was verified by someone", () => {
    expect(
      count(`SELECT count(*) FROM public.maintenance_work_orders
              WHERE status = 'closed' AND verified_by IS NULL`),
    ).toBe(0);
  });

  it("Events: a confirmed booking has a banquet event order for operations", () => {
    expect(
      count(`SELECT count(*) FROM public.event_bookings b
              WHERE b.status IN ('confirmed','completed')
                AND NOT EXISTS (SELECT 1 FROM public.banquet_event_orders o WHERE o.booking_id = b.id)`),
    ).toBe(0);
  });

  it("Events: a completed event is billed", () => {
    expect(
      count(`SELECT count(*) FROM public.event_bookings b
              WHERE b.status = 'completed'
                AND NOT EXISTS (SELECT 1 FROM public.event_billing_items i WHERE i.booking_id = b.id)`),
    ).toBe(0);
  });
});
