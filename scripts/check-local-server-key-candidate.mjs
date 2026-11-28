// Accept an env-file candidate on stdin. Never prints credential values.
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const candidate = parseEnv(readFileSync(0, "utf8"));
const source = readFileSync(".env.local", "utf8");
const current = parseEnv(source);
const key = candidate.SUPABASE_SERVICE_ROLE_KEY ?? "";
let role = null;
try {
  role = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString()).role;
} catch {
  /* opaque or invalid key */
}
const supported =
  key.startsWith("sb_secret_") || (key.startsWith("eyJ") && role === "service_role");
const sameProject = candidate.SUPABASE_URL === current.SUPABASE_URL;
console.log(
  JSON.stringify({
    candidateHasServerKey: Boolean(key),
    supportedServerKeyFormat: supported,
    sameAsCurrent: key === current.SUPABASE_SERVICE_ROLE_KEY,
    sameProject,
  }),
);
if (!supported || !sameProject) process.exit(2);
try {
  const headers = { apikey: key };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(
    new URL("/rest/v1/mpesa_settings?select=organization_id&limit=0", current.SUPABASE_URL),
    {
      headers,
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.text();
  console.log(
    JSON.stringify({ status: response.status, invalidApiKey: /invalid api key/i.test(body) }),
  );
  if (!response.ok) process.exit(3);
  if (process.argv.includes("--install")) {
    // Install only a server-role key already accepted by the target project.
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error("Unsupported key encoding");
    const line = `SUPABASE_SERVICE_ROLE_KEY=${key}`;
    const updated = /^\s*SUPABASE_SERVICE_ROLE_KEY\s*=.*$/m.test(source)
      ? source.replace(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=.*$/m, line)
      : `${source.trimEnd()}\n${line}\n`;
    writeFileSync(".env.local", updated);
    console.log(
      JSON.stringify({
        installed: true,
        destination: ".env.local",
        variable: "SUPABASE_SERVICE_ROLE_KEY",
      }),
    );
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.name, networkCode: error.cause?.code ?? null }));
  process.exitCode = 4;
}
