-- =====================================================================
-- Dynamic reporting lines: role metadata, stored reporting manager,
-- cycle-safe candidate resolution and evidence-based backfill.
-- Additive only: no drops, no data loss, every existing id preserved.
-- =====================================================================

-- 1. Organisational metadata on the canonical role catalogue -----------
ALTER TABLE public.role_catalogue
  ADD COLUMN IF NOT EXISTS management_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reports_to_role_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS can_manage_role_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS managerial_scope text NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS department_scope text NOT NULL DEFAULT 'own',
  ADD COLUMN IF NOT EXISTS property_scope text NOT NULL DEFAULT 'own',
  ADD COLUMN IF NOT EXISTS reporting_manager_required boolean NOT NULL DEFAULT true;

-- Per-organisation overrides so a newly created role is configurable
-- without any frontend change.
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS reports_to_role_keys text[],
  ADD COLUMN IF NOT EXISTS can_manage_role_keys text[],
  ADD COLUMN IF NOT EXISTS reporting_manager_required boolean,
  ADD COLUMN IF NOT EXISTS management_level integer;

-- 2. Catalogue entries that live roles already use but the catalogue
--    never carried. Without them those roles have no reporting metadata.
INSERT INTO public.role_catalogue
  (role_key, role_name, department, reports_to_key, access_scope, summary, sort_order)
VALUES
  ('general-manager','General Manager','Executive','owner','organisation','Heads the property on behalf of ownership.',5),
  ('maintenance-officer','Maintenance Officer','Maintenance','maintenance-manager','team','Carries out and coordinates maintenance work.',260),
  ('bar-supervisor','Bar Supervisor','Food & Beverage','food-and-beverage-manager','team','Supervises the bar and its attendants.',75),
  ('restaurant-supervisor','Restaurant Supervisor','Food & Beverage','food-and-beverage-manager','team','Supervises restaurant service staff.',74),
  ('coffee-station-supervisor','Coffee Station Supervisor','Food & Beverage','food-and-beverage-manager','team','Supervises the coffee station.',76),
  ('hot-kitchen-supervisor','Hot Kitchen Supervisor','Kitchen','head-chef','team','Supervises the hot kitchen section.',105),
  ('stores-manager','Stores Manager','Supply Chain','operations-manager','department','Owns stores and stock custody.',300)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.role_catalogue_aliases (alias_key, role_key)
SELECT v.alias, v.key
  FROM (VALUES
  ('general manager','general-manager'),
  ('gm','general-manager'),
  ('maintenance officer','maintenance-officer'),
  ('bar manager','bar-supervisor'),
  ('bar supervisor','bar-supervisor'),
  ('restaurant supervisor','restaurant-supervisor'),
  ('coffee station supervisor','coffee-station-supervisor'),
  ('hot kitchen supervisor','hot-kitchen-supervisor'),
  ('stores manager','stores-manager'),
  ('director','owner')
  ) AS v(alias, key)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.role_catalogue_aliases a WHERE a.alias_key = v.alias
 );

-- 3. Reporting metadata. Migration guidance only — resolution at runtime
--    is by canonical role key, never by name or job title.
WITH meta(role_key, lvl, reports_to, mscope) AS (VALUES
  ('owner',                     100, ARRAY[]::text[],                                                     'organisation'),
  ('general-manager',            90, ARRAY['owner'],                                                      'organisation'),
  ('operations-manager',         80, ARRAY['general-manager','owner'],                                    'property'),
  ('it-system-administrator',    70, ARRAY['general-manager','owner'],                                    'organisation'),
  ('finance-manager',            70, ARRAY['general-manager','owner'],                                    'department'),
  ('human-resources-manager',    70, ARRAY['general-manager','owner'],                                    'department'),
  ('marketing-manager',          70, ARRAY['general-manager','owner'],                                    'department'),
  ('sales-and-events-manager',   70, ARRAY['general-manager','owner'],                                    'department'),
  ('food-and-beverage-manager',  70, ARRAY['operations-manager','general-manager','owner'],               'department'),
  ('procurement-manager',        70, ARRAY['operations-manager','general-manager','owner'],               'department'),
  ('stores-manager',             65, ARRAY['procurement-manager','operations-manager','general-manager'], 'department'),
  ('maintenance-manager',        70, ARRAY['operations-manager','general-manager','owner'],               'department'),
  ('delivery-manager',           70, ARRAY['operations-manager','general-manager'],                       'department'),
  ('head-chef',                  70, ARRAY['food-and-beverage-manager','operations-manager','general-manager'], 'department'),
  ('head-pastry-chef',           65, ARRAY['head-chef','food-and-beverage-manager','operations-manager'], 'department'),
  ('front-office-supervisor',    50, ARRAY['operations-manager','general-manager'],                       'department'),
  ('housekeeping-supervisor',    50, ARRAY['operations-manager','general-manager'],                       'department'),
  ('laundry-supervisor',         45, ARRAY['housekeeping-supervisor','operations-manager'],               'team'),
  ('security-supervisor',        50, ARRAY['operations-manager','general-manager'],                       'department'),
  ('bar-supervisor',             45, ARRAY['food-and-beverage-manager'],                                  'team'),
  ('restaurant-supervisor',      45, ARRAY['food-and-beverage-manager'],                                  'team'),
  ('coffee-station-supervisor',  45, ARRAY['food-and-beverage-manager'],                                  'team'),
  ('hot-kitchen-supervisor',     45, ARRAY['head-chef'],                                                  'team'),
  ('chief-steward',              45, ARRAY['head-chef'],                                                  'team'),
  ('events-coordinator',         45, ARRAY['sales-and-events-manager'],                                   'team'),
  ('maintenance-officer',        40, ARRAY['maintenance-manager','operations-manager'],                   'team'),
  ('procurement-officer',        30, ARRAY['procurement-manager','operations-manager','general-manager'], 'team'),
  ('storekeeper',                30, ARRAY['stores-manager','procurement-manager','operations-manager'],  'team'),
  ('hr-officer',                 30, ARRAY['human-resources-manager'],                                    'team'),
  ('accountant',                  0, ARRAY['finance-manager'],                                            'self'),
  ('night-auditor',               0, ARRAY['finance-manager'],                                            'self'),
  ('receptionist',                0, ARRAY['front-office-supervisor'],                                    'self'),
  ('reservations-agent',          0, ARRAY['front-office-supervisor'],                                    'self'),
  ('front-office-cashier',        0, ARRAY['front-office-supervisor'],                                    'self'),
  ('porter',                      0, ARRAY['front-office-supervisor'],                                    'self'),
  ('driver',                      0, ARRAY['front-office-supervisor'],                                    'self'),
  ('housekeeper',                 0, ARRAY['housekeeping-supervisor'],                                    'self'),
  ('laundry-attendant',           0, ARRAY['laundry-supervisor'],                                         'self'),
  ('waiter',                      0, ARRAY['restaurant-supervisor','food-and-beverage-manager'],          'self'),
  ('barista',                     0, ARRAY['coffee-station-supervisor','food-and-beverage-manager'],      'self'),
  ('bar-attendant',               0, ARRAY['bar-supervisor','food-and-beverage-manager'],                 'self'),
  ('hot-kitchen-chef',            0, ARRAY['hot-kitchen-supervisor','head-chef'],                         'self'),
  ('pastry-chef',                 0, ARRAY['head-pastry-chef','head-chef'],                               'self'),
  ('kitchen-steward',             0, ARRAY['chief-steward','head-chef'],                                  'self'),
  ('banqueting-staff',            0, ARRAY['events-coordinator','sales-and-events-manager'],              'self'),
  ('maintenance-technician',      0, ARRAY['maintenance-officer','maintenance-manager'],                  'self'),
  ('grounds-worker',              0, ARRAY['maintenance-manager'],                                        'self'),
  ('receiving-clerk',             0, ARRAY['storekeeper','stores-manager'],                               'self'),
  ('security-guard',              0, ARRAY['security-supervisor','operations-manager'],                   'self'),
  ('rider',                       0, ARRAY['delivery-manager'],                                           'self')
)
UPDATE public.role_catalogue c
   SET management_level = m.lvl,
       managerial_scope = m.mscope,
       reports_to_role_keys =
         CASE WHEN array_length(m.reports_to, 1) IS NULL THEN '{}'::text[] ELSE m.reports_to END,
       reporting_manager_required = (m.lvl < 100),
       updated_at = now()
  FROM meta m
 WHERE c.role_key = m.role_key;

-- Any catalogue row not named above keeps its single legacy parent.
UPDATE public.role_catalogue
   SET reports_to_role_keys = ARRAY[reports_to_key]
 WHERE reports_to_role_keys = '{}'
   AND reports_to_key IS NOT NULL
   AND reports_to_key <> '';

-- can_manage is the inverse of reports_to, derived (never hand-kept).
UPDATE public.role_catalogue c
   SET can_manage_role_keys = COALESCE(sub.keys, '{}')
  FROM (
    SELECT parent AS role_key, array_agg(DISTINCT child ORDER BY child) AS keys
      FROM (SELECT role_key AS child, unnest(reports_to_role_keys) AS parent
              FROM public.role_catalogue) x
     GROUP BY parent
  ) sub
 WHERE sub.role_key = c.role_key;

-- 4. Normalise live role keys onto the canonical catalogue -------------
UPDATE public.roles r
   SET normalized_role_key = a.role_key
  FROM public.role_catalogue_aliases a
 WHERE a.alias_key = lower(btrim(r.normalized_role_key))
   AND a.ambiguous = false
   AND r.normalized_role_key IS DISTINCT FROM a.role_key;

-- 5. The reporting line itself, on the staff account ------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS reporting_manager_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reporting_effective_from date,
  ADD COLUMN IF NOT EXISTS assignment_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assignment_review_reason text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS profiles_reporting_manager_idx
  ON public.profiles (reporting_manager_id);

-- Guard: no self-reporting, no cross-organisation manager, no cycles,
-- no inactive or archived manager.
CREATE OR REPLACE FUNCTION public.neo_guard_reporting_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mgr public.profiles%ROWTYPE;
  walker uuid;
  hops integer := 0;
BEGIN
  IF NEW.reporting_manager_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.reporting_manager_id = NEW.id THEN
    RAISE EXCEPTION 'An employee cannot report to themselves';
  END IF;

  SELECT * INTO mgr FROM public.profiles WHERE id = NEW.reporting_manager_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reporting manager account does not exist';
  END IF;
  IF mgr.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'A reporting manager must belong to the same organisation';
  END IF;
  IF mgr.account_status <> 'active'
     OR mgr.invitation_status IN ('suspended','deactivated') THEN
    RAISE EXCEPTION 'A reporting manager must be an active account';
  END IF;

  walker := mgr.reporting_manager_id;
  WHILE walker IS NOT NULL AND hops < 64 LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'That reporting line would create a cycle';
    END IF;
    SELECT reporting_manager_id INTO walker FROM public.profiles WHERE id = walker;
    hops := hops + 1;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_guard_reporting_line_trg ON public.profiles;
CREATE TRIGGER neo_guard_reporting_line_trg
  BEFORE INSERT OR UPDATE OF reporting_manager_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_reporting_line();

-- 6. Effective reporting metadata for a set of role ids ---------------
CREATE OR REPLACE FUNCTION public.neo_role_reporting_meta(_role_ids uuid[])
RETURNS TABLE (
  allowed_manager_keys text[],
  manager_required boolean,
  worker_keys text[],
  worker_level integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    SELECT ro.normalized_role_key AS key,
           ro.reports_to_role_keys AS override_keys,
           ro.reporting_manager_required AS override_required,
           ro.management_level AS override_level
      FROM public.roles ro
     WHERE ro.id = ANY(COALESCE(_role_ids, '{}'::uuid[]))
  ),
  merged AS (
    SELECT r.key,
           COALESCE(r.override_keys, c.reports_to_role_keys, '{}') AS keys,
           COALESCE(r.override_required, c.reporting_manager_required, true) AS required,
           COALESCE(r.override_level, c.management_level, 0) AS lvl
      FROM r LEFT JOIN public.role_catalogue c ON c.role_key = r.key
  ),
  inverse AS (
    SELECT DISTINCT c.role_key AS key
      FROM public.role_catalogue c
     WHERE EXISTS (SELECT 1 FROM merged m WHERE m.key = ANY(c.can_manage_role_keys))
  )
  SELECT
    (SELECT COALESCE(array_agg(DISTINCT k), '{}')
       FROM (SELECT unnest(keys) k FROM merged
             UNION SELECT key FROM inverse) u
      WHERE k IS NOT NULL AND k <> ''),
    (SELECT COALESCE(bool_or(required), false) FROM merged),
    (SELECT COALESCE(array_agg(DISTINCT key), '{}') FROM merged WHERE key IS NOT NULL),
    (SELECT COALESCE(max(lvl), 0) FROM merged);
$$;

-- 7. Dynamic candidate resolution -------------------------------------
CREATE OR REPLACE FUNCTION public.neo_reporting_candidate_rows(
  _org uuid,
  _profile uuid,
  _branch uuid,
  _role_ids uuid[]
)
RETURNS TABLE (
  profile_id uuid,
  full_name text,
  staff_id text,
  job_title text,
  role_key text,
  role_name text,
  branch_id uuid,
  department_id uuid,
  management_level integer,
  property_match text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed text[];
BEGIN
  SELECT m.allowed_manager_keys INTO allowed
    FROM public.neo_role_reporting_meta(_role_ids) m;
  IF allowed IS NULL OR array_length(allowed, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT DISTINCT ON (p.id)
           p.id,
           p.full_name,
           p.staff_id,
           p.job_title,
           ro.normalized_role_key AS rkey,
           ro.name AS rname,
           p.branch_id AS bid,
           p.department_id AS did,
           COALESCE(ro.management_level, c.management_level, 0) AS lvl,
           COALESCE(c.managerial_scope, 'self') AS mscope
      FROM public.profiles p
      JOIN public.user_roles ur ON ur.user_id = p.id
      JOIN public.roles ro ON ro.id = ur.role_id
      LEFT JOIN public.role_catalogue c ON c.role_key = ro.normalized_role_key
     WHERE p.organization_id = _org
       AND p.account_type = 'staff'
       AND p.account_status = 'active'
       AND p.invitation_status NOT IN ('suspended','deactivated')
       AND p.id <> COALESCE(_profile, '00000000-0000-0000-0000-000000000000'::uuid)
       AND ro.active
       AND ro.role_status <> 'archived'
       AND ro.normalized_role_key = ANY(allowed)
     ORDER BY p.id, COALESCE(ro.management_level, c.management_level, 0) DESC
  )
  SELECT cd.id, cd.full_name, cd.staff_id, cd.job_title, cd.rkey, cd.rname,
         cd.bid, cd.did, cd.lvl,
         CASE
           WHEN _branch IS NULL OR cd.bid IS NULL THEN 'organisation'
           WHEN cd.bid = _branch THEN 'property'
           ELSE 'wider'
         END
    FROM candidate cd
   WHERE (
      _branch IS NULL
      OR cd.bid IS NULL
      OR cd.bid = _branch
      OR cd.mscope IN ('organisation','property')
   )
   AND NOT EXISTS (
     WITH RECURSIVE up(id, manager) AS (
       SELECT p2.id, p2.reporting_manager_id FROM public.profiles p2 WHERE p2.id = cd.id
       UNION ALL
       SELECT p3.id, p3.reporting_manager_id
         FROM public.profiles p3
         JOIN up ON up.manager = p3.id
     )
     SELECT 1 FROM up WHERE up.id = _profile
   )
   ORDER BY cd.lvl DESC, cd.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_reporting_candidate_rows(uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.neo_reporting_candidates(
  _user uuid,
  _branch uuid,
  _department uuid,
  _station uuid,
  _role_ids uuid[]
)
RETURNS TABLE (
  profile_id uuid,
  full_name text,
  staff_id text,
  job_title text,
  role_key text,
  role_name text,
  branch_id uuid,
  department_id uuid,
  management_level integer,
  property_match text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_org uuid := public.current_org_id();
  target_org uuid;
BEGIN
  IF caller_org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;
  IF _user IS NOT NULL THEN
    SELECT organization_id INTO target_org FROM public.profiles WHERE id = _user;
    IF target_org IS NOT NULL AND target_org <> caller_org THEN
      RAISE EXCEPTION 'User not found in your organisation';
    END IF;
  END IF;
  RETURN QUERY
    SELECT * FROM public.neo_reporting_candidate_rows(caller_org, _user, _branch, _role_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_reporting_candidates(uuid, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reporting_candidates(uuid, uuid, uuid, uuid, uuid[])
  TO authenticated, service_role;

-- 8. Evidence-based backfill ------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_backfill_reporting_lines(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  meta record;
  n_candidates integer;
  only_manager uuid;
  linked integer := 0;
  review integer := 0;
  missing integer := 0;
  skipped integer := 0;
  details jsonb := '[]'::jsonb;
BEGIN
  FOR rec IN
    SELECT p.id, p.full_name, p.branch_id, p.reporting_manager_id,
           COALESCE(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS role_ids
      FROM public.profiles p
      LEFT JOIN public.user_roles ur ON ur.user_id = p.id
     WHERE p.organization_id = _org
       AND p.account_type = 'staff'
       AND p.account_status = 'active'
     GROUP BY p.id
  LOOP
    IF rec.reporting_manager_id IS NOT NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    SELECT * INTO meta FROM public.neo_role_reporting_meta(rec.role_ids);
    IF NOT meta.manager_required
       OR meta.allowed_manager_keys IS NULL
       OR array_length(meta.allowed_manager_keys, 1) IS NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    SELECT count(*), min(profile_id) INTO n_candidates, only_manager
      FROM public.neo_reporting_candidate_rows(_org, rec.id, rec.branch_id, rec.role_ids);

    IF n_candidates = 1 THEN
      UPDATE public.profiles
         SET reporting_manager_id = only_manager,
             reporting_effective_from = COALESCE(reporting_effective_from, CURRENT_DATE),
             assignment_review_required = false,
             assignment_review_reason = ''
       WHERE id = rec.id;
      linked := linked + 1;
    ELSIF n_candidates > 1 THEN
      UPDATE public.profiles
         SET assignment_review_required = true,
             assignment_review_reason = format(
               '%s eligible managers (%s) — confirm the reporting line.',
               n_candidates, array_to_string(meta.allowed_manager_keys, ', '))
       WHERE id = rec.id;
      review := review + 1;
    ELSE
      UPDATE public.profiles
         SET assignment_review_required = true,
             assignment_review_reason = format(
               'No active holder of the required manager role (%s).',
               array_to_string(meta.allowed_manager_keys, ', '))
       WHERE id = rec.id;
      missing := missing + 1;
      details := details || jsonb_build_object(
        'profile', rec.id, 'name', rec.full_name,
        'missing_roles', to_jsonb(meta.allowed_manager_keys));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('organization', _org, 'linked', linked,
    'review_required', review, 'missing_manager_role', missing,
    'left_as_is', skipped, 'missing_details', details);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_backfill_reporting_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_backfill_reporting_lines(uuid) TO service_role;

-- 9. Managerial visibility helper: a reporting line alone grants nothing,
--    it only narrows what an already-capable, in-scope manager may see.
CREATE OR REPLACE FUNCTION public.neo_reports_to_me(_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE chain(id, manager) AS (
    SELECT p.id, p.reporting_manager_id FROM public.profiles p WHERE p.id = _profile
    UNION ALL
    SELECT p2.id, p2.reporting_manager_id
      FROM public.profiles p2 JOIN chain ON chain.manager = p2.id
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE chain.manager = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.neo_reports_to_me(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reports_to_me(uuid) TO authenticated, service_role;