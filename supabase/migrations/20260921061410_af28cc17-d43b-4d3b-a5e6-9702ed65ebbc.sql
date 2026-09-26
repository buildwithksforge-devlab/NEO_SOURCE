CREATE UNIQUE INDEX IF NOT EXISTS linen_items_org_branch_name_norm_idx
  ON public.linen_items (organization_id, branch_id, lower(btrim(name)))
  WHERE branch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS linen_items_org_shared_name_norm_idx
  ON public.linen_items (organization_id, lower(btrim(name)))
  WHERE branch_id IS NULL;