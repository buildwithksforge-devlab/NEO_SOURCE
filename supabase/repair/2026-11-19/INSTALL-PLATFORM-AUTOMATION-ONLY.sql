-- Atomic shared rollout. Preserves reviewed source guards and existing grants.
-- No historical balances, stock, payments or folio charges are changed.
BEGIN;
-- Source: supabase/migrations/20261119160000_automatic_platform_checks.sql

-- Evidence uses the existing Quality registers, not a separate dashboard.
ALTER TABLE public.test_runs ADD COLUMN IF NOT EXISTS automation_key text;
ALTER TABLE public.defects ADD COLUMN IF NOT EXISTS automation_key text;
CREATE UNIQUE INDEX IF NOT EXISTS test_runs_automation_key ON public.test_runs(organization_id,automation_key) WHERE automation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS defects_automation_key ON public.defects(organization_id,automation_key) WHERE automation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_platform_check_result(_run uuid,_org uuid,_branch uuid,_key text,_label text,_status text,_detail text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE k text:='integrity:'||coalesce(_branch::text,'organisation')||':'||_key;
BEGIN
 INSERT INTO public.test_case_results(organization_id,run_id,status,actual_result,evidence_reference,tested_at)
 VALUES(_org,_run,_status,_detail,'auto-check:'||k,now());
 IF _status IN ('failed','blocked') THEN
  INSERT INTO public.defects(organization_id,branch_id,reference,environment,module,summary,actual_result,severity,status,release_blocking,evidence_reference,automation_key)
  VALUES(_org,_branch,'AUTO-'||substr(md5(_org::text||k),1,12),'production','platform',_label,_detail,
    CASE WHEN _status='failed' THEN 'high' ELSE 'medium' END,'new',_status='failed',_run::text,k)
  ON CONFLICT(organization_id,automation_key) WHERE automation_key IS NOT NULL DO UPDATE
   SET actual_result=EXCLUDED.actual_result,evidence_reference=EXCLUDED.evidence_reference,updated_at=now(),
    retest_status='failed',resolved_at=NULL,
    status=CASE WHEN defects.status IN ('closed','fixed','retesting') THEN 'new' ELSE defects.status END;
 ELSE
  -- A passed automated retest is evidence for review; it never erases history
  -- or silently closes a manually triaged defect.
  UPDATE public.defects SET retest_status='passed',evidence_reference=_run::text,updated_at=now()
   WHERE organization_id=_org AND automation_key=k;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.neo_platform_check_result(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_platform_checks_internal(_org uuid,_branch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE rid uuid; last_run public.test_runs; c record; n bigint; result_status text; detail text; ok_count int:=0; bad_count int:=0; blocked_count int:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=_org) THEN
  RAISE EXCEPTION 'Property does not belong to organisation' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('platform-check:'||_org::text||':'||_branch::text,0));
 SELECT * INTO last_run FROM public.test_runs WHERE organization_id=_org
  AND evidence_reference='auto-checks:'||_branch::text AND finished_at>now()-interval '15 minutes'
  ORDER BY finished_at DESC LIMIT 1;
 IF last_run.id IS NOT NULL THEN RETURN jsonb_build_object('run_id',last_run.id,'status',last_run.status,'passed',last_run.passed,'failed',last_run.failed,'blocked',last_run.blocked,'cached',true,'finished_at',last_run.finished_at); END IF;
 INSERT INTO public.test_runs(organization_id,environment,status,evidence_reference,notes,started_at)
 VALUES(_org,'production','running','auto-checks:'||_branch::text,
  'Automated saved-data integrity checks. No stock, payment, email or configuration mutations. This is not complete workflow or provider certification.',now()) RETURNING id INTO rid;
 FOR c IN SELECT * FROM (VALUES
  ('receiving_grn','Posted receiving count has no matching saved GRN',
   'SELECT count(*) FROM public.neo_blind_receiving_counts c WHERE c.organization_id=$1 AND c.branch_id=$2 AND c.status=''posted'' AND NOT EXISTS(SELECT 1 FROM public.goods_receipts g WHERE g.id=c.posted_grn_id AND g.organization_id=c.organization_id AND g.branch_id=c.branch_id AND g.order_id=c.purchase_order_id)'),
  ('grn_purchase','GRN purchase ownership or property link is invalid',
   'SELECT count(*) FROM public.goods_receipts g WHERE g.organization_id=$1 AND g.branch_id=$2 AND (g.order_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.purchase_orders p WHERE p.id=g.order_id AND p.organization_id=g.organization_id AND p.branch_id=g.branch_id))'),
  ('menu_stock','Direct-stock menu refers to missing or foreign stock',
   'SELECT count(*) FROM public.menu_items m WHERE m.organization_id=$1 AND m.branch_id=$2 AND m.consumption_mode=''direct_stock'' AND NOT EXISTS(SELECT 1 FROM public.stock_items s WHERE s.id=m.stock_item_id AND s.organization_id=m.organization_id AND (s.branch_id IS NULL OR s.branch_id=m.branch_id))'),
  ('station_store','Consuming station has no valid departmental store',
   'SELECT count(*) FROM public.operational_stations s WHERE s.organization_id=$1 AND s.branch_id=$2 AND s.active AND EXISTS(SELECT 1 FROM public.menu_items m WHERE m.station_id=s.id AND m.organization_id=$1 AND m.consumption_mode IN (''recipe'',''direct_stock'',''batch'')) AND NOT EXISTS(SELECT 1 FROM public.station_consumption_stores x JOIN public.stock_locations l ON l.id=x.location_id WHERE x.station_id=s.id AND x.organization_id=$1 AND x.branch_id=$2 AND l.organization_id=$1 AND l.branch_id=$2 AND l.active AND NOT l.is_main AND l.location_type<>''minibar'')')
 ) AS checks(key,label,sql_text) LOOP
  BEGIN
   EXECUTE c.sql_text INTO n USING _org,_branch;
   result_status:=CASE WHEN n=0 THEN 'passed' ELSE 'failed' END;
   detail:=jsonb_build_object('check',c.key,'branch_id',_branch,'problem_count',n,'checked_at',now())::text;
  EXCEPTION WHEN OTHERS THEN
   result_status:='blocked'; detail:=jsonb_build_object('check',c.key,'branch_id',_branch,'error_code',SQLSTATE,'error',SQLERRM)::text;
  END;
  PERFORM public.neo_platform_check_result(rid,_org,_branch,c.key,c.label,result_status,detail);
  IF result_status='passed' THEN ok_count:=ok_count+1; ELSIF result_status='failed' THEN bad_count:=bad_count+1; ELSE blocked_count:=blocked_count+1; END IF;
 END LOOP;
 UPDATE public.test_runs SET status=CASE WHEN bad_count>0 THEN 'failed' WHEN blocked_count>0 THEN 'blocked' ELSE 'passed' END,
  passed=ok_count,failed=bad_count,blocked=blocked_count,finished_at=now() WHERE id=rid;
 RETURN jsonb_build_object('run_id',rid,'passed',ok_count,'failed',bad_count,'blocked',blocked_count,'finished_at',now(),'cached',false);
END $$;
REVOKE ALL ON FUNCTION public.neo_platform_checks_internal(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_platform_run_checks(_branch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id();
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR (public.is_org_admin() OR public.has_permission('platform','readiness','view') OR public.has_permission('platform','quality','view')) IS NOT TRUE
 OR public.neo_branch_in_scope(_branch) IS NOT TRUE THEN
  RAISE EXCEPTION 'Not permitted to run checks for this property' USING ERRCODE='42501';
 END IF;
 RETURN public.neo_platform_checks_internal(org,_branch);
END $$;
REVOKE ALL ON FUNCTION public.neo_platform_run_checks(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_platform_run_checks(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_platform_checks_scheduled()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b record; checked int:=0;
BEGIN
 FOR b IN SELECT id,organization_id FROM public.branches WHERE coalesce(active,true) ORDER BY organization_id,id LOOP
  PERFORM public.neo_platform_checks_internal(b.organization_id,b.id); checked:=checked+1;
 END LOOP;
 RETURN checked;
END $$;
REVOKE ALL ON FUNCTION public.neo_platform_checks_scheduled() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.neo_platform_checks_scheduled() TO service_role;

-- Simulation cases automatically enter the same Quality register and defect log.
CREATE OR REPLACE FUNCTION public.neo_simulation_quality_bridge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE rid uuid; k text:='simulation:'||NEW.suite||':'||NEW.case_key; st text;
BEGIN
 INSERT INTO public.test_runs(organization_id,environment,status,started_at,evidence_reference,automation_key,notes)
 VALUES(NEW.control_org_id,'testing','running',now(),NEW.run_id::text,'simulation:'||NEW.run_id::text,'Automatic projection of saved Simulation Centre results.')
 ON CONFLICT(organization_id,automation_key) WHERE automation_key IS NOT NULL DO UPDATE SET notes=EXCLUDED.notes
 RETURNING id INTO rid;
 st:=CASE WHEN NEW.status='pass' THEN 'passed' WHEN NEW.status IN ('fail','critical') THEN 'failed' ELSE 'blocked' END;
 INSERT INTO public.test_case_results(organization_id,run_id,status,actual_result,evidence_reference,tested_at)
 VALUES(NEW.control_org_id,rid,st,jsonb_build_object('name',NEW.name,'detail',NEW.detail,'assertions',NEW.assertions)::text,NEW.id::text,now());
 UPDATE public.test_runs SET passed=passed+CASE WHEN st='passed' THEN 1 ELSE 0 END,
  failed=failed+CASE WHEN st='failed' THEN 1 ELSE 0 END,blocked=blocked+CASE WHEN st='blocked' THEN 1 ELSE 0 END,
  status='running',finished_at=NULL WHERE id=rid;
 IF st='failed' THEN
  INSERT INTO public.defects(organization_id,reference,environment,module,summary,actual_result,severity,status,release_blocking,evidence_reference,automation_key)
  VALUES(NEW.control_org_id,'SIM-'||substr(md5(NEW.control_org_id::text||k),1,12),'testing',NEW.suite,NEW.name,NEW.detail,
   CASE WHEN NEW.status='critical' THEN 'critical' ELSE 'high' END,'new',true,NEW.id::text,k)
  ON CONFLICT(organization_id,automation_key) WHERE automation_key IS NOT NULL DO UPDATE SET actual_result=EXCLUDED.actual_result,
   evidence_reference=EXCLUDED.evidence_reference,retest_status='failed',updated_at=now(),
   status=CASE WHEN defects.status IN ('closed','fixed','retesting') THEN 'new' ELSE defects.status END;
 ELSIF st='passed' THEN
  UPDATE public.defects SET retest_status='passed',evidence_reference=NEW.id::text,updated_at=now()
   WHERE organization_id=NEW.control_org_id AND automation_key=k;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_simulation_quality_bridge() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS neo_simulation_quality_bridge ON public.neo_test_results;
CREATE TRIGGER neo_simulation_quality_bridge AFTER INSERT ON public.neo_test_results FOR EACH ROW EXECUTE FUNCTION public.neo_simulation_quality_bridge();

CREATE OR REPLACE FUNCTION public.neo_simulation_quality_finish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE rid uuid;
BEGIN
 IF NEW.finished_at IS NULL THEN RETURN NEW; END IF;
 INSERT INTO public.test_runs(organization_id,environment,status,started_at,finished_at,evidence_reference,automation_key,notes)
 VALUES(NEW.control_org_id,'testing',CASE WHEN NEW.status IN ('failed','critical') THEN 'failed' WHEN NEW.status='passed' THEN 'passed' ELSE 'blocked' END,
  NEW.started_at,NEW.finished_at,NEW.id::text,'simulation:'||NEW.id::text,'Automatic projection of saved Simulation Centre results.')
 ON CONFLICT(organization_id,automation_key) WHERE automation_key IS NOT NULL DO UPDATE SET
  status=EXCLUDED.status,finished_at=EXCLUDED.finished_at
 RETURNING id INTO rid;
 IF NEW.status IN ('failed','critical') AND NOT EXISTS(SELECT 1 FROM public.test_case_results WHERE run_id=rid AND status='failed') THEN
  PERFORM public.neo_platform_check_result(rid,NEW.control_org_id,NULL,'simulation_runner','Simulation did not complete successfully','failed',
   coalesce(to_jsonb(NEW)->>'failure_detail','See the saved simulation run and its case evidence.'));
  UPDATE public.test_runs SET failed=failed+1 WHERE id=rid;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_simulation_quality_finish() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS neo_simulation_quality_finish ON public.neo_test_runs;
CREATE TRIGGER neo_simulation_quality_finish AFTER UPDATE OF status,finished_at ON public.neo_test_runs FOR EACH ROW EXECUTE FUNCTION public.neo_simulation_quality_finish();

-- Do not install extensions or claim a schedule exists when cron is unavailable.
DO $cron$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='neo-platform-integrity-checks') THEN
   PERFORM cron.schedule('neo-platform-integrity-checks','*/30 * * * *','SELECT public.neo_platform_checks_scheduled();');
  END IF;
 END IF;
END $cron$;
NOTIFY pgrst,'reload schema';


COMMIT;

DO $status$ DECLARE scheduled boolean:=false; BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname=''neo-platform-integrity-checks'' AND active)' INTO scheduled;
 END IF;
 PERFORM set_config('neo.platform_scheduler_installed',scheduled::text,false);
END $status$;
SELECT jsonb_build_object(
 'automatic_check_function',to_regprocedure('public.neo_platform_run_checks(uuid)')::text,
 'anonymous_checks',has_function_privilege('anon','public.neo_platform_run_checks(uuid)','EXECUTE'),
 'staff_checks',has_function_privilege('authenticated','public.neo_platform_run_checks(uuid)','EXECUTE'),
 'background_schedule_installed',current_setting('neo.platform_scheduler_installed')::boolean,
 'simulation_defect_bridge',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.neo_test_results'::regclass AND tgname='neo_simulation_quality_bridge' AND tgenabled IN ('O','A')),
 'room_transfer_hash',(SELECT md5(regexp_replace(regexp_replace(prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) FROM pg_proc WHERE oid='public.pos_post_room_charge(uuid,uuid,text)'::regprocedure),
 'room_transfer_definition',pg_get_functiondef('public.pos_post_room_charge(uuid,uuid,text)'::regprocedure)
) AS platform_rollout_result;
