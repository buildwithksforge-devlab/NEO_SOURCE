import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2] || '.output/public';
const sentinel = process.env.NEO_SECRET_LEAK_SENTINEL || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!sentinel) {
  console.error('Set NEO_SECRET_LEAK_SENTINEL or SUPABASE_SERVICE_ROLE_KEY to a non-production sentinel before running this check.');
  process.exit(2);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

try {
  const files = await walk(root);
  const hits = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > 20 * 1024 * 1024) continue;
    const buf = await readFile(file);
    if (buf.includes(Buffer.from(sentinel))) hits.push(file);
  }

  if (hits.length) {
    console.error('CLIENT SECRET LEAK DETECTED. Sentinel found in public build output:');
    for (const hit of hits) console.error(`- ${hit}`);
    process.exit(1);
  }

  console.log(`Client secret boundary PASS: sentinel not found in ${files.length} public build files.`);
} catch (error) {
  console.error(`Unable to scan ${root}:`, error?.message || error);
  process.exit(1);
}
