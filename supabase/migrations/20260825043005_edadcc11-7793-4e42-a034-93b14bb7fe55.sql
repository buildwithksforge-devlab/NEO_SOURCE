-- Approval and publishing both sit on the standard "approve" action so the
-- Marketing Manager's existing authority covers them and no invented action
-- can silently grant nobody (or everybody) the right to publish.
CREATE OR REPLACE FUNCTION public.neo_marketing_content_schedule(
  _content uuid,
  _scheduled_for timestamptz
)
RETURNS public.marketing_content_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.marketing_content_items;
BEGIN
  IF NOT has_permission('marketing', 'content', 'approve') THEN
    RAISE EXCEPTION 'You are not permitted to schedule marketing content';
  END IF;

  SELECT * INTO v_row FROM public.marketing_content_items
   WHERE id = _content AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item not found';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved content can be scheduled';
  END IF;

  UPDATE public.marketing_content_items
     SET status = 'scheduled', scheduled_for = _scheduled_for
   WHERE id = _content
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_marketing_content_publish(
  _content uuid,
  _reference text DEFAULT NULL
)
RETURNS public.marketing_content_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.marketing_content_items;
BEGIN
  IF NOT has_permission('marketing', 'content', 'approve') THEN
    RAISE EXCEPTION 'You are not permitted to publish marketing content';
  END IF;

  SELECT * INTO v_row FROM public.marketing_content_items
   WHERE id = _content AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item not found';
  END IF;
  IF v_row.status NOT IN ('approved', 'scheduled') THEN
    RAISE EXCEPTION 'Only approved content can be published';
  END IF;

  UPDATE public.marketing_content_items
     SET status = 'published',
         published_at = now(),
         publish_reference = COALESCE(_reference, v_row.publish_reference)
   WHERE id = _content
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- Social Media Manager: scoped features instead of marketing.*
-- ------------------------------------------------------------
DELETE FROM public.role_feature_templates
 WHERE role_key = 'social-media-manager' AND module = 'marketing';

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'social-media-manager', 'marketing', f, a
  FROM unnest(ARRAY[
    'overview', 'content', 'calendar', 'campaigns', 'leads',
    'reviews', 'feedback', 'tasks', 'stock_needs', 'crm-customers'
  ]) AS f
  CROSS JOIN unnest(ARRAY['view', 'create', 'edit', 'export']) AS a
 WHERE NOT (f = 'overview' AND a IN ('create', 'edit'))
   AND NOT (f = 'campaigns' AND a IN ('create', 'edit'))
   AND NOT (f = 'calendar' AND a IN ('create', 'edit'))
ON CONFLICT DO NOTHING;

SELECT public.neo_apply_feature_templates(o.id) FROM public.organizations o;