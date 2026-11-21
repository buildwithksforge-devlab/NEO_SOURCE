import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const versions = new Map();
const failures = [];
for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql"))) {
  const version = filename.match(/^(\d+)_/)?.[1];
  if (!version) {
    failures.push(`Missing numeric migration version: ${filename}`);
    continue;
  }
  const existing = versions.get(version);
  if (existing) failures.push(`Duplicate migration version ${version}: ${existing}, ${filename}`);
  else versions.set(version, filename);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Migration version check passed: ${versions.size} unique SQL versions.`);
}
