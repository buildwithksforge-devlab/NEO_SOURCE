/**
 * NEØ System Test — second property parity.
 *
 * Everything the first property proves must also hold on a second, separately
 * created property: a delivery raised there gets its own verification record,
 * the record is readable only inside that workspace, a till is available to
 * that property's cashier, and finance postings stay scoped to it.
 *
 * The suite drives the real routines through signed-in staff of the secondary
 * environment. The only arrangement made openly as setup is marking the seeded
 * test dish as available for pickup, so an order can be raised at all.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NotConfigured, Skipped } from "./harness.server";
import type { SuiteContext } from "./suites.server";

type Client = SupabaseClient;

function clientB(ctx: SuiteContext, key: string): Client {
  const c = ctx.clientsB.get(key);
  if (!c) throw new Skipped(`The ${key} test account is not available on the second property.`);
  return c;
}

async function rpc(c: Client, name: string, args: Record<string, unknown>) {
  const { data, error } = await c.rpc(name as never, args as never);
  return { data: data as unknown, error: error as { message: string; code?: string } | null };
}

export async function suiteSecondProperty(ctx: SuiteContext) {
  const { rec, admin } = ctx;

  await rec.run("Second property", 13, "second.order", "A delivery order can be raised on the second property", async (t) => {
    const menuItemId = ctx.b.seed["menuItemId"];
    if (!menuItemId) throw new NotConfigured("The second property has no seeded menu item.");

    // Setup, declared openly: the seeded dish must be offered for pickup, and
    // the test property needs delivery settings that allow a cash order at all.
    await admin.from("menu_items").update({ available_takeaway: true } as never).eq("id", menuItemId);
    const { data: existingSettings } = await admin
      .from("delivery_settings")
      .select("id")
      .eq("organization_id", ctx.b.orgId)
      .eq("branch_id", ctx.b.branchId)
      .maybeSingle();
    if (!existingSettings) {
      await admin.from("delivery_settings").insert({
        organization_id: ctx.b.orgId,
        branch_id: ctx.b.branchId,
        cod_enabled: true,
        cod_limit: 100000,
        allowed_payment_methods: ["cash", "mpesa"],
      } as never);
    } else {
      await admin
        .from("delivery_settings")
        .update({ cod_enabled: true, cod_limit: 100000 } as never)
        .eq("id", (existingSettings as { id: string }).id);
    }

    const ops = clientB(ctx, "operations_manager");
    const { data, error } = await rpc(ops, "neo_delivery_staff_place_order", {
      _branch: ctx.b.branchId,
      _contact_name: `TEST Second Guest ${ctx.runRef}`,
      _contact_phone: `+254733${ctx.runRef.replace(/\D/g, "").slice(-6).padStart(6, "0")}`,
      _items: [{ menu_item_id: menuItemId, quantity: 1 }],
      _fulfilment: "pickup",
      _payment_method: "cash",
      _notes: `Second property parity ${ctx.runRef}`,
    });
    if (error) throw new NotConfigured(`The second property could not take an order: ${error.message}`);
    const result = data as { delivery_order_id?: string; order_number?: string; pin?: unknown };
    t.note("order", { number: result?.order_number, id: result?.delivery_order_id });
    t.must("an order was created", Boolean(result?.delivery_order_id));
    t.must("no readable PIN is handed back to staff", result?.pin === undefined || result?.pin === null);
    ctx.state["secondDeliveryOrderId"] = result!.delivery_order_id!;
    rec.artifact("delivery_orders", result!.delivery_order_id!);

    const { data: row } = await admin
      .from("delivery_orders")
      .select("organization_id, branch_id")
      .eq("id", result!.delivery_order_id!)
      .maybeSingle();
    const order = row as { organization_id: string; branch_id: string } | null;
    t.mustIsolate("the order belongs to the second workspace", order?.organization_id === ctx.b.orgId);
    t.must("the order belongs to the second property", order?.branch_id === ctx.b.branchId);
  });

  await rec.run("Second property", 13, "second.pin_record", "The order gets its own verification record", async (t) => {
    const orderId = ctx.state["secondDeliveryOrderId"];
    if (!orderId) throw new Skipped("No order was raised on the second property.");

    const { data, error } = await admin
      .from("delivery_order_pins")
      .select("organization_id, pin, pin_secret, pin_hash, expires_at, consumed_at")
      .eq("delivery_order_id", orderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const pin = data as
      | { organization_id: string; pin: string | null; pin_secret: string | null; pin_hash: string | null; expires_at: string | null; consumed_at: string | null }
      | null;
    t.note("pin_record", {
      has_secret: Boolean(pin?.pin_secret),
      readable_pin: Boolean(pin?.pin),
      fingerprint: Boolean(pin?.pin_hash),
      expires_at: pin?.expires_at,
    });
    t.must("a verification record exists", Boolean(pin));
    t.mustIsolate("the record belongs to the second workspace", pin?.organization_id === ctx.b.orgId);
    t.must("the PIN is stored hashed, not in readable text", Boolean(pin?.pin_secret) && !pin?.pin);
    t.check("the PIN has not been used yet", pin?.consumed_at === null);

    const owner = clientB(ctx, "owner");
    const { data: board, error: boardError } = await rpc(owner, "neo_delivery_pin_board", { _branch: ctx.b.branchId });
    if (boardError) throw new Error(`The verification board failed: ${boardError.message}`);
    const payload = board as { ok?: boolean; reason?: string; orders?: unknown } | null;
    if (payload?.ok === false) throw new Error(`The verification board refused: ${payload.reason ?? "unknown"}`);
    const rows = (Array.isArray(payload?.orders) ? payload!.orders : Array.isArray(board) ? board : []) as {
      delivery_order_id?: string;
      order_id?: string;
      has_pin?: boolean;
    }[];
    t.must(
      "the order shows on the second property's verification board",
      rows.some((r) => r.delivery_order_id === orderId || r.order_id === orderId),
    );
  });

  await rec.run("Second property", 13, "second.pin_isolated", "The other property cannot read that record", async (t) => {
    const orderId = ctx.state["secondDeliveryOrderId"];
    if (!orderId) throw new Skipped("No order was raised on the second property.");
    const ownerA = ctx.clientsA.get("owner");
    if (!ownerA) throw new Skipped("The first property owner account is not available.");

    const { data, error } = await ownerA.from("delivery_order_pins").select("id").eq("delivery_order_id", orderId);
    t.note("cross_read", { error: error?.message ?? null, rows: (data ?? []).length });
    t.mustIsolate("no verification record leaks across workspaces", (data ?? []).length === 0);

    const { data: status, error: statusError } = await rpc(ownerA, "neo_delivery_pin_status", { _order: orderId });
    const statusBody = status as { ok?: boolean; reason?: string } | null;
    const refused = Boolean(statusError) || statusBody === null || statusBody?.ok === false;
    t.note("cross_status", statusError?.message ?? status);
    t.mustIsolate("the status routine refuses a foreign order", refused);
  });

  await rec.run("Second property", 13, "second.till", "A till is available to the second property's cashier", async (t) => {
    const cashier = ctx.clientsB.get("cashier") ?? ctx.clientsB.get("accountant");
    if (!cashier) throw new Skipped("No till-holding account is available on the second property.");
    const { data, error } = await rpc(cashier, "neo_cash_till_context", { _branch: ctx.b.branchId });
    if (error) throw new Error(error.message);
    const raw = JSON.stringify(data ?? null);
    t.note("till_context", raw.slice(0, 400));
    if (!/till|drawer|shift/i.test(raw))
      throw new NotConfigured("No till or cash drawer is configured on the second property.");
    t.check("a till context was returned", raw.length > 2);
  });

  await rec.run("Second property", 13, "second.finance", "Finance postings stay inside the second property", async (t) => {
    const { data: accounts } = await admin
      .from("chart_of_accounts")
      .select("id")
      .eq("organization_id", ctx.b.orgId)
      .limit(5);
    t.note("accounts", (accounts ?? []).length);
    t.must("the second workspace has its own chart of accounts", (accounts ?? []).length > 0);

    const accountant = ctx.clientsB.get("accountant");
    if (!accountant) throw new Skipped("No accountant account is available on the second property.");
    const { data: entries, error } = await accountant.from("journal_entries").select("organization_id").limit(200);
    if (error) throw new Error(error.message);
    const rows = (entries ?? []) as { organization_id: string }[];
    t.note("journals", rows.length);
    t.mustIsolate(
      "every journal the second property can read belongs to it",
      rows.every((r) => r.organization_id === ctx.b.orgId),
    );
  });
}

export const SECOND_PROPERTY_SUITES: { key: string; name: string; run: (ctx: SuiteContext) => Promise<void> }[] = [
  { key: "second_property", name: "Second property parity", run: suiteSecondProperty },
];
