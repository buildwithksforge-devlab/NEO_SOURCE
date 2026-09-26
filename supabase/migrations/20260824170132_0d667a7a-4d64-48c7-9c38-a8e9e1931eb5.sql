CREATE TABLE IF NOT EXISTS public.department_stock_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  department_id uuid,
  module text NOT NULL DEFAULT 'front-office',
  item text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unit',
  priority text NOT NULL DEFAULT 'normal',
  notes text,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  requisition_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS department_stock_needs_org_idx
  ON public.department_stock_needs (organization_id, branch_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.department_stock_needs TO authenticated;
GRANT ALL ON public.department_stock_needs TO service_role;

ALTER TABLE public.department_stock_needs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_needs_read_own_org" ON public.department_stock_needs;
CREATE POLICY "stock_needs_read_own_org" ON public.department_stock_needs
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_active_staff());

DROP POLICY IF EXISTS "stock_needs_insert_own_org" ON public.department_stock_needs;
CREATE POLICY "stock_needs_insert_own_org" ON public.department_stock_needs
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_org_id()
    AND public.is_active_staff()
    AND requested_by = auth.uid()
  );

DROP POLICY IF EXISTS "stock_needs_review_with_permission" ON public.department_stock_needs;
CREATE POLICY "stock_needs_review_with_permission" ON public.department_stock_needs
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND public.has_permission(module, 'requisitions', 'create')
  )
  WITH CHECK (organization_id = public.current_org_id());

DROP TRIGGER IF EXISTS department_stock_needs_touch ON public.department_stock_needs;
CREATE TRIGGER department_stock_needs_touch
  BEFORE UPDATE ON public.department_stock_needs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_department_stock_need_create(
  _item text,
  _quantity numeric DEFAULT 1,
  _unit text DEFAULT 'unit',
  _priority text DEFAULT 'normal',
  _notes text DEFAULT NULL,
  _module text DEFAULT 'front-office',
  _department uuid DEFAULT NULL,
  _branch uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _id uuid; _branch_final uuid; _dept uuid;
BEGIN
  IF _org IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Only active staff can report a stock need';
  END IF;
  IF coalesce(btrim(_item), '') = '' THEN RAISE EXCEPTION 'Describe the item you need'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO _branch_final
  FROM public.profiles p WHERE p.id = auth.uid();

  SELECT coalesce(_department, p.department_id) INTO _dept
  FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.department_stock_needs (
    organization_id, branch_id, department_id, module, item, quantity, unit, priority, notes, requested_by
  ) VALUES (
    _org, _branch_final, _dept, coalesce(_module, 'front-office'), btrim(_item), _quantity,
    coalesce(nullif(btrim(_unit), ''), 'unit'), coalesce(nullif(btrim(_priority), ''), 'normal'),
    nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING id INTO _id;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _branch_final, 'operations', 'Stock need reported',
    btrim(_item) || ' — ' || _quantity::text || ' ' || coalesce(_unit, 'unit'),
    '/pms/requisitions');

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_department_stock_need_review(
  _need uuid,
  _decision text,
  _notes text DEFAULT NULL,
  _requisition uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _row public.department_stock_needs; _status text;
BEGIN
  SELECT * INTO _row FROM public.department_stock_needs
   WHERE id = _need AND organization_id = _org FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;

  IF NOT public.has_permission(_row.module, 'requisitions', 'create') THEN
    RAISE EXCEPTION 'Not permitted to review stock needs for this department';
  END IF;

  _status := CASE lower(coalesce(_decision, ''))
    WHEN 'acknowledge' THEN 'acknowledged'
    WHEN 'acknowledged' THEN 'acknowledged'
    WHEN 'requisition' THEN 'requisitioned'
    WHEN 'requisitioned' THEN 'requisitioned'
    WHEN 'decline' THEN 'declined'
    WHEN 'declined' THEN 'declined'
    WHEN 'close' THEN 'closed'
    ELSE NULL END;
  IF _status IS NULL THEN RAISE EXCEPTION 'Unknown decision %', _decision; END IF;

  UPDATE public.department_stock_needs
     SET status = _status,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_notes = coalesce(nullif(btrim(_notes), ''), review_notes),
         requisition_id = coalesce(_requisition, requisition_id),
         updated_at = now()
   WHERE id = _need;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'stock_need.' || _status, _row.module, _need::text,
          jsonb_build_object('item', _row.item, 'status', _status), _notes);

  RETURN jsonb_build_object('id', _need, 'status', _status);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_department_stock_need_review(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_department_stock_need_review(uuid, text, text, uuid) TO authenticated;

INSERT INTO public.permissions (module, feature, action, label)
VALUES
  ('front-office', 'tasks', 'view', 'View front office tasks'),
  ('front-office', 'tasks', 'create', 'Assign front office tasks'),
  ('front-office', 'tasks', 'edit', 'Update front office tasks'),
  ('front-office', 'requisitions', 'view', 'View front office requisitions'),
  ('front-office', 'requisitions', 'create', 'Raise front office requisitions'),
  ('front-office', 'stock-needs', 'view', 'View front office stock needs'),
  ('front-office', 'stock-needs', 'create', 'Report a front office stock need'),
  ('front-office', 'intelligence', 'view', 'View front office intelligence'),
  ('pms', '*', 'checkin.override_readiness', 'Check in to a room that is not ready')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.neo_fo_checkin_readiness_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _room public.rooms; _not_ready boolean;
BEGIN
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO _room FROM public.rooms WHERE id = NEW.room_id;
  IF _room.id IS NULL THEN RETURN NEW; END IF;

  _not_ready := lower(coalesce(_room.room_condition, '')) IN ('dirty', 'vacant-dirty', 'cleaning', 'inspection', 'not-ready')
    OR lower(coalesce(_room.housekeeping_status, '')) IN ('dirty', 'cleaning', 'inspection', 'not-ready');

  IF _not_ready AND NOT public.has_permission('pms', '*', 'checkin.override_readiness') THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (NEW.organization_id, auth.uid(), '', 'pms.checkin.blocked', 'front-office', NEW.room_id::text,
      jsonb_build_object('room', _room.room_number, 'condition', _room.room_condition,
                         'housekeeping_status', _room.housekeeping_status),
      'Room not ready for check-in');
    RAISE EXCEPTION 'Room % is not ready (%). Housekeeping must release it, or an authorised exception is required.',
      _room.room_number, coalesce(nullif(_room.housekeeping_status, ''), _room.room_condition);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_fo_checkin_readiness_guard ON public.stays;
CREATE TRIGGER neo_fo_checkin_readiness_guard
  BEFORE INSERT ON public.stays
  FOR EACH ROW EXECUTE FUNCTION public.neo_fo_checkin_readiness_guard();