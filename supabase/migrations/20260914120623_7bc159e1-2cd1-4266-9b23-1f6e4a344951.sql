-- 1. Per-workspace messaging provider credentials (server-only)
CREATE TABLE IF NOT EXISTS public.provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider text NOT NULL,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

COMMENT ON TABLE public.provider_credentials IS
  'Tenant-owned messaging credentials. Deliberately unreadable by anon/authenticated: only trusted server code (service_role) may read or write, and the UI only ever sees a masked summary.';

GRANT ALL ON public.provider_credentials TO service_role;
ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;
-- No policy for anon/authenticated by design: the Data API must never expose credentials.

DROP TRIGGER IF EXISTS provider_credentials_touch ON public.provider_credentials;
CREATE TRIGGER provider_credentials_touch
  BEFORE UPDATE ON public.provider_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- 2. Daily stock reconciliation for one organisation
CREATE OR REPLACE FUNCTION public.neo_stock_daily_reconcile(_organization uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org uuid := _organization;
  _branch record;
  _checked int;
  _no_baseline int;
  _corrected int;
  _changes jsonb;
  _below jsonb;
  _below_count int;
  _recipient record;
  _queued int := 0;
  _skipped int := 0;
  _properties int := 0;
  _key text;
  _day text := to_char(current_date, 'YYYY-MM-DD');
  _body text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation'; END IF;

  FOR _branch IN
    SELECT b.id, b.name
      FROM public.branches b
     WHERE b.organization_id = _org
     ORDER BY b.name
  LOOP
    _properties := _properties + 1;

    WITH scoped AS (
      SELECT sl.id, sl.stock_item_id, sl.location_id, sl.opening_balance,
             coalesce(sl.quantity_on_hand, 0) AS stored
        FROM public.stock_levels sl
        JOIN public.stock_locations loc ON loc.id = sl.location_id
       WHERE sl.organization_id = _org
         AND loc.branch_id = _branch.id
    ), ledger AS (
      SELECT s.id, s.stored,
             CASE WHEN s.opening_balance IS NULL THEN NULL
                  ELSE s.opening_balance + coalesce((
                    SELECT sum(m.quantity) FROM public.stock_movements m
                     WHERE m.organization_id = _org
                       AND m.stock_item_id = s.stock_item_id
                       AND m.location_id = s.location_id
                       AND m.movement_type <> 'opening'), 0)
             END AS derived
        FROM scoped s
    ), applied AS (
      UPDATE public.stock_levels sl
         SET quantity_on_hand = round(l.derived, 4),
             last_movement_at = coalesce(
               (SELECT max(m.created_at) FROM public.stock_movements m
                 WHERE m.organization_id = _org
                   AND m.stock_item_id = sl.stock_item_id
                   AND m.location_id = sl.location_id),
               sl.last_movement_at),
             updated_at = now()
        FROM ledger l
       WHERE sl.id = l.id
         AND l.derived IS NOT NULL
         AND round(l.derived, 4) IS DISTINCT FROM round(l.stored, 4)
      RETURNING sl.id, sl.stock_item_id, sl.location_id, l.stored AS was, sl.quantity_on_hand AS now_is
    )
    SELECT (SELECT count(*) FROM ledger),
           (SELECT count(*) FROM ledger WHERE derived IS NULL),
           (SELECT count(*) FROM applied),
           coalesce((SELECT jsonb_agg(jsonb_build_object(
                       'stock_item_id', a.stock_item_id,
                       'location_id', a.location_id,
                       'was', a.was,
                       'now', a.now_is)) FROM applied a), '[]'::jsonb)
      INTO _checked, _no_baseline, _corrected, _changes;

    -- Items sitting at or below their reorder point after the rebuild.
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'item'), '[]'::jsonb), count(*)
      INTO _below, _below_count
      FROM (
        SELECT jsonb_build_object(
                 'item', si.name,
                 'store', loc.name,
                 'on_hand', round(coalesce(sl.quantity_on_hand,0), 2),
                 'reorder_point', coalesce(si.reorder_point, si.min_level)
               ) AS x
          FROM public.stock_levels sl
          JOIN public.stock_locations loc ON loc.id = sl.location_id
          JOIN public.stock_items si ON si.id = sl.stock_item_id
         WHERE sl.organization_id = _org
           AND loc.branch_id = _branch.id
           AND coalesce(si.reorder_point, si.min_level) IS NOT NULL
           AND coalesce(si.reorder_point, si.min_level) > 0
           AND coalesce(sl.quantity_on_hand, 0) <= coalesce(si.reorder_point, si.min_level)
      ) s;

    INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value, reason)
    VALUES (_org, _branch.id, NULL, 'inventory.levels.reconciled.daily', 'inventory', _branch.id::text,
            jsonb_build_object('checked', _checked, 'corrected', _corrected,
                               'without_baseline', _no_baseline, 'below_reorder', _below_count,
                               'changes', _changes),
            'Scheduled daily stock reconciliation');

    CONTINUE WHEN _corrected = 0 AND _below_count = 0;

    _body :=
      '<p>Overnight stock reconciliation for <strong>' || replace(coalesce(_branch.name,'this property'),'<','&lt;') || '</strong> on ' || _day || '.</p>' ||
      '<p>Lines checked: ' || _checked || '<br/>Levels corrected against the movement ledger: ' || _corrected ||
      '<br/>Lines with no opening balance to rebuild from: ' || _no_baseline ||
      '<br/>Items at or below their reorder point: ' || _below_count || '</p>' ||
      CASE WHEN _below_count > 0 THEN
        '<p>Below reorder:</p><ul>' || coalesce((
          SELECT string_agg('<li>' || replace(coalesce(e->>'item','—'),'<','&lt;') ||
                            ' — ' || replace(coalesce(e->>'store','—'),'<','&lt;') ||
                            ': ' || coalesce(e->>'on_hand','0') ||
                            ' (reorder at ' || coalesce(e->>'reorder_point','—') || ')</li>', '')
            FROM jsonb_array_elements(_below) e), '') || '</ul>'
      ELSE '' END ||
      '<p>Open Inventory → Live Stock in NEØ to review and act on these figures.</p>';

    FOR _recipient IN
      SELECT DISTINCT p.id AS user_id, trim(p.email) AS email
        FROM public.profiles p
       WHERE p.organization_id = _org
         AND coalesce(p.account_status, 'active') = 'active'
         AND nullif(trim(coalesce(p.email,'')), '') IS NOT NULL
         AND (p.branch_id IS NULL OR p.branch_id = _branch.id)
         AND EXISTS (
           SELECT 1
             FROM public.user_roles ur
             JOIN public.roles r ON r.id = ur.role_id AND r.active
             JOIN public.role_permissions rp ON rp.role_id = r.id
             JOIN public.permissions pm ON pm.id = rp.permission_id
            WHERE ur.user_id = p.id
              AND ur.organization_id = _org
              AND pm.module = 'inventory'
              AND pm.action IN ('manage', 'edit', 'approve')
         )
    LOOP
      _key := 'stock-daily-reconcile:' || _branch.id::text || ':' || _day || ':' || _recipient.user_id::text;
      INSERT INTO public.communication_queue(
        organization_id, branch_id, template_key, channel, recipient, subject,
        rendered_body, variables, scheduled_for, status, max_attempts,
        source_module, source_record_id, idempotency_key, is_marketing
      ) VALUES (
        _org, _branch.id, 'stock-daily-reconciliation', 'email', _recipient.email,
        'Stock reconciliation — ' || coalesce(_branch.name,'property') || ' — ' || _day,
        _body,
        jsonb_build_object('branch_id', _branch.id, 'checked', _checked, 'corrected', _corrected,
                           'without_baseline', _no_baseline, 'below_reorder', _below_count,
                           'below', _below),
        now(), 'queued', 3, 'inventory', _branch.id, _key, false
      )
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
      _queued := _queued + 1;
    END LOOP;

    IF NOT FOUND THEN _skipped := _skipped + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'properties', _properties, 'queued', _queued,
                            'properties_without_recipient', _skipped, 'run_at', now());
END
$function$;

REVOKE ALL ON FUNCTION public.neo_stock_daily_reconcile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_daily_reconcile(uuid) TO service_role;

-- 3. All organisations, for the scheduler
CREATE OR REPLACE FUNCTION public.neo_stock_daily_reconcile_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org record;
  _result jsonb;
  _queued int := 0;
  _properties int := 0;
BEGIN
  FOR _org IN SELECT DISTINCT sl.organization_id AS id FROM public.stock_levels sl
  LOOP
    _result := public.neo_stock_daily_reconcile(_org.id);
    _queued := _queued + coalesce((_result->>'queued')::int, 0);
    _properties := _properties + coalesce((_result->>'properties')::int, 0);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'organisations_processed', _properties, 'queued', _queued);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_stock_daily_reconcile_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_daily_reconcile_all() TO service_role;

DO $do$
DECLARE _job bigint;
BEGIN
  SELECT jobid INTO _job FROM cron.job WHERE jobname = 'neo-stock-daily-reconcile' LIMIT 1;
  IF _job IS NOT NULL THEN PERFORM cron.unschedule(_job); END IF;
  PERFORM cron.schedule(
    'neo-stock-daily-reconcile',
    '40 2 * * *',
    $job$SELECT public.neo_stock_daily_reconcile_all();$job$
  );
END
$do$;
