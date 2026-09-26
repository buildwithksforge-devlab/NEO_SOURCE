-- ============ A. Role template compilation completion ============
ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'template';

COMMENT ON COLUMN public.role_permissions.source IS
  'template = compiled from role_feature_templates; custom = deliberately granted by an administrator and never auto-revoked; legacy = pre-catalogue grant awaiting compilation.';

CREATE TABLE IF NOT EXISTS public.role_template_aliases (
  role_key text PRIMARY KEY,
  template_key text NOT NULL,
  access_scope text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.role_template_aliases TO authenticated;
GRANT ALL ON public.role_template_aliases TO service_role;
ALTER TABLE public.role_template_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_template_aliases_read" ON public.role_template_aliases;
CREATE POLICY "role_template_aliases_read" ON public.role_template_aliases
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.role_template_aliases (role_key, template_key, access_scope, note) VALUES
  ('general manager', 'operations-manager', 'branch', 'Property head — compiled as Operations Manager.'),
  ('bar manager', 'food-and-beverage-manager', 'department', 'Bar section head — compiled as Food and Beverage Manager.'),
  ('maintenance officer', 'maintenance-technician', 'self', 'Line maintenance role — compiled as Maintenance Technician.'),
  ('coffee station supervisor', 'barista', 'team', 'Coffee station lead — compiled as Barista with team scope.'),
  ('hot kitchen supervisor', 'hot-kitchen-chef', 'team', 'Hot kitchen lead — compiled as Hot-Kitchen Chef with team scope.')
ON CONFLICT (role_key) DO UPDATE
  SET template_key = excluded.template_key,
      access_scope = excluded.access_scope,
      note = excluded.note;

CREATE OR REPLACE FUNCTION public.neo_resolve_role_template_key(_key text, _name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(
    (SELECT ft.role_key FROM public.role_feature_templates ft
      WHERE ft.role_key = _key LIMIT 1),
    (SELECT a.template_key FROM public.role_template_aliases a
      WHERE a.role_key = lower(coalesce(_key, '')) LIMIT 1),
    (SELECT a.template_key FROM public.role_template_aliases a
      WHERE a.role_key = lower(regexp_replace(coalesce(_name, ''), '[^a-zA-Z0-9]+', ' ', 'g')) LIMIT 1)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.neo_resolve_role_template_key(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_resolve_role_template_key(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_apply_feature_templates(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _removed integer := 0;
  _added integer := 0;
  _scoped integer := 0;
BEGIN
  CREATE TEMP TABLE _targets ON COMMIT DROP AS
    SELECT r.id AS role_id,
           public.neo_resolve_role_template_key(r.normalized_role_key, r.name) AS role_key
    FROM public.roles r
    WHERE r.organization_id = _org
      AND coalesce(r.active, true);
  DELETE FROM _targets WHERE role_key IS NULL;

  -- Access scope follows the compiled template, never the role title.
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

  -- Retire grants no template justifies. Grants an administrator marked
  -- 'custom' are deliberate and are always preserved.
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
$function$;

REVOKE EXECUTE ON FUNCTION public.neo_apply_feature_templates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_apply_feature_templates(uuid) TO authenticated, service_role;

-- Recompile every workspace, then invalidate cached access snapshots.
DO $$
DECLARE _o uuid;
BEGIN
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(_o);
  END LOOP;
END $$;

DELETE FROM public.user_access_snapshots;

-- ============ B. Station routing truth ============
CREATE OR REPLACE FUNCTION public.neo_resolve_item_station(
  _org uuid, _branch uuid, _menu_item uuid, _order_type text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _station uuid;
  _category uuid;
BEGIN
  IF _menu_item IS NULL THEN RETURN NULL; END IF;

  SELECT mi.station_id, mi.category_id INTO _station, _category
  FROM public.menu_items mi WHERE mi.id = _menu_item;
  IF _station IS NOT NULL THEN RETURN _station; END IF;

  SELECT rr.station_id INTO _station
  FROM public.station_routing_rules rr
  WHERE rr.organization_id = _org
    AND coalesce(rr.active, true)
    AND rr.menu_item_id = _menu_item
    AND (rr.branch_id IS NULL OR _branch IS NULL OR rr.branch_id = _branch)
    AND (rr.order_type IS NULL OR _order_type IS NULL OR rr.order_type = _order_type)
  ORDER BY rr.priority NULLS LAST LIMIT 1;
  IF _station IS NOT NULL THEN RETURN _station; END IF;

  IF _category IS NOT NULL THEN
    SELECT rr.station_id INTO _station
    FROM public.station_routing_rules rr
    WHERE rr.organization_id = _org
      AND coalesce(rr.active, true)
      AND rr.category_id = _category
      AND (rr.branch_id IS NULL OR _branch IS NULL OR rr.branch_id = _branch)
      AND (rr.order_type IS NULL OR _order_type IS NULL OR rr.order_type = _order_type)
    ORDER BY rr.priority NULLS LAST LIMIT 1;
    IF _station IS NOT NULL THEN RETURN _station; END IF;

    SELECT mc.station_id INTO _station
    FROM public.menu_categories mc WHERE mc.id = _category;
    IF _station IS NOT NULL THEN RETURN _station; END IF;
  END IF;

  -- Last resort: the workspace has exactly one production station, so an
  -- unrouted preparable item can only belong there. Never guesses between two.
  SELECT s.id INTO _station
  FROM public.operational_stations s
  WHERE s.organization_id = _org
    AND coalesce(s.active, true)
    AND s.station_type = 'production'
    AND (s.branch_id IS NULL OR _branch IS NULL OR s.branch_id = _branch);
  IF (SELECT count(*) FROM public.operational_stations s
        WHERE s.organization_id = _org AND coalesce(s.active, true)
          AND s.station_type = 'production'
          AND (s.branch_id IS NULL OR _branch IS NULL OR s.branch_id = _branch)) = 1 THEN
    RETURN _station;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_resolve_item_station(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_resolve_item_station(uuid, uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_pos_item_station()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _branch uuid; _otype text;
BEGIN
  IF NEW.station_id IS NOT NULL OR NEW.menu_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.branch_id, o.order_type INTO _branch, _otype
  FROM public.pos_orders o WHERE o.id = NEW.order_id;
  NEW.station_id := public.neo_resolve_item_station(NEW.organization_id, _branch, NEW.menu_item_id, _otype);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_pos_item_station_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_item_station_trg
  BEFORE INSERT OR UPDATE OF menu_item_id, station_id ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_pos_item_station();

-- Backfill existing unrouted order lines (no rows created or deleted).
UPDATE public.pos_order_items i
   SET station_id = public.neo_resolve_item_station(i.organization_id, o.branch_id, i.menu_item_id, o.order_type)
  FROM public.pos_orders o
 WHERE o.id = i.order_id
   AND i.station_id IS NULL
   AND i.menu_item_id IS NOT NULL;