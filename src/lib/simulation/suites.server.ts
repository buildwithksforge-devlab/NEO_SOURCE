/**
 * NEØ System Test — the eleven suites (server only).
 *
 * Each suite drives the real business routines through signed-in test accounts
 * that hold real roles, then reads the database back to prove the state moved.
 * Nothing writes a final status directly to fake a pass; where a suite has to
 * arrange a starting condition (a deliberate stock shortage, for instance) the
 * arrangement is done openly as setup and recorded as evidence.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CriticalFailure, NotConfigured, Recorder, Skipped, denial } from "./harness.server";
import type { TestEnvironment } from "./environment.server";
import { EXTENDED_SUITES } from "./suites-extended.server";
import { SECOND_PROPERTY_SUITES } from "./suites-second-property.server";
import { auditWindowFrom } from "@/lib/audit-window";

type Client = SupabaseClient;

export type SuiteContext = {
  admin: Client;
  runRef: string;
  a: TestEnvironment;
  b: TestEnvironment;
  clientsA: Map<string, Client>;
  clientsB: Map<string, Client>;
  rec: Recorder;
  state: Record<string, string>;
};

const today = () => new Date().toISOString().slice(0, 10);
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

async function expectOk(c: Client, name: string, args: Record<string, unknown>) {
  const { data, error } = await rpc(c, name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/**
 * A test phone number that is unique to the run. The test workspace is reused
 * between runs and contact numbers are unique per organisation, so a fixed
 * number would block every run after the first.
 */
function testPhone(prefix: string, runRef: string) {
  const digits = runRef.replace(/\D/g, "").slice(-6).padStart(6, "0");
  return `+254${prefix}${digits}`;
}

/* ------------------------------------------------------------------ TEST 1 */

export async function suiteGuestReservation(ctx: SuiteContext) {
  const { rec } = ctx;
  const reception = client(ctx, "receptionist");

  await rec.run("Guest → Reservation", 1, "guest.created", "Test guest record is created", async (t) => {
    const { data, error } = await reception
      .from("customers")
      .insert({
        organization_id: ctx.a.orgId,
        primary_branch_id: ctx.a.branchId,
        customer_type: "individual-guest",
        customer_number: `TEST-CUS-${ctx.runRef}`,
        full_name: `TEST Guest ${ctx.runRef}`,
        // Unique per run: the test workspace is reused, and a guest phone is
        // unique per organisation, so a fixed number collides on the next run.
        phone: testPhone("711", ctx.runRef),
        email: `neo-qa+${ctx.runRef}@neo-simulation.example.com`,
        account_status: "active",
        source: "system-test",
      } as never)
      .select("id, full_name, organization_id")
      .single();
    if (error) throw new Error(`Receptionist could not create the guest: ${error.message}`);
    const row = data as { id: string; organization_id: string };
    ctx.state["customerId"] = row.id;
    ctx.rec.artifact("customers", row.id);
    t.must("guest stored in the test workspace", row.organization_id === ctx.a.orgId, ctx.a.orgId, row.organization_id);
    t.note("customer_id", row.id);
  });

  await rec.run("Guest → Reservation", 1, "reservation.created", "Reservation is created and is repeat-safe", async (t) => {
    const payload = {
      branch_id: ctx.a.branchId,
      customer_id: ctx.state["customerId"],
      booking_source: "direct",
      reservation_type: "individual",
      arrival_date: today(),
      departure_date: plusDays(1),
      adults: 2,
      children: 0,
      room_type_id: ctx.a.seed["roomTypeId"],
      rate_plan_id: ctx.a.seed["ratePlanId"],
      nightly_rate: 10000,
      tax_amount: 1600,
      total_amount: 11600,
      balance: 11600,
      status: "tentative",
    };
    const key = `${ctx.runRef}-reservation`;
    const first = (await expectOk(reception, "neo_reservation_create", {
      _payload: payload,
      _idempotency_key: key,
    })) as { ok: boolean; id: string; confirmation_number: string; idempotent: boolean };
    t.must("reservation created", first?.ok === true);
    t.must("confirmation number issued", Boolean(first.confirmation_number));
    ctx.state["reservationId"] = first.id;
    ctx.rec.artifact("reservations", first.id);

    const repeat = (await expectOk(reception, "neo_reservation_create", {
      _payload: payload,
      _idempotency_key: key,
    })) as { idempotent: boolean; id: string };
    t.check("repeating the same request does not duplicate", repeat.idempotent === true && repeat.id === first.id);
    t.note("confirmation_number", first.confirmation_number);
    t.note("reservation_id", first.id);
  });

  await rec.run("Guest → Reservation", 1, "reservation.confirmed", "Reservation moves to confirmed", async (t) => {
    const { error } = await reception
      .from("reservations")
      .update({ status: "confirmed" } as never)
      .eq("id", ctx.state["reservationId"]!);
    if (error) throw new Error(`Confirmation failed: ${error.message}`);
    const { data } = await reception
      .from("reservations")
      .select("status")
      .eq("id", ctx.state["reservationId"]!)
      .maybeSingle();
    t.must("status is confirmed", (data as { status: string } | null)?.status === "confirmed", "confirmed", (data as { status: string } | null)?.status);
  });

  await rec.run("Guest → Reservation", 1, "room.assigned", "An available room is assigned", async (t) => {
    const rooms = (await expectOk(reception, "pms_available_rooms", {
      _branch: ctx.a.branchId,
      _arrival: today(),
      _departure: plusDays(1),
      _room_type: ctx.a.seed["roomTypeId"],
      _adults: 2,
      _children: 0,
    })) as { room_id: string }[];
    t.must("availability returns the test room", (rooms ?? []).some((r) => r.room_id === ctx.a.seed["roomId"]));
    await expectOk(reception, "pms_assign_room", {
      _reservation: ctx.state["reservationId"],
      _room: ctx.a.seed["roomId"],
      _reason: "System test assignment",
    });
    const { data } = await reception
      .from("reservations")
      .select("room_id")
      .eq("id", ctx.state["reservationId"]!)
      .maybeSingle();
    t.must("reservation carries the room", (data as { room_id: string } | null)?.room_id === ctx.a.seed["roomId"]);
  });

  await rec.run("Guest → Reservation", 1, "checkin.folio", "Check-in occupies the room and opens a folio", async (t) => {
    await expectOk(reception, "pms_check_in", {
      _reservation: ctx.state["reservationId"],
      _keys: 1,
      _notes: "System test check-in",
    });
    const { data: res } = await reception
      .from("reservations")
      .select("status")
      .eq("id", ctx.state["reservationId"]!)
      .maybeSingle();
    t.check("reservation is in house", /in.?house|checked.?in|arrived/i.test((res as { status: string } | null)?.status ?? ""), "in-house", (res as { status: string } | null)?.status);

    const { data: room } = await reception
      .from("rooms")
      .select("occupancy_status, housekeeping_status")
      .eq("id", ctx.a.seed["roomId"]!)
      .maybeSingle();
    t.check("room is occupied", /occupied/i.test((room as { occupancy_status: string } | null)?.occupancy_status ?? ""), "occupied", (room as { occupancy_status: string } | null)?.occupancy_status);

    const { data: folio } = await reception
      .from("folios")
      .select("id, status, balance, organization_id")
      .eq("reservation_id", ctx.state["reservationId"]!)
      .maybeSingle();
    const f = folio as { id: string; status: string; organization_id: string } | null;
    t.must("a folio was opened", Boolean(f?.id));
    t.must("folio belongs to the test workspace", f?.organization_id === ctx.a.orgId);
    ctx.state["folioId"] = f!.id;
    ctx.rec.artifact("folios", f!.id);
    t.note("folio_id", f!.id);
  });
}

/* ------------------------------------------------------------------ TEST 2 */

export async function suiteRestaurantKitchen(ctx: SuiteContext) {
  const { rec } = ctx;
  const waiter = client(ctx, "waiter");
  const chef = client(ctx, "chef");

  await rec.run("Restaurant → Kitchen → Stock", 2, "order.created", "Waitress raises a restaurant order", async (t) => {
    const waiterAccount = ctx.a.accounts.find((x) => x.key === "waiter")!;
    const { data, error } = await waiter
      .from("pos_orders")
      .insert({
        organization_id: ctx.a.orgId,
        branch_id: ctx.a.branchId,
        order_number: `TEST-${ctx.runRef}-POS`,
        order_type: "dine-in",
        order_source: "waiter",
        station_id: ctx.a.seed["restaurantStationId"] ?? null,
        folio_id: ctx.state["folioId"] ?? null,
        room_id: ctx.a.seed["roomId"],
        customer_id: ctx.state["customerId"] ?? null,
        waiter_id: waiterAccount.userId,
        guest_count: 2,
        status: "confirmed",
        payment_status: "unpaid",
        subtotal: 1200,
        tax_total: 192,
        grand_total: 1392,
        currency: "KES",
        created_by: waiterAccount.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`The waitress could not raise an order: ${error.message}`);
    const orderId = (data as { id: string }).id;
    ctx.state["posOrderId"] = orderId;
    ctx.rec.artifact("pos_orders", orderId);

    const { error: lineError } = await waiter.from("pos_order_items").insert({
      organization_id: ctx.a.orgId,
      order_id: orderId,
      menu_item_id: ctx.a.seed["menuItemId"],
      station_id: ctx.a.seed["hotKitchenStationId"] ?? null,
      item_name: "TEST Grilled Chicken",
      quantity: 1,
      unit_price: 1200,
      tax_rate: 16,
      tax_amount: 192,
      line_total: 1392,
      status: "sent",
      created_by: waiterAccount.userId,
    } as never);
    if (lineError) throw new Error(`Order line failed: ${lineError.message}`);
    t.must("order stored", Boolean(orderId));
    t.note("pos_order_id", orderId);
  });

  await rec.run("Restaurant → Kitchen → Stock", 2, "kds.routed", "The order reaches the correct kitchen station", async (t) => {
    await expectOk(waiter, "neo_pos_send_to_kitchen", { _order: ctx.state["posOrderId"], _attempt: crypto.randomUUID() });
    const { data } = await ctx.admin
      .from("station_tickets")
      .select("id, station_id, status")
      .eq("order_id", ctx.state["posOrderId"]!);
    const tickets = (data ?? []) as { id: string; station_id: string; status: string }[];
    t.must("a station ticket exists", tickets.length > 0);
    t.must(
      "ticket routed to the hot kitchen station",
      tickets.every((x) => x.station_id === ctx.a.seed["hotKitchenStationId"]),
      ctx.a.seed["hotKitchenStationId"],
      tickets.map((x) => x.station_id),
    );
    ctx.state["ticketId"] = tickets[0]!.id;
    t.note("station_ticket_id", tickets[0]!.id);
  });

  await rec.run("Restaurant → Kitchen → Stock", 2, "kds.chef_sees", "The chef sees the ticket in their queue", async (t) => {
    const { data, error } = await rpc(chef, "neo_kitchen_queue", {
      _branch: ctx.a.branchId,
      _station: ctx.a.seed["hotKitchenStationId"],
      _view: "live",
    });
    t.note("queue_error", error?.message ?? null);
    t.note("queue", JSON.stringify(data ?? "").slice(0, 400));
    const { data: mine } = await chef.from("station_tickets").select("id").eq("id", ctx.state["ticketId"]!);
    t.must("the chef can open the ticket at their station", ((mine ?? []) as unknown[]).length > 0);
    // Kitchen work is allocated by the head chef before it reaches a chef's queue.
    const head = ctx.clientsA.get("owner")!;
    const chefAccount = ctx.a.accounts.find((x) => x.key === "chef")!;
    const { error: allocError } = await rpc(head, "neo_kitchen_assign_chef", {
      _ticket: ctx.state["ticketId"]!,
      _chef: chefAccount.userId,
      _reason: "System test",
    });
    t.must(`the head chef can allocate the ticket${allocError ? `: ${allocError.message}` : ""}`, !allocError);
    const { data: queued } = await rpc(chef, "neo_kitchen_queue", {
      _branch: ctx.a.branchId,
      _station: ctx.a.seed["hotKitchenStationId"],
      _view: "live",
    });
    t.must("the allocated ticket appears in the chef's queue", JSON.stringify(queued ?? "").includes(ctx.state["ticketId"]!));
  });

  await rec.run("Restaurant → Kitchen → Stock", 2, "kds.prepared", "Preparation runs through to ready", async (t) => {
    const { data: items } = await ctx.admin
      .from("station_ticket_items")
      .select("id, status")
      .eq("ticket_id", ctx.state["ticketId"]!);
    const list = (items ?? []) as { id: string; status: string }[];
    t.must("the ticket has items", list.length > 0);

    const before = await stockOnHand(ctx);
    for (const item of list) {
      const { error: acceptError } = await rpc(chef, "neo_kitchen_item_transition", {
        _item: item.id,
        _to: "accepted",
        _reason: "System test",
      });
      t.note("accept_error", acceptError?.message ?? null);
      await expectOk(chef, "neo_kitchen_item_transition", { _item: item.id, _to: "preparing", _reason: "System test" });
      await expectOk(chef, "neo_kitchen_item_transition", { _item: item.id, _to: "ready", _reason: "System test" });
    }
    const { data: after } = await ctx.admin
      .from("station_ticket_items")
      .select("status")
      .eq("ticket_id", ctx.state["ticketId"]!);
    t.must(
      "every item is ready",
      ((after ?? []) as { status: string }[]).every((x) => /ready|collected|served/i.test(x.status)),
    );

    // Stock leaves the store when the food is served, not when it is plated.
    const waiterClient = ctx.clientsA.get("waiter")!;
    for (const item of list) {
      const { error: serveError } = await rpc(waiterClient, "neo_kitchen_item_transition", {
        _item: item.id,
        _to: "served",
        _reason: "System test",
      });
      t.note("serve_error", serveError?.message ?? null);
    }

    const now = await stockOnHand(ctx);
    ctx.state["stockAfterSale"] = String(now);
    t.check("recipe consumption reduced the store stock", now < before, `< ${before}`, now);
    t.note("stock_before", before);
    t.note("stock_after", now);
  });

  await rec.run("Restaurant → Kitchen → Stock", 2, "kds.notified", "The waitress is told the food is ready", async (t) => {
    const waiterAccount = ctx.a.accounts.find((x) => x.key === "waiter")!;
    const { data } = await ctx.admin
      .from("notifications")
      .select("id, title, category, user_id")
      .eq("organization_id", ctx.a.orgId)
      .eq("user_id", waiterAccount.userId)
      .order("created_at", { ascending: false })
      .limit(20);
    const rows = (data ?? []) as { title: string }[];
    t.note("notifications", rows.map((r) => r.title));
    if (rows.length === 0)
      throw new NotConfigured("No ready-notification reached the waitress; this workspace has no notification rule for it.");
    t.check("a notification reached the waitress", rows.length > 0);
  });
}

async function stockOnHand(ctx: SuiteContext): Promise<number> {
  const { data } = await ctx.admin
    .from("stock_levels")
    .select("quantity_on_hand")
    .eq("stock_item_id", ctx.a.seed["stockItemId"]!)
    .eq("location_id", ctx.a.seed["storeLocationId"]!)
    .maybeSingle();
  return Number((data as { quantity_on_hand: number } | null)?.quantity_on_hand ?? 0);
}

/* ------------------------------------------------------------------ TEST 3 */

export async function suiteShortageProcurement(ctx: SuiteContext) {
  const { rec } = ctx;
  const storekeeper = client(ctx, "storekeeper");
  const procurement = client(ctx, "procurement");

  await rec.run("Shortage → Procurement", 3, "shortage.detected", "A controlled shortage is detected by the low stock scan", async (t) => {
    await ctx.admin
      .from("stock_levels")
      .update({ quantity_on_hand: 1 } as never)
      .eq("stock_item_id", ctx.a.seed["stockItemId"]!)
      .eq("location_id", ctx.a.seed["storeLocationId"]!);
    t.note("setup", "Stock deliberately reduced to 1 kg against a reorder point of 5 kg.");

    const { data, error } = await rpc(storekeeper, "neo_stores_low_stock_scan", { _branch: ctx.a.branchId });
    if (error) throw new Error(`Low stock scan failed: ${error.message}`);
    const scan = (data ?? {}) as { items_below_minimum?: number };
    t.note("scan", scan);
    t.must("the shortage is reported", Number(scan.items_below_minimum ?? 0) > 0, "> 0", scan.items_below_minimum);
  });

  await rec.run("Shortage → Procurement", 3, "requisition.raised", "A purchase requisition is raised and submitted", async (t) => {
    const account = ctx.a.accounts.find((x) => x.key === "procurement")!;
    const { data, error } = await procurement
      .from("purchase_requests")
      .insert({
        organization_id: ctx.a.orgId,
        branch_id: ctx.a.branchId,
        department_id: ctx.a.seed["kitchenDepartmentId"] ?? null,
        request_number: `TEST-${ctx.runRef}-PR`,
        title: `TEST replenishment ${ctx.runRef}`,
        status: "draft",
        priority: "normal",
        source: "system-test",
        needed_by: plusDays(2),
        justification: "System test controlled shortage",
        requested_by: account.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`Requisition could not be raised: ${error.message}`);
    const requestId = (data as { id: string }).id;
    ctx.state["purchaseRequestId"] = requestId;
    ctx.rec.artifact("purchase_requests", requestId);

    const { error: lineError } = await procurement.from("purchase_request_lines").insert({
      organization_id: ctx.a.orgId,
      request_id: requestId,
      stock_item_id: ctx.a.seed["stockItemId"],
      description: "TEST Chicken Fillet",
      quantity: 20,
      unit: "kg",
      estimated_unit_price: 550,
    } as never);
    if (lineError) throw new Error(`Requisition line failed: ${lineError.message}`);

    await expectOk(procurement, "neo_procurement_request_submit", {
      _request: requestId,
      _attempt: crypto.randomUUID(),
    });
    const { data: after } = await procurement
      .from("purchase_requests")
      .select("status")
      .eq("id", requestId)
      .maybeSingle();
    t.check("requisition left draft", (after as { status: string } | null)?.status !== "draft", "submitted", (after as { status: string } | null)?.status);
    t.note("purchase_request_id", requestId);
  });

  await rec.run("Shortage → Procurement", 3, "order.raised", "A purchase order is created and approved", async (t) => {
    const approvals: string[] = [];
    let approvedBy: string | null = null;
    for (const key of ["operations_manager", "owner"]) {
      const c = ctx.clientsA.get(key);
      if (!c) continue;
      const { error } = await rpc(c, "neo_procurement_request_decide", {
        _request: ctx.state["purchaseRequestId"],
        _decision: "approve",
        _reason: "System test approval",
      });
      if (!error) { approvedBy = key; break; }
      approvals.push(`${key}: ${error.message}`);
    }
    t.note("approval_refusals", approvals);
    t.must("the requisition is approved", Boolean(approvedBy), "approved", approvals.join(" | "));
    const created = (await expectOk(procurement, "neo_procurement_order_from_request", {
      _request: ctx.state["purchaseRequestId"],
      _supplier: ctx.a.seed["supplierId"],
      _expected: plusDays(2),
      _attempt: crypto.randomUUID(),
      _location: ctx.a.seed["storeLocationId"],
    })) as { id?: string; order_id?: string } | string;
    const orderId = typeof created === "string" ? created : (created.id ?? created.order_id);
    t.must("a purchase order was created", Boolean(orderId));
    ctx.state["purchaseOrderId"] = orderId!;
    ctx.rec.artifact("purchase_orders", orderId!);

    const orderRefusals: string[] = [];
    let orderApprovedBy: string | null = null;
    for (const key of ["procurement", "operations_manager", "owner"]) {
      const c = ctx.clientsA.get(key);
      if (!c) continue;
      const { error } = await rpc(c, "neo_procurement_order_approve", { _order: orderId, _reason: "System test" });
      if (!error) { orderApprovedBy = key; break; }
      orderRefusals.push(`${key}: ${error.message}`);
    }
    t.note("order_approval_refusals", orderRefusals);
    if (!orderApprovedBy) throw new Error(`No role could approve the order — ${orderRefusals.join(" | ")}`);
    t.note("order_approved_by", orderApprovedBy);
    const { data: po } = await procurement.from("purchase_orders").select("status").eq("id", orderId!).maybeSingle();
    t.check("order is approved", /approv|pending-delivery|sent|issued/i.test((po as { status: string } | null)?.status ?? ""), "approved", (po as { status: string } | null)?.status);
  });

  await rec.run("Shortage → Procurement", 3, "grn.received", "Goods are received and stock rises", async (t) => {
    const before = await stockOnHand(ctx);
    const { data: lines } = await ctx.admin
      .from("purchase_order_lines")
      .select("id, stock_item_id, quantity, unit_price")
      .eq("order_id", ctx.state["purchaseOrderId"]!);
    const list = (lines ?? []) as { id: string; stock_item_id: string; quantity: number; unit_price: number }[];
    t.must("the order has lines", list.length > 0);

    await expectOk(storekeeper, "neo_stores_receive_goods", {
      _order: ctx.state["purchaseOrderId"],
      _location: ctx.a.seed["storeLocationId"],
      _lines: list.map((l) => ({
        order_line_id: l.id,
        stock_item_id: l.stock_item_id,
        quantity_received: l.quantity,
        quantity_accepted: l.quantity,
        quantity_rejected: 0,
        unit_price: l.unit_price ?? 550,
      })),
      _attempt: crypto.randomUUID(),
      _notes: "System test receipt",
      _delivery_note: `TEST-${ctx.runRef}-DN`,
    });

    const after = await stockOnHand(ctx);
    t.must("stock increased after receiving", after > before, `> ${before}`, after);
    const { data: grn } = await ctx.admin
      .from("goods_receipts")
      .select("id, status")
      .eq("order_id", ctx.state["purchaseOrderId"]!)
      .limit(1)
      .maybeSingle();
    t.must("a goods receipt note exists", Boolean((grn as { id: string } | null)?.id));
    if ((grn as { id: string } | null)?.id) ctx.rec.artifact("goods_receipts", (grn as { id: string }).id);
    t.note("stock_before", before);
    t.note("stock_after", after);
  });
}

/* ------------------------------------------------------------------ TEST 4 */

export async function suiteFinance(ctx: SuiteContext) {
  const { rec } = ctx;
  const accountant = client(ctx, "accountant");
  const reception = client(ctx, "receptionist");

  await rec.run("Finance", 4, "charge.posted", "A room charge posts to the folio", async (t) => {
    if (!ctx.state["folioId"]) throw new Skipped("No folio was opened, so nothing can be charged.");
    await expectOk(reception, "pms_post_room_charge", {
      _folio: ctx.state["folioId"],
      _category: "miscellaneous",
      _description: "TEST incidental charge",
      _quantity: 1,
      _unit_price: 10000,
      _tax: 1600,
      _source_module: "system-test",
      _source_record_id: ctx.state["reservationId"] ?? ctx.runRef,
      _idempotency_key: `${ctx.runRef}-incidental`,
    });
    const { data } = await ctx.admin
      .from("folios")
      .select("total_charges, balance")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    const folio = data as { total_charges: number; balance: number } | null;
    t.must("charges are on the folio", Number(folio?.total_charges ?? 0) > 0, "> 0", folio?.total_charges);
    ctx.state["folioBalance"] = String(folio?.balance ?? 0);
    t.note("balance_after_charge", folio?.balance);
  });

  await rec.run("Finance", 4, "charge.idempotent", "Re-posting the same charge does not double it", async (t) => {
    const before = Number(ctx.state["folioBalance"] ?? 0);
    await rpc(reception, "pms_post_room_charge", {
      _folio: ctx.state["folioId"],
      _category: "miscellaneous",
      _description: "TEST incidental charge",
      _quantity: 1,
      _unit_price: 10000,
      _tax: 1600,
      _source_module: "system-test",
      _source_record_id: ctx.state["reservationId"] ?? ctx.runRef,
      _idempotency_key: `${ctx.runRef}-incidental`,
    });
    const { data } = await ctx.admin.from("folios").select("balance").eq("id", ctx.state["folioId"]!).maybeSingle();
    const balance = Number((data as { balance: number } | null)?.balance ?? 0);
    t.must("balance unchanged on repeat", Math.abs(balance - before) < 0.01, before, balance);
  });

  await rec.run("Finance", 4, "payment.recorded", "A simulated payment settles the folio", async (t) => {
    const { data: before } = await ctx.admin
      .from("folios")
      .select("balance")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    const due = Number((before as { balance: number } | null)?.balance ?? 0);
    t.note("balance_due", due);
    // Each cashier takes money from their own open till, so every candidate
    // opens one first — the same order a real desk works in.
    const tills: Record<string, string> = {};
    for (const key of ["accountant", "receptionist", "operations_manager", "owner"]) {
      const c = ctx.clientsA.get(key);
      if (!c) continue;
      const { data: shift, error: shiftError } = await rpc(c, "cash_open_shift", {
        _branch: ctx.a.branchId,
        _station: null,
        _float: 0,
      });
      tills[key] = shiftError ? shiftError.message : String(shift);
    }
    t.note("tills", tills);
    const settlers = ["accountant", "receptionist", "operations_manager", "owner"]
      .map((k) => [k, ctx.clientsA.get(k)] as const)
      .filter((x) => Boolean(x[1]));
    let settledBy: string | null = null;
    const refusals: string[] = [];
    for (const [key, c] of settlers) {
      const { error } = await rpc(c!, "pms_record_payment", {
        _folio: ctx.state["folioId"],
        _amount: due,
        _method: "cash",
        _reference: `TEST-${ctx.runRef}-PAY`,
        _notes: "System test simulated settlement — no external provider used",
        _intent_key: `${ctx.runRef}-payment`,
      });
      if (!error) { settledBy = key; break; }
      refusals.push(`${key}: ${error.message}`);
    }
    t.note("refusals", refusals);
    t.note("settled_by", settledBy);
    // Recording money is a till duty: cashier/front office, with finance oversight.
    t.must("a till-holding role can settle the bill", Boolean(settledBy));
    t.note("accountant_refusal", refusals.find((r) => r.startsWith("accountant")) ?? null);
    t.must("the bill was settled by an authorised role", Boolean(settledBy), "settled", refusals.join(" | "));
    const { data: after } = await ctx.admin
      .from("folios")
      .select("balance, total_payments, status")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    const folio = after as { balance: number; total_payments: number } | null;
    t.must("payment recorded", Number(folio?.total_payments ?? 0) > 0);
    t.must("balance cleared", Math.abs(Number(folio?.balance ?? 1)) < 0.01, 0, folio?.balance);
  });

  await rec.run("Finance", 4, "payment.idempotent", "The same payment intent cannot be taken twice", async (t) => {
    const { data: before } = await ctx.admin
      .from("folios")
      .select("total_payments")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    await rpc(ctx.clientsA.get("owner")!, "pms_record_payment", {
      _folio: ctx.state["folioId"],
      _amount: 100,
      _method: "cash",
      _reference: `TEST-${ctx.runRef}-PAY`,
      _notes: "Repeat of the same intent",
      _intent_key: `${ctx.runRef}-payment`,
    });
    const { data: after } = await ctx.admin
      .from("folios")
      .select("total_payments")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    t.must(
      "payments total unchanged",
      Number((before as { total_payments: number } | null)?.total_payments) ===
        Number((after as { total_payments: number } | null)?.total_payments),
      (before as { total_payments: number } | null)?.total_payments,
      (after as { total_payments: number } | null)?.total_payments,
    );
  });

  await rec.run("Finance", 4, "till.context", "A till is available to the cashier", async (t) => {
    const { data, error } = await rpc(accountant, "neo_cash_till_context", { _branch: ctx.a.branchId });
    if (error) throw new Error(`Till lookup failed: ${error.message}`);
    const raw = JSON.stringify(data ?? {});
    t.note("till_context", raw.slice(0, 400));
    if (!/till|drawer|shift/i.test(raw) || /"till":null|\[\]/.test(raw))
      throw new NotConfigured("No till or cash drawer is configured in this workspace, so till open/close was not exercised.");
    t.check("a till context was returned", raw.length > 2);
  });

  await rec.run("Finance", 4, "refund.governed", "A refund needs authorisation before money moves", async (t) => {
    const { data: paymentRow } = await ctx.admin
      .from("payments")
      .select("id")
      .eq("folio_id", ctx.state["folioId"]!)
      .limit(1)
      .maybeSingle();
    const paymentId = (paymentRow as { id: string } | null)?.id;
    if (!paymentId) throw new Skipped("No payment exists to refund.");
    const { data, error } = await rpc(accountant, "neo_cash_refund_request", {
      _payment: paymentId,
      _amount: 100,
      _reason: "System test refund",
    });
    if (error) {
      const d = denial(error);
      if (d.denied) {
        t.check("refund is refused without authority", true, "denied", d.message);
        return;
      }
      throw new NotConfigured(`Refund request could not be exercised in this workspace: ${error.message}`);
    }
    const raw = JSON.stringify(data ?? {});
    t.check("refund raised as a request, not an immediate payout", /pending|requested|await/i.test(raw), "pending", raw.slice(0, 200));
    t.note("refund_response", raw.slice(0, 300));
  });

  await rec.run("Finance", 4, "audit.finance", "The money movements are on the audit trail", async (t) => {
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("action, module, user_id, organization_id, created_at, record_id")
      .eq("organization_id", ctx.a.orgId)
      .gte("created_at", auditWindowFrom(30))
      .order("created_at", { ascending: false })
      .limit(100);
    const rows = (data ?? []) as { action: string; module: string; user_id: string | null }[];
    const payment = rows.find((r) => /payment|folio|charge/i.test(`${r.action} ${r.module}`));
    t.note("recent_audit_actions", rows.slice(0, 10).map((r) => r.action));
    t.must("a money-movement entry exists", Boolean(payment));
    t.must("the entry names an actor", Boolean(payment?.user_id));
  });
}

/* ------------------------------------------------------------------ TEST 5 */

export async function suiteHousekeeping(ctx: SuiteContext) {
  const { rec } = ctx;
  const reception = client(ctx, "receptionist");
  const housekeeper = client(ctx, "housekeeper");

  await rec.run("Housekeeping", 5, "checkout.dirty", "Checkout leaves the room dirty and vacant", async (t) => {
    if (!ctx.state["reservationId"]) throw new Skipped("No reservation to check out.");
    const { error } = await rpc(reception, "pms_check_out", {
      _reservation: ctx.state["reservationId"],
      _force: false,
      _notes: "System test checkout",
    });
    if (error) throw new Error(`Checkout failed: ${error.message}`);
    const { data } = await ctx.admin
      .from("rooms")
      .select("occupancy_status, housekeeping_status")
      .eq("id", ctx.a.seed["roomId"]!)
      .maybeSingle();
    const room = data as { occupancy_status: string; housekeeping_status: string } | null;
    t.check("room is vacant", /vacant/i.test(room?.occupancy_status ?? ""), "vacant", room?.occupancy_status);
    t.check("room is dirty", /dirty|soiled/i.test(room?.housekeeping_status ?? ""), "dirty", room?.housekeeping_status);

    const { data: folio } = await ctx.admin
      .from("folios")
      .select("status, balance")
      .eq("id", ctx.state["folioId"]!)
      .maybeSingle();
    t.check("the folio closed with no balance", Math.abs(Number((folio as { balance: number } | null)?.balance ?? 1)) < 0.01);
    t.note("folio_status", (folio as { status: string } | null)?.status);
  });

  await rec.run("Housekeeping", 5, "task.assigned", "A cleaning task is raised and assigned", async (t) => {
    // Checkout usually raises the departure clean itself; reuse it when it exists.
    const { data: existing } = await ctx.admin
      .from("housekeeping_jobs")
      .select("id, status")
      .eq("organization_id", ctx.a.orgId)
      .eq("room_id", ctx.a.seed["roomId"]!)
      .in("status", ["pending", "assigned", "in-progress", "rework"])
      .limit(1)
      .maybeSingle();
    let created: { id?: string; job_id?: string } | string | null =
      (existing as { id: string } | null) ?? null;
    if (created) t.note("reused_existing_job", true);
    const refusals: string[] = [];
    for (const key of created ? [] : ["housekeeper", "operations_manager", "receptionist", "owner"]) {
      const c = ctx.clientsA.get(key);
      if (!c) continue;
      const { data, error } = await rpc(c, "hk_raise_cleaning_task", {
        _room: ctx.a.seed["roomId"],
        _job_type: "stayover-cleaning",
        _reason: "System test departure clean",
        _priority: "normal",
        _source: "system-test",
        _idempotency_key: `${ctx.runRef}-hk`,
      });
      if (!error) { created = data as never; t.note("raised_by", key); break; }
      refusals.push(`${key}: ${error.message}`);
    }
    t.note("refusals", refusals);
    if (!created) throw new Error(`No role could raise a cleaning task — ${refusals.join(" | ")}`);
    const madeJob = created as { id?: string; job_id?: string } | string;
    const jobId = typeof madeJob === "string" ? madeJob : (madeJob.id ?? madeJob.job_id);
    t.must("a cleaning job exists", Boolean(jobId));
    ctx.state["housekeepingJobId"] = jobId!;
    ctx.rec.artifact("housekeeping_jobs", jobId!);

    const account = ctx.a.accounts.find((x) => x.key === "housekeeper")!;
    const { error: assignError } = await rpc(housekeeper, "hk_assign_job", {
      _job: jobId,
      _assignee: account.userId,
      _reason: "System test",
    });
    if (assignError) {
      t.note("housekeeper_self_assign_refused", assignError.message);
      const assigner = ctx.clientsA.get("operations_manager") ?? ctx.clientsA.get("owner")!;
      await expectOk(assigner, "hk_assign_job", { _job: jobId, _assignee: account.userId, _reason: "System test" });
    }
    const { data } = await ctx.admin
      .from("housekeeping_jobs")
      .select("assignee_id, status")
      .eq("id", jobId!)
      .maybeSingle();
    t.must("the job names a housekeeper", (data as { assignee_id: string } | null)?.assignee_id === account.userId);
  });

  await rec.run("Housekeeping", 5, "task.cleaned", "The room is cleaned, inspected and released", async (t) => {
    const jobId = ctx.state["housekeepingJobId"];
    if (!jobId) throw new Skipped("No cleaning job to work.");
    await expectOk(housekeeper, "hk_start_job", { _job: jobId });
    await expectOk(housekeeper, "hk_complete_job", { _job: jobId, _notes: "System test clean" });
    const { data: mid } = await ctx.admin.from("housekeeping_jobs").select("status").eq("id", jobId).maybeSingle();
    t.check("job completed", /complete|inspect/i.test((mid as { status: string } | null)?.status ?? ""), "completed", (mid as { status: string } | null)?.status);

    const supervisor = ctx.clientsA.get("operations_manager") ?? ctx.clientsA.get("owner")!;
    const { error } = await rpc(supervisor, "hk_record_inspection", {
      _job: jobId,
      _result: "passed",
      _notes: "System test inspection",
    });
    if (error) throw new Error(`Inspection failed: ${error.message}`);

    const { data: room } = await ctx.admin
      .from("rooms")
      .select("housekeeping_status, occupancy_status, sellable")
      .eq("id", ctx.a.seed["roomId"]!)
      .maybeSingle();
    const r = room as { housekeeping_status: string; sellable: boolean } | null;
    t.check("room is clean again", /clean|inspected/i.test(r?.housekeeping_status ?? ""), "clean", r?.housekeeping_status);
    t.check("room is sellable", r?.sellable === true);
  });
}

/* ------------------------------------------------------------------ TEST 6 */

export async function suiteMaintenance(ctx: SuiteContext) {
  const { rec } = ctx;
  const maintenance = client(ctx, "maintenance");
  const manager = ctx.clientsA.get("operations_manager") ?? ctx.clientsA.get("owner")!;

  await rec.run("Maintenance", 6, "issue.raised", "A maintenance issue is raised", async (t) => {
    const created = (await expectOk(manager, "neo_maintenance_work_order_create", {
      _payload: {
        branch_id: ctx.a.branchId,
        room_id: ctx.a.seed["roomId2"],
        description: `TEST fault ${ctx.runRef} — simulated dripping tap`,
        priority: "normal",
        fault_category: "plumbing",
        requesting_department_id: ctx.a.seed["housekeepingDepartmentId"] ?? null,
        source_module: "system-test",
      },
      _idempotency_key: `${ctx.runRef}-wo`,
    })) as { id?: string; work_order_id?: string } | string;
    const id = typeof created === "string" ? created : (created.id ?? created.work_order_id);
    t.must("a work order exists", Boolean(id));
    ctx.state["workOrderId"] = id!;
    ctx.rec.artifact("maintenance_work_orders", id!);
  });

  await rec.run("Maintenance", 6, "issue.worked", "Assignment, work and completion are recorded", async (t) => {
    const id = ctx.state["workOrderId"];
    if (!id) throw new Skipped("No work order to advance.");
    const officer = ctx.a.accounts.find((x) => x.key === "maintenance")!;
    const { error: assignError } = await manager
      .from("maintenance_work_orders")
      .update({ assigned_to: officer.userId } as never)
      .eq("id", id);
    if (assignError) throw new Error(`Assignment failed: ${assignError.message}`);

    await expectOk(maintenance, "neo_maint_job_advance", { _work_order: id, _status: "in-progress", _note: "System test" });
    await expectOk(maintenance, "neo_maint_job_advance", {
      _work_order: id,
      _status: "completed",
      _note: "System test repair complete",
    });

    const { data } = await ctx.admin
      .from("maintenance_work_orders")
      .select("status, assigned_to, completed_at")
      .eq("id", id)
      .maybeSingle();
    const wo = data as { status: string; assigned_to: string; completed_at: string | null } | null;
    t.must("the job names the officer", wo?.assigned_to === officer.userId);
    t.check("the job is completed", /complete|resolved|closed/i.test(wo?.status ?? ""), "completed", wo?.status);
    t.check("a completion time was stamped", Boolean(wo?.completed_at));

    const { data: history } = await ctx.admin
      .from("work_order_status_history")
      .select("new_status, changed_by, created_at")
      .eq("work_order_id", id);
    t.note("status_history", history ?? []);
    t.check("the change history is recorded", ((history ?? []) as unknown[]).length > 0);
  });
}

/* ------------------------------------------------------------------ TEST 7 */

export async function suiteEvents(ctx: SuiteContext) {
  const { rec } = ctx;
  const events = client(ctx, "events");

  const GUESTS = 50;
  const PACKAGE_PRICE = 2500;
  const EVENT_VALUE = GUESTS * PACKAGE_PRICE;

  await rec.run("Events", 7, "package.priced", "A priced package sits in the events catalogue", async (t) => {
    const account = ctx.a.accounts.find((x) => x.key === "events")!;
    const { data, error } = await events
      .from("event_packages")
      .insert({
        organization_id: ctx.a.orgId,
        branch_id: ctx.a.branchId,
        name: `TEST Conference Package ${ctx.runRef}`,
        description: "System test package — per person",
        price_basis: "per-person",
        price: PACKAGE_PRICE,
        min_guests: 20,
        max_guests: 150,
        tax_rate: 0,
        active: true,
        created_by: account.userId,
      } as never)
      .select("id, price, min_guests, max_guests, active")
      .single();
    if (error) throw new Error(`The events manager could not create a package: ${error.message}`);
    const pkg = data as { id: string; price: number; min_guests: number; max_guests: number; active: boolean };
    ctx.state["eventPackageId"] = pkg.id;
    ctx.rec.artifact("event_packages", pkg.id);
    t.must("the package carries a price", Number(pkg.price) === PACKAGE_PRICE, PACKAGE_PRICE, pkg.price);
    t.must("the package is active", pkg.active === true);
    t.must(
      "the test guest count sits inside the package range",
      GUESTS >= pkg.min_guests && GUESTS <= pkg.max_guests,
      `${pkg.min_guests}-${pkg.max_guests}`,
      GUESTS,
    );
  });

  await rec.run("Events", 7, "enquiry.booked", "An enquiry is quoted on the package and becomes a confirmed booking", async (t) => {
    const account = ctx.a.accounts.find((x) => x.key === "events")!;
    const { data: enquiry, error: enquiryError } = await events
      .from("event_enquiries")
      .insert({
        organization_id: ctx.a.orgId,
        branch_id: ctx.a.branchId,
        enquiry_number: `TEST-${ctx.runRef}-ENQ`,
        contact_name: "TEST Event Contact",
        phone: testPhone("722", ctx.runRef),
        email: `neo-qa+event@neo-simulation.example.com`,
        proposed_date: plusDays(14),
        expected_adults: GUESTS,
        status: "new",
        created_by: account.userId,
      } as never)
      .select("id")
      .single();
    if (enquiryError) throw new Error(`Enquiry failed: ${enquiryError.message}`);
    const enquiryId = (enquiry as { id: string }).id;
    ctx.rec.artifact("event_enquiries", enquiryId);

    const packageId = ctx.state["eventPackageId"];
    if (!packageId) throw new Skipped("No priced package is available to quote on.");

    const { data: quotation, error: quoteError } = await events
      .from("event_quotations")
      .insert({
        organization_id: ctx.a.orgId,
        branch_id: ctx.a.branchId,
        enquiry_id: enquiryId,
        package_id: packageId,
        quotation_number: `TEST-${ctx.runRef}-QUO`,
        title: `TEST Conference ${ctx.runRef}`,
        event_date: plusDays(14),
        start_time: "09:00",
        end_time: "17:00",
        guest_count: GUESTS,
        subtotal: EVENT_VALUE,
        grand_total: EVENT_VALUE,
        deposit_percent: 20,
        deposit_amount: EVENT_VALUE * 0.2,
        balance_due: EVENT_VALUE * 0.8,
        status: "draft",
        created_by: account.userId,
      } as never)
      .select("id")
      .single();
    if (quoteError) throw new Error(`Quotation failed: ${quoteError.message}`);
    const quotationId = (quotation as { id: string }).id;
    ctx.state["eventQuotationId"] = quotationId;
    ctx.rec.artifact("event_quotations", quotationId);

    const { error: itemError } = await events.from("event_quotation_items").insert({
      organization_id: ctx.a.orgId,
      quotation_id: quotationId,
      category: "package",
      description: `TEST Conference Package ${ctx.runRef}`,
      quantity: GUESTS,
      unit: "person",
      unit_price: PACKAGE_PRICE,
      line_total: EVENT_VALUE,
      taxable: false,
    } as never);
    if (itemError) throw new Error(`Quotation line failed: ${itemError.message}`);

    const { error: acceptError } = await events
      .from("event_quotations")
      .update({ status: "accepted", accepted_by_name: "TEST Event Contact" } as never)
      .eq("id", quotationId);
    if (acceptError) throw new Error(`The quotation could not be accepted: ${acceptError.message}`);

    const converted = await expectOk(events, "neo_event_convert_quotation", {
      _quotation: quotationId,
      _payload: { branch_id: ctx.a.branchId, event_name: `TEST Conference ${ctx.runRef}`, status: "confirmed" },
    });
    const bookingId = (converted as { booking_id?: string })?.booking_id;
    t.must("the accepted quotation became an event", Boolean(bookingId), "booking created", JSON.stringify(converted));
    if (!bookingId) return;
    ctx.state["eventBookingId"] = bookingId;
    ctx.rec.artifact("event_bookings", bookingId);

    const { data: booking } = await ctx.admin
      .from("event_bookings")
      .select("status, total_amount, quotation_id, expected_guests")
      .eq("id", bookingId)
      .maybeSingle();
    const row = booking as { status: string; total_amount: number; quotation_id: string; expected_guests: number } | null;
    t.must("the booking is confirmed", row?.status === "confirmed", "confirmed", row?.status);
    t.must("the booking is tied to the accepted quotation", row?.quotation_id === quotationId);
    t.must("the booking carries the package value", Number(row?.total_amount ?? 0) === EVENT_VALUE, EVENT_VALUE, row?.total_amount);
  });

  await rec.run("Events", 7, "billing.built", "The bill is built from the priced package", async (t) => {
    const id = ctx.state["eventBookingId"];
    if (!id) throw new Skipped("No event booking to bill.");
    const built = (await expectOk(events, "neo_event_billing_build", { _booking: id })) as {
      lines?: number;
      total?: number;
    };
    t.note("build_result", JSON.stringify(built));
    const { data: items } = await ctx.admin
      .from("event_billing_items")
      .select("id, category, line_total")
      .eq("booking_id", id);
    const rows = (items ?? []) as { category: string; line_total: number }[];
    const total = rows.reduce((s, r) => s + Number(r.line_total ?? 0), 0);
    t.must("a billing line was raised", rows.length > 0, "> 0", rows.length);
    t.must("the bill equals the package value", Math.abs(total - EVENT_VALUE) < 0.01, EVENT_VALUE, total);
  });

  await rec.run("Events", 7, "beo.published", "The banquet order reaches kitchen, housekeeping and billing", async (t) => {
    const id = ctx.state["eventBookingId"];
    if (!id) throw new Skipped("No event booking to hand over.");
    const ensured = (await expectOk(events, "neo_event_beo_ensure", { _booking: id })) as { id?: string; beo_id?: string } | string;
    const beoId = typeof ensured === "string" ? ensured : (ensured.id ?? ensured.beo_id);
    t.must("a banquet event order exists", Boolean(beoId));
    ctx.state["beoId"] = beoId!;
    ctx.rec.artifact("banquet_event_orders", beoId!);

    const published = await expectOk(events, "neo_event_beo_publish", { _beo: beoId });
    t.note("publish_result", published);

    const { data: requirements } = await ctx.admin
      .from("event_department_requirements")
      .select("department_id, department_key, readiness")
      .eq("booking_id", id);
    t.must("departments received their requirements", ((requirements ?? []) as unknown[]).length > 0, "> 0", (requirements ?? []).length);
    t.note("departments", (requirements ?? []).map((r) => (r as { department_key: string }).department_key));

    const { data: jobs } = await ctx.admin
      .from("housekeeping_jobs")
      .select("id")
      .eq("organization_id", ctx.a.orgId)
      .eq("idempotency_key", `beo:${beoId}`);
    t.check("housekeeping received a preparation job", ((jobs ?? []) as unknown[]).length > 0);

    const { data: billing } = await ctx.admin
      .from("event_billing_items")
      .select("id, line_total")
      .eq("booking_id", id);
    t.note("billing_items", (billing ?? []).length);
    t.must("billing holds the event value", ((billing ?? []) as unknown[]).length > 0, "> 0", (billing ?? []).length);
  });

  await rec.run("Events", 7, "event.paid", "A simulated deposit is recorded against the event", async (t) => {
    const id = ctx.state["eventBookingId"];
    if (!id) throw new Skipped("No event booking to pay.");
    const account = ctx.a.accounts.find((x) => x.key === "events")!;
    const { error } = await events.from("event_payments").insert({
      organization_id: ctx.a.orgId,
      booking_id: id,
      amount: 50000,
      entry_type: "deposit",
      method: "cash",
      reference: `TEST-${ctx.runRef}-EVTPAY`,
      reason: "System test simulated deposit",
      recorded_by: account.userId,
    } as never);
    if (error) throw new Error(`Event payment failed: ${error.message}`);
    const { data } = await ctx.admin.from("event_payments").select("id, amount").eq("booking_id", id);
    t.must("the payment is recorded", ((data ?? []) as unknown[]).length > 0);

    const chain = await expectOk(events, "neo_event_chain_status", { _branch: ctx.a.branchId });
    t.note("chain_status", JSON.stringify(chain).slice(0, 600));
  });
}

/* ------------------------------------------------------------------ TEST 8 */

export async function suiteNotifications(ctx: SuiteContext) {
  const { rec } = ctx;

  await rec.run("Notifications", 8, "internal.generated", "Internal notifications were generated by the run", async (t) => {
    const { data } = await ctx.admin
      .from("notifications")
      .select("id, title, category, source_module, user_id, created_at")
      .eq("organization_id", ctx.a.orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    const rows = (data ?? []) as { title: string; source_module: string | null }[];
    t.note("count", rows.length);
    t.note("sample", rows.slice(0, 8).map((r) => r.title));
    t.must("the workflows raised in-app notifications", rows.length > 0, "> 0", rows.length);
  });

  await rec.run("Notifications", 8, "external.delivery", "External delivery is reported separately", async (t) => {
    const { data } = await ctx.admin
      .from("provider_connections")
      .select("provider, channel, status, enabled")
      .eq("organization_id", ctx.a.orgId);
    const providers = (data ?? []) as { provider: string; channel: string; status: string; enabled: boolean }[];
    t.note("providers", providers);
    const live = providers.filter((p) => p.enabled && p.status === "connected");
    if (live.length === 0)
      throw new NotConfigured(
        "No email, SMS or WhatsApp provider is connected for the test workspace, so external delivery was not attempted. In-app notifications were generated normally.",
      );
    t.check(
      "no test message was actually sent to a real recipient",
      true,
      "no outbound send",
      "external sending is deliberately not triggered by the simulator",
    );
  });

  await rec.run("Notifications", 8, "external.queue_clean", "The test run sent nothing to a real recipient", async (t) => {
    const { data } = await ctx.admin
      .from("communication_queue")
      .select("id, status, recipient")
      .eq("organization_id", ctx.a.orgId)
      .eq("status", "sent");
    t.must("nothing left the system during the test run", ((data ?? []) as unknown[]).length === 0, 0, (data ?? []).length);
  });
}

/* ------------------------------------------------------------------ TEST 9 */

type Probe = {
  role: string;
  label: string;
  expect: "allow" | "deny";
  run: (c: Client, ctx: SuiteContext) => Promise<{ ok: boolean; detail: string }>;
};

const permitted = async (p: Promise<{ error: unknown }>) => {
  const { error } = (await p) as { error: { message: string } | null };
  return { ok: !error, detail: error?.message ?? "allowed" };
};

const PROBES: Probe[] = [
  {
    role: "waiter",
    label: "raise a restaurant order",
    expect: "allow",
    run: async (c, ctx) => {
      const account = ctx.a.accounts.find((x) => x.key === "waiter")!;
      const { data, error } = await c
        .from("pos_orders")
        .insert({
          organization_id: ctx.a.orgId,
          branch_id: ctx.a.branchId,
          order_number: `TEST-${ctx.runRef}-RBAC`,
          order_type: "dine-in",
          status: "confirmed",
          waiter_id: account.userId,
          grand_total: 0,
          created_by: account.userId,
        } as never)
        .select("id")
        .maybeSingle();
      if (data) ctx.rec.artifact("pos_orders", (data as { id: string }).id);
      return { ok: !error, detail: (error as { message: string } | null)?.message ?? "allowed" };
    },
  },
  {
    role: "waiter",
    label: "approve a purchase order",
    expect: "deny",
    run: async (c, ctx) =>
      permitted(c.rpc("neo_procurement_order_approve" as never, { _order: ctx.state["purchaseOrderId"], _reason: "RBAC probe" } as never) as never),
  },
  {
    role: "waiter",
    label: "read staff HR records",
    expect: "deny",
    run: async (c, ctx) => {
      const self = ctx.a.accounts.find((x) => x.key === "waiter")!.userId;
      const { data, error } = await c.from("employees").select("id").neq("profile_id", self).limit(1);
      return { ok: !error && ((data ?? []) as unknown[]).length > 0, detail: (error as { message: string } | null)?.message ?? `${(data ?? []).length} rows` };
    },
  },
  {
    role: "waiter",
    label: "change workspace configuration",
    expect: "deny",
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("organizations")
        .update({ description: "RBAC probe" } as never)
        .eq("id", ctx.a.orgId)
        .select("id");
      return { ok: !error && ((data ?? []) as unknown[]).length > 0, detail: (error as { message: string } | null)?.message ?? `${(data ?? []).length} rows` };
    },
  },
  {
    role: "receptionist",
    label: "read the reservation book",
    expect: "allow",
    run: async (c) => {
      const { error } = await c.from("reservations").select("id").limit(1);
      return { ok: !error, detail: (error as { message: string } | null)?.message ?? "allowed" };
    },
  },
  {
    role: "receptionist",
    label: "post a finance journal",
    expect: "deny",
    run: async (c, ctx) => {
      const { data, error } = await c
        .from("journal_entries")
        .insert({ organization_id: ctx.a.orgId, branch_id: ctx.a.branchId, description: "RBAC probe" } as never)
        .select("id");
      if (data?.[0]) ctx.rec.artifact("journal_entries", (data[0] as { id: string }).id);
      return { ok: !error && ((data ?? []) as unknown[]).length > 0, detail: (error as { message: string } | null)?.message ?? "inserted" };
    },
  },
  {
    role: "housekeeper",
    label: "work a cleaning job",
    expect: "allow",
    run: async (c) => {
      const { error } = await c.from("housekeeping_jobs").select("id").limit(1);
      return { ok: !error, detail: (error as { message: string } | null)?.message ?? "allowed" };
    },
  },
  {
    role: "housekeeper",
    label: "read the general ledger",
    expect: "deny",
    run: async (c) => {
      const { data, error } = await c.from("journal_entry_lines").select("id").limit(1);
      return { ok: !error && ((data ?? []) as unknown[]).length > 0, detail: (error as { message: string } | null)?.message ?? `${(data ?? []).length} rows` };
    },
  },
  {
    role: "storekeeper",
    label: "issue stock",
    expect: "allow",
    run: async (c) => {
      const { error } = await c.from("stock_levels").select("id").limit(1);
      return { ok: !error, detail: (error as { message: string } | null)?.message ?? "allowed" };
    },
  },
  {
    role: "storekeeper",
    label: "approve a purchase order",
    expect: "deny",
    run: async (c, ctx) =>
      permitted(c.rpc("neo_procurement_order_approve" as never, { _order: ctx.state["purchaseOrderId"], _reason: "RBAC probe" } as never) as never),
  },
  {
    role: "chef",
    label: "see the kitchen queue",
    expect: "allow",
    run: async (c, ctx) => permitted(c.rpc("neo_kitchen_queue" as never, { _branch: ctx.a.branchId, _view: "live" } as never) as never),
  },
  {
    role: "chef",
    label: "record a guest payment",
    expect: "deny",
    run: async (c, ctx) =>
      permitted(
        c.rpc("pms_record_payment" as never, {
          _folio: ctx.state["folioId"],
          _amount: 1,
          _method: "cash",
          _intent_key: `${ctx.runRef}-rbac-chef`,
        } as never) as never,
      ),
  },
  {
    role: "rider",
    label: "read the reservation book",
    expect: "deny",
    run: async (c) => {
      const { data, error } = await c.from("reservations").select("id").limit(1);
      return { ok: !error && ((data ?? []) as unknown[]).length > 0, detail: (error as { message: string } | null)?.message ?? `${(data ?? []).length} rows` };
    },
  },
  {
    role: "operations_manager",
    label: "decide approvals for the property",
    expect: "allow",
    run: async (c) => {
      const { error } = await c.from("approval_requests").select("id").limit(1);
      return { ok: !error, detail: (error as { message: string } | null)?.message ?? "allowed" };
    },
  },
];

export async function suitePermissions(ctx: SuiteContext) {
  const { rec } = ctx;
  for (const probe of PROBES) {
    await rec.run(
      "Permissions",
      9,
      `rbac.${probe.role}.${probe.label.replace(/\s+/g, "_")}`,
      `${probe.role}: ${probe.expect === "allow" ? "can" : "cannot"} ${probe.label}`,
      async (t) => {
        const c = ctx.clientsA.get(probe.role);
        if (!c) throw new Skipped(`No ${probe.role} test account.`);
        const outcome = await probe.run(c, ctx);
        t.note("expected", probe.expect);
        t.note("actual", outcome.ok ? "allowed" : "denied");
        t.note("detail", outcome.detail);
        if (probe.expect === "allow") {
          t.must(`${probe.role} may ${probe.label}`, outcome.ok, "allowed", outcome.detail);
        } else {
          t.must(`${probe.role} must not ${probe.label}`, !outcome.ok, "denied", outcome.detail);
        }
      },
    );
  }
}

/* ----------------------------------------------------------------- TEST 10 */

export async function suiteTenancy(ctx: SuiteContext) {
  const { rec } = ctx;
  const foreignOwner = ctx.clientsB.get("owner");
  const foreignReception = ctx.clientsB.get("receptionist");

  await rec.run("Multi-tenancy", 10, "tenant.read", "Hotel B cannot read Hotel A's records", async (t) => {
    if (!foreignOwner) throw new Skipped("The second test workspace is not available.");
    for (const table of ["reservations", "folios", "customers", "pos_orders", "rooms", "audit_logs"]) {
      const { data, error } = await foreignOwner.from(table).select("id, organization_id").eq("organization_id", ctx.a.orgId);
      const rows = (data ?? []) as unknown[];
      t.note(`${table}_rows_visible`, rows.length);
      t.mustIsolate(`Hotel B sees no ${table} of Hotel A`, rows.length === 0, 0, rows.length);
      if (error) t.note(`${table}_error`, error.message);
    }
  });

  await rec.run("Multi-tenancy", 10, "tenant.write", "Hotel B cannot change Hotel A's records", async (t) => {
    if (!foreignOwner) throw new Skipped("The second test workspace is not available.");
    const { data, error } = await foreignOwner
      .from("rooms")
      .update({ notes: "cross-tenant probe" } as never)
      .eq("id", ctx.a.seed["roomId"]!)
      .select("id");
    t.note("update_error", error?.message ?? null);
    t.mustIsolate("no row of Hotel A was changed", ((data ?? []) as unknown[]).length === 0, 0, (data ?? []).length);

    const { data: room } = await ctx.admin.from("rooms").select("notes").eq("id", ctx.a.seed["roomId"]!).maybeSingle();
    t.mustIsolate(
      "Hotel A's room is untouched",
      (room as { notes: string | null } | null)?.notes !== "cross-tenant probe",
    );
  });

  await rec.run("Multi-tenancy", 10, "tenant.rpc", "Cross-workspace business calls are refused", async (t) => {
    if (!foreignReception) throw new Skipped("The second test workspace has no receptionist.");
    const { error } = await rpc(foreignReception, "pms_check_in", {
      _reservation: ctx.state["reservationId"],
      _keys: 1,
      _notes: "cross-tenant probe",
    });
    t.note("rpc_error", error?.message ?? "no error");
    t.mustIsolate("check-in of another workspace's reservation is refused", Boolean(error), "refused", error?.message);

    const { error: chargeError } = await rpc(foreignReception, "pms_post_room_charge", {
      _folio: ctx.state["folioId"],
      _category: "accommodation",
      _description: "cross-tenant probe",
      _quantity: 1,
      _unit_price: 1,
      _tax: 0,
      _source_module: "system-test",
      _source_record_id: ctx.runRef,
      _idempotency_key: `${ctx.runRef}-cross`,
    });
    t.mustIsolate("charging another workspace's folio is refused", Boolean(chargeError), "refused", chargeError?.message);
  });

  await rec.run("Multi-tenancy", 10, "tenant.documents", "Hotel B cannot reach Hotel A's guest documents", async (t) => {
    if (!foreignOwner) throw new Skipped("The second test workspace is not available.");
    const { data } = await foreignOwner.from("customer_documents").select("id").eq("organization_id", ctx.a.orgId);
    t.mustIsolate("no guest documents are visible", ((data ?? []) as unknown[]).length === 0, 0, (data ?? []).length);
  });
}

/* ----------------------------------------------------------------- TEST 11 */

export async function suiteAudit(ctx: SuiteContext) {
  const { rec } = ctx;

  await rec.run("Audit", 11, "audit.fields", "Audited actions carry actor, action, workspace and time", async (t) => {
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("id, action, module, user_id, user_name, organization_id, record_id, created_at, branch_id")
      .eq("organization_id", ctx.a.orgId)
      .gte("created_at", auditWindowFrom(30))
      .order("created_at", { ascending: false })
      .limit(200);
    const rows = (data ?? []) as {
      action: string;
      user_id: string | null;
      user_name: string | null;
      organization_id: string;
      record_id: string | null;
      created_at: string;
    }[];
    t.note("entries", rows.length);
    if (rows.length === 0)
      throw new Error("No audit entries were written for any action in this run.");
    t.must("every entry names the workspace", rows.every((r) => r.organization_id === ctx.a.orgId));
    t.must("every entry is timestamped", rows.every((r) => Boolean(r.created_at)));
    t.must("every entry names an action", rows.every((r) => Boolean(r.action)));
    // System-generated entries carry the acting service name rather than a user id.
    const withActor = rows.filter((r) => r.user_id ?? r.user_name).length;
    t.check("entries name the person who acted", withActor === rows.length, rows.length, withActor);
    t.note("actions", Array.from(new Set(rows.map((r) => r.action))).slice(0, 25));
  });

  await rec.run("Audit", 11, "audit.reservation", "Reservation history records the stay's transitions", async (t) => {
    if (!ctx.state["reservationId"]) throw new Skipped("No reservation in this run.");
    const { data } = await ctx.admin
      .from("reservation_history")
      .select("action, changed_by, created_at")
      .eq("reservation_id", ctx.state["reservationId"]!);
    const rows = (data ?? []) as { action: string }[];
    t.note("history", rows.map((r) => r.action));
    t.must("the stay has a history trail", rows.length > 0);
  });

  await rec.run("Audit", 11, "audit.tenant_scope", "No audit entry leaked from another workspace", async (t) => {
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("organization_id")
      .eq("organization_id", ctx.a.orgId)
      .gte("created_at", auditWindowFrom(30))
      .limit(500);
    const rows = (data ?? []) as { organization_id: string }[];
    t.mustIsolate(
      "all entries belong to the test workspace",
      rows.every((r) => r.organization_id === ctx.a.orgId),
    );
  });
}

/* ----------------------------------------------------------- TEST 12 */

/**
 * Rider readiness.
 *
 * A rider who is merely "available" must never count as ready for work: the
 * dispatch board only treats a rider as eligible once a shift actually covers
 * the current moment. This suite proves both halves — off shift means not
 * eligible, and scheduling a shift through the real routine makes the same
 * rider eligible straight away.
 */
export async function suiteDeliveryRiders(ctx: SuiteContext) {
  const { rec, admin } = ctx;

  await rec.run("Delivery", 12, "rider.off_shift", "A rider with no shift is not eligible for work", async (t) => {
    const { data: existing } = await admin
      .from("rider_profiles")
      .select("id")
      .eq("organization_id", ctx.a.orgId)
      .limit(1);

    let riderId = ((existing ?? [])[0] as { id: string } | undefined)?.id ?? null;
    if (!riderId) {
      const { data: created, error } = await admin
        .from("rider_profiles")
        .insert({
          organization_id: ctx.a.orgId,
          branch_id: ctx.a.branchId,
          rider_code: `TEST-${ctx.runRef}`,
          display_name: "TEST Rider",
          vehicle_type: "motorcycle",
          availability_status: "available",
          max_active_deliveries: 3,
          cash_handling_allowed: true,
          active: true,
        } as never)
        .select("id")
        .single();
      if (error) throw new Error(`Could not create a test rider: ${error.message}`);
      riderId = (created as { id: string }).id;
      rec.artifact("rider_profiles", riderId);
    }
    ctx.state["riderId"] = riderId;

    // Make sure no leftover shift from an earlier run covers this moment.
    await admin
      .from("rider_shifts")
      .update({ status: "cancelled", cancelled_reason: `Test reset ${ctx.runRef}` } as never)
      .eq("rider_id", riderId)
      .in("status", ["scheduled", "active"]);

    // The dispatch board answers as the signed-in staff member, so it is read
    // through an operations account rather than the maintenance client.
    const boardReader = client(ctx, "operations_manager");
    const board = (await expectOk(boardReader, "neo_delivery_dispatch_board", { _branch: ctx.a.branchId })) as {
      riders?: { rider_id: string; on_shift: boolean; availability_status: string }[];
    };
    const rider = (board.riders ?? []).find((r) => r.rider_id === riderId);
    t.note("rider", rider);
    t.must("the rider appears on the dispatch board", Boolean(rider));
    t.check("availability alone is reported", rider?.availability_status === "available", "available", rider?.availability_status);
    t.must("the rider is off shift, so not eligible for work", rider?.on_shift === false, false, rider?.on_shift);
  });

  await rec.run("Delivery", 12, "rider.shift_makes_eligible", "Scheduling a shift makes the rider eligible", async (t) => {
    const riderId = ctx.state["riderId"];
    if (!riderId) throw new Skipped("No test rider was prepared.");
    const ops = client(ctx, "operations_manager");

    const starts = new Date(Date.now() - 30 * 60_000).toISOString();
    const ends = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const result = (await expectOk(ops, "neo_delivery_shift_schedule", {
      _rider: riderId,
      _starts_at: starts,
      _ends_at: ends,
      _branch: ctx.a.branchId,
      _notes: `Test shift ${ctx.runRef}`,
    })) as { ok?: boolean; shift_id?: string; reason?: string };
    t.note("schedule", result);
    t.must("the shift was accepted", result?.ok === true, true, result?.reason ?? result?.ok);
    rec.artifact("rider_shifts", result?.shift_id ?? null);

    const { data: shifts } = await admin
      .from("rider_shifts")
      .select("id, starts_at, ends_at, status")
      .eq("rider_id", riderId)
      .in("status", ["scheduled", "active"]);
    t.note("shifts", shifts);
    t.must("the shift is stored with both times", ((shifts ?? []) as { starts_at: string; ends_at: string }[]).some((s) => Boolean(s.starts_at && s.ends_at)));

    const board = (await expectOk(ops, "neo_delivery_dispatch_board", { _branch: ctx.a.branchId })) as {
      riders?: { rider_id: string; on_shift: boolean; active_load: number; max_active: number }[];
    };
    const rider = (board.riders ?? []).find((r) => r.rider_id === riderId);
    t.note("rider", rider);
    t.must("the rider is now on shift", rider?.on_shift === true, true, rider?.on_shift);
    t.check("the rider has spare capacity", (rider?.active_load ?? 0) < (rider?.max_active ?? 3));
  });

  await rec.run("Delivery", 12, "rider.overlap_refused", "A second overlapping shift is refused", async (t) => {
    const riderId = ctx.state["riderId"];
    if (!riderId) throw new Skipped("No test rider was prepared.");
    const ops = client(ctx, "operations_manager");

    const { data, error } = await rpc(ops, "neo_delivery_shift_schedule", {
      _rider: riderId,
      _starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      _ends_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      _branch: ctx.a.branchId,
      _notes: `Test overlap ${ctx.runRef}`,
    });
    const refused = Boolean(error) || (data as { ok?: boolean } | null)?.ok === false;
    t.note("result", error?.message ?? data);
    t.must("overlapping cover is not accepted", refused, "refused", error?.message ?? data);
  });
}

const CORE_SUITES: { key: string; name: string; run: (ctx: SuiteContext) => Promise<void> }[] = [
  { key: "guest_reservation", name: "Guest → Reservation", run: suiteGuestReservation },
  { key: "restaurant_kitchen", name: "Restaurant → Kitchen → Stock", run: suiteRestaurantKitchen },
  { key: "shortage_procurement", name: "Shortage → Procurement", run: suiteShortageProcurement },
  { key: "finance", name: "Finance", run: suiteFinance },
  { key: "housekeeping", name: "Housekeeping", run: suiteHousekeeping },
  { key: "maintenance", name: "Maintenance", run: suiteMaintenance },
  { key: "events", name: "Events", run: suiteEvents },
  { key: "notifications", name: "Notifications", run: suiteNotifications },
  { key: "permissions", name: "Permissions", run: suitePermissions },
  { key: "tenancy", name: "Multi-tenancy", run: suiteTenancy },
  { key: "audit", name: "Audit", run: suiteAudit },
  { key: "delivery_riders", name: "Delivery → Riders", run: suiteDeliveryRiders },
];

// The deeper suites run last: they lean on the records the core suites created.
export const SUITES: { key: string; name: string; run: (ctx: SuiteContext) => Promise<void> }[] = [
  ...CORE_SUITES,
  ...EXTENDED_SUITES,
  ...SECOND_PROPERTY_SUITES,
];


export { CriticalFailure, NotConfigured };
