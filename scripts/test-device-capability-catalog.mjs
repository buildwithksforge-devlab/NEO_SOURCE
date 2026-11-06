import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE permissions(id uuid DEFAULT gen_random_uuid(),module text,feature text,action text,label text,UNIQUE(module,feature,action));
    CREATE TABLE role_feature_templates(role_key text,module text,feature text,action text,UNIQUE(role_key,module,feature,action));
    CREATE TABLE role_permissions(role_id text,permission_id text);
    INSERT INTO permissions(module,feature,action,label) VALUES('administration','users','view','Existing permission');
    INSERT INTO role_feature_templates VALUES('accountant','finance','ledger','view');
    INSERT INTO role_permissions VALUES('existing-role','existing-permission');
  `);
  const migration = readFileSync(new URL("../supabase/migrations/20261106090300_device_management_capability.sql",import.meta.url),"utf8").replace(/^\uFEFF/, "");
  await db.exec(migration);
  await db.exec(migration);
  const roles = (await db.query("SELECT role_key FROM role_feature_templates WHERE module='administration' AND feature='devices' AND action='manage' ORDER BY role_key")).rows.map(row => row.role_key);
  assert.deepEqual(roles,["it-system-administrator","owner"]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM permissions WHERE module='administration' AND feature='devices' AND action='manage'")).rows[0].count,1);
  assert.deepEqual((await db.query("SELECT role_id,permission_id FROM role_permissions")).rows,[{role_id:"existing-role",permission_id:"existing-permission"}]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM permissions WHERE module='administration' AND feature='users'")).rows[0].count,1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM role_feature_templates WHERE role_key='accountant'")).rows[0].count,1);
  console.log("PASS device catalogue: only the two approved templates, repeat-safe seed, existing permissions and role assignments preserved.");
} finally { await db.close(); }