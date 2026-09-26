/**
 * NEØ peak-load test.
 *
 * Drives the real Data API as a signed-in staff user, with the ordinary access
 * rules applied, and reports p50/p95/p99 per action class.
 *
 * Reads are the heaviest list screens. The only write exercised is the
 * session's own `last_login_at` stamp — a save the app already performs — so
 * the test never creates or alters operational data.
 *
 * Usage: bun scripts/load-test.ts [concurrency] [iterations]
 */

const SESSION_FILE = process.env["NEO_SESSION_FILE"] ?? "/root/.cache/lovable-auth/session.json";
const URL = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"]!;
const KEY = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_PUBLISHABLE_KEY"]!;

const session = JSON.parse(await Bun.file(SESSION_FILE).text());
const token: string = session.access_token ?? session.session?.access_token;
const userId: string = session.user?.id ?? session.session?.user?.id;
if (!token) throw new Error("No access token in the session file.");

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Prefer: "count=none",
};

type Action = { name: string; kind: "read" | "save"; run: () => Promise<Response> };

const actions: Action[] = [
  {
    name: "menu items list",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/menu_items?select=id,name,availability,category_id,station_id&order=display_order.asc,name.asc&limit=200`,
        { headers },
      ),
  },
  {
    name: "menu categories list",
    kind: "read",
    run: () =>
      fetch(`${URL}/rest/v1/menu_categories?select=id,name,menu_id&order=display_order.asc&limit=200`, {
        headers,
      }),
  },
  {
    name: "stock items with levels",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/stock_items?select=id,name,sku,base_unit,average_cost,active,stock_levels(quantity_on_hand,location_id)&order=name.asc&limit=200`,
        { headers },
      ),
  },
  {
    name: "notifications inbox",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/notifications?select=id,title,category,priority,read_at,created_at&order=created_at.desc&limit=50`,
        { headers },
      ),
  },
  {
    name: "suppliers list",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/suppliers?select=id,name,code,active,payment_terms&order=name.asc&limit=200`,
        { headers },
      ),
  },
  {
    name: "purchase orders list",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/purchase_orders?select=id,order_number,status,total_amount,supplier_id,expected_date&order=created_at.desc&limit=100`,
        { headers },
      ),
  },
  {
    name: "goods receipts list",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/goods_receipts?select=id,grn_number,status,total_value,accrual_journal_id,received_at&order=received_at.desc&limit=100`,
        { headers },
      ),
  },
  {
    name: "stock levels by store",
    kind: "read",
    run: () =>
      fetch(
        `${URL}/rest/v1/stock_levels?select=stock_item_id,location_id,quantity_on_hand,quantity_reserved,updated_at&order=updated_at.desc&limit=300`,
        { headers },
      ),
  },
  {
    name: "session stamp save",
    kind: "save",
    run: () =>
      fetch(`${URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ last_login_at: new Date().toISOString() }),
      }),
  },
];

const concurrency = Number(process.argv[2] ?? 20);
const iterations = Number(process.argv[3] ?? 10);

const samples = new Map<string, number[]>();
const failures = new Map<string, number>();

async function worker(seed: number) {
  for (let i = 0; i < iterations; i += 1) {
    const action = actions[(seed + i) % actions.length]!;
    const started = performance.now();
    try {
      const res = await action.run();
      await res.arrayBuffer();
      const ms = performance.now() - started;
      if (!res.ok) failures.set(action.name, (failures.get(action.name) ?? 0) + 1);
      else (samples.get(action.name) ?? samples.set(action.name, []).get(action.name)!).push(ms);
    } catch {
      failures.set(action.name, (failures.get(action.name) ?? 0) + 1);
    }
  }
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] ?? 0);
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const elapsed = (performance.now() - started) / 1000;

const total = [...samples.values()].reduce((t, v) => t + v.length, 0);
console.log(
  `\nNEØ peak-load test — ${concurrency} concurrent users x ${iterations} actions ` +
    `(${total} completed in ${elapsed.toFixed(1)}s, ${(total / elapsed).toFixed(1)} req/s)\n`,
);
console.log("action                     n     p50     p95     p99     max   failed");
for (const action of actions) {
  const v = samples.get(action.name) ?? [];
  if (v.length === 0 && !failures.has(action.name)) continue;
  console.log(
    action.name.padEnd(24) +
      String(v.length).padStart(6) +
      `${pct(v, 50)}ms`.padStart(8) +
      `${pct(v, 95)}ms`.padStart(8) +
      `${pct(v, 99)}ms`.padStart(8) +
      `${pct(v, 100)}ms`.padStart(8) +
      String(failures.get(action.name) ?? 0).padStart(9),
  );
}
