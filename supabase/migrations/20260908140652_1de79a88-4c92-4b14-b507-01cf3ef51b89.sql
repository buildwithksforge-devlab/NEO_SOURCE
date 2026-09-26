
CREATE OR REPLACE FUNCTION public.neo_notify_event(
  _org uuid, _user uuid, _branch uuid, _event text, _record uuid DEFAULT NULL::uuid,
  _vars jsonb DEFAULT '{}'::jsonb, _idem text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _t public.notification_templates; _title text; _body text; _link text; _k text; _missing text[]; _status text;
BEGIN
  IF _org IS NULL OR _event IS NULL THEN RETURN NULL; END IF;
  IF auth.uid() IS NOT NULL AND _org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Not allowed for another workspace' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _t FROM public.notification_templates
   WHERE event_type = _event AND active
     AND (organization_id = _org OR organization_id IS NULL)
   ORDER BY organization_id NULLS LAST LIMIT 1;
  IF _t.id IS NULL THEN RETURN NULL; END IF;

  _title := _t.title_template; _body := _t.body_template; _link := _t.link_template;
  _vars := coalesce(_vars,'{}'::jsonb) || jsonb_build_object('record', coalesce(_record::text,''));
  _status := coalesce(_vars->>'status', '');
  FOR _k IN SELECT jsonb_object_keys(_vars) LOOP
    _title := replace(_title, '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _body  := replace(_body,  '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _link  := replace(coalesce(_link,''), '{{'||_k||'}}', coalesce(_vars->>_k,''));
  END LOOP;

  SELECT array_agg(DISTINCT m[1]) INTO _missing
    FROM regexp_matches(coalesce(_title,'')||' '||coalesce(_body,'')||' '||coalesce(_link,''),
                        '\{\{([a-zA-Z0-9_.]+)\}\}', 'g') AS m;

  IF _missing IS NOT NULL AND array_length(_missing,1) > 0 THEN
    INSERT INTO public.notification_render_failures
      (organization_id, branch_id, event_type, record_id, missing_variables, rendered_title, rendered_body, variables)
    VALUES (_org, _branch, _event, _record, _missing, _title, _body, _vars);
    RETURN NULL;
  END IF;

  RETURN public.neo_notify(_org, _user, _branch, _t.category, _title, _body,
    nullif(_link,''), _t.priority, _t.action_required, _t.source_module, _record, _event,
    coalesce(_idem, _event || ':' || coalesce(_record::text,'') || ':' || _status || ':' || coalesce(_user::text,'all')));
END
$fn$;

CREATE OR REPLACE FUNCTION public.neo_apply_feature_templates(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _removed integer := 0;
  _added integer := 0;
  _scoped integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL
     AND (_org IS DISTINCT FROM public.current_org_id() OR NOT public.is_org_admin_for(_org)) THEN
    RAISE EXCEPTION 'Only a workspace administrator can apply role templates' USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE _targets ON COMMIT DROP AS
    SELECT r.id AS role_id,
           public.neo_resolve_role_template_key(r.normalized_role_key, r.name) AS role_key
    FROM public.roles r
    WHERE r.organization_id = _org
      AND coalesce(r.active, true);
  DELETE FROM _targets WHERE role_key IS NULL;

  WITH scoped AS (
    UPDATE public.roles r
       SET access_scope = a.access_scope
      FROM _targets t
      JOIN public.role_template_aliases a ON a.template_key = t.role_key
     WHERE r.id = t.role_id
       AND r.access_scope IS NULL
       AND a.access_scope IS NOT NULL
       AND lower(coalesce(r.normalized_role_key, '')) = a.role_key
    RETURNING 1
  )
  SELECT count(*) INTO _scoped FROM scoped;

  WITH doomed AS (
    SELECT rp.id, t.role_id, t.role_key, p.id AS permission_id, p.module, p.feature, p.action
    FROM _targets t
    JOIN public.role_permissions rp ON rp.role_id = t.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE rp.source <> 'custom'
      AND NOT EXISTS (
        SELECT 1 FROM public.role_feature_templates ft
        WHERE ft.role_key = t.role_key
          AND ft.module = p.module AND ft.feature = p.feature AND ft.action = p.action
      )
  ),
  logged AS (
    INSERT INTO public.role_grant_migration_log
      (organization_id, role_id, role_key, permission_id, module, feature, action, operation, reason)
    SELECT _org, d.role_id, d.role_key, d.permission_id, d.module, d.feature, d.action, 'revoked',
           'legacy grant retired: no feature-level capability in the compiled catalogue template'
    FROM doomed d RETURNING 1
  ),
  deleted AS (
    DELETE FROM public.role_permissions rp USING doomed d WHERE rp.id = d.id RETURNING 1
  )
  SELECT count(*) INTO _removed FROM deleted;

  WITH wanted AS (
    SELECT t.role_id, t.role_key, p.id AS permission_id, p.module, p.feature, p.action
    FROM _targets t
    JOIN public.role_feature_templates ft ON ft.role_key = t.role_key
    JOIN public.permissions p
      ON p.module = ft.module AND p.feature = ft.feature AND p.action = ft.action
    WHERE NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = t.role_id AND rp.permission_id = p.id
    )
  ),
  inserted AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
    SELECT _org, w.role_id, w.permission_id, 'template' FROM wanted w RETURNING 1
  ),
  logged2 AS (
    INSERT INTO public.role_grant_migration_log
      (organization_id, role_id, role_key, permission_id, module, feature, action, operation, reason)
    SELECT _org, w.role_id, w.role_key, w.permission_id, w.module, w.feature, w.action, 'granted',
           'feature-level capability compiled from the modern role catalogue'
    FROM wanted w RETURNING 1
  )
  SELECT count(*) INTO _added FROM inserted;

  DROP TABLE IF EXISTS _targets;

  RETURN jsonb_build_object('organization_id', _org, 'revoked', _removed,
                            'granted', _added, 'scopes_filled', _scoped);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_aggregate_ticket(_ticket uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _t record; _now timestamptz := now();
  _active int; _new int; _accepted int; _preparing int; _ready_plus int; _served_plus int; _completed int;
  _state text;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF auth.uid() IS NOT NULL AND _t.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Not allowed for another workspace' USING ERRCODE = '42501';
  END IF;

  SELECT
    count(*) FILTER (WHERE status <> 'cancelled'),
    count(*) FILTER (WHERE status = 'new'),
    count(*) FILTER (WHERE status IN ('accepted','cancel-pending')),
    count(*) FILTER (WHERE status IN ('preparing','remaking','remake-requested')),
    count(*) FILTER (WHERE status IN ('ready','collected','served','completed')),
    count(*) FILTER (WHERE status IN ('served','completed')),
    count(*) FILTER (WHERE status = 'completed')
  INTO _active, _new, _accepted, _preparing, _ready_plus, _served_plus, _completed
  FROM public.station_ticket_items WHERE ticket_id = _ticket;

  _state := CASE
    WHEN _active = 0 THEN 'cancelled'
    WHEN _completed = _active THEN 'completed'
    WHEN _served_plus = _active THEN 'served'
    WHEN _ready_plus = _active THEN 'ready'
    WHEN _ready_plus > 0 THEN 'partially-ready'
    WHEN _preparing > 0 THEN 'preparing'
    WHEN _accepted > 0 THEN 'accepted'
    ELSE 'new'
  END;

  UPDATE public.station_tickets SET
    status = _state,
    accepted_at = CASE WHEN _state = 'new' THEN NULL ELSE COALESCE(accepted_at, _now) END,
    started_at = CASE WHEN _state IN ('preparing','partially-ready','ready','served','completed')
                      THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _state IN ('ready','served','completed') THEN COALESCE(ready_at, _now) ELSE NULL END,
    completed_at = CASE WHEN _state = 'completed' THEN COALESCE(completed_at, _now) ELSE NULL END,
    cancelled_at = CASE WHEN _state = 'cancelled' THEN COALESCE(cancelled_at, _now) ELSE NULL END
  WHERE id = _ticket;

  IF _state = 'ready' THEN
    PERFORM public.emit_domain_event(_t.organization_id, _t.branch_id, 'kitchen.order.ready', 'kitchen', _ticket,
      jsonb_build_object('order_id', _t.order_id, 'station_id', _t.station_id),
      'kitchen-ticket-ready-' || _ticket::text, NULL);
    INSERT INTO public.notifications (organization_id, user_id, branch_id, department_id, station_id, category,
                                      title, body, link, priority, source_module, source_record_id,
                                      event_type, idempotency_key)
    SELECT _t.organization_id, o.waiter_id, _t.branch_id, _t.department_id, _t.station_id, 'kitchen',
           'Order ' || o.order_number || ' is ready',
           'All items on ticket ' || _t.ticket_number || ' are ready for collection.',
           '/pos/orders/' || o.id::text, 'high', 'kitchen', _ticket,
           'kitchen.order.ready',
           'kitchen.order.ready:' || _ticket::text || ':' || o.waiter_id::text
    FROM public.pos_orders o
    WHERE o.id = _t.order_id AND o.waiter_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN _state;
END
$fn$;
