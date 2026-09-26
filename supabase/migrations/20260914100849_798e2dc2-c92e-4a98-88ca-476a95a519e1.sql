-- 1. Board: delivery_orders uses order_status, not status.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_board(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := public.current_org_id(); rows jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('delivery', 'dispatch.view') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  SELECT coalesce(jsonb_agg(r ORDER BY r->>'created_at' DESC), '[]'::jsonb) INTO rows
  FROM (
    SELECT jsonb_build_object(
      'order_id', o.id,
      'order_number', o.order_number,
      'order_status', o.order_status,
      'contact_name', o.contact_name,
      'created_at', o.created_at,
      'has_pin', p.id IS NOT NULL,
      'issued_at', p.issued_at,
      'expires_at', p.expires_at,
      'consumed_at', p.consumed_at,
      'invalidated_at', p.invalidated_at,
      'locked', p.locked_at IS NOT NULL,
      'attempt_count', coalesce(p.attempt_count, 0),
      'max_attempts', coalesce(p.max_attempts, 5),
      'regenerated_count', coalesce(p.regenerated_count, 0),
      'override_at', p.override_at,
      'channel', p.last_channel,
      'sent_at', p.last_sent_at,
      'send_status', p.last_send_status,
      'is_legacy', coalesce(p.is_legacy, false),
      'state', CASE
        WHEN p.id IS NULL THEN 'none'
        WHEN p.consumed_at IS NOT NULL THEN 'verified'
        WHEN p.invalidated_at IS NOT NULL THEN 'replaced'
        WHEN p.expires_at IS NOT NULL AND p.expires_at < now() THEN 'expired'
        WHEN p.locked_at IS NOT NULL THEN 'locked'
        WHEN p.last_send_status = 'failed' THEN 'failed'
        WHEN p.last_send_status IN ('sent', 'queued') THEN 'sent'
        ELSE 'generated' END
    ) AS r
    FROM public.delivery_orders o
    LEFT JOIN public.delivery_order_pins p ON p.delivery_order_id = o.id
    WHERE o.organization_id = org
      AND (_branch IS NULL OR o.branch_id = _branch)
      AND public.neo_branch_in_scope(o.branch_id)
      AND o.created_at > now() - interval '30 days'
    ORDER BY o.created_at DESC
    LIMIT 200
  ) q;

  RETURN jsonb_build_object('ok', true, 'orders', rows);
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_board(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_board(uuid) TO authenticated;

-- 2. Guarantee: every delivery order gets a PIN record, whatever created it.
CREATE OR REPLACE FUNCTION public.neo_delivery_order_ensure_pin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_order_pins WHERE delivery_order_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.delivery_order_pins (organization_id, delivery_order_id, customer_id, pin)
  VALUES (NEW.organization_id, NEW.id, NEW.customer_id, '')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS delivery_orders_ensure_pin ON public.delivery_orders;
CREATE TRIGGER delivery_orders_ensure_pin
  AFTER INSERT ON public.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_order_ensure_pin();

-- 3. Backfill in-flight deliveries only; history is left as it stands.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.id, o.organization_id, o.customer_id
      FROM public.delivery_orders o
      LEFT JOIN public.delivery_order_pins p ON p.delivery_order_id = o.id
     WHERE p.id IS NULL
       AND o.customer_id IS NOT NULL
       AND o.order_status NOT IN ('delivered', 'cancelled', 'failed', 'rejected', 'refunded')
  LOOP
    INSERT INTO public.delivery_order_pins (organization_id, delivery_order_id, customer_id, pin)
    VALUES (r.organization_id, r.id, r.customer_id, '');
    INSERT INTO public.delivery_pin_events
      (organization_id, delivery_order_id, pin_version, event_type, detail)
    VALUES (r.organization_id, r.id, 1, 'backfilled',
            'PIN record created for a delivery placed before delivery verification existed.');
  END LOOP;
END $$;