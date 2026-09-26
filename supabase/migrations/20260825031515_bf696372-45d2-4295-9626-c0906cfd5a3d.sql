-- ============================================================
-- NEØ — Laundry Department
-- Linen batch lifecycle, attendant isolation, damage reporting
-- ============================================================

-- 1. A linen batch handed over to Laundry (Housekeeping linen, uniforms or a guest order)
CREATE OR REPLACE FUNCTION public.neo_laundry_batch_create(
  _branch uuid,
  _kind text DEFAULT 'linen',
  _items jsonb DEFAULT '[]'::jsonb,
  _source_department uuid DEFAULT NULL,
  _guest_order uuid DEFAULT NULL,
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_batch uuid;
  v_number text;
  v_line jsonb;
  v_count int := 0;
BEGIN
  IF NOT (has_exact_permission('laundry','batches','create')
          OR has_exact_permission('laundry','batches','edit')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to receive linen into Laundry';
  END IF;
  IF _branch IS NULL THEN RAISE EXCEPTION 'Select a property before receiving linen'; END IF;
  IF jsonb_array_length(COALESCE(_items,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Record at least one item on the handover';
  END IF;

  v_number := 'LB-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO laundry_batches (
    organization_id, branch_id, batch_number, source_department_id, batch_kind,
    guest_order_id, status, received_at, notes, created_by
  ) VALUES (
    v_org, _branch, v_number, _source_department, COALESCE(_kind,'linen'),
    _guest_order, 'received', now(), _notes, auth.uid()
  ) RETURNING id INTO v_batch;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_items) LOOP
    IF COALESCE((v_line->>'quantity')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    INSERT INTO laundry_batch_items (organization_id, batch_id, linen_item_id, description, quantity)
    VALUES (
      v_org, v_batch,
      NULLIF(v_line->>'linen_item_id','')::uuid,
      NULLIF(v_line->>'description',''),
      (v_line->>'quantity')::numeric
    );

    INSERT INTO linen_movements (
      organization_id, branch_id, linen_item_id, from_state, to_state,
      from_department_id, to_department_id, batch_id, quantity, performed_by
    ) VALUES (
      v_org, _branch, NULLIF(v_line->>'linen_item_id','')::uuid, 'soiled', 'in-laundry',
      _source_department, NULL, v_batch, (v_line->>'quantity')::numeric, auth.uid()
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('id', v_batch, 'batch_number', v_number, 'lines', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_laundry_batch_create(uuid, text, jsonb, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_create(uuid, text, jsonb, uuid, uuid, text) TO authenticated;

-- 2. The Laundry Manager assigns or reassigns a batch to an attendant
CREATE OR REPLACE FUNCTION public.neo_laundry_batch_assign(
  _batch uuid,
  _attendant uuid,
  _priority text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid := current_org_id(); b record;
BEGIN
  IF NOT (has_exact_permission('laundry','batches','assign')
          OR has_exact_permission('laundry','batches','edit')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only the Laundry Manager may assign laundry work';
  END IF;
  SELECT * INTO b FROM laundry_batches WHERE id = _batch AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Unknown laundry batch'; END IF;
  IF b.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'This batch is closed'; END IF;

  UPDATE laundry_batches
     SET attendant_id = _attendant,
         notes = COALESCE(NULLIF(_priority,''), notes)
   WHERE id = _batch;

  RETURN jsonb_build_object('ok', true, 'batch', _batch, 'attendant', _attendant);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_laundry_batch_assign(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_assign(uuid, uuid, text) TO authenticated;

-- 3. Attendants move their own batch along the conveyor; managers may move any
CREATE OR REPLACE FUNCTION public.neo_laundry_batch_advance(_batch uuid, _status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  b record;
  v_manager boolean := has_exact_permission('laundry','batches','edit') OR is_org_admin();
  v_order text[] := ARRAY['received','washing','drying','finishing','ready','handed-over','completed'];
  v_from int; v_to int;
BEGIN
  SELECT * INTO b FROM laundry_batches WHERE id = _batch AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Unknown laundry batch'; END IF;

  IF NOT v_manager THEN
    IF b.attendant_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'This laundry batch is assigned to somebody else';
    END IF;
    IF NOT has_exact_permission('laundry','my-work','edit') THEN
      RAISE EXCEPTION 'Not permitted to update laundry work';
    END IF;
  END IF;

  v_from := array_position(v_order, COALESCE(b.status,'received'));
  v_to := array_position(v_order, _status);
  IF v_to IS NULL THEN RAISE EXCEPTION 'Unknown laundry status %', _status; END IF;
  IF v_from IS NOT NULL AND v_to < v_from AND NOT v_manager THEN
    RAISE EXCEPTION 'Only the Laundry Manager can send a batch backwards';
  END IF;

  UPDATE laundry_batches
     SET status = _status,
         started_at = CASE WHEN _status = 'washing' AND started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN _status = 'completed' THEN now() ELSE completed_at END,
         attendant_id = CASE WHEN attendant_id IS NULL THEN auth.uid() ELSE attendant_id END
   WHERE id = _batch;

  RETURN jsonb_build_object('ok', true, 'status', _status);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_laundry_batch_advance(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_advance(uuid, text) TO authenticated;

-- 4. Return the batch to the source department with a counted reconciliation
CREATE OR REPLACE FUNCTION public.neo_laundry_batch_return(_batch uuid, _lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  b record; l jsonb; li record;
  v_returned numeric; v_damaged numeric; v_missing numeric;
  v_incidents int := 0;
BEGIN
  SELECT * INTO b FROM laundry_batches WHERE id = _batch AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Unknown laundry batch'; END IF;
  IF NOT (has_exact_permission('laundry','batches','edit')
          OR is_org_admin()
          OR (b.attendant_id = auth.uid() AND has_exact_permission('laundry','my-work','edit'))) THEN
    RAISE EXCEPTION 'Not permitted to hand this batch back';
  END IF;

  FOR l IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    SELECT * INTO li FROM laundry_batch_items
      WHERE id = (l->>'id')::uuid AND batch_id = _batch AND organization_id = v_org FOR UPDATE;
    CONTINUE WHEN li IS NULL;

    v_returned := COALESCE((l->>'returned_quantity')::numeric, li.quantity);
    v_damaged := COALESCE((l->>'damaged_quantity')::numeric, 0);
    v_missing := GREATEST(li.quantity - v_returned - v_damaged, 0);

    IF v_returned + v_damaged > li.quantity THEN
      RAISE EXCEPTION 'More items returned than were handed over on this line';
    END IF;

    UPDATE laundry_batch_items
       SET returned_quantity = v_returned,
           damaged_quantity = v_damaged,
           missing_quantity = v_missing
     WHERE id = li.id;

    INSERT INTO linen_movements (
      organization_id, branch_id, linen_item_id, from_state, to_state,
      from_department_id, to_department_id, batch_id, quantity, received_quantity,
      discrepancy, performed_by, confirmed_by, confirmed_at
    ) VALUES (
      v_org, b.branch_id, li.linen_item_id, 'in-laundry', 'clean',
      NULL, b.source_department_id, _batch, li.quantity, v_returned,
      (v_damaged + v_missing) > 0, auth.uid(), auth.uid(), now()
    );

    IF v_damaged > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_damaged, b.source_department_id,
        COALESCE(l->>'notes','Damaged during laundry processing'), 'damaged', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;

    IF v_missing > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_missing, b.source_department_id,
        COALESCE(l->>'notes','Not returned from laundry'), 'missing', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;
  END LOOP;

  UPDATE laundry_batches
     SET status = 'completed', completed_at = now()
   WHERE id = _batch;

  RETURN jsonb_build_object('ok', true, 'incidents', v_incidents);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_laundry_batch_return(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_return(uuid, jsonb) TO authenticated;

-- 5. Anybody in Laundry reports damage; only the Manager decides the write-off
CREATE OR REPLACE FUNCTION public.neo_linen_incident_report(
  _branch uuid,
  _linen_item uuid,
  _quantity numeric,
  _condition text,
  _reason text,
  _batch uuid DEFAULT NULL,
  _photo text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid := current_org_id(); v_id uuid;
BEGIN
  IF NOT (has_exact_permission('laundry','incidents','create')
          OR has_exact_permission('laundry','my-work','edit')
          OR has_exact_permission('laundry','batches','edit')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to report a linen incident';
  END IF;
  IF COALESCE(_quantity,0) <= 0 THEN RAISE EXCEPTION 'Record how many items are affected'; END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN RAISE EXCEPTION 'Describe what happened'; END IF;

  INSERT INTO linen_incidents (
    organization_id, branch_id, linen_item_id, quantity, reason, condition,
    responsible_process, photo_url, reported_by, status
  ) VALUES (
    v_org, _branch, _linen_item, _quantity, btrim(_reason), COALESCE(_condition,'damaged'),
    'laundry', NULLIF(_photo,''), auth.uid(), 'reported'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.neo_linen_incident_report(uuid, uuid, numeric, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_linen_incident_report(uuid, uuid, numeric, text, text, uuid, text) TO authenticated;

-- 6. Manager review: write-off requires approval, and never by the reporter
CREATE OR REPLACE FUNCTION public.neo_linen_incident_review(
  _incident uuid,
  _decision text,
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  i record; v_status text; v_approval uuid; v_value numeric;
BEGIN
  IF NOT (has_exact_permission('laundry','incidents','approve')
          OR has_exact_permission('laundry','incidents','edit')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only the Laundry Manager may review a linen incident';
  END IF;
  SELECT * INTO i FROM linen_incidents WHERE id = _incident AND organization_id = v_org FOR UPDATE;
  IF i IS NULL THEN RAISE EXCEPTION 'Unknown linen incident'; END IF;
  IF i.reported_by = auth.uid() AND _decision = 'write-off' AND NOT is_org_admin() THEN
    RAISE EXCEPTION 'A linen write-off cannot be approved by the person who reported it';
  END IF;

  IF _decision = 'write-off' THEN
    SELECT COALESCE(replacement_cost,0) * i.quantity INTO v_value FROM linen_items WHERE id = i.linen_item_id;
    INSERT INTO approval_requests (
      organization_id, branch_id, module, request_type, reference_id, reason,
      requested_amount, status, requested_by
    ) VALUES (
      v_org, i.branch_id, 'laundry', 'linen-write-off', i.id,
      COALESCE(_notes, i.reason), COALESCE(v_value,0), 'pending', auth.uid()
    ) RETURNING id INTO v_approval;
    v_status := 'awaiting-approval';
  ELSIF _decision = 'repair' THEN
    v_status := 'repair';
  ELSIF _decision = 'dismiss' THEN
    v_status := 'dismissed';
  ELSE
    v_status := 'reviewed';
  END IF;

  UPDATE linen_incidents
     SET status = v_status,
         final_action = _decision,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         approval_request_id = COALESCE(v_approval, approval_request_id)
   WHERE id = _incident;

  RETURN jsonb_build_object('status', v_status, 'approval_request', v_approval);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_linen_incident_review(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_linen_incident_review(uuid, text, text) TO authenticated;

-- 7. Department feature templates
DELETE FROM public.role_feature_templates
 WHERE role_key IN ('laundry-manager','laundry-attendant','laundry-supervisor') AND module = 'laundry';

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'laundry-manager', 'laundry', f, a
FROM unnest(ARRAY['overview','batches','guest','incidents','supplies','requisitions','maintenance','tasks','reports','approvals','my-work']) f
CROSS JOIN unnest(ARRAY['view','create','edit','export','print']) a
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES ('laundry-manager','laundry','batches','assign'),
       ('laundry-manager','laundry','incidents','approve'),
       ('laundry-manager','laundry','approvals','approve')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'laundry-supervisor', 'laundry', f, a
FROM unnest(ARRAY['overview','batches','guest','incidents','supplies','tasks','my-work']) f
CROSS JOIN unnest(ARRAY['view','create','edit']) a
ON CONFLICT DO NOTHING;
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES ('laundry-supervisor','laundry','batches','assign')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES ('laundry-attendant','laundry','my-work','view'),
       ('laundry-attendant','laundry','my-work','edit'),
       ('laundry-attendant','laundry','supplies','view'),
       ('laundry-attendant','laundry','supplies','create'),
       ('laundry-attendant','laundry','incidents','create'),
       ('laundry-attendant','laundry','maintenance','create'),
       ('laundry-attendant','laundry','tasks','view'),
       ('laundry-attendant','laundry','tasks','edit')
ON CONFLICT DO NOTHING;