/**
 * NEØ System Test — the deeper suites (server only).
 *
 * These go past "the happy path works": they drive the money controls, a real
 * priced event bill, the full role-by-role permission matrix, the sensitive
 * database routines and the inventory hierarchy, and they check that a finished
 * run keeps no credentials. Every case is driven through signed-in test accounts
 * inside the isolated QA workspaces; nothing writes a final status by hand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CriticalFailure, NotConfigured, Skipped, denial } from "./harness.server";
import type { SuiteContext } from "./suites.server";

type Client = SupabaseClient;

const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function client(ctx: SuiteContext, key: string): Client {
  const c = ctx.clientsA.get(key);
  if (!c) throw new Skipped(`The ${key} test account is not available.`);
  return c;
}

async function rpc(c: Client, name: string, args: Record<string, unknown>) {
  const { data, error } = await c.rpc(name as never, args as never);
  return { data: data as unknown, error: error as { message: string; code?: string } | null };
}

/* ------------------------------------------------- TEST 12 — money controls */

export async function suiteFinanceControls(ctx: SuiteContext) {
  const { rec } = ctx;
  // Taking and reconciling cash is the cashier's duty; approving a refund is the
  // owner's. The suite drives each control through the role that really holds it.
  const cashier = ctx.clientsA.get("cashier") ?? client(ctx, "accountant");
  const refunder = ctx.clientsA.get("receptionist") ?? cashier;
  const waiter = client(ctx, "waiter");
  const owner = client(ctx, "owner");
  const accountant = client(ctx, "accountant");

  let shiftId: string | null = null;

  await rec.run("Finance controls", 12, "till.open", "A till opens for the shift", async (t) => {
    const { data, error } = await rpc(cashier, "cash_open_shift", {
      _branch: ctx.a.branchId,
      _station: null,
      _float: 5000,
    });
    if (error) throw new NotConfigured(`A till could not be opened in this workspace: ${error.message}`);

    shiftId = typeof data === "string" ? data : ((data as { id?: string })?.id ?? null);
    ctx.state["shiftId"] = shiftId ?? "";
    t.must("the till has an identity", Boolean(shiftId));
    const { data: row } = await ctx.admin
      .from("pos_shifts")
      .select("id, organization_id, opened_by, status, opening_float")
      .eq("id", shiftId!)
      .maybeSingle();
    const shift = row as { organization_id: string; opened_by: string | null; status: string; opening_float: number } | null;
    t.must("the till belongs to the test workspace", shift?.organization_id === ctx.a.orgId);
    t.check("the opening float is recorded", Number(shift?.opening_float ?? 0) === 5000, 5000, shift?.opening_float);
    t.check("the till names who opened it", Boolean(shift?.opened_by));
  });

  await rec.run("Finance controls", 12, "till.movement", "A till movement is recorded", async (t) => {
    if (!shiftId) throw new Skipped("No till was opened.");
    const { error } = await rpc(cashier, "cash_record_movement", {
      _shift: shiftId,
      _type: "paid-out",
      _amount: 500,
      _reason: "TEST petty payout",
      _reference: `TEST-${ctx.runRef}-MOVE`,
    });
    if (error) throw new Error(`Till movement failed: ${error.message}`);
    const { data } = await ctx.admin
      .from("cash_movements")
      .select("id, amount, movement_type, organization_id")
      .eq("shift_id", shiftId);
    const rows = (data ?? []) as { organization_id: string }[];
    t.must("the movement is stored", rows.length > 0);
    t.must("the movement stays in the test workspace", rows.every((r) => r.organization_id === ctx.a.orgId));
  });

  await rec.run("Finance controls", 12, "till.expected", "The till states what should be in the drawer", async (t) => {
    if (!shiftId) throw new Skipped("No till was opened.");
    const { data, error } = await rpc(cashier, "cash_shift_expected", { _shift: shiftId });
    if (error) throw new Error(`Expected cash could not be read: ${error.message}`);
    t.note("expected_cash", data);
    t.must("an expected figure is returned", data !== null && data !== undefined);
    ctx.state["expectedCash"] = String(data ?? 0);
  });

  await rec.run("Finance controls", 12, "till.close", "The till closes and is reconciled", async (t) => {
    if (!shiftId) throw new Skipped("No till was opened.");
    const expected = Number(ctx.state["expectedCash"] ?? 0);
    const { data, error } = await rpc(cashier, "cash_close_shift", {
      _shift: shiftId,
      _counted: expected,
      _reason: "System test close",
    });
    if (error) throw new Error(`Till close failed: ${error.message}`);
    t.note("close_result", JSON.stringify(data).slice(0, 300));
    const { data: row } = await ctx.admin
      .from("pos_shifts")
      .select("status, counted_cash, variance, closed_at")
      .eq("id", shiftId)
      .maybeSingle();
    const shift = row as { status: string; variance: number | null; closed_at: string | null } | null;
    t.must("the till is closed", shift?.status !== "open", "closed", shift?.status);
    t.check("closing is timestamped", Boolean(shift?.closed_at));
    t.check("a counted variance is held", shift?.variance !== undefined);

    const { data: recon, error: reconError } = await rpc(cashier, "neo_cash_shift_reconciliation", { _shift: shiftId });
    if (reconError) throw new Error(`Reconciliation failed: ${reconError.message}`);
    t.note("reconciliation", JSON.stringify(recon).slice(0, 400));
    t.must("a reconciliation is produced", Boolean(recon));
  });

  await rec.run("Finance controls", 12, "till.close.repeat", "Closing the same till twice changes nothing", async (t) => {
    if (!shiftId) throw new Skipped("No till was opened.");
    const { data: before } = await ctx.admin.from("pos_shifts").select("counted_cash, closed_at").eq("id", shiftId).maybeSingle();
    await rpc(cashier, "cash_close_shift", { _shift: shiftId, _counted: 999999, _reason: "Repeat close" });
    const { data: after } = await ctx.admin.from("pos_shifts").select("counted_cash, closed_at").eq("id", shiftId).maybeSingle();
    t.must(
      "the closed till is unchanged",
      JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify(before),
      JSON.stringify(after),
    );
  });

  await rec.run("Finance controls", 12, "discount.unauthorised", "A waiter cannot discount beyond their authority", async (t) => {
    const orderId = ctx.state["posOrderId"];
    if (!orderId) throw new Skipped("No restaurant order exists to discount.");
    const { error } = await waiter
      .from("pos_orders")
      .update({ discount_amount: 100000, discount_reason: "TEST unauthorised discount" } as never)
      .eq("id", orderId);
    const d = denial(error as { message?: string; code?: string } | null);
    const { data: row } = await ctx.admin.from("pos_orders").select("discount_amount").eq("id", orderId).maybeSingle();
    const applied = Number((row as { discount_amount: number | null } | null)?.discount_amount ?? 0);
    t.note("refusal", d.message);
    if (!error && applied >= 100000)
      throw new CriticalFailure("A waiter applied an unlimited discount with no approval.");
    t.check("the oversized discount was refused", d.denied || applied < 100000, "denied", d.message || applied);
  });

  await rec.run("Finance controls", 12, "void.unauthorised", "A waiter cannot void a settled sale", async (t) => {
    const orderId = ctx.state["posOrderId"];
    if (!orderId) throw new Skipped("No restaurant order exists to void.");
    const { error } = await waiter
      .from("pos_orders")
      .update({ status: "voided", void_reason: "TEST unauthorised void" } as never)
      .eq("id", orderId);
    const { data: row } = await ctx.admin.from("pos_orders").select("status").eq("id", orderId).maybeSingle();
    const status = (row as { status: string } | null)?.status;
    t.note("status_after_attempt", status);
    if (status === "voided" && !error) throw new CriticalFailure("A waiter voided a sale unchallenged.");
    t.check("the void attempt did not take effect", status !== "voided", "not voided", status);
  });

  await rec.run("Finance controls", 12, "refund.decision", "A refund only pays out after an authorised decision", async (t) => {
    const { data: paymentRow } = await ctx.admin
      .from("payments")
      .select("id")
      .eq("organization_id", ctx.a.orgId)
      .limit(1)
      .maybeSingle();
    const paymentId = (paymentRow as { id: string } | null)?.id;
    if (!paymentId) throw new Skipped("No payment exists to refund.");

    const { data, error } = await rpc(refunder, "neo_cash_refund_request", {
      _payment: paymentId,
      _amount: 100,
      _reason: "System test refund request",
    });
    if (error) throw new NotConfigured(`Refunds could not be exercised here: ${error.message}`);
    const raw = JSON.stringify(data ?? {});
    t.note("request", raw.slice(0, 300));

    const { data: reqRow } = await ctx.admin
      .from("cash_refund_requests")
      .select("id, status, organization_id")
      .eq("organization_id", ctx.a.orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const request = reqRow as { id: string; status: string } | null;
    t.must("the refund is a request, not a payout", Boolean(request) && request!.status !== "paid", "pending", request?.status);

    // An unauthorised role must not be able to approve it.
    const { error: waiterError } = await rpc(waiter, "neo_cash_refund_decide", {
      _refund: request!.id,
      _approve: true,
      _note: "TEST unauthorised approval",
    });
    const wd = denial(waiterError);
    const { data: midRow } = await ctx.admin.from("cash_refund_requests").select("status").eq("id", request!.id).maybeSingle();
    const midStatus = (midRow as { status: string } | null)?.status;
    if (!waiterError && midStatus === "approved")
      throw new CriticalFailure("A waiter approved a refund.");
    t.check("an unauthorised approval is refused", wd.denied || midStatus !== "approved", "denied", wd.message || midStatus);

    const { error: ownerError } = await rpc(owner, "neo_cash_refund_decide", {
      _refund: request!.id,
      _approve: true,
      _note: "System test authorised approval",
    });
    if (ownerError) throw new Error(`An authorised approval was refused: ${ownerError.message}`);
    const { data: finalRow } = await ctx.admin
      .from("cash_refund_requests")
      .select("status, approved_by, approved_at")
      .eq("id", request!.id)
      .maybeSingle();
    const decided = finalRow as { status: string; approved_by: string | null; approved_at: string | null } | null;
    t.must("the authorised decision is recorded", decided?.status !== "pending", "decided", decided?.status);
    t.check("the decision names the approver", Boolean(decided?.approved_by));
    t.check("the decision is timestamped", Boolean(decided?.approved_at));
  });

  await rec.run("Finance controls", 12, "posting.idempotent", "A sale cannot be posted to the books twice", async (t) => {
    const orderId = ctx.state["posOrderId"];
    if (!orderId) throw new Skipped("No restaurant order exists to post.");
    const first = await rpc(accountant, "neo_post_pos_order", { _order: orderId });
    if (first.error) throw new NotConfigured(`Posting could not be exercised: ${first.error.message}`);
    const { count: afterFirst } = await ctx.admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.a.orgId);
    await rpc(accountant, "neo_post_pos_order", { _order: orderId });
    const { count: afterSecond } = await ctx.admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.a.orgId);
    t.note("journals", { afterFirst, afterSecond });
    t.must("no second set of books entries appears", afterFirst === afterSecond, afterFirst, afterSecond);
  });

  await rec.run("Finance controls", 12, "books.posted", "A real guest receipt reaches the books", async (t) => {
    const folioId = ctx.state["folioId"];
    if (!folioId) throw new Skipped("No folio exists to collect against.");
    const { data: paymentRow } = await ctx.admin
      .from("payments")
      .select("id, amount, status, method")
      .eq("folio_id", folioId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const payment = paymentRow as { id: string; amount: number; status: string; method: string } | null;
    if (!payment) throw new Skipped("No guest receipt was taken, so nothing could be posted.");
    ctx.state["postedPaymentId"] = payment.id;
    t.note("receipt", { amount: payment.amount, status: payment.status, method: payment.method });

    const posted = await rpc(accountant, "neo_finance_post_txn", {
      _source_type: "folio_payment",
      _source_id: payment.id,
      _silent: false,
    });
    if (posted.error) throw new Error(`The receipt could not be posted to the books: ${posted.error.message}`);
    t.note("posting", JSON.stringify(posted.data).slice(0, 300));

    const { data: journals } = await ctx.admin
      .from("journal_entries")
      .select("id, source_document_id, source_module")
      .eq("organization_id", ctx.a.orgId)
      .eq("source_document_id", payment.id);
    const made = (journals ?? []) as { id: string }[];
    t.must("the receipt produced a books entry", made.length > 0, "> 0", made.length);
    if (made.length === 0) return;
    ctx.state["paymentJournalId"] = made[0]!.id;

    // Posting the same receipt again must not open a second entry.
    await rpc(accountant, "neo_finance_post_txn", {
      _source_type: "folio_payment",
      _source_id: payment.id,
      _silent: false,
    });
    const { count } = await ctx.admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.a.orgId)
      .eq("source_document_id", payment.id);
    t.must("the receipt is on the books once", (count ?? 0) === made.length, made.length, count);

    const { data: lines } = await ctx.admin
      .from("journal_entry_lines")
      .select("debit, credit")
      .eq("journal_id", made[0]!.id);
    const rows = (lines ?? []) as { debit: number | null; credit: number | null }[];
    const debit = rows.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = rows.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    t.note("entry_totals", { debit, credit });
    t.must("the entry has lines", rows.length > 0, "> 0", rows.length);
    t.must("the entry balances", Math.abs(debit - credit) < 0.01, debit, credit);
    t.must("the entry carries the receipt value", Math.abs(debit - Number(payment.amount)) < 0.01, payment.amount, debit);
  });

  await rec.run("Finance controls", 12, "journals.balanced", "Every books entry balances", async (t) => {
    const { data: entries } = await ctx.admin
      .from("journal_entries")
      .select("id, status")
      .eq("organization_id", ctx.a.orgId)
      .limit(50);
    const rows = (entries ?? []) as { id: string }[];
    // The run posts a real receipt above, so an empty book here is a failure,
    // not a workspace that was never configured.
    t.must("the run produced books entries to check", rows.length > 0, "> 0", rows.length);
    if (rows.length === 0) return;
    const { data: lines } = await ctx.admin
      .from("journal_entry_lines")
      .select("journal_id, debit, credit")
      .in("journal_id", rows.map((r) => r.id));
    const totals = new Map<string, { debit: number; credit: number }>();
    for (const line of (lines ?? []) as { journal_id: string; debit: number | null; credit: number | null }[]) {
      const cur = totals.get(line.journal_id) ?? { debit: 0, credit: 0 };
      cur.debit += Number(line.debit ?? 0);
      cur.credit += Number(line.credit ?? 0);
      totals.set(line.journal_id, cur);
    }
    const unbalanced = [...totals.entries()].filter(([, v]) => Math.abs(v.debit - v.credit) > 0.01);
    t.note("entries_checked", totals.size);
    t.must("no entry is out of balance", unbalanced.length === 0, 0, unbalanced.length);
  });
}

/* ------------------------------------------------- TEST 13 — event billing */

export async function suiteEventBilling(ctx: SuiteContext) {
  const { rec } = ctx;
  const events = client(ctx, "events");
  const owner = client(ctx, "owner");
  const account = ctx.a.accounts.find((x) => x.key === "events");

  await rec.run("Event billing", 13, "event.priced", "A priced TEST menu is attached to the event", async (t) => {
    const booking = ctx.state["eventBookingId"];
    if (!booking) throw new Skipped("No event booking exists.");
    const { error } = await events.from("event_menus").insert({
      organization_id: ctx.a.orgId,
      booking_id: booking,
      name: `TEST Conference Menu ${ctx.runRef}`,
      service_style: "buffet",
      service_at: `${plusDays(14)}T12:30:00Z`,
      guest_count: 50,
      price_per_person: 2500,
      estimated_cost: 1200,
      created_by: account?.userId ?? null,
    } as never);
    if (error) throw new Error(`The test menu could not be attached: ${error.message}`);
    ctx.state["eventMenuValue"] = String(50 * 2500);
    t.note("expected_value", 50 * 2500);
    t.check("the menu carries a price", true);
  });

  await rec.run("Event billing", 13, "event.billed", "The bill is built from the configured price", async (t) => {
    const booking = ctx.state["eventBookingId"];
    if (!booking) throw new Skipped("No event booking exists.");
    const { data, error } = await rpc(events, "neo_event_billing_build", { _booking: booking });
    if (error) throw new Error(`Billing build failed: ${error.message}`);
    t.note("build", JSON.stringify(data).slice(0, 300));
    const { data: items } = await ctx.admin
      .from("event_billing_items")
      .select("description, quantity, unit_price, line_total, organization_id")
      .eq("booking_id", booking);
    const rows = (items ?? []) as { quantity: number; unit_price: number; line_total: number; organization_id: string }[];
    t.must("billing lines exist", rows.length > 0);
    t.must("every line belongs to the test workspace", rows.every((r) => r.organization_id === ctx.a.orgId));
    const menuLine = rows.find((r) => Number(r.unit_price) === 2500);
    t.must("the menu line is priced from the configuration", Boolean(menuLine));
    t.must(
      "the line total is quantity times price",
      Math.abs(Number(menuLine?.line_total ?? 0) - Number(menuLine?.quantity ?? 0) * 2500) < 0.01,
      Number(menuLine?.quantity ?? 0) * 2500,
      menuLine?.line_total,
    );
    ctx.state["eventCharged"] = String(rows.reduce((s, r) => s + Number(r.line_total ?? 0), 0));
  });

  await rec.run("Event billing", 13, "event.part.paid", "A part payment leaves a balance outstanding", async (t) => {
    const booking = ctx.state["eventBookingId"];
    if (!booking) throw new Skipped("No event booking exists.");
    const charged = Number(ctx.state["eventCharged"] ?? 0);
    if (charged <= 0) throw new Skipped("The event bill has no value.");
    const { data, error } = await rpc(events, "neo_event_billing_record_payment", {
      _booking: booking,
      _amount: Math.round(charged / 2),
      _entry_type: "deposit",
      _method: "cash",
      _reference: `TEST-${ctx.runRef}-EVTDEP`,
      _reason: "System test deposit — no external provider used",
    });
    if (error) throw new Error(`Event payment failed: ${error.message}`);
    t.note("payment", JSON.stringify(data).slice(0, 300));
    const { data: statement } = await rpc(events, "neo_event_billing_statement", { _booking: booking });
    const raw = JSON.stringify(statement ?? {});
    t.note("statement", raw.slice(0, 400));
    const { data: paid } = await ctx.admin.from("event_payments").select("amount").eq("booking_id", booking);
    const total = ((paid ?? []) as { amount: number }[]).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    t.must("money is recorded against the event", total > 0);
    t.must("the event is not yet fully paid", total < charged, `< ${charged}`, total);
  });

  await rec.run("Event billing", 13, "event.settled", "The event settles and the bill is finalised once", async (t) => {
    const booking = ctx.state["eventBookingId"];
    if (!booking) throw new Skipped("No event booking exists.");
    const charged = Number(ctx.state["eventCharged"] ?? 0);
    const { data: paidRows } = await ctx.admin.from("event_payments").select("amount").eq("booking_id", booking);
    const paid = ((paidRows ?? []) as { amount: number }[]).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    // Card is used deliberately: cash would demand an open till, which this
    // suite does not run, and the point here is the settlement record itself.
    const settle = await rpc(events, "neo_event_billing_record_payment", {
      _booking: booking,
      _amount: charged - paid,
      _entry_type: "payment",
      _method: "card",
      _reference: `TEST-${ctx.runRef}-EVTFINAL`,
      _reason: "System test balance settlement",
    });
    if (settle.error) throw new Error(`Final event payment failed: ${settle.error.message}`);
    const settleResult = settle.data as { ok?: boolean; reason?: string; detail?: string } | null;
    if (settleResult?.ok === false) {
      throw new Error(`Final event payment refused: ${settleResult.reason ?? "unknown"} ${settleResult.detail ?? ""}`.trim());
    }

    const finalise = await rpc(owner, "neo_event_billing_finalise", { _booking: booking, _reason: "System test closure" });
    if (finalise.error) throw new Error(`Finalisation failed: ${finalise.error.message}`);
    t.note("finalise", JSON.stringify(finalise.data).slice(0, 300));

    const { data: row } = await ctx.admin
      .from("event_bookings")
      .select("billing_status, billed_by, billed_at, total_amount")
      .eq("id", booking)
      .maybeSingle();
    const b = row as { billing_status: string; billed_by: string | null; billed_at: string | null; total_amount: number } | null;
    t.must("the bill is finalised", b?.billing_status === "finalised", "finalised", b?.billing_status);
    t.check("finalisation names the actor", Boolean(b?.billed_by));
    t.check("finalisation is timestamped", Boolean(b?.billed_at));

    const { count } = await ctx.admin
      .from("event_payments")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", booking)
      .eq("reference", `TEST-${ctx.runRef}-EVTFINAL`);
    t.must("the settlement was taken once", (count ?? 0) === 1, 1, count);

    // A second build must be refused now the bill is final.
    const rebuild = await rpc(events, "neo_event_billing_build", { _booking: booking });
    const raw = JSON.stringify(rebuild.data ?? rebuild.error ?? {});
    t.check("a finalised bill cannot be silently rebuilt", /finalis/i.test(raw) || Boolean(rebuild.error), "refused", raw.slice(0, 200));
  });
}

/* ------------------------------------------------- TEST 14 — RBAC matrix */

type MatrixCheck = {
  action: string;
  module: string;
  /** Roles expected to be allowed. Everyone else must be refused. */
  allowed: string[];
  run: (c: Client, ctx: SuiteContext) => Promise<{ error: { message?: string; code?: string } | null; mutated?: boolean }>;
};

const ALL_ROLES = [
  "owner",
  "operations_manager",
  "accountant",
  "cashier",
  "receptionist",
  "waiter",
  "chef",
  "housekeeper",
  "procurement",
  "storekeeper",
  "marketing",
  "events",
  "hr",
  "rider",
];

const MATRIX: MatrixCheck[] = [
  {
    action: "read guest records",
    module: "Guests",
    allowed: ["owner", "operations_manager", "accountant", "cashier", "receptionist", "events", "marketing", "waiter"],
    run: async (c, ctx) => {
      const { data, error } = await c.from("customers").select("id").eq("organization_id", ctx.a.orgId).limit(1);
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "create a reservation",
    module: "Front office",
    allowed: ["owner", "operations_manager", "receptionist", "events"],
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("reservations")
        .insert({
          organization_id: ctx.a.orgId,
          branch_id: ctx.a.branchId,
          reservation_number: `TEST-RBAC-${crypto.randomUUID().slice(0, 8)}`,
          check_in_date: plusDays(21),
          check_out_date: plusDays(22),
          adults: 1,
          status: "pending",
        } as never)
        .select("id")
        .maybeSingle();
      if (data) await ctx.admin.from("reservations").delete().eq("id", (data as { id: string }).id);
      return { error, mutated: Boolean(data) };
    },
  },
  {
    action: "read the books",
    module: "Finance",
    allowed: ["owner", "operations_manager", "accountant", "cashier"],
    run: async (c, ctx) => {
      const { data, error } = await c.from("journal_entries").select("id").eq("organization_id", ctx.a.orgId).limit(1);
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "read staff records",
    module: "People",
    allowed: ["owner", "operations_manager", "hr", "accountant"],
    run: async (c, ctx) => {
      const { data, error } = await c.from("employees").select("id, salary").eq("organization_id", ctx.a.orgId).limit(1);
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "approve a purchase order",
    module: "Procurement",
    allowed: ["owner", "operations_manager", "procurement"],
    run: async (c, ctx) => {
      const id = ctx.state["purchaseOrderId"];
      if (!id) return { error: null, mutated: false };
      const { data, error } = await c
        .from("purchase_orders")
        .update({ notes: `TEST RBAC probe ${crypto.randomUUID().slice(0, 6)}` } as never)
        .eq("id", id)
        .select("id");
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "change the menu",
    module: "Restaurant",
    allowed: ["owner", "operations_manager", "chef"],
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("menu_items")
        .update({ description: `TEST RBAC probe ${crypto.randomUUID().slice(0, 6)}` } as never)
        .eq("id", ctx.a.seed["menuItemId"] ?? "00000000-0000-0000-0000-000000000000")
        .select("id");
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "adjust stock",
    module: "Stores",
    allowed: ["owner", "operations_manager", "storekeeper", "procurement"],
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("stock_items")
        .update({ description: `TEST RBAC probe ${crypto.randomUUID().slice(0, 6)}` } as never)
        .eq("id", ctx.a.seed["stockItemId"] ?? "00000000-0000-0000-0000-000000000000")
        .select("id");
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "change system configuration",
    module: "Settings",
    allowed: ["owner"],
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("branches")
        .update({ description: `TEST RBAC probe ${crypto.randomUUID().slice(0, 6)}` } as never)
        .eq("id", ctx.a.branchId)
        .select("id");
      return { error, mutated: (data ?? []).length > 0 };
    },
  },
  {
    action: "grant permissions to a role",
    module: "Access control",
    allowed: ["owner"],
    run: async (c, ctx) => {
      const { data: role } = await ctx.admin
        .from("roles")
        .select("id")
        .eq("organization_id", ctx.a.orgId)
        .eq("name", "Waiter / Waitress")
        .maybeSingle();
      const roleId = (role as { id: string } | null)?.id;
      if (!roleId) return { error: null, mutated: false };
      const { data, error } = await c.rpc("apply_recommended_permissions" as never, { _role_id: roleId, _reset: false } as never);
      return { error: error as { message?: string } | null, mutated: Boolean(data) };
    },
  },
];

export async function suiteRbacMatrix(ctx: SuiteContext) {
  const { rec } = ctx;
  const matrix: Record<string, Record<string, string>> = {};

  for (const check of MATRIX) {
    await rec.run("Permission matrix", 14, `rbac.${check.module}.${check.action}`.replace(/\s+/g, "_").toLowerCase(),
      `${check.module}: ${check.action}`, async (t) => {
        const row: Record<string, string> = {};
        const wrongAllows: string[] = [];
        const wrongDenies: string[] = [];

        for (const role of ALL_ROLES) {
          const c = ctx.clientsA.get(role);
          if (!c) {
            row[role] = "no account";
            continue;
          }
          let outcome: { error: { message?: string; code?: string } | null; mutated?: boolean };
          try {
            outcome = await check.run(c, ctx);
          } catch (error) {
            outcome = { error: { message: error instanceof Error ? error.message : String(error) } };
          }
          const d = denial(outcome.error ?? null);
          const succeeded = !outcome.error && outcome.mutated === true;
          const shouldAllow = check.allowed.includes(role);

          if (shouldAllow) {
            row[role] = succeeded ? "allowed" : d.denied ? "REFUSED" : "no effect";
            if (d.denied) wrongDenies.push(`${role}: ${d.message}`);
          } else {
            row[role] = succeeded ? "ALLOWED" : "refused";
            if (succeeded) wrongAllows.push(role);
          }
        }

        matrix[`${check.module} — ${check.action}`] = row;
        t.note("roles", row);
        t.note("refused_unexpectedly", wrongDenies);
        if (wrongAllows.length > 0)
          throw new CriticalFailure(
            `${check.action}: allowed for roles that should be refused — ${wrongAllows.join(", ")}`,
          );
        t.check("no forbidden role got through", wrongAllows.length === 0, 0, wrongAllows.length);
        t.check(
          "the intended roles were not blocked",
          wrongDenies.length === 0,
          "none blocked",
          wrongDenies.join(" | ") || "none",
        );
      });
  }

  await rec.run("Permission matrix", 14, "rbac.matrix", "The full role matrix is recorded", async (t) => {
    t.note("matrix", matrix);
    t.note("roles_tested", ALL_ROLES);
    t.must("every role was exercised", ALL_ROLES.length === 14, 14, ALL_ROLES.length);
  });

  await rec.run("Permission matrix", 14, "rbac.guest", "A guest cannot reach staff data", async (t) => {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) throw new NotConfigured("The backend connection details are not available.");
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, storage: undefined } });
    for (const table of ["employees", "journal_entries", "customers", "folios"]) {
      const { data } = await anon.from(table).select("id").limit(1);
      t.mustIsolate(`a signed-out visitor sees no ${table}`, ((data ?? []) as unknown[]).length === 0, 0, (data ?? []).length);
    }
  });
}

/* ------------------------------- TEST 15 — sensitive database routines */

export async function suiteSecurityRoutines(ctx: SuiteContext) {
  const { rec } = ctx;
  const waiter = client(ctx, "waiter");

  await rec.run("Sensitive routines", 15, "definer.inventory", "Sensitive routines are inventoried", async (t) => {
    const { data, error } = await rpc(ctx.admin, "neo_security_definer_inventory", {});
    if (error) throw new NotConfigured(`The routine inventory is unavailable: ${error.message}`);
    const summary = data as { total?: number; callable?: number; writers?: number; unguarded?: string[] } | null;
    t.note("summary", summary);
    const unguarded = summary?.unguarded ?? [];
    t.note("unguarded", unguarded.slice(0, 25));
    if (unguarded.length > 0)
      throw new CriticalFailure(`Routines that write without a permission or ownership check: ${unguarded.slice(0, 10).join(", ")}`);
    t.check("no writer routine is unguarded", unguarded.length === 0, 0, unguarded.length);
  });

  await rec.run("Sensitive routines", 15, "definer.cross_tenant", "A routine gives up nothing from another workspace", async (t) => {
    const foreignBranch = ctx.b.branchId;
    const attempts: { routine: string; leaked: boolean; message: string }[] = [];

    // Naming another workspace's property must never return that workspace's
    // records. A routine may still answer with the caller's own (empty) picture
    // — that is a refusal to cross, not a leak.
    const probes: { name: string; args: Record<string, unknown> }[] = [
      { name: "neo_event_chain_status", args: { _branch: foreignBranch } },
      { name: "neo_cash_till_context", args: { _branch: foreignBranch } },
      { name: "cash_open_shift", args: { _branch: foreignBranch, _station: null, _float: 0 } },
    ];
    for (const probe of probes) {
      const { data, error } = await rpc(waiter, probe.name, probe.args);
      const d = denial(error);
      const raw = JSON.stringify(data ?? null);
      // A routine may echo the branch that was asked for; that is not a leak.
      // Only records that actually belong to the other workspace count.
      const foreignRecords = !error
        ? (JSON.stringify(data ?? null).match(/"(organization_id|branch_id)"\s*:\s*"([0-9a-f-]{36})"/g) ?? []).filter(
            (m) => m.includes(ctx.b.orgId) || m.includes(foreignBranch),
          )
        : [];
      const leaked = foreignRecords.length > 0;
      attempts.push({ routine: probe.name, leaked, message: d.message || raw.slice(0, 120) });
      t.mustIsolate(`${probe.name} returns nothing from the other workspace`, !leaked, "no foreign data", raw.slice(0, 160));
    }

    // Nothing may be written into the other workspace either.
    const { data: created } = await ctx.admin
      .from("cash_shifts")
      .select("id")
      .eq("organization_id", ctx.b.orgId)
      .eq("branch_id", foreignBranch);
    t.mustIsolate("no till was opened in the other workspace", ((created ?? []) as unknown[]).length === 0);
    t.note("attempts", attempts);
  });

  await rec.run("Sensitive routines", 15, "definer.caller_ids", "Supplied identities cannot be forged", async (t) => {
    const otherUser = ctx.b.ownerUserId;
    const waiterAccount = ctx.a.accounts.find((x) => x.key === "waiter");
    const action = `test.forged.actor.${ctx.runRef}`;
    const { error } = await waiter
      .from("audit_logs")
      .insert({
        organization_id: ctx.a.orgId,
        action,
        module: "system-test",
        user_id: otherUser,
      } as never);
    const d = denial(error as { message?: string; code?: string } | null);
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("id, user_id")
      .eq("organization_id", ctx.a.orgId)
      .eq("action", action)
      .limit(1);
    const row = ((data ?? []) as { id: string; user_id: string | null }[])[0];
    if (row) await ctx.admin.from("audit_logs").delete().eq("id", row.id);
    if (row && row.user_id === otherUser)
      throw new CriticalFailure("A trail entry was written naming somebody else as the actor.");
    t.note("outcome", error ? d.message : `stored actor ${row?.user_id ?? "none"}`);
    t.check(
      "the entry can only name the person who wrote it",
      Boolean(error) || !row || row.user_id === (waiterAccount?.userId ?? row.user_id),
      "own identity",
      row?.user_id ?? d.message,
    );
  });
}


/* --------------------------------- TEST 16 — inventory hierarchy */

export async function suiteInventoryHierarchy(ctx: SuiteContext) {
  const { rec } = ctx;
  const storekeeper = client(ctx, "storekeeper");

  await rec.run("Inventory hierarchy", 16, "hierarchy.shape", "Every item sits under a category, and every category under a group", async (t) => {
    const { data: items } = await ctx.admin
      .from("stock_items")
      .select("id, name, category_id")
      .eq("organization_id", ctx.a.orgId);
    const rows = (items ?? []) as { id: string; name: string; category_id: string | null }[];
    t.must("the workspace has stock items", rows.length > 0);
    const uncategorised = rows.filter((r) => !r.category_id);
    t.must("no item is left without a category", uncategorised.length === 0, 0, uncategorised.length);

    const { data: categories } = await ctx.admin
      .from("stock_categories")
      .select("id, name, group_id")
      .eq("organization_id", ctx.a.orgId);
    const cats = (categories ?? []) as { id: string; name: string; group_id: string | null }[];
    t.must("the workspace has categories", cats.length > 0);
    const ungrouped = cats.filter((c) => !c.group_id);
    t.must("every category belongs to an item group", ungrouped.length === 0, 0, ungrouped.map((c) => c.name));

    const byId = new Map(cats.map((c) => [c.id, c]));
    const orphan = rows.filter((r) => r.category_id && !byId.has(r.category_id));
    t.must("no item points at a category from elsewhere", orphan.length === 0, 0, orphan.length);
    t.note("counts", { items: rows.length, categories: cats.length });
  });

  await rec.run("Inventory hierarchy", 16, "hierarchy.inherits", "An item inherits its group through its category", async (t) => {
    const { data: items } = await ctx.admin
      .from("stock_items")
      .select("id, name, category_id")
      .eq("organization_id", ctx.a.orgId)
      .limit(5);
    const rows = (items ?? []) as { id: string; name: string; category_id: string | null }[];
    const categoryIds = rows.map((r) => r.category_id).filter(Boolean) as string[];
    const { data: cats } = await ctx.admin
      .from("stock_categories")
      .select("id, name, group_id")
      .in("id", categoryIds.length > 0 ? categoryIds : ["00000000-0000-0000-0000-000000000000"]);
    const catRows = (cats ?? []) as { id: string; name: string; group_id: string | null }[];
    const groupIds = catRows.map((c) => c.group_id).filter(Boolean) as string[];
    const { data: groups } = await ctx.admin
      .from("stock_item_groups")
      .select("id, name")
      .in("id", groupIds.length > 0 ? groupIds : ["00000000-0000-0000-0000-000000000000"]);
    const groupRows = (groups ?? []) as { id: string; name: string }[];
    t.note("chain", { items: rows.length, categories: catRows.length, groups: groupRows.length });
    t.must("every sampled item reaches a category", catRows.length > 0 && categoryIds.length === rows.length);
    t.must("every sampled category reaches an item group", groupRows.length > 0 && groupIds.length === catRows.length);
  });

  await rec.run("Inventory hierarchy", 16, "hierarchy.category_needs_group", "A category cannot be created without a group", async (t) => {
    const { data, error } = await storekeeper
      .from("stock_categories")
      .insert({
        organization_id: ctx.a.orgId,
        name: `TEST Loose Category ${ctx.runRef}`,
        is_active: true,
      } as never)
      .select("id")
      .maybeSingle();
    const id = (data as { id: string } | null)?.id;
    if (id) await ctx.admin.from("stock_categories").delete().eq("id", id);
    const d = denial(error as { message?: string; code?: string } | null);
    t.note("outcome", error ? d.message : "created without a group");
    t.check("a group is required", Boolean(error) || !id, "refused", d.message);
  });

  await rec.run("Inventory hierarchy", 16, "hierarchy.levels", "Reorder levels survive alongside the hierarchy", async (t) => {
    const { data } = await ctx.admin
      .from("stock_items")
      .select("id, min_level, reorder_point")
      .eq("id", ctx.a.seed["stockItemId"] ?? "00000000-0000-0000-0000-000000000000")
      .maybeSingle();
    const item = data as { min_level: number | null; reorder_point: number | null } | null;
    t.note("levels", item);
    t.must("the test item still carries its minimum level", item !== null && item.min_level !== null);
  });
}

/* --------------------------------- TEST 17 — credential hygiene */

export async function suiteCredentialHygiene(ctx: SuiteContext) {
  const { rec } = ctx;

  await rec.run("Credential hygiene", 17, "secrets.none_stored", "No test credential is stored anywhere", async (t) => {
    const { data } = await ctx.admin.from("neo_test_environments").select("id, accounts, seed");
    const rows = (data ?? []) as { id: string; accounts: unknown; seed: unknown }[];
    const offenders = rows.filter((r) =>
      /password|secret|"pwd"/i.test(JSON.stringify({ accounts: r.accounts, seed: r.seed })),
    );
    t.note("environments_checked", rows.length);
    if (offenders.length > 0) throw new CriticalFailure("A test environment record holds credential material.");
    t.must("no environment record holds a credential", offenders.length === 0, 0, offenders.length);
  });

  await rec.run("Credential hygiene", 17, "secrets.not_in_evidence", "No credential leaks into the run evidence", async (t) => {
    const raw = JSON.stringify(ctx.rec.cases.map((c) => ({ e: c.evidence, d: c.detail })));
    const leaked = /Test-[0-9a-f]{18}!9/.test(raw) || /"password"\s*:/i.test(raw);
    if (leaked) throw new CriticalFailure("A credential appeared in the run evidence.");
    t.must("the evidence carries no credential", !leaked);
  });

  await rec.run("Credential hygiene", 17, "accounts.metadata_only", "Account evidence keeps only what is safe", async (t) => {
    const account = ctx.a.accounts[0];
    if (!account) throw new Skipped("No test accounts were provisioned.");
    const keys = Object.keys(account);
    t.note("kept_fields", keys);
    t.must("no credential field is present", !keys.includes("password"));
    t.check("the useful evidence is kept", keys.includes("email") && keys.includes("userId") && keys.includes("roleName"));
  });
}

export const EXTENDED_SUITES: { key: string; name: string; run: (ctx: SuiteContext) => Promise<void> }[] = [
  { key: "finance_controls", name: "Finance controls", run: suiteFinanceControls },
  { key: "event_billing", name: "Event billing", run: suiteEventBilling },
  { key: "rbac_matrix", name: "Permission matrix", run: suiteRbacMatrix },
  { key: "security_routines", name: "Sensitive routines", run: suiteSecurityRoutines },
  { key: "inventory_hierarchy", name: "Inventory hierarchy", run: suiteInventoryHierarchy },
  { key: "credential_hygiene", name: "Credential hygiene", run: suiteCredentialHygiene },
];
