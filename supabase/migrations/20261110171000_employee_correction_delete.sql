BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_hr_delete_incorrect_employee(uuid,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'Employee correction delete is already installed; run the postcheck'; END IF;
END $guard$;
CREATE FUNCTION public.neo_hr_delete_incorrect_employee(_employee uuid,_confirmation text,_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); actor uuid:=auth.uid(); e public.employees; ref record; found_reference boolean; blockers text[]:=ARRAY[]::text[]; removed uuid;
BEGIN
 IF actor IS NULL OR org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.is_org_admin() OR public.has_permission('hr-employees','delete'),false) THEN RAISE EXCEPTION 'Employee deletion requires existing HR delete authority' USING ERRCODE='42501'; END IF;
 IF length(btrim(coalesce(_reason,'')))<3 OR length(btrim(_reason))>500 THEN RAISE EXCEPTION 'Enter a correction reason of 3 to 500 characters'; END IF;
 SELECT * INTO e FROM public.employees WHERE id=_employee AND organization_id=org FOR UPDATE;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Employee not found in this workspace'; END IF;
 IF e.branch_id IS NULL THEN
  IF NOT coalesce(public.is_org_admin() OR public.current_access_scope()='organisation',false) THEN RAISE EXCEPTION 'An organisation-scoped HR administrator must correct this unassigned record' USING ERRCODE='42501'; END IF;
 ELSIF NOT coalesce(public.neo_branch_in_scope(e.branch_id),false) THEN RAISE EXCEPTION 'Employee property is outside your access' USING ERRCODE='42501'; END IF;
 IF btrim(coalesce(_confirmation,'')) IS DISTINCT FROM e.employee_number THEN RAISE EXCEPTION 'Type the exact employee number to confirm deletion'; END IF;
 IF e.profile_id IS NOT NULL THEN RAISE EXCEPTION 'This employee has a linked login. Correct or unlink that account separately before deleting an incorrect employee record.'; END IF;
 -- Read every incoming employee foreign key, plus UUID employee references that lack a real FK.
 FOR ref IN
  WITH foreign_refs AS (
   SELECT c.oid AS relid,c.relname AS table_name,a.attname AS column_name,true AS enforced
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL unnest(k.conkey,k.confkey) AS cols(child,parent)
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=cols.child
   JOIN pg_attribute p ON p.attrelid=k.confrelid AND p.attnum=cols.parent
   WHERE k.contype='f' AND k.confrelid='public.employees'::regclass AND p.attname='id' AND n.nspname='public'
  ), loose_refs AS (
   SELECT c.oid AS relid,c.relname AS table_name,a.attname AS column_name,false AS enforced
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='uuid'::regtype
    AND (a.attname='employee_id' OR a.attname LIKE '%\_employee_id' ESCAPE '\')
  ) SELECT relid,table_name,column_name,bool_or(enforced) AS enforced FROM (SELECT * FROM foreign_refs UNION ALL SELECT * FROM loose_refs) all_refs GROUP BY relid,table_name,column_name ORDER BY table_name,column_name
 LOOP
  IF ref.table_name IN ('employee_identifiers','employee_emergency_contacts','employee_payment_details','employee_compensation','employee_branch_assignments') AND ref.column_name='employee_id' AND ref.enforced THEN
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE employee_id=$1 AND organization_id IS DISTINCT FROM $2)',ref.table_name) INTO found_reference USING e.id,org;
   IF found_reference THEN blockers:=array_append(blockers,ref.table_name); END IF;
   CONTINUE;
  END IF;
  IF ref.table_name='leave_balances' AND ref.column_name='employee_id' AND ref.enforced THEN
   SELECT EXISTS(SELECT 1 FROM public.leave_balances b WHERE b.employee_id=e.id AND (b.organization_id IS DISTINCT FROM org OR coalesce(b.taken_days,0)<>0 OR coalesce(b.pending_days,0)<>0 OR coalesce(b.adjustment_days,0)<>0 OR coalesce(b.carried_forward_days,0)<>0 OR coalesce(b.expired_days,0)<>0)) INTO found_reference;
   IF found_reference THEN blockers:=array_append(blockers,ref.table_name); END IF;
   CONTINUE;
  END IF;
  -- Loose legacy references need a table lock so another writer cannot add history after this check.
  IF NOT ref.enforced THEN EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',ref.table_name); END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I=$1)',ref.table_name,ref.column_name) INTO found_reference USING e.id;
  IF found_reference THEN blockers:=array_append(blockers,ref.table_name); END IF;
 END LOOP;
 IF cardinality(blockers)>0 THEN RAISE EXCEPTION 'Deletion stopped: linked history or assignments exist in %. Keep this record and correct its details or use the existing exit process.',array_to_string(blockers,', '); END IF;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
 VALUES(org,e.branch_id,actor,'','hr.employee.incorrect_record_deleted','human-resources',e.id::text,jsonb_build_object('employee_number',e.employee_number),jsonb_build_object('deleted',true,'linked_login_deleted',false),btrim(_reason));
 DELETE FROM public.employees WHERE id=e.id AND organization_id=org RETURNING id INTO removed;
 IF removed IS NULL THEN RAISE EXCEPTION 'Employee deletion was not confirmed'; END IF;
 RETURN jsonb_build_object('ok',true,'deleted',true,'employee_id',removed,'employee_number',e.employee_number,'linked_login_deleted',false);
END $function$;
REVOKE ALL ON FUNCTION public.neo_hr_delete_incorrect_employee(uuid,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.neo_hr_delete_incorrect_employee(uuid,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';
SELECT jsonb_build_object('diagnostic_version','employee-correction-delete-install-v1','definition_matches',md5(pg_get_functiondef(to_regprocedure('public.neo_hr_delete_incorrect_employee(uuid,text,text)')))='12d9c1688b6b667dcc470e04125358ab','scope','Installs a scoped correction-delete command only. No employee is deleted by installation. Linked logins, payroll, attendance and other history block deletion; minimal deletion audit is retained.') AS result;
COMMIT;
