CREATE OR REPLACE FUNCTION public.neo_hotel_partner_inbox(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  IF _branch IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'no_property'); END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property'); END IF;
  IF NOT (public.has_permission('procurement','view') OR public.has_permission('finance','view')
          OR public.is_org_admin_for(v_org)) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_permitted');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'conversations', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.last_message_at DESC NULLS LAST)
    FROM (
      SELECT t.id AS thread_id,
             t.subject,
             t.status,
             t.last_message_at,
             r.id AS relationship_id,
             r.party_display_name AS partner_name,
             r.relationship_type,
             (SELECT m.body FROM public.partner_messages m
               WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
             (SELECT m.sender_side FROM public.partner_messages m
               WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_side,
             (SELECT count(*) FROM public.partner_messages m WHERE m.thread_id = t.id) AS message_count
      FROM public.partner_message_threads t
      JOIN public.neo_access_relationships r ON r.id = t.relationship_id
      WHERE t.organization_id = v_org
        AND t.branch_id = _branch
        AND r.door = 'partner'
    ) x), '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_hotel_partner_inbox(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hotel_partner_inbox(uuid) TO authenticated;