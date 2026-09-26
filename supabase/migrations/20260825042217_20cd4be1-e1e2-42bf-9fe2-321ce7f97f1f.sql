-- ============================================================
-- Marketing department: social content workflow
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  reference text,
  channel text NOT NULL DEFAULT 'instagram',
  content_type text NOT NULL DEFAULT 'post',
  title text NOT NULL,
  body text,
  asset_url text,
  planned_for date,
  scheduled_for timestamptz,
  published_at timestamptz,
  publish_reference text,
  status text NOT NULL DEFAULT 'draft',
  review_notes text,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.marketing_content_items TO authenticated;
GRANT ALL ON public.marketing_content_items TO service_role;

ALTER TABLE public.marketing_content_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_content_read_own_org ON public.marketing_content_items;
CREATE POLICY marketing_content_read_own_org
  ON public.marketing_content_items FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND is_active_staff());

DROP POLICY IF EXISTS marketing_content_insert_own_org ON public.marketing_content_items;
CREATE POLICY marketing_content_insert_own_org
  ON public.marketing_content_items FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = current_org_id()
    AND is_active_staff()
    AND created_by = auth.uid()
    AND has_permission('marketing', 'content', 'create')
  );

DROP POLICY IF EXISTS marketing_content_update_own_draft ON public.marketing_content_items;
CREATE POLICY marketing_content_update_own_draft
  ON public.marketing_content_items FOR UPDATE TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (created_by = auth.uid() AND status IN ('draft', 'returned'))
      OR has_permission('marketing', 'content', 'approve')
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE INDEX IF NOT EXISTS marketing_content_org_status_idx
  ON public.marketing_content_items (organization_id, status, planned_for);

DROP TRIGGER IF EXISTS marketing_content_updated_at ON public.marketing_content_items;
CREATE TRIGGER marketing_content_updated_at
  BEFORE UPDATE ON public.marketing_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

-- ------------------------------------------------------------
-- No self-approval: the author never approves their own content
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_marketing_content_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('approved', 'rejected')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.reviewed_by IS NOT NULL
     AND NEW.reviewed_by = NEW.created_by THEN
    RAISE EXCEPTION 'Marketing content cannot be approved or rejected by its author';
  END IF;

  IF NEW.status IN ('scheduled', 'published')
     AND OLD.status NOT IN ('approved', 'scheduled', 'published') THEN
    RAISE EXCEPTION 'Marketing content must be approved before it is scheduled or published';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_marketing_content_guard_trg ON public.marketing_content_items;
CREATE TRIGGER neo_marketing_content_guard_trg
  BEFORE UPDATE ON public.marketing_content_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_marketing_content_guard();

-- ------------------------------------------------------------
-- Submit for approval
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_marketing_content_submit(_content uuid)
RETURNS public.marketing_content_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.marketing_content_items;
BEGIN
  SELECT * INTO v_row FROM public.marketing_content_items
   WHERE id = _content AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item not found';
  END IF;
  IF v_row.created_by <> auth.uid() AND NOT has_permission('marketing', 'content', 'approve') THEN
    RAISE EXCEPTION 'Only the author may submit this content';
  END IF;
  IF v_row.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'Only a draft or returned item can be submitted';
  END IF;

  UPDATE public.marketing_content_items
     SET status = 'submitted', submitted_at = now(), review_notes = NULL
   WHERE id = _content
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_submit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_submit(uuid) TO authenticated;

-- ------------------------------------------------------------
-- Review: approve, return or reject
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_marketing_content_review(
  _content uuid,
  _decision text,
  _notes text DEFAULT NULL
)
RETURNS public.marketing_content_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.marketing_content_items;
  v_status text;
BEGIN
  IF NOT has_permission('marketing', 'content', 'approve') THEN
    RAISE EXCEPTION 'You are not permitted to review marketing content';
  END IF;

  v_status := CASE lower(_decision)
    WHEN 'approve' THEN 'approved'
    WHEN 'approved' THEN 'approved'
    WHEN 'return' THEN 'returned'
    WHEN 'returned' THEN 'returned'
    WHEN 'reject' THEN 'rejected'
    WHEN 'rejected' THEN 'rejected'
    ELSE NULL
  END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Decision must be approve, return or reject';
  END IF;

  SELECT * INTO v_row FROM public.marketing_content_items
   WHERE id = _content AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item not found';
  END IF;
  IF v_row.status <> 'submitted' THEN
    RAISE EXCEPTION 'Only submitted content can be reviewed';
  END IF;
  IF v_row.created_by = auth.uid() THEN
    RAISE EXCEPTION 'Marketing content cannot be reviewed by its author';
  END IF;

  UPDATE public.marketing_content_items
     SET status = v_status,
         review_notes = _notes,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = _content
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_review(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_review(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Schedule / publish approved content
-- ------------------------------------------------------------
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
  IF NOT has_permission('marketing', 'content', 'publish') THEN
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

REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) TO authenticated;

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
  IF NOT has_permission('marketing', 'content', 'publish') THEN
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

REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) TO authenticated;