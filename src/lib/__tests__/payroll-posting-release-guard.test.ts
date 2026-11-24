import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { payrollTotals, type PayrollComputationRow } from "@/lib/hr-payroll";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260924133000_payroll_posting_release_guard.sql", import.meta.url),
  "utf8",
);

describe("payroll payslip release guard", () => {
  it("requires an exported, posted payroll before release", () => {
    expect(sql).toContain("p.status = 'exported'");
    expect(sql).toContain("p.posted_journal_id IS NOT NULL");
    expect(sql).toContain("p.posted_at IS NOT NULL");
    expect(sql).toContain("Post this payroll to Finance before releasing payslips");
  });

  it("preserves employee self-service isolation while hiding premature releases", () => {
    expect(sql).toContain("e.profile_id = auth.uid()");
    expect(sql).toContain("p.payslips_released_at IS NOT NULL");
  });
});

describe("existing payroll arithmetic and posting", () => {
  let db: PGlite;
  const org="ab000000-0000-4000-8000-000000000001", branch="ab000000-0000-4000-8000-000000000002";
  const period="ab000000-0000-4000-8000-000000000003", employee="ab000000-0000-4000-8000-000000000004";
  const other="ab000000-0000-4000-8000-000000000099";
  const migration=readFileSync(new URL("../../../supabase/migrations/20261116080000_payroll_calculation_posting_guards.sql",import.meta.url),"utf8");
  let originalACL: unknown;
  const query=async <T extends Record<string,unknown> = Record<string,unknown>>(s:string,p:unknown[]=[]) => (await db.query<T>(s,p)).rows;
  const compute=()=>query("SELECT * FROM neo_hr_payroll_compute($1)",[period]);
  const post=async()=> (await query("SELECT neo_hr_payroll_post($1) result",[period]))[0]?.["result"] as Record<string,unknown>;
  const deny=async(fn:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("SAVEPOINT denied");await expect(fn()).rejects.toThrow(pattern);await db.exec("ROLLBACK TO SAVEPOINT denied");};
  const acl=()=>query("SELECT oid::regprocedure::text signature,proowner::text owner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid IN ('neo_hr_payroll_compute(uuid)'::regprocedure,'neo_hr_payroll_post(uuid)'::regprocedure) ORDER BY 1");
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT CASE WHEN current_setting('test.auth',true)='false' THEN NULL ELSE '${employee}'::uuid END$$;
CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$SELECT '${org}'::uuid$$;
CREATE FUNCTION current_access_scope() RETURNS text LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.scope',true),''),'branch')$$;
CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$SELECT current_access_scope()='organisation'$$;
CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT current_access_scope()='organisation' OR $1='${branch}'::uuid$$;
CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting(CASE WHEN $2='approve' THEN 'test.approve' ELSE 'test.view' END,true),''),'true')::boolean$$;
CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.currency',true),''),'KES')$$;
CREATE TABLE payroll_periods(id uuid primary key,organization_id uuid,branch_id uuid,name text,period_start date,period_end date,status text,posted_journal_id uuid,posted_at timestamptz,posted_by uuid,payslips_released_at timestamptz,payslips_released_by uuid,notes text,updated_at timestamptz);
CREATE TABLE employees(id uuid primary key,organization_id uuid,branch_id uuid,full_name text);
CREATE TABLE employee_compensation(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,employee_id uuid,effective_from date,pay_frequency text,base_amount numeric,currency text);
CREATE TABLE payroll_input_records(id uuid primary key default gen_random_uuid(),organization_id uuid,period_id uuid,employee_id uuid,branch_id uuid,worked_days numeric,worked_hours numeric,allowances numeric,bonuses numeric,commissions numeric,reimbursements numeric,deductions numeric,base_pay numeric,gross_pay numeric,net_pay numeric,currency text,notes text,updated_at timestamptz,unique(period_id,employee_id));
CREATE TABLE payroll_posting_settings(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,salary_expense_account_id uuid,allowance_expense_account_id uuid,bonus_expense_account_id uuid,reimbursement_expense_account_id uuid,deduction_liability_account_id uuid,net_pay_liability_account_id uuid);
CREATE TABLE chart_of_accounts(id uuid primary key default gen_random_uuid(),organization_id uuid,code text,category text,active boolean default true,postable boolean default true,is_header boolean default false,unique(organization_id,code));
CREATE TABLE journal_entries(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,currency text,status text,total_debit numeric,total_credit numeric,source_document_type text,source_document_id uuid,reversed_by_journal_id uuid);
CREATE TABLE journal_entry_lines(journal_id uuid,organization_id uuid,branch_id uuid,account_id uuid,debit numeric,credit numeric);
CREATE FUNCTION log_audit_event(uuid,text,text,text,jsonb,jsonb,text) RETURNS void LANGUAGE sql AS $$SELECT NULL::void$$;
CREATE FUNCTION neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=$1 AND j.organization_id=$2 AND j.branch_id IS NOT DISTINCT FROM $3 AND j.currency=$4 AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.source_document_type=$6 AND j.source_document_id=$7 AND $5>0 AND $5::text NOT IN ('NaN','Infinity','-Infinity') AND j.total_debit=$5 AND j.total_credit=$5
 AND (SELECT coalesce(sum(debit),0) FROM journal_entry_lines WHERE journal_id=j.id)=$5 AND (SELECT coalesce(sum(credit),0) FROM journal_entry_lines WHERE journal_id=j.id)=$5
 AND NOT EXISTS(SELECT 1 FROM journal_entry_lines l LEFT JOIN chart_of_accounts a ON a.id=l.account_id WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM $2 OR l.branch_id IS DISTINCT FROM $3 OR a.organization_id IS DISTINCT FROM $2 OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0)))$$;
CREATE FUNCTION neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE j uuid;amount numeric;line jsonb;account uuid;mode text:=coalesce(current_setting('test.mode',true),'normal');BEGIN
 IF mode='refused' THEN RETURN jsonb_build_object('ok',false,'reason','blocked');END IF;
 IF mode='throw' THEN RAISE EXCEPTION 'Accounting period is closed';END IF;
 SELECT sum(coalesce((value->>'debit')::numeric,0)) INTO amount FROM jsonb_array_elements($10);
 INSERT INTO journal_entries(organization_id,branch_id,currency,status,total_debit,total_credit,source_document_type,source_document_id) VALUES($1,$2,$8,CASE WHEN mode='draft' THEN 'draft' ELSE 'posted' END,amount,amount,$4||':'||$6,$5) RETURNING id INTO j;
 IF mode<>'missing-lines' THEN FOR line IN SELECT * FROM jsonb_array_elements($10) LOOP SELECT id INTO account FROM chart_of_accounts WHERE organization_id=$1 AND code=line->>'code';INSERT INTO journal_entry_lines VALUES(j,$1,$2,account,coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0));END LOOP;END IF;
 IF mode='change-compensation' THEN UPDATE employee_compensation SET base_amount=base_amount+999;END IF;
 RETURN jsonb_build_object('ok',true,'journal_id',j,'duplicate_prevented',false);END$$;`);
    for(const [file,name] of [["20260914192925_44ccf909-c329-421b-b4cf-118826ae6c9a.sql","neo_hr_payroll_compute"],["20260914193024_945c5c68-5be2-4fac-8c27-92a4cb91a1e9.sql","neo_hr_payroll_post"]]){
      const text=readFileSync(new URL(`../../../supabase/migrations/${file}`,import.meta.url),"utf8").replace(/\r\n/g,"\n");const start=text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);await db.exec(text.slice(start,text.indexOf("$$;",start)+3));
    }
    await db.exec("REVOKE ALL ON FUNCTION neo_hr_payroll_compute(uuid),neo_hr_payroll_post(uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION neo_hr_payroll_compute(uuid),neo_hr_payroll_post(uuid) TO authenticated,service_role;");
    originalACL=await acl();await db.exec(migration);await db.exec(migration.replaceAll("\n","\n  "));
  },30000);
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{
    await db.exec("BEGIN;SELECT set_config('test.scope','branch',true),set_config('test.auth','true',true),set_config('test.view','true',true),set_config('test.approve','true',true),set_config('test.mode','normal',true),set_config('test.currency','KES',true);");
    await query("INSERT INTO payroll_periods(id,organization_id,branch_id,name,period_start,period_end,status) VALUES($1,$2,$3,'September','2026-09-01','2026-09-30','approved')",[period,org,branch]);
    await query("INSERT INTO employees VALUES($1,$2,$3,'Recorded employee')",[employee,org,branch]);
    await query("INSERT INTO employee_compensation(organization_id,branch_id,employee_id,effective_from,pay_frequency,base_amount,currency) VALUES($1,$2,$3,'2026-09-01','monthly',100,'KES')",[org,branch,employee]);
    await query("INSERT INTO payroll_input_records(organization_id,period_id,employee_id,branch_id,worked_days,worked_hours,allowances,bonuses,commissions,reimbursements,deductions) VALUES($1,$2,$3,$4,20,160,10,5,2,3,20)",[org,period,employee,branch]);
    const accounts=[];for(const code of ['5010','5020','5030','5040','2075','2080'])accounts.push((await query("INSERT INTO chart_of_accounts(organization_id,code,category) VALUES($1,$2,$3) RETURNING id",[org,code,code.startsWith('2')?'liability':'operating_expense']))[0]?.["id"]);
    await query("INSERT INTO payroll_posting_settings(organization_id,branch_id,salary_expense_account_id,allowance_expense_account_id,bonus_expense_account_id,reimbursement_expense_account_id,deduction_liability_account_id,net_pay_liability_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[org,branch,...accounts]);
  });
  afterEach(async()=>{await db.exec("ROLLBACK");});
  it("preserves existing owners and execute permissions on repeated installation",async()=>{expect(await acl()).toEqual(originalACL);});
  it("posts rounded components once and keeps the saved snapshot",async()=>{const row=(await compute())[0];expect(Number(row?.["gross_pay"])).toBe(117);expect(Number(row?.["net_pay"])).toBe(100);const first=await post(),repeat=await post();expect(first["ok"]).toBe(true);expect(repeat["duplicate_prevented"]).toBe(true);expect(repeat["journal_id"]).toBe(first["journal_id"]);expect((await query("SELECT count(*) n FROM journal_entries"))[0]?.["n"]).toBe(1);});
  it.each([['daily',2,20,40],['hourly',0.01,0.5,0.01]])("calculates %s pay with component rounding",async(frequency,rate,units,expected)=>{await query("UPDATE employee_compensation SET pay_frequency=$1,base_amount=$2",[frequency,rate]);await query("UPDATE payroll_input_records SET worked_days=$1,worked_hours=$1,deductions=0",[units]);expect(Number((await compute())[0]?.["base_pay"])).toBe(expected);await post();});
  it("preserves posted pay when compensation changes during or after posting",async()=>{await db.exec("SELECT set_config('test.mode','change-compensation',true)");await post();expect(Number((await compute())[0]?.["base_pay"])).toBe(100);await db.exec("UPDATE employee_compensation SET base_amount=2000");expect(Number((await compute())[0]?.["net_pay"])).toBe(100);});
  it.each(['NaN','Infinity','-Infinity',-1])("refuses invalid input %s before saving",async(value)=>{await deny(()=>query("UPDATE payroll_input_records SET allowances=$1",[value]),/finite nonnegative/);});
  it("reports missing compensation without posting zero wages",async()=>{await db.exec("DELETE FROM employee_compensation");expect((await compute())[0]?.["missing_compensation"]).toBe(true);await deny(post,/no pay record/);});
  it("refuses deductions above employee earnings",async()=>{await db.exec("UPDATE payroll_input_records SET deductions=500");await deny(post,/deductions exceed/);});
  it("enforces read and posting capabilities separately",async()=>{await db.exec("SELECT set_config('test.approve','false',true)");expect((await compute()).length).toBe(1);await deny(post,/Not authorised/);await db.exec("SELECT set_config('test.view','false',true)");await deny(compute,/read permission/);});
  it("refuses a payroll period outside property scope",async()=>{await query("UPDATE payroll_periods SET branch_id=$1",[other]);await deny(compute,/property scope/);});
  it("retains legacy inputs whose property comes from their period",async()=>{await db.exec("UPDATE payroll_input_records SET branch_id=NULL");expect((await compute())[0]?.["branch_id"]).toBe(branch);expect((await post())["ok"]).toBe(true);});
  it("restricts organisation-wide payroll to organisation authority",async()=>{await db.exec("UPDATE payroll_periods SET branch_id=NULL;UPDATE payroll_posting_settings SET branch_id=NULL");await deny(compute,/property scope/);await db.exec("SELECT set_config('test.scope','organisation',true)");expect((await post())["ok"]).toBe(true);});
  it("does not leak an employee from another workspace",async()=>{await query("UPDATE employees SET organization_id=$1",[other]);await deny(compute,/workspace or property/);});
  it("cannot substitute a foreign-workspace expense account with a matching code",async()=>{await query("UPDATE chart_of_accounts SET organization_id=$1 WHERE code='5010'",[other]);await deny(post,/active postable account/);expect((await query("SELECT count(*) n FROM journal_entries"))[0]?.["n"]).toBe(0);});
  it("requires an actual liability account for net pay payable",async()=>{await db.exec("UPDATE chart_of_accounts SET category='revenue' WHERE code='2080'");await deny(post,/active postable account/);});
  it("does not post an unapproved or null-status period",async()=>{await db.exec("UPDATE payroll_periods SET status=NULL");await deny(post,/Approve or lock/);});
  it.each(['refused','draft','missing-lines','throw'])("never exports payroll after %s posting",async(mode)=>{await query("SELECT set_config('test.mode',$1,true)",[mode]);await deny(post,/verified balanced|closed/);expect((await query("SELECT status FROM payroll_periods"))[0]?.["status"]).toBe('approved');expect((await query("SELECT count(*) n FROM journal_entries"))[0]?.["n"]).toBe(0);});
  it("does not treat a saved journal identifier as posted evidence",async()=>{await post();await db.exec("DELETE FROM journal_entry_lines");await deny(post,/not verified posted/);});
  it("protects posted inputs and period history while allowing notes and release flags",async()=>{await post();await deny(()=>db.exec("UPDATE payroll_input_records SET allowances=999"),/financial history/);await deny(()=>db.exec("DELETE FROM payroll_input_records"),/history/);await deny(()=>db.exec("UPDATE payroll_periods SET posted_journal_id=NULL,status='approved'"),/financial history/);await deny(()=>db.exec("DELETE FROM payroll_periods"),/history/);await db.exec("UPDATE payroll_input_records SET notes='Reviewed';UPDATE payroll_periods SET payslips_released_at=now(),payslips_released_by=auth.uid()");});
  it("cannot fake an exported period through a direct table update",async()=>{await deny(()=>query("UPDATE payroll_periods SET status='exported',posted_at=now(),posted_by=auth.uid(),posted_journal_id=$1",[other]),/verified posted journal/);});
  it("requires real journal evidence again before releasing payslips",async()=>{await post();await db.exec("DELETE FROM journal_entry_lines");await deny(()=>db.exec("UPDATE payroll_periods SET payslips_released_at=now(),payslips_released_by=auth.uid()"),/verified posted journal/);});
  it("does not grant payroll editors release authority",async()=>{await post();await db.exec("SELECT set_config('test.approve','false',true)");await deny(()=>db.exec("UPDATE payroll_periods SET payslips_released_at=now(),payslips_released_by=auth.uid()"),/Not authorised to release/);});
  it("refuses unconverted payroll currency but accepts a configured property currency",async()=>{await db.exec("UPDATE employee_compensation SET currency='USD'");await deny(post,/verified conversion/);await db.exec("SELECT set_config('test.currency','USD',true)");expect((await post())["ok"]).toBe(true);});
  it("does not combine different employee currencies into one payroll posting",async()=>{await query("INSERT INTO employees VALUES($1,$2,$3,'Second employee')",[other,org,branch]);await query("INSERT INTO employee_compensation(organization_id,branch_id,employee_id,effective_from,pay_frequency,base_amount,currency) VALUES($1,$2,$3,'2026-09-01','monthly',100,'USD')",[org,branch,other]);await query("INSERT INTO payroll_input_records(organization_id,period_id,employee_id,branch_id) VALUES($1,$2,$3,$4)",[org,period,other,branch]);await deny(post,/mixes currencies/);});
  it("refuses non-finite compensation before any journal is created",async()=>{await db.exec("UPDATE employee_compensation SET base_amount='NaN'");await deny(post,/compensation amount/);});
  it("does not prevent deleting unposted inputs and an unused period",async()=>{await db.exec("DELETE FROM payroll_input_records;DELETE FROM payroll_periods");expect((await query("SELECT count(*) n FROM payroll_periods"))[0]?.["n"]).toBe(0);});
  it("refuses unknown installed code without overwriting it",async()=>{await db.exec("CREATE OR REPLACE FUNCTION neo_hr_payroll_post(_period uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN RETURN '{}'::jsonb;END$$;");await expect(db.exec(migration)).rejects.toThrow(/differ from reviewed code/);await db.exec("ROLLBACK");});
});

describe("payroll display totals",()=>{
  const row=(amount:number,currency="KES")=>({employee_id:"ab000000-0000-4000-8000-000000000004",full_name:"Employee",branch_id:null,currency,pay_frequency:"monthly",base_pay:amount,allowances:0,bonuses:0,reimbursements:0,deductions:0,gross_pay:amount,net_pay:amount,missing_compensation:false}) as PayrollComputationRow;
  it("adds currency cents without binary rounding drift",()=>{expect(payrollTotals([row(0.1),row(0.2)]).net).toBe(0.3);});
  it("does not sum different currencies into one labelled total",()=>{expect(()=>payrollTotals([row(100),row(100,"USD")])).toThrow(/mixes KES, USD/);});
  it.each([NaN,Infinity,-1])("refuses an invalid display amount %s",amount=>{expect(()=>payrollTotals([row(amount)])).toThrow(/finite currency cents/);});
});
