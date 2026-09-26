-- Per-branch reorder rules. Additive: nothing existing is altered, and the
-- organisation-level stock_items.reorder_point stays the fallback.
CREATE TABLE IF NOT EXISTS public.stock_branch_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  reorder_point numeric,
  par_level numeric,
  reorder_quantity numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (branch_id, stock_item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_branch_thresholds TO authenticated;
GRANT ALL ON public.stock_branch_thresholds TO service_role;

ALTER TABLE public.stock_branch_thresholds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_branch_thresholds_select ON public.stock_branch_thresholds;
CREATE POLICY stock_branch_thresholds_select ON public.stock_branch_thresholds
  FOR SELECT TO authenticated
  USING (in_my_config_scope(organization_id, branch_id));

DROP POLICY IF EXISTS stock_branch_thresholds_write ON public.stock_branch_thresholds;
CREATE POLICY stock_branch_thresholds_write ON public.stock_branch_thresholds
  FOR ALL TO authenticated
  USING (in_my_config_scope(organization_id, branch_id) AND has_permission('inventory'::text, 'items.manage'::text))
  WITH CHECK (in_my_config_scope(organization_id, branch_id) AND has_permission('inventory'::text, 'items.manage'::text));

CREATE INDEX IF NOT EXISTS stock_branch_thresholds_org_branch_idx
  ON public.stock_branch_thresholds (organization_id, branch_id);

CREATE OR REPLACE FUNCTION public.stock_branch_thresholds_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_branch_thresholds_touch ON public.stock_branch_thresholds;
CREATE TRIGGER stock_branch_thresholds_touch
  BEFORE UPDATE ON public.stock_branch_thresholds
  FOR EACH ROW EXECUTE FUNCTION public.stock_branch_thresholds_touch();