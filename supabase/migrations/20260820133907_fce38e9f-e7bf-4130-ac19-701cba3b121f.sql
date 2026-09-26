CREATE OR REPLACE FUNCTION public.neo_norm_key(_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT lower(btrim(regexp_replace(coalesce(_value,''), '\s+', ' ', 'g')));
$$;

-- ---------------------------------------------------------------------------
-- Department alignment. Additive and idempotent: renames keep the UUID, only
-- genuinely missing departments are created, nothing is deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_align_departments(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _renamed jsonb := '[]'::jsonb;
  _created jsonb := '[]'::jsonb;
  _legacy  jsonb := '[]'::jsonb;
  _moved   jsonb := '[]'::jsonb;
  _rec record;
  _id uuid;
  _target text;
  _deps integer;
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised to align departments';
  END IF;

  -- 1. Renames in place (UUID preserved, previous name recorded).
  FOR _rec IN
    SELECT * FROM (VALUES
      ('restaurant','Food and Beverage','food-and-beverage'),
      ('kitchen','Main Kitchen','main-kitchen'),
      ('maintenance','Maintenance and Landscaping','maintenance'),
      ('events','Sales, Events and Banqueting','sales-events-banqueting'),
      ('inventory & stores','Inventory and Stores','inventory-and-stores'),
      ('stores and inventory','Inventory and Stores','inventory-and-stores')
    ) AS t(from_key, to_name, key)
  LOOP
    SELECT id INTO _id FROM departments
     WHERE organization_id = _org AND public.neo_norm_key(name) = _rec.from_key LIMIT 1;
    IF _id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM departments d2
                        WHERE d2.organization_id = _org AND d2.id <> _id
                          AND public.neo_norm_key(d2.name) = public.neo_norm_key(_rec.to_name)) THEN
      UPDATE departments
         SET previous_name = COALESCE(NULLIF(previous_name,''), name),
             name = _rec.to_name,
             catalogue_key = _rec.key,
             department_status = 'active'
       WHERE id = _id AND name <> _rec.to_name;
      IF FOUND THEN
        _renamed := _renamed || jsonb_build_object('id', _id, 'from', _rec.from_key, 'to', _rec.to_name);
      END IF;
      UPDATE departments SET catalogue_key = _rec.key WHERE id = _id AND catalogue_key IS DISTINCT FROM _rec.key;
    END IF;
  END LOOP;

  -- 2. Tag the departments that keep their name.
  UPDATE departments d SET catalogue_key = m.key
    FROM (VALUES
      ('finance','finance'),('front office','front-office'),('housekeeping','housekeeping'),
      ('laundry','laundry'),('human resources','human-resources'),('marketing','marketing'),
      ('procurement','procurement'),('delivery','delivery'),('bar','bar'),
      ('administration','administration'),('food and beverage','food-and-beverage'),
      ('main kitchen','main-kitchen'),('maintenance and landscaping','maintenance'),
      ('sales, events and banqueting','sales-events-banqueting'),
      ('inventory and stores','inventory-and-stores')
    ) AS m(nkey, key)
   WHERE d.organization_id = _org AND public.neo_norm_key(d.name) = m.nkey
     AND d.catalogue_key IS DISTINCT FROM m.key;

  -- 3. Create only genuinely missing departments.
  FOR _rec IN
    SELECT * FROM (VALUES
      ('Executive Management','executive-management','EXEC'),
      ('Operations','operations','OPER'),
      ('Pastry and Bakery','pastry-and-bakery','PAST'),
      ('Security','security','SECU'),
      ('IT and Systems','it-and-systems','ITSY')
    ) AS t(dname, key, code)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM departments
                    WHERE organization_id = _org
                      AND (public.neo_norm_key(name) = public.neo_norm_key(_rec.dname)
                           OR catalogue_key = _rec.key)) THEN
      INSERT INTO departments (organization_id, name, code, catalogue_key, department_status)
      VALUES (_org, _rec.dname, _rec.code, _rec.key, 'active')
      RETURNING id INTO _id;
      _created := _created || jsonb_build_object('id', _id, 'name', _rec.dname);
    END IF;
  END LOOP;

  -- 4. Stations follow their department.
  UPDATE operational_stations s
     SET department_id = (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'food-and-beverage' LIMIT 1)
   WHERE s.organization_id = _org AND public.neo_norm_key(s.name) = 'main bar'
     AND s.department_id IS DISTINCT FROM (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'food-and-beverage' LIMIT 1);
  IF FOUND THEN _moved := _moved || jsonb_build_object('station','Main Bar','to','Food and Beverage'); END IF;

  UPDATE operational_stations s
     SET department_id = (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'pastry-and-bakery' LIMIT 1)
   WHERE s.organization_id = _org AND public.neo_norm_key(s.name) = 'pastry'
     AND s.department_id IS DISTINCT FROM (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'pastry-and-bakery' LIMIT 1);
  IF FOUND THEN _moved := _moved || jsonb_build_object('station','Pastry','to','Pastry and Bakery'); END IF;

  -- 5. Reporting lines through a real parent relationship.
  FOR _rec IN
    SELECT * FROM (VALUES
      ('operations','executive-management'),
      ('finance','executive-management'),
      ('human-resources','executive-management'),
      ('it-and-systems','executive-management'),
      ('food-and-beverage','operations'),
      ('main-kitchen','operations'),
      ('pastry-and-bakery','operations'),
      ('front-office','operations'),
      ('housekeeping','operations'),
      ('laundry','housekeeping'),
      ('maintenance','operations'),
      ('marketing','operations'),
      ('sales-events-banqueting','operations'),
      ('procurement','operations'),
      ('inventory-and-stores','operations'),
      ('security','operations'),
      ('delivery','operations')
    ) AS t(child, parent)
  LOOP
    UPDATE departments c
       SET parent_department_id = p.id
      FROM departments p
     WHERE c.organization_id = _org AND p.organization_id = _org
       AND c.catalogue_key = _rec.child AND p.catalogue_key = _rec.parent
       AND c.id <> p.id
       AND c.parent_department_id IS DISTINCT FROM p.id;
  END LOOP;

  -- 6. Bar: move remaining dependencies to Food and Beverage, then classify legacy.
  SELECT id INTO _id FROM departments WHERE organization_id = _org AND catalogue_key = 'bar' LIMIT 1;
  IF _id IS NOT NULL THEN
    UPDATE profiles SET department_id = (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'food-and-beverage' LIMIT 1)
     WHERE organization_id = _org AND department_id = _id;
    UPDATE roles SET department_id = (SELECT id FROM departments WHERE organization_id = _org AND catalogue_key = 'food-and-beverage' LIMIT 1)
     WHERE organization_id = _org AND department_id = _id;
    SELECT count(*) INTO _deps FROM operational_stations WHERE organization_id = _org AND department_id = _id AND active;
    IF _deps = 0
       AND NOT EXISTS (SELECT 1 FROM profiles WHERE organization_id = _org AND department_id = _id)
       AND NOT EXISTS (SELECT 1 FROM roles WHERE organization_id = _org AND department_id = _id) THEN
      UPDATE departments SET department_status = 'legacy', active = false WHERE id = _id AND department_status <> 'legacy';
      IF FOUND THEN _legacy := _legacy || jsonb_build_object('id', _id, 'name','Bar'); END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'renamed', _renamed, 'created', _created, 'stations_moved', _moved, 'legacy', _legacy,
    'departments', (SELECT count(*) FROM departments WHERE organization_id = _org)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_align_departments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_align_departments(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Role classification. Links every organisation role to the approved catalogue
-- without deleting or duplicating anything.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_classify_roles(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _r record;
  _cat record;
  _alias record;
  _renamed jsonb := '[]'::jsonb;
  _legacy jsonb := '[]'::jsonb;
  _custom jsonb := '[]'::jsonb;
  _canonical uuid;
  _dept uuid;
  _level integer;
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised to classify roles';
  END IF;

  FOR _r IN SELECT * FROM roles WHERE organization_id = _org ORDER BY name LOOP
    SELECT * INTO _alias FROM role_catalogue_aliases WHERE alias_key = public.neo_norm_key(_r.name);

    -- Customer-facing role stays out of the staff catalogue entirely.
    IF public.neo_norm_key(_r.name) IN ('guest','guest/customer','customer') THEN
      UPDATE roles SET role_status = 'custom', migration_status = 'not_started',
                       migration_review_reason = 'Guest/customer role — deliberately kept separate from the staff catalogue.',
                       normalized_role_key = 'guest'
       WHERE id = _r.id;
      CONTINUE;
    END IF;

    IF _alias IS NULL THEN
      UPDATE roles SET role_status = 'custom', migration_status = 'review_required',
                       migration_review_reason = 'No approved catalogue equivalent. An authorised administrator must decide whether it stays custom or maps to a modern role.',
                       normalized_role_key = public.neo_norm_key(_r.name)
       WHERE id = _r.id AND role_status <> 'archived';
      _custom := _custom || jsonb_build_object('id', _r.id, 'name', _r.name);
      CONTINUE;
    END IF;

    IF _alias.ambiguous THEN
      UPDATE roles SET role_status = 'custom', migration_status = 'review_required',
                       migration_review_reason = _alias.review_reason,
                       normalized_role_key = public.neo_norm_key(_r.name)
       WHERE id = _r.id AND role_status <> 'archived';
      _custom := _custom || jsonb_build_object('id', _r.id, 'name', _r.name, 'reason', _alias.review_reason);
      CONTINUE;
    END IF;

    SELECT * INTO _cat FROM role_catalogue WHERE role_key = _alias.role_key;
    SELECT id INTO _dept FROM departments
      WHERE organization_id = _org AND public.neo_norm_key(name) = public.neo_norm_key(_cat.department)
      LIMIT 1;

    WITH RECURSIVE chain AS (
      SELECT role_key, reports_to_key, 1 AS depth FROM role_catalogue WHERE role_key = _cat.role_key
      UNION ALL
      SELECT rc.role_key, rc.reports_to_key, c.depth + 1
        FROM role_catalogue rc JOIN chain c ON rc.role_key = c.reports_to_key
    ) SELECT max(depth) INTO _level FROM chain;

    -- Does the organisation already hold a role carrying the catalogue name?
    SELECT id INTO _canonical FROM roles
      WHERE organization_id = _org AND public.neo_norm_key(name) = public.neo_norm_key(_cat.role_name)
      LIMIT 1;

    IF _canonical IS NULL OR _canonical = _r.id THEN
      -- Rename in place: the UUID, its grants and its history are preserved.
      UPDATE roles SET
        previous_name = CASE WHEN name <> _cat.role_name THEN COALESCE(NULLIF(previous_name,''), name) ELSE previous_name END,
        name = _cat.role_name,
        normalized_role_key = _cat.role_key,
        role_status = 'active',
        catalogue_version = 2,
        department_id = COALESCE(_dept, department_id),
        access_scope = COALESCE(access_scope, _cat.access_scope),
        managerial_scope = _cat.access_scope,
        position_level = _level,
        approval_class = CASE WHEN _cat.restricted_authority THEN 'restricted_approver' ELSE 'requester' END,
        migration_status = 'migrated',
        migration_review_reason = NULL
      WHERE id = _r.id;
      IF _r.name <> _cat.role_name THEN
        _renamed := _renamed || jsonb_build_object('id', _r.id, 'from', _r.name, 'to', _cat.role_name);
      END IF;
    ELSE
      -- Both the old and the modern role exist: keep both, link them.
      UPDATE roles SET
        successor_role_id = _canonical,
        normalized_role_key = _cat.role_key,
        role_status = 'legacy',
        migration_status = 'planned',
        migration_review_reason = format('Predecessor of %s. Active users must be reassigned before it can be archived.', _cat.role_name)
      WHERE id = _r.id;
      UPDATE roles SET predecessor_role_id = _r.id WHERE id = _canonical AND predecessor_role_id IS NULL;
      _legacy := _legacy || jsonb_build_object('id', _r.id, 'name', _r.name, 'successor', _cat.role_name);
    END IF;
  END LOOP;

  -- Reporting lines between roles, resolved through catalogue keys only.
  UPDATE roles child SET reports_to_role_id = parent.id
    FROM role_catalogue rc
    JOIN roles parent ON parent.organization_id = _org
                     AND parent.normalized_role_key = rc.reports_to_key
                     AND parent.role_status = 'active'
   WHERE child.organization_id = _org
     AND child.normalized_role_key = rc.role_key
     AND child.role_status = 'active'
     AND child.id <> parent.id
     AND child.reports_to_role_id IS DISTINCT FROM parent.id;

  RETURN jsonb_build_object('renamed', _renamed, 'legacy_linked', _legacy, 'review_required', _custom);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_classify_roles(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_classify_roles(uuid) TO authenticated;
