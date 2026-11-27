import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync
} from "node:fs";

import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);

const directory = new URL("supabase/migrations/",root);

const files = readdirSync(directory)
  .filter(name =>
    name.endsWith(".sql") &&
    /^20261125(21|22|23)|^20261126/.test(name)
  )
  .sort();

if(files.length!==41){
  throw new Error(`Expected 41 migrations, found ${files.length}`);
}

// Recognize transaction boundaries only outside
// quoted SQL, comments and dollar-quoted bodies.

function normalizeTransactions(source,file){

  let output="";
  let i=0;
  let state="normal";
  let dollar="";
  let blockDepth=0;
  let statementStart=true;
  let removed=0;

  while(i<source.length){

    const ch=source[i];
    const next=source[i+1];

    if(state==="line-comment"){

      output+=ch;
      i++;

      if(ch==="\n") state="normal";

      continue;
    }

    if(state==="block-comment"){

      if(ch==="/" && next==="*"){
        blockDepth++;
        output+="/*";
        i+=2;
        continue;
      }

      if(ch==="*" && next==="/"){
        blockDepth--;
        output+="*/";
        i+=2;

        if(blockDepth===0) state="normal";

        continue;
      }

      output+=ch;
      i++;
      continue;
    }

    if(state==="dollar"){

      if(source.startsWith(dollar,i)){
        output+=dollar;
        i+=dollar.length;
        state="normal";
      }else{
        output+=ch;
        i++;
      }

      continue;
    }

    if(state==="single" || state==="double"){

      const quote=state==="single" ? "'" : '"';

      output+=ch;
      i++;

      if(ch===quote){

        if(source[i]===quote){
          output+=source[i];
          i++;
        }else{
          state="normal";
        }

      }

      continue;
    }

    if(ch==="-" && next==="-"){
      output+="--";
      i+=2;
      state="line-comment";
      continue;
    }

    if(ch==="/" && next==="*"){
      output+="/*";
      i+=2;
      blockDepth=1;
      state="block-comment";
      continue;
    }

    if(/\s/.test(ch)){
      output+=ch;
      i++;
      continue;
    }

    if(statementStart){

      const transaction=source.slice(i).match(
        /^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/i
      );

      if(transaction){

        if(/^(ROLLBACK|START)/i.test(transaction[1])){
          throw new Error(
            `Unexpected transaction control in ${file}`
          );
        }

        output+=`\n-- Integrated wrapper: ${transaction[1]}\n`;

        i+=transaction[0].length;
        removed++;
        continue;
      }

    }

    if(ch==="$"){

      const delimiter=source.slice(i).match(
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/
      );

      if(delimiter){

        dollar=delimiter[0];

        output+=dollar;
        i+=dollar.length;

        state="dollar";
        statementStart=false;
        continue;
      }

    }

    if(ch==="'" || ch==='"'){
      state=ch==="'" ? "single" : "double";
      statementStart=false;
      output+=ch;
      i++;
      continue;
    }

    output+=ch;
    i++;

    statementStart=ch===";";
  }

  if(!["normal","line-comment"].includes(state)){
    throw new Error(`Unclosed SQL lexical boundary: ${file}`);
  }

  return {sql:output.trim(),removed};
}

const entries=[];

for(const file of files){

  const source=readFileSync(
    new URL(file,directory),"utf8"
  ).replaceAll("\r\n","\n");

  const normalized=normalizeTransactions(source,file);

  if(!normalized.sql){
    throw new Error(`Empty migration: ${file}`);
  }

  const hash=createHash("sha256")
    .update(source)
    .digest("hex");

  entries.push({
    file,
    hash,
    removed:normalized.removed,
    sql:normalized.sql
  });

  console.log(JSON.stringify({
    migration:file,
    transactionWrappers:normalized.removed,
    bytes:Buffer.byteLength(normalized.sql)
  }));

}

const sql=`-- NEØ integrated operational and financial rollout
-- Existing managed backend only.
-- Review all source migrations and prerequisites before execution.

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $prerequisites$
BEGIN

  IF to_regclass('public.pos_orders') IS NULL
     OR to_regclass('public.stock_items') IS NULL
     OR to_regclass('public.journal_entries') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.mpesa_transactions') IS NULL
  THEN
    RAISE EXCEPTION 'NEO installed schema prerequisites missing';
  END IF;

  IF to_regprocedure(
    'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Installed M-Pesa settlement contract missing';
  END IF;

END;
$prerequisites$;

${entries.map(entry=>`
-- ==================================================
-- MIGRATION: ${entry.file}
-- SOURCE SHA256: ${entry.hash}
-- ==================================================

${entry.sql}

`).join("\n")}

NOTIFY pgrst,'reload schema';

COMMIT;

SELECT jsonb_build_object(
  'rollout','neo-integrated-20261127',
  'migration_count',${entries.length},
  'payment_evidence',
    to_regclass('public.neo_payment_settlement_evidence')::text,
  'late_receipt_exceptions',
    to_regclass('public.neo_payment_late_receipt_exceptions')::text,
  'overpayment_postings',
    to_regclass('public.neo_payment_overpayment_postings')::text,
  'refund_guard',
    to_regprocedure(
      'public.neo_pos_refund_financial_guard(uuid,boolean)'
    )::text,
  'receipt_execution_guard',
    to_regprocedure(
      'public.neo_mpesa_receipt_execution_guard(uuid)'
    )::text
) AS integrated_rollout_result;
`;

const output=new URL(".output/",root);

mkdirSync(output,{recursive:true});

writeFileSync(
  new URL("NEO_INTEGRATED_ROLLOUT.sql",output),
  sql,
  "utf8"
);

writeFileSync(
  new URL("NEO_INTEGRATED_ROLLOUT_MANIFEST.json",output),
  JSON.stringify(
    entries.map(({file,hash,removed})=>({
      file,hash,removed
    })),
    null,
    2
  ),
  "utf8"
);

console.log("INTEGRATED ROLLOUT PREPARED");
console.log("MIGRATIONS:",entries.length);
console.log("SQL BYTES:",Buffer.byteLength(sql));
console.log("LIVE DATABASE EXECUTION: NONE");