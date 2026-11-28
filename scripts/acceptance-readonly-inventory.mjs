// Read-only prerequisite discovery. Never prints credentials or staff details.
import { writeFileSync } from 'node:fs';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing server API configuration');
const response = await fetch(`${url}/rest/v1/organizations?select=id,name&limit=100`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
const rows = await response.json();
const evidence = {
  scope: 'Read-only organization discovery; not authenticated acceptance',
  status: response.status,
  organizations: Array.isArray(rows) ? rows.filter(row => /savannah.*crown/i.test(row.name)) : [],
};
writeFileSync('docs/repair/acceptance-readonly-inventory-2026-11-11.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
