-- Legacy capability keys used by server routines are resolved onto the
-- catalogued module.feature.action grants that roles actually hold.
CREATE TABLE IF NOT EXISTS public.permission_key_aliases (
  alias_module text NOT NULL,
  alias_action text NOT NULL,
  canonical_module text NOT NULL,
  canonical_feature text NOT NULL,
  canonical_action text NOT NULL,
  PRIMARY KEY (alias_module, alias_action)
);

GRANT SELECT ON public.permission_key_aliases TO authenticated;
GRANT ALL ON public.permission_key_aliases TO service_role;
ALTER TABLE public.permission_key_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permission key aliases readable" ON public.permission_key_aliases;
CREATE POLICY "permission key aliases readable" ON public.permission_key_aliases
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.permission_key_aliases AS a
  (alias_module, alias_action, canonical_module, canonical_feature, canonical_action)
VALUES
  ('pms','rooms.assign','front-office','arrivals','edit'),
  ('pms','rooms.transfer','front-office','in-house','edit'),
  ('pms','rooms.manage','front-office','rack','edit'),
  ('pms','rooms.view','front-office','rack','view'),
  ('pms','checkin.perform','front-office','arrivals','edit'),
  ('pms','checkin.revert','front-office','*','approve'),
  ('pms','checkout.perform','front-office','departures','edit'),
  ('pms','folios.post_charge','front-office','folios','create'),
  ('pms','folios.transfer','front-office','folios','edit'),
  ('pms','folios.reopen','front-office','folios','approve'),
  ('pms','payments.record','front-office','folios','create'),
  ('pms','reservations.manage','front-office','reservations','edit'),
  ('pms','dashboard.view','front-office','overview','view'),
  ('pms','write','front-office','*','edit'),
  ('finance','cash.review','finance','banking','edit'),
  ('finance','folios.reopen','finance','*','approve'),
  ('pos','menu','restaurant','menu','edit'),
  ('pos','payments','restaurant','orders','edit'),
  ('pos','room_charge.post','restaurant','orders','approve'),
  ('pos','shifts.open','restaurant','shifts','create'),
  ('pos','shifts.review','restaurant','shifts','edit'),
  ('pos','write','restaurant','*','edit'),
  ('restaurant','menu','restaurant','menu','edit'),
  ('restaurant','orders.manage','restaurant','orders','edit'),
  ('kitchen','queue.manage','kitchen','queue','edit'),
  ('housekeeping','tasks','housekeeping','tasks','edit'),
  ('housekeeping','inspections','housekeeping','*','inspect'),
  ('inventory','stock.manage','stores','*','edit'),
  ('inventory','stocktake.manage','stores','*','edit'),
  ('inventory','transfers.manage','stores','*','edit'),
  ('inventory','adjustments.approve','stores','*','approve'),
  ('events','billing','events','billing','view'),
  ('events','bookings','events','bookings','view'),
  ('events','enquiries','events','enquiries','view'),
  ('events','quotations','events','quotations','view'),
  ('events','feedback','events','feedback','view'),
  ('events','reports','events','reports','view'),
  ('events','resources','events','resources','view'),
  ('administration','approvals','administration','*','approve'),
  ('administration','approvals.emergency_override','administration','*','override'),
  ('administration','audit','administration','audit-logs','view'),
  ('administration','users','administration','users','view'),
  ('administration','workspace','administration','*','edit'),
  ('operations','view','tasks','*','view')
ON CONFLICT (alias_module, alias_action) DO UPDATE
  SET canonical_module = EXCLUDED.canonical_module,
      canonical_feature = EXCLUDED.canonical_feature,
      canonical_action = EXCLUDED.canonical_action;

CREATE OR REPLACE FUNCTION public.canonical_permission(_module text, _feature text, _action text)
RETURNS TABLE(module text, feature text, action text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      COALESCE((SELECT a.canonical_module FROM public.permission_module_aliases a WHERE a.alias_module = _module), _module) AS m,
      CASE
        WHEN position('.' in _action) > 0 THEN split_part(_action, '.', 1)
        WHEN COALESCE(_feature, '*') <> '*' THEN _feature
        ELSE '*'
      END AS f,
      CASE WHEN position('.' in _action) > 0
        THEN substring(_action from position('.' in _action) + 1)
        ELSE _action END AS a
  ),
  alias AS (
    SELECT k.canonical_module, k.canonical_feature, k.canonical_action
    FROM public.permission_key_aliases k
    WHERE k.alias_module = _module
      AND k.alias_action = _action
      AND COALESCE(_feature, '*') = '*'
  )
  SELECT
    COALESCE((SELECT canonical_module FROM alias), base.m),
    COALESCE((SELECT canonical_feature FROM alias), base.f),
    COALESCE((SELECT canonical_action FROM alias), base.a)
  FROM base;
$$;

REVOKE ALL ON FUNCTION public.canonical_permission(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canonical_permission(text, text, text) TO authenticated, service_role;