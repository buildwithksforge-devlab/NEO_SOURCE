-- Repair the existing payroll calculation and posting commands. No payroll is posted here.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)') IS NULL OR to_regprocedure('public.neo_fact_currency(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Existing payroll journal/currency dependencies are missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_hr_payroll_compute(uuid)')
   AND (md5(pg_get_functiondef(p.oid))='08d45a5abc8b40a41675eda35a2bdcd1' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='41dc977fa621847f3683480995a86826'))
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_hr_payroll_post(uuid)')
   AND (md5(pg_get_functiondef(p.oid))='aaadf1eebad0f2e43f438003e49aec6a' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='679b84b0bed03dec7d4c682dd155a72b')) THEN
  RAISE EXCEPTION 'Installed payroll commands differ from reviewed code; nothing replaced';
 END IF;
 IF to_regprocedure('public.neo_payroll_posted_record_guard()') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_payroll_posted_record_guard()')
   AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='9b335b68ceb93191d1a6d093d33787c0') THEN
  RAISE EXCEPTION 'Payroll guard name is already used by different code';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_payroll_acl ON COMMIT DROP AS SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN ('public.neo_hr_payroll_compute(uuid)'::regprocedure,'public.neo_hr_payroll_post(uuid)'::regprocedure);

CREATE OR REPLACE FUNCTION public.neo_hr_payroll_compute(_period uuid)
RETURNS TABLE(employee_id uuid,full_name text,branch_id uuid,currency text,pay_frequency text,base_pay numeric,allowances numeric,bonuses numeric,reimbursements numeric,deductions numeric,gross_pay numeric,net_pay numeric,missing_compensation boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE period public.payroll_periods; input record; compensation public.employee_compensation; saved boolean; value numeric;
BEGIN
 IF auth.uid() IS NULL OR public.has_permission('hr-payroll','inputs.view') IS NOT TRUE
   OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN
  RAISE EXCEPTION 'Payroll input read permission required' USING ERRCODE='42501';
 END IF;
 SELECT p.* INTO period FROM public.payroll_periods p WHERE p.id=_period AND p.organization_id=public.current_org_id();
 IF period.id IS NULL THEN RETURN; END IF;
 IF (period.branch_id IS NULL AND public.current_access_scope()<>'organisation' AND public.is_org_admin() IS NOT TRUE)
   OR (period.branch_id IS NOT NULL AND public.neo_branch_in_scope(period.branch_id) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Payroll period is outside your property scope' USING ERRCODE='42501';
 END IF;
 IF period.period_start IS NULL OR period.period_end IS NULL OR period.period_start>period.period_end THEN RAISE EXCEPTION 'Payroll period dates require review'; END IF;
 saved:=period.posted_journal_id IS NOT NULL OR period.posted_at IS NOT NULL OR period.status='exported';
 FOR input IN SELECT r.*,e.full_name employee_name,e.organization_id employee_org,e.branch_id employee_branch
   FROM public.payroll_input_records r LEFT JOIN public.employees e ON e.id=r.employee_id WHERE r.period_id=_period ORDER BY e.full_name,r.id LOOP
  IF input.organization_id IS DISTINCT FROM period.organization_id OR input.employee_org IS DISTINCT FROM period.organization_id
    OR (period.branch_id IS NOT NULL AND coalesce(input.branch_id,period.branch_id,input.employee_branch) IS DISTINCT FROM period.branch_id)
    OR public.neo_branch_in_scope(coalesce(input.branch_id,period.branch_id,input.employee_branch)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Payroll input employee, workspace or property link requires review';
  END IF;
  FOREACH value IN ARRAY ARRAY[input.worked_days,input.worked_hours,input.allowances,input.bonuses,input.commissions,input.reimbursements,input.deductions] LOOP
   IF value<0 OR value::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Payroll inputs require finite nonnegative amounts and worked units'; END IF;
  END LOOP;
  employee_id:=input.employee_id;full_name:=input.employee_name;branch_id:=coalesce(input.branch_id,period.branch_id,input.employee_branch);
  allowances:=round(coalesce(input.allowances,0),2);bonuses:=round(coalesce(input.bonuses,0)+coalesce(input.commissions,0),2);
  reimbursements:=round(coalesce(input.reimbursements,0),2);deductions:=round(coalesce(input.deductions,0),2);
  SELECT c.* INTO compensation FROM public.employee_compensation c WHERE c.organization_id=period.organization_id AND c.employee_id=input.employee_id
   AND c.effective_from<=period.period_end ORDER BY c.effective_from DESC,c.id DESC LIMIT 1;
  pay_frequency:=coalesce(compensation.pay_frequency,'monthly');
  IF saved THEN
   base_pay:=input.base_pay;gross_pay:=input.gross_pay;net_pay:=input.net_pay;currency:=input.currency;missing_compensation:=false;
   IF base_pay IS NULL OR gross_pay IS NULL OR net_pay IS NULL OR base_pay<0 OR gross_pay<0 OR net_pay<0
     OR base_pay::text IN ('NaN','Infinity','-Infinity') OR gross_pay::text IN ('NaN','Infinity','-Infinity') OR net_pay::text IN ('NaN','Infinity','-Infinity')
     OR abs(gross_pay-base_pay-allowances-bonuses)>0.01 OR abs(net_pay-gross_pay-reimbursements+deductions)>0.01 THEN
    RAISE EXCEPTION 'Posted payroll snapshot needs reconciliation; current compensation cannot replace it';
   END IF;
  ELSE
   missing_compensation:=compensation.id IS NULL;
   IF NOT missing_compensation AND (compensation.base_amount IS NULL OR compensation.base_amount<0 OR compensation.base_amount::text IN ('NaN','Infinity','-Infinity')
      OR compensation.pay_frequency IS NULL OR compensation.pay_frequency NOT IN ('monthly','daily','hourly')
      OR (compensation.branch_id IS NOT NULL AND compensation.branch_id IS DISTINCT FROM branch_id)) THEN
    RAISE EXCEPTION 'Employee compensation amount, frequency or property requires review';
   END IF;
   currency:=CASE WHEN missing_compensation THEN public.neo_fact_currency(period.organization_id,branch_id) ELSE compensation.currency END;
   base_pay:=round(coalesce(CASE compensation.pay_frequency WHEN 'monthly' THEN compensation.base_amount
     WHEN 'daily' THEN compensation.base_amount*coalesce(input.worked_days,0)
     WHEN 'hourly' THEN compensation.base_amount*coalesce(input.worked_hours,0) END,0),2);
   gross_pay:=base_pay+allowances+bonuses;net_pay:=gross_pay+reimbursements-deductions;
   IF net_pay<0 THEN RAISE EXCEPTION 'Employee deductions exceed payable earnings; review before posting'; END IF;
  END IF;
  IF currency IS NULL OR currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Payroll currency requires review'; END IF;
  RETURN NEXT;
 END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_hr_payroll_post(_period uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id();period public.payroll_periods;settings public.payroll_posting_settings;
 snapshot jsonb;rows integer;missing integer;base numeric;allowance numeric;bonus numeric;reimbursement numeric;deduction numeric;net numeric;total numeric;
 cur text;lines jsonb:='[]';result jsonb;journal uuid;bucket record;code text;affected integer;
BEGIN
 IF org IS NULL OR auth.uid() IS NULL OR public.has_permission('hr-payroll','approve') IS NOT TRUE THEN RAISE EXCEPTION 'Not authorised to post payroll to the finance books' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO period FROM public.payroll_periods p WHERE p.id=_period AND p.organization_id=org FOR UPDATE;
 IF period.id IS NULL THEN RAISE EXCEPTION 'Payroll period not found in this organisation'; END IF;
 PERFORM 1 FROM public.payroll_input_records r WHERE r.period_id=_period FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) INTO snapshot FROM public.neo_hr_payroll_compute(_period) c;
 SELECT count(*),count(*) FILTER(WHERE c.missing_compensation),coalesce(sum(c.base_pay),0),coalesce(sum(c.allowances),0),coalesce(sum(c.bonuses),0),
   coalesce(sum(c.reimbursements),0),coalesce(sum(c.deductions),0),coalesce(sum(c.net_pay),0),min(c.currency)
 INTO rows,missing,base,allowance,bonus,reimbursement,deduction,net,cur
 FROM jsonb_to_recordset(snapshot) c(base_pay numeric,allowances numeric,bonuses numeric,reimbursements numeric,deductions numeric,net_pay numeric,currency text,missing_compensation boolean);
 IF rows=0 THEN RAISE EXCEPTION 'This period has no payroll input records'; END IF;
 IF missing>0 THEN RAISE EXCEPTION '% employee(s) have no pay record; enter their pay before posting',missing; END IF;
 IF (SELECT count(DISTINCT c->>'currency') FROM jsonb_array_elements(snapshot) c)<>1 THEN RAISE EXCEPTION 'This period mixes currencies; post each currency separately'; END IF;
 total:=base+allowance+bonus+reimbursement;
 IF total<=0 OR total IS DISTINCT FROM deduction+net THEN RAISE EXCEPTION 'Payroll debit and payable amounts do not reconcile'; END IF;
 IF period.posted_journal_id IS NOT NULL THEN
  IF NOT public.neo_connection_journal_matches(period.posted_journal_id,org,period.branch_id,cur,total,'payroll_period:payroll',period.id) THEN
   RAISE EXCEPTION 'Saved payroll journal is not verified posted; reconcile before retrying';
  END IF;
  RETURN jsonb_build_object('ok',true,'journal_id',period.posted_journal_id,'employees',rows,'net',net,'duplicate_prevented',true);
 END IF;
 IF period.posted_at IS NOT NULL OR period.status IS NULL OR period.status NOT IN ('approved','locked') THEN RAISE EXCEPTION 'Approve or lock the payroll period before posting it'; END IF;
 IF cur IS DISTINCT FROM public.neo_fact_currency(org,period.branch_id) THEN RAISE EXCEPTION 'Payroll requires verified conversion to the property currency before posting'; END IF;
 SELECT s.* INTO settings FROM public.payroll_posting_settings s WHERE s.organization_id=org AND (s.branch_id=period.branch_id OR s.branch_id IS NULL)
   ORDER BY s.branch_id IS NULL,s.id LIMIT 1 FOR SHARE;
 IF settings.id IS NULL THEN RAISE EXCEPTION 'Payroll posting accounts are not configured for this property'; END IF;
 IF (SELECT count(*) FROM public.payroll_posting_settings s WHERE s.organization_id=org AND s.branch_id IS NOT DISTINCT FROM settings.branch_id)<>1 THEN RAISE EXCEPTION 'Payroll posting settings are ambiguous for this property'; END IF;
 FOR bucket IN SELECT * FROM (VALUES
   (settings.salary_expense_account_id,base,'Salaries and wages',true),
   (settings.allowance_expense_account_id,allowance,'Allowances',true),
   (settings.bonus_expense_account_id,bonus,'Bonuses and commissions',true),
   (settings.reimbursement_expense_account_id,reimbursement,'Reimbursements',true),
   (settings.deduction_liability_account_id,deduction,'Payroll deductions payable',false),
   (settings.net_pay_liability_account_id,net,'Net pay payable',false)) b(account_id,amount,description,is_debit) LOOP
  IF bucket.amount>0 THEN
   SELECT a.code INTO code FROM public.chart_of_accounts a WHERE a.id=bucket.account_id AND a.organization_id=org AND a.active AND a.postable AND NOT coalesce(a.is_header,false) AND (bucket.is_debit OR a.category='liability') FOR SHARE;
   IF code IS NULL THEN RAISE EXCEPTION 'Choose an active postable account in this workspace for %',bucket.description; END IF;
   lines:=lines||jsonb_build_array(jsonb_build_object('code',code,'debit',CASE WHEN bucket.is_debit THEN bucket.amount ELSE 0 END,'credit',CASE WHEN bucket.is_debit THEN 0 ELSE bucket.amount END,'description',bucket.description));
  END IF;
 END LOOP;
 result:=public.neo_gl_post(org,period.branch_id,'human-resources','payroll_period',period.id,'payroll',period.period_end,cur,'Payroll '||period.name,lines);
 journal:=nullif(result->>'journal_id','')::uuid;
 IF result->>'ok' IS DISTINCT FROM 'true' OR NOT public.neo_connection_journal_matches(journal,org,period.branch_id,cur,total,'payroll_period:payroll',period.id) THEN RAISE EXCEPTION 'Payroll did not produce its verified balanced posted journal'; END IF;
 UPDATE public.payroll_input_records r SET base_pay=c.base_pay,gross_pay=c.gross_pay,net_pay=c.net_pay,currency=c.currency,updated_at=now()
 FROM jsonb_to_recordset(snapshot) c(employee_id uuid,base_pay numeric,gross_pay numeric,net_pay numeric,currency text)
 WHERE r.period_id=period.id AND r.organization_id=org AND r.employee_id=c.employee_id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>rows THEN RAISE EXCEPTION 'Payroll snapshot changed during posting; nothing exported'; END IF;
 UPDATE public.payroll_periods SET posted_journal_id=journal,posted_at=now(),posted_by=auth.uid(),status='exported',updated_at=now() WHERE id=period.id AND organization_id=org;
 PERFORM public.log_audit_event(org,'hr.payroll.posted','human-resources',period.id::text,jsonb_build_object('status',period.status),jsonb_build_object('journal_id',journal,'employees',rows,'gross',base+allowance+bonus,'net',net,'currency',cur),'Payroll posted to the finance books');
 RETURN jsonb_build_object('ok',true,'journal_id',journal,'employees',rows,'net',net,'duplicate_prevented',coalesce((result->>'duplicate_prevented')::boolean,false));
END $function$;

CREATE OR REPLACE FUNCTION public.neo_payroll_posted_record_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE period public.payroll_periods;target uuid;posted boolean;value numeric;
BEGIN
 IF TG_TABLE_NAME='payroll_periods' THEN
  IF TG_OP<>'INSERT' AND (OLD.posted_journal_id IS NOT NULL OR OLD.posted_at IS NOT NULL OR OLD.status='exported') THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted payroll history cannot be deleted'; END IF;
   IF (to_jsonb(NEW)-ARRAY['notes','updated_at','payslips_released_at','payslips_released_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['notes','updated_at','payslips_released_at','payslips_released_by']) THEN RAISE EXCEPTION 'Posted payroll financial history cannot be edited'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='INSERT' AND (NEW.posted_journal_id IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.status='exported') THEN RAISE EXCEPTION 'Post payroll through its guarded command before exporting'; END IF;
  IF TG_OP='UPDATE' AND (NEW.payslips_released_at IS DISTINCT FROM OLD.payslips_released_at OR NEW.payslips_released_by IS DISTINCT FROM OLD.payslips_released_by) THEN
   IF auth.uid() IS NULL OR (public.has_permission('hr-payroll','approve') OR public.is_org_admin()) IS NOT TRUE
     OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical'
     OR (NEW.branch_id IS NULL AND public.current_access_scope()<>'organisation' AND public.is_org_admin() IS NOT TRUE)
     OR (NEW.branch_id IS NOT NULL AND public.neo_branch_in_scope(NEW.branch_id) IS NOT TRUE) THEN RAISE EXCEPTION 'Not authorised to release payslips for this property' USING ERRCODE='42501'; END IF;
   IF NEW.payslips_released_at IS NOT NULL AND OLD.payslips_released_at IS NULL AND NEW.payslips_released_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Payslip release must record the current authorised person'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.posted_journal_id IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.status='exported')
    AND OLD.posted_journal_id IS NULL AND OLD.posted_at IS NULL AND OLD.status IS DISTINCT FROM 'exported' THEN
   IF auth.uid() IS NULL OR public.has_permission('hr-payroll','approve') IS NOT TRUE OR NEW.posted_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Payroll posting must record the current authorised approver'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (((NEW.posted_journal_id IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.status='exported')
     AND OLD.posted_journal_id IS NULL AND OLD.posted_at IS NULL AND OLD.status IS DISTINCT FROM 'exported')
     OR (NEW.payslips_released_at IS NOT NULL AND (NEW.payslips_released_at IS DISTINCT FROM OLD.payslips_released_at OR NEW.payslips_released_by IS DISTINCT FROM OLD.payslips_released_by))) THEN
   IF NEW.status IS DISTINCT FROM 'exported'
     OR NEW.posted_journal_id IS NULL OR NEW.posted_at IS NULL
     OR EXISTS(SELECT 1 FROM public.payroll_input_records r WHERE r.period_id=NEW.id AND
       (r.organization_id IS DISTINCT FROM NEW.organization_id OR r.base_pay IS NULL OR r.gross_pay IS NULL OR r.net_pay IS NULL OR r.currency IS NULL
        OR NOT EXISTS(SELECT 1 FROM public.employees e WHERE e.id=r.employee_id AND e.organization_id=NEW.organization_id)))
     OR NOT EXISTS(SELECT 1 FROM public.journal_entries j
       CROSS JOIN LATERAL(SELECT sum(r.base_pay+round(coalesce(r.allowances,0),2)+round(coalesce(r.bonuses,0)+coalesce(r.commissions,0),2)+round(coalesce(r.reimbursements,0),2)) amount,
          min(r.currency) cur,count(DISTINCT r.currency) currencies,count(*) entries
         FROM public.payroll_input_records r WHERE r.period_id=NEW.id AND r.organization_id=NEW.organization_id) proof
       WHERE j.id=NEW.posted_journal_id AND proof.currencies=1 AND proof.entries>0
         AND public.neo_connection_journal_matches(j.id,NEW.organization_id,NEW.branch_id,proof.cur,proof.amount,'payroll_period:payroll',NEW.id)) THEN
    RAISE EXCEPTION 'Exported payroll requires its saved input snapshot and verified posted journal';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.period_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.period_id END]) x WHERE x IS NOT NULL ORDER BY x LOOP
  BEGIN SELECT p.* INTO period FROM public.payroll_periods p WHERE p.id=target FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'Payroll is being posted; refresh before editing inputs' USING ERRCODE='55P03'; END;
  IF period.id IS NULL THEN
   IF TG_OP='DELETE' THEN CONTINUE; END IF;
   RAISE EXCEPTION 'Payroll input period not found';
  END IF;
  posted:=period.posted_journal_id IS NOT NULL OR period.posted_at IS NOT NULL OR period.status='exported';
  IF posted THEN
   IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Posted payroll input history cannot be inserted or deleted'; END IF;
   IF (to_jsonb(NEW)-ARRAY['notes','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['notes','updated_at']) THEN RAISE EXCEPTION 'Posted payroll input financial history cannot be edited'; END IF;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 SELECT p.* INTO period FROM public.payroll_periods p WHERE p.id=NEW.period_id;
 IF NEW.organization_id IS DISTINCT FROM period.organization_id OR NOT EXISTS(SELECT 1 FROM public.employees e WHERE e.id=NEW.employee_id AND e.organization_id=NEW.organization_id)
   OR (period.branch_id IS NOT NULL AND coalesce(NEW.branch_id,period.branch_id) IS DISTINCT FROM period.branch_id) THEN RAISE EXCEPTION 'Payroll input workspace, employee or property link does not match its period'; END IF;
 IF period.posted_journal_id IS NULL AND period.posted_at IS NULL AND period.status IS DISTINCT FROM 'exported' THEN
  FOREACH value IN ARRAY ARRAY[NEW.worked_days,NEW.worked_hours,NEW.allowances,NEW.bonuses,NEW.commissions,NEW.reimbursements,NEW.deductions] LOOP
   IF value<0 OR value::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Payroll inputs require finite nonnegative amounts and worked units'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_payroll_posted_record_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $owner$ DECLARE trusted text; BEGIN
 SELECT r.rolname INTO trusted FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.neo_hr_payroll_post(uuid)'::regprocedure;
 IF trusted IN ('anon','authenticated') THEN RAISE EXCEPTION 'Payroll command has an untrusted owner'; END IF;
 EXECUTE format('ALTER FUNCTION public.neo_payroll_posted_record_guard() OWNER TO %I',trusted);
END $owner$;
DO $triggers$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll_periods'::regclass AND tgname='neo_payroll_posted_period_guard' AND tgfoid<>'public.neo_payroll_posted_record_guard()'::regprocedure)
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll_input_records'::regclass AND tgname='neo_payroll_posted_input_guard' AND tgfoid<>'public.neo_payroll_posted_record_guard()'::regprocedure) THEN RAISE EXCEPTION 'Payroll guard trigger name already in use'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll_periods'::regclass AND tgname='neo_payroll_posted_period_guard') THEN CREATE TRIGGER neo_payroll_posted_period_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION public.neo_payroll_posted_record_guard(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll_input_records'::regclass AND tgname='neo_payroll_posted_input_guard') THEN CREATE TRIGGER neo_payroll_posted_input_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_input_records FOR EACH ROW EXECUTE FUNCTION public.neo_payroll_posted_record_guard(); END IF;
END $triggers$;
DO $verify$ BEGIN
 IF (SELECT count(*) FROM pg_proc p JOIN neo_payroll_acl s ON s.oid=p.oid AND s.proowner=p.proowner AND s.acl=coalesce(p.proacl::text,''))<>2 THEN RAISE EXCEPTION 'Payroll permissions or owners changed; installation rolled back'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.neo_hr_payroll_compute(uuid)'::regprocedure AND p.prosecdef AND p.provolatile='s' AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='41dc977fa621847f3683480995a86826')
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.neo_hr_payroll_post(uuid)'::regprocedure AND p.prosecdef AND p.provolatile='v' AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='679b84b0bed03dec7d4c682dd155a72b') THEN RAISE EXCEPTION 'Payroll definition verification failed; installation rolled back'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.neo_payroll_posted_record_guard()'::regprocedure AND tgname IN ('neo_payroll_posted_period_guard','neo_payroll_posted_input_guard') AND tgenabled IN ('O','A') AND tgtype=31)<>2 THEN RAISE EXCEPTION 'Payroll history guards are not enabled'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.neo_payroll_posted_record_guard()'::regprocedure AND p.prosecdef
   AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid='public.neo_hr_payroll_post(uuid)'::regprocedure)
   AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='9b335b68ceb93191d1a6d093d33787c0')
   OR has_function_privilege('authenticated','public.neo_payroll_posted_record_guard()','EXECUTE') OR has_function_privilege('anon','public.neo_payroll_posted_record_guard()','EXECUTE') THEN RAISE EXCEPTION 'Payroll history guard verification failed'; END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','payroll-existing-calculation-posting-v1','definitions_match',true,'permissions_unchanged',true,'scope','Repairs existing payroll scope, rounded component arithmetic and verified posting; protects posted snapshots. Installation posts no payroll, changes no salary or history, and preserves existing command permissions.');
COMMIT;
