// Read-only connectivity check. Never prints API keys, response bodies, or rows.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const env = parseEnv(readFileSync(".env.local", "utf8"));
for (const [label, url, key] of [
  ["browser", env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY],
  ["server", env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY],
]) {
  const headers = { apikey: key };
  if (key && !key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetch(new URL("/rest/v1/organizations?select=id&limit=0", url), {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* only report status */
    }
    console.log(
      JSON.stringify({
        label,
        status: response.status,
        invalidApiKey: /invalid api key/i.test(body),
        errorCode: parsed?.code ?? null,
        rowsReturned: Array.isArray(parsed) ? parsed.length : null,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({ label, error: error.name, networkCode: error.cause?.code ?? null }),
    );
  }
}
