import { supabaseAdmin } from "../../src/integrations/supabase/client.server";
import { createEnvironment, runFullSystemTest } from "../../src/lib/simulation/runner.server";

const CONTROL = "f056e655-5058-4312-8856-1b529bc3b88a";
const USER = "e1323bea-a6c7-48cf-8ebe-2fb1b0cdb9f6";

const envs = await createEnvironment(supabaseAdmin as never, CONTROL, USER);
console.log("environments", envs.primary.label, envs.secondary.label);
const result = await runFullSystemTest(supabaseAdmin as never, {
  controlOrg: CONTROL, createdBy: USER, primary: envs.primary, secondary: envs.secondary,
});
console.log(JSON.stringify({ runRef: result.runRef, status: result.status, totals: result.totals }, null, 2));
for (const c of result.cases) if (c.status !== "pass") console.log(c.status.toUpperCase(), "|", c.suite, "|", c.name, "|", c.detail);
