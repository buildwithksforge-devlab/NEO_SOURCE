import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync("supabase/migrations/20261115020000_supplier_matching_quantity_parity.sql", "utf8").replaceAll("\r\n", "\n");
const original = source.match(/CREATE OR REPLACE FUNCTION public\.neo_supplier_invoice_accept\([\s\S]*?\$function\$\s*;/)?.[0];
if (!original) throw new Error("Reviewed supplier acceptance source missing");
const replace = (sql, from, to) => {
  if (sql.split(from).length !== 2) throw new Error(`Missing/ambiguous payable repair boundary: ${from}`);
  return sql.replace(from,to);
};
let repaired = replace(original,"IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN", "IF NOT coalesce(has_permission('finance','approve') OR is_org_admin(),false) THEN");
repaired = replace(repaired,"  IF inv.journal_id IS NOT NULL THEN\n    RETURN", `  IF inv.status IS NULL OR inv.status IN ('cancelled','canceled','void','voided','rejected','reversed') THEN
    RAISE EXCEPTION 'Supplier invoice cannot be accepted from status %',coalesce(inv.status,'missing');
  END IF;
  IF inv.journal_id IS NOT NULL THEN
    RETURN`);
const validJournal = (reference) => `SELECT 1 FROM public.journal_entries j
      WHERE j.id=${reference} AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id
        AND j.status='posted' AND j.reversed_by_journal_id IS NULL
        AND j.source_document_type='supplier_invoice:payable' AND j.source_document_id=_invoice
        AND j.currency=public.neo_fact_currency(v_org,inv.branch_id)
        AND (inv.invoice_date IS NULL OR j.accounting_date=inv.invoice_date)
        AND j.total_debit=round(inv.amount,2) AND j.total_credit=round(inv.amount,2)
        AND (SELECT sum(journal_line.debit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND (SELECT sum(journal_line.credit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines journal_line LEFT JOIN public.chart_of_accounts a ON a.id=journal_line.account_id
          WHERE journal_line.journal_id=j.id AND (journal_line.organization_id IS DISTINCT FROM v_org OR a.organization_id IS DISTINCT FROM v_org
            OR journal_line.branch_id IS DISTINCT FROM inv.branch_id OR journal_line.debit IS NULL OR journal_line.credit IS NULL OR journal_line.debit<0 OR journal_line.credit<0
            OR journal_line.debit::text IN ('NaN','Infinity','-Infinity') OR journal_line.credit::text IN ('NaN','Infinity','-Infinity')
            OR (journal_line.debit>0 AND journal_line.credit>0)))`;
repaired = replace(repaired,"SELECT 1 FROM public.journal_entries j WHERE j.id=inv.journal_id AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted'", validJournal("inv.journal_id"));
repaired = replace(repaired,"SELECT 1 FROM public.journal_entries j WHERE j.id=nullif(v_res->>'journal_id','')::uuid AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted'", validJournal("nullif(v_res->>'journal_id','')::uuid"));
const hash = (sql) => createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
writeFileSync("supabase/migrations/20261116235700_supplier_payable_journal_identity.sql", `-- STAGED ONLY: verify future acceptance/replay against the original payable journal.
-- No supplier invoice, journal, purchase quantity or historical amount changed on installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_supplier_invoice_accept(uuid,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(original)}','${hash(repaired)}')) THEN
 RAISE EXCEPTION 'Supplier acceptance differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_supplier_acceptance_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl
 FROM pg_proc WHERE oid='public.neo_supplier_invoice_accept(uuid,text)'::regprocedure;
${repaired}
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_supplier_acceptance_acl old
 WHERE p.oid='public.neo_supplier_invoice_accept(uuid,text)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Supplier acceptance owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded supplier payable identity and invoice-state repair.");
