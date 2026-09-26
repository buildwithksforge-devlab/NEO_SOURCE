-- A. Import tolerates a missing preparation station: the item is committed as a
--    Draft awaiting station mapping instead of being silently dropped.
CREATE OR REPLACE FUNCTION public.pos_import_menu_drafts(_menu uuid, _branch uuid, _file_name text, _file_type text, _checksum text, _rows jsonb, _idempotency_key text, _correlation uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_batch uuid; v_row jsonb; v_category uuid; v_station uuid; v_item uuid;
  v_parsed int:=jsonb_array_length(coalesce(_rows,'[]'::jsonb)); v_valid int:=0; v_committed int:=0; v_duplicates int:=0; v_mapping int:=0; v_rejected int:=0; v_event uuid; v_audit uuid;
BEGIN
  IF NOT public.has_permission('restaurant','menu','create') THEN RAISE EXCEPTION 'Missing permission: restaurant.menu.create'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.menus WHERE id=_menu AND organization_id=v_org AND branch_id=_branch) THEN RAISE EXCEPTION 'Select a canonical menu in your authorized property'; END IF;
  IF NOT public.in_my_config_scope(v_org,_branch) THEN RAISE EXCEPTION 'The selected property is outside your configuration scope'; END IF;
  SELECT id INTO v_batch FROM public.menu_import_batches WHERE organization_id=v_org AND checksum=_checksum AND menu_id=_menu AND status <> 'failed' LIMIT 1;
  IF v_batch IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'batch_id',v_batch,'parsed_rows',(SELECT parsed_rows FROM public.menu_import_batches WHERE id=v_batch),'committed_rows',(SELECT committed_rows FROM public.menu_import_batches WHERE id=v_batch));
  END IF;
  INSERT INTO public.menu_import_batches(organization_id,branch_id,menu_id,file_name,file_type,total_rows,parsed_rows,status,checksum,correlation_id,created_by)
  VALUES(v_org,_branch,_menu,_file_name,_file_type,v_parsed,v_parsed,'processing',_checksum,_correlation,auth.uid()) RETURNING id INTO v_batch;
  FOR v_row IN SELECT value FROM jsonb_array_elements(coalesce(_rows,'[]'::jsonb)) LOOP
    IF nullif(btrim(v_row->>'name'),'') IS NULL OR nullif(btrim(v_row->>'category'),'') IS NULL OR (v_row->>'base_price') IS NULL THEN v_rejected:=v_rejected+1; CONTINUE; END IF;
    v_valid:=v_valid+1;
    SELECT id,station_id INTO v_category,v_station FROM public.menu_categories WHERE organization_id=v_org AND menu_id=_menu AND lower(name)=lower(btrim(v_row->>'category')) LIMIT 1;
    IF v_category IS NULL THEN
      INSERT INTO public.menu_categories(organization_id,menu_id,name) VALUES(v_org,_menu,btrim(v_row->>'category')) RETURNING id,station_id INTO v_category,v_station;
    END IF;
    -- Inherit a preparation station already configured for the same category name.
    IF v_station IS NULL THEN
      SELECT mc.station_id INTO v_station FROM public.menu_categories mc
       WHERE mc.organization_id=v_org AND lower(mc.name)=lower(btrim(v_row->>'category')) AND mc.station_id IS NOT NULL LIMIT 1;
      IF v_station IS NOT NULL THEN UPDATE public.menu_categories SET station_id=v_station WHERE id=v_category AND station_id IS NULL; END IF;
    END IF;
    IF v_station IS NULL THEN v_mapping:=v_mapping+1; END IF;
    SELECT id INTO v_item FROM public.menu_items WHERE organization_id=v_org AND branch_id=_branch AND category_id=v_category AND lower(name)=lower(btrim(v_row->>'name')) LIMIT 1;
    IF v_item IS NOT NULL THEN v_duplicates:=v_duplicates+1; CONTINUE; END IF;
    INSERT INTO public.menu_items(organization_id,branch_id,category_id,station_id,name,description,base_price,currency,availability,publish_status,import_batch_id,created_by,tax_rate,prep_minutes)
    VALUES(v_org,_branch,v_category,v_station,btrim(v_row->>'name'),nullif(v_row->>'description',''),(v_row->>'base_price')::numeric,coalesce(nullif(v_row->>'currency',''),'KES'),coalesce(nullif(v_row->>'availability',''),'available'),'draft',v_batch,auth.uid(),nullif(v_row->>'tax_rate','')::numeric,nullif(v_row->>'prep_minutes','')::integer)
    RETURNING id INTO v_item;
    v_committed:=v_committed+1;
  END LOOP;
  UPDATE public.menu_import_batches SET valid_rows=v_valid,imported_rows=v_committed,committed_rows=v_committed,rejected_rows=v_rejected,duplicate_rows=v_duplicates,mapping_rows=v_mapping,status=CASE WHEN v_committed=0 THEN 'failed' WHEN v_rejected>0 THEN 'partial' ELSE 'completed' END WHERE id=v_batch;
  v_event:=public.emit_domain_event(v_org,_branch,'restaurant.menu.imported','restaurant',v_batch,jsonb_build_object('menu_id',_menu,'parsed',v_parsed,'valid',v_valid,'committed',v_committed,'rejected',v_rejected,'duplicates',v_duplicates,'awaiting_mapping',v_mapping),'menu-import:'||coalesce(nullif(_idempotency_key,''),v_batch::text),NULL);
  v_audit:=public.log_audit_event('menu.import.completed','restaurant',v_batch::text,NULL,jsonb_build_object('file_name',_file_name,'checksum',_checksum,'menu_id',_menu,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping),NULL,'restaurant.menu.create',_branch,NULL,NULL,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',v_committed>0,'partial',(v_rejected+v_mapping)>0,'batch_id',v_batch,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $function$;

-- B. Recover the Mawimbi import without recreating menus, categories or items.
DO $$
DECLARE v_org uuid:='f8cf89cf-3523-4ca4-a1fb-886802b32d19';
        v_branch uuid:='ebec27a4-8842-4342-a1b1-f33caed67090';
        v_menu uuid:='81be2c30-72c0-4bed-8131-a2e82b38dfbd';
        v_keep uuid:='684f84f1-27d9-4d10-8dcd-24494b324f95';
        v_failed uuid:='0d13c24a-4471-4030-9440-342f39d26864';
        v_moved int; v_archived int;
BEGIN
  -- Inherit preparation stations onto the menu-linked categories.
  UPDATE public.menu_categories t
     SET station_id = s.station_id
    FROM (SELECT DISTINCT ON (lower(name)) lower(name) nm, station_id
            FROM public.menu_categories
           WHERE organization_id=v_org AND station_id IS NOT NULL) s
   WHERE t.organization_id=v_org AND t.menu_id=v_menu AND t.station_id IS NULL AND lower(t.name)=s.nm;

  -- Repoint the preserved 77 items onto the canonical menu categories.
  WITH moved AS (
    UPDATE public.menu_items mi
       SET category_id = target.id,
           station_id  = coalesce(mi.station_id, target.station_id),
           branch_id   = coalesce(mi.branch_id, v_branch),
           updated_at  = now()
      FROM public.menu_categories src, public.menu_categories target
     WHERE mi.import_batch_id = v_keep
       AND src.id = mi.category_id
       AND target.organization_id = v_org AND target.menu_id = v_menu
       AND lower(target.name) = lower(src.name)
    RETURNING mi.id)
  SELECT count(*) INTO v_moved FROM moved;

  -- The four superseded duplicate import passes are archived, never deleted.
  WITH arch AS (
    UPDATE public.menu_items SET publish_status='archived', updated_at=now()
     WHERE organization_id=v_org
       AND import_batch_id IS NOT NULL
       AND import_batch_id <> v_keep
       AND publish_status <> 'archived'
    RETURNING id)
  SELECT count(*) INTO v_archived FROM arch;

  UPDATE public.menu_import_batches
     SET status='completed', committed_rows=v_moved, imported_rows=v_moved, valid_rows=77,
         mapping_rows=(SELECT count(*) FROM public.menu_items WHERE import_batch_id=v_keep AND station_id IS NULL),
         updated_at=now()
   WHERE id IN (v_failed, v_keep);

  INSERT INTO public.audit_logs(organization_id,branch_id,user_name,action,module,record_id,new_value,reason,permission_used)
  VALUES (v_org,v_branch,'System integrity repair','menu.import.recovered','restaurant',v_failed::text,
    jsonb_build_object('menu_id',v_menu,'preserved_batch',v_keep,'items_linked',v_moved,'duplicates_archived',v_archived),
    'Mawimbi CSV import recovered onto the existing menu and categories; no menus, categories or item UUIDs were recreated.',
    'restaurant.menu.create');
END $$;

-- C. Room condition may not stay in cleaning without an active task.
CREATE OR REPLACE FUNCTION public.hk_reconcile_room_conditions()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid := public.current_org_id(); v_detected int := 0; v_case uuid; v_evidence jsonb := '[]'::jsonb; r record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  FOR r IN
    SELECT rm.id, rm.room_number, rm.branch_id, rm.housekeeping_status, rm.sellable
      FROM public.rooms rm
     WHERE rm.organization_id = v_org
       AND public.hk_canonical_condition(rm.housekeeping_status) = 'cleaning_in_progress'
       AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j
                        WHERE j.room_id = rm.id AND j.status NOT IN ('completed','cancelled'))
  LOOP
    v_detected := v_detected + 1;
    v_evidence := v_evidence || jsonb_build_object('room_id',r.id,'room_number',r.room_number,'previous_condition',r.housekeeping_status,'restored_condition','dirty');
    UPDATE public.rooms SET housekeeping_status='dirty', sellable=false, updated_at=now() WHERE id=r.id;
    INSERT INTO public.audit_logs(organization_id,branch_id,user_name,action,module,record_id,previous_value,new_value,reason,permission_used)
    VALUES (v_org,r.branch_id,'System integrity repair','housekeeping.room.condition.repaired','housekeeping',r.id::text,
      jsonb_build_object('housekeeping_status',r.housekeeping_status),jsonb_build_object('housekeeping_status','dirty'),
      'Room was cleaning_in_progress with no active cleaning task; restored to the last proven condition.','housekeeping.tasks.manage');
  END LOOP;
  INSERT INTO public.integrity_repair_jobs(organization_id,check_key,idempotency_key,run_window,status,attempts,detected_count,repaired_count,remaining_count,evidence,started_at,finished_at)
  VALUES (v_org,'housekeeping_condition_without_task','hk-condition:'||to_char(now(),'YYYYMMDDHH24MI'),date_trunc('hour',now()),
          CASE WHEN v_detected=0 THEN 'clean' ELSE 'repaired' END,1,v_detected,v_detected,0,
          jsonb_build_object('rooms',v_evidence),now(),now())
  ON CONFLICT DO NOTHING RETURNING id INTO v_case;
  RETURN jsonb_build_object('ok',true,'detected',v_detected,'repaired',v_detected,'repair_case_id',v_case,'evidence',v_evidence);
END $$;
REVOKE EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() TO authenticated;

-- Immediate repair of the observed drift (Room 103).
DO $$
DECLARE v_org uuid:='f8cf89cf-3523-4ca4-a1fb-886802b32d19'; r record; v_detected int:=0; v_evidence jsonb:='[]'::jsonb;
BEGIN
  FOR r IN SELECT rm.id, rm.room_number, rm.branch_id, rm.housekeeping_status FROM public.rooms rm
            WHERE rm.organization_id=v_org
              AND public.hk_canonical_condition(rm.housekeeping_status)='cleaning_in_progress'
              AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.room_id=rm.id AND j.status NOT IN ('completed','cancelled'))
  LOOP
    v_detected := v_detected + 1;
    v_evidence := v_evidence || jsonb_build_object('room_id',r.id,'room_number',r.room_number,'previous_condition',r.housekeeping_status,'restored_condition','dirty');
    UPDATE public.rooms SET housekeeping_status='dirty', sellable=false, updated_at=now() WHERE id=r.id;
    INSERT INTO public.audit_logs(organization_id,branch_id,user_name,action,module,record_id,previous_value,new_value,reason,permission_used)
    VALUES (v_org,r.branch_id,'System integrity repair','housekeeping.room.condition.repaired','housekeeping',r.id::text,
      jsonb_build_object('housekeeping_status',r.housekeeping_status),jsonb_build_object('housekeeping_status','dirty'),
      'Room was cleaning_in_progress with no active cleaning task; restored to the last proven condition.','housekeeping.tasks.manage');
  END LOOP;
  INSERT INTO public.integrity_repair_jobs(organization_id,check_key,idempotency_key,run_window,status,attempts,detected_count,repaired_count,remaining_count,evidence,started_at,finished_at)
  VALUES (v_org,'housekeeping_condition_without_task','hk-condition:room-state-reconciliation-20260822',date_trunc('hour',now()),
          CASE WHEN v_detected=0 THEN 'clean' ELSE 'repaired' END,1,v_detected,v_detected,0,jsonb_build_object('rooms',v_evidence),now(),now());
END $$;