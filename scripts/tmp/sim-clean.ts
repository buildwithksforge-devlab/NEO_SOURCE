import { supabaseAdmin } from "../../src/integrations/supabase/client.server";
const { data } = await supabaseAdmin.from("organizations").select("id,name").like("name", "NEØ Test Organization%");
for (const o of (data ?? []) as { id: string; name: string }[]) {
  for (const t of ["role_permissions","approval_rules","audit_logs","domain_events","notifications","communication_queue"]) await supabaseAdmin.from(t).delete().eq("organization_id", o.id);
  const { error } = await supabaseAdmin.from("organizations").delete().eq("id", o.id);
  console.log("org", o.name, error?.message ?? "removed");
}
let page = 1;
for (;;) {
  const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
  const list = users?.users ?? [];
  for (const u of list) if ((u.email ?? "").includes("neo-simulation.example.com")) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(u.id);
    console.log("user", u.email, error?.message ?? "removed");
  }
  if (list.length < 200) break;
  page += 1;
}
await supabaseAdmin.from("neo_test_environments").update({ status: "purged", test_org_id: null }).eq("status", "active");
console.log("done");
