CREATE OR REPLACE FUNCTION public.neo_pos_status_rules()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'draft', jsonb_build_array('held','confirmed','sent','cancelled'),
    'held', jsonb_build_array('draft','confirmed','cancelled'),
    'confirmed', jsonb_build_array('sent','cancelled'),
    'sent', jsonb_build_array('accepted','in-preparation','partially-ready','ready','cancelled','void-pending'),
    'accepted', jsonb_build_array('in-preparation','partially-ready','ready','void-pending'),
    'in-preparation', jsonb_build_array('partially-ready','ready','void-pending'),
    'partially-ready', jsonb_build_array('ready','partially-served','void-pending'),
    'ready', jsonb_build_array('partially-served','served','void-pending'),
    'partially-served', jsonb_build_array('served','awaiting-payment','void-pending'),
    'served', jsonb_build_array('awaiting-payment','void-pending'),
    'awaiting-payment', jsonb_build_array('paid','charged-to-room','credit','void-pending'),
    'paid', jsonb_build_array('closed','void-pending'),
    'charged-to-room', jsonb_build_array('closed','void-pending'),
    'credit', jsonb_build_array('closed','void-pending'),
    'closed', jsonb_build_array('awaiting-payment'),
    'void-pending', jsonb_build_array('voided','served','awaiting-payment')
  )
$function$;

REVOKE EXECUTE ON FUNCTION public.neo_pos_status_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_status_rules() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_enforce_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT coalesce(array_agg(v::text), ARRAY[]::text[]) INTO allowed
  FROM jsonb_array_elements_text(coalesce(public.neo_pos_status_rules() -> OLD.status, '[]'::jsonb)) v;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid order status transition % -> % (allowed from %: %)',
      OLD.status, NEW.status, OLD.status,
      CASE WHEN array_length(allowed, 1) IS NULL THEN 'none' ELSE array_to_string(allowed, ', ') END;
  END IF;
  INSERT INTO public.pos_order_status_history (organization_id, order_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_pos_order_diagnostics(_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE _o public.pos_orders;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'rules', public.neo_pos_status_rules());
  END IF;
  RETURN jsonb_build_object(
    'found', true,
    'order_id', _o.id,
    'order_number', _o.order_number,
    'status', _o.status,
    'payment_status', _o.payment_status,
    'grand_total', _o.grand_total,
    'sent_at', _o.sent_at,
    'allowed_next', coalesce(public.neo_pos_status_rules() -> _o.status, '[]'::jsonb),
    'rules', public.neo_pos_status_rules()
  );
END; $function$;

REVOKE EXECUTE ON FUNCTION public.neo_pos_order_diagnostics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_order_diagnostics(uuid) TO authenticated, service_role;