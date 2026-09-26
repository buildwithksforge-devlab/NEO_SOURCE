
CREATE TABLE IF NOT EXISTS public.permission_action_classes (
  action_suffix text PRIMARY KEY,
  action_class text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.permission_action_classes TO authenticated;
GRANT ALL ON public.permission_action_classes TO service_role;
ALTER TABLE public.permission_action_classes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.permission_action_classes'::regclass AND polname='action class read') THEN
    CREATE POLICY "action class read" ON public.permission_action_classes FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.permission_action_classes'::regclass AND polname='action class platform write') THEN
    CREATE POLICY "action class platform write" ON public.permission_action_classes FOR ALL TO authenticated
      USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
  END IF;
END $$;

INSERT INTO public.permission_action_classes (action_suffix, action_class) VALUES
  ('view','view'),('view-all','view'),('view-own','view'),('availability','view'),('revenue','view'),
  ('performance','view'),('readiness','view'),('financials','view'),('view_compliance','view'),
  ('view_costs','view'),('view_profit','view'),('report','view'),('eta','view'),('rider-location','view'),
  ('access','view'),('cost','view'),('beo','view'),
  ('create','create'),('create-assisted','create'),('perform','create'),('record','create'),
  ('request','create'),('apply','create'),('clock','create'),('issue','create'),('send','create'),
  ('submit','create'),('start','create'),('schedule','create'),('quote','create'),('conduct','create'),
  ('attempt','create'),('count_cash','create'),('open','create'),('open_shift','create'),('pickup','create'),
  ('deliver','create'),('collect','create'),('contact','create'),('contact-customer','create'),
  ('contact-rider','create'),('proof','create'),('generate','create'),('prepare','create'),('ready','create'),
  ('receive','create'),('split','create'),('hold','create'),('accept','create'),('cash','create'),
  ('cod','create'),('partial','create'),('print','print'),('reprint','print'),('export','export'),
  ('edit','edit'),('edit_draft','edit'),('update','edit'),('manage','edit'),('manage-defaults','edit'),
  ('assign','edit'),('reassign','edit'),('adjust','edit'),('block','edit'),('cancel','edit'),
  ('cancel_item','edit'),('cancel_request','edit'),('mark_no_show','edit'),('customize','edit'),
  ('configure','edit'),('prioritize','edit'),('release','edit'),('reinstate','edit'),('upgrade','edit'),
  ('correct','edit'),('close','edit'),('close_shift','edit'),('convert','edit'),('post_charge','edit'),
  ('inspect','edit'),('review','edit'),('process','edit'),('complete','edit'),('transfer','edit'),
  ('assignment.view','view'),('assignment.accept','create'),('assignment.reject','create')
ON CONFLICT (action_suffix) DO NOTHING;

CREATE OR REPLACE FUNCTION public.permission_action_class(_action text)
RETURNS text LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT c.action_class FROM public.permission_action_classes c WHERE c.action_suffix = _action), _action);
$$;
REVOKE EXECUTE ON FUNCTION public.permission_action_class(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.permission_action_class(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
    FROM public.canonical_permission(_module, _feature, _action) c
  ),
  held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
      AND rp.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'deny' AND h.module = w.module AND h.action = w.action
        AND h.feature IN (w.feature, '*')
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'grant' AND h.module = w.module
        AND h.feature IN (w.feature, '*')
        AND (h.action = w.action OR (h.feature = '*' AND h.action_class = w.action_class))
    )
  END;
$$;
